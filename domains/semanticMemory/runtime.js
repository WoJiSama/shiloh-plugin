// 语义记忆运行时单例:组装 store/gateway/indexer/retriever,注册归档写入钩子。
// 由 apps/test.js 配置装载处创建;命令 app 与主流程共用同一实例(ESM 单例)。
import path from "node:path"
import { SemanticMemoryStore } from "./SemanticMemoryStore.js"
import { EmbeddingGateway } from "./EmbeddingGateway.js"
import { RerankGateway, rerankUrlFromEmbeddingUrl } from "./RerankGateway.js"
import { SemanticMemoryIndexer } from "./SemanticMemoryIndexer.js"
import { SemanticMemoryRetriever } from "./SemanticMemoryRetriever.js"

export const DEFAULT_SEMANTIC_MEMORY_CONFIG = {
  enabled: false,
  // 语义记忆保留期独立于归档:索引是压缩后的精华(分块远少于原消息),
  // 延长记忆跨度比延长归档便宜得多,默认 30 天
  retentionDays: 30,
  includeGroups: [],
  excludeGroups: [],
  windowSize: 8,
  stride: 4,
  topK: 5,
  minScore: 0.35,
  contextMaxChars: 900,
  retrieveTimeoutMs: 900,
  indexOnWrite: true,
  embeddingDimensions: 1024,
  // 重排:SiliconFlow 免费 bge-reranker-v2-m3;默认评估/调试启用,聊天热路径默认关闭(保延迟)
  rerankEnabled: true,
  rerankInChat: false,
  rerankModel: "BAAI/bge-reranker-v2-m3",
  rerankTopN: 20,
  rerankTimeoutMs: 1500
}

let runtime = null
let archiveHookInstalled = false
let sweepTimer = null
let sweepInterval = null

const SWEEP_INITIAL_DELAY_MS = 60000
const SWEEP_INTERVAL_MS = 24 * 3600 * 1000

function scheduleSweep(store, logger) {
  if (sweepTimer) clearTimeout(sweepTimer)
  if (sweepInterval) clearInterval(sweepInterval)
  const runSweep = () => {
    store.sweepAll().then(summary => {
      if (summary.compactedGroups > 0 || summary.droppedChunks > 0) {
        logger?.info?.(`[SemanticMemory] 每日清扫:${summary.compactedGroups} 群压实,清理过期分块 ${summary.droppedChunks} 个`)
      }
    }).catch(error => logger?.warn?.(`[SemanticMemory] 清扫失败: ${error.message}`))
  }
  sweepTimer = setTimeout(runSweep, SWEEP_INITIAL_DELAY_MS)
  sweepTimer.unref?.()
  sweepInterval = setInterval(runSweep, SWEEP_INTERVAL_MS)
  sweepInterval.unref?.()
}

export function normalizeSemanticMemoryConfig(raw = {}, embeddingAiConfig = {}) {
  const config = {
    ...DEFAULT_SEMANTIC_MEMORY_CONFIG,
    ...raw,
    includeGroups: Array.isArray(raw.includeGroups) ? raw.includeGroups.map(String) : [],
    excludeGroups: Array.isArray(raw.excludeGroups) ? raw.excludeGroups.map(String) : []
  }
  config.windowSize = Math.max(2, Number(config.windowSize) || 8)
  config.stride = Math.max(1, Number(config.stride) || 4)
  config.topK = Math.max(1, Number(config.topK) || 5)
  config.minScore = Math.min(0.95, Math.max(0.05, Number(config.minScore) || 0.35))
  config.retentionDays = Math.max(1, Number(config.retentionDays) || 30)
  config.embeddingDimensions = Number(config.embeddingDimensions) || 1024
  config.rerankEnabled = config.rerankEnabled !== false
  config.rerankInChat = config.rerankInChat === true
  config.rerankModel = String(config.rerankModel || "BAAI/bge-reranker-v2-m3")
  config.rerankTopN = Math.max(5, Number(config.rerankTopN) || 20)
  config.rerankTimeoutMs = Math.max(300, Number(config.rerankTimeoutMs) || 1500)
  return config
}

export function getSemanticMemoryRuntime() {
  return runtime
}

export function installSemanticMemoryRuntime({ pluginSettings = {}, archiveManager = null, logger = globalThis.logger } = {}) {
  const config = normalizeSemanticMemoryConfig(pluginSettings.semanticMemory, pluginSettings.embeddingAiConfig)
  const embedding = pluginSettings.embeddingAiConfig || {}
  const usable = Boolean(
    config.enabled &&
    archiveManager &&
    embedding.embeddingApiUrl &&
    embedding.embeddingApiKey &&
    !String(embedding.embeddingApiKey).includes("sk-xxx") &&
    embedding.embeddingApiModel
  )
  if (!usable) {
    if (runtime) detachArchiveHook()
    if (sweepTimer) clearTimeout(sweepTimer)
    if (sweepInterval) clearInterval(sweepInterval)
    runtime = null
    return null
  }

  const baseDir = path.join(path.dirname(archiveManager.getBaseDir()), "semantic_memory")
  const store = new SemanticMemoryStore({
    baseDir,
    dimension: config.embeddingDimensions,
    retentionDays: config.retentionDays,
    logger
  })
  const gateway = new EmbeddingGateway({
    apiUrl: embedding.embeddingApiUrl,
    apiKey: embedding.embeddingApiKey,
    model: embedding.embeddingApiModel,
    logger
  })
  const reranker = config.rerankEnabled
    ? new RerankGateway({
      apiUrl: rerankUrlFromEmbeddingUrl(embedding.embeddingApiUrl),
      apiKey: embedding.embeddingApiKey,
      model: config.rerankModel,
      timeoutMs: config.rerankTimeoutMs,
      logger
    })
    : null
  const indexer = new SemanticMemoryIndexer({ store, gateway, archiveManager, config, logger })
  const retriever = new SemanticMemoryRetriever({ store, gateway, reranker, config, logger })
  runtime = { config, store, gateway, reranker, indexer, retriever, baseDir }
  // 评估出题模型:复用 memoryAiConfig(glm flash 一类便宜小模型)
  const memory = pluginSettings.memoryAiConfig || {}
  if (memory.memoryAiUrl && memory.memoryAiApikey) {
    runtime.questionModel = {
      url: `${String(memory.memoryAiUrl).replace(/\/+$/, "")}/chat/completions`,
      model: memory.memoryAiModel || "glm-5.3-flash",
      key: memory.memoryAiApikey,
      timeoutMs: 20000
    }
  }
  installArchiveHook(archiveManager, logger)
  scheduleSweep(store, logger)
  logger?.info?.(`[SemanticMemory] 语义记忆就绪 model=${gateway.model} dim=${store.dimension} retention=${config.retentionDays}d base=${baseDir}`)
  return runtime
}

function installArchiveHook(archiveManager, logger) {
  if (archiveHookInstalled) return
  archiveHookInstalled = true
  const original = archiveManager.recordMessage.bind(archiveManager)
  archiveManager.recordMessage = async (event, options) => {
    const record = await original(event, options)
    if (record) {
      try {
        runtime?.indexer?.onArchivedRecord(record)
      } catch {}
    }
    return record
  }
}

function detachArchiveHook() {
  archiveHookInstalled = false
}

// 供测试重置
export function __resetSemanticMemoryRuntimeForTest() {
  runtime = null
  archiveHookInstalled = false
  if (sweepTimer) clearTimeout(sweepTimer)
  if (sweepInterval) clearInterval(sweepInterval)
  sweepTimer = null
  sweepInterval = null
}
