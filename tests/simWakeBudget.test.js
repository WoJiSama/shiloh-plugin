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

test('按群金额上限：覆盖的群用本群上限，未覆盖的用默认，非法项被丢弃', () => {
  const base = defaultSimRuntimeConfig({ budget: { dailyCostCny: 5, groups: { '725902146': 30, '981339693': 15, abc: 99, '123': 1, '725902146x': 2 } } })
  assert.deepEqual(base.budget.groups, { '725902146': 30, '981339693': 15 })
  const at = { kind: 'atMention', seq: 1 }
  // 瓦尔哈拉覆盖 30：花 5 元仍在限内
  assert.equal(checkWakeBudget(state(), base, now, 5.0, at, '725902146').allowed, true)
  assert.equal(checkWakeBudget(state(), base, now, 5.0, at, '725902146').allowed, true)
  assert.match(checkWakeBudget(state(), base, now, 30.0, at, '725902146').reason, /30\.00\/30/)
  // 未覆盖的群仍按默认 5 拦
  assert.match(checkWakeBudget(state(), base, now, 5.0, at, '295708427').reason, /5\.00\/5/)
  // 覆盖 15 的群介于两者之间
  assert.equal(checkWakeBudget(state(), base, now, 5.0, at, '981339693').allowed, true)
  assert.match(checkWakeBudget(state(), base, now, 15.0, at, '981339693').reason, /15\.00\/15/)
})

test('按群上限支持不限(-1):回合与金额都不再拦截', () => {
  const cfg = defaultSimRuntimeConfig({ budget: { dailyCostCny: 5, groups: { '725902146': -1 } }, turn: { groups: { '725902146': -1 } } })
  const at = { kind: 'atMention', seq: 1 }
  // 回合 999、花费 999 元都不拦
  assert.equal(checkWakeBudget(state({ turns: 999 }), cfg, now, 999, at, '725902146').allowed, true)
  // 其他群照常受限
  assert.match(checkWakeBudget(state({ turns: 40 }), cfg, now, 0, at, '295708427').reason, /dailyTurns/)
  // 回合按群具体值生效
  const cfg50 = defaultSimRuntimeConfig({ turn: { groups: { '933253375': 50 } } })
  assert.equal(checkWakeBudget(state({ turns: 49 }), cfg50, now, 0, at, '933253375').allowed, true)
  assert.match(checkWakeBudget(state({ turns: 50 }), cfg50, now, 0, at, '933253375').reason, /50/)
})
