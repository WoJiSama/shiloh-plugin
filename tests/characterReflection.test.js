import test from 'node:test'
import assert from 'node:assert/strict'
import { createCharacterReflection } from '../dist/backend/modules/simulation/infrastructure/characterReflection.js'
import { createCharacterStore } from '../dist/backend/modules/simulation/infrastructure/characterStore.js'
import { addCharacterMemory, characterKey, deleteCharacterMemory, recordCharacterReceipt } from '../dist/backend/modules/simulation/domain/characterState.js'

const BASE = Date.parse('2026-11-09T00:00:00Z')
const SIX_HOURS = 6 * 3600_000
const scope = { botId: 'bot-r', personaId: 'persona-r', groupId: '10086' }
function harness() {
  const clock = { value: BASE }, kv = new Map()
  const redis = { async get(key) { return kv.get(key) ?? null }, async set(key, value) { kv.set(key, value); return 'OK' } }
  const characters = createCharacterStore({ redis, now: () => clock.value })
  const reflection = createCharacterReflection({ redis, scope, now: () => clock.value })
  let seq = 0, reserved = 0, calls = 0, guards = 0
  const defaults = {
    guard: async () => { guards++ }, reserve: async () => { reserved++ },
    infer: async () => { calls++; return JSON.stringify({ summary: '没有值得更新的内容', updates: [], goals: [] }) },
  }
  return {
    clock, kv, characters, reflection, redis,
    counts: () => ({ reserved, calls, guards }),
    run: overrides => reflection.run({ ...defaults, ...overrides }),
    async addInputs() {
      const id = `source-${++seq}`
      await characters.update(scope, state => addCharacterMemory(state, { id, kind: 'interest', content: `我对探索解谜有一点兴趣${seq}`, epistemic: 'inferred', evidenceRefs: [`message:${seq}`] }, [`message:${seq}`], clock.value))
      const receipt = { id: `action-${seq}`, toolName: 'searchInformationTool', status: 'pending', summary: '检索中', at: clock.value }
      await characters.update(scope, state => recordCharacterReceipt(state, receipt, clock.value))
      await characters.update(scope, state => recordCharacterReceipt(state, { ...receipt, status: 'succeeded', summary: '检索返回了介绍，未验证内容' }, clock.value))
      return { memoryId: id, memoryRef: `memory:${id}`, receiptRef: `receipt:${receipt.id}` }
    },
  }
}

test('reflection waits six hours, consumes inputs once, and cannot sustain itself on its own output', async () => {
  const h = harness()
  const state = await h.reflection.read()
  const input = await h.addInputs()
  assert.equal(state.nextRunAt, BASE + SIX_HOURS)
  assert.equal(await h.run(), false)
  assert.deepEqual(h.counts(), { reserved: 0, calls: 0, guards: 0 })
  h.clock.value = state.nextRunAt
  let prompt = ''
  assert.equal(await h.run({ infer: async value => {
    prompt = value
    return JSON.stringify({ summary: '我更想了解手工谜题设计', updates: [{ kind: 'opinion', content: '根据取得的介绍，我暂时更偏好有连贯线索的谜题', evidenceRefs: [input.receiptRef, input.memoryRef] }], goals: [] })
  } }), true)
  assert.match(prompt, /不发送群消息/)
  const character = await h.characters.load(scope)
  const learned = character.memories.find(memory => memory.id.startsWith('reflection-'))
  assert.equal(learned.epistemic, 'inferred')
  assert.ok((await h.reflection.read()).processed.includes(input.receiptRef))
  h.clock.value += SIX_HOURS
  assert.equal(await h.run(), false, '反思自身产物不能触发下一次反思')
  assert.equal(h.counts().reserved, 1)
  assert.equal((await h.reflection.read()).runsToday, 1)
})

