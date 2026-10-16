import { startLeaseHeartbeat, LeaseLostError } from './leaseHeartbeat.js'
import { randomUUID } from 'node:crypto'
import { envelopeToRuntimeEvent, isEnvelopeFromBot } from './eventEnvelope.js'
import { AsyncSemaphore, KeyedSerialQueue } from './keyedSerialQueue.js'
import type { PipelinePorts,PipelineOptions,PipelineEmitter,EventJob } from '../../../contracts/messagePipeline.js'
import type { EventEnvelope, MessageSegment, ForwardContext } from '../../../contracts/pipeline.js'
import {parseForwardCompleteness} from '../../conversation/domain/forwardCompleteness.js'
export function isEventJob(value: unknown): value is EventJob {
 if (!value || typeof value !== 'object') return false
 const job = value as Record<string, unknown>
 if (job.version !== 1 || typeof job.id !== 'string' || !job.id || !['pending','processing','retry_wait','completed','failed'].includes(String(job.state))) return false
 if (!['attempts','createdAt','updatedAt','nextRetryAt','leaseUntil'].every(key => typeof job[key] === 'number' && Number.isFinite(job[key]))) return false
 if (typeof job.ownerRunId !== 'string' || typeof job.lastError !== 'string') return false
 if (!job.consumers || typeof job.consumers !== 'object') return false
 const consumers = job.consumers as Record<string, unknown>
 if (!['recent','archive','media','emoji'].every(key => ['pending','done','skipped','accepted'].includes(String(consumers[key])))) return false
 if (!job.envelope || typeof job.envelope !== 'object') return false
 const envelope = job.envelope as Record<string, unknown>
 if (envelope.version !== 1 || envelope.eventId !== job.id || !Array.isArray(envelope.message)) return false
 if (!envelope.message.every(item => item && typeof item === 'object' && !Array.isArray(item))) return false
 return ['eventId','postType','messageType','noticeType','subType','botId','conversationType','conversationId','groupId','groupName','userId','messageId','rawMessage','operatorId','targetId','adapterId','adapterName'].every(key => typeof envelope[key] === 'string') &&
   ['occurredAt','capturedAt'].every(key => typeof envelope[key] === 'number' && Number.isFinite(envelope[key]))
}
export function createMessagePipelineClass(ports:PipelinePorts) {
 const {extractBilibiliShareFromSegment,extractBilibiliShareFromText,extractDouyinShareFromText,extractYoutubeShareFromText,extractPixivShareFromText,isResponsibleBot,isFederationSibling,markBotOnline,onlineBotList,createEventEnvelope}=ports
 const {enrichBilibili:enrichBilibiliMessageSegments,enrichDouyin:enrichDouyinMessageSegments,enrichYoutube:enrichYoutubeMessageSegments,enrichPixiv:enrichPixivMessageSegments}=ports
const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_RETRY_BASE_MS = 1000
const DEFAULT_LEASE_MS = 5 * 60 * 1000

function cleanError(error: unknown) {
  return String((error instanceof Error ? error.message : error) || "unknown error").replace(/https?:\/\/\S+/g, "[url]").slice(0, 500)
}

function initialConsumers(envelope: EventEnvelope) {
  if (envelope.postType === "notice") {
    return { recent: "skipped", archive: "pending", media: "skipped", emoji: "skipped" }
  }
  return { recent: "pending", archive: "pending", media: "pending", emoji: "pending" }
}

function findRawMedia(envelope: EventEnvelope) {
  for (const segment of Array.isArray(envelope.message) ? envelope.message : []) {
    const bilibili = extractBilibiliShareFromSegment(segment, envelope.rawMessage)
    if (bilibili) return bilibili
    if (segment?.type === "douyin") return { ...segment }
  }
  const bilibili = extractBilibiliShareFromSegment({ type: "json" }, envelope.rawMessage) || extractBilibiliShareFromText(envelope.rawMessage)
  if (bilibili) return bilibili
  return extractDouyinShareFromText(envelope.rawMessage)
    || extractYoutubeShareFromText(envelope.rawMessage)
    || extractPixivShareFromText(envelope.rawMessage)
}

function hasCollectibleImage(envelope: EventEnvelope) {
  return Array.isArray(envelope.message)
    && envelope.message.some(segment => segment?.type === "image" && segment?.url)
}

function appendForwardContextSegment(message: MessageSegment[] = [], context: ForwardContext = {}) {
  const text = String(context?.text || "").trim()
  if (!text || !Array.isArray(message)) return message
  if (message.some(segment => segment?.type === "forward_context")) return message
  return [
    ...message,
    {
      type: "forward_context",
      text,
      forward_ids: Array.isArray(context.forwardIds) ? context.forwardIds.map(String) : [],
      media: Array.isArray(context.media) ? context.media : [],
      forward_nodes: Array.isArray(context.forwardNodes) ? context.forwardNodes : [],
      ...(context.completeness ? {completeness: context.completeness} : {})
    }
  ]
}

class MessagePipeline {
  store:PipelineOptions['store']; recentManager:PipelineOptions['recentManager']; archiveManager:PipelineOptions['archiveManager']; mediaOutbox:PipelineOptions['mediaOutbox']; emojiCollector:PipelineOptions['emojiCollector'];stats:PipelineOptions['stats'];logger:PipelineOptions['logger'];queue:NonNullable<PipelineOptions["queue"]>;semaphore:AsyncSemaphore;emojiSemaphore:AsyncSemaphore;maxAttempts:number;retryBaseMs:number;leaseMs:number;enrichBilibili:PipelinePorts['enrichBilibili'];enrichDouyin:PipelinePorts['enrichDouyin'];enrichYoutube:PipelinePorts['enrichYoutube'];enrichPixiv:PipelinePorts['enrichPixiv'];resolveForwardContext:PipelineOptions['resolveForwardContext'];runId:string;timers:Map<string,ReturnType<typeof setTimeout>>;stopped:boolean;botEmitter:PipelineEmitter|undefined;messageListener:((event:unknown)=>void)|undefined;noticeListener:((event:unknown)=>void)|undefined
  constructor({
    store,
    recentManager,
    archiveManager,
    mediaOutbox,
    emojiCollector,
    logger,
    queue = new KeyedSerialQueue(),
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    retryBaseMs = DEFAULT_RETRY_BASE_MS,
    leaseMs = DEFAULT_LEASE_MS,
    concurrency = 8,
    emojiConcurrency = 2,
    enrichBilibili = enrichBilibiliMessageSegments,
    enrichDouyin = enrichDouyinMessageSegments,
    enrichYoutube = enrichYoutubeMessageSegments,
    enrichPixiv = enrichPixivMessageSegments,
    resolveForwardContext = null,
    stats = null
  }: PipelineOptions) {
    this.store = store
    this.recentManager = recentManager
    this.archiveManager = archiveManager
    this.mediaOutbox = mediaOutbox
    this.emojiCollector = emojiCollector
    this.stats = stats
    this.logger = logger
    this.queue = queue
    this.semaphore = new AsyncSemaphore(concurrency)
    this.emojiSemaphore = new AsyncSemaphore(emojiConcurrency)
    this.maxAttempts = Math.max(1, Number(maxAttempts) || DEFAULT_MAX_ATTEMPTS)
    this.retryBaseMs = Math.max(100, Number(retryBaseMs) || DEFAULT_RETRY_BASE_MS)
    this.leaseMs = Math.max(10000, Number(leaseMs) || DEFAULT_LEASE_MS)
    this.enrichBilibili = enrichBilibili
    this.enrichDouyin = enrichDouyin
    this.enrichYoutube = enrichYoutube
    this.enrichPixiv = enrichPixiv
    this.resolveForwardContext = typeof resolveForwardContext === "function" ? resolveForwardContext : null
    this.runId = randomUUID()
    this.timers = new Map()
    this.stopped = false
  }

  createJob(envelope: EventEnvelope): EventJob {
    const now = Date.now()
    return {
      version: 1,
      id: envelope.eventId,
      envelope,
      state: "pending",
      attempts: 0,
      consumers: initialConsumers(envelope),
      createdAt: now,
      updatedAt: now,
      nextRetryAt: 0,
      leaseUntil: 0,
      ownerRunId: "",
      lastError: ""
    }
  }

  handleRawEvent(e: unknown, postType: string) {
    if (this.stopped) return ""
    let envelope
    try {
      envelope = createEventEnvelope(e, postType)
    } catch (error) {
      this.logger?.warn?.(`[MessagePipeline] 事件快照失败: ${cleanError(error)}`)
      return ""
    }
    this.capture(envelope).catch(error => {
      this.logger?.warn?.(`[MessagePipeline] 捕获持久化失败 event=${envelope.eventId}: ${cleanError(error)}`)
    })
    // 多账号联邦:心跳登记 + 统计只在责任侧计(兄弟消息/旁观者不计,防止双 bot 同群计数翻倍)
    markBotOnline(envelope.botId)
    if (this.stats) {
      this.federationAllows(envelope)
        .then(allows => {
          if (!allows) return
          try {
            this.stats?.recordReceive(envelope)
          } catch {
            // 统计 fail-open,绝不影响事件捕获
          }
        })
        .catch(() => {
          try {
            this.stats?.recordReceive(envelope)
          } catch {}
        })
    }
    return envelope.eventId
  }

  // 联邦判定:@ 优先,否则(群号+在线bot列表)稳定哈希选主;私聊与单 bot 恒通过。
  // 兄弟 bot 的消息(自家其他账号发的)一律不算普通群友事件。
  async federationAllows(envelope: EventEnvelope) {
    try {
      const me = String(envelope.botId || "")
      const who = String(envelope.userId || "")
      if (me && who && who !== me && (await isFederationSibling(me, who))) return false
      if (!envelope.groupId) return true
      const bots = await onlineBotList()
      const atBotQqs = this.extractOwnAtBots(envelope, bots)
      return await isResponsibleBot({
        groupId: String(envelope.groupId),
        selfId: me,
        atBotQqs,
        knownBots: bots
      })
    } catch {
      return true
    }
  }

  extractOwnAtBots(envelope: EventEnvelope, bots: string[] = []) {
    const out = new Set<string>()
    for (const segment of Array.isArray(envelope.message) ? envelope.message : []) {
      if (segment?.type !== "at") continue
      const qq = String(segment?.qq ?? segment?.data?.qq ?? "").trim()
      if (qq && bots.includes(qq)) out.add(qq)
    }
    return [...out]
  }

  async capture(envelope: EventEnvelope) {
    const created = await this.store.create("event", envelope.eventId, this.createJob(envelope))
    const job = created ? await this.store.get<EventJob>("event", envelope.eventId, isEventJob) : await this.store.get<EventJob>("event", envelope.eventId, isEventJob)
    if (!job) throw new Error("事件写入后无法读取")
    if (created) {
      this.logger?.info?.(`[MessagePipeline] 已捕获 event=${envelope.eventId} group=${envelope.groupId || "private"}`)
    }
    if (!["completed", "failed"].includes(job.state)) this.schedule(job.id, envelope.conversationId)
    return { created, job }
  }

  schedule(id: string, conversationId: string, delayMs = 0) {
    if (this.stopped || !id) return
    const existing = this.timers.get(id)
    if (existing) clearTimeout(existing)
    const run = () => {
      if(this.stopped)return
      this.timers.delete(id)
      this.queue.run(conversationId, () => this.semaphore.run(() => this.process(id))).catch(error => {
        this.logger?.warn?.(`[MessagePipeline] 后台事件异常 id=${id}: ${cleanError(error)}`)
      })
    }
    if (delayMs > 0) {
      const timer = setTimeout(run, delayMs)
      timer.unref?.()
      this.timers.set(id, timer)
    } else {
      setImmediate(run)
    }
  }

  async enrichMessage(envelope: EventEnvelope) {
    let message = envelope.message
    try {
      message = await this.enrichBilibili(message, envelope.rawMessage)
    } catch (error) {
      this.logger?.warn?.(`[MessagePipeline] B站富化失败，保留原消息 event=${envelope.eventId}: ${cleanError(error)}`)
    }
    try {
      message = await this.enrichDouyin(message, envelope.rawMessage)
    } catch (error) {
      this.logger?.warn?.(`[MessagePipeline] 抖音富化失败，保留已有消息 event=${envelope.eventId}: ${cleanError(error)}`)
    }
    try {
      message = await this.enrichYoutube(message, envelope.rawMessage)
    } catch (error) {
      this.logger?.warn?.(`[MessagePipeline] YouTube 富化失败，保留已有消息 event=${envelope.eventId}: ${cleanError(error)}`)
    }
    try {
      message = await this.enrichPixiv(message, envelope.rawMessage)
    } catch (error) {
      this.logger?.warn?.(`[MessagePipeline] Pixiv 富化失败，保留已有消息 event=${envelope.eventId}: ${cleanError(error)}`)
    }
    const hasForwardSegment = Array.isArray(envelope.message) && envelope.message.some(segment => segment?.type === "forward")
    if (hasForwardSegment) {
      this.logger?.info?.(`[MessagePipeline] 合并转发上下文探测 event=${envelope.eventId} resolver=${Boolean(this.resolveForwardContext)} cached=${Boolean(envelope.forwardContext)}`)
    }
    if (this.resolveForwardContext && !envelope.forwardContext) {
      try {
        const forwardContext = await this.resolveForwardContext(envelope)
        if (forwardContext) {
          envelope.forwardContext = forwardContext
          delete envelope.forwardContextFailure
          message = appendForwardContextSegment(message, forwardContext)
          this.logger?.info?.(`[MessagePipeline] 合并转发展开 event=${envelope.eventId} state=${forwardContext.completeness?.state || 'unknown'} processed=${forwardContext.completeness?.processedNodes ?? 'unknown'} knownTotal=${forwardContext.completeness?.knownTotalNodes ?? 'unknown'} forwards=${forwardContext.forwardIds?.length || 0} media=${forwardContext.media?.length || 0}`)
        }
      } catch (error) {
        const completeness = error && typeof error === 'object' && 'completeness' in error ? parseForwardCompleteness(error.completeness) : undefined
        if (completeness) envelope.forwardContextFailure = completeness
        if (error && typeof error === "object" && "code" in error && error.code === "forward_context_unavailable") throw error
        this.logger?.warn?.(`[MessagePipeline] 合并转发展开失败 event=${envelope.eventId}: ${cleanError(error)}`)
      }
    } else if (envelope.forwardContext) {
      message = appendForwardContextSegment(message, envelope.forwardContext)
    }
    return Array.isArray(message) ? message : envelope.message
  }

  scheduleEmojiCollection(envelope: EventEnvelope) {
    const event = envelopeToRuntimeEvent(envelope)
    setImmediate(() => {
      this.emojiSemaphore.run(() => this.emojiCollector!.maybeAutoCollect(event)).catch(error => {
        this.logger?.warn?.(`[MessagePipeline] 表情包自动收集失败 event=${envelope.eventId}: ${cleanError(error)}`)
      })
    })
  }

  async processMessage(job: EventJob) {
    const envelope = job.envelope
    const errors = []

    // 联邦闸门:兄弟 bot 的消息不作为群友事件;非责任 bot 不做任何数据类消费
    if (!(await this.federationAllows(envelope))) {
      let changed = false
      for (const key of ["media", "emoji", "recent", "archive"]) {
        if (job.consumers[key] !== "done" && job.consumers[key] !== "skipped") {
          job.consumers[key] = "skipped"
          changed = true
        }
      }
      if (changed) await this.store.save("event", job.id, { ...job, updatedAt: Date.now() }).catch(() => {})
      return
    }

    if (job.consumers.media !== "done" && job.consumers.media !== "skipped") {
      try {
        const media = findRawMedia(envelope)
        if (media && envelope.groupId && !isEnvelopeFromBot(envelope)) {
          const delivery = await this.mediaOutbox.enqueue({ envelope, media })
          job.consumers.media = delivery ? "done" : "skipped"
        } else {
          job.consumers.media = "skipped"
        }
        await this.store.save("event", job.id, { ...job, updatedAt: Date.now() })
      } catch (error) {
        errors.push(new Error(`media: ${cleanError(error)}`))
      }
    }

    if (job.consumers.emoji !== "accepted" && job.consumers.emoji !== "skipped") {
      try {
        if (this.emojiCollector?.maybeAutoCollect && hasCollectibleImage(envelope) && !isEnvelopeFromBot(envelope)) {
          job.consumers.emoji = "accepted"
          await this.store.save("event", job.id, { ...job, updatedAt: Date.now() })
          this.scheduleEmojiCollection(envelope)
        } else {
          job.consumers.emoji = "skipped"
          await this.store.save("event", job.id, { ...job, updatedAt: Date.now() })
        }
      } catch (error) {
        this.logger?.warn?.(`[MessagePipeline] 表情包收集调度失败 event=${envelope.eventId}: ${cleanError(error)}`)
        job.consumers.emoji = "skipped"
      }
    }

    const needsRecent = job.consumers.recent !== "done"
    const needsArchive = job.consumers.archive !== "done" && job.consumers.archive !== "skipped"
    if (!needsRecent && !needsArchive) {
      if (errors.length) throw new AggregateError(errors, errors.map(cleanError).join("; "))
      return
    }

    const enrichedMessage = await this.enrichMessage(envelope)
    const runtimeEvent = envelopeToRuntimeEvent(envelope, enrichedMessage)

    if (needsRecent) {
      try {
        await this.recentManager.recordMessage(runtimeEvent, {
          preEnrichedMessage: enrichedMessage,
          throwOnError: true
        })
        job.consumers.recent = "done"
        await this.store.save("event", job.id, { ...job, updatedAt: Date.now() })
      } catch (error) {
        errors.push(new Error(`recent: ${cleanError(error)}`))
      }
    }

    if (needsArchive) {
      try {
        if (this.archiveManager.shouldRecord(runtimeEvent)) {
          await this.archiveManager.recordMessage(runtimeEvent, {
            preEnrichedMessage: enrichedMessage,
            throwOnError: true
          })
          job.consumers.archive = "done"
        } else {
          job.consumers.archive = "skipped"
        }
        await this.store.save("event", job.id, { ...job, updatedAt: Date.now() })
      } catch (error) {
        errors.push(new Error(`archive: ${cleanError(error)}`))
      }
    }

    if (errors.length) throw new AggregateError(errors, errors.map(cleanError).join("; "))
  }

  async processNotice(job: EventJob) {
    if (job.consumers.archive === "done" || job.consumers.archive === "skipped") return
    const event = envelopeToRuntimeEvent(job.envelope)
    if (!this.archiveManager.shouldRecordNotice(event)) {
      job.consumers.archive = "skipped"
      return
    }
    await this.archiveManager.recordNotice(event, { throwOnError: true })
    job.consumers.archive = "done"
  }

  async process(id: string) {
    const token = await this.store.acquireLock("event", id, this.leaseMs)
    if (!token) {
      const current = await this.store.get<EventJob>("event", id, isEventJob)
      if (current && !["completed", "failed"].includes(current.state)) {
        const delay = current.state === "processing"
          ? Math.max(250, Number(current.leaseUntil || 0) - Date.now() + 100)
          : 500
        this.schedule(current.id, current.envelope?.conversationId, delay)
      }
      return false
    }
    const heartbeat = startLeaseHeartbeat({store:this.store,kind:"event",id,token,leaseMs:this.leaseMs,...(this.logger ? {logger:this.logger}:{})})
    let job = await this.store.get<EventJob>("event", id, isEventJob)
    try {
      if (!job || ["completed", "failed"].includes(job.state)) return false
      if (job.state === "retry_wait" && Number(job.nextRetryAt || 0) > Date.now()) {
        this.schedule(job.id, job.envelope?.conversationId, job.nextRetryAt - Date.now())
        return false
      }
      const now = Date.now()
      job = {
        ...job,
        state: "processing",
        attempts: Number(job.attempts || 0) + 1,
        updatedAt: now,
        leaseUntil: now + this.leaseMs,
        ownerRunId: this.runId,
        lastError: ""
      }
      await this.store.save("event", id, job)

      if (job.envelope.postType === "notice") await this.processNotice(job)
      else await this.processMessage(job)

      await heartbeat.assertOwned()
      job = {
        ...job,
        state: "completed",
        updatedAt: Date.now(),
        leaseUntil: 0,
        ownerRunId: "",
        nextRetryAt: 0,
        lastError: ""
      }
      await this.store.save("event", id, job)
      return true
    } catch (error) {
      if (error instanceof LeaseLostError || !await heartbeat.renew()) return false
      if (!job) return false
      const canRetry = Number(job.attempts || 0) < this.maxAttempts
      const delay = this.retryBaseMs * Math.pow(3, Math.max(0, Number(job.attempts || 1) - 1))
      job = {
        ...job,
        state: canRetry ? "retry_wait" : "failed",
        updatedAt: Date.now(),
        leaseUntil: 0,
        ownerRunId: "",
        nextRetryAt: canRetry ? Date.now() + delay : 0,
        lastError: cleanError(error)
      }
      await this.store.save("event", id, job)
      this.logger?.warn?.(`[MessagePipeline] ${canRetry ? "等待重试" : "最终失败"} event=${id} attempt=${job.attempts}: ${job.lastError}`)
      if (canRetry) this.schedule(job.id, job.envelope?.conversationId, delay)
      return false
    } finally {
      heartbeat.stop()
      await this.store.releaseLock("event", id, token).catch(error => {
        this.logger?.warn?.(`[MessagePipeline] 释放事件锁失败 id=${id}: ${cleanError(error)}`)
      })
    }
  }

  async recover() {
    const jobs = await this.store.list<EventJob>("event", isEventJob)
    let count = 0
    for (const job of jobs) {
      if (!job?.id || ["completed", "failed"].includes(job.state)) continue
      const now = Date.now()
      const delay = job.state === "retry_wait"
        ? Math.max(0, Number(job.nextRetryAt || 0) - now)
        : job.state === "processing"
          ? Math.max(0, Number(job.leaseUntil || 0) - now + 100)
          : 0
      this.schedule(job.id, job.envelope?.conversationId, delay)
      count++
    }
    if (count) this.logger?.info?.(`[MessagePipeline] 恢复 ${count} 个未完成事件`)
    return count
  }

  start(botEmitter: PipelineEmitter) {
    if (!botEmitter?.on) throw new Error("Bot EventEmitter 不可用")
    if(this.botEmitter===botEmitter&&!this.stopped)return this
    if(this.botEmitter)this.stop()
    this.stopped=false
    this.botEmitter = botEmitter
    this.messageListener = event => this.handleRawEvent(event, "message")
    this.noticeListener = event => this.handleRawEvent(event, "notice")
    botEmitter.on("message", this.messageListener)
    botEmitter.on("notice", this.noticeListener)
    setImmediate(() => {
      Promise.all([this.recover(), this.mediaOutbox.recover()]).catch(error => {
        this.logger?.warn?.(`[MessagePipeline] 启动恢复失败: ${cleanError(error)}`)
      })
    })
    return this
  }

  stop() {
    this.stopped = true
    if (this.botEmitter?.off) {
      if (this.messageListener) this.botEmitter.off("message", this.messageListener)
      if (this.noticeListener) this.botEmitter.off("notice", this.noticeListener)
    }
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.mediaOutbox.stop()
  }
}

return MessagePipeline
}
