// tests/memory/extractor.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAndRoute } from '../../domains/memory/engine/extractor.js'

const ctx = { speakerQQ: '925640859', at: 1000 }

test('explicit_teaching is ignored by the background extractor', () => {
  const ops = parseAndRoute([
    { route: 'explicit_teaching', alias: 'maela', targetQQ: '3188163302', confidence: 0.9 }
  ], ctx)
  assert.deepEqual(ops, [])
})

test('self_statement name -> speaker alias authority self', () => {
  const ops = parseAndRoute([
    { route: 'self_statement', alias: '咖啡大人', confidence: 0.9 }
  ], ctx)
  assert.equal(ops[0].stream, 'alias')
  assert.equal(ops[0].authority, 'self')
  assert.equal(ops[0].qq, '925640859') // attaches to speaker
})

test('user_preference -> speaker entity fact tag 偏好', () => {
  const ops = parseAndRoute([
    { route: 'user_preference', content: '不喜欢被叫全名', confidence: 0.8 }
  ], ctx)
  assert.equal(ops[0].stream, 'entityFact')
  assert.equal(ops[0].qq, '925640859')
  assert.ok(ops[0].fact.tags.includes('偏好'))
})

test('group_consensus -> group fact authority mention', () => {
  const ops = parseAndRoute([
    { route: 'group_consensus', content: '群里不要刷屏', tags: ['群规'], confidence: 0.8 }
  ], ctx)
  assert.equal(ops[0].stream, 'groupFact')
  assert.equal(ops[0].authority, 'mention')
})

test('ordinary_chat and unknown routes are dropped', () => {
  const ops = parseAndRoute([
    { route: 'ordinary_chat', content: '哈哈' },
    { route: 'bogus', content: 'x' },
    null,
    { route: 'self_statement' } // no alias/content
  ], ctx)
  assert.equal(ops.length, 0)
})

const NOW = 1_700_000_000_000
const DAY_MS = 86400000
const ctxNow = { speakerQQ: '925640859', at: 1000, now: NOW }

test('eventInDays sets eventAt on entity fact (self_statement) with ctx.now', () => {
  const ops = parseAndRoute([
    { route: 'self_statement', content: '下周有考试', eventInDays: 7, confidence: 0.9 }
  ], ctxNow)
  assert.equal(ops[0].stream, 'entityFact')
  assert.equal(ops[0].fact.eventAt, NOW + 7 * DAY_MS)
})

test('eventInDays negative sets past eventAt on group fact (group_consensus)', () => {
  const ops = parseAndRoute([
    { route: 'group_consensus', content: '昨天开了会', eventInDays: -1, confidence: 0.8 }
  ], ctxNow)
  assert.equal(ops[0].stream, 'groupFact')
  assert.equal(ops[0].fact.eventAt, NOW - 1 * DAY_MS)
})

test('teaching facts are reserved for the synchronous group decision', () => {
  const ops = parseAndRoute([
    { route: 'explicit_teaching', content: '群庆在三天后', eventInDays: 3, confidence: 0.8 }
  ], ctxNow)
  assert.deepEqual(ops, [])
})

test('eventAt stays null when ctx.now missing', () => {
  const ops = parseAndRoute([
    { route: 'self_statement', content: '下周有考试', eventInDays: 7, confidence: 0.9 }
  ], ctx) // no now
  assert.equal(ops[0].fact.eventAt, null)
})

test('eventAt stays null when eventInDays absent or non-finite', () => {
  const ops = parseAndRoute([
    { route: 'self_statement', content: '在上海工作', confidence: 0.9 },
    { route: 'group_consensus', content: '群规一', eventInDays: 'soon', confidence: 0.8 }
  ], ctxNow)
  assert.equal(ops[0].fact.eventAt, null)
  assert.equal(ops[1].fact.eventAt, null)
})

test('refs filtered to pure-number strings on self_statement entity fact', () => {
  const ops = parseAndRoute([
    { route: 'self_statement', content: '我和他是同事', refs: ['123', 456], confidence: 0.9 }
  ], ctx)
  assert.equal(ops[0].stream, 'entityFact')
  assert.deepEqual(ops[0].fact.refs, ['123', '456'])
})

test('refs drops non-numeric and hallucinated values, dedupes', () => {
  const ops = parseAndRoute([
    { route: 'self_statement', content: '提到一堆人', refs: ['123', 'abc', '@456', '12.3', '789', '789', '', null], confidence: 0.9 }
  ], ctx)
  assert.deepEqual(ops[0].fact.refs, ['123', '789'])
})

test('refs on group_consensus group fact filtered to pure numbers', () => {
  const ops = parseAndRoute([
    { route: 'group_consensus', content: '群里都说他俩闹掰了', refs: ['111', 'qq222', '333'], confidence: 0.8 }
  ], ctx)
  assert.equal(ops[0].stream, 'groupFact')
  assert.deepEqual(ops[0].fact.refs, ['111', '333'])
})

test('refs absent or non-array yields empty refs', () => {
  const ops = parseAndRoute([
    { route: 'self_statement', content: '没提别人', confidence: 0.9 },
    { route: 'user_preference', content: '喜欢安静', refs: 'not-an-array', confidence: 0.8 }
  ], ctx)
  assert.deepEqual(ops[0].fact.refs, [])
  assert.deepEqual(ops[1].fact.refs, [])
})
