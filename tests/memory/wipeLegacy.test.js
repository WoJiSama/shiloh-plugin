// tests/memory/wipeLegacy.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFakeRedis } from './helpers/fakeRedis.js'
import { wipeLegacyMemory } from '../../scripts/wipe-legacy-memory.js'

test('dryRun reports count without deleting; real run deletes only legacy keys', async () => {
  const r = createFakeRedis()
  await r.set('ytbot:memory:v2:group:1:meta', '{}')
  await r.set('ytbot:memory:981:1:meta', '{}')
  await r.set('ytbot:mem:g:1:entities', '{}') // 新键，不该删
  const dry = await wipeLegacyMemory(r, { dryRun: true })
  assert.equal(dry.wouldDelete, 2)
  assert.equal(await r.get('ytbot:memory:v2:group:1:meta'), '{}')
  const real = await wipeLegacyMemory(r, { dryRun: false })
  assert.equal(real.deleted, 2)
  assert.equal(await r.get('ytbot:mem:g:1:entities'), '{}') // 新键保留
})

test('legacy wipe handles Redis batch iterators and KEYS fallback', async () => {
  const removed = []
  const batches = {
    async *scanIterator(options) {
      assert.deepEqual(options, { MATCH: 'ytbot:memory:*', COUNT: 200 })
      yield ['ytbot:memory:1', 'ytbot:memory:2']
      yield 'ytbot:memory:3'
    },
    async del(key) { removed.push(key) }
  }
  assert.deepEqual(await wipeLegacyMemory(batches), { wouldDelete: 3, sample: ['ytbot:memory:1', 'ytbot:memory:2', 'ytbot:memory:3'] })
  assert.deepEqual(removed, [])
  assert.deepEqual(await wipeLegacyMemory({
    async keys(pattern) { assert.equal(pattern, 'ytbot:memory:*'); return ['ytbot:memory:1'] },
    async del(key) { removed.push(key) }
  }, { dryRun: false }), { deleted: 1 })
  assert.deepEqual(removed, ['ytbot:memory:1'])
})
