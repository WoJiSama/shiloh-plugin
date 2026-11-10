import test from 'node:test'
import assert from 'node:assert/strict'
import { createCharacterStore } from '../dist/backend/modules/simulation/infrastructure/characterStore.js'
import { addCharacterMemory, characterKey, createEmptyCharacterState, setCharacterDecision } from '../dist/backend/modules/simulation/domain/characterState.js'

const SCOPE = { botId: 'robot-a', personaId: 'persona-a', groupId: 'group-a' }
const AT = 1794200000000
const setDecision = state => setCharacterDecision(state, { kind: 'deferred', reason: '等资料', at: AT })

function memoryRedis({ atomic = false, getDelay = false } = {}) {
  const kv = new Map()
  const calls = { get: [], set: [], eval: [] }
  const control = { failRead: false, failWrite: false, beforeCommit: null }
  const redis = {
    async get(key) {
      calls.get.push(key)
      if (control.failRead) throw new Error('read unavailable')
      // This asynchronous boundary exposes lost updates if stores do not share their queue.
      if (getDelay) await new Promise(resolve => setTimeout(resolve, 1))
      return kv.get(key) ?? null
    },
    async set(key, value, options) {
      calls.set.push({ key, value, options })
      if (control.failWrite && !key.endsWith(':lock')) throw new Error('write unavailable')
      if (options?.NX && kv.has(key)) return null
      kv.set(key, value)
      return 'OK'
    },
    async del(...keys) {
      let deleted = 0
      for (const key of keys) if (kv.delete(key)) deleted += 1
      return deleted
    },
  }
  if (atomic) redis.eval = async (script, options) => {
    calls.eval.push({ script, ...options })
    const [lock, key] = options.keys
    const [token, value] = options.arguments
    if (key) {
      control.beforeCommit?.({ lock, key, token })
      if (kv.get(lock) !== token) return 0
      if (control.failWrite) throw new Error('atomic write unavailable')
      kv.set(key, value)
      kv.delete(lock)
      return 1
    }
    if (kv.get(lock) !== token) return 0
    kv.delete(lock)
    return 1
  }
  return { redis, kv, calls, control }
}

test('角色存储损坏读取不能降级为空状态，也不能覆盖原数据', async () => {
  for (const corrupt of ['{broken-json', JSON.stringify({ schemaVersion: 999 }), JSON.stringify(createEmptyCharacterState({ ...SCOPE, botId: 'other' }))]) {
    const fake = memoryRedis()
    const key = characterKey(SCOPE)
    fake.kv.set(key, corrupt)
    const store = createCharacterStore({ redis: fake.redis })
    await assert.rejects(store.load(SCOPE))
    let mutated = false
    await assert.rejects(store.update(SCOPE, state => { mutated = true; return setDecision(state) }))
    assert.equal(mutated, false)
    assert.equal(fake.kv.get(key), corrupt)
    assert.equal(fake.calls.set.length, 0)
  }
})

test('角色存储读失败不执行变更，写失败不返回成功并允许后续重试', async () => {
  const fake = memoryRedis()
  const store = createCharacterStore({ redis: fake.redis })
  fake.control.failRead = true
  await assert.rejects(store.load(SCOPE), /read unavailable/)
  let mutated = false
  await assert.rejects(store.update(SCOPE, state => { mutated = true; return state }), /read unavailable/)
  assert.equal(mutated, false)
  fake.control.failRead = false
  fake.control.failWrite = true
  await assert.rejects(store.update(SCOPE, setDecision), /write unavailable/)
  assert.equal(fake.kv.has(characterKey(SCOPE)), false)
  fake.control.failWrite = false
  const saved = await store.update(SCOPE, setDecision)
  assert.equal(saved.revision, 1)
  assert.equal((await store.load(SCOPE)).decision.reason, '等资料')
})

test('同一个Redis上的两个角色store共享串行队列，不丢失并发更新与revision', async () => {
  const fake = memoryRedis({ getDelay: true })
  const a = createCharacterStore({ redis: fake.redis })
  const b = createCharacterStore({ redis: fake.redis })
  await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? a : b).update(SCOPE, state => addCharacterMemory(state, {
    id: `memory-${index}`, kind: 'opinion', content: `暂时判断 ${index}`, epistemic: 'inferred', evidenceRefs: ['message:1'],
  }, ['message:1'], AT))))
  const state = await a.load(SCOPE)
  assert.equal(state.revision, 12)
  assert.equal(state.memories.length, 12)
  assert.equal(new Set(state.memories.map(memory => memory.id)).size, 12)
})

