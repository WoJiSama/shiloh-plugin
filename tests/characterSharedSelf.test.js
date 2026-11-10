import test from 'node:test'
import assert from 'node:assert/strict'
import { createCharacterSharedSelf, createSharedSelfTools } from '../dist/backend/modules/simulation/infrastructure/characterSharedSelf.js'
import { createCharacterStore } from '../dist/backend/modules/simulation/infrastructure/characterStore.js'
import { addCharacterMemory, characterKey, deleteCharacterMemory } from '../dist/backend/modules/simulation/domain/characterState.js'

const BASE = Date.parse('2026-11-09T00:00:00Z')
const A = { botId: 'bot-s', personaId: 'persona-s', groupId: '10086' }
const B = { ...A, groupId: '10087' }
function harness() {
  const kv = new Map()
  const redis = { async get(key) { return kv.get(key) ?? null }, async set(key, value) { kv.set(key, value); return 'OK' } }
  const characters = createCharacterStore({ redis, now: () => BASE })
  const shared = scope => createCharacterSharedSelf({ redis, scope, now: () => BASE })
  return { kv, redis, characters, shared,
    async memory(scope, id, { kind = 'interest', content = '我偏爱有探索感的独立游戏', supersedes } = {}) {
      return characters.update(scope, state => addCharacterMemory(state, { id, kind, content, epistemic: kind === 'experience' ? 'reported' : 'inferred', evidenceRefs: ['message:1'], ...(supersedes ? { supersedes } : {}) }, ['message:1', ...(supersedes ? [`memory:${supersedes}`] : [])], BASE))
    },
  }
}

test('pending preferences stay private to their source group until source-group approval', async () => {
  const h = harness(); await h.memory(A, 'interest-a')
  const own = h.shared(A), other = h.shared(B), id = await own.propose('interest-a')
  assert.deepEqual(await own.projection(), [])
  assert.deepEqual(await other.projection(), [])
  assert.equal((await own.pending())[0].id, id)
  assert.deepEqual(await other.pending(), [])
  await assert.rejects(other.approve(id), /本群提议不存在/)
  await own.approve(id)
  const projection = await other.projection()
  assert.deepEqual(projection, await own.projection())
  assert.equal(projection[0].content, '我偏爱有探索感的独立游戏')
  assert.equal('sourceScope' in projection[0], false)
  assert.equal('sourceMemoryId' in projection[0], false)
  assert.equal('evidenceRefs' in projection[0], false)
})

test('shared projection is isolated by both bot and persona', async () => {
  const h = harness(); await h.memory(A, 'interest-a')
  const own = h.shared(A), id = await own.propose('interest-a'); await own.approve(id)
  assert.deepEqual(await h.shared({ ...B, botId: 'other-bot' }).projection(), [])
  assert.deepEqual(await h.shared({ ...B, personaId: 'other-persona' }).projection(), [])
  const scope = { ...A, botId: 'other-bot' }
  await h.memory(scope, 'interest-b')
  const other = h.shared(scope), otherId = await other.propose('interest-b'); await other.approve(otherId)
  assert.notEqual((await other.projection())[0].id, id)
})

test('deleting or superseding the source dynamically invalidates approved preferences', async () => {
  for (const mutation of ['delete', 'supersede']) {
    const h = harness(); await h.memory(A, 'interest-a')
    const own = h.shared(A), id = await own.propose('interest-a'); await own.approve(id)
    const before = await h.shared(B).fingerprint()
    if (mutation === 'delete') await h.characters.update(A, state => deleteCharacterMemory(state, 'interest-a', BASE))
    else await h.memory(A, 'interest-new', { content: '现在更想研究叙事设计', supersedes: 'interest-a' })
    assert.deepEqual(await h.shared(B).projection(), [])
    assert.notEqual(await h.shared(B).fingerprint(), before)
  }
})

