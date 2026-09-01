import test from 'node:test'
import assert from 'node:assert/strict'
import { MemoryManager } from '../../utils/MemoryManager.js'
import { findGroupKnowledgeDeletionCandidates, parseSemanticGroupKnowledgeOutput, parseSemanticGroupMemoryOutput } from '../../utils/memory/groupKnowledge.js'
import { createFakeRedis } from './helpers/fakeRedis.js'

function memberMap() {
  return new Map([
    [1, { user_id: 1, card: '希洛' }],
    [9, { user_id: 9, card: '沃基' }],
    [2, { user_id: 2, card: '甲' }],
    [3, { user_id: 3, card: '乙' }]
  ])
}

function parseKnowledge(items, context = {}) {
  return parseSemanticGroupKnowledgeOutput(JSON.stringify(items), {
    text: '原始用户消息',
    memberMap: memberMap(),
    creatorQQ: '9',
    creatorDisplay: '沃基',
    botId: '1',
    now: 100,
    ...context
  })
}

function mapTeaching() {
  return parseKnowledge([{
    kind: 'group_file',
    subject: '地图',
    owner: 'speaker',
    resourceFileName: '地图世界.zip'
  }], {
    fileAssets: [{ type: 'file', fileName: '地图世界.zip', fileId: 'file-1', origin: 'current', source: 'https://temporary.example/file' }]
  })
}

test('stores a group file definition with stable file identity and owner, not a temporary URL', () => {
  const entries = mapTeaching()
  assert.equal(entries.length, 1)
  assert.equal(entries[0].kind, 'group_file')
  assert.equal(entries[0].subject, '地图')
  assert.equal(entries[0].ownerQQ, '9')
  assert.equal(entries[0].resource.fileName, '地图世界.zip')
  assert.equal(entries[0].resource.fileId, 'file-1')
  assert.equal('source' in entries[0].resource, false)
})

test('answers a natural first-person group-file query only for the defined owner and keeps groups isolated', async () => {
  const manager = new MemoryManager({ enabled: true }, { redis: createFakeRedis() })
  await manager.upsertGroupKnowledgeEntries('g1', mapTeaching())
  const prompt = await manager.getGroupKnowledgePrompt('g1', { speakerQQ: '9', message: '希洛，我群里面的地图是什么' })
  assert.match(prompt, /地图世界\.zip/)
  assert.match(prompt, /当前发言者/)
  assert.equal(await manager.getGroupKnowledgePrompt('g1', { speakerQQ: '2', message: '我的地图是什么' }), '')
  assert.equal(await manager.getGroupKnowledgePrompt('g2', { speakerQQ: '9', message: '我的地图是什么' }), '')
})

test('records one or many named members as a reusable group definition', async () => {
  const entries = parseKnowledge([{
    kind: 'member_set', subject: '美术组', targetNames: ['甲', '乙']
  }])
  assert.equal(entries[0].kind, 'member_set')
  assert.equal(entries[0].subject, '美术组')
  assert.deepEqual(entries[0].targetUserIds, ['2', '3'])

  const manager = new MemoryManager({ enabled: true }, { redis: createFakeRedis() })
  const saved = await manager.upsertGroupKnowledgeEntries('g', entries)
  const prompt = await manager.getGroupKnowledgePrompt('g', { speakerQQ: '9', message: '美术组是谁' })
  assert.match(prompt, /甲\(QQ:2\).*乙\(QQ:3\)/)
  assert.equal((await manager.adminDeleteGroupKnowledge({ groupId: 'g', id: saved.entries[0].id })).deleted, true)
  assert.equal((await manager.getGroupKnowledgeEntries('g')).length, 0)
})

test('resolves my relationship to the current speaker instead of storing the pronoun', async () => {
  const entries = parseKnowledge([{
    kind: 'member_definition', subject: '星怒', owner: 'speaker', targetNames: ['星野']
  }], {
    text: '希洛群里的星野是我的星怒你记住了',
    memberMap: new Map([...memberMap(), [4, { user_id: 4, card: '星野' }]]),
  })
  assert.equal(entries.length, 1)
  assert.equal(entries[0].subject, '星怒')
  assert.equal(entries[0].ownerQQ, '9')
  assert.equal(entries[0].targets[0].userId, '4')

  const manager = new MemoryManager({ enabled: true }, { redis: createFakeRedis() })
  await manager.upsertGroupKnowledgeEntries('g', entries)
  const prompt = await manager.getGroupKnowledgePrompt('g', { speakerQQ: '9', message: '我群里的星怒是谁' })
  assert.match(prompt, /当前发言者的“星怒”指的是：星野/)
})

test('model semantic output resolves pronouns through provided speaker and live member context', () => {
  const members = new Map([...memberMap(), [4, { user_id: 4, card: '星野' }]])
  const entries = parseKnowledge([
    { kind: 'member_definition', subject: '星怒', owner: 'speaker', targetNames: ['星野'] }
  ], {
    text: '希洛群里的星野是我的星怒你记住了',
    memberMap: members,
  })
  assert.equal(entries.length, 1)
  assert.equal(entries[0].ownerQQ, '9')
  assert.equal(entries[0].targets[0].userId, '4')
})

