import type { RuntimeAssemblyPorts,RuntimeInput,RuntimeBundle } from '../../../contracts/pipelineRuntime.js'
function record(value: unknown): Record<string,unknown> { return value && typeof value==='object' && !Array.isArray(value) ? value as Record<string,unknown> : {} }
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

function positiveNumber(value: unknown, fallback: number) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function nonnegativeNumber(value: unknown, fallback: number) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? number : fallback
}

export function normalizeMessagePipelineConfig(value: unknown = {}) {
  const cfg: Record<string,unknown> = { ...DEFAULT_MESSAGE_PIPELINE_CONFIG, ...record(value) }
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

function disposeResource(value: unknown) {
 if (!value || typeof value !== 'object' || !('stop' in value) || typeof value.stop !== 'function') return
 try { Promise.resolve(value.stop()).catch(() => {}) } catch {}
}
export function createPipelineRuntime(ports: RuntimeAssemblyPorts) {
function createMessagePipelineRuntime({
  bot = ports.getBot(),
  redis = ports.getRedis(),
  logger = ports.getLogger(),
  pluginSettings = {},
  recentManager,
  archiveManager = ports.archiveManager,
  emojiCollector = null,
  gateway,
  store
}: RuntimeInput = {}): RuntimeBundle {
  const cleanup: (() => void)[] = []
  try {
  const config = normalizeMessagePipelineConfig(pluginSettings.messagePipeline)
  if (!store) {
    const missing = ports.getMissingRedisJobCapabilities(redis)
    if (missing.length) throw new Error(`Redis 缺少可靠消息管道能力: ${missing.join(", ")}`)
  }
  const jobStore = store || ports.createJobStore({
    redis,
    logger,
    eventTtlSeconds: config.eventTtlMinutes * 60,
    deliveryTtlSeconds: config.deliveryTtlHours * 60 * 60
  })
  const stats = ports.createStats({ redis, logger, settings: pluginSettings })
  cleanup.push(() => disposeResource(stats))
  const deliveryGateway = gateway || ports.createGateway({ botRoot: () => ports.getBot() || bot, logger, stats })
  const artifactStore = ports.createArtifactStore({
    ttlMs: config.mediaArtifactTtlSeconds * 1000,
    maxEntries: config.mediaArtifactMaxEntries,
    maxIdleBytes: config.mediaArtifactMaxIdleMb * 1024 * 1024,
    maxEncodedBytes: config.mediaArtifactMaxEncodedMb * 1024 * 1024,
    logger
  })
  cleanup.push(() => disposeResource(artifactStore))
  const mediaOutbox = ports.createOutbox({
    store: jobStore,
    gateway: deliveryGateway,
    logger,
    enabled: config.mediaAutoRelay,
    maxAttempts: config.deliveryMaxAttempts,
    retryBaseMs: config.retryBaseSeconds * 1000,
    leaseMs: config.deliveryLeaseSeconds * 1000,
    concurrency: config.deliveryConcurrency,
    prepareConcurrency: config.mediaPrepareConcurrency,
    autoBilibiliMemberAuth: record(pluginSettings.bilibiliQualityRelay).autoUseAuthorizedForMemberOnly !== false,
    getBilibiliAuthCookie: () => ports.getBilibiliAuthCookie(),
    artifactStore,
    youtubeRelay: pluginSettings.youtubeRelay || {},
    pixivRelay: pluginSettings.pixivRelay || {},
    xiaohongshuRelay: pluginSettings.xiaohongshuRelay || {},
    sharedMedia: config.mediaSharedHostDir && config.mediaSharedContainerDir
      ? { hostDir: config.mediaSharedHostDir, containerDir: config.mediaSharedContainerDir }
      : null
  })
  cleanup.push(() => disposeResource(mediaOutbox))
  const recent = recentManager || ports.createRecent({
    groupMaxMessages: pluginSettings.groupMaxMessages,
    messageMaxLength: pluginSettings.messageMaxLength,
    cacheExpireMinutes: pluginSettings.groupChatMemoryMinutes,
    cacheExpireDays: pluginSettings.groupChatMemoryDays
  })
  const pipeline = ports.createPipeline({
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
    resolveForwardContext: (envelope: unknown) => ports.resolveForwardContext(envelope, bot),
    stats
  })
  cleanup.push(() => disposeResource(pipeline))
  const adminReportStop = ports.startAdminReport({ store: jobStore, logger })
  cleanup.push(() => { try { Promise.resolve(adminReportStop()).catch(() => {}) } catch {} })
  let disposed = false
  const dispose = () => { if (disposed) return; disposed = true; for (const release of cleanup.reverse()) release() }
  return { config, pipeline, mediaOutbox, store: jobStore, gateway: deliveryGateway, artifactStore, stats, adminReportStop, dispose }
  } catch (error) { for (const release of cleanup.reverse()) release(); throw error }
}

function installMessagePipeline({
  bot = ports.getBot(),
  redis = ports.getRedis(),
  logger = ports.getLogger(),
  pluginSettings = {},
  emojiCollector = null
}: RuntimeInput = {}): RuntimeBundle {
  const previous = ports.getInstalled()
  if (previous?.dispose) previous.dispose()
  else { disposeResource(previous?.pipeline); previous?.adminReportStop?.() }

  // pixiv.net/pximg.net 国内不可达:所有 Pixiv 富化路径统一走 pixivRelay.proxyUrl 指定的代理。
  ports.setPixivFetchProxy(String(record(pluginSettings.pixivRelay).proxyUrl || "").trim())

  const config = normalizeMessagePipelineConfig(pluginSettings.messagePipeline)
  if (!config.enabled) {
    const runtime = { config, pipeline: null, mediaOutbox: null, store: null, gateway: null, stats: null }
    logger?.warn?.("[MessagePipeline] 已在配置中关闭，消息归档和媒体自动搬运不会运行")
    ports.setInstalled(runtime)
    return runtime
  }
  let runtime
  try {
    runtime = createMessagePipelineRuntime({ bot, redis, logger, pluginSettings, emojiCollector })
    runtime.pipeline?.start?.(bot)
  } catch (error) {
    runtime?.dispose?.()
    runtime = {
      config,
      pipeline: null,
      mediaOutbox: null,
      store: null,
      gateway: null,
      unavailableReason: (error instanceof Error ? error.message : String(error))
    }
    ports.setInstalled(runtime)
    logger?.error?.(`[MessagePipeline] 启动失败，其他插件继续运行：${(error instanceof Error ? error.message : String(error))}`)
    return runtime
  }
  ports.setInstalled(runtime)
  logger?.info?.("[MessagePipeline] 原始事件捕获、持久任务和媒体 outbox 已启动")
  return runtime
}

function getInstalledMessagePipeline() {
  return ports.getInstalled() || null
}

return { createMessagePipelineRuntime, installMessagePipeline, getInstalledMessagePipeline }
}