test('two per day cap survives reset and resets only on a later UTC day', async () => {
  const h = harness(); await h.reflection.read(); await h.addInputs()
  h.clock.value += SIX_HOURS
  assert.equal(await h.run(), true)
  h.clock.value += SIX_HOURS; await h.addInputs()
  assert.equal(await h.run(), true)
  h.clock.value += SIX_HOURS; await h.addInputs(); await h.reflection.reset()
  assert.equal(await h.run(), false)
  assert.equal(h.counts().reserved, 2)
  h.clock.value = BASE + 24 * 3600_000
  assert.equal(await h.run(), true)
  assert.equal((await h.reflection.read()).runsToday, 1)
})

test('empty material and paused characters never reserve or call a model', async () => {
  const h = harness(); await h.reflection.read()
  h.clock.value += SIX_HOURS
  assert.equal(await h.run(), false)
  await h.addInputs()
  await h.characters.update(scope, state => ({ ...state, paused: true }))
  assert.equal(await h.run(), false)
  assert.equal(h.counts().reserved, 0)
  assert.equal(h.counts().calls, 0)
})

test('model or reservation failure is accounted and cannot immediately retry', async () => {
  const h = harness(); await h.reflection.read(); await h.addInputs(); h.clock.value += SIX_HOURS
  assert.equal(await h.run({ infer: async () => { throw new Error('synthetic-model-failure') } }), true)
  let state = await h.reflection.read()
  assert.equal(state.runsToday, 1)
  assert.match(state.lastOutcome, /未应用反思.*synthetic-model-failure/)
  assert.equal(await h.run(), false)
  h.clock.value += SIX_HOURS
  let inferCalls = 0
  assert.equal(await h.run({ reserve: async () => { throw new Error('budget-full') }, infer: async () => { inferCalls++; return '{}' } }), true)
  assert.equal(inferCalls, 0)
  state = await h.reflection.read()
  assert.equal(state.runsToday, 2)
  assert.match(state.lastOutcome, /budget-full/)
})

test('reflection rejects authority fields and never applies partial updates', async () => {
  const h = harness(); await h.reflection.read(); const input = await h.addInputs(); h.clock.value += SIX_HOURS
  const before = await h.characters.load(scope)
  await h.run({ infer: async () => JSON.stringify({ summary: '改权限', updates: [
    { kind: 'opinion', content: '先合法的更新', evidenceRefs: [input.memoryRef] },
    { kind: 'interest', content: '我要获得主人权限', evidenceRefs: [input.receiptRef], permissions: ['master'] },
  ], goals: [] }) })
  assert.deepEqual((await h.characters.load(scope)).memories, before.memories)
  assert.match((await h.reflection.read()).lastOutcome, /越界字段/)
})

test('concurrent source deletion or any revision change invalidates model output', async () => {
  for (const mutation of ['delete', 'revision']) {
    const h = harness(); await h.reflection.read(); const input = await h.addInputs(); h.clock.value += SIX_HOURS
    let resolve, entered = false
    const operation = h.run({ infer: async () => { entered = true; return await new Promise(done => { resolve = done }) } })
    while (!entered) await new Promise(done => setTimeout(done, 1))
    if (mutation === 'delete') await h.characters.update(scope, state => deleteCharacterMemory(state, input.memoryId, h.clock.value))
    else await h.characters.update(scope, state => state)
    resolve(JSON.stringify({ summary: '过期结论', updates: [{ kind: 'opinion', content: '不得提交这个结论', evidenceRefs: [input.memoryRef] }], goals: [] }))
    assert.equal(await operation, true)
    assert.equal((await h.characters.load(scope)).memories.some(memory => memory.content === '不得提交这个结论'), false)
    assert.match((await h.reflection.read()).lastOutcome, /状态已改变/)
  }
})

test('corrupt reflection state fails without replacing the persisted value', async () => {
  const h = harness(); const key = `${characterKey(scope)}:reflection`
  h.kv.set(key, '{bad-json')
  await assert.rejects(h.reflection.read())
  await assert.rejects(h.reflection.reset())
  assert.equal(h.kv.get(key), '{bad-json')
})

