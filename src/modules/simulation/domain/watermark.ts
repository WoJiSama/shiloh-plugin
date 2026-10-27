import type { SimMessage, SimSessionState } from '../../../contracts/simulation.js'

/**
 * 水位协议（纯状态管理）：
 * - lastReadThroughSeq 是「连续已读」游标，只能跨过「确实给过模型的 seq」或「已被淘汰、再也不可能展示的 seq」。
 * - modelSeenSeqs 只记给过模型的（可见 ≠ 确认），并裁剪到当前未读窗口内。
 * - agent 只能把水位提交到 ≤ readThroughSeq，越界拒绝。
 */
export function readThroughSeq(state: Pick<SimSessionState, 'unread' | 'lastReadThroughSeq' | 'modelSeenSeqs'>): number {
  const seen = new Set(state.modelSeenSeqs)
  let cursor = state.lastReadThroughSeq
  for (const message of state.unread) {
    if (message.seq <= cursor) continue
    if (seen.has(message.seq)) { cursor = message.seq; continue }
    break
  }
  return cursor
}

export function noteModelSeen(state: SimSessionState, seqs: number[]): void {
  const window = new Set(state.unread.map(m => m.seq))
  const all = seqs.length ? [...state.modelSeenSeqs, ...seqs] : state.modelSeenSeqs
  state.modelSeenSeqs = [...new Set(all.filter(seq => window.has(seq)))].sort((a, b) => a - b)
}

export function acknowledgeMessages(state: SimSessionState, throughSeq: number): boolean {
  const limit = readThroughSeq(state)
  const value = Math.floor(Number(throughSeq))
  if (!Number.isFinite(value) || value < 0) return false
  if (value > limit) return false
  state.unread = state.unread.filter(m => m.seq > value)
  state.lastReadThroughSeq = Math.max(state.lastReadThroughSeq, value)
  noteModelSeen(state, [])
  return true
}

export function unreadSince(state: Pick<SimSessionState, 'unread'>, afterSeq: number, limit: number): SimMessage[] {
  return state.unread
    .filter(m => m.seq > afterSeq)
    .sort((a, b) => a.seq - b.seq)
    .slice(0, Math.max(1, limit))
}

export function unreadCount(state: Pick<SimSessionState, 'unread'>): number {
  return state.unread.length
}
