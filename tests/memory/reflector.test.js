// tests/memory/reflector.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Reflector } from '../../domains/memory/engine/reflector.js'
import { makeEntity, makeFact } from '../../domains/memory/engine/entityModel.js'
import { memStats } from '../../domains/memory/engine/stats.js'

const AI = { memoryAiConfig: { memoryAiUrl: 'u', memoryAiApikey: 'k' } }

function trackCalls(reflector, response) {
  const calls = []
  reflector._callChat = async (messages, maxTokens) => {
    calls.push({ messages, maxTokens })
    return response
  }
  return calls
}

test('canUse reflects memoryAiConfig presence', () => {
  assert.equal(new Reflector({ memoryAiConfig: null }).canUse(), false)
  assert.equal(new Reflector({ memoryAiConfig: { memoryAiUrl: 'u' } }).canUse(), false)
  assert.equal(new Reflector(AI).canUse(), true)
})

test('consolidateEntity returns changed:false and does not call LLM when unconfigured', async () => {
  const r = new Reflector({ memoryAiConfig: null })
  let called = false
  r._callChat = async () => { called = true; return '[]' }
  const entity = makeEntity({ qq: '1', facts: [makeFact({ text: '在上海', authority: 'self', confidence: 0.9 })] })
  const out = await r.consolidateEntity(entity)
  assert.equal(called, false)
  assert.equal(out.changed, false)
  assert.equal(out.facts.length, 1)
})

test('consolidateEntity merges facts, stamps origin reflection, keeps strongest authority', async () => {
  const r = new Reflector(AI)
  trackCalls(r, '[{"text":"在上海做后端开发","sources":[1,2],"tags":["职业"]}]')
  const entity = makeEntity({
    qq: '1',
    facts: [
      makeFact({ text: '在上海', authority: 'mention', confidence: 0.6, at: 100 }),
      makeFact({ text: '做后端', authority: 'self', confidence: 0.9, at: 200, refs: ['9'] })
    ]
  })
  const out = await r.consolidateEntity(entity)
  assert.equal(out.changed, true)
  assert.equal(out.facts.length, 1)
  const fact = out.facts[0]
  assert.equal(fact.text, '在上海做后端开发')
  assert.equal(fact.origin, 'reflection')
  assert.equal(fact.authority, 'self') // highest authority among merged
  assert.equal(fact.confidence, 0.9) // highest confidence among merged
  assert.equal(fact.at, 200) // latest at
  assert.ok(fact.tags.includes('职业'))
  assert.ok(fact.refs.includes('9'))
})

test('consolidateEntity never touches origin:config facts and never fabricates config authority', async () => {
  const r = new Reflector(AI)
  const calls = trackCalls(r, '[{"text":"巩固后的事实","sources":[1]}]')
  const configFact = makeFact({ text: '管理员设定', authority: 'config', confidence: 1, origin: 'config' })
  const entity = makeEntity({
    qq: '1',
    facts: [configFact, makeFact({ text: '喜欢咖啡', authority: 'self', confidence: 0.8 })]
  })
  const out = await r.consolidateEntity(entity)
  assert.equal(out.changed, true)
  // config fact survives untouched and is not sent to the LLM
  assert.ok(out.facts.some(f => f.origin === 'config' && f.text === '管理员设定'))
  const sentPrompt = calls[0].messages.map(m => m.content).join('\n')
  assert.ok(!sentPrompt.includes('管理员设定'))
  // reflection products must not claim config authority
  for (const f of out.facts.filter(f => f.origin === 'reflection')) {
    assert.notEqual(f.authority, 'config')
  }
})

test('consolidateEntity ignores superseded and config-only entities (nothing reflectable)', async () => {
  const r = new Reflector(AI)
  let called = false
  r._callChat = async () => { called = true; return '[]' }
  const entity = makeEntity({
    qq: '1',
    facts: [
      makeFact({ text: '旧的', authority: 'self', superseded: true }),
      makeFact({ text: 'config', authority: 'config', origin: 'config' })
    ]
  })
  const out = await r.consolidateEntity(entity)
  assert.equal(called, false)
  assert.equal(out.changed, false)
  assert.equal(out.facts.length, 2)
})

test('consolidateEntity degrades silently to changed:false on LLM error', async () => {
  const r = new Reflector(AI)
  r._callChat = async () => { throw new Error('boom') }
  const entity = makeEntity({ qq: '1', facts: [makeFact({ text: '在上海', authority: 'self' })] })
  const out = await r.consolidateEntity(entity)
  assert.equal(out.changed, false)
  assert.equal(out.facts.length, 1)
})

test('consolidateEntity returns changed:false when LLM yields no usable items', async () => {
  const r = new Reflector(AI)
  trackCalls(r, 'sorry I cannot')
  const entity = makeEntity({ qq: '1', facts: [makeFact({ text: '在上海', authority: 'self' })] })
  const out = await r.consolidateEntity(entity)
  assert.equal(out.changed, false)
  assert.equal(out.facts.length, 1)
})

