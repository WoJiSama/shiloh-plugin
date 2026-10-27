import type { SimMessage, SimSessionState } from '../../../contracts/simulation.js'

/**
 * 沉睡前观察 / 回复前静默闸门（纯逻辑，等待本身由 infrastructure 的事件等待实现）。
 * purpose='reply'：回复前短静默——从最后一条消息起算 quietMs，安静够久立即返回。
 * purpose='messages'：等下文——先等 minNew 条新消息，等到后再等「最后一条新消息后
 *   minQuietAfterNewMs 无新消息」（防抢话）。
 */
export interface SimWaitPlan {
  purpose: 'reply' | 'messages'
  quietMs: number
  timeoutMs: number
  minNewMessages: number
  minQuietAfterNewMs: number
}

export const MIN_QUIET_AFTER_NEW_MS = 10_000

export function normalizeWaitPlan(input: unknown, maxQuietMs: number, maxTimeoutMs: number): SimWaitPlan {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
  const purpose = raw.purpose === 'reply' ? 'reply' : 'messages'
  const quietMs = clampInt(raw.quietMs, 1000, maxQuietMs, purpose === 'reply' ? 8000 : 30_000)
  const timeoutMs = clampInt(raw.timeoutMs, 1000, maxTimeoutMs, Math.min(maxTimeoutMs, quietMs + 30_000))
  const minNewMessages = clampInt(raw.minNewMessages, 1, 10, 1)
  const minQuietAfterNewMs = clampInt(raw.minQuietAfterNewMs, 1000, MIN_QUIET_AFTER_NEW_MS, MIN_QUIET_AFTER_NEW_MS)
  return { purpose, quietMs, timeoutMs, minNewMessages, minQuietAfterNewMs }
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export interface SimWaitOutcome {
  canSleepNow: boolean
  countsAsObservation: boolean
  hint: string
  newMessages: SimMessage[]
  partial: boolean
}

/**
 * 由等待实现在退出等待时调用：判定此刻能不能睡、该怎么继续。
 * 把闸门结论直接写给模型（canSleepNow/hint）——这是 qq-bridge 实测过的防白烧轮次手段。
 * timedOut=true 表示等待预算耗尽而非条件满足，hint 会明确告知这是超时收尾。
 */
export function computeWaitOutcome(state: SimSessionState, plan: SimWaitPlan, arrived: SimMessage[], now: number, lastNewIncomingAt: number, timedOut = false): SimWaitOutcome {
  const quietFor = now - Math.max(state.lastIncomingAt, 0)
  if (plan.purpose === 'reply') {
    const quietEnough = quietFor >= plan.quietMs
    if (timedOut && !quietEnough) {
      return {
        canSleepNow: false,
        countsAsObservation: true,
        hint: `等待超时：群里 ${Math.floor(quietFor / 1000)} 秒前还有新消息，始终没安静到 ${Math.floor(plan.quietMs / 1000)} 秒。这算一次有效观察——要么直接回，要么放弃这轮等待。`,
        newMessages: arrived,
        partial: false,
      }
    }
    return {
      canSleepNow: quietEnough,
      countsAsObservation: quietEnough,
      hint: quietEnough
        ? `群里已安静 ${Math.floor(quietFor / 1000)} 秒，可以回复了（回复前不用再等）。`
        : `群里 ${Math.floor(quietFor / 1000)} 秒前还有新消息，还没安静到 ${Math.floor(plan.quietMs / 1000)} 秒；建议继续 simWaitForMessages 或直接决定不回。`,
      newMessages: arrived,
      partial: false,
    }
  }
  if (arrived.length < plan.minNewMessages) {
    return {
      canSleepNow: false,
      countsAsObservation: true,
      hint: `${timedOut ? '等待超时，' : ''}等待期间新增 ${arrived.length} 条（目标 ≥${plan.minNewMessages} 条）。这就是一次有效观察，现在可以选择回一句，或设置唤醒配置后结束回合睡觉。`,
      newMessages: arrived,
      partial: false,
    }
  }
  const quietAfterNew = now - Math.max(lastNewIncomingAt, 0)
  const quietEnough = quietAfterNew >= plan.minQuietAfterNewMs
  return {
    canSleepNow: quietEnough,
    countsAsObservation: quietEnough,
    hint: quietEnough
      ? `等到了 ${arrived.length} 条新消息，且之后已安静 ${Math.floor(quietAfterNew / 1000)} 秒。上下文足够，请基于新消息决定怎么接。`
      : `等到了 ${arrived.length} 条新消息，但最后一条之后只安静了 ${Math.floor(quietAfterNew / 1000)} 秒（防抢话要 ${Math.floor(plan.minQuietAfterNewMs / 1000)} 秒）。${timedOut ? '本次等待已超时。' : ''}建议再等一小会儿或直接决定。`,
    newMessages: arrived,
    partial: false,
  }
}
