import { randomUUID } from "node:crypto"
import fs from "node:fs"
import { buildBilibiliArchiveRelaySegments, cleanupBilibiliArchiveRelayFiles } from "../bilibiliMediaRelay.js"
import { enrichBilibiliShare, formatBilibiliHistoryLinks, formatBilibiliHistoryText } from "../bilibiliMessage.js"
import { buildDouyinArchiveRelaySegments, cleanupDouyinArchiveRelayFiles } from "../douyinMediaRelay.js"
import { enrichDouyinShare, formatDouyinHistoryLinks, formatDouyinHistoryText } from "../douyinMessage.js"
import { buildYoutubeArchiveRelaySegments, cleanupYoutubeArchiveRelayFiles } from "../youtubeMediaRelay.js"
import { enrichYoutubeShare, formatYoutubeHistoryLinks, formatYoutubeHistoryText } from "../youtubeMessage.js"
import { buildPixivArchiveRelaySegments, cleanupPixivArchiveRelayFiles } from "../pixivMediaRelay.js"
import { enrichPixivShare, formatPixivHistoryLinks, formatPixivHistoryText } from "../pixivMessage.js"
import { inlineForwardLocalFileSegment, inlineForwardVideoSegment } from "./deliveryGateway.js"
import { AsyncSemaphore, KeyedSerialQueue } from "./keyedSerialQueue.js"
import { LeaseLostError, startLeaseHeartbeat } from "./leaseHeartbeat.js"

const DEFAULT_MAX_ATTEMPTS = 4
const DEFAULT_RETRY_BASE_MS = 5000
const DEFAULT_LEASE_MS = 15 * 60 * 1000
const DEFAULT_PREPARE_CONCURRENCY = 2
const PREPARED_RELAY_HOLD_MS = 3 * 60 * 1000

const segmentApi = {
  image: file => ({ type: "image", file }),
  video: file => ({ type: "video", file })
}

function cleanError(error) {
  return String(error?.message || error || "unknown error").replace(/https?:\/\/\S+/g, "[url]").slice(0, 500)
}

function serializeMedia(card = {}) {
  const output = {}
  for (const [key, value] of Object.entries(card || {})) {
    if (["play_url", "runtimeMessage", "tempFiles"].includes(key)) continue
    if (typeof value === "function" || value === undefined) continue
    output[key] = value
  }
  return output
}

function emptyRelay() {
  return { segments: [], tempFiles: [], artifactLeases: [], sharedMediaFiles: [] }
}

function deliveryIdFor({ platform, botId, groupId, messageId, eventId }) {
  return ["v1", platform || "media", botId || "bot", groupId || "group", messageId || eventId].join(":")
}

const PLATFORM_LABELS = Object.freeze({
  bilibili: "B站视频搬一下",
  douyin: "抖音视频搬一下",
  youtube: "YouTube视频搬一下",
  pixiv: "Pixiv作品解析"
})