test('semantic adjudicator rejects story casting and quoted bot acknowledgements', async () => {
  const manager = new MemoryManager({
    enabled: true,
    memoryAiConfig: { memoryAiUrl: 'https://memory.example/chat', memoryAiApikey: 'test', memoryAiModel: 'test' }
  }, { redis: createFakeRedis() })
  let prompt = ''
  manager.extractor._callChat = async messages => {
    prompt = messages[1].content
    return '[]'
  }
  const decision = await manager.interpretGroupKnowledgeInstruction({
    text: "这个故事不够有反转，再加新角色'水水水水'和'兔头'；上次它还说‘记住了’",
    memberMap: new Map([...memberMap(), [4, { user_id: 4, card: '水水水水' }], [5, { user_id: 5, card: '诺登不登校' }]]),
    creatorQQ: '9',
    botId: '1'
  })
  assert.equal(decision.status, 'ignored')
  assert.deepEqual(decision.knowledgeEntries, [])
  assert.match(prompt, /创作故事/)
  assert.match(prompt, /“记住了”/)
})

test('stores a quoted alias as one exact member definition', async () => {
  const members = new Map([...memberMap(), [5, { user_id: 5, card: '诺登不登校' }]])
  const entries = parseKnowledge([
    { kind: 'member_definition', subject: '兔头', targetNames: ['诺登不登校'] }
  ], {
    text: "希洛，记住'兔头'也就是群里的诺登不登校",
    memberMap: members,
  })
  assert.equal(entries.length, 1)
  assert.equal(entries[0].subject, '兔头')
  assert.deepEqual(entries[0].targetUserIds, ['5'])

  const manager = new MemoryManager({ enabled: true }, { redis: createFakeRedis() })
  await manager.upsertGroupKnowledgeEntries('g', entries)
  const prompt = await manager.getGroupKnowledgePrompt('g', { message: '兔头是谁' })
  assert.match(prompt, /“兔头”指的是：诺登不登校/)
})

test('forgets only the requesting user\'s uniquely named group knowledge', async () => {
  const manager = new MemoryManager({ enabled: true }, { redis: createFakeRedis() })
  const mine = {
    kind: 'group_file', subject: '地图', subjectKey: '地图', aliases: ['我的地图', '地图'],
    ownerQQ: '9', ownerDisplay: '沃基', targetUserIds: [], targets: [], resource: { fileName: '我的地图.zip' },
    createdBy: '9', sourceText: '地图是我做的', at: 100, enabled: true
  }
  const theirs = { ...mine, ownerQQ: '2', ownerDisplay: '甲', resource: { fileName: '甲的地图.zip' }, createdBy: '2', sourceText: '地图是甲做的', at: 101 }
  const saved = await manager.upsertGroupKnowledgeEntries('g', [mine, theirs])
  assert.equal(saved.entries.length, 2)
  const candidates = findGroupKnowledgeDeletionCandidates(await manager.getGroupKnowledgeEntries('g'), {
    query: '我的地图', speakerQQ: '9', createdBy: '9'
  })
  assert.equal(candidates.length, 1)
  const result = await manager.forgetGroupKnowledge({ groupId: 'g', requesterQQ: '9', query: '我的地图' })
  assert.equal(result.deleted, true)
  assert.equal((await manager.getGroupKnowledgeEntries('g')).length, 1)
  assert.equal((await manager.getGroupKnowledgeEntries('other')).length, 0)
})

test('does not delete an ambiguous or foreign group knowledge entry', async () => {
  const manager = new MemoryManager({ enabled: true }, { redis: createFakeRedis() })
  const base = {
    kind: 'member_definition', subject: '搭档', subjectKey: '搭档', aliases: ['搭档'], ownerQQ: '',
    targetUserIds: ['2'], targets: [{ userId: '2', displayName: '甲' }], createdBy: '9', at: 100, enabled: true
  }
  await manager.upsertGroupKnowledgeEntries('g', [base, { ...base, kind: 'member_set', targetUserIds: ['3'], targets: [{ userId: '3', displayName: '乙' }], at: 101 }])
  const ambiguous = await manager.forgetGroupKnowledge({ groupId: 'g', requesterQQ: '9', query: '搭档' })
  assert.equal(ambiguous.reason, 'ambiguous')
  assert.equal((await manager.getGroupKnowledgeEntries('g')).length, 2)
  const foreign = await manager.forgetGroupKnowledge({ groupId: 'g', requesterQQ: '2', query: '搭档' })
  assert.equal(foreign.reason, 'not-found')
  assert.equal((await manager.getGroupKnowledgeEntries('g')).length, 2)
})

