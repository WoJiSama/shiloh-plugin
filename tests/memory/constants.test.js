// tests/memory/constants.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AUTHORITY_RANK, ROUTES, normalizeAlias, clamp, compactText } from '../../domains/memory/engine/constants.js'

test('authority rank ordering config>self>teaching>mention', () => {
  assert.ok(AUTHORITY_RANK.config > AUTHORITY_RANK.self)
  assert.ok(AUTHORITY_RANK.self > AUTHORITY_RANK.teaching)
  assert.ok(AUTHORITY_RANK.teaching > AUTHORITY_RANK.mention)
})

test('unknown authority ranks lowest (0)', () => {
  assert.equal(AUTHORITY_RANK.bogus ?? 0, 0)
})

test('ROUTES contains the five routes', () => {
  assert.deepEqual([...ROUTES].sort(), ['explicit_teaching','group_consensus','ordinary_chat','self_statement','user_preference'].sort())
})

test('normalizeAlias lowercases and strips punctuation/space', () => {
  assert.equal(normalizeAlias('  Maela! '), 'maela')
  assert.equal(normalizeAlias('希洛（QQ）'), '希洛qq')
})

test('clamp bounds to [0,1] by default', () => {
  assert.equal(clamp(2), 1)
  assert.equal(clamp(-1), 0)
  assert.equal(clamp('x', 0, 1), 0)
})

test('compactText collapses whitespace and truncates', () => {
  assert.equal(compactText('a   b\n c'), 'a b c')
  assert.equal(compactText('abcdef', 3), 'abc')
})
