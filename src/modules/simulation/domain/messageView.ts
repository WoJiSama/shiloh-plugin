import type { SimMessage, SimSessionState } from '../../../contracts/simulation.js'
import { readThroughSeq } from './watermark.js'

/** epoch → "HH:MM"（北京时间，与主链路 local_time 口径一致）。 */
export function atClock(now: number): string {
  const d = new Date(now + 8 * 3600_000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

export function agoText(at: number, now: number): string {
  const delta = Math.max(0, now - at)
  if (delta < 60_000) return `${Math.max(1, Math.floor(delta / 1000))}秒前`
  if (delta < 3600_000) return `${Math.floor(delta / 60_000)}分钟前`
  if (delta < 86_400_000) return `${(delta / 3600_000).toFixed(1)}小时前`
  return `${Math.floor(delta / 86_400_000)}天前`
}

/** 单条消息的紧凑视图：删空字段、epoch 换 at/ago（防沉睡后把旧消息当刚发的）。 */
export function compactSimMessage(message: SimMessage, now: number): string {
  const media = message.imageCount > 0 ? ` [附图×${message.imageCount}]` : ''
  const forward = message.forwardId ? ' [合并转发，可用 simGetForward 查看]' : ''
  // 引用标记：引用你的话 vs 引用别人的话（带被引用人+原文——判断"这句话对谁说"的关键信号，引用第三方时别抢话）
  const quoted = message.quoteToSelf
    ? '[引用你的话]'
    : message.quoteAuthor ? `[引用 ${message.quoteAuthor}${message.quoteText ? `：${message.quoteText}` : ''}]` : ''
  const self = message.atSelf ? '[@你]' : ''
  return `${atClock(message.at)}(${agoText(message.at, now)}) ${message.name}${self}: ${quoted}${message.text}${media}${forward}`
}

export interface SimSnapshot {
  text: string
  included: number
  unreadTotal: number
  partial: boolean
  readThroughSeq: number
}

/**
 * 唤醒快照：最早未读优先（最老的上下文最重要），超出条数/字符预算从最新的开始丢并标记 partial。
 * 快照即「已给模型」，调用方必须 noteModelSeen。
 */
export function buildWakeSnapshot(state: SimSessionState, opts: { limit: number; maxChars: number; now: number }): SimSnapshot {
  const ordered = [...state.unread].sort((a, b) => a.seq - b.seq)
  const budget = Math.max(1, Math.floor(opts.limit))
  const chosen: SimMessage[] = []
  let chars = 0
  for (const message of ordered) {
    if (chosen.length >= budget) break
    const line = compactSimMessage(message, opts.now)
    if (chars + line.length > opts.maxChars && chosen.length > 0) break
    chosen.push(message)
    chars += line.length
  }
  const lines = chosen.map(m => compactSimMessage(m, opts.now))
  const partial = chosen.length < ordered.length
  if (partial && lines.length) lines.push(`（未读共 ${ordered.length} 条，这里只给出最早的 ${chosen.length} 条；其余请用 simGetUnreadMessages 从 readThroughSeq 之后续读）`)
  return {
    text: lines.join('\n'),
    included: chosen.length,
    unreadTotal: ordered.length,
    partial,
    readThroughSeq: readThroughSeq(state),
  }
}

export function seqsOf(messages: SimMessage[]): number[] {
  return messages.map(m => m.seq)
}