test('机器人、人设和群的三个scope分量各自隔离，不受分隔符碰撞影响', async () => {
  const fake = memoryRedis()
  const store = createCharacterStore({ redis: fake.redis })
  const scopes = [
    SCOPE,
    { ...SCOPE, botId: 'robot-b' },
    { ...SCOPE, personaId: 'persona-b' },
    { ...SCOPE, groupId: 'group-b' },
    { ...SCOPE, botId: 'a:b', personaId: 'c' },
    { ...SCOPE, botId: 'a', personaId: 'b:c' },
  ]
  assert.equal(new Set(scopes.map(characterKey)).size, scopes.length)
  for (const [index, scope] of scopes.entries()) {
    await store.update(scope, state => setCharacterDecision(state, { kind: 'engage', reason: `scope-${index}`, at: AT }))
  }
  for (const [index, scope] of scopes.entries()) {
    const state = await store.load(scope)
    assert.deepEqual(state.scope, scope)
    assert.equal(state.revision, 1)
    assert.equal(state.decision.reason, `scope-${index}`)
  }
})

test('Redis原子提交使用带token的NX租约，提交后释放自己的锁', async () => {
  const fake = memoryRedis({ atomic: true })
  const store = createCharacterStore({ redis: fake.redis })
  const saved = await store.update(SCOPE, setDecision)
  assert.equal(saved.revision, 1)
  assert.equal((await store.load(SCOPE)).revision, 1)
  const lock = `${characterKey(SCOPE)}:lock`
  const acquisition = fake.calls.set.find(call => call.key === lock)
  assert.deepEqual(acquisition.options, { NX: true, PX: 10_000 })
  assert.ok(acquisition.value)
  assert.equal(fake.kv.has(lock), false)
  assert.equal(fake.calls.eval[0].arguments[0], acquisition.value)
})

test('Redis租约被占用超时不读取或提交角色状态，也不删除其他持有者的锁', async t => {
  const fake = memoryRedis({ atomic: true })
  const key = characterKey(SCOPE)
  const lock = `${key}:lock`
  fake.kv.set(lock, 'another-owner')
  const store = createCharacterStore({ redis: fake.redis })
  let calls = 0
  // Advance only the lease wait deadline; avoid a 2.5 second test pause.
  t.mock.method(Date, 'now', () => AT + (calls++ === 0 ? 0 : 3000))
  await assert.rejects(store.update(SCOPE, setDecision), /正忙/)
  assert.equal(fake.kv.get(lock), 'another-owner')
  assert.equal(fake.kv.has(key), false)
  assert.deepEqual(fake.calls.get, [])
  assert.deepEqual(fake.calls.eval, [])
})

test('Redis租约失效时不提交旧修改，且清理不会删除新的持有者', async () => {
  const fake = memoryRedis({ atomic: true })
  const key = characterKey(SCOPE)
  const initial = JSON.stringify(createEmptyCharacterState(SCOPE))
  fake.kv.set(key, initial)
  fake.control.beforeCommit = ({ lock }) => { fake.kv.set(lock, 'replacement-owner') }
  const store = createCharacterStore({ redis: fake.redis })
  await assert.rejects(store.update(SCOPE, setDecision), /锁已失效/)
  assert.equal(fake.kv.get(key), initial)
  assert.equal(fake.kv.get(`${key}:lock`), 'replacement-owner')
  assert.equal(fake.calls.eval.length, 2, '提交失败后只尝试token校验的释放')
})

test('Redis原子写失败保持原版本并释放租约，队列仍能继续处理后续修改', async () => {
  const fake = memoryRedis({ atomic: true })
  const store = createCharacterStore({ redis: fake.redis })
  const key = characterKey(SCOPE)
  fake.control.failWrite = true
  await assert.rejects(store.update(SCOPE, setDecision), /atomic write unavailable/)
  assert.equal(fake.kv.has(key), false)
  assert.equal(fake.kv.has(`${key}:lock`), false)
  fake.control.failWrite = false
  const saved = await store.update(SCOPE, setDecision)
  assert.equal(saved.revision, 1)
})