export class MediaOutbox {
  constructor({
    store,
    gateway,
    logger = globalThis.logger,
    enabled = true,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryBaseMs = DEFAULT_RETRY_BASE_MS,
    leaseMs = DEFAULT_LEASE_MS,
    queue = new KeyedSerialQueue(),
    concurrency = 4,
    prepareConcurrency = DEFAULT_PREPARE_CONCURRENCY,
    enrichBilibili = enrichBilibiliShare,
    enrichDouyin = enrichDouyinShare,
    enrichYoutube = enrichYoutubeShare,
    enrichPixiv = enrichPixivShare,
    buildBilibili = buildBilibiliArchiveRelaySegments,
    buildDouyin = buildDouyinArchiveRelaySegments,
    buildYoutube = buildYoutubeArchiveRelaySegments,
    buildPixiv = buildPixivArchiveRelaySegments,
    autoBilibiliMemberAuth = false,
    getBilibiliAuthCookie = () => "",
    artifactStore = null,
    sharedMedia = null,
    youtubeRelay = {},
    pixivRelay = {}
  } = {}) {
    this.store = store
    this.gateway = gateway
    this.logger = logger
    this.enabled = enabled !== false
    this.maxAttempts = Math.max(1, Number(maxAttempts) || DEFAULT_MAX_ATTEMPTS)
    this.retryBaseMs = Math.max(100, Number(retryBaseMs) || DEFAULT_RETRY_BASE_MS)
    this.leaseMs = Math.max(10000, Number(leaseMs) || DEFAULT_LEASE_MS)
    this.queue = queue
    this.semaphore = new AsyncSemaphore(concurrency)
    this.prepareSemaphore = new AsyncSemaphore(prepareConcurrency)
    this.enrichBilibili = enrichBilibili
    this.enrichDouyin = enrichDouyin
    this.enrichYoutube = enrichYoutube
    this.enrichPixiv = enrichPixiv
    this.buildBilibili = buildBilibili
    this.buildDouyin = buildDouyin
    this.buildYoutube = buildYoutube
    this.buildPixiv = buildPixiv
    this.autoBilibiliMemberAuth = autoBilibiliMemberAuth === true
    this.getBilibiliAuthCookie = getBilibiliAuthCookie
    this.artifactStore = artifactStore
    this.sharedMedia = sharedMedia
    this.youtubeRelay = youtubeRelay && typeof youtubeRelay === "object" ? youtubeRelay : {}
    this.pixivRelay = pixivRelay && typeof pixivRelay === "object" ? pixivRelay : {}
    this.refreshPromises = new Map()
    this.preparedRelays = new Map()
    this.runId = randomUUID()
    this.timers = new Map()
    this.stopped = false
  }

  async enqueue({ envelope, media }) {
    if (!this.enabled) return null
    const adapter = this.platformAdapter(media?.type)
    if (!media || !envelope?.groupId || !adapter?.enabled) return null
    const id = deliveryIdFor({
      platform: media.type,
      botId: envelope.botId,
      groupId: envelope.groupId,
      messageId: envelope.messageId,
      eventId: envelope.eventId
    })
    const now = Date.now()
    const job = {
      version: 1,
      id,
      eventId: envelope.eventId,
      platform: media.type,
      botId: envelope.botId,
      groupId: String(envelope.groupId),
      messageId: String(envelope.messageId || ""),
      media: serializeMedia(media),
      state: "pending",
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      nextRetryAt: 0,
      leaseUntil: 0,
      ownerRunId: "",
      receipt: null,
      lastError: ""
    }
    const created = await this.store.create("delivery", id, job)
    const current = created ? job : await this.store.get("delivery", id)
    if (created && !this.stopped) this.startPrewarm(job)
    if (current && !["sent", "failed"].includes(current.state)) this.schedule(id, current.groupId)
    return current
  }

  schedule(id, groupId, delayMs = 0) {
    if (this.stopped || !id) return
    const existing = this.timers.get(id)
    if (existing) clearTimeout(existing)
    if (delayMs > 0) {
      const timer = setTimeout(() => {
        this.timers.delete(id)
        this.queue.run(groupId, () => this.semaphore.run(() => this.process(id))).catch(error => {
          this.logger?.warn?.(`[MediaOutbox] 后台任务异常 id=${id}: ${cleanError(error)}`)
        })
      }, delayMs)
      timer.unref?.()
      this.timers.set(id, timer)
      return
    }
    setImmediate(() => {
      if (this.stopped) return
      this.queue.run(groupId, () => this.semaphore.run(() => this.process(id))).catch(error => {
        this.logger?.warn?.(`[MediaOutbox] 后台任务异常 id=${id}: ${cleanError(error)}`)
      })
    })
  }

  async recover() {
    if (!this.enabled) return 0
    const jobs = await this.store.list("delivery")
    let count = 0
    for (const job of jobs) {
      if (!job?.id || ["sent", "failed"].includes(job.state)) continue
      const now = Date.now()
      const delay = job.state === "retry_wait"
        ? Math.max(0, Number(job.nextRetryAt || 0) - now)
        : job.state === "processing"
          ? Math.max(0, Number(job.leaseUntil || 0) - now + 100)
          : 0
      this.schedule(job.id, job.groupId, delay)
      count++
    }
    if (count) this.logger?.info?.(`[MediaOutbox] 恢复 ${count} 个未完成媒体任务`)
    return count
  }

