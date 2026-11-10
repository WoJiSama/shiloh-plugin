import assert from 'node:assert/strict'
import test from 'node:test'
import { createSimSessionStore } from '../dist/backend/modules/simulation/infrastructure/simSessionStore.js'
import { createDefaultSimSession } from '../dist/backend/modules/simulation/domain/simConfig.js'

const GROUP = '10086'
const BASE = Date.parse('2026-11-09T00:00:00Z')
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function fixture({ failFirst = false } = {}) {
  const kv = new Map(), entered = deferred(), held = deferred(), writes = []
  const redis = {
    async get(key) { return kv.get(key) ?? null },
    async set(key, value) {
      writes.push(JSON.parse(value))
      if (writes.length === 1) {
        entered.resolve()
        await held.promise
        if (failFirst) throw new Error('isolated Redis write failed')
      }
      kv.set(key, value)
      return 'OK'
    },
    async del(key) { kv.delete(key) },
  }
  return { entered, held, writes, store: createSimSessionStore({ redis, now: () => BASE }), other: createSimSessionStore({ redis, now: () => BASE }) }
}
function state(seq) { const value = createDefaultSimSession(BASE); value.seq = seq; return value }

test('session stores serialize writes across instances, capture snapshots, and keep loads behind queued writes', async () => {
  const h = fixture()
  const before = state(1), after = state(2)
  const first = h.store.save(GROUP, before)
  await h.entered.promise
  const second = h.other.save(GROUP, after)
  before.seq = 91; after.seq = 92
  let loaded = false
  const reading = h.store.load(GROUP).then(value => { loaded = true; return value })
  await Promise.resolve()
  assert.equal(loaded, false)
  assert.equal(h.writes.length, 1, 'the later Redis SET must not overtake the held SET')
  h.held.resolve()
  await Promise.all([first, second])

  assert.equal((await reading).seq, 2)
  assert.deepEqual(h.writes.map(value => value.seq), [1, 2])
})

test('a failed session save rejects its caller but does not poison queued saves or future loads', async () => {
  const h = fixture({ failFirst: true })
  const first = h.store.save(GROUP, state(1))
  const failed = assert.rejects(first, /isolated Redis write failed/)
  await h.entered.promise
  const second = h.other.save(GROUP, state(2))
  const reading = h.store.load(GROUP)
  h.held.resolve()
  await Promise.all([failed, second])

  assert.equal((await reading).seq, 2)
  await h.store.save(GROUP, state(3))
  assert.equal((await h.other.load(GROUP)).seq, 3)
})

test('session reset waits for earlier saves and loads observe the reset state', async () => {
  const h = fixture()
  const first = h.store.save(GROUP, state(7))
  await h.entered.promise
  const resetting = h.other.reset(GROUP, ['new-keyword'])
  const reading = h.store.load(GROUP)
  assert.equal(h.writes.length, 1)
  h.held.resolve()
  await Promise.all([first, resetting])

  const reset = await reading
  assert.equal(reset.seq, 0)
  assert.equal(reset.bootstrapSent, true)
  assert.deepEqual(reset.wakeConfig.triggers.keywords, ['new-keyword'])
  assert.deepEqual(h.writes.map(value => value.seq), [7, 0])
})

test('independent activity revocation survives stale session saves and resets across Redis clients', async () => {
  const kv = new Map()
  const client = () => ({ get: async key => kv.get(key) ?? null, set: async (key, value) => { kv.set(key, value); return 'OK' }, del: async key => kv.delete(key) })
  const bot = createSimSessionStore({ redis: client(), now: () => BASE })
  const consoleStore = createSimSessionStore({ redis: client(), now: () => BASE })
  assert.equal(await bot.loadActivityVersion(GROUP), '')
  const stale = state(7)
  await bot.save(GROUP, stale)
  await consoleStore.invalidateActivity(GROUP)
  const first = await bot.loadActivityVersion(GROUP)
  assert.ok(first)
  await bot.save(GROUP, stale)
  await bot.reset(GROUP, [])
  assert.equal(await bot.loadActivityVersion(GROUP), first)
  await consoleStore.invalidateActivity(GROUP)
  assert.notEqual(await bot.loadActivityVersion(GROUP), first)
  assert.equal(await bot.loadActivityVersion('10087'), '')
})
