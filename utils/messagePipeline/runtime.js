import { MessageManager } from "../MessageManager.js"
import { messageArchiveManager } from "../MessageArchiveManager.js"
import { DeliveryGateway } from "./deliveryGateway.js"
import { MediaOutbox } from "./mediaOutbox.js"
import { MediaArtifactStore } from "./mediaArtifactStore.js"
import { MessagePipeline } from "./messagePipeline.js"
import { getMissingRedisJobCapabilities, RedisJobStore } from "./redisJobStore.js"
import { BilibiliAuthManager } from "../BilibiliAuthManager.js"
import { collectForwardContext, extractForwardIdsFromSegments } from "../groupContextResolver.js"

const RUNTIME_KEY = Symbol.for("bl-chat-plugin.message-pipeline.runtime")

export const DEFAULT_MESSAGE_PIPELINE_CONFIG = Object.freeze({
  enabled: true,
  mediaAutoRelay: true,
  eventTtlMinutes: 360,
  deliveryTtlHours: 24,
  eventMaxAttempts: 5,
  deliveryMaxAttempts: 4,
  retryBaseSeconds: 5,
  eventLeaseSeconds: 300,
  deliveryLeaseSeconds: 900,
  eventConcurrency: 8,
  deliveryConcurrency: 4,
  mediaPrepareConcurrency: 2,
  mediaArtifactTtlSeconds: 120,
  mediaArtifactMaxEntries: 8,
  mediaArtifactMaxIdleMb: 512,
  mediaArtifactMaxEncodedMb: 64,
  mediaSharedHostDir: "",
  mediaSharedContainerDir: ""
})

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function nonnegativeNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

async function resolvePipelineForwardContext(envelope = {}, bot = globalThis.Bot) {
  const forwardIds = extractForwardIdsFromSegments(envelope.message)
  if (!forwardIds.length || !envelope.groupId) return null
  try {
    const root = globalThis.Bot || bot
    const group = root?.pickGroup?.(Number(envelope.groupId)) || root?.pickGroup?.(String(envelope.groupId))
    if (!group?.getForwardMsg) throw new Error("OneBot group context is not ready")
    const context = await collectForwardContext(group, envelope.message, {
      maxDepth: 3,
      maxLines: 80,
      maxImages: 12,
      maxText: 6000
    })
    // NapCat reconnecting can return an empty list before the OneBot action channel is ready.
    // A forward record with no readable nodes is not useful context, so retry instead of
    // permanently recording it as an empty forward.
    if (!context.text && !(context.media || []).length) throw new Error("OneBot returned no forward nodes")
    return {
      forwardIds,
      text: context.text,
      media: (context.media || []).map(asset => ({
        type: asset.type,
        label: asset.label,
        fileName: asset.fileName || "",
        source: asset.source || ""
      })),
      forwardNodes: Array.isArray(context.forwardNodes) ? context.forwardNodes : []
    }
  } catch (cause) {
    const error = new Error(`OneBot forward context is not ready: ${cause?.message || cause}`)
    error.code = "forward_context_unavailable"
    throw error
  }
}

export function normalizeMessagePipelineConfig(value = {}) {
  const cfg = { ...DEFAULT_MESSAGE_PIPELINE_CONFIG, ...(value || {}) }
  return {
    ...cfg,
    enabled: cfg.enabled !== false,
    mediaAutoRelay: cfg.mediaAutoRelay !== false,
    eventTtlMinutes: positiveNumber(cfg.eventTtlMinutes, DEFAULT_MESSAGE_PIPELINE_CONFIG.eventTtlMinutes),
    deliveryTtlHours: positiveNumber(cfg.deliveryTtlHours, DEFAULT_MESSAGE_PIPELINE_CONFIG.deliveryTtlHours),
    eventMaxAttempts: positiveNumber(cfg.eventMaxAttempts, DEFAULT_MESSAGE_PIPELINE_CONFIG.eventMaxAttempts),
    deliveryMaxAttempts: positiveNumber(cfg.deliveryMaxAttempts, DEFAULT_MESSAGE_PIPELINE_CONFIG.deliveryMaxAttempts),
    retryBaseSeconds: positiveNumber(cfg.retryBaseSeconds, DEFAULT_MESSAGE_PIPELINE_CONFIG.retryBaseSeconds),
    eventLeaseSeconds: positiveNumber(cfg.eventLeaseSeconds, DEFAULT_MESSAGE_PIPELINE_CONFIG.eventLeaseSeconds),
    deliveryLeaseSeconds: positiveNumber(cfg.deliveryLeaseSeconds, DEFAULT_MESSAGE_PIPELINE_CONFIG.deliveryLeaseSeconds),
    eventConcurrency: positiveNumber(cfg.eventConcurrency, DEFAULT_MESSAGE_PIPELINE_CONFIG.eventConcurrency),
    deliveryConcurrency: positiveNumber(cfg.deliveryConcurrency, DEFAULT_MESSAGE_PIPELINE_CONFIG.deliveryConcurrency),
    mediaPrepareConcurrency: positiveNumber(cfg.mediaPrepareConcurrency, DEFAULT_MESSAGE_PIPELINE_CONFIG.mediaPrepareConcurrency),
    mediaArtifactTtlSeconds: positiveNumber(cfg.mediaArtifactTtlSeconds, DEFAULT_MESSAGE_PIPELINE_CONFIG.mediaArtifactTtlSeconds),
    mediaArtifactMaxEntries: positiveNumber(cfg.mediaArtifactMaxEntries, DEFAULT_MESSAGE_PIPELINE_CONFIG.mediaArtifactMaxEntries),
    mediaArtifactMaxIdleMb: positiveNumber(cfg.mediaArtifactMaxIdleMb, DEFAULT_MESSAGE_PIPELINE_CONFIG.mediaArtifactMaxIdleMb),
    mediaArtifactMaxEncodedMb: nonnegativeNumber(cfg.mediaArtifactMaxEncodedMb, DEFAULT_MESSAGE_PIPELINE_CONFIG.mediaArtifactMaxEncodedMb),
    mediaSharedHostDir: String(cfg.mediaSharedHostDir || "").trim(),
    mediaSharedContainerDir: String(cfg.mediaSharedContainerDir || "").trim()
  }
}

