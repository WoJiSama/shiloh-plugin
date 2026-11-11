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

test('限额提示:预算类原因有人话描述,同群 30 分钟节流', async () => {
  const { describeBudgetLimit, limitNoticeDue } = await import('../dist/backend/modules/simulation/domain/budget.js')
  assert.match(describeBudgetLimit('dailyTurns:40/40'), /回合/)
  assert.match(describeBudgetLimit('dailyCost:5.00/5元'), /消耗/)
  assert.equal(describeBudgetLimit('wakePerHour:12/12'), '')
  const t = 1770000000000
  assert.equal(limitNoticeDue(0, t), true, '首次必发')
  assert.equal(limitNoticeDue(t - 60_000, t), false, '冷却内不发')
  assert.equal(limitNoticeDue(t - 31 * 60_000, t), true, '过期再发')
})

test('限额提示只在有人在场时发:死群的定时器唤醒被拦不冒泡', async () => {
  const { shouldAnnounceBudgetLimit } = await import('../dist/backend/modules/simulation/domain/budget.js')
  const t = 1770000000000
  assert.equal(shouldAnnounceBudgetLimit('proactiveCheck', 0, t), false, '死群无人说话')
  assert.equal(shouldAnnounceBudgetLimit('proactiveCheck', t - 3600_000, t), false, '一小时前有人说话已离场')
  assert.equal(shouldAnnounceBudgetLimit('proactiveCheck', t - 5 * 60_000, t), true, '刚有人说话')
  assert.equal(shouldAnnounceBudgetLimit('replyCheck', t - 5 * 60_000, t), true, '回音检查且刚有人说话')
  for (const kind of ['atMention', 'nameMention', 'question', 'admin']) {
    assert.equal(shouldAnnounceBudgetLimit(kind, 0, t), true, `${kind} 被点名必提示`)
  }
})

test('承诺到期唤醒绕过每日回合/金额预算：答应了不放，不隐性失约', () => {
  const cfg = config()
  const commitment = { kind: 'commitment', detail: '每天中午12点发三角洲今日密码' }
  assert.equal(checkWakeBudget(state({ turns: 40 }), cfg, now, 0, commitment).allowed, true, '回合打满仍放行')
  const costly = checkWakeBudget(state(), cfg, now, 5.0, commitment)
  assert.equal(costly.allowed, true, '金额到顶仍放行')
  assert.equal(costly.reason, 'commitment')
  // 其他直接点名类不享受该豁免（对照组）
  assert.equal(checkWakeBudget(state({ turns: 40 }), cfg, now, 0, { kind: 'atMention', seq: 1 }).allowed, false)
})

test('被点名回合发送豁免小时闸：醒了就发得出声（瓦尔哈拉实拍事故回归）', async () => {
  const { checkSendAllowance, isDirectAddressKind } = await import('../dist/backend/modules/simulation/domain/budget.js')
  const cfg = config()
  const full = { wakeTimes: [], sendTimes: Array(10).fill(now - 61_000), budget: { day: dayKey(now), turns: 0, tokens: 0 } }
  assert.equal(checkSendAllowance(full, cfg, now, 0).allowed, false, '旁听回合小时闸照拦')
  assert.match(checkSendAllowance(full, cfg, now, 0).reason, /说得够多了/)
  assert.equal(checkSendAllowance(full, cfg, now, 0, true).allowed, true, '点名回合跳过小时闸')
  const minuteFull = { wakeTimes: [], sendTimes: Array(8).fill(now - 5_000), budget: { day: dayKey(now), turns: 0, tokens: 0 } }
  assert.equal(checkSendAllowance(minuteFull, cfg, now, 0, true).allowed, false, '分钟频控不豁免')
  assert.match(checkSendAllowance(minuteFull, cfg, now, 0, true).reason, /分钟/)
  assert.equal(checkSendAllowance(full, cfg, now, 5, true).allowed, false, '回合上限不豁免')
  for (const kind of ['admin', 'atMention', 'nameMention', 'question', 'commitment']) assert.equal(isDirectAddressKind(kind), true, kind)
  for (const kind of ['keyword', 'probability', 'continuation', 'replyCheck', undefined]) assert.equal(isDirectAddressKind(kind), false, String(kind))
})
