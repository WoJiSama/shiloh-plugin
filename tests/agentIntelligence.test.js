import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildStructuredHistoryMessage,
  inspectAgentRequestComplexity,
  resolveHistorySelectionBudget,
  resolveAgentBackend,
  resolveToolRoundLimit,
  selectRelevantGroupHistory,
  shouldAcceptPlannerTextResponse,
  summarizeToolResultForAgent
} from '../utils/agentIntelligence.js'

function history(id, content, userId = id) {
  return { role: 'user', messageId: String(id), userId: String(userId), content }
}

test('keeps recent continuity and older messages relevant to the current reference', () => {
  const messages = [
    history(1, '[10:00] 小明(QQ号:1): 我最近一直在找项目，已经看了十几个'),
    history(2, '[10:01] A(QQ号:2): 今天天气不错'),
    history(3, '[10:02] B(QQ号:3): 晚上吃什么'),
    history(4, '[10:03] C(QQ号:4): 发了个表情'),
    history(5, '[10:04] D(QQ号:5): 我下班了'),
    history(6, '[10:05] E(QQ号:6): 打游戏吗'),
    history(7, '[10:06] 小明(QQ号:1): 又看到一个开源项目'),
    history(8, '[10:07] F(QQ号:7): 看起来一般'),
    history(9, '[10:08] G(QQ号:8): 确实'),
    history(10, '[10:09] H(QQ号:9): 哈哈')
  ]
  const selected = selectRelevantGroupHistory(messages, {
    query: '希洛你能不能锐评一下他上面一直找项目的事情',
    recentCount: 4,
    relevantCount: 3,
    maxMessages: 7
  })

  assert.ok(selected.some(message => message.messageId === '1'))
  assert.deepEqual(selected.slice(-4).map(message => message.messageId), ['7', '8', '9', '10'])
  assert.ok(!selected.some(message => message.messageId === '2'))
})

test('always keeps the quoted message and its immediate neighbors', () => {
  const messages = Array.from({ length: 14 }, (_, index) => history(index + 1, `[10:${index}] 用户${index + 1}说第${index + 1}句话`))
  const selected = selectRelevantGroupHistory(messages, {
    query: '评价一下引用的那句',
    replyMessageId: '3',
    recentCount: 4,
    relevantCount: 0,
    maxMessages: 8
  })

  assert.ok(selected.some(message => message.messageId === '2'))
  assert.ok(selected.some(message => message.messageId === '3'))
  assert.ok(selected.some(message => message.messageId === '4'))
})

test('builds structured history without a fake assistant acknowledgement', () => {
  const context = buildStructuredHistoryMessage([
    { ...history(1, '[10:00] 小明: 找项目'), contextSection: 'relevant' },
    { role: 'assistant', content: '你慢慢找', contextSection: 'recent' }
  ])
  assert.equal(context.role, 'user')
  assert.match(context.content, /较早但与当前问题相关/)
  assert.match(context.content, /\[当前机器人回复\] 你慢慢找/)
  assert.doesNotMatch(context.content, /收到，我会根据历史记录/)
})

test('uses a bounded history budget for independent short chat only', () => {
  assert.deepEqual(
    resolveHistorySelectionBudget({ shortChatRecentHistoryMessages: 7, shortChatRelevantHistoryMessages: 1, shortChatMaxSelectedHistoryMessages: 8 }, { compact: true }),
    { recentCount: 7, relevantCount: 1, maxMessages: 8, mode: 'compact' }
  )
  assert.deepEqual(
    resolveHistorySelectionBudget({ recentHistoryMessages: 10, relevantHistoryMessages: 6, maxSelectedHistoryMessages: 18 }),
    { recentCount: 10, relevantCount: 6, maxMessages: 18, mode: 'full' }
  )
})

test('routes reference-heavy reasoning to the stronger backend but keeps greetings fast', () => {
  const complex = inspectAgentRequestComplexity([
    { role: 'system', content: '【当前群聊上下文】\n[10:00] A(QQ号:1): 我一直找项目\n[10:01] B(QQ号:2): 他又开始了' },
    { role: 'user', content: '你能不能锐评一下他上面一直找项目的事情' }
  ])
  const simple = inspectAgentRequestComplexity([{ role: 'user', content: '希洛在吗' }])
  assert.equal(complex.complex, true)
  assert.equal(simple.complex, false)
})

test('accepts planner text directly and expands tool rounds only for complex work', () => {
  assert.equal(shouldAcceptPlannerTextResponse({ choices: [{ message: { content: '直接回答', tool_calls: [] } }] }), true)
  assert.equal(shouldAcceptPlannerTextResponse({ choices: [{ message: { content: '', tool_calls: [{ id: '1' }] } }] }), false)
  assert.equal(resolveToolRoundLimit({ maxToolRounds: 2, agentIntelligence: { complexMaxToolRounds: 3 } }, { toolNames: ['searchInformationTool'] }), 3)
  assert.equal(resolveToolRoundLimit({ maxToolRounds: 2 }, { toolNames: ['likeTool'], messages: [{ role: 'user', content: '点个赞' }] }), 2)
})

test('selects the reasoning backend only for complex requests', () => {
  const config = {
    useTools: true,
    agentIntelligence: { enabled: true, complexModelRouting: true },
    chatAiConfig: { chatApiUrl: 'https://fast.example/v1', chatApiModel: 'flash', chatApiKey: 'fast-key' },
    toolsAiConfig: { toolsAiUrl: 'https://reasoning.example/v1', toolsAiModel: 'pro', toolsAiApikey: 'pro-key' }
  }
  const complex = resolveAgentBackend(config, {
    messages: [
      { role: 'user', content: '【当前群聊上下文】\nA说他一直在找项目，B说他又开始了' },
      { role: 'user', content: '锐评一下他上面一直找项目这件事' }
    ]
  })
  const simple = resolveAgentBackend(config, { messages: [{ role: 'user', content: '希洛在吗' }] })
  assert.equal(complex.label, 'reasoning')
  assert.equal(complex.model, 'pro')
  assert.equal(simple.label, 'fast')
  assert.equal(simple.model, 'flash')
})

test('uses per-tool result budgets instead of unlimited tool output', () => {
  const longText = 'x'.repeat(9000)
  assert.ok(summarizeToolResultForAgent('searchInformationTool', longText).length > 7000)
  assert.ok(summarizeToolResultForAgent('likeTool', longText).length < 5000)
})
