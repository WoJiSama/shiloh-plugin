import type { SimRuntimeConfig, SimSessionState } from '../../../contracts/simulation.js'
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

/** 唤醒限频（1 分钟/1 小时两窗）+ 每群每日回合预算 + 当日金额预算（读令牌账本）。超限只能延后不能丢弃（由调用方重试）。 */
export function checkWakeBudget(state: SimSessionState, config: SimRuntimeConfig, now: number, todayCostCny = 0): WakeBudgetVerdict {
  rollBudgetDay(state, now)
  const minuteWindow = pruneWindow(state.wakeTimes, now, 60_000, 200)
  if (minuteWindow.length >= config.wake.maxWakePerMinute) {
    return { allowed: false, reason: `wakePerMinute:${minuteWindow.length}/${config.wake.maxWakePerMinute}` }
  }
  const hourWindow = pruneWindow(state.wakeTimes, now, 3600_000, 200)
  if (hourWindow.length >= config.wake.maxWakePerHour) {
    return { allowed: false, reason: `wakePerHour:${hourWindow.length}/${config.wake.maxWakePerHour}` }
  }
  if (state.budget.turns >= config.turn.maxTurnsPerDay) {
    return { allowed: false, reason: `dailyTurns:${state.budget.turns}/${config.turn.maxTurnsPerDay}` }
  }
  if (config.budget.dailyCostCny > 0 && todayCostCny >= config.budget.dailyCostCny) {
    return { allowed: false, reason: `dailyCost:${todayCostCny.toFixed(2)}/${config.budget.dailyCostCny}元` }
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
