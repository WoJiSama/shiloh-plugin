import type { SimMessage, SimWakeConfig, SimWakeReason, SimWakeReasonKind } from '../../../contracts/simulation.js'

/** 唤醒原因优先级：合并窗口内只升不降（值越大越优先）。 */
export const WAKE_PRIORITY: Record<SimWakeReasonKind, number> = {
  admin: 100,
  atMention: 90,
  question: 80,
  continuation: 78,
  speaker: 75,
  nameMention: 70,
  keyword: 60,
  anyMessage: 50,
  probability: 45,
  bootstrap: 40,
  replyCheck: 30,
  timeout: 25,
  proactiveCheck: 20,
}

/** 定时器类唤醒：与未读无关，回合结束补发时必须无条件补。 */
export const TIMER_WAKE_REASONS: readonly SimWakeReasonKind[] = ['timeout', 'replyCheck', 'proactiveCheck', 'bootstrap', 'admin']

/** 指向 AI 的疑问/催促判定（规则版，零 LLM）。 */
const QUESTION_HINT_RE = /[?？吗呢嘛么啊呀]\s*$|[?？]/
const CHALLENGE_RE = /(你会不会|你能不能|能不能|会不会|帮我看|帮我查|怎么看|怎么弄|怎么办|说说|讲讲|聊聊|评价|觉得|认为|推荐|建议|解释|是什么|啥意思|什么意思|几点了|多少)/
const AI_ADDRESS_RE = /(机器人|bot|ai|助手)/i

export function isQuestionDirectedAtAi(text: string, selfName: string): boolean {
  const value = String(text || '').trim()
  if (!value || value.length > 120) return false
  const nameHit = selfName && value.includes(selfName)
  if (!nameHit && !AI_ADDRESS_RE.test(value)) return false
  return QUESTION_HINT_RE.test(value) || CHALLENGE_RE.test(value)
}

function keywordPattern(keyword: string): RegExp | null {
  const value = String(keyword || '').trim()
  if (!value) return null
  // 纯字母数字且 ≤4 字符的关键词必须词边界匹配，防止 ADS 误触 DS 这类子串误命中。
  if (/^[A-Za-z0-9]{1,4}$/.test(value)) return new RegExp(`\\b${escapeRegExp(value)}\\b`, 'i')
  return new RegExp(escapeRegExp(value), 'i')
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface WakeTriggerContext {
  selfId: string
  selfName: string
  random(): number
  isPrivate?: boolean
  /** 会话延续状态（机器人最近参与过对话）：对话对象不点名的新消息也值得醒来看 */
  conversation?: { activeUntil: number; interlocutorIds: string[] }
}

/**
 * 触发判定（纯规则，优先级顺序）：
 * anyMessage > atMention（@ 或引用目标是自己）> nameMention > keyword > question > speaker > probability。
 * nameMention 只看纯文本——引用一条提到机器人昵称的旧消息不算点名。
 */
export function evaluateWakeTrigger(message: SimMessage, config: SimWakeConfig, ctx: WakeTriggerContext): SimWakeReason | null {
  if (ctx.isPrivate) return { kind: 'atMention', seq: message.seq }
  const t = config.triggers
  if (t.anyMessage) return { kind: 'anyMessage', seq: message.seq }
  if (t.atMention && (message.atSelf || message.quoteToSelf)) return { kind: 'atMention', seq: message.seq }
  if (t.nameMention && ctx.selfName && message.text && message.text.includes(ctx.selfName)) {
    return { kind: 'nameMention', seq: message.seq, detail: ctx.selfName }
  }
  if (message.text) {
    for (const keyword of t.keywords) {
      const pattern = keywordPattern(keyword)
      if (pattern && pattern.test(message.text)) return { kind: 'keyword', seq: message.seq, detail: keyword }
    }
  }
  if (t.question && isQuestionDirectedAtAi(message.text, ctx.selfName)) return { kind: 'question', seq: message.seq }
  // 会话延续：窗口内、说话的是刚才的对话对象、且没在 @ 别人（@ 别人 = 明显不是对机器人说）。
  // 醒来后由模型读上下文自行决定接不接（不想接可以安静 markRead），所以这里放宽是安全的。
  const conversation = ctx.conversation
  if (conversation && conversation.activeUntil > 0
    && conversation.activeUntil >= message.at
    && !message.atOther
    && conversation.interlocutorIds.includes(message.userId)) {
    return { kind: 'continuation', seq: message.seq, detail: message.name }
  }
  if (t.speakerIds.length && t.speakerIds.includes(message.userId)) {
    return { kind: 'speaker', seq: message.seq, detail: message.name }
  }
  if (t.probability > 0 && ctx.random() < t.probability) return { kind: 'probability', seq: message.seq }
  return null
}

/** 合并窗口内的原因升级：新原因优先级更高才替换，否则保留原定时。 */
export function mergeWakeReason(current: SimWakeReason | null, next: SimWakeReason): { reason: SimWakeReason; changed: boolean } {
  if (!current) return { reason: next, changed: true }
  if (WAKE_PRIORITY[next.kind] > WAKE_PRIORITY[current.kind]) return { reason: next, changed: true }
  return { reason: current, changed: false }
}

export function formatWakeReason(reason: SimWakeReason | null): string {
  if (!reason) return '无'
  switch (reason.kind) {
    case 'keyword': return `关键词「${reason.detail || ''}」`
    case 'speaker': return `关注的群友 ${reason.detail || reason.seq || ''}`
    case 'atMention': return '被@或引用'
    case 'continuation': return `刚才在聊天的${reason.detail || '群友'}又说话了`
    default: return reason.kind
  }
}

/** 消息类原因补发前要确认：未读里还能找到对应 seq（已被读掉的不补）。 */
export function messageReasonStillPending(reason: SimWakeReason, unread: SimMessage[]): boolean {
  if (TIMER_WAKE_REASONS.includes(reason.kind)) return true
  if (typeof reason.seq !== 'number') return false
  return unread.some(m => m.seq === reason.seq)
}

export function pushPendingReason(reasons: SimWakeReason[], reason: SimWakeReason, limit = 20): SimWakeReason[] {
  const next = [...reasons, reason]
  return next.length > limit ? next.slice(next.length - limit) : next
}