export function createMessagePipelineRuntime({
  bot = globalThis.Bot,
  redis = globalThis.redis,
  logger = globalThis.logger,
  pluginSettings = {},
  recentManager,
  archiveManager = messageArchiveManager,
  emojiCollector = null,
  gateway,
  store
} = {}) {
  const config = normalizeMessagePipelineConfig(pluginSettings.messagePipeline)
  if (!store) {
    const missing = getMissingRedisJobCapabilities(redis)
    if (missing.length) throw new Error(`Redis 缺少可靠消息管道能力: ${missing.join(", ")}`)
  }
  const jobStore = store || new RedisJobStore({
    redis,
    logger,
    eventTtlSeconds: config.eventTtlMinutes * 60,
    deliveryTtlSeconds: config.deliveryTtlHours * 60 * 60
  })
  const deliveryGateway = gateway || new DeliveryGateway({ botRoot: () => globalThis.Bot || bot, logger })
  const artifactStore = new MediaArtifactStore({
    ttlMs: config.mediaArtifactTtlSeconds * 1000,
    maxEntries: config.mediaArtifactMaxEntries,
    maxIdleBytes: config.mediaArtifactMaxIdleMb * 1024 * 1024,
    maxEncodedBytes: config.mediaArtifactMaxEncodedMb * 1024 * 1024,
    logger
  })
  const mediaOutbox = new MediaOutbox({
    store: jobStore,
    gateway: deliveryGateway,
    logger,
    enabled: config.mediaAutoRelay,
    maxAttempts: config.deliveryMaxAttempts,
    retryBaseMs: config.retryBaseSeconds * 1000,
    leaseMs: config.deliveryLeaseSeconds * 1000,
    concurrency: config.deliveryConcurrency,
    prepareConcurrency: config.mediaPrepareConcurrency,
    autoBilibiliMemberAuth: pluginSettings.bilibiliQualityRelay?.autoUseAuthorizedForMemberOnly !== false,
    getBilibiliAuthCookie: () => new BilibiliAuthManager().cookie(),
    artifactStore,
    youtubeRelay: pluginSettings.youtubeRelay || {},
    pixivRelay: pluginSettings.pixivRelay || {},
    sharedMedia: config.mediaSharedHostDir && config.mediaSharedContainerDir
      ? { hostDir: config.mediaSharedHostDir, containerDir: config.mediaSharedContainerDir }
      : null
  })
  const recent = recentManager || new MessageManager({
    groupMaxMessages: pluginSettings.groupMaxMessages,
    messageMaxLength: pluginSettings.messageMaxLength,
    cacheExpireMinutes: pluginSettings.groupChatMemoryMinutes,
    cacheExpireDays: pluginSettings.groupChatMemoryDays
  })
  const pipeline = new MessagePipeline({
    store: jobStore,
    recentManager: recent,
    archiveManager,
    mediaOutbox,
    emojiCollector,
    logger,
    maxAttempts: config.eventMaxAttempts,
    retryBaseMs: config.retryBaseSeconds * 1000,
    leaseMs: config.eventLeaseSeconds * 1000,
    concurrency: config.eventConcurrency,
    resolveForwardContext: envelope => resolvePipelineForwardContext(envelope, bot)
  })
  return { config, pipeline, mediaOutbox, store: jobStore, gateway: deliveryGateway, artifactStore }
}

export function installMessagePipeline({
  bot = globalThis.Bot,
  redis = globalThis.redis,
  logger = globalThis.logger,
  pluginSettings = {},
  emojiCollector = null
} = {}) {
  const previous = globalThis[RUNTIME_KEY]
  previous?.pipeline?.stop?.()

  const config = normalizeMessagePipelineConfig(pluginSettings.messagePipeline)
  if (!config.enabled) {
    const runtime = { config, pipeline: null, mediaOutbox: null, store: null, gateway: null }
    logger?.warn?.("[MessagePipeline] 已在配置中关闭，消息归档和媒体自动搬运不会运行")
    globalThis[RUNTIME_KEY] = runtime
    return runtime
  }
  let runtime
  try {
    runtime = createMessagePipelineRuntime({ bot, redis, logger, pluginSettings, emojiCollector })
    runtime.pipeline.start(bot)
  } catch (error) {
    runtime?.pipeline?.stop?.()
    runtime = {
      config,
      pipeline: null,
      mediaOutbox: null,
      store: null,
      gateway: null,
      unavailableReason: error.message
    }
    globalThis[RUNTIME_KEY] = runtime
    logger?.error?.(`[MessagePipeline] 启动失败，其他插件继续运行：${error.message}`)
    return runtime
  }
  globalThis[RUNTIME_KEY] = runtime
  logger?.info?.("[MessagePipeline] 原始事件捕获、持久任务和媒体 outbox 已启动")
  return runtime
}

export function getInstalledMessagePipeline() {
  return globalThis[RUNTIME_KEY] || null
}
