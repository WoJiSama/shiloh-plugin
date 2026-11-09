// 承诺账本纯函数测试:时间归一/顺延/上限/卡片。全部走显式 now,不碰环境。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  advanceCommitmentAfterRun, checkCommitmentCaps, computeNextDailyRun, formatScheduleText,
  isCommitmentExpired, normalizeSchedule, parseOnceTime, renderCommitmentCard, resolvedCommitmentConfig,
} from '../../src/modules/commitments/domain/commitments.js'
import type { CommitmentData } from '../../src/contracts/commitments.js'

// 北京时间 2026-11-09 12:00:00 = UTC 2026-11-09T04:00:00Z
const NOON = Date.parse('2026-11-09T12:00:00+08:00')

test('computeNextDailyRun:当天未到=今天,已过=明天,北京时间语义', () => {
  const before = Date.parse('2026-11-09T08:00:00+08:00')
  assert.equal(computeNextDailyRun('12:00', before), NOON)
  assert.equal(computeNextDailyRun('12:00', NOON), NOON + 86400_000, '恰好到点视为已过,顺延明天')
  const after = Date.parse('2026-11-09T12:00:01+08:00')
  assert.equal(computeNextDailyRun('12:00', after), NOON + 86400_000)
  // 跨月:10-31 23:50 之后 → 11-01 23:50
  const halloween = Date.parse('2026-10-31T23:55:00+08:00')
  assert.equal(computeNextDailyRun('23:50', halloween), Date.parse('2026-11-01T23:50:00+08:00'))
  assert.equal(computeNextDailyRun('25:00', NOON), null)
  assert.equal(computeNextDailyRun('bad', NOON), null)
})

test('parseOnceTime:ISO 缺时区按北京时间补', () => {
  assert.equal(parseOnceTime('2026-11-10T12:00:00+08:00'), Date.parse('2026-11-10T12:00:00+08:00'))
  assert.equal(parseOnceTime('2026-11-10T12:00:00'), Date.parse('2026-11-10T12:00:00+08:00'))
  assert.equal(parseOnceTime('2026-11-10T04:00:00Z'), Date.parse('2026-11-10T04:00:00Z'))
  assert.equal(parseOnceTime(12345), 12345)
  assert.equal(parseOnceTime('garbage'), null)
  assert.equal(parseOnceTime(''), null)
})

test('normalizeSchedule:daily/once 校验与拒绝', () => {
  const daily = normalizeSchedule('daily', '12:00', NOON - 3600_000)
  assert.ok('schedule' in daily)
  assert.deepEqual(daily.schedule, { kind: 'daily', time: '12:00' })
  assert.equal(daily.nextRunAt, NOON)
  const once = normalizeSchedule('once', '2026-11-10T09:00:00+08:00', NOON)
  assert.ok('schedule' in once)
  assert.equal(once.nextRunAt, Date.parse('2026-11-10T09:00:00+08:00'))
  const past = normalizeSchedule('once', '2026-11-09T11:00:00+08:00', NOON)
  assert.ok('error' in past); assert.match(past.error, /过去/)
  const bad = normalizeSchedule('daily', '99:00', NOON)
  assert.ok('error' in bad); assert.match(bad.error, /HH:mm/)
  const unknown = normalizeSchedule('weekly', 'x', NOON)
  assert.ok('error' in unknown); assert.match(unknown.error, /once/)
})

test('advanceCommitmentAfterRun:daily 顺延,once 完结', () => {
  const base = {
    id: 'cmt_1', group_id: '1', creator_id: '2', creator_name: '星野', intent: '每天中午12点发三角洲今日密码',
    deliver: 'agent', static_message: null, expiry_at: 0, next_run_at: NOON, status: 'active',
    last_run_at: 0, last_result: '', retry_count: 0, created_at: 0, bot_id: '',
  } as CommitmentData
  assert.deepEqual(advanceCommitmentAfterRun({ ...base, schedule: { kind: 'daily', time: '12:00' } }, NOON + 1000), { nextRunAt: NOON + 86400_000, status: 'active' })
  assert.deepEqual(advanceCommitmentAfterRun({ ...base, schedule: { kind: 'once', time: NOON } }, NOON + 1000), { nextRunAt: null, status: 'completed' })
})

test('checkCommitmentCaps:群上限与个人上限', () => {
  const cfg = resolvedCommitmentConfig({})
  assert.deepEqual(cfg, { maxActivePerGroup: 10, maxPerCreator: 5, defaultExpiryDays: 30 })
  const mk = (creator: string): CommitmentData => ({ id: `cmt_${creator}`, group_id: '1', creator_id: creator, creator_name: creator, intent: 'x', schedule: { kind: 'daily', time: '12:00' }, deliver: 'static', static_message: 'x', expiry_at: 0, next_run_at: 1, status: 'active', last_run_at: 0, last_result: '', retry_count: 0, created_at: 0, bot_id: '' })
  const mine = Array.from({ length: 5 }, () => mk('2'))
  assert.match(checkCommitmentCaps(mine, '1', '2', cfg)!, /每人上限 5/, '5 条自己的即触个人上限')
  assert.equal(checkCommitmentCaps(mine.slice(0, 4), '1', '2', cfg), null, '4 条还能加')
  assert.equal(checkCommitmentCaps(mine, '1', '3', cfg), null, '别人不受影响')
  const crowd = Array.from({ length: 10 }, (_, i) => mk(String(i)))
  assert.match(checkCommitmentCaps(crowd, '1', '99', cfg)!, /上限 10 个/)
})

test('renderCommitmentCard 与 formatScheduleText', () => {
  const card = renderCommitmentCard({
    id: 'cmt_1', group_id: '1', creator_id: '2', creator_name: '星野', intent: '每天中午12点在群里发三角洲今日密码',
    schedule: { kind: 'daily', time: '12:00' }, deliver: 'agent', static_message: null,
    expiry_at: 0, next_run_at: NOON, status: 'active', last_run_at: 0, last_result: '', retry_count: 0, created_at: 0, bot_id: '',
  })
  assert.match(card, /星野 托付的事/)
  assert.match(card, /每天 12:00/)
  assert.match(card, /自己动手完成/)
  assert.equal(formatScheduleText({ kind: 'once', time: NOON }), '11-09 12:00')
})

test('isCommitmentExpired', () => {
  const c = { expiry_at: NOON + 1000 } as CommitmentData
  assert.equal(isCommitmentExpired(c, NOON), false)
  assert.equal(isCommitmentExpired(c, NOON + 1000), true)
  assert.equal(isCommitmentExpired({ expiry_at: 0 } as CommitmentData, NOON), false, '0=永不过期')
})
