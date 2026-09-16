// tests/memory/conflictResolver.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveClaim } from '../../domains/memory/engine/conflictResolver.js'

const A = { authority: 'mention', at: 100, by: ['x'] }   // 路人指认
const B = { authority: 'self', at: 50, by: ['y'] }        // 本人自述（更旧但更权威）

test('higher authority wins regardless of recency', () => {
  const r = resolveClaim(A, B)
  assert.equal(r.winner, B)
  assert.equal(r.changed, true)
})

test('same authority -> most recent wins', () => {
  const older = { authority: 'teaching', at: 10, by: ['a'] }
  const newer = { authority: 'teaching', at: 20, by: ['b'] }
  assert.equal(resolveClaim(older, newer).winner, newer)
})

test('same authority same time -> more supporters (by) wins', () => {
  const few = { authority: 'mention', at: 5, by: ['a'] }
  const many = { authority: 'mention', at: 5, by: ['a','b'] }
  assert.equal(resolveClaim(few, many).winner, many)
})

test('incoming equal-or-weaker than existing keeps existing, changed=false', () => {
  const existing = { authority: 'self', at: 100, by: ['a'] }
  const incoming = { authority: 'mention', at: 200, by: ['b'] }
  const r = resolveClaim(existing, incoming)
  assert.equal(r.winner, existing)
  assert.equal(r.changed, false)
})

test('no existing -> incoming wins, changed=true', () => {
  const incoming = { authority: 'mention', at: 1, by: [] }
  const r = resolveClaim(null, incoming)
  assert.equal(r.winner, incoming)
  assert.equal(r.changed, true)
})
