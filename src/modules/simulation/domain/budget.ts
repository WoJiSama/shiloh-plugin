import type { SimRuntimeConfig, SimSessionState, SimWakeReason } from '../../../contracts/simulation.js'
import { dayKey } from './simConfig.js'

function pruneWindow(times: number[], now: number, windowMs: number, limit: number): number[] {
  const cutoff = now - windowMs
  const kept = times.filter(t => t > cutoff)
  return kept.length > limit ? kept.slice(kept.length - limit) : kept
}

export function rollBudgetDay(state: SimSessionState, now: number): void {
  const today = dayKey(now)
  if (state.budget.day !== today) state.budget = { day: today, turns: 0, tokens: 0 }
}

export interface WakeBudgetVerdict { allowed: boolean; reason: string }

/** 直接点名类唤醒：被@/被引用、叫名字、明确向 AI 提问、管理员指令。
 *  社交上"被点名不回"最伤——限频只管旁观型唤醒(关键词/随机/延续等),这几类直接放行;金额与每日回合预算仍生效。 */
const DIRECT_ADDRESS_WAKE_KINDS: readonly string[] = ['admin', 'atMention', 'nameMention', 'question']

/** 唤醒限频（1 分钟/1 小时两窗）+ 每群每日回合预算 + 当日金额预算（读令牌账本）。超限只能延后不能丢弃（由调用方重试）。 */
export function checkWakeBudget(state: SimSessionState, config: SimRuntimeConfig, now: number, todayCostCny = 0, reason: SimWakeReason | null = null, groupId = ''): WakeBudgetVerdict {
  rollBudgetDay(state, now)
  if (!DIRECT_ADDRESS_WAKE_KINDS.includes(String(reason?.kind || ''))) {
    const minuteWindow = pruneWindow(state.wakeTimes, now, 60_000, 200)
    if (minuteWindow.length >= config.wake.maxWakePerMinute) {
      return { allowed: false, reason: `wakePerMinute:${minuteWindow.length}/${config.wake.maxWakePerMinute}` }
    }
    const hourWindow = pruneWindow(state.wakeTimes, now, 3600_000, 200)
    if (hourWindow.length >= config.wake.maxWakePerHour) {
      return { allowed: false, reason: `wakePerHour:${hourWindow.length}/${config.wake.maxWakePerHour}` }
    }
  }
  // 按群覆盖(-1=不限)优先于全局默认:回合与金额同规则
  const turnsCap = config.turn.groups?.[groupId] ?? config.turn.maxTurnsPerDay
  if (turnsCap >= 0 && state.budget.turns >= turnsCap) {
    return { allowed: false, reason: `dailyTurns:${state.budget.turns}/${turnsCap}` }
  }
  const dailyCap = config.budget.groups?.[groupId] ?? config.budget.dailyCostCny
  if (dailyCap > 0 && todayCostCny >= dailyCap) {
    return { allowed: false, reason: `dailyCost:${todayCostCny.toFixed(2)}/${dailyCap}元` }
  }
  return { allowed: true, reason: 'ok' }
}

export function recordWake(state: SimSessionState, now: number): void {
  state.wakeTimes = pruneWindow([...state.wakeTimes, now], now, 3600_000, 200)
  state.lastWakeAt = now
  state.budget.turns += 1
}

export function recordWakeTokens(state: SimSessionState, tokens: number): void {
  const value = Math.max(0, Math.floor(Number(tokens) || 0))
  state.budget.tokens += value
}

export interface SendAllowance { allowed: boolean; reason: string }

/** 回合内发送条数 + 每分钟发送频率。 */
export function checkSendAllowance(state: SimSessionState, config: SimRuntimeConfig, now: number, sendsThisTurn: number): SendAllowance {
  if (sendsThisTurn >= config.turn.maxSendsPerTurn) {
    return { allowed: false, reason: `本回合发送已达上限 ${config.turn.maxSendsPerTurn} 条，请收束这一轮，把想说的话留到下次唤醒` }
  }
  const minuteWindow = pruneWindow(state.sendTimes, now, 60_000, 200)
  if (minuteWindow.length >= config.turn.sendPerMinute) {
    return { allowed: false, reason: `发送频率已达 ${config.turn.sendPerMinute} 条/分钟，请等一会儿再发` }
  }
  return { allowed: true, reason: 'ok' }
}

export function recordSend(state: SimSessionState, now: number, count = 1): void {
  const added = [...state.sendTimes]
  for (let i = 0; i < count; i += 1) added.push(now)
  state.sendTimes = pruneWindow(added, now, 3600_000, 200)
}

/**
 * 新消息到达即重置沉睡前观察：参与感被新内容打断，之前的「观察够了」不再成立。
 */
export function resetPreSleepWait(state: SimSessionState): void {
  state.preSleepWait = { accumMs: 0 }
}

export function markPreSleepSatisfied(state: SimSessionState, now: number): void {
  state.preSleepWait.satisfiedAt = now
  state.preSleepWait.observedAt = now
}

/** 发言=参与：发言后沉睡前观察作废。 */
export function invalidatePreSleepWaitByParticipation(state: SimSessionState): void {
  state.preSleepWait = { accumMs: 0 }
}

/** 每日限额的人话描述;非预算类原因返回空串 */
export function describeBudgetLimit(reason: string): string {
  if (reason.startsWith("dailyTurns")) return "今日对话回合已达上限"
  if (reason.startsWith("dailyCost")) return "今日消耗额度已达上限"
  return ""
}

/** 限额提示节流:同一群冷却窗口内只提醒一次(默认 30 分钟) */
export function limitNoticeDue(lastAt: number, now: number, cooldownMs = 30 * 60_000): boolean {
  return !(lastAt > 0 && now - lastAt < cooldownMs)
}

/** 限额提示是否值得发:死群里定时器自主唤醒被拦时没人看着,突然冒一句"调用已限额"很瘆人——
 *  只有被点名(@/叫名/提问/管理员)或近 30 分钟内有人说过话才提示,其余静默记日志。 */
export function shouldAnnounceBudgetLimit(reasonKind: string, lastIncomingAt: number, now: number, recentWindowMs = 30 * 60_000): boolean {
  if (["admin", "atMention", "nameMention", "question"].includes(reasonKind)) return true
  return lastIncomingAt > 0 && now - lastIncomingAt < recentWindowMs
}
