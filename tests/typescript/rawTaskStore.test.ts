import assert from 'node:assert/strict'
import test from 'node:test'
import { createRawTaskStore } from '../../src/adapters/rawTaskStore.js'
import type { TaskWriteOptions } from '../../src/contracts/taskStore.js'

test('memory fallback preserves shared map, NX and delete receipts', async () => {
  const memory = new Map<string, string>()
  const store = createRawTaskStore({ redis: () => undefined, memory })
  assert.equal(await store.getRaw('missing'), null)
  assert.equal(await store.setRaw('a', 'one', { NX: true, EX: 60 }), 'OK')
  assert.equal(memory.get('a'), 'one')
  assert.equal(await store.setRaw('a', 'two', { NX: true }), null)
  assert.equal(await store.getRaw('a'), 'one')
  assert.equal(await store.setRaw('a', 'three'), 'OK')
  assert.equal(await store.delRaw('a'), 1)
  assert.equal(await store.delRaw('a'), 0)
})

test('redis method receiver, options identity and raw receipts are preserved', async () => {
  const options = { NX: true, PX: 5000 }
  const client = {
    marker: 'owned',
    get(key: string) { assert.equal(this.marker, 'owned'); return key },
    set(key: string, value: string, supplied: TaskWriteOptions) {
      assert.equal(this.marker, 'owned'); assert.equal(key, 'k'); assert.equal(value, 'v')
      assert.equal(supplied, options); return null
    },
    del() { assert.equal(this.marker, 'owned'); return 2 }
  }
  const store = createRawTaskStore({ redis: () => client, memory: new Map() })
  assert.equal(await store.getRaw('k'), 'k')
  assert.equal(await store.setRaw('k', 'v', options), null)
  assert.equal(await store.delRaw('k'), 2)
})

test('partial redis clients fall back per capability and can be replaced live', async () => {
  const memory = new Map<string, string>()
  let client: unknown = { get: () => 'remote' }
  const store = createRawTaskStore({ redis: () => client, memory })
  assert.equal(await store.setRaw('k', 'local', { EX: 90 }), 'OK')
  assert.equal(await store.getRaw('k'), 'remote')
  client = undefined
  assert.equal(await store.getRaw('k'), 'local')
  client = { del: () => { throw new Error('unavailable') } }
  await assert.rejects(store.delRaw('k'), /unavailable/)
  assert.equal(memory.get('k'), 'local')
})
