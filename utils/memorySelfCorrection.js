// 记忆自纠错:群友在对话里指出"你记错了"时,系统自动降权她刚刚用到的那条记忆——
// 纠错发生在对话里,不靠主人手动查删。
// 语义:降权(penalize)而非直接删除——被纠错的记忆基准强度下调且不重置衰减时钟,
// 重复纠错会把它打到冻结线以下,由每日清扫自然淡忘;单次误伤只降权,不丢数据。
const DEFAULT_TTL_MS = 10 * 60 * 1000
const DEFAULT_PENALTY = 0.5

// 纠错话术(指向 bot 的"你记错了"类表达;命中任一即视为纠错信号)
export const DEFAULT_CORRECTION_PATTERNS = [
  /你记错/,
  /记错了吧/,
  /记岔/,
  /你搞错/,
  /不是这样的/,
  /不是吧,?根本没有/,
  /根本没有这(件|个)(事|说法)/,
  /没有这回事/,
  /哪有这(件|个)(事|说法)/,
  /你(是不是)?(记|想)岔/,
  /瞎(说|讲),?没(有|这事)/
]

// 每群最近一次注入的分块 id(她在"引用记忆说话",纠错落点就是这些)
const injectedByGroup = new Map() // groupId -> { ids: [], at }

export function noteInjectedChunks(groupId, items = [], now = Date.now()) {
  const key = String(groupId || "")
  const ids = (Array.isArray(items) ? items : []).map(item => item?.chunk?.id || "").filter(Boolean)
  if (!key || !ids.length) return
  injectedByGroup.set(key, { ids, at: now })
}

export function getInjectedChunks(groupId, { ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  const record = injectedByGroup.get(String(groupId || ""))
  if (!record) return null
  if (now - record.at > ttlMs) {
    injectedByGroup.delete(String(groupId || ""))
    return null
  }
  return record
}

export function isCorrectionText(text = "", patterns = DEFAULT_CORRECTION_PATTERNS) {
  const content = String(text || "")
  if (!content) return false
  return patterns.some(pattern => pattern.test(content))
}

/**
 * 纠错检测与执行。返回被降权的分块 id 数组(空数组=未触发),不抛错。
 * 触发条件(全部满足):
 * 1) 消息文本命中纠错话术;
 * 2) 与 bot 相关:引用了 bot 的消息,或发送者正是 bot 上一轮回复的人;
 * 3) 该群在 TTL 内有"注入过记忆"的记录。
 */
export function detectAndPenalize({
  text = "",
  groupId = "",
  quotesBot = false,
  senderUserId = "",
  lastBotReplyToUserId = "",
  runtime = null,
  patterns = DEFAULT_CORRECTION_PATTERNS,
  ttlMs = DEFAULT_TTL_MS,
  penalty = DEFAULT_PENALTY,
  now = Date.now(),
  logger = globalThis.logger
} = {}) {
  const store = runtime?.store
  if (!store || typeof store.penalizeChunks !== "function") return []
  const record = getInjectedChunks(groupId, { ttlMs, now })
  if (!record) return []
  if (!isCorrectionText(text, patterns)) return []
  const related = Boolean(quotesBot || String(senderUserId || "") && String(senderUserId) === String(lastBotReplyToUserId || ""))
  if (!related) return []
  try {
    const penalized = store.penalizeChunks(groupId, record.ids, { penalty })
    if (penalized > 0) {
      logger?.mark?.(`[记忆自纠错] group=${groupId} 群友指出记错,已降权 ${penalized} 条相关记忆(降 ${penalty},继续衰减将自然淡忘)`)
    }
    return record.ids.slice(0, penalized)
  } catch (error) {
    logger?.warn?.(`[记忆自纠错] 降权失败 group=${groupId}: ${error?.message || error}`)
    return []
  }
}

export function __resetMemorySelfCorrectionForTest() {
  injectedByGroup.clear()
}
