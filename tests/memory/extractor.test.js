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

test('eventInDays uses provided source at when ctx.now is absent', () => {
  const ops = parseAndRoute([
    { route: 'self_statement', content: '下周有考试', eventInDays: 7, confidence: 0.9 }
  ], ctx) // no now
  assert.equal(ops[0].fact.eventAt, ctx.at + 7 * DAY_MS)
})

test('event dates survive a midnight flush and use the selected utterance clock', () => {
  const first=Date.parse('2026-10-15T23:59:00+08:00')
  const second=Date.parse('2026-10-16T00:01:00+08:00')
  const ops=parseAndRoute([
    {route:'self_statement',content:'明天考试',eventInDays:1,sourceIndex:1},
    {route:'self_statement',content:'明天面试',eventInDays:1,sourceIndex:2},
    {route:'self_statement',content:'来源不明',eventInDays:1},
    {route:'self_statement',content:'行号不合法',eventInDays:1,sourceIndex:3}
  ],{speakerQQ:'1',at:second+DAY_MS,messages:[{content:'明天考试',at:first},{content:'明天面试',at:second}]})
  assert.equal(ops[0].fact.eventAt,first+DAY_MS)
  assert.equal(ops[0].fact.at,first)
  assert.equal(ops[1].fact.eventAt,second+DAY_MS)
  assert.equal(ops[2].fact.eventAt,null)
  assert.equal(ops[3].fact.eventAt,null)
})

test('absolute calendar dates are validated and invalid relative values cannot become day zero', () => {
  const items=[null,'',false,true,Infinity,0.5,'1'].map(eventInDays=>({route:'self_statement',content:'日期未知',eventInDays}))
  const invalid=parseAndRoute(items,ctxNow)
  assert.ok(invalid.every(op=>op.fact.eventAt===null))
  const dated=parseAndRoute([
    {route:'self_statement',content:'十月十七日考试',eventDate:'2026-10-17'},
    {route:'self_statement',content:'坏日期',eventDate:'2026-02-30'},
    {route:'self_statement',content:'未知日期',eventInDays:1}
  ],{speakerQQ:'1',at:NOW,messages:[{content:'unknown'}]})
  assert.equal(dated[0].fact.eventAt,Date.parse('2026-10-17T12:00:00+08:00'))
  assert.equal(dated[1].fact.eventAt,null)
  assert.equal(dated[2].fact.eventAt,null)
})

test('third-party forward and quote never become sender self-memory or group consensus', () => {
  const messages=[{content:'我叫小馒头',source:'forward',at:1000},{content:'群里周三开会',source:'user',at:2000}]
  const ops=parseAndRoute([
    {route:'self_statement',alias:'小馒头',sourceIndex:1},
    {route:'group_consensus',content:'小馒头是本人',sourceIndex:1},
    {route:'group_consensus',content:'来源缺失'},
    {route:'group_consensus',content:'群里周三开会',sourceIndex:2}
  ],{speakerQQ:'1',at:3000,messages})
  assert.equal(ops.length,1)
  assert.equal(ops[0].fact.text,'群里周三开会')
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
