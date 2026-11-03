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

// ── A2 错误外发收紧 ──
/**
 * 仿真模式的工具错误给模型的文本不应透传上游 error.message——
 * 可能含内部 URL、凭据、provider 信息（qq-bridge 实测案例：503 {"gateway_hint":"..."}）。
 * 统一替换为固定文案，原文只进本地日志。
 */
export function safeToolErrorText(toolName: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  // 已脱敏的错误（buildVisibleFailureDetail 产物格式："error: 503 上游服务异常" 等）直接透传
  // 注意：不能只看开头数字——"401 Unauthorized: invalid api key..." 也是数字开头但是原始上游错误
  if (/^(?:error: )?\d{3}\s+(?:上游服务|请求失败|Too Many|Not Found|Forbidden)/.test(message) || /^error: (?:请求超时|网络连接失败)/.test(message)) {
    return `error: ${message}`
  }
  // 原始上游错误 → 固定文案 + 类型提示（不给模型可利用的内部信息）
  const kind = /timeout|timed?.?out|超时/i.test(message) ? '超时'
    : /fetch|network|econn|enotfound|socket|连接/i.test(message) ? '网络'
    : /401|403|unauthorized|鉴权/i.test(message) ? '鉴权'
    : /429|rate.?limit|频率/i.test(message) ? '限频'
    : ''
  return `error: 工具 ${toolName} ${kind ? `因${kind}问题` : '执行'}失败，请换种方式或稍后再试`
}

/** 群友可见的错误回复节流（5 分钟）：同一群短时间内不反复发失败提示 */
const errorNoticeAt = new Map<string, number>()
export function shouldSendErrorNotice(scope: string, throttleMs = 300_000): boolean {
  const now = Date.now()
  const last = errorNoticeAt.get(scope) || 0
  if (now - last < throttleMs) return false
  errorNoticeAt.set(scope, now)
  return true
}

/** 测试用 */
export function resetErrorNoticeForTest(): void {
  errorNoticeAt.clear()
}