  async refreshCard(job) {
    const adapter = this.platformAdapter(job.platform)
    if (!adapter) return { ...job.media, type: job.platform }
    const stableId = adapter.stableId(job.media)
    const key = stableId ? `${job.platform}:${stableId}` : ""
    if (key && this.refreshPromises.has(key)) return await this.refreshPromises.get(key)
    const promise = adapter.enrich({ ...job.media, type: job.platform }, { cacheTtlMs: 0, ...adapter.enrichOptions })
    if (key) this.refreshPromises.set(key, promise)
    try {
      return await promise
    } finally {
      if (key && this.refreshPromises.get(key) === promise) this.refreshPromises.delete(key)
    }
  }

  async buildRelay(job, card, onTiming) {
    const adapter = this.platformAdapter(job.platform)
    if (!adapter) return emptyRelay()
    const options = { segmentApi, logger: this.logger, artifactStore: this.artifactStore, onTiming, ...adapter.relayOptions }
    if (job.platform === "bilibili" && this.autoBilibiliMemberAuth) {
      // 仅在 relay 识别出试看/登录限制后使用；普通自动搬运不会发送 Cookie。
      options.autoAuthRetryCookie = String(this.getBilibiliAuthCookie?.() || "")
    }
    return await adapter.build(card, options)
  }

  formatInfo(job, card) {
    const adapter = this.platformAdapter(job.platform)
    if (!adapter) return "媒体解析"
    const links = adapter.formatLinks(card)
    return `${PLATFORM_LABELS[job.platform] || "媒体解析"}：${adapter.formatText(card)}${links ? `\n${links}` : ""}`
  }

  async releaseRelay(job, relay = emptyRelay()) {
    await Promise.all((relay.artifactLeases || []).map(lease => lease?.release?.()))
    await Promise.all((relay.sharedMediaFiles || []).map(file => fs.promises.unlink(file).catch(() => {})))
    const adapter = this.platformAdapter(job?.platform)
    await adapter?.cleanup(relay.tempFiles)
  }

  platformAdapter(platform) {
    const type = String(platform || "").toLowerCase()
    const adapters = {
      bilibili: {
        stableId: card => card?.bvid || card?.ep_id || card?.short_url || card?.page_url,
        enrich: this.enrichBilibili,
        build: this.buildBilibili,
        cleanup: cleanupBilibiliArchiveRelayFiles,
        formatText: formatBilibiliHistoryText,
        formatLinks: formatBilibiliHistoryLinks,
        relayOptions: {},
        enrichOptions: {},
        enabled: true,
        resolvedStatuses: ["resolved", "resolved_bangumi"]
      },
      douyin: {
        stableId: card => card?.aweme_id || card?.short_url || card?.page_url,
        enrich: this.enrichDouyin,
        build: this.buildDouyin,
        cleanup: cleanupDouyinArchiveRelayFiles,
        formatText: formatDouyinHistoryText,
        formatLinks: formatDouyinHistoryLinks,
        relayOptions: {},
        enrichOptions: {},
        enabled: true,
        resolvedStatuses: ["resolved"]
      },
      youtube: {
        stableId: card => card?.video_id || card?.page_url || card?.short_url,
        enrich: this.enrichYoutube,
        build: this.buildYoutube,
        cleanup: cleanupYoutubeArchiveRelayFiles,
        formatText: formatYoutubeHistoryText,
        formatLinks: formatYoutubeHistoryLinks,
        relayOptions: { youtubeRelay: this.youtubeRelay },
        enrichOptions: {
          binary: this.youtubeRelay.binary,
          timeoutMs: this.youtubeRelay.metadataTimeoutMs,
          proxyUrl: this.youtubeRelay.proxyUrl,
          cookieHeader: this.youtubeRelay.cookieHeader,
          poToken: this.youtubeRelay.poToken
        },
        enabled: this.youtubeRelay.enabled !== false,
        resolvedStatuses: ["resolved"]
      },
      pixiv: {
        stableId: card => card?.artwork_id || card?.page_url || card?.short_url,
        enrich: this.enrichPixiv,
        build: this.buildPixiv,
        cleanup: cleanupPixivArchiveRelayFiles,
        formatText: formatPixivHistoryText,
        formatLinks: formatPixivHistoryLinks,
        relayOptions: { pixivRelay: this.pixivRelay },
        enrichOptions: {},
        enabled: this.pixivRelay.enabled !== false,
        resolvedStatuses: ["resolved"]
      }
    }
    return adapters[type] || null
  }

