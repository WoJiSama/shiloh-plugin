import test from 'node:test'
import assert from 'node:assert/strict'
import { MemoryManager } from '../../domains/memory/MemoryManager.js'
import { extractExplicitGroupWorkflowRules } from '../../domains/memory/engine/groupWorkflow.js'
import { createFakeRedis } from './helpers/fakeRedis.js'

function members() {
  return new Map([
    [1, { user_id: 1, card: '希洛' }],
    [2, { user_id: 2, card: '甲' }],
    [3, { user_id: 3, card: '乙' }]
  ])
}

function teach(text = '如果有人要挂团，就要找 @甲 和 @乙') {
  return extractExplicitGroupWorkflowRules({
    text,
    messageSegments: [
      { type: 'at', data: { qq: '1' } },
      { type: 'text', text: ' 如果有人要挂团，就要找 ' },
      { type: 'at', data: { qq: '2' } },
      { type: 'text', text: ' 和 ' },
      { type: 'at', data: { qq: '3' } }
    ],
    memberMap: members(),
    creatorQQ: '9',
    botId: '1',
    now: 100
  })
}

test('explicit conditional teaching resolves current member IDs and excludes the bot mention', () => {
  const rules = teach()
  assert.equal(rules.length, 1)
  assert.equal(rules[0].condition, '有人要挂团')
  assert.deepEqual(rules[0].targetUserIds, ['2', '3'])
  assert.deepEqual(rules[0].targets.map(item => item.displayName), ['甲', '乙'])
})

test('workflow memory is group-scoped, replaces the same condition, and only exposes on an explicit action request', async () => {
  const manager = new MemoryManager({ enabled: true }, { redis: createFakeRedis() })
  const first = await manager.upsertGroupWorkflowRules('g1', teach())
  assert.equal(first.written, 1)
  assert.equal((await manager.getGroupWorkflowRules('g2')).length, 0)
  assert.equal(await manager.getGroupWorkflowPrompt('g1', '有人要挂团啦'), '')
  assert.equal(await manager.getGroupWorkflowPrompt('g1', '@甲 你看一下这个'), '')

  const prompt = await manager.getGroupWorkflowPrompt('g1', '有人要挂团啦，你可以帮我艾特吗')
  assert.match(prompt, /已教会的群工作流 - 可执行/)
  assert.match(prompt, /"2","3"/)
  assert.match(prompt, /mentionMembersTool/)

  const replacement = teach('如果有人要挂团，就要找 @甲')
  replacement[0].targetUserIds = ['2']
  replacement[0].targets = [{ userId: '2', displayName: '甲' }]
  await manager.upsertGroupWorkflowRules('g1', replacement)
  const stored = await manager.getGroupWorkflowRules('g1')
  assert.equal(stored.length, 1)
  assert.deepEqual(stored[0].targetUserIds, ['2'])
})

test('workflow deletion and group memory clearing remove executable rules', async () => {
  const manager = new MemoryManager({ enabled: true }, { redis: createFakeRedis() })
  const saved = await manager.upsertGroupWorkflowRules('g', teach())
  const id = saved.rules[0].id
  assert.equal((await manager.adminDeleteGroupWorkflow({ groupId: 'g', id })).deleted, true)
  assert.equal((await manager.getGroupWorkflowRules('g')).length, 0)
  await manager.upsertGroupWorkflowRules('g', teach())
  await manager.adminClearMemories({ groupId: 'g' })
  assert.equal((await manager.getGroupWorkflowRules('g')).length, 0)
})
