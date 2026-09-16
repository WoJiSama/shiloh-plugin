// tests/memory/stats.test.js
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { memStats } from '../../domains/memory/engine/stats.js'

beforeEach(() => memStats.reset())

test('inc accumulates counters with default and explicit n', () => {
  memStats.inc('embed.hit')
  memStats.inc('embed.hit')
  memStats.inc('embed.miss', 3)
  const snap = memStats.snapshot()
  assert.equal(snap.counters['embed.hit'], 2)
  assert.equal(snap.counters['embed.miss'], 3)
})

test('inc ignores empty key and non-finite n', () => {
  memStats.inc('', 5)
  memStats.inc('llm.extract.call', NaN)
  memStats.inc('llm.extract.call', 'x')
  const snap = memStats.snapshot()
  assert.equal(snap.counters[''], undefined)
  assert.equal(snap.counters['llm.extract.call'], undefined)
})

test('observe records count, sumMs and computes avgMs', () => {
  memStats.observe('embed.ms', 100)
  memStats.observe('embed.ms', 300)
  const snap = memStats.snapshot()
  assert.equal(snap.timings['embed.ms'].count, 2)
  assert.equal(snap.timings['embed.ms'].sumMs, 400)
  assert.equal(snap.timings['embed.ms'].avgMs, 200)
})

test('observe ignores non-finite ms', () => {
  memStats.observe('llm.extract.ms', NaN)
  memStats.observe('llm.extract.ms', 'slow')
  const snap = memStats.snapshot()
  assert.equal(snap.timings['llm.extract.ms'], undefined)
})

test('snapshot is an immutable copy: mutating it does not affect state', () => {
  memStats.inc('extract.user.flushed')
  const snap = memStats.snapshot()
  snap.counters['extract.user.flushed'] = 999
  snap.counters.injected = 1
  const fresh = memStats.snapshot()
  assert.equal(fresh.counters['extract.user.flushed'], 1)
  assert.equal(fresh.counters.injected, undefined)
})

test('snapshot returns empty structures after reset', () => {
  memStats.inc('extract.group.run')
  memStats.observe('llm.reflect.ms', 50)
  memStats.reset()
  const snap = memStats.snapshot()
  assert.deepEqual(snap.counters, {})
  assert.deepEqual(snap.timings, {})
})

test('avgMs is 0 when a timing has no observations after reset path', () => {
  memStats.observe('llm.reflect.ms', 0)
  const snap = memStats.snapshot()
  assert.equal(snap.timings['llm.reflect.ms'].count, 1)
  assert.equal(snap.timings['llm.reflect.ms'].avgMs, 0)
})
