// 安全防呆四件套（纯函数，借鉴 qq-bridge v0.2.1-r2 安全批次）

/** ── A1 定时器溢出限幅 ──
 * Node 的 setTimeout 延迟超过 2^31-1 时静默改写为 1ms → 忙循环。
 * 所有从配置/Redis 状态来的延迟值必须过这个函数。 */
export const TIMER_MAX_MS = 86_400_000 // 24h 上限
export const TIMER_MIN_MS = 0

export function boundedTimerDelay(ms: unknown, max = TIMER_MAX_MS, min = TIMER_MIN_MS): number {
  const n = Number(ms)
  if (Number.isNaN(n)) return min > 0 ? min : 1000 // NaN 兜底
  if (!Number.isFinite(n)) return n > 0 ? max : min // ±Infinity 分别取上/下限
  return Math.min(max, Math.max(min, Math.floor(n)))
}

/** 安全 setTimeout：延迟先 clamp 再调（调用点不需要每次手写 clamp） */
export function safeSetTimeout(callback: () => void, ms: unknown, max = TIMER_MAX_MS): ReturnType<typeof setTimeout> {
  return setTimeout(callback, boundedTimerDelay(ms, max))
}

// ── A2 messageId 幂等 ──
const messageIdCache = new Map<string, true>() // LRU
const MESSAGE_ID_CACHE_MAX = 500

/** 消息是否已处理过（true=重复，应跳过） */
export function isDuplicateMessageId(messageId: unknown): boolean {
  const id = String(messageId ?? '')
  if (!id || id === 'null') return false // 无 id 的消息不去重（无法判重）
  if (messageIdCache.has(id)) return true
  messageIdCache.set(id, true)
  if (messageIdCache.size > MESSAGE_ID_CACHE_MAX) {
    const oldest = messageIdCache.keys().next().value
    if (oldest !== undefined) messageIdCache.delete(oldest)
  }
  return false
}

// ── A4 不可信文本结构净化 ──
/**
 * 群友消息入提示词前剥掉【…】段落标记——防止伪造系统段落。
 * 我们的提示词用全角【】做段落前缀（【待跟进】【群友好感】等），
 * 群友发的消息如果也用【】开头，模型可能误认为是系统指令。
 * 修法：群友可控文本里的全角【】替换为全角⟨⟩（视觉相近但不是我们的段落标记）。
 */
export function sanitizeUntrustedText(text: string): string {
  return String(text || '')
    .replace(/【/g, '⟨')
    .replace(/】/g, '⟩')
}

/** 测试用：清空 messageId 缓存 */
export function resetMessageIdCacheForTest(): void {
  messageIdCache.clear()
}
