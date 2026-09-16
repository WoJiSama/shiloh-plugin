// tests/memory/aliasRegistry.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { upsertAlias, resolveAlias } from '../../domains/memory/engine/aliasRegistry.js'

test('upsert new alias adds entry', () => {
  const doc = {}
  const out = upsertAlias(doc, { text: 'Maela', qq: '3188163302', authority: 'teaching', confidence: 0.9, by: ['925640859'], at: 10 })
  assert.equal(out.changed, true)
  assert.equal(out.doc['maela'].qq, '3188163302')
})

test('self-statement beats mention for same alias -> different QQ', () => {
  let doc = upsertAlias({}, { text: '希洛', qq: '3188163302', authority: 'mention', confidence: 0.8, by: ['x'], at: 5 }).doc
  const out = upsertAlias(doc, { text: '希洛', qq: '925640859', authority: 'self', confidence: 0.9, by: ['925640859'], at: 6 })
  assert.equal(out.changed, true)
  assert.equal(out.doc['希洛'].qq, '925640859') // self wins
})

test('weaker incoming for same alias->different QQ is rejected', () => {
  let doc = upsertAlias({}, { text: '希洛', qq: '925640859', authority: 'self', confidence: 0.9, by: ['925640859'], at: 6 }).doc
  const out = upsertAlias(doc, { text: '希洛', qq: '3188163302', authority: 'mention', confidence: 0.8, by: ['x'], at: 99 })
  assert.equal(out.changed, false)
  assert.equal(out.doc['希洛'].qq, '925640859')
})

test('same QQ re-statement merges supporters and bumps recency', () => {
  let doc = upsertAlias({}, { text: 'maela', qq: '1', authority: 'teaching', confidence: 0.9, by: ['a'], at: 1 }).doc
  const out = upsertAlias(doc, { text: 'maela', qq: '1', authority: 'teaching', confidence: 0.9, by: ['b'], at: 2 })
  assert.deepEqual(out.doc['maela'].by.sort(), ['a','b'])
  assert.equal(out.doc['maela'].at, 2)
})

test('resolveAlias is case/punct-insensitive', () => {
  const doc = upsertAlias({}, { text: 'Maela', qq: '1', authority: 'self', confidence: 1, by: [], at: 0 }).doc
  assert.equal(resolveAlias(doc, ' maela! ')?.qq, '1')
  assert.equal(resolveAlias(doc, 'unknown'), null)
})