  async prepareRelay(job) {
    const timings = { refresh: 0, playback: 0, download: 0 }
    let card = { ...job.media, type: job.platform }
    try {
      const refreshStartedAt = Date.now()
      const refreshed = await this.refreshCard(job)
      timings.refresh = Date.now() - refreshStartedAt
      if (refreshed && typeof refreshed === "object") card = refreshed
    } catch (error) {
      this.logger?.warn?.(`[MediaOutbox] 元数据刷新失败，使用事件快照 group=${job.groupId} id=${job.id}: ${cleanError(error)}`)
    }

    try {
      const relay = await this.buildRelay(job, card, (stage, elapsedMs) => {
        if (Object.hasOwn(timings, stage)) timings[stage] += Math.max(0, Number(elapsedMs) || 0)
      })
      return { card, relay: relay || emptyRelay(), relayBuildFailed: false, timings }
    } catch (error) {
      this.logger?.warn?.(`[MediaOutbox] 媒体资源组装失败，降级为信息节点 group=${job.groupId} id=${job.id}: ${cleanError(error)}`)
      return { card, relay: emptyRelay(), relayBuildFailed: true, timings }
    }
  }

  startPrewarm(job) {
    if (!job?.id || this.preparedRelays.has(job.id) || this.stopped) return
    const entry = { job, prepared: null, cleanupTimer: null, claimed: false, discarded: false, released: false }
    entry.promise = this.prepareSemaphore.run(() => this.prepareRelay(job))
      .then(prepared => {
        entry.prepared = prepared
        if (entry.discarded) this.releasePreparedRelay(entry).catch(error => {
          this.logger?.warn?.(`[MediaOutbox] 释放预准备资源失败 id=${job.id}: ${cleanError(error)}`)
        })
        return entry
      })
      .catch(error => {
        this.logger?.warn?.(`[MediaOutbox] 预准备异常 id=${job.id}: ${cleanError(error)}`)
        entry.prepared = { card: { ...job.media, type: job.platform }, relay: emptyRelay(), relayBuildFailed: true, timings: { refresh: 0, playback: 0, download: 0 } }
        return entry
      })
    entry.promise.then(() => {
      if (entry.discarded || entry.claimed) return
      entry.cleanupTimer = setTimeout(() => {
        this.discardPrewarm(job.id, entry).catch(error => {
          this.logger?.warn?.(`[MediaOutbox] 清理过期预准备资源失败 id=${job.id}: ${cleanError(error)}`)
        })
      }, PREPARED_RELAY_HOLD_MS)
      entry.cleanupTimer.unref?.()
    })
    this.preparedRelays.set(job.id, entry)
  }

  async releasePreparedRelay(entry) {
    if (!entry || entry.released || !entry.prepared?.relay) return
    entry.released = true
    await this.releaseRelay(entry.job, entry.prepared.relay)
  }

