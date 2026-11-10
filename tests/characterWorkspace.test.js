import test from 'node:test'
import assert from 'node:assert/strict'
import { createCharacterWorkspace, createCharacterWorkspaceTools } from '../dist/backend/modules/simulation/infrastructure/characterWorkspace.js'
import { characterKey } from '../dist/backend/modules/simulation/domain/characterState.js'

const SCOPE = { botId: 'bot-a', personaId: 'persona-a', groupId: 'group-a' }
const AT = 1_794_200_000_000
function fixture(scope = SCOPE) {
  const kv = new Map()
  let at = AT
  const redis = { get: async key => kv.get(key) ?? null, set: async (key, value) => { kv.set(key, value); return 'OK' }, del: async key => kv.delete(key) }
  const workspace = createCharacterWorkspace({ redis, scope, now: () => at })
  return { workspace, kv, redis, advance: () => { at += 1000 }, key: `${characterKey(scope)}:workspace` }
}
const draft = (changes = {}) => ({ title: '游戏地图调查', kind: 'research', content: '第一版：资料尚待核实。', evidenceRefs: ['message:1'], ...changes })

test('workspace revisions preserve actual text and restore as a new monotonic version', async () => {
  const h = fixture()
  const original = await h.workspace.write(draft())
  assert.equal(original.revision, 1)
  assert.equal(original.status, 'draft')
  h.advance()
  const edited = await h.workspace.write(draft({ id: original.id, expectedRevision: 1, content: '第二版：补充了玩法线索。' }))
  assert.equal(edited.revision, 2)
  assert.equal((await h.workspace.read(original.id, 1)).versions[0].content, draft().content)
  h.advance()
  const restored = await h.workspace.restore(original.id, 1, 2)
  assert.equal(restored.revision, 3)
  assert.equal(restored.versions.at(-1).content, draft().content)
  assert.equal(restored.versions[1].content, edited.versions.at(-1).content)
  assert.equal(restored.versions.at(-1).revision, 3)
})

test('independent adapters serialize concurrent edits and reject stale or absent expected revision', async () => {
  const h = fixture(), first = await h.workspace.write(draft())
  const other = createCharacterWorkspace({ redis: h.redis, scope: SCOPE, now: () => AT })
  const writes = await Promise.allSettled([
    h.workspace.write(draft({ id: first.id, expectedRevision: 1, content: '并发A' })),
    other.write(draft({ id: first.id, expectedRevision: 1, content: '并发B' })),
  ])
  assert.equal(writes.filter(r => r.status === 'fulfilled').length, 1)
  assert.equal(writes.filter(r => r.status === 'rejected').length, 1)
  await assert.rejects(h.workspace.write(draft({ id: first.id })), /expectedRevision/)
  await assert.rejects(h.workspace.restore(first.id, 1), /expectedRevision/)
  assert.equal((await h.workspace.read(first.id)).versions.length, 2)
})

test('scope mismatch, corrupt JSON and unknown persisted fields fail without overwriting history', async () => {
  for (const raw of ['broken-json', JSON.stringify({ schemaVersion: 1, scope: { ...SCOPE, groupId: 'other-group' }, works: [] }), JSON.stringify({ schemaVersion: 1, scope: SCOPE, works: [], arbitrary: true })]) {
    const h = fixture()
    h.kv.set(h.key, raw)
    await assert.rejects(h.workspace.list())
    await assert.rejects(h.workspace.write(draft()))
    assert.equal(h.kv.get(h.key), raw)
  }
  const h = fixture(), work = await h.workspace.write(draft())
  const other = createCharacterWorkspace({ redis: h.redis, scope: { ...SCOPE, groupId: 'other-group' } })
  assert.deepEqual(await other.list(), [])
  await assert.rejects(other.read(work.id), /不存在/)
})

test('source deletion prunes dependent versions without reusing revisions or pruning expired message windows', async () => {
  const h = fixture()
  const first = await h.workspace.write(draft())
  await h.workspace.write(draft({ id: first.id, expectedRevision: 1, content: '带来源的第二版', evidenceRefs: ['memory:old-source'] }))
  await h.workspace.pruneEvidence([])
  const pruned = await h.workspace.read(first.id)
  assert.deepEqual(pruned.versions.map(v => v.revision), [1])
  assert.equal(pruned.revision, 3)
  assert.equal(pruned.title, '来源已整理的作品')
  await assert.rejects(h.workspace.restore(first.id, 2, 3), /不存在/)
  const updated = await h.workspace.write(draft({ id: first.id, expectedRevision: 3, content: '删源后新稿', evidenceRefs: ['receipt:actual-source'] }))
  assert.equal(updated.versions.at(-1).revision, 4)
  await h.workspace.pruneEvidence(['receipt:actual-source'])
  assert.equal((await h.workspace.read(first.id)).versions.length, 2)
  const dependent = await h.workspace.write(draft({ evidenceRefs: ['memory:deleted'] }))
  await h.workspace.pruneEvidence(['receipt:actual-source'])
  await assert.rejects(h.workspace.read(dependent.id), /不存在/)
})

test('archive stops edits and bounded version retention keeps newest 12 revisions', async () => {
  const h = fixture()
  let work = await h.workspace.write(draft())
  for (let index = 2; index <= 15; index++) work = await h.workspace.write(draft({ id: work.id, expectedRevision: work.revision, content: `第${index}版` }))
  assert.equal(work.versions.length, 12)
  assert.equal(work.versions[0].revision, 4)
  await assert.rejects(h.workspace.read(work.id, 1), /保留窗口/)
  const archived = await h.workspace.archive(work.id, true)
  await assert.rejects(h.workspace.write(draft({ id: work.id, expectedRevision: archived.revision })), /归档/)
  await assert.rejects(h.workspace.restore(work.id, 4, archived.revision - 1), /已更新/)
  const restored = await h.workspace.restore(work.id, 4, archived.revision)
  assert.equal(restored.status, 'draft')
  assert.equal(restored.versions.at(-1).content, '第4版')
  assert.equal(restored.revision, archived.revision + 1)
  await h.workspace.remove(work.id)
  assert.deepEqual(await h.workspace.list(), [])
})

