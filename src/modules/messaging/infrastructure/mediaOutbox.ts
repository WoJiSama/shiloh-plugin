import { randomUUID } from "node:crypto"
import fs from "node:fs"
import { AsyncSemaphore, KeyedSerialQueue } from "./keyedSerialQueue.js"
import { LeaseLostError, startLeaseHeartbeat } from "./leaseHeartbeat.js"
import type { DeliverySegment, ForwardNode, FileOptions } from './deliveryGateway.js'
import type { RedisJobStore } from './redisJobStore.js'
interface Card { type: string; bvid?: string; ep_id?: string; short_url?: string; page_url?: string; aweme_id?: string; video_id?: string; artwork_id?: string; note_id?: string; metadata_status?: string; metadata_failure_reason?: string; [key: string]: unknown }
interface Relay { segments: (DeliverySegment | string)[]; tempFiles: string[]; artifactLeases?: { release(): Promise<unknown> }[]; sharedMediaFiles?: string[]; qualityOptions?: { label: string }[]; imageNodes?: DeliverySegment[]; textNodes?: string[] }
interface Timings { refresh: number; playback: number; download: number }
interface Job { version: number; id: string; eventId: string; platform: string; botId: string; groupId: string; messageId: string; media: Card; state: string; attempts: number; createdAt: number; updatedAt: number; nextRetryAt: number; leaseUntil: number; ownerRunId: string; receipt: unknown; lastError: string; fallbackStatus?: string; fallbackReason?: string; lastMediaError?: string; timings?: object; lastRetcode?: unknown; uncertain?: boolean }
export function isDeliveryJob(value: unknown): value is Job {
 const job = record(value), media = record(job.media)
 if (!value || Array.isArray(value) || !job.media || Array.isArray(job.media)) return false
 if (!['pending','processing','retry_wait','sending','sent','failed','uncertain'].includes(String(job.state))) return false
 if (job.version !== 1 || typeof job.id !== 'string' || !job.id || typeof job.eventId !== 'string' || !job.eventId) return false
 if (typeof job.platform !== 'string' || !['bilibili','douyin','youtube','pixiv','xiaohongshu'].includes(job.platform) || media.type !== job.platform) return false
 if (typeof job.botId !== 'string' || !/^[1-9]\d*$/.test(job.botId) || typeof job.groupId !== 'string' || !/^[1-9]\d*$/.test(job.groupId)) return false
 if (typeof job.messageId !== 'string' || typeof job.ownerRunId !== 'string' || typeof job.lastError !== 'string') return false
 for (const field of ['attempts','createdAt','updatedAt','nextRetryAt','leaseUntil']) if (typeof job[field] !== 'number' || !Number.isFinite(job[field]) || Number(job[field]) < 0) return false
 if (!Number.isInteger(job.attempts)) return false
 for (const field of ['bvid','ep_id','short_url','page_url','aweme_id','video_id','artwork_id','note_id','metadata_status','metadata_failure_reason']) if (media[field] !== undefined && typeof media[field] !== 'string') return false
 return true
}
interface Prepared { card: Card; relay: Relay; relayBuildFailed: boolean; timings: Timings }
interface PreparedEntry { job: Job; prepared: Prepared | null; cleanupTimer: ReturnType<typeof setTimeout> | null; claimed: boolean; discarded: boolean; released: boolean; promise?: Promise<PreparedEntry> }
interface Logger { info?(message: string): void; warn?(message: string): void; error?(message: string): void }
type Enrich = (card: Card, options: object) => Promise<Card>
type Build = (card: Card, options: object) => Promise<Relay>
interface PlatformAdapter { stableId(card: Card): string | undefined; enrich: Enrich; build: Build; cleanup(files: string[]): Promise<unknown>; formatText(card: Card): string; formatLinks(card: Card): string; relayOptions: object; enrichOptions: object; enabled: boolean; resolvedStatuses: string[] }
interface RelayConfig { enabled?: boolean; binary?: unknown; metadataTimeoutMs?: unknown; proxyUrl?: unknown; cookieHeader?: unknown; poToken?: unknown }
interface OutboxOptions {
 store: RedisJobStore; gateway: { sendGroupForward(args: {botId:string;groupId:string;nodes:ForwardNode[]}): Promise<unknown>; sendGroupText?(args:{botId:string;groupId:string;text:string}):Promise<unknown>; sendGroupSegments?(args:{botId:string;groupId:string;segments:DeliverySegment[]}):Promise<unknown> }; logger?: Logger
 enabled?: boolean; maxAttempts?: number; retryBaseMs?: number; leaseMs?: number; queue?: KeyedSerialQueue; concurrency?: number; prepareConcurrency?: number
 enrichBilibili?: Enrich; enrichDouyin?: Enrich; enrichYoutube?: Enrich; enrichPixiv?: Enrich; enrichXiaohongshu?: Enrich
 buildBilibili?: Build; buildDouyin?: Build; buildYoutube?: Build; buildPixiv?: Build; buildXiaohongshu?: Build
 autoBilibiliMemberAuth?: boolean; getBilibiliAuthCookie?: () => string; artifactStore?: (NonNullable<FileOptions['artifactStore']> & { stop?(): Promise<unknown> }) | null
 sharedMedia?: FileOptions['sharedMedia']; prepareThumbnail?: (file: string) => Promise<{file:string;cleanup():Promise<unknown>}>; youtubeRelay?: RelayConfig; pixivRelay?: RelayConfig; xiaohongshuRelay?: RelayConfig
}
interface OutboxPorts {
 defaults: Required<Pick<OutboxOptions,'enrichBilibili'|'enrichDouyin'|'enrichYoutube'|'enrichPixiv'|'enrichXiaohongshu'|'buildBilibili'|'buildDouyin'|'buildYoutube'|'buildPixiv'|'buildXiaohongshu'|'prepareThumbnail'>>
 platforms: Record<'bilibili'|'douyin'|'youtube'|'pixiv'|'xiaohongshu', Pick<PlatformAdapter,'cleanup'|'formatText'|'formatLinks'>>
 logger?: Logger; botIdentity(botId:string): { uin?: string | number; nickname?: string }
 isForwardResourceFailure(error: unknown): boolean
 inlineForwardLocalFileSegment(segment: DeliverySegment, options: FileOptions): Promise<DeliverySegment>
 inlineForwardVideoSegment(segment: DeliverySegment, options: FileOptions): Promise<DeliverySegment>
}
function record(value: unknown): Record<string,unknown> { return value && typeof value === 'object' ? value as Record<string,unknown> : {} }
export function createMediaOutboxClass(ports: OutboxPorts) {
const { inlineForwardLocalFileSegment, inlineForwardVideoSegment, isForwardResourceFailure } = ports
const { enrichBilibili: enrichBilibiliShare, enrichDouyin: enrichDouyinShare, enrichYoutube: enrichYoutubeShare, enrichPixiv: enrichPixivShare, enrichXiaohongshu: enrichXiaohongshuShare, buildBilibili: buildBilibiliArchiveRelaySegments, buildDouyin: buildDouyinArchiveRelaySegments, buildYoutube: buildYoutubeArchiveRelaySegments, buildPixiv: buildPixivArchiveRelaySegments, buildXiaohongshu: buildXiaohongshuRelaySegments, prepareThumbnail: createVideoThumbnail } = ports.defaults
const { cleanup: cleanupBilibiliArchiveRelayFiles, formatText: formatBilibiliHistoryText, formatLinks: formatBilibiliHistoryLinks } = ports.platforms.bilibili
const { cleanup: cleanupDouyinArchiveRelayFiles, formatText: formatDouyinHistoryText, formatLinks: formatDouyinHistoryLinks } = ports.platforms.douyin
const { cleanup: cleanupYoutubeArchiveRelayFiles, formatText: formatYoutubeHistoryText, formatLinks: formatYoutubeHistoryLinks } = ports.platforms.youtube
const { cleanup: cleanupPixivArchiveRelayFiles, formatText: formatPixivHistoryText, formatLinks: formatPixivHistoryLinks } = ports.platforms.pixiv
const { cleanup: cleanupXiaohongshuRelayFiles, formatText: formatXiaohongshuHistoryText, formatLinks: formatXiaohongshuHistoryLinks } = ports.platforms.xiaohongshu

const DEFAULT_MAX_ATTEMPTS = 4
const DEFAULT_RETRY_BASE_MS = 5000
const DEFAULT_LEASE_MS = 15 * 60 * 1000
const DEFAULT_PREPARE_CONCURRENCY = 2
const PREPARED_RELAY_HOLD_MS = 3 * 60 * 1000

const segmentApi = {
  image: (file: string) => ({ type: "image", file }),
  video: (file: string) => ({ type: "video", file })
}

function cleanError(error: unknown) {
  return String(record(error).message || error || "unknown error").replace(/https?:\/\/\S+/g, "[url]").slice(0, 500)
}

function serializeMedia(card: Card): Card {
  const output: Card = { type: card.type }
  for (const [key, value] of Object.entries(card || {})) {
    if (["play_url", "runtimeMessage", "tempFiles"].includes(key)) continue
    if (typeof value === "function" || value === undefined) continue
    output[key] = value
  }
  return output
}

function emptyRelay(): Relay {
  return { segments: [], tempFiles: [], artifactLeases: [], sharedMediaFiles: [] }
}

function deliveryIdFor({ platform, botId, groupId, messageId, eventId }: { platform: string; botId: string; groupId: string | null; messageId: string; eventId: string }) {
  return ["v1", platform || "media", botId || "bot", groupId || "group", messageId || eventId].join(":")
}

const PLATFORM_LABELS: Readonly<Record<string,string>> = Object.freeze({
  bilibili: "B站视频搬一下",
  douyin: "抖音视频搬一下",
  youtube: "YouTube视频搬一下",
  pixiv: "Pixiv作品解析",
  xiaohongshu: "小红书笔记搬一下"
})

class MediaOutbox {
 store: RedisJobStore; gateway: OutboxOptions['gateway']; logger: Logger | undefined; enabled: boolean; maxAttempts:number; retryBaseMs:number;leaseMs:number
 queue: KeyedSerialQueue; semaphore: AsyncSemaphore; prepareSemaphore: AsyncSemaphore
 enrichBilibili: Enrich; enrichDouyin: Enrich; enrichYoutube: Enrich; enrichPixiv: Enrich; enrichXiaohongshu: Enrich
 buildBilibili: Build; buildDouyin: Build; buildYoutube: Build; buildPixiv: Build; buildXiaohongshu: Build
 autoBilibiliMemberAuth:boolean;getBilibiliAuthCookie:()=>string;artifactStore:OutboxOptions['artifactStore'];sharedMedia:FileOptions['sharedMedia'];prepareThumbnail:NonNullable<OutboxOptions['prepareThumbnail']>;youtubeRelay:RelayConfig;pixivRelay:RelayConfig;xiaohongshuRelay:RelayConfig
 refreshPromises:Map<string,Promise<Card>>;preparedRelays:Map<string,PreparedEntry>;runId:string;timers:Map<string,ReturnType<typeof setTimeout>>;stopped:boolean

  constructor({
    store,
    gateway,
    logger = ports.logger,
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
    enrichXiaohongshu = enrichXiaohongshuShare,
    buildBilibili = buildBilibiliArchiveRelaySegments,
    buildDouyin = buildDouyinArchiveRelaySegments,
    buildYoutube = buildYoutubeArchiveRelaySegments,
    buildPixiv = buildPixivArchiveRelaySegments,
    buildXiaohongshu = buildXiaohongshuRelaySegments,
    autoBilibiliMemberAuth = false,
    getBilibiliAuthCookie = () => "",
    artifactStore = null,
    sharedMedia = null,
    prepareThumbnail = createVideoThumbnail,
    youtubeRelay = {},
    pixivRelay = {},
    xiaohongshuRelay = {}
  }: OutboxOptions) {
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
    this.enrichXiaohongshu = enrichXiaohongshu
    this.buildBilibili = buildBilibili
    this.buildDouyin = buildDouyin
    this.buildYoutube = buildYoutube
    this.buildPixiv = buildPixiv
    this.buildXiaohongshu = buildXiaohongshu
    this.autoBilibiliMemberAuth = autoBilibiliMemberAuth === true
    this.getBilibiliAuthCookie = getBilibiliAuthCookie
    this.artifactStore = artifactStore
    this.sharedMedia = sharedMedia
    this.prepareThumbnail = prepareThumbnail
    this.youtubeRelay = youtubeRelay && typeof youtubeRelay === "object" ? youtubeRelay : {}
    this.pixivRelay = pixivRelay && typeof pixivRelay === "object" ? pixivRelay : {}
    this.xiaohongshuRelay = xiaohongshuRelay && typeof xiaohongshuRelay === "object" ? xiaohongshuRelay : {}
    this.refreshPromises = new Map()
    this.preparedRelays = new Map()
    this.runId = randomUUID()
    this.timers = new Map()
    this.stopped = false
  }

  async enqueue({ envelope, media }: { envelope: {botId:string;groupId:string|null;messageId:string;eventId:string}; media:Card }) {
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
    const job: Job = {
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
    const current = created ? job : await this.store.get<Job>("delivery", id, isDeliveryJob)
    if (created && !this.stopped) this.startPrewarm(job)
    if (current && !["sent", "failed", "uncertain"].includes(current.state)) this.schedule(id, current.groupId)
    return current
  }

  schedule(id: string, groupId: string, delayMs = 0) {
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
    const jobs = await this.store.list<Job>("delivery", isDeliveryJob)
    let count = 0
    for (const job of jobs) {
      if (!job?.id || ["sent", "failed", "uncertain"].includes(job.state)) continue
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

  async refreshCard(job: Job): Promise<Card> {
    const adapter = this.platformAdapter(job.platform)
    if (!adapter) return { ...job.media, type: job.platform }
    const stableId = adapter.stableId(job.media)
    const key = stableId ? `${job.platform}:${stableId}` : ""
    if (key && this.refreshPromises.has(key)) return await this.refreshPromises.get(key)!
    const promise = adapter.enrich({ ...job.media, type: job.platform }, { cacheTtlMs: 0, ...adapter.enrichOptions })
    if (key) this.refreshPromises.set(key, promise)
    try {
      return await promise
    } finally {
      if (key && this.refreshPromises.get(key) === promise) this.refreshPromises.delete(key)
    }
  }

  async buildRelay(job: Job, card: Card, onTiming: (stage: keyof Timings, elapsedMs: number) => void) {
    const adapter = this.platformAdapter(job.platform)
    if (!adapter) return emptyRelay()
    const options: Record<string, unknown> = { segmentApi, logger: this.logger, artifactStore: this.artifactStore, onTiming, ...adapter.relayOptions }
    if (job.platform === "bilibili" && this.autoBilibiliMemberAuth) {
      // 仅在 relay 识别出试看/登录限制后使用；普通自动搬运不会发送 Cookie。
      options.autoAuthRetryCookie = String(this.getBilibiliAuthCookie?.() || "")
    }
    return await adapter.build(card, options)
  }

  formatInfo(job: Job, card: Card) {
    const adapter = this.platformAdapter(job.platform)
    if (!adapter) return "媒体解析"
    const links = adapter.formatLinks(card)
    return `${PLATFORM_LABELS[job.platform] || "媒体解析"}：${adapter.formatText(card)}${links ? `\n${links}` : ""}`
  }

  async releaseRelay(job: Job | null, relay = emptyRelay()) {
    await Promise.all((relay.artifactLeases || []).map(lease => lease?.release?.()))
    await Promise.all((relay.sharedMediaFiles || []).map(file => fs.promises.unlink(file).catch(() => {})))
    const adapter = this.platformAdapter(job?.platform)
    await adapter?.cleanup(relay.tempFiles)
  }

  // 多账号:合并转发要用的媒体文件必须落在"发送 bot 那个 napcat 容器"的挂载目录里,
  // 否则容器内 ENOENT。约定(add-account.sh):各账号宿主目录 /opt/napcat-<qq>/config,
  // 主号/旧部署用配置默认;容器内路径 /app/napcat/config/... 所有 napcat 一致。
  sharedMediaFor(botId = "") {
    const base = this.sharedMedia
    if (!base?.hostDir || !base?.containerDir) return base
    const qq = String(botId || "").trim()
    if (!/^\d{4,12}$/.test(qq)) return base
    try {
      if (fs.existsSync(`/opt/napcat-${qq}/config`)) {
        return { hostDir: `/opt/napcat-${qq}/config/bl-chat-media`, containerDir: base.containerDir }
      }
    } catch {}
    return base
  }

  platformAdapter(platform: unknown): PlatformAdapter | null {
    const type = String(platform || "").toLowerCase()
    const adapters: Record<string, PlatformAdapter> = {
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
        enrichOptions: { proxyUrl: this.pixivRelay.proxyUrl },
        enabled: this.pixivRelay.enabled !== false,
        resolvedStatuses: ["resolved"]
      },
      xiaohongshu: {
        stableId: card => card?.note_id || card?.page_url || card?.short_url,
        enrich: this.enrichXiaohongshu,
        build: this.buildXiaohongshu,
        cleanup: cleanupXiaohongshuRelayFiles,
        formatText: formatXiaohongshuHistoryText,
        formatLinks: formatXiaohongshuHistoryLinks,
        relayOptions: { xiaohongshuRelay: this.xiaohongshuRelay },
        enrichOptions: { cookieHeader: this.xiaohongshuRelay.cookieHeader },
        enabled: this.xiaohongshuRelay.enabled !== false,
        resolvedStatuses: ["resolved"]
      }
    }
    return adapters[type] || null
  }

  async prepareRelay(job: Job): Promise<Prepared> {
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

  startPrewarm(job: Job) {
    if (!job?.id || this.preparedRelays.has(job.id) || this.stopped) return
    const entry: PreparedEntry = { job, prepared: null, cleanupTimer: null, claimed: false, discarded: false, released: false }
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

  async releasePreparedRelay(entry: PreparedEntry) {
    if (!entry || entry.released || !entry.prepared?.relay) return
    entry.released = true
    await this.releaseRelay(entry.job, entry.prepared.relay)
  }

  async discardPrewarm(id: string, entry = this.preparedRelays.get(id)) {
    if (!entry) return
    entry.discarded = true
    if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer)
    if (this.preparedRelays.get(id) === entry) this.preparedRelays.delete(id)
    await entry.promise
    await this.releasePreparedRelay(entry)
  }

  async takePrewarm(id: string) {
    const entry = this.preparedRelays.get(id)
    if (!entry) return null
    await entry.promise
    if (entry.discarded || this.preparedRelays.get(id) !== entry) return null
    entry.claimed = true
    if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer)
    this.preparedRelays.delete(id)
    return entry.prepared
  }

  async process(id: string) {
    const token = await this.store.acquireLock("delivery", id, this.leaseMs)
    if (!token) {
      const current = await this.store.get<Job>("delivery", id, isDeliveryJob)
      if (current && !["sent", "failed", "uncertain"].includes(current.state)) {
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
      ...(this.logger ? { logger: this.logger } : {})
    })
    let job = await this.store.get<Job>("delivery", id, isDeliveryJob)
    let relay = emptyRelay()
    const processStartedAt = Date.now()
    let thumbnailFailure = ""
    const thumbnailLeases = []
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
      if (!job || ["sent", "failed", "uncertain"].includes(job.state)) return false
      if (job.state === "retry_wait" && Number(job.nextRetryAt || 0) > Date.now()) {
        this.schedule(job.id, job.groupId, job.nextRetryAt - Date.now())
        return false
      }

      if (job.state === "sending") {
        job = { ...job, state: "uncertain", uncertain: true, lastError: "发送已开始但回执未持久化，禁止自动重发", leaseUntil: 0, ownerRunId: "" }
        await this.store.save("delivery", id, job)
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
      for (const stage of ["refresh", "playback", "download"] as const) {
        timings[stage] += Math.max(0, Number(prepared.timings?.[stage]) || 0)
      }
      const adapter = this.platformAdapter(job.platform)
      const relaySegments = Array.isArray(relay?.segments) ? relay.segments : []
      const videoSegments = relaySegments.filter((item): item is DeliverySegment => (typeof item === 'string' ? '' : item?.type) === "video")
      const nonVideoSegments = relaySegments.filter((item) => (typeof item === 'string' ? '' : item?.type) !== "video")
      if (Array.isArray(relay?.qualityOptions) && relay.qualityOptions.length) {
        nonVideoSegments.push(`\n可选清晰度：${relay.qualityOptions.map(item => item.label).join("、")}`)
      }
      if (relayBuildFailed) nonVideoSegments.push("\n（媒体资源暂时获取失败，已保留基本信息和页面）")
      else if (card.metadata_status && !adapter?.resolvedStatuses?.includes(card.metadata_status)) {
        const reason = card.metadata_failure_reason || (card.metadata_status === "bangumi_metadata_failed"
          ? "已识别为B站番剧集，但番剧详情未返回可播放分集信息"
          : job.platform === "pixiv" ? "Pixiv 作品详情暂时未解析完成"
          : job.platform === "xiaohongshu" ? "小红书笔记详情暂时未解析完成"
          : "视频详情暂时未解析完成")
        nonVideoSegments.push(`\n（${reason}，已保留当前卡片信息和页面）`)
      }
      const videos:DeliverySegment[] = []
      const encodeStartedAt = Date.now()
      for (const video of videoSegments) {
        relay.sharedMediaFiles ||= []
        try {
          const thumbnail = await this.prepareThumbnail(String((video.data || video).file || ''))
          thumbnailLeases.push(thumbnail)
          const withThumb = video.data ? { ...video, data: { ...video.data, thumb: thumbnail.file } } : { ...video, thumb: thumbnail.file }
          videos.push(await inlineForwardVideoSegment(withThumb, { artifactStore: this.artifactStore, sharedMedia: this.sharedMediaFor(job.botId), sharedMediaFiles: relay.sharedMediaFiles }))
        } catch (error) {
          if (!isForwardResourceFailure(error)) throw error
          thumbnailFailure = String(record(error).message)
          break
        }
      }
      const inlineSegments = []
      for (const item of nonVideoSegments) {
        if ((typeof item === 'string' ? '' : item?.type) === "image") {
          relay.sharedMediaFiles ||= []
          inlineSegments.push(await inlineForwardLocalFileSegment(item as DeliverySegment, { artifactStore: this.artifactStore, sharedMedia: this.sharedMediaFor(job.botId), sharedMediaFiles: relay.sharedMediaFiles }))
        } else {
          inlineSegments.push(item)
        }
      }
      // 图集(图文作品)节点:与视频节点同构,每张图一个节点,全部进同一条合并转发
      const galleryImages = []
      for (const image of Array.isArray(relay.imageNodes) ? relay.imageNodes : []) {
        if (image?.type !== "image") continue
        relay.sharedMediaFiles ||= []
        galleryImages.push(await inlineForwardLocalFileSegment(image, { artifactStore: this.artifactStore, sharedMedia: this.sharedMediaFor(job.botId), sharedMediaFiles: relay.sharedMediaFiles }))
      }
      timings.encode += Date.now() - encodeStartedAt
      const botRoot = ports.botIdentity(job.botId)
      const senderId = Number(job.botId || botRoot?.uin || 0) || 0
      const senderName = botRoot?.nickname || "希洛"
      // 独立文本节点(如小红书简介全文):紧跟信息节点,不与媒体混排
      const textOnlyNodes = (Array.isArray(relay.textNodes) ? relay.textNodes : [])
        .map(text => String(text || "").trim())
        .filter(Boolean)
        .map(text => ({ user_id: senderId, nickname: senderName, message: [text] }))
      const nodes = [
        { user_id: senderId, nickname: senderName, message: [this.formatInfo(job, card), ...inlineSegments] },
        ...textOnlyNodes,
        ...videos.map(video => ({ user_id: senderId, nickname: senderName, message: [video] })),
        ...galleryImages.map(image => ({ user_id: senderId, nickname: senderName, message: [image] }))
      ]
      await heartbeat.assertOwned()
      this.logger?.info?.(`[MediaOutbox] 发送 group=${job.groupId} id=${job.id} attempt=${job.attempts} nodes=${nodes.length}`)
      job = { ...job, state: "sending", updatedAt: Date.now() }
      await this.store.save("delivery", id, job)
      await heartbeat.assertOwned()
      const sendStartedAt = Date.now()
      let receipt
      const fallbackText = `${this.formatInfo(job, card)}\n${card.page_url || job.media?.page_url || ""}\n（视频转发资源暂不可用，已改为发送原视频链接）`
      const fallback = async (error: unknown) => {
        if (typeof this.gateway.sendGroupText !== "function") throw error
        await heartbeat.assertOwned()
        const result = await this.gateway.sendGroupText({ botId: job!.botId, groupId: job!.groupId, text: fallbackText })
        job = { ...job!, fallbackStatus: "link_sent", fallbackReason: /video_thumbnail_missing/.test(String(record(error).message)) ? "video_thumbnail_missing" : "forward_resource_upload_failed", lastMediaError: cleanError(error) }
        return result
      }
      // 大视频在 napcat 的转发资源上传容易失败(实测 697s/百 MB 级):
      // 先发信息文字,再把视频本体作为普通消息直发(send_group_msg 另一条上传路径),
      // 直发也失败才退到纯文字链接
      const directVideoFallback = async (error: unknown) => {
        if (typeof this.gateway.sendGroupSegments !== "function" || !videos.length || typeof this.gateway.sendGroupText !== "function") throw error
        await heartbeat.assertOwned()
        await this.gateway.sendGroupText({ botId: job!.botId, groupId: job!.groupId, text: `${this.formatInfo(job!, card)}\n${card.page_url || job!.media?.page_url || ""}\n（合并转发上传失败，视频改为直接发送）` })
        const result = await this.gateway.sendGroupSegments({ botId: job!.botId, groupId: job!.groupId, segments: videos })
        job = { ...job!, fallbackStatus: "direct_video_sent", fallbackReason: "forward_resource_upload_failed", lastMediaError: cleanError(error) }
        return result
      }
      if (thumbnailFailure) {
        receipt = await fallback(new Error(thumbnailFailure))
      } else {
        try {
          receipt = await this.gateway.sendGroupForward({ botId: job.botId, groupId: job.groupId, nodes })
        } catch (error) {
          if (!videos.length || !isForwardResourceFailure(error) || record(error).uncertain) throw error
          // Explicit resource preprocessing failure proves no forward was sent.
          await heartbeat.assertOwned()
          try {
            receipt = await this.gateway.sendGroupForward({ botId: job.botId, groupId: job.groupId, nodes })
          } catch (retryError) {
            if (!isForwardResourceFailure(retryError) || record(retryError).uncertain) throw retryError
            try {
              receipt = await directVideoFallback(retryError)
            } catch (directError) {
              if (record(directError).uncertain) throw directError
              receipt = await fallback(retryError)
            }
          }
        }
      }
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
        this.logger?.error?.(`[MediaOutbox] 发送已成功但回执状态持久化失败 group=${job.groupId} id=${job.id} message=${record(receipt).messageId || ""}: ${cleanError(error)}`)
        job = { ...job, state: "uncertain", uncertain: true, lastError: "发送已成功但回执状态持久化失败，禁止自动重发" }
        await this.store.save("delivery", id, job).catch(() => {})
        return true
      }
      this.logger?.info?.(`[MediaOutbox] 已发送 group=${job.groupId} id=${job.id} message=${record(receipt).messageId || ""}`)
      this.logger?.info?.(`[MediaTiming] group=${job.groupId} id=${job.id} queue=${timings.queue}ms refresh=${timings.refresh}ms playback=${timings.playback}ms download=${timings.download}ms encode=${timings.encode}ms send=${timings.send}ms total=${timings.total}ms`)
      return true
    } catch (error) {
      if (!job) return false
      if (error instanceof LeaseLostError) {
        this.logger?.warn?.(`[MediaOutbox] 租约已转移，旧 worker 停止提交状态 group=${job.groupId} id=${job.id}`)
        return false
      }
      const canRetry = !record(error).uncertain && record(error).retryable !== false && Number(job.attempts || 0) < this.maxAttempts
      const delay = this.retryBaseMs * Math.pow(3, Math.max(0, Number(job.attempts || 1) - 1))
      job = {
        ...job,
        state: record(error).uncertain ? "uncertain" : canRetry ? "retry_wait" : "failed",
        updatedAt: Date.now(),
        leaseUntil: 0,
        ownerRunId: "",
        nextRetryAt: canRetry ? Date.now() + delay : 0,
        lastError: cleanError(error),
        lastRetcode: record(error).retcode ?? null,
        uncertain: Boolean(record(error).uncertain)
      }
      await this.store.save("delivery", id, job)
      this.logger?.warn?.(`[MediaOutbox] ${canRetry ? "等待重试" : "最终失败"} group=${job.groupId} id=${job.id} attempt=${job.attempts}: ${job.lastError}`)
      if (canRetry) this.schedule(job.id, job.groupId, delay)
      return false
    } finally {
      heartbeat.stop()
      await Promise.all(thumbnailLeases.map(item => item.cleanup().catch(() => {})))
      await this.releaseRelay(job, relay)
      await this.store.releaseLock("delivery", id, token).catch(error => {
        this.logger?.warn?.(`[MediaOutbox] 释放投递锁失败 id=${id}: ${cleanError(error)}`)
      })
    }
  }

  async getStatus(id: string) {
    return await this.store.get<Job>("delivery", id, isDeliveryJob)
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
return MediaOutbox
}