  async discardPrewarm(id, entry = this.preparedRelays.get(id)) {
    if (!entry) return
    entry.discarded = true
    if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer)
    if (this.preparedRelays.get(id) === entry) this.preparedRelays.delete(id)
    await entry.promise
    await this.releasePreparedRelay(entry)
  }

  async takePrewarm(id) {
    const entry = this.preparedRelays.get(id)
    if (!entry) return null
    await entry.promise
    if (entry.discarded || this.preparedRelays.get(id) !== entry) return null
    entry.claimed = true
    if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer)
    this.preparedRelays.delete(id)
    return entry.prepared
  }

  async process(id) {
    const token = await this.store.acquireLock("delivery", id, this.leaseMs)
    if (!token) {
      const current = await this.store.get("delivery", id)
      if (current && !["sent", "failed"].includes(current.state)) {
        const delay = current.state === "processing"
          ? Math.max(250, Number(current.leaseUntil || 0) - Date.now() + 100)
          : 500
        this.schedule(current.id, current.groupId, delay)
      }
      return false
    }
    const heartbeat = startLeaseHeartbeat({
      store: this.store,
      kind: "delivery",
      id,
      token,
      leaseMs: this.leaseMs,
      logger: this.logger
    })
    let job = await this.store.get("delivery", id)
    let relay = emptyRelay()
    const processStartedAt = Date.now()
    const timings = {
      queue: 0,
      refresh: 0,
      playback: 0,
      download: 0,
      encode: 0,
      send: 0,
      total: 0
    }
    try {
      if (!job || ["sent", "failed"].includes(job.state)) return false
      if (job.state === "retry_wait" && Number(job.nextRetryAt || 0) > Date.now()) {
        this.schedule(job.id, job.groupId, job.nextRetryAt - Date.now())
        return false
      }

      const now = Date.now()
      timings.queue = Math.max(0, now - Number(job.createdAt || now))
      job = {
        ...job,
        state: "processing",
        attempts: Number(job.attempts || 0) + 1,
        updatedAt: now,
        leaseUntil: now + this.leaseMs,
        ownerRunId: this.runId,
        lastError: ""
      }
      await this.store.save("delivery", id, job)

      const prepared = await this.takePrewarm(id) || await this.prepareRelay(job)
      const card = prepared.card
      relay = prepared.relay
      const relayBuildFailed = prepared.relayBuildFailed
      for (const stage of ["refresh", "playback", "download"]) {
        timings[stage] += Math.max(0, Number(prepared.timings?.[stage]) || 0)
      }
      const adapter = this.platformAdapter(job.platform)
      const relaySegments = Array.isArray(relay?.segments) ? relay.segments : []
      const videoSegments = relaySegments.filter(item => item?.type === "video")
      const nonVideoSegments = relaySegments.filter(item => item?.type !== "video")
      if (Array.isArray(relay?.qualityOptions) && relay.qualityOptions.length) {
        nonVideoSegments.push(`\n可选清晰度：${relay.qualityOptions.map(item => item.label).join("、")}`)
      }
      if (relayBuildFailed) nonVideoSegments.push("\n（媒体资源暂时获取失败，已保留基本信息和页面）")
      else if (card.metadata_status && !adapter?.resolvedStatuses?.includes(card.metadata_status)) {
        const reason = card.metadata_failure_reason || (card.metadata_status === "bangumi_metadata_failed"
          ? "已识别为B站番剧集，但番剧详情未返回可播放分集信息"
          : job.platform === "pixiv" ? "Pixiv 作品详情暂时未解析完成" : "视频详情暂时未解析完成")
        nonVideoSegments.push(`\n（${reason}，已保留当前卡片信息和页面）`)
      }
      const videos = []
      const encodeStartedAt = Date.now()
      for (const video of videoSegments) {
        relay.sharedMediaFiles ||= []
        videos.push(await inlineForwardVideoSegment(video, { artifactStore: this.artifactStore, sharedMedia: this.sharedMedia, sharedMediaFiles: relay.sharedMediaFiles }))
      }
      const inlineSegments = []
      for (const item of nonVideoSegments) {
        if (item?.type === "image") {
          relay.sharedMediaFiles ||= []
          inlineSegments.push(await inlineForwardLocalFileSegment(item, { artifactStore: this.artifactStore, sharedMedia: this.sharedMedia, sharedMediaFiles: relay.sharedMediaFiles }))
        } else {
          inlineSegments.push(item)
        }
      }
      timings.encode += Date.now() - encodeStartedAt
      const botRoot = globalThis.Bot
      const senderId = Number(job.botId || botRoot?.uin || 0) || 0
      const senderName = botRoot?.bots?.[String(job.botId)]?.nickname || botRoot?.nickname || "希洛"
      const nodes = [
        { user_id: senderId, nickname: senderName, message: [this.formatInfo(job, card), ...inlineSegments] },
        ...videos.map(video => ({ user_id: senderId, nickname: senderName, message: [video] }))
      ]
      await heartbeat.assertOwned()
      this.logger?.info?.(`[MediaOutbox] 发送 group=${job.groupId} id=${job.id} attempt=${job.attempts} nodes=${nodes.length}`)
      const sendStartedAt = Date.now()
      const receipt = await this.gateway.sendGroupForward({ botId: job.botId, groupId: job.groupId, nodes })
      timings.send += Date.now() - sendStartedAt
      timings.total = Date.now() - processStartedAt
      job = {
        ...job,
        state: "sent",
        updatedAt: Date.now(),
        leaseUntil: 0,
        ownerRunId: "",
        receipt,
        timings,
        lastError: ""
      }
      try {
        await this.store.save("delivery", id, job)
      } catch (error) {
        this.logger?.error?.(`[MediaOutbox] 发送已成功但回执状态持久化失败 group=${job.groupId} id=${job.id} message=${receipt?.messageId || ""}: ${cleanError(error)}`)
        return true
      }
      this.logger?.info?.(`[MediaOutbox] 已发送 group=${job.groupId} id=${job.id} message=${receipt?.messageId || ""}`)
      this.logger?.info?.(`[MediaTiming] group=${job.groupId} id=${job.id} queue=${timings.queue}ms refresh=${timings.refresh}ms playback=${timings.playback}ms download=${timings.download}ms encode=${timings.encode}ms send=${timings.send}ms total=${timings.total}ms`)
      return true
    } catch (error) {
      if (!job) return false
      if (error instanceof LeaseLostError) {
        this.logger?.warn?.(`[MediaOutbox] 租约已转移，旧 worker 停止提交状态 group=${job.groupId} id=${job.id}`)
        return false
      }
      const canRetry = error?.retryable !== false && Number(job.attempts || 0) < this.maxAttempts
      const delay = this.retryBaseMs * Math.pow(3, Math.max(0, Number(job.attempts || 1) - 1))
      job = {
        ...job,
        state: canRetry ? "retry_wait" : "failed",
        updatedAt: Date.now(),
        leaseUntil: 0,
        ownerRunId: "",
        nextRetryAt: canRetry ? Date.now() + delay : 0,
        lastError: cleanError(error),
        lastRetcode: error?.retcode ?? null,
        uncertain: Boolean(error?.uncertain)
      }
      await this.store.save("delivery", id, job)
      this.logger?.warn?.(`[MediaOutbox] ${canRetry ? "等待重试" : "最终失败"} group=${job.groupId} id=${job.id} attempt=${job.attempts}: ${job.lastError}`)
      if (canRetry) this.schedule(job.id, job.groupId, delay)
      return false
    } finally {
      heartbeat.stop()
      await this.releaseRelay(job, relay)
      await this.store.releaseLock("delivery", id, token).catch(error => {
        this.logger?.warn?.(`[MediaOutbox] 释放投递锁失败 id=${id}: ${cleanError(error)}`)
      })
    }
  }

  async getStatus(id) {
    return await this.store.get("delivery", id)
  }

  stop() {
    this.stopped = true
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.refreshPromises.clear()
    for (const [id, entry] of this.preparedRelays) {
      this.discardPrewarm(id, entry).catch(error => {
        this.logger?.warn?.(`[MediaOutbox] 停止时清理预准备资源失败 id=${id}: ${cleanError(error)}`)
      })
    }
    this.preparedRelays.clear()
    this.artifactStore?.stop?.().catch?.(error => {
      this.logger?.warn?.(`[MediaArtifactStore] 停止清理失败: ${cleanError(error)}`)
    })
  }
}
