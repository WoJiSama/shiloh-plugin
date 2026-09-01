import test from 'node:test'
import assert from 'node:assert/strict'
import { ForgetGroupKnowledgeTool } from '../functions/functions_tools/ForgetGroupKnowledgeTool.js'
import { extractGroupKnowledgeForgetTarget, isExplicitGroupKnowledgeForgetRequest } from '../utils/groupKnowledgeForgetPolicy.js'

test('extracts a natural group-knowledge forget request without accepting ordinary forgetfulness', () => {
  assert.equal(isExplicitGroupKnowledgeForgetRequest('希洛，忘掉我的星怒'), true)
  assert.equal(extractGroupKnowledgeForgetTarget('希洛，忘掉我的星怒'), '我的星怒')
  assert.equal(extractGroupKnowledgeForgetTarget('把我之前教你的地图删掉'), '地图')
  assert.equal(isExplicitGroupKnowledgeForgetRequest('我忘记带钥匙了'), false)
})

test('forgets through MemoryManager only for an explicit current-group request', async () => {
  const calls = []
  const tool = new ForgetGroupKnowledgeTool()
  const event = {
    group_id: 'g', user_id: '9', msg: '希洛，忘掉我的星怒',
    memoryManager: {
      async forgetGroupKnowledge(input) {
        calls.push(input)
        return { deleted: true, entry: { kind: 'member_definition', subject: '星怒', targets: [{ displayName: '星野' }] } }
      }
    }
  }
  assert.match(await tool.execute({ memory: '我的星怒' }, event), /已经忘掉.*星怒.*星野/)
  assert.deepEqual(calls, [{ groupId: 'g', requesterQQ: '9', requesterIsGroupManager: false, query: '我的星怒' }])
})

test('does not call deletion for a non-destructive sentence', async () => {
  let called = false
  const tool = new ForgetGroupKnowledgeTool()
  const result = await tool.execute({ memory: '星怒' }, {
    group_id: 'g', user_id: '9', msg: '我忘记星怒是谁了',
    memoryManager: { async forgetGroupKnowledge() { called = true } }
  })
  assert.match(result, /没有明确要求删除/)
  assert.equal(called, false)
})