test('unified semantic commit uses one source for aliases, knowledge and workflows and forget removes all of it', async () => {
  const manager = new MemoryManager({ enabled: true }, { redis: createFakeRedis() })
  const decision = parseSemanticGroupMemoryOutput(JSON.stringify([
    { kind: 'member_definition', subject: '星怒', owner: 'speaker', targetNames: ['甲'] },
    { kind: 'alias', alias: '甲哥', targetNames: ['甲'] },
    { kind: 'workflow', condition: '有人要挂团', targetNames: ['甲'] }
  ]), {
    text: '希洛，记住甲是我的星怒，甲哥也是甲；有人要挂团就找甲',
    memberMap: memberMap(), creatorQQ: '9', creatorDisplay: '沃基', botId: '1', sourceMessageId: 'm-1', now: 100
  })
  const committed = await manager.commitGroupMemoryDecision('g', decision, {
    requesterQQ: '9', isGroupManager: true, sourceMessageId: 'm-1', text: '原话', now: 100
  })
  assert.equal(committed.status, 'accepted')
  assert.equal((await manager.getGroupKnowledgeEntries('g')).length, 1)
  assert.equal((await manager.getGroupWorkflowRules('g')).length, 1)
  assert.equal(Object.keys(await manager.store.getAlias('g')).length, 1)
  const source = (await manager.getGroupKnowledgeEntries('g'))[0].proposalId
  assert.ok(source)
  assert.equal((await manager.getGroupWorkflowRules('g'))[0].proposalId, source)
  assert.equal((await manager.store.getAlias('g'))['甲哥'].proposalId, source)

  const forgotten = await manager.forgetGroupKnowledge({ groupId: 'g', requesterQQ: '9', query: '我的星怒' })
  assert.equal(forgotten.deleted, true)
  assert.equal((await manager.getGroupKnowledgeEntries('g')).length, 0)
  assert.equal((await manager.getGroupWorkflowRules('g')).length, 0)
  assert.equal(Object.keys(await manager.store.getAlias('g')).length, 0)
})

test('unified semantic commit rejects non-manager workflows and another member overwriting shared definitions', async () => {
  const manager = new MemoryManager({ enabled: true }, { redis: createFakeRedis() })
  const workflowOnly = parseSemanticGroupMemoryOutput(JSON.stringify([
    { kind: 'workflow', condition: '有人要挂团', targetNames: ['甲'] }
  ]), { text: '记住有人要挂团找甲', memberMap: memberMap(), creatorQQ: '9', botId: '1', sourceMessageId: 'm-w' })
  const denied = await manager.commitGroupMemoryDecision('g', workflowOnly, { requesterQQ: '9', isGroupManager: false, sourceMessageId: 'm-w' })
  assert.equal(denied.status, 'rejected')
  assert.equal(denied.rejected[0].reason, 'unauthorized')
  assert.equal((await manager.getGroupWorkflowRules('g')).length, 0)

  const first = parseSemanticGroupMemoryOutput(JSON.stringify([
    { kind: 'member_definition', subject: '策划', targetNames: ['甲'] },
    { kind: 'alias', alias: '主策', targetNames: ['甲'] }
  ]), { text: '记住甲是策划', memberMap: memberMap(), creatorQQ: '9', botId: '1', sourceMessageId: 'm-a' })
  await manager.commitGroupMemoryDecision('g', first, { requesterQQ: '9', sourceMessageId: 'm-a' })
  const replacement = parseSemanticGroupMemoryOutput(JSON.stringify([
    { kind: 'member_definition', subject: '策划', targetNames: ['乙'] },
    { kind: 'alias', alias: '主策', targetNames: ['乙'] }
  ]), { text: '记住乙是策划', memberMap: memberMap(), creatorQQ: '3', botId: '1', sourceMessageId: 'm-b' })
  const conflict = await manager.commitGroupMemoryDecision('g', replacement, { requesterQQ: '3', sourceMessageId: 'm-b' })
  assert.equal(conflict.status, 'rejected')
  assert.deepEqual(conflict.rejected.map(item => item.reason), ['conflict', 'conflict'])
  assert.equal((await manager.getGroupKnowledgeEntries('g'))[0].targets[0].userId, '2')
  assert.equal((await manager.store.getAlias('g'))['主策'].qq, '2')
})

test('semantic adjudicator includes explicit at targets and the speaker among identity candidates', async () => {
  const manager = new MemoryManager({
    enabled: true,
    memoryAiConfig: { memoryAiUrl: 'https://memory.example/chat', memoryAiApikey: 'test', memoryAiModel: 'test' }
  }, { redis: createFakeRedis() })
  let prompt = ''
  manager.extractor._callChat = async messages => { prompt = messages[1].content; return '[]' }
  await manager.interpretGroupKnowledgeInstruction({
    text: '希洛，记住这个人是我的搭档',
    messageSegments: [{ type: 'at', data: { qq: '2' } }],
    memberMap: memberMap(), creatorQQ: '9', creatorDisplay: '沃基', botId: '1'
  })
  assert.match(prompt, /沃基\(QQ:9\)/)
  assert.match(prompt, /甲\(QQ:2\)/)
})
