// tests/memory/entityModel.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { makeEntity, makeAlias, makeFact, slimEntityDoc, factShortId } from '../../domains/memory/engine/entityModel.js'
import { createHash } from 'node:crypto'

test('makeAlias produces slim shape, no bloat fields', () => {
  const a = makeAlias({ text: 'Maela', authority: 'teaching', confidence: 0.9, by: ['1','1'], at: 100 })
  assert.deepEqual(Object.keys(a).sort(), ['at','authority','by','confidence','superseded','text'].sort())
  assert.deepEqual(a.by, ['1']) // deduped
  assert.equal(a.superseded, false)
})

test('makeFact keeps slim shape with embedding/eventAt/origin, drops other bloat', () => {
  const f = makeFact({ text: 'likes 原神', tags: ['偏好'], refs: ['2'], authority: 'self', confidence: 0.8, at: 1,
    sourceMessageIds: ['x'], embedding: [1,2], eventAt: 1000, origin: 'extract', score: 0.5, relevance: 0.3 })
  assert.deepEqual(Object.keys(f).sort(),
    ['at','authority','confidence','embedding','eventAt','origin','refs','superseded','tags','text'].sort())
  assert.equal(f.sourceMessageIds, undefined)
  assert.equal(f.score, undefined)
})

test('makeFact normalizes embedding: Array kept, non-Array → null', () => {
  assert.deepEqual(makeFact({ text: 't', embedding: [0.1, 0.2] }).embedding, [0.1, 0.2])
  assert.equal(makeFact({ text: 't', embedding: 'nope' }).embedding, null)
  assert.equal(makeFact({ text: 't', embedding: 42 }).embedding, null)
  assert.equal(makeFact({ text: 't', embedding: { 0: 1 } }).embedding, null)
  assert.equal(makeFact({ text: 't' }).embedding, null) // default
})

test('makeFact normalizes eventAt: finite number kept, otherwise → null', () => {
  assert.equal(makeFact({ text: 't', eventAt: 1718000000000 }).eventAt, 1718000000000)
  assert.equal(makeFact({ text: 't', eventAt: 0 }).eventAt, 0)
  assert.equal(makeFact({ text: 't', eventAt: 'soon' }).eventAt, null)
  assert.equal(makeFact({ text: 't', eventAt: NaN }).eventAt, null)
  assert.equal(makeFact({ text: 't', eventAt: Infinity }).eventAt, null)
  assert.equal(makeFact({ text: 't' }).eventAt, null) // default
})

test('makeFact normalizes origin: whitelist kept, otherwise → extract', () => {
  assert.equal(makeFact({ text: 't', origin: 'extract' }).origin, 'extract')
  assert.equal(makeFact({ text: 't', origin: 'reflection' }).origin, 'reflection')
  assert.equal(makeFact({ text: 't', origin: 'config' }).origin, 'config')
  assert.equal(makeFact({ text: 't', origin: 'hacker' }).origin, 'extract')
  assert.equal(makeFact({ text: 't', origin: 123 }).origin, 'extract')
  assert.equal(makeFact({ text: 't' }).origin, 'extract') // default
})

test('makeAlias does not gain embedding/eventAt/origin fields', () => {
  const a = makeAlias({ text: 'x', embedding: [1,2], eventAt: 1, origin: 'reflection' })
  assert.equal(a.embedding, undefined)
  assert.equal(a.eventAt, undefined)
  assert.equal(a.origin, undefined)
})

test('makeEntity normalizes qq to string|null and defaults arrays', () => {
  const e = makeEntity({ qq: 123 })
  assert.equal(e.qq, '123')
  assert.deepEqual(e.aliases, [])
  assert.deepEqual(e.facts, [])
  const e2 = makeEntity({})
  assert.equal(e2.qq, null)
})

test('factShortId returns 8-char sha256 prefix and is stable for same text', () => {
  const id = factShortId('在上海工作')
  assert.equal(id.length, 8)
  assert.match(id, /^[0-9a-f]{8}$/)
  assert.equal(id, factShortId('在上海工作')) // 稳定：同文本恒定
  assert.equal(id, createHash('sha256').update('在上海工作').digest('hex').slice(0, 8))
})

test('factShortId differs for different text and handles empty/nullish', () => {
  assert.notEqual(factShortId('A'), factShortId('B'))
  assert.equal(factShortId(''), createHash('sha256').update('').digest('hex').slice(0, 8))
  assert.equal(factShortId(undefined), factShortId('')) // nullish -> '' 处理一致
  assert.equal(factShortId(null), factShortId(''))
})

test('slimEntityDoc strips legacy/transient fields from loaded data', () => {
  const dirty = { '1': { qq: '1', canonicalName: 'A', aliases: [], facts: [
    { text: 't', authority: 'self', confidence: 0.7, at: 1, tags: [], refs: [], relevance: 0.9, score: 0.5, sourceMessageIds: ['z'] }
  ], updatedAt: 1, relationshipScore: 0.6 } }
  const clean = slimEntityDoc(dirty)
  assert.equal(clean['1'].relationshipScore, undefined)
  assert.equal(clean['1'].facts[0].relevance, undefined)
  assert.equal(clean['1'].facts[0].sourceMessageIds, undefined)
})