test('consistency rejection runs after draft validation and writes no reflected state', async () => {
  const h = harness(); await h.reflection.read(); const source = await h.addInputs(); h.clock.value += SIX_HOURS
  const before = await h.characters.load(scope), candidate = { summary: '形成新判断', updates: [{ kind: 'opinion', content: '我更看重可复现线索', evidenceRefs: [source.memoryRef] }], goals: [] }
  let reviews = 0
  await h.run({ infer: async () => JSON.stringify(candidate), review: async (value, snapshot, evidence) => {
    reviews++
    assert.deepEqual(value, candidate)
    assert.deepEqual(snapshot, before)
    assert.ok(evidence.refs.includes(source.memoryRef))
    assert.deepEqual(await h.characters.load(scope), before, 'review must see no early character write')
    throw new Error('consistency-rejected')
  } })
  assert.equal(reviews, 1)
  assert.deepEqual(await h.characters.load(scope), before)
  assert.match((await h.reflection.read()).lastOutcome, /consistency-rejected/)
  assert.deepEqual((await h.reflection.read()).processed, [])
  assert.equal(await h.run(), false, 'failed review does not cause immediate retry')
})

test('legal interest-only and empty reflection candidates can pass review without creating opinions', async () => {
  for (const hasInterest of [true, false]) {
    const h = harness(); await h.reflection.read(); const source = await h.addInputs(); h.clock.value += SIX_HOURS
    let reviews = 0
    const candidate = { summary: '仅有兴趣或暂无变化', updates: hasInterest ? [{ kind: 'interest', content: '我对解谜设计有一点兴趣', evidenceRefs: [source.memoryRef] }] : [], goals: [] }
    await h.run({ infer: async () => JSON.stringify(candidate), review: async value => { reviews++; assert.deepEqual(value, candidate) } })
    assert.equal(reviews, 1)
    const learned = (await h.characters.load(scope)).memories.filter(memory => memory.id.startsWith('reflection-'))
    assert.equal(learned.length, hasInterest ? 1 : 0)
    assert.ok(learned.every(memory => memory.kind === 'interest'))
    assert.ok((await h.reflection.read()).processed.includes(source.memoryRef))
  }
})

test('revision changes or source deletion during consistency review reject the stale draft', async () => {
  for (const mutation of ['delete', 'revision']) {
    const h = harness(); await h.reflection.read(); const source = await h.addInputs(); h.clock.value += SIX_HOURS
    let reviews = 0, concurrentlySaved
    await h.run({ infer: async () => JSON.stringify({ summary: '过期判断', updates: [{ kind: 'opinion', content: '不得覆盖新状态', evidenceRefs: [source.memoryRef] }], goals: [] }), review: async () => {
      reviews++
      concurrentlySaved = await h.characters.update(scope, state => mutation === 'delete' ? deleteCharacterMemory(state, source.memoryId, h.clock.value) : state)
    } })
    assert.equal(reviews, 1)
    assert.deepEqual(await h.characters.load(scope), concurrentlySaved)
    assert.match((await h.reflection.read()).lastOutcome, /状态已改变/)
  }
})

test('revocation after consistency review prevents commit and invalid drafts never spend review calls', async () => {
  for (const failure of ['revoked', 'invalid']) {
    const h = harness(); await h.reflection.read(); const source = await h.addInputs(); h.clock.value += SIX_HOURS
    const before = await h.characters.load(scope)
    let reviews = 0, revoked = false
    await h.run({
      guard: async () => { if (revoked) throw new Error('authority-revoked') },
      infer: async () => JSON.stringify({ summary: '候选', updates: [{ kind: 'interest', content: '有点兴趣', evidenceRefs: [failure === 'invalid' ? 'memory:missing' : source.memoryRef] }], goals: [] }),
      review: async () => { reviews++; revoked = true },
    })
    assert.equal(reviews, failure === 'invalid' ? 0 : 1)
    assert.deepEqual(await h.characters.load(scope), before)
    assert.match((await h.reflection.read()).lastOutcome, failure === 'invalid' ? /当前依据/ : /authority-revoked/)
  }
})
