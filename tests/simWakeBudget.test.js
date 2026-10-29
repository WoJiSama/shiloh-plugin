import test from 'node:test'
import assert from 'node:assert/strict'
import { checkWakeBudget } from '../dist/backend/modules/simulation/domain/budget.js'
import { defaultSimRuntimeConfig, dayKey } from '../dist/backend/modules/simulation/domain/simConfig.js'

const now = 1770000000000
function state({ wakeTimes = [], turns = 0 } = {}) {
  return { wakeTimes, sendTimes: [], budget: { day: dayKey(now), turns, tokens: 0 } }
}
function config({ maxTurnsPerDay = 40, dailyCostCny = 5 } = {}) {
  const base = defaultSimRuntimeConfig()
  return { ...base, turn: { ...base.turn, maxTurnsPerDay }, budget: { ...base.budget, dailyCostCny } }
}

test('小时限频打满后，被@/叫名字/提问/管理员仍放行', () => {
  const full = Array.from({ length: 12 }, (_, i) => now - i * 60_000)
  const cfg = config()
  for (const reason of [
    { kind: 'atMention', seq: 1 },
    { kind: 'nameMention', seq: 1, detail: '希洛' },
    { kind: 'question', seq: 1 },
    { kind: 'admin', seq: 1 }
  ]) {
    assert.equal(checkWakeBudget(state({ wakeTimes: full }), cfg, now, 0, reason).allowed, true, reason.kind)
  }
})

test('旁观型唤醒照旧被小时限频拦截', () => {
  const full = Array.from({ length: 12 }, (_, i) => now - i * 60_000)
  const cfg = config()
  for (const reason of [
    { kind: 'keyword', seq: 1, detail: '游戏' },
    { kind: 'probability', seq: 1 },
    { kind: 'continuation', seq: 1 },
    null
  ]) {
    const verdict = checkWakeBudget(state({ wakeTimes: full }), cfg, now, 0, reason)
    assert.equal(verdict.allowed, false, String(reason?.kind))
    assert.match(verdict.reason, /wakePerHour/)
  }
})

test('点名豁免不豁免预算：每日回合与金额闸仍然拦截', () => {
  const cfg = config()
  const at = { kind: 'atMention', seq: 1 }
  assert.equal(checkWakeBudget(state({ turns: 40 }), cfg, now, 0, at).allowed, false)
  assert.match(checkWakeBudget(state({ turns: 40 }), cfg, now, 0, at).reason, /dailyTurns/)
  const costly = checkWakeBudget(state(), cfg, now, 5.0, at)
  assert.equal(costly.allowed, false)
  assert.match(costly.reason, /dailyCost/)
})
