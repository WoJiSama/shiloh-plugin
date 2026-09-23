// 提示词层 TTL 缓存:情绪/表达学习/全局风格/人设反馈/对方画像这些"慢变化层"
// 按 (层名+群+用户) 维度缓存,避免每条消息重复读文件与画像。
// 记忆、群知识、知识库、语义风格随消息文本变化,不走此缓存。
// 各层 TTL 刻意取得很短:这些层本来就允许降级为空,宁可轻微陈旧也不引入复杂失效逻辑;
// 写入侧(学到新反馈/新风格)最多延迟一个 TTL 生效。
const store = new Map()
const MAX_ENTRIES = 512

export const LAYER_CACHE_TTL_MS = {
  emotion: 60_000,
  expression: 300_000,
  globalStyle: 60_000,
  personaFeedback: 45_000,
  personProfile: 90_000
}

export function isPromptLayerCacheEnabled(config = {}) {
  return config?.promptLayerCache?.enabled !== false
}

function evictOldest() {
  let oldestKey = null
  let oldestAt = Infinity
  for (const [key, entry] of store) {
    if (entry.at < oldestAt) {
      oldestAt = entry.at
      oldestKey = key
    }
  }
  if (oldestKey) store.delete(oldestKey)
}

export async function cachedPromptLayer(key, ttlMs, loader) {
  const now = Date.now()
  const hit = store.get(key)
  if (hit && now - hit.at < ttlMs) return hit.value
  const value = await loader()
  if (store.size >= MAX_ENTRIES) evictOldest()
  store.set(key, { value, at: now })
  return value
}

export function clearPromptLayerCache() {
  store.clear()
}

export function promptLayerCacheStats() {
  return { entries: store.size, maxEntries: MAX_ENTRIES }
}