test('workspace rejects oversized, empty and forged inputs without creating content', async () => {
  const h = fixture()
  for (const input of [draft({ content: 'x'.repeat(12001) }), draft({ title: 'x'.repeat(121) }), draft({ evidenceRefs: [] }), draft({ evidenceRefs: ['memory:phantom', 'memory:phantom'] }), draft({ evidenceRefs: ['file:/tmp/other'] }), draft({ filename: '/tmp/unsafe' }), draft({ id: 'fake', expectedRevision: 1 }), draft({ expectedRevision: 1 })]) await assert.rejects(h.workspace.write(input))
  assert.deepEqual(await h.workspace.list(), [])
})

test('workspace tools expose bounded segments and enforce source visibility, scope and active guard', async () => {
  const h = fixture(), visible = ['message:1']
  let stopped = false
  const [tool] = createCharacterWorkspaceTools({ workspace: h.workspace, visibleEvidenceRefs: () => visible, ensureActive: async () => { if (stopped) throw new Error('cancelled') } })
  assert.match(await tool.execute({ action: 'write', ...draft({ evidenceRefs: ['memory:invisible'] }) }, {}), /^error:/)
  assert.match(await tool.execute({ action: 'write', ...draft(), path: '/tmp/unsafe' }, {}), /^error:/)
  const saved = await tool.execute({ action: 'write', ...draft({ content: '甲'.repeat(5000) }) }, {})
  assert.equal(saved.saved, true)
  assert.equal(saved.shared, false)
  const first = await tool.execute({ action: 'read', id: saved.id, limit: 2000 }, {})
  const second = await tool.execute({ action: 'read', id: saved.id, offset: first.nextOffset, limit: 2000 }, {})
  assert.equal(first.content.length, 2000)
  assert.equal(second.content.length, 2000)
  assert.equal(second.nextOffset, 4000)
  const listed = await tool.execute({ action: 'list' }, {})
  assert.ok(JSON.stringify(listed).length <= 3500)
  assert.equal('content' in listed.works[0], false)
  visible.length = 0
  assert.match(await tool.execute({ action: 'restore', id: saved.id, revision: 1, expectedRevision: 1 }, {}), /^error:/)
  stopped = true
  assert.match(await tool.execute({ action: 'read', id: saved.id }, {}), /^error:/)
  assert.match(await tool.execute({ action: 'list' }, {}), /^error:/)
})

test('long source references stay whole inside tool result budget while body chunks remain readable', async () => {
  const h = fixture()
  const refs = Array.from({ length: 16 }, (_, i) => `memory:${String(i).padStart(3, '0')}${'x'.repeat(160)}`)
  const item = await h.workspace.write(draft({ content: '正文'.repeat(2000), evidenceRefs: refs }))
  const [tool] = createCharacterWorkspaceTools({ workspace: h.workspace, visibleEvidenceRefs: () => refs, ensureActive: async () => {} })
  const result = await tool.execute({ action: 'read', id: item.id }, {})
  assert.equal(result.ok, true)
  assert.ok(JSON.stringify(result).length <= 3500)
  assert.deepEqual(result.evidenceRefs, refs)
  assert.ok(result.content.length > 0)
  assert.ok(result.nextOffset > 0)
})

test('shared preference revocation removes derived versions and restores retain original shared provenance', async () => {
  const h = fixture()
  const base = await h.workspace.write(draft())
  const derived = await h.workspace.write(draft({ id: base.id, expectedRevision: 1, content: '受共享兴趣影响的稿件', sharedSources: ['shared-a'] }))
  await h.workspace.archive(base.id, true)
  const restored = await h.workspace.restore(base.id, derived.revision, 3)
  assert.deepEqual(restored.versions.at(-1).sharedSources, ['shared-a'])
  await h.workspace.pruneShared(['shared-a'])
  assert.equal((await h.workspace.read(base.id)).revision, 4)
  await h.workspace.pruneShared([])
  const pruned = await h.workspace.read(base.id)
  assert.equal(pruned.revision, 5)
  assert.equal(pruned.title, '来源已整理的作品')
  assert.deepEqual(pruned.versions.map(v => v.revision), [1])
  await assert.rejects(h.workspace.restore(base.id, 4, 5), /不存在/)
  const after = await h.workspace.write(draft({ id: base.id, expectedRevision: 5 }))
  assert.equal(after.versions.at(-1).revision, 6)
})

test('workspace shared provenance is runtime supplied and cannot be forged by model arguments', async () => {
  const h = fixture()
  const [tool] = createCharacterWorkspaceTools({ workspace: h.workspace, visibleEvidenceRefs: () => ['message:1'], sharedSourceIds: () => ['shared-visible'], ensureActive: async () => {} })
  assert.match(await tool.execute({ action: 'write', ...draft(), sharedSources: ['shared-forged'] }, {}), /^error:/)
  const saved = await tool.execute({ action: 'write', ...draft() }, {})
  assert.deepEqual((await h.workspace.read(saved.id)).versions.at(-1).sharedSources, ['shared-visible'])
  await h.workspace.pruneShared([])
  assert.deepEqual(await h.workspace.list(), [])
})
