// tests/memory/redisStore.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFakeRedis } from './helpers/fakeRedis.js'
import { RedisStore } from '../../domains/memory/engine/redisStore.js'

test('entities round-trip + slimming on read', async () => {
  const redis = createFakeRedis()
  const store = new RedisStore({ redis })
  await store.saveEntities('g1', { '1': { qq: '1', canonicalName: 'A', aliases: [], facts: [], updatedAt: 5 } })
  const loaded = await store.getEntities('g1')
  assert.equal(loaded['1'].canonicalName, 'A')
})

test('missing docs return empty defaults', async () => {
  const store = new RedisStore({ redis: createFakeRedis() })
  assert.deepEqual(await store.getEntities('gX'), {})
  assert.deepEqual(await store.getAlias('gX'), {})
  assert.deepEqual(await store.getFacts('gX'), [])
  const meta = await store.getMeta('gX')
  assert.equal(meta.disabled, false)
  assert.equal(meta.failureCount, 0)
})

test('clearGroup deletes all four docs', async () => {
  const redis = createFakeRedis()
  const store = new RedisStore({ redis })
  await store.saveEntities('g1', { a: { qq: 'a', aliases: [], facts: [] } })
  await store.saveAlias('g1', { x: { qq: 'a', authority: 'self', confidence: 1, at: 0 } })
  await store.saveFacts('g1', [{ text: 't', authority: 'self', confidence: 1, at: 0, tags: [], refs: [] }])
  await store.saveMeta('g1', { disabled: true })
  const n = await store.clearGroup('g1')
  assert.ok(n >= 1)
  assert.deepEqual(await store.getEntities('g1'), {})
  assert.deepEqual(await store.getAlias('g1'), {})
})