test('reflectGroup produces insight facts with required shape', async () => {
  const r = new Reflector(AI)
  trackCalls(r, '[{"text":"群里热衷讨论咖啡","tags":["梗"]},{"text":"对新人友好"}]')
  const { insights } = await r.reflectGroup({
    groupId: 'g1',
    facts: [makeFact({ text: '群规：不要刷屏', at: 50 })],
    recentTexts: ['今天喝什么咖啡', '欢迎新人']
  })
  assert.equal(insights.length, 2)
  for (const fact of insights) {
    assert.ok(fact.tags.includes('洞察'))
    assert.equal(fact.origin, 'reflection')
    assert.equal(fact.authority, 'mention')
    assert.equal(fact.confidence, 0.6)
  }
})

test('reflectGroup caps insights at 3', async () => {
  const r = new Reflector(AI)
  trackCalls(r, '[{"text":"a"},{"text":"b"},{"text":"c"},{"text":"d"},{"text":"e"}]')
  const { insights } = await r.reflectGroup({ groupId: 'g1', facts: [], recentTexts: [] })
  assert.equal(insights.length, 3)
})

test('reflectGroup returns [] when unconfigured', async () => {
  const r = new Reflector({ memoryAiConfig: null })
  let called = false
  r._callChat = async () => { called = true; return '[]' }
  const { insights } = await r.reflectGroup({ groupId: 'g1', facts: [], recentTexts: ['hi'] })
  assert.equal(called, false)
  assert.deepEqual(insights, [])
})

test('reflectGroup degrades silently to [] on LLM error', async () => {
  const r = new Reflector(AI)
  r._callChat = async () => { throw new Error('boom') }
  const { insights } = await r.reflectGroup({ groupId: 'g1', facts: [], recentTexts: ['hi'] })
  assert.deepEqual(insights, [])
})

test('reflectGroup returns [] when LLM yields no usable items', async () => {
  const r = new Reflector(AI)
  trackCalls(r, 'no json here')
  const { insights } = await r.reflectGroup({ groupId: 'g1', facts: [], recentTexts: [] })
  assert.deepEqual(insights, [])
})

// --- _callChat: fetch 超时 + 统计打点（§0.5 / §0.3 / P1-4）---

function stubFetch(impl) {
  const original = globalThis.fetch
  globalThis.fetch = impl
  return () => { globalThis.fetch = original }
}

function stubLogger() {
  const original = globalThis.logger
  const warnings = []
  globalThis.logger = { warn: msg => warnings.push(msg) }
  return { warnings, restore: () => { globalThis.logger = original } }
}

test('_callChat passes AbortSignal.timeout and returns content on success', async () => {
  memStats.reset()
  let seenSignal
  const restore = stubFetch(async (_url, init) => {
    seenSignal = init.signal
    return { ok: true, json: async () => ({ choices: [{ message: { content: ' [{"text":"x"}] ' } }] }) }
  })
  try {
    const r = new Reflector(AI)
    const out = await r._callChat([{ role: 'user', content: 'hi' }])
    assert.equal(out, '[{"text":"x"}]')
    assert.ok(seenSignal instanceof AbortSignal, 'fetch must receive an AbortSignal')
    const snap = memStats.snapshot()
    assert.equal(snap.counters['llm.reflect.call'], 1)
    assert.ok(snap.timings['llm.reflect.ms']?.count === 1)
    assert.equal(snap.counters['llm.reflect.fail'], undefined)
  } finally {
    restore()
  }
})

test('_callChat counts fail and warns (no fact text) on non-ok response', async () => {
  memStats.reset()
  const restore = stubFetch(async () => ({ ok: false, status: 503, json: async () => ({}) }))
  const log = stubLogger()
  try {
    const r = new Reflector(AI)
    await assert.rejects(() => r._callChat([{ role: 'user', content: 'secret fact text' }]))
    const snap = memStats.snapshot()
    assert.equal(snap.counters['llm.reflect.fail'], 1)
    assert.equal(snap.counters['llm.reflect.call'], undefined)
    assert.equal(log.warnings.length, 1)
    assert.ok(!log.warnings[0].includes('secret fact text'), 'warning must not leak prompt/fact text')
  } finally {
    log.restore()
    restore()
  }
})

test('_callChat counts fail and warns when fetch aborts (timeout)', async () => {
  memStats.reset()
  const restore = stubFetch(async () => {
    const err = new Error('The operation was aborted')
    err.name = 'TimeoutError'
    throw err
  })
  const log = stubLogger()
  try {
    const r = new Reflector(AI)
    await assert.rejects(() => r._callChat([{ role: 'user', content: 'hi' }]))
    const snap = memStats.snapshot()
    assert.equal(snap.counters['llm.reflect.fail'], 1)
    assert.equal(log.warnings.length, 1)
  } finally {
    log.restore()
    restore()
  }
})

test('consolidateEntity stays silent on _callChat failure but still counts the fail', async () => {
  memStats.reset()
  const restore = stubFetch(async () => { throw new Error('boom') })
  const log = stubLogger()
  try {
    const r = new Reflector(AI)
    const entity = makeEntity({ qq: '1', facts: [makeFact({ text: '在上海', authority: 'self' })] })
    const out = await r.consolidateEntity(entity)
    assert.equal(out.changed, false)
    assert.equal(out.facts.length, 1)
    assert.equal(memStats.snapshot().counters['llm.reflect.fail'], 1)
  } finally {
    log.restore()
    restore()
  }
})