test('removing a shared ancestor invalidates derived shared preferences without waking the intermediate group', async () => {
  const h = harness(); await h.memory(A, 'source-a')
  const sharedA = h.shared(A), sharedB = h.shared(B), C = { ...A, groupId: '10088' }
  const parentId = await sharedA.propose('source-a'); await sharedA.approve(parentId)
  await h.characters.update(B, state => addCharacterMemory(state, {
    id: 'derived-b', kind: 'interest', content: '延续共享兴趣，我更想研究探索游戏的谜题设计', epistemic: 'inferred', evidenceRefs: ['message:1'], sharedSources: [parentId],
  }, ['message:1'], BASE))
  const childId = await sharedB.propose('derived-b'); await sharedB.approve(childId)
  assert.deepEqual(new Set((await h.shared(C).projection()).map(entry => entry.id)), new Set([parentId, childId]))
  const bBefore = h.kv.get(characterKey(B))
  await sharedA.remove(parentId)
  assert.deepEqual(await h.shared(C).projection(), [])
  assert.equal(h.kv.get(characterKey(B)), bBefore, 'B未运行、清理或写回，其派生共享也须立即失效')
})

test('only current local opinions or interests can be proposed, never experiences or foreign memories', async () => {
  const h = harness(); await h.memory(A, 'old'); await h.memory(A, 'new', { supersedes: 'old' })
  await h.memory(A, 'experience', { kind: 'experience', content: '群友转述的个人经历' })
  await h.memory(B, 'foreign')
  const own = h.shared(A)
  await assert.rejects(own.propose('old'), /当前有效/)
  await assert.rejects(own.propose('experience'), /观点或兴趣/)
  await assert.rejects(own.propose('foreign'), /本群/)
  const id = await own.propose('new')
  assert.equal(typeof id, 'string')
  await assert.rejects(own.propose('new'), /相同共享提议/)
})

test('models can only propose visible sources and cannot approve or inject approval fields', async () => {
  const h = harness(); await h.memory(A, 'interest-a')
  const shared = h.shared(A)
  let active = true, visible = []
  const tool = createSharedSelfTools({ shared, ensureActive: async () => { if (!active) throw new Error('inactive') }, visibleEvidenceRefs: () => visible })[0]
  assert.match(await tool.execute({ action: 'propose', memoryId: 'interest-a' }, {}), /^error:/)
  visible = ['memory:interest-a']
  assert.match(await tool.execute({ action: 'approve', memoryId: 'interest-a' }, {}), /^error:/)
  assert.match(await tool.execute({ action: 'propose', memoryId: 'interest-a', approved: true }, {}), /^error:/)
  const proposed = await tool.execute({ action: 'propose', memoryId: 'interest-a' }, {})
  assert.equal(proposed.status, 'pending_admin_review')
  assert.deepEqual(await shared.projection(), [])
  const listed = await tool.execute({ action: 'list' }, {})
  assert.deepEqual(listed.shared, [])
  active = false
  assert.match(await tool.execute({ action: 'list' }, {}), /^error:/)
})

test('corrupt shared data and identity mismatches fail without overwriting persisted data', async () => {
  const h = harness(); await h.memory(A, 'interest-a')
  const shared = h.shared(A); await shared.propose('interest-a')
  const key = [...h.kv.keys()].find(key => key.startsWith('shiloh:shared-self:'))
  const valid = h.kv.get(key)
  h.kv.set(key, '{bad-json')
  await assert.rejects(shared.projection())
  await assert.rejects(shared.propose('interest-a'))
  assert.equal(h.kv.get(key), '{bad-json')
  const wrong = JSON.parse(valid); wrong.entries[0].sourceScope.botId = 'not-my-bot'
  h.kv.set(key, JSON.stringify(wrong))
  await assert.rejects(shared.pending(), /身份不匹配/)
  assert.equal(JSON.parse(h.kv.get(key)).entries[0].sourceScope.botId, 'not-my-bot')
  assert.equal(JSON.parse(h.kv.get(characterKey(A))).scope.botId, A.botId)
})
