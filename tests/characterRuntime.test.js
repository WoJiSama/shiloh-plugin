import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { createSimulationRuntime } from '../dist/backend/modules/simulation/infrastructure/simulationRuntime.js'
import { createDefaultSimSession } from '../dist/backend/modules/simulation/domain/simConfig.js'
import { CHARACTER_MIN_WAKE_MS, addCharacterMemory, beginCharacterGoalAttempt, characterKey, createCharacterGoal, createEmptyCharacterState, deleteCharacterMemory } from '../dist/backend/modules/simulation/domain/characterState.js'
import { resolveCharacterConsistencyRoute } from '../dist/backend/modules/simulation/infrastructure/characterConsistencyRouting.js'

const BOT = '3094088525'
const GROUP = '10086'
const OTHER_GROUP = '10087'
const BASE_AT = 1_790_000_000_000
const sessionKey = groupId => `shiloh:sim:g:${groupId}`
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let callSequence = 0
const toolCall = (name, args) => ({ id: `test-call-${++callSequence}`, type: 'function', function: { name, arguments: JSON.stringify(name === 'simSendMessage' ? { continuation: 'chat', ...args } : args) } })
const tools = (...calls) => ({ role: 'assistant', content: '', tool_calls: calls })
const quiet = () => ({ role: 'assistant', content: '' })
const finalText = content => ({ role: 'assistant', content })

async function waitFor(check, description, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await sleep(25)
  }
  assert.fail(`等待超时：${description}`)
}

function seedSession(kv, groupId, botId, clock) {
  const state = createDefaultSimSession(clock.value)
  state.bootstrapSent = true
  state.botId = botId
  state.wakeConfig.triggers.probability = 0
  state.nextProactiveCheckAt = 0
  kv.set(sessionKey(groupId), JSON.stringify(state))
}

/** No model, network or QQ adapters: only the compiled production runtime is exercised. */
function fixture({
  kv = new Map(), clock = { value: BASE_AT }, botId = BOT,
  identity = { id: 'shiloh', name: '希洛', systemContent: '喜欢独立游戏' },
  groups = [GROUP], script = () => quiet(), execute, writeFault, onSave, send, review, recordTokens,
  proactiveProbability = 0, seed = true, maxToolRounds = 8, consistencyEnabled,
  judgeSocialPermission,
} = {}) {
  if (seed) for (const groupId of groups) if (!kv.has(sessionKey(groupId))) seedSession(kv, groupId, botId, clock)
  const calls = []
  const events = []
  const sent = []
  const errors = []
  const writes = []
  const toolDefinitions = ['searchInformationTool', 'ownerAdminTool', 'simDangerTool'].map(name => ({
    name, description: `测试隔离工具 ${name}`,
    parameters: { type: 'object', properties: {}, required: [] },
    async execute(args, event) {
      events.push({ name, args, event })
      return execute ? await execute(name, args, event) : { ok: true, result: '公开搜索结果' }
    },
  }))
  const redis = {
    async get(key) { return kv.has(key) ? kv.get(key) : null },
    async set(key, value) {
      if (writeFault) await writeFault(key, value)
      writes.push({ key, value })
      kv.set(key, value)
      if (onSave) await onSave(key, value)
      return 'OK'
    },
    async del(...keys) { let count = 0; for (const key of keys) if (kv.delete(key)) count += 1; return count },
  }
  const runtime = createSimulationRuntime({
    redis, now: () => clock.value, random: () => 0.99,
    logger: { info() {}, warn(...args) { errors.push(args.join(' ')) }, error(...args) { errors.push(args.map(String).join(' ')) } },
    getSelf: () => ({ id: botId, name: identity.name }),
    getPersona: () => ({ personaId: identity.id, persona: { name: identity.name }, systemContent: identity.systemContent }),
    getSection: () => ({
      enabled: true, allGroups: false, groups,
      ...(consistencyEnabled === undefined ? {} : { consistency: { enabled: typeof consistencyEnabled === 'function' ? consistencyEnabled() : consistencyEnabled } }),
      extraTools: toolDefinitions.map(tool => tool.name), toolPolicy: { mode: 'legacy' },
      wake: { probability: 0, batchWindowMs: 1000, maxWakePerMinute: 100, maxWakePerHour: 100, proactiveProbability, proactiveIdleMs: 60_000 },
      turn: { maxToolRounds, minSendGapMs: 0, maxTurnsPerDay: 100 },
      rhythm: { enabled: false }, mood: { enabled: false }, wakeGate: { enabled: false }, userStyle: { enabled: false },
    }),
    getExecutionConfig: () => ({ useTools: true }),
    ...(review ? { reviewCharacter: review } : {}),
    ...(recordTokens ? { recordTokens } : {}),
    ...(judgeSocialPermission ? { judgeSocialPermission } : {}),
    getExtraTools: names => toolDefinitions.filter(tool => names.includes(tool.name)),
    async YTapi(request) {
      calls.push(structuredClone(request))
      const message = await script(request, calls.length - 1)
      return { choices: [{ message, finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop' }], usage: { total_tokens: 10 }, model: 'offline-test' }
    },
    async sendGroupMessage(groupId, segments) {
      const receipt = send ? await send(groupId, segments) : { ok: true, messageId: `sent-${sent.length + 1}` }
      if (receipt.ok) sent.push({ groupId, segments })
      return receipt
    },
  })
  return {
    runtime, kv, clock, identity, botId, calls, events, sent, errors, writes,
    scope: (groupId = GROUP) => ({ botId, personaId: identity.id, groupId }),
    async ingest(text = '看看这个游戏', userId = '40000', { at = true, groupId = GROUP, source } = {}) {
      return runtime.ingest({ group_id: groupId, self_id: botId, user_id: userId, message_type: 'group', msg: text,
        atBot: at, message: at ? [{ type: 'at', data: { qq: botId } }, { type: 'text', data: { text } }] : [], sender: { nickname: `群友${userId}` }, ...(source ? { source } : {}) })
    },
  }
}

async function idle(harness, minCalls, groupId = GROUP) {
  await waitFor(async () => harness.calls.length >= minCalls && !(await harness.runtime.describeGroup(groupId)).running, `回合结束（模型调用至少 ${minCalls} 次）：${harness.errors.join(' | ')}`)
}

function toolResult(request, name) {
  return [...request.messages].reverse().find(message => message.role === 'tool' && message.name === name)?.content
}

function storedToolReply(harness, call) {
  return JSON.parse(harness.kv.get(sessionKey(GROUP))).agentHistory.find(message => message.role === 'tool' && message.tool_call_id === call.id)
}

function turnContext(request) {
  const content = request.messages.filter(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('【本轮执行检查】')).at(-1)?.content
  assert.ok(content, '每次模型请求应包含本轮动态状态')
  return JSON.parse(content.slice(content.lastIndexOf('【本轮执行检查】')).split('\n')[1])
}

function seededGoal(harness, id = 'goal-seeded') {
  const scope = harness.scope()
  const state = createCharacterGoal(createEmptyCharacterState(scope), {
    id, title: '了解刚才提到的独立游戏', motivation: '这符合我持续关注的游戏兴趣', nextStep: '搜索开发者公开介绍',
    completionCriteria: '取得搜索工具成功回执', stopConditions: ['管理员取消', '来源不可用'], evidenceRefs: ['message:1'],
  }, ['message:1'], harness.clock.value)
  harness.kv.set(characterKey(scope), JSON.stringify(state))
  return state.goals[0]
}

test('当前请求给出动态阶段、剩余轮数和可见来源，普通聊天不会自动创建角色状态', async () => {
  const h = fixture()
  try {
    await h.ingest('只是聊聊，不用记住或安排什么'); await idle(h, 1)
    assert.deepEqual(turnContext(h.calls[0]), { phase: 'acting', remainingToolRounds: 8, focusedGoalId: null, visibleEvidenceRefs: ['message:1'] })
    const character = (await h.runtime.describeGroup(GROUP)).character
    assert.equal(character.memories.length, 0)
    assert.equal(character.goals.length, 0)
    assert.equal(character.decision, undefined)
  } finally { h.runtime.stop() }
})

const finishMemory = { kind: 'interest', content: '我对连贯线索设计保持兴趣', epistemic: 'inferred', evidenceRefs: ['message:1'] }
const finishGoal = { title: '收尾中保存的研究计划', motivation: '这符合我的线索设计兴趣', nextStep: '核对公开介绍', completionCriteria: '取得公开介绍并核对', stopConditions: ['管理员取消', '来源不可用'], evidenceRefs: ['message:1'], nextCheckInMinutes: 30 }

test('finish 的目标和记忆在发送 adapter 前已落盘，发送标读后按真实 call id 保存收尾结果并停止', async () => {
  let observed = false, h
  const finish = toolCall('simFinishTurn', { choice: 'schedule', reason: '我决定稍后研究', goal: finishGoal, memories: [finishMemory], messages: ['我稍后继续核对介绍'], throughSeq: 1 })
  h = fixture({ script: () => tools(finish), send: async (groupId, segments) => {
    const character = JSON.parse(h.kv.get(characterKey(h.scope())))
    assert.equal(character.goals.length, 1)
    assert.equal(character.goals[0].title, finishGoal.title)
    assert.equal(character.memories[0].content, finishMemory.content)
    assert.equal(character.goals[0].status, 'active')
    assert.equal(groupId, GROUP)
    assert.ok(JSON.stringify(segments).includes('稍后继续核对'))
    observed = true
    return { ok: true, messageId: 'finish-schedule-message' }
  } })
  try {
    await h.ingest('请按你的兴趣决定是否继续')
    await idle(h, 1)
    assert.equal(observed, true)
    assert.equal(h.calls.length, 1, '成功封口后不能再调用模型')
    assert.equal(h.sent.length, 1)
    const session = JSON.parse(h.kv.get(sessionKey(GROUP)))
    assert.equal(session.lastReadThroughSeq, 1); assert.deepEqual(session.unread, [])
    const reply = storedToolReply(h, finish)
    assert.equal(reply.name, 'simFinishTurn'); assert.equal(reply.tool_call_id, finish.id)
    const result = JSON.parse(reply.content)
    assert.equal(result.ok, true); assert.equal(result.choice, 'schedule'); assert.equal(result.saved, true)
    assert.equal(result.sendStatus, 'succeeded'); assert.equal(result.sent, 1); assert.equal(result.readStatus, 'succeeded')
    assert.equal(session.agentHistory.at(-1).tool_call_id, finish.id)
  } finally { h.runtime.stop() }
})

test('finish complete 先保存终态再公告一次，同一 batch 后续工具全部不执行且保留协议响应', async () => {
  let goal, finish, after = [], h, sawCompletedBeforeSend = false
  h = fixture({ script: (request, index) => {
    if (index === 0) {
      assert.equal(turnContext(request).focusedGoalId, goal.id)
      return tools(toolCall('searchInformationTool', {}))
    }
    const receipt = JSON.parse(toolResult(request, 'searchInformationTool').match(/【运行时行动回执】(.*)$/u)[1])
    assert.equal(receipt.status, 'succeeded')
    assert.ok(turnContext(request).visibleEvidenceRefs.includes(receipt.evidenceRef))
    finish = toolCall('simFinishTurn', { choice: 'complete', reason: '已取得本目标所需资料', goal: { id: goal.id, evidenceRefs: [receipt.evidenceRef], outcome: '已取得公开搜索结果' }, messages: ['公开资料已经找到了'], throughSeq: 1 })
    after = [
      toolCall('searchInformationTool', {}), toolCall('simSendMessage', { messages: ['这一条不能重复发出'] }),
      toolCall('simCharacterMemory', { action: 'remember', kind: 'opinion', content: '封口后不能新增的观点', epistemic: 'inferred', evidenceRefs: [receipt.evidenceRef] }),
      toolCall('simMarkRead', { throughSeq: 999 }),
      toolCall('simFinishTurn', { choice: 'chat', reason: '不能重复提交', messages: ['重复的收尾消息'] }),
    ]
    return tools(finish, ...after)
  }, send: async () => {
    const character = JSON.parse(h.kv.get(characterKey(h.scope())))
    assert.equal(character.goals[0].status, 'completed', '不能先公告成功再尝试提交目标完成')
    sawCompletedBeforeSend = true
    return { ok: true, messageId: 'finish-complete-message' }
  } })
  try {
    await h.ingest('用于目标的真实来源', '30000', { at: false })
    goal = seededGoal(h)
    h.clock.value = goal.nextCheckAt
    await h.runtime.sweepOnce(); await idle(h, 2)
    assert.equal(sawCompletedBeforeSend, true)
    assert.equal(h.calls.length, 2); assert.equal(h.sent.length, 1)
    assert.deepEqual(h.events.map(item => item.name), ['searchInformationTool'])
    const character = JSON.parse(h.kv.get(characterKey(h.scope())))
    assert.equal(character.goals[0].status, 'completed'); assert.equal(character.memories.length, 0)
    const session = JSON.parse(h.kv.get(sessionKey(GROUP)))
    assert.equal(session.lastReadThroughSeq, 1); assert.deepEqual(session.unread, [])
    const result = JSON.parse(storedToolReply(h, finish).content)
    assert.equal(result.ok, true); assert.equal(result.choice, 'complete'); assert.equal(result.saved, true)
    assert.equal(result.sendStatus, 'succeeded'); assert.equal(result.sent, 1)
    for (const call of after) {
      const response = storedToolReply(h, call)
      assert.ok(response, `被封口的 ${call.function.name} 也需要匹配 tool_call_id 的协议响应`)
      assert.match(response.content, /^error:/)
    }
  } finally { h.runtime.stop() }
})

test('非法 complete、越界 throughSeq 和存储失败都不发送或标读，也不写入部分记忆目标', async () => {
  for (const failure of ['complete', 'throughSeq', 'storage']) {
    let attempted, failedWrites = 0
    const h = fixture({ script: (_request, index) => {
      if (index > 0) return tools(toolCall('simFinishTurn', { choice: 'silent', reason: '本轮不再行动' }))
      const input = failure === 'complete'
        ? { choice: 'complete', reason: '没有成功回执的完成申请', goal: { id: 'missing-goal', evidenceRefs: ['message:1'] }, memories: [finishMemory] }
        : { choice: 'schedule', reason: '先验证再执行', goal: finishGoal, memories: [finishMemory] }
      attempted = toolCall('simFinishTurn', { ...input, messages: ['这条消息不得发出'], throughSeq: failure === 'throughSeq' ? 999 : 1 })
      return tools(attempted)
    }, writeFault: async (key, value) => {
      if (failure === 'storage' && key === characterKey({ botId: BOT, personaId: 'shiloh', groupId: GROUP }) && JSON.parse(value).memories.some(memory => memory.content === finishMemory.content)) {
        failedWrites++; throw new Error('injected closure persistence failure')
      }
    } })
    try {
      await h.ingest(); await idle(h, 2)
      assert.equal(h.sent.length, 0, failure)
      const session = JSON.parse(h.kv.get(sessionKey(GROUP)))
      assert.equal(session.lastReadThroughSeq, 0, failure)
      assert.equal(session.unread.length, 1, failure)
      const character = JSON.parse(h.kv.get(characterKey(h.scope())))
      assert.equal(character.memories.length, 0, failure); assert.equal(character.goals.length, 0, failure)
      assert.match(storedToolReply(h, attempted).content, /^error:/, failure)
      if (failure === 'storage') assert.equal(failedWrites, 1)
    } finally { h.runtime.stop() }
  }
})

test('finish 参数或存储失败后锁定收尾，连续普通最终文本和同批或后续显式发送都不能绕过', async () => {
  for (const failure of ['parameters', 'storage']) for (const fallback of ['text', 'send']) {
    let attempted, sameBatchSend, laterSend, failedWrites = 0
    const announcement = '后续研究已经安排并保存好了，我会继续核对公开资料'
    const h = fixture({ script: (_request, index) => {
      if (index === 0) {
        attempted = toolCall('simFinishTurn', { choice: 'schedule', reason: failure === 'parameters' ? '' : '尝试保存后续计划', goal: finishGoal, memories: [finishMemory], messages: [announcement], throughSeq: 1 })
        sameBatchSend = toolCall('simSendMessage', { messages: [announcement] })
        return tools(attempted, sameBatchSend)
      }
      if (index === 1 && fallback === 'send') {
        laterSend = toolCall('simSendMessage', { messages: [announcement] })
        return tools(laterSend)
      }
      return finalText(announcement)
    }, writeFault: async (key, value) => {
      if (failure === 'storage' && key === characterKey({ botId: BOT, personaId: 'shiloh', groupId: GROUP }) && JSON.parse(value).memories.some(memory => memory.content === finishMemory.content)) {
        failedWrites++; throw new Error('injected closure persistence failure')
      }
    } })
    try {
      const expectedCalls = fallback === 'send' ? 3 : 2
      await h.ingest(); await idle(h, expectedCalls)
      assert.equal(h.calls.length, expectedCalls, `${failure}/${fallback}：纯文本应直接结束，不能继续催发或兜底`)
      assert.equal(h.sent.length, 0, `${failure}/${fallback}`)
      for (const request of h.calls.slice(1)) {
        assert.deepEqual(request.tools.map(tool => tool.function.name), ['simFinishTurn'])
        assert.equal(request.tool_choice, 'required')
        assert.equal(turnContext(request).phase, 'closing')
      }
      assert.match(storedToolReply(h, attempted).content, /^error:/)
      assert.match(storedToolReply(h, sameBatchSend).content, /^error:/)
      if (laterSend) assert.match(storedToolReply(h, laterSend).content, /^error:/)
      const session = JSON.parse(h.kv.get(sessionKey(GROUP)))
      assert.equal(session.lastReadThroughSeq, 0); assert.equal(session.unread.length, 1)
      assert.equal(session.agentHistory.some(message => message.content?.includes('【系统提醒】你刚才写的这段话群友看不到')), false)
      const character = JSON.parse(h.kv.get(characterKey(h.scope())))
      assert.equal(character.memories.length, 0); assert.equal(character.goals.length, 0); assert.equal(character.decision, undefined)
      assert.equal(character.receipts.some(receipt => receipt.toolName === 'simSendMessage'), false)
      if (failure === 'storage') assert.equal(failedWrites, 1)
    } finally { h.runtime.stop() }
  }
})

test('finish 发送失败保留已保存计划和记忆，不回滚、不重试、不再调用模型', async () => {
  let sends = 0
  const finish = toolCall('simFinishTurn', { choice: 'schedule', reason: '明确的后续计划', goal: finishGoal, memories: [finishMemory], messages: ['我稍后继续研究'] })
  const h = fixture({ script: () => tools(finish), send: async () => { sends++; return { ok: false, error: '网关发送结果未确认' } } })
  try {
    await h.ingest(); await idle(h, 1)
    assert.equal(sends, 1); assert.equal(h.sent.length, 0); assert.equal(h.calls.length, 1)
    const character = JSON.parse(h.kv.get(characterKey(h.scope())))
    assert.equal(character.memories[0].content, finishMemory.content)
    assert.equal(character.goals.length, 1); assert.equal(character.goals[0].status, 'active')
    const result = JSON.parse(storedToolReply(h, finish).content)
    assert.equal(result.ok, true); assert.equal(result.saved, true); assert.equal(result.choice, 'schedule')
    assert.equal(result.sendStatus, 'failed'); assert.equal(result.sent, 0); assert.equal(result.readStatus, 'not_requested')
  } finally { h.runtime.stop() }
})

test('finish 提交后目标被取消、人设切换或源记忆删除时不能公告或标读，旧状态不能复活', async () => {
  for (const change of ['cancel', 'persona', 'source']) {
    let injected = false, h
    const finish = toolCall('simFinishTurn', { choice: 'schedule', reason: '本轮决定继续研究', goal: { ...finishGoal, evidenceRefs: ['memory:source-before-close'] }, messages: ['这个安排已经保存'], throughSeq: 2 })
    h = fixture({ script: () => tools(finish), onSave: async (key, value) => {
      if (injected || key !== characterKey(h.scope())) return
      const current = JSON.parse(value)
      if (!current.goals.some(goal => goal.title === finishGoal.title)) return
      injected = true
      if (change === 'persona') { h.identity.id = 'switched-after-commit'; return }
      if (change === 'source') {
        const revoked = deleteCharacterMemory(current, 'source-before-close', h.clock.value)
        revoked.revision = current.revision + 1
        h.kv.set(key, JSON.stringify(revoked))
        h.kv.set(`${sessionKey(GROUP)}:activity-version`, 'source-revoked-after-commit')
      } else {
        current.goals[0].status = 'abandoned'; current.goals[0].revision++; current.goals[0].lastOutcome = '管理员提交后取消'
        current.revision++
        h.kv.set(key, JSON.stringify(current))
      }
    } })
    try {
      await h.ingest('本轮此前已有的兴趣来源', '40000', { at: false })
      const source = addCharacterMemory(createEmptyCharacterState(h.scope()), { id: 'source-before-close', kind: 'interest', content: '我持续关注的线索设计', epistemic: 'inferred', evidenceRefs: ['message:1'] }, ['message:1'], h.clock.value)
      const originalKey = characterKey(h.scope())
      h.kv.set(originalKey, JSON.stringify(source))
      await h.ingest('现在决定是否继续')
      await idle(h, 1)
      assert.equal(injected, true, change)
      assert.equal(h.sent.length, 0, change)
      const session = JSON.parse(h.kv.get(sessionKey(GROUP)))
      assert.equal(session.lastReadThroughSeq, 0, change)
      assert.equal(session.unread.length, 2, change)
      const current = JSON.parse(h.kv.get(originalKey))
      assert.equal(current.goals.length, 1, change)
      if (change !== 'persona') assert.equal(current.goals[0].status, 'abandoned', change)
      if (change === 'source') assert.equal(current.memories.some(memory => memory.id === 'source-before-close'), false)
      if (change === 'persona') assert.equal(h.identity.id, 'switched-after-commit')
    } finally { h.runtime.stop() }
  }
})

test('聚焦目标在收尾公告登记后到期，旧 permit 不能发送最终消息或标读', async () => {
  let goal, expired = false, h
  const finish = toolCall('simFinishTurn', { choice: 'chat', reason: '只汇报当前想法，不改目标', messages: ['我还在核对这款游戏'], throughSeq: 1 })
  h = fixture({ script: () => tools(finish), onSave: async (key, value) => {
    if (expired || key !== characterKey(h.scope())) return
    const current = JSON.parse(value)
    if (!current.receipts.some(receipt => receipt.toolName === 'simFinishTurn' && receipt.status === 'pending')) return
    expired = true
    h.clock.value = goal.expiresAt
  } })
  try {
    await h.ingest('用于目标的真实来源', '30000', { at: false })
    goal = seededGoal(h)
    h.clock.value = goal.nextCheckAt
    await h.runtime.sweepOnce(); await idle(h, 1)
    assert.equal(expired, true)
    assert.equal(turnContext(h.calls[0]).focusedGoalId, goal.id)
    assert.equal(h.calls.length, 1); assert.equal(h.sent.length, 0)
    const session = JSON.parse(h.kv.get(sessionKey(GROUP)))
    assert.equal(session.lastReadThroughSeq, 0); assert.equal(session.unread.length, 1)
    const result = JSON.parse(storedToolReply(h, finish).content)
    assert.equal(result.ok, true); assert.equal(result.saved, true)
    assert.equal(result.sendStatus, 'failed'); assert.equal(result.sent, 0); assert.equal(result.readStatus, 'failed')
    const character = JSON.parse(h.kv.get(characterKey(h.scope())))
    assert.equal(character.receipts.find(receipt => receipt.toolName === 'simFinishTurn').status, 'failed')
  } finally { h.runtime.stop() }
})

test('超长合法记忆和目标的 finish 回执压缩为可核对哈希，仍保留完整 JSON 和发送标读状态', async () => {
  const memories = [{ ...finishMemory, content: '源'.repeat(1200) }, { ...finishMemory, kind: 'opinion', content: '观'.repeat(1200) }]
  const goal = { ...finishGoal, title: '题'.repeat(160), motivation: '动'.repeat(600), nextStep: '步'.repeat(600), completionCriteria: '验'.repeat(600), stopConditions: ['停'.repeat(300)] }
  const finish = toolCall('simFinishTurn', { choice: 'schedule', reason: '完整保存合法的详细记录', memories, goal, messages: ['详细记录和后续安排已经保存'], throughSeq: 1 })
  const h = fixture({ script: () => tools(finish) })
  try {
    await h.ingest(); await idle(h, 1)
    assert.equal(h.calls.length, 1); assert.equal(h.sent.length, 1)
    const character = JSON.parse(h.kv.get(characterKey(h.scope())))
    assert.equal(character.memories.length, 2); assert.equal(character.goals.length, 1)
    assert.deepEqual(character.memories.map(memory => memory.content), memories.map(memory => memory.content))
    assert.equal(character.goals[0].completionCriteria, goal.completionCriteria)
    assert.ok(JSON.stringify({ memories: character.memories, goal: character.goals[0] }).length > 3500, '本用例必须触发真实的长回执压缩')
    const reply = storedToolReply(h, finish)
    const result = JSON.parse(reply.content)
    assert.ok(reply.content.length <= 3500, '不能靠截断 JSON 适配历史上限')
    assert.equal(result.ok, true); assert.equal(result.saved, true); assert.equal(result.choice, 'schedule')
    assert.equal(result.sendStatus, 'succeeded'); assert.equal(result.sent, 1); assert.equal(result.readStatus, 'succeeded')
    const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
    const savedGoal = character.goals[0]
    assert.deepEqual(result.goal, { id: savedGoal.id, revision: savedGoal.revision, status: savedGoal.status, recordHash: hash(savedGoal) })
    assert.deepEqual(result.memories, character.memories.map(memory => ({ id: memory.id, recordHash: hash(memory) })))
    const session = JSON.parse(h.kv.get(sessionKey(GROUP)))
    assert.equal(session.lastReadThroughSeq, 1); assert.deepEqual(session.unread, [])
    assert.equal(session.agentHistory.at(-1).tool_call_id, finish.id)
  } finally { h.runtime.stop() }
})

test('finish 提交合法 throughSeq 时只标读已展示消息，模型请求期间的新入站继续保持未读', async () => {
  let arrived = false, h
  const finish = toolCall('simFinishTurn', { choice: 'chat', reason: '回应本轮实际展示的消息', messages: ['刚才的消息我看到了'], throughSeq: 1 })
  h = fixture({ script: async request => {
    assert.deepEqual(turnContext(request).visibleEvidenceRefs, ['message:1'])
    await h.ingest('这是一条后到的背景消息', '50000', { at: false })
    arrived = true
    return tools(finish)
  } })
  try {
    await h.ingest(); await idle(h, 1)
    assert.equal(arrived, true); assert.equal(h.calls.length, 1); assert.equal(h.sent.length, 1)
    const session = JSON.parse(h.kv.get(sessionKey(GROUP)))
    assert.equal(session.lastReadThroughSeq, 1)
    assert.deepEqual(session.unread.map(message => ({ seq: message.seq, text: message.text })), [{ seq: 2, text: '这是一条后到的背景消息' }])
    assert.deepEqual(session.modelSeenSeqs, [])
    const result = JSON.parse(storedToolReply(h, finish).content)
    assert.equal(result.ok, true); assert.equal(result.saved, true)
    assert.equal(result.sendStatus, 'succeeded'); assert.equal(result.sent, 1); assert.equal(result.readStatus, 'succeeded')
  } finally { h.runtime.stop() }
})

test('最后两轮只暴露 finish 并强制 required，provider 忽视工具限制也不能执行其他动作或兜底发送', async () => {
  let rejected = []
  const h = fixture({ maxToolRounds: 4, script: (_request, index) => {
    if (index < 2) return tools(toolCall('searchInformationTool', {}))
    if (index === 2) {
      rejected = [toolCall('searchInformationTool', {}), toolCall('simSendMessage', { messages: ['收尾阶段不能发送的普通消息'] }), toolCall('simMarkRead', { throughSeq: 1 }), toolCall('simCharacterMemory', { action: 'remember', ...finishMemory })]
      return tools(...rejected)
    }
    return finalText('我已经安排了后续研究，这段纯文本也不能被兜底发送')
  } })
  try {
    await h.ingest(); await idle(h, 4)
    assert.equal(h.calls.length, 4, 'provider 忽视 required 不能导致无限续轮')
    assert.deepEqual(h.events.map(item => item.name), ['searchInformationTool', 'searchInformationTool'])
    for (const [index, remaining] of [[2, 2], [3, 1]]) {
      assert.deepEqual(h.calls[index].tools.map(tool => tool.function.name), ['simFinishTurn'])
      assert.equal(h.calls[index].tool_choice, 'required')
      assert.equal(turnContext(h.calls[index]).phase, 'closing')
      assert.equal(turnContext(h.calls[index]).remainingToolRounds, remaining)
    }
    for (const call of rejected) assert.match(storedToolReply(h, call).content, /^error:/)
    assert.equal(h.sent.length, 0)
    const session = JSON.parse(h.kv.get(sessionKey(GROUP)))
    assert.equal(session.lastReadThroughSeq, 0); assert.equal(session.unread.length, 1)
    const character = JSON.parse(h.kv.get(characterKey(h.scope())))
    assert.equal(character.memories.length, 0); assert.equal(character.goals.length, 0); assert.equal(character.decision, undefined)
    assert.equal(character.receipts.filter(receipt => receipt.toolName === 'searchInformationTool').length, 2)
    assert.equal(character.receipts.some(receipt => receipt.toolName === 'simSendMessage'), false)
  } finally { h.runtime.stop() }
})

test('被 @ 回合工具主体来自 reason.seq，不借用第一条未读群友身份', async () => {
  const h = fixture({ script: (_request, index) => index === 0 ? tools(toolCall('ownerAdminTool', {})) : quiet() })
  try {
    await h.ingest('刚才大家在聊的背景', '30000', { at: false })
    await h.ingest('请查一下这件事', '40000')
    await idle(h, 2)
    assert.equal(h.events.length, 1)
    assert.equal(h.events[0].event.user_id, 40000)
    assert.equal(h.events[0].event.simulationActor.userId, '40000')
    assert.equal(h.events[0].event.simulationActor.kind, 'user')
    const recent = JSON.parse(h.kv.get(sessionKey(GROUP))).recent
    assert.equal(recent[0].userId, '30000', '确实存在更早的另一位未读群友')
    assert.ok(h.calls[0].tools.some(tool => tool.function.name === 'ownerAdminTool'))
  } finally { h.runtime.stop() }
})

test('新会话第一条 @ 同样绑定真实群友，不被 bootstrap 丢失身份', async () => {
  const h = fixture({ seed: false, script: (_request, index) => index === 0 ? tools(toolCall('ownerAdminTool', {})) : quiet() })
  try {
    await h.ingest('请执行我的请求', '40000')
    await idle(h, 2)
    assert.equal(h.events.length, 1)
    assert.equal(h.events[0].event.user_id, 40000)
    assert.equal(h.events[0].event.simulationActor.kind, 'user')
  } finally { h.runtime.stop() }
})

test('主动空闲唤醒无 user_id，管理员工具和伪 sim 前缀工具既不暴露也不能绕过清单执行', async () => {
  const h = fixture({ proactiveProbability: 1, script: (_request, index) => index === 0
    ? tools(toolCall('ownerAdminTool', {}), toolCall('simDangerTool', {}), toolCall('searchInformationTool', {})) : quiet() })
  try {
    await h.ingest('上一位群友的普通聊天', '30000', { at: false })
    h.clock.value += 2 * 60 * 60_000
    await h.runtime.sweepOnce()
    await idle(h, 2)
    assert.equal((await h.runtime.describeGroup(GROUP)).lastWakeReason, 'proactiveCheck')
    assert.deepEqual(h.events.map(item => item.name), ['searchInformationTool'])
    assert.equal('user_id' in h.events[0].event, false)
    assert.equal('sender' in h.events[0].event, false)
    assert.equal(h.events[0].event.simulationActor.kind, 'autonomous')
    assert.equal(h.calls[0].tools.some(tool => tool.function.name === 'ownerAdminTool'), false)
    assert.equal(h.calls[0].tools.some(tool => tool.function.name === 'simDangerTool'), false)
    assert.match(toolResult(h.calls[1], 'ownerAdminTool'), /自主执行主体没有此工具权限/)
    assert.match(toolResult(h.calls[1], 'simDangerTool'), /自主执行主体没有此工具权限/)
  } finally { h.runtime.stop() }
})

test('已明确欢迎的到期待办只唤醒一次，重启后空回音和相同入站不会再次唤醒', async () => {
  const memoryKey = `shiloh:sim:g:${GROUP}:memories`
  const h = fixture({ proactiveProbability: 1, script: () => tools(toolCall('simFinishTurn', {
    choice: 'chat', reason: '只问这一回', messages: ['纸灯展布置得怎么样？'],
  })) })
  try {
    await h.ingest('明天展览布置完，欢迎到群里问我一句', '40000', { at: false })
    h.kv.set(memoryKey, JSON.stringify([
      { id: 'old', kind: 'pendingEvent', content: '旧待办没有主动许可', aboutUser: '40000', dueAt: BASE_AT + 3600_000 },
      { id: 'welcome', kind: 'pendingEvent', content: '问纸灯展布展情况', aboutUser: '40000', dueAt: BASE_AT + 86400_000, proactiveSourceSeq: 1 },
    ]))
    h.clock.value += 86460_000
    await h.runtime.sweepOnce()
    await idle(h, 1)
    const saved = JSON.parse(h.kv.get(sessionKey(GROUP)))
    assert.deepEqual(saved.offeredFollowUpIds, ['welcome'])
    assert.equal(h.sent.length, 1)
    assert.match(h.calls[0].messages.map(message => message.content).join('\n'), /问纸灯展布展情况.*这次主动检查的事/)
    assert.ok(!JSON.parse(h.kv.get(memoryKey)).find(memory => memory.id === 'welcome').done)
  } finally { h.runtime.stop() }
  const restarted = fixture({ kv: h.kv, clock: h.clock, proactiveProbability: 1 })
  try {
    h.clock.value += 7200_000
    await restarted.runtime.sweepOnce()
    await sleep(1150)
    assert.equal(restarted.calls.length, 0)
    assert.equal(JSON.parse(h.kv.get(sessionKey(GROUP))).nextReplyCheckAt, 0)
    await restarted.ingest('新话题，聊聊纸灯怎么折', '40001')
    await idle(restarted, 1)
  } finally { restarted.runtime.stop() }
})

test('本群相处习惯和已发送回复用于原对话对象，不冒充其他人的互动', async () => {
  const h = fixture({ script: (_request, index) => {
    if (index === 0) return tools(
      toolCall('simRemember', { kind: 'interaction', aboutUser: '40000', content: '对方说不喜欢被叫宝' }),
      toolCall('simUpdateAffinity', { userId: '40000', delta: 1, reason: '对方直接说清了喜欢的称呼' }),
    )
    if (index === 1) return tools(toolCall('simFinishTurn', { choice: 'chat', reason: '回应对方', messages: ['行，那就叫你阿晓'] }))
    return quiet()
  } })
  try {
    await h.ingest('叫我阿晓就行，别叫我宝')
    await idle(h, 2)
    assert.equal(h.sent.length, 1, JSON.stringify({ errors: h.errors, history: JSON.parse(h.kv.get(sessionKey(GROUP))).agentHistory.filter(message => message.role === 'tool') }))
    assert.ok(!h.writes.some(write => write.key === 'shiloh:sim:person:40000'), '相处习惯不写跨群档案')
    await h.ingest('对，就是这样叫', '40000')
    await idle(h, 3)
    const same = h.calls[2].messages.filter(message => message.role === 'user').at(-2)?.content || ''
    assert.match(same, /对方说不喜欢被叫宝/)
    assert.match(same, /你上一轮给此人的已发送消息.*\n.*那就叫你阿晓/)
    await h.ingest('你怎么称呼我？', '40001')
    await idle(h, 4)
    const other = h.calls[3].messages.filter(message => message.role === 'user').at(-2)?.content || ''
    assert.doesNotMatch(other, /你上一轮给此人的已发送消息/)
  } finally { h.runtime.stop() }
})

test('点名接话隔离另一人的快照和历史，引用及显式查阅仍能看见原话', async () => {
  const h = fixture({ script: (_request, index) => {
    if (index === 0) return tools(toolCall('simFinishTurn', { choice: 'chat', reason: '接梗', messages: ['两块饼干成交'], throughSeq: 1 }))
    if (index === 2) return tools(toolCall('simFinishTurn', { choice: 'chat', reason: '继续接梗', messages: ['第三块一人一半'] }))
    if (index === 3) return tools(toolCall('simGetMessageDetail', { seq: 2 }))
    return quiet()
  } })
  try {
    await h.ingest('我给你两块饼干当工资')
    await idle(h, 1)
    await h.ingest('烤箱旁边是蓝色计时器', '40001')
    await idle(h, 2)
    await h.ingest('第三块你分我一半', '40000')
    await idle(h, 3)
    const direct = h.calls[2].messages.map(m => m.content).join('\n')
    assert.match(direct, /第三块你分我一半/)
    assert.match(direct, /两块饼干成交/)
    assert.doesNotMatch(direct, /烤箱|蓝色计时器/)
    assert.deepEqual(turnContext(h.calls[2]).visibleEvidenceRefs.filter(ref => ref.startsWith('message:')), ['message:1', 'message:3'])
    await h.ingest('请再查第二条，烤箱旁边是什么？', '40000', { source: { user_id: '40001', text: '烤箱旁边是蓝色计时器' } })
    await idle(h, 5)
    assert.match(h.calls[3].messages.map(m => m.content).join('\n'), /引用.*蓝色计时器/)
    assert.match(toolResult(h.calls[4], 'simGetMessageDetail'), /蓝色计时器/)
    assert.ok(turnContext(h.calls[4]).visibleEvidenceRefs.includes('message:2'))
  } finally { h.runtime.stop() }
})

test('合并窗内两个群友分别点名会获得独立回合', async () => {
  const h = fixture({ script: (_request, index) => tools(toolCall('simFinishTurn', {
    choice: 'chat', reason: '回答当前群友', messages: [index === 0 ? '饼干成交' : '看看烤箱说明'], throughSeq: index + 1,
  })) })
  try {
    await h.ingest('给你两块饼干，成交吗？', '40000')
    await h.ingest('新烤箱怎么设置？', '40001')
    await idle(h, 2)
    const first = h.calls[0].messages.map(message => message.content).join('\n')
    const second = h.calls[1].messages.map(message => message.content).join('\n')
    assert.match(first, /饼干/)
    assert.doesNotMatch(first, /新烤箱/)
    assert.match(second, /新烤箱/)
    assert.doesNotMatch(second, /饼干成交|两块饼干/)
    assert.equal(h.sent.length, 2)
  } finally { h.runtime.stop() }
})

test('误填主动许可和社交目标均不能用模型改写替代当事人原话', async () => {
  const original = '明天面试完，碰巧聊到你再问一句，别特意催'
  const judgments = []
  const h = fixture({ proactiveProbability: 1, judgeSocialPermission: async request => {
    judgments.push(JSON.parse(request.messages[1].content))
    const verdict = judgments.at(-1).action === 'follow_up' ? 'explicit_invitation' : 'conversation_only'
    return { choices: [{ message: { content: JSON.stringify({ verdict, quote: original }) } }] }
  }, script: (_request, index) => {
    if (index === 0) return tools(toolCall('simRemember', { kind: 'pendingEvent', content: '对方允许明天主动问', dueInMinutes: 1440, welcomeProactiveFollowUp: true }))
    if (index === 1) return tools(toolCall('simFinishTurn', { choice: 'schedule', reason: '等对方露面', goal: finishGoal }))
    return tools(toolCall('simFinishTurn', { choice: 'chat', reason: '普通接续', messages: ['聊到了再问'] }))
  } })
  try {
    await h.ingest(original)
    await idle(h, 3)
    assert.deepEqual(judgments.map(item => [item.action, item.original]), [['follow_up', original], ['goal', original]])
    const saved = JSON.parse(h.kv.get(`shiloh:sim:g:${GROUP}:memories`))[0]
    assert.equal(saved.proactiveSourceSeq, undefined)
    assert.match(toolResult(h.calls[1], 'simRemember'), /"proactiveApproved":false/)
    assert.equal((await h.runtime.describeGroup(GROUP)).character.goals.length, 0)
    h.clock.value += 86460_000
    await h.runtime.sweepOnce()
    await sleep(1150)
    assert.equal(h.calls.length, 3)
    assert.equal(h.sent.length, 1)
  } finally { h.runtime.stop() }
})

test('直接点名回合把回答正文漏写到收尾参数外时可以纠正一次', async () => {
  const h = fixture({ script: (_request, index) => index === 0
    ? { ...tools(toolCall('simFinishTurn', { choice: 'chat', reason: '回答了对方' })), content: '看说明书的上下管独立控温一栏。' }
    : tools(toolCall('simFinishTurn', { choice: 'chat', reason: '回答烤箱设置', messages: ['看看说明书的上下管独立控温一栏。'] })) })
  try {
    await h.ingest('新烤箱怎么设置？')
    await idle(h, 2)
    assert.match(toolResult(h.calls[1], 'simFinishTurn'), /群友看不到/)
    assert.equal(h.sent.length, 1)
  } finally { h.runtime.stop() }
})

test('触发原话被截断时不能授予主动跟进', async () => {
  let reviewed = false
  const h = fixture({
    judgeSocialPermission: async () => { reviewed = true; throw new Error('不应审核被截断的发言') },
    script: (_request, index) => index === 0
      ? tools(toolCall('simRemember', { kind: 'pendingEvent', content: '对方允许明天主动问', dueInMinutes: 1440, welcomeProactiveFollowUp: true }))
      : quiet(),
  })
  try {
    await h.ingest(`明天你可以主动问我。${'补充内容'.repeat(80)}不过碰巧聊到再问`)
    await idle(h, 2)
    assert.equal(reviewed, false)
    assert.match(toolResult(h.calls[1], 'simRemember'), /"proactiveApproved":false/)
  } finally { h.runtime.stop() }
})

test('simDecide silent 后普通最终文本不会触发提醒、兜底发送或任何群消息', async () => {
  const h = fixture({ script: (_request, index) => index === 0
    ? tools(toolCall('simDecide', { kind: 'silent', reason: '我更想先听大家聊' }))
    : finalText('今天这个话题我也有一点自己的想法') })
  try {
    await h.ingest()
    await idle(h, 2)
    assert.equal(h.calls.length, 2)
    assert.equal(h.sent.length, 0)
    assert.equal((await h.runtime.describeGroup(GROUP)).character.decision.kind, 'silent')
  } finally { h.runtime.stop() }
})

for (const wake of ['proactiveCheck', 'characterGoal']) {
  test(`${wake} 自主回合的普通最终文本只留在历史，不催发、不兜底、不伪造决定`, async () => {
    const text = wake === 'proactiveCheck'
      ? '刚看到订阅有更新，但群里一个多小时没人说话，我就不主动甩链接打扰了，安静记着，等有人聊到纸灯塔再说。继续潜水。'
      : '我已经整理出这款游戏值得继续研究的三个方向'
    const h = fixture({ proactiveProbability: wake === 'proactiveCheck' ? 1 : 0, script: () => finalText(text) })
    try {
      await h.ingest('用于自主兴趣来源的普通消息', '30000', { at: false })
      h.clock.value = wake === 'characterGoal' ? seededGoal(h).nextCheckAt : h.clock.value + 2 * 60 * 60_000
      await h.runtime.sweepOnce()
      await idle(h, 1)
      const detail = await h.runtime.describeGroup(GROUP)
      assert.equal(detail.lastWakeReason, wake)
      assert.equal(h.calls.length, 1, '普通最终文本直接结束自主回合，不能追加发送提醒')
      assert.equal(h.sent.length, 0)
      assert.equal(detail.character.decision, undefined, '最终文本不能被运行时改写成 simDecide')
      const history = JSON.parse(h.kv.get(sessionKey(GROUP))).agentHistory
      assert.ok(history.some(message => message.role === 'assistant' && message.content === text))
      assert.equal(history.some(message => message.content?.includes('【系统提醒】你刚才写的这段话群友看不到')), false)
    } finally { h.runtime.stop() }
  })
}

test('用户回合聚焦自主目标后，按当前主体保留最终文本且不催发', async () => {
  let goal
  const text = '我想先把这款游戏的研究方向整理在自己的记录里'
  const h = fixture({ script: (_request, index) => index === 0
    ? tools(toolCall('simGoal', { action: 'focus', id: goal.id })) : finalText(text) })
  try {
    await h.ingest('用于目标来源的普通消息', '30000', { at: false })
    goal = seededGoal(h)
    h.clock.value = goal.nextCheckAt
    await h.ingest('看看你自己的研究目标')
    await idle(h, 2)
    assert.doesNotMatch(toolResult(h.calls[1], 'simGoal'), /^error:/)
    assert.equal(h.calls.length, 2)
    assert.equal(h.sent.length, 0)
    assert.equal((await h.runtime.describeGroup(GROUP)).character.decision, undefined)
    assert.ok(JSON.parse(h.kv.get(sessionKey(GROUP))).agentHistory.some(message => message.content === text))
  } finally { h.runtime.stop() }
})

test('到期自主目标自动聚焦后 wait 成功即收尾，后续发送仍被版本保护拒绝', async () => {
  let goal
  const nextStep = '等官方补充后继续核对玩法资料'
  const h = fixture({ script: (_request, index) => index === 0
    ? tools(toolCall('simGoal', { action: 'wait', id: goal.id, nextStep, nextCheckInMinutes: 30, outcome: '现有资料不足，先等待新来源' }))
    : index === 1 ? tools(toolCall('simSendMessage', { messages: ['等待更新已保存后也不该继续发送这条消息'] })) : quiet() })
  try {
    await h.ingest('用于自主目标的可见来源', '30000', { at: false })
    goal = seededGoal(h)
    h.clock.value = goal.nextCheckAt
    await h.runtime.sweepOnce()
    await idle(h, 3)
    const waited = JSON.parse(toolResult(h.calls[1], 'simGoal'))
    assert.equal(waited.ok, true)
    assert.equal(waited.goal.id, goal.id)
    assert.equal(waited.goal.attempts, 1, '到期回合须已由运行时自动聚焦目标')
    assert.equal(waited.goal.status, 'waiting')
    assert.equal(waited.goal.nextStep, nextStep)
    assert.equal(waited.goal.nextCheckAt, h.clock.value + 30 * 60_000)
    assert.equal(waited.goal.revision, goal.revision + 2, '自动聚焦和 wait 更新各推进一次版本')
    assert.match(toolResult(h.calls[2], 'simSendMessage'), /^error:/, 'wait 改变版本后不能沿用本轮旧授权发送')
    const detail = await h.runtime.describeGroup(GROUP)
    assert.equal(detail.lastWakeReason, 'characterGoal')
    assert.equal(detail.character.goals.length, 1, '继续已有目标不能额外创建目标')
    assert.equal(detail.character.goals[0].revision, waited.goal.revision)
    assert.equal(detail.character.receipts.some(receipt => receipt.toolName === 'simSendMessage'), false, '发送须在登记外部动作前被拦截')
    assert.equal(h.calls.length, 3)
    assert.equal(h.sent.length, 0)
  } finally { h.runtime.stop() }
})

for (const wake of ['atMention', 'commitment']) {
  test(`${wake} 普通最终文本仍提醒一次，再经原有兜底发送`, async () => {
    const text = '这款游戏里的谜题设计确实很有意思'
    const h = fixture({ script: () => finalText(text) })
    try {
      if (wake === 'atMention') await h.ingest()
      else {
        await h.ingest('承诺的消息来源', '30000', { at: false })
        await h.runtime.wakeForCommitment(GROUP, '分享刚才整理的游戏看法')
      }
      await idle(h, 2)
      assert.equal(h.calls.length, 2)
      assert.equal((await h.runtime.describeGroup(GROUP)).lastWakeReason, wake)
      assert.ok(h.calls[1].messages.some(message => message.content?.includes('【系统提醒】你刚才写的这段话群友看不到')))
      assert.equal(h.sent.length, 1)
      assert.ok(JSON.stringify(h.sent[0].segments).includes(text))
    } finally { h.runtime.stop() }
  })
}

test('自主回合仍可显式调用 simSendMessage 发送', async () => {
  const text = '刚查到这款游戏的新资料，我想分享一下'
  const h = fixture({ proactiveProbability: 1, script: (_request, index) => index === 0
    ? tools(toolCall('simSendMessage', { messages: [text] })) : quiet() })
  try {
    await h.ingest('上一位群友的普通聊天', '30000', { at: false })
    h.clock.value += 2 * 60 * 60_000
    await h.runtime.sweepOnce()
    await idle(h, 2)
    assert.doesNotMatch(toolResult(h.calls[1], 'simSendMessage'), /^error:/)
    assert.equal(h.sent.length, 1)
    assert.ok(JSON.stringify(h.sent[0].segments).includes(text))
  } finally { h.runtime.stop() }
})

test('自主回合显式 simDecide silent 仍阻止后续工具发送和最终文本发送', async () => {
  const h = fixture({ proactiveProbability: 1, script: (_request, index) => index === 0
    ? tools(toolCall('simDecide', { kind: 'silent', reason: '我想先听大家聊' }))
    : index === 1 ? tools(toolCall('simSendMessage', { messages: ['这条消息不应发送'] }))
      : finalText('今天这个话题我也有一点自己的想法') })
  try {
    await h.ingest('上一位群友的普通聊天', '30000', { at: false })
    h.clock.value += 2 * 60 * 60_000
    await h.runtime.sweepOnce()
    await idle(h, 3)
    assert.equal(h.calls.length, 3)
    assert.equal(h.sent.length, 0)
    assert.match(toolResult(h.calls[2], 'simSendMessage'), /本轮已选择沉默或暂缓/)
    assert.equal((await h.runtime.describeGroup(GROUP)).character.decision.kind, 'silent')
  } finally { h.runtime.stop() }
})

test('目标至少 15 分钟后经 sweep 唤醒，跨 runtime 重启后完成工具回执、观察记忆、目标闭环', async () => {
  const kv = new Map()
  const clock = { value: BASE_AT }
  const first = fixture({ kv, clock, script: (_request, index) => index === 0 ? tools(toolCall('simGoal', {
    action: 'create', title: '关注独立游戏的新资料', motivation: '这是我持续感兴趣的话题', nextStep: '搜索公开介绍',
    completionCriteria: '取得公开资料的成功工具回执', stopConditions: ['群友明确不想继续', '管理员取消'], evidenceRefs: ['message:1'],
  })) : quiet() })
  let goal
  try {
    await first.ingest('我最近在玩一款新的独立游戏')
    await idle(first, 2)
    goal = (await first.runtime.describeGroup(GROUP)).character.goals[0]
    assert.ok(goal)
    assert.ok(goal.nextCheckAt >= BASE_AT + CHARACTER_MIN_WAKE_MS)
  } finally { first.runtime.stop() }

  const next = fixture({ kv, clock, seed: false, script: (request, index) => {
    if (index === 0) return tools(toolCall('ownerAdminTool', {}), toolCall('searchInformationTool', {}))
    if (index === 1) {
      const result = toolResult(request, 'searchInformationTool')
      const receipt = JSON.parse(result.match(/【运行时行动回执】(.*)$/u)[1])
      assert.equal(receipt.status, 'succeeded')
      return tools(
        toolCall('simCharacterMemory', { action: 'remember', kind: 'experience', content: '搜索工具返回了这款游戏的公开资料', epistemic: 'observed', evidenceRefs: [receipt.evidenceRef] }),
        toolCall('simGoal', { action: 'complete', id: goal.id, evidenceRefs: [receipt.evidenceRef], outcome: '已取得公开搜索结果' }),
      )
    }
    return quiet()
  } })
  try {
    clock.value = goal.nextCheckAt - 1
    await next.runtime.sweepOnce()
    assert.equal(next.calls.length, 0, '未到目标时间不能调用模型')
    assert.equal((await next.runtime.describeGroup(GROUP)).character.goals[0].attempts, 0)
    clock.value = goal.nextCheckAt
    await next.runtime.sweepOnce()
    await idle(next, 3)
    const state = (await next.runtime.describeGroup(GROUP)).character
    assert.equal(state.goals[0].status, 'completed')
    assert.equal(state.goals[0].attempts, 1)
    assert.equal(state.memories[0].epistemic, 'observed')
    assert.ok(state.receipts.some(receipt => receipt.toolName === 'simGoalCheck' && receipt.status === 'unknown'))
    const succeeded = state.receipts.find(receipt => receipt.toolName === 'searchInformationTool')
    assert.equal(succeeded.status, 'succeeded')
    assert.ok(state.goals[0].evidenceRefs.includes(`receipt:${succeeded.id}`))
    assert.deepEqual(next.events.map(item => item.name), ['searchInformationTool'])
    assert.equal('user_id' in next.events[0].event, false)
    assert.equal(next.events[0].event.simulationActor.kind, 'autonomous')
    assert.equal(next.calls[0].tools.some(tool => tool.function.name === 'ownerAdminTool'), false)
    assert.equal((await next.runtime.describeGroup(GROUP)).lastWakeReason, 'characterGoal')
  } finally { next.runtime.stop() }
})

test('目标执行中取消后，迟到回执不复活目标且工具 reply、后续发送与文本兜底均被阻止', async () => {
  let release
  let entered = false
  let lateReplyBlocked = false
  const held = new Promise(resolve => { release = resolve })
  const h = fixture({
    async execute(_name, _args, event) {
      entered = true
      await held
      try { await event.reply('这个迟到的工具回复必须被取消挡住') } catch { lateReplyBlocked = true }
      return { ok: true, result: '已经在外部取得结果' }
    },
    script: (_request, index) => index === 0 ? tools(toolCall('searchInformationTool', {}))
      : index === 1 ? tools(toolCall('simSendMessage', { messages: ['取消后不该再发送的内容'] }))
        : finalText('这是取消之后也不该兜底发送的普通文本'),
  })
  try {
    await h.ingest('触发自主兴趣的消息', '30000', { at: false })
    const goal = seededGoal(h)
    h.clock.value = goal.nextCheckAt
    await h.runtime.sweepOnce()
    await waitFor(() => entered, '外部工具进入等待')
    await h.runtime.controlCharacter(GROUP, 'cancel-goal', goal.id)
    release()
    await idle(h, 3)
    const state = (await h.runtime.describeGroup(GROUP)).character
    assert.equal(state.goals[0].status, 'abandoned')
    assert.ok(state.receipts.some(receipt => receipt.toolName === 'searchInformationTool' && receipt.status === 'succeeded'))
    assert.equal(lateReplyBlocked, true)
    assert.equal(h.sent.length, 0)
    assert.equal(h.events.length, 1)
    assert.match(toolResult(h.calls[2], 'simSendMessage'), /^error:/)
  } finally { release(); h.runtime.stop() }
})

async function pendingBeforeRestart(toolName) {
  const kv = new Map()
  const clock = { value: BASE_AT }
  const first = fixture({ kv, clock })
  try {
    await first.ingest('用于目标来源的普通群消息', '30000', { at: false })
    const goal = seededGoal(first)
    clock.value = goal.nextCheckAt
    const pending = beginCharacterGoalAttempt(JSON.parse(kv.get(characterKey(first.scope()))), goal.id,
      { id: 'interrupted-action', toolName }, clock.value)
    kv.set(characterKey(first.scope()), JSON.stringify(pending))
    clock.value += 1
    return { kv, clock, goalId: goal.id, nextCheckAt: pending.goals[0].nextCheckAt }
  } finally { first.runtime.stop() }
}

test('发送动作 pending 时重启会转 unknown 并暂停目标，后续 sweep 不得自动重复发送', async () => {
  const crash = await pendingBeforeRestart('simSendMessage')
  const h = fixture({ ...crash, seed: false })
  try {
    await h.runtime.sweepOnce()
    const recovered = (await h.runtime.describeGroup(GROUP)).character
    assert.equal(recovered.receipts.find(receipt => receipt.id === 'interrupted-action').status, 'unknown')
    assert.equal(recovered.goals[0].status, 'paused')
    assert.match(recovered.goals[0].lastOutcome, /未知|核对|副作用/)
    assert.equal(recovered.goals[0].attempts, 1)
    h.clock.value = crash.nextCheckAt + CHARACTER_MIN_WAKE_MS
    await h.runtime.sweepOnce()
    assert.equal(h.calls.length, 0, '暂停的副作用目标不应再次进入模型回合')
    assert.equal(h.events.length, 0)
    assert.equal(h.sent.length, 0)
    assert.equal((await h.runtime.describeGroup(GROUP)).character.goals[0].status, 'paused')
  } finally { h.runtime.stop() }
})

test('只读搜索 pending 时重启转 unknown，最早下次检查时间可继续目标而不伪造旧成功', async () => {
  const crash = await pendingBeforeRestart('searchInformationTool')
  const h = fixture({ ...crash, seed: false, script: (_request, index) => index === 0
    ? tools(toolCall('searchInformationTool', {})) : quiet() })
  try {
    await h.runtime.sweepOnce()
    const recovered = (await h.runtime.describeGroup(GROUP)).character
    assert.equal(recovered.receipts.find(receipt => receipt.id === 'interrupted-action').status, 'unknown')
    assert.equal(recovered.goals[0].status, 'waiting')
    assert.equal(h.calls.length, 0, '恢复时尚未到下一次检查')
    h.clock.value = crash.nextCheckAt
    await h.runtime.sweepOnce()
    await idle(h, 2)
    const progressed = (await h.runtime.describeGroup(GROUP)).character
    assert.equal(progressed.goals[0].attempts, 2)
    assert.equal(progressed.goals[0].status, 'waiting')
    assert.equal(progressed.receipts.find(receipt => receipt.id === 'interrupted-action').status, 'unknown', '恢复不能把原未知回执改成成功')
    assert.ok(progressed.receipts.some(receipt => receipt.id !== 'interrupted-action' && receipt.toolName === 'searchInformationTool' && receipt.status === 'succeeded'))
    assert.deepEqual(h.events.map(item => item.name), ['searchInformationTool'])
    assert.equal('user_id' in h.events[0].event, false)
  } finally { h.runtime.stop() }
})

test('角色记忆按 bot/persona/group 隔离，普通人设文字修改和 runtime 重启保留同角色记忆', async () => {
  const kv = new Map()
  const identity = { id: 'shiloh', name: '希洛', systemContent: '最初的人设文字' }
  const h = fixture({ kv, identity, groups: [GROUP, OTHER_GROUP], script: (_request, index) => index === 0
    ? tools(toolCall('simCharacterMemory', { action: 'remember', kind: 'interest', content: '我想继续了解独立游戏', epistemic: 'desired', evidenceRefs: ['message:1'] })) : quiet() })
  try {
    await h.ingest()
    await idle(h, 2)
    const original = (await h.runtime.describeGroup(GROUP)).character
    assert.equal(original.memories.length, 1)
    identity.systemContent = '编辑后的同一人设文字'
    identity.name = '希洛的新称呼'
    h.clock.value += 60_000
    await h.ingest('人设文字编辑后再开始一个回合')
    await idle(h, 3)
    assert.equal((await h.runtime.describeGroup(GROUP)).character.memories.length, 1)
    assert.equal((await h.runtime.describeGroup(OTHER_GROUP)).character.memories.length, 0)
    identity.id = 'another-character'
    assert.equal((await h.runtime.describeGroup(GROUP)).character.memories.length, 0)
    identity.id = 'shiloh'
    assert.equal((await h.runtime.describeGroup(GROUP)).character.memories[0].id, original.memories[0].id)
  } finally { h.runtime.stop() }

  const restarted = fixture({ kv, identity, seed: false })
  try {
    assert.equal((await restarted.runtime.describeGroup(GROUP)).character.memories.length, 1)
  } finally { restarted.runtime.stop() }

  // Simulate an explicit new account/session binding, leaving the old account's character key intact.
  const otherBot = '3094088999'
  seedSession(kv, GROUP, otherBot, { value: BASE_AT })
  const other = fixture({ kv, botId: otherBot, identity, seed: false })
  try {
    const state = (await other.runtime.describeGroup(GROUP)).character
    assert.equal(state.scope.botId, otherBot)
    assert.equal(state.memories.length, 0)
    assert.equal(JSON.parse(kv.get(characterKey({ botId: BOT, personaId: 'shiloh', groupId: GROUP }))).memories.length, 1)
  } finally { other.runtime.stop() }
})

test('行动前 pending 回执写入失败时绝不调用外部工具，也不写入成功事实', async () => {
  let failedWrites = 0
  const h = fixture({
    script: (_request, index) => index === 0 ? tools(toolCall('searchInformationTool', {})) : quiet(),
    async writeFault(key, value) {
      if (!key.startsWith('shiloh:character:v1:')) return
      const state = JSON.parse(value)
      if (state.receipts?.some(receipt => receipt.toolName === 'searchInformationTool' && receipt.status === 'pending')) {
        failedWrites += 1
        throw new Error('injected Redis persistence failure')
      }
    },
  })
  try {
    await h.ingest()
    await idle(h, 2)
    assert.equal(failedWrites, 1)
    assert.equal(h.events.length, 0)
    assert.equal(h.sent.length, 0)
    assert.match(toolResult(h.calls[1], 'searchInformationTool'), /error:/)
    const state = (await h.runtime.describeGroup(GROUP)).character
    assert.equal(state.receipts.some(receipt => receipt.toolName === 'searchInformationTool'), false)
  } finally { h.runtime.stop() }
})

test('重置会话保留 bot/persona 与旧角色记忆目标，消息 seq 单调增加不复用旧证据', async () => {
  const h = fixture({ script: (_request, index) => index === 0 ? tools(
    toolCall('simCharacterMemory', { action: 'remember', kind: 'interest', content: '我想了解大家提到的游戏', epistemic: 'desired', evidenceRefs: ['message:1'] }),
    toolCall('simGoal', { action: 'create', title: '继续了解游戏资料', motivation: '这符合我的游戏兴趣', nextStep: '找公开介绍',
      completionCriteria: '取得公开资料的成功回执', stopConditions: ['管理员取消'], evidenceRefs: ['message:1'] }),
  ) : quiet() })
  try {
    await h.ingest('我最近发现一款新的独立游戏')
    await idle(h, 2)
    await h.ingest('这是重置前最后一条普通群消息', '30000', { at: false })
    const previous = JSON.parse(h.kv.get(sessionKey(GROUP)))
    const characterBefore = (await h.runtime.describeGroup(GROUP)).character
    assert.equal(previous.botId, BOT)
    assert.equal(previous.personaId, 'shiloh')
    assert.equal(characterBefore.memories.length, 1)
    assert.equal(characterBefore.goals.length, 1)
    assert.ok(previous.agentHistory.length > 0)
    assert.match(await h.runtime.resetGroup(GROUP), /已重置/)
    const reset = JSON.parse(h.kv.get(sessionKey(GROUP)))
    assert.equal(reset.seq, previous.seq)
    assert.equal(reset.lastReadThroughSeq, previous.seq)
    assert.equal(reset.botId, previous.botId)
    assert.equal(reset.personaId, previous.personaId)
    assert.deepEqual(reset.agentHistory, [])
    assert.deepEqual(reset.recent, [])
    const characterAfter = (await h.runtime.describeGroup(GROUP)).character
    assert.deepEqual(characterAfter.memories, characterBefore.memories)
    assert.deepEqual(characterAfter.goals, characterBefore.goals)
    h.clock.value += 60_000
    await h.ingest('重置后第一条新消息', '50000', { at: false })
    const after = JSON.parse(h.kv.get(sessionKey(GROUP)))
    assert.equal(after.seq, previous.seq + 1)
    assert.equal(after.recent[0].seq, previous.seq + 1)
    assert.ok(after.recent.every(message => message.seq > previous.seq), '新消息不得冒用旧 message:seq')
    assert.deepEqual((await h.runtime.describeGroup(GROUP)).character.memories[0].evidenceRefs, ['message:1'])
    assert.equal(h.sent.length, 0)
  } finally { h.runtime.stop() }
})

test('模型请求中删除来源记忆会清空历史，迟到 send/remember 不能再用旧来源且不会复写历史', async () => {
  let release
  let modelWaiting = false
  let memoryId
  const held = new Promise(resolve => { release = resolve })
  const h = fixture({ script: async (request, index) => {
    if (index === 0) return tools(toolCall('simCharacterMemory', {
      action: 'remember', kind: 'interest', content: '我想关注这个独立游戏', epistemic: 'desired', evidenceRefs: ['message:1'],
    }))
    if (index === 2) {
      assert.ok(JSON.stringify(request.messages).includes(memoryId), '模型请求确实带着将被删除的来源记录')
      modelWaiting = true
      await held
      return tools(
        toolCall('simSendMessage', { messages: ['这段依据已被删除的内容不得外发'] }),
        toolCall('simCharacterMemory', { action: 'remember', kind: 'opinion', content: '从已删除来源推导的新观点', epistemic: 'inferred', evidenceRefs: [`memory:${memoryId}`] }),
      )
    }
    return quiet()
  } })
  try {
    await h.ingest('这条游戏兴趣是后续的来源')
    await idle(h, 2)
    memoryId = (await h.runtime.describeGroup(GROUP)).character.memories[0].id
    assert.ok(JSON.parse(h.kv.get(sessionKey(GROUP))).agentHistory.length > 0)
    h.clock.value += 60_000
    await h.ingest('继续刚才的话题')
    await waitFor(() => modelWaiting, '模型已收到含旧来源的请求并等待返回')
    await h.runtime.controlCharacter(GROUP, 'delete-memory', memoryId)
    assert.deepEqual(JSON.parse(h.kv.get(sessionKey(GROUP))).agentHistory, [], '删除操作立即清空持久化的旧上下文')
    assert.equal((await h.runtime.describeGroup(GROUP)).character.memories.length, 0)
    release()
    await idle(h, 4)
    assert.equal(h.sent.length, 0)
    assert.equal(h.events.length, 0)
    assert.match(toolResult(h.calls[3], 'simSendMessage'), /^error:/)
    assert.match(toolResult(h.calls[3], 'simCharacterMemory'), /^error:/)
    assert.equal((await h.runtime.describeGroup(GROUP)).character.memories.length, 0, '不得从已删除来源再造派生记忆')
    assert.deepEqual(JSON.parse(h.kv.get(sessionKey(GROUP))).agentHistory, [], '迟到的回合不能把本地旧 history 写回')
  } finally { release(); h.runtime.stop() }
})

test('另一个机器人收到拍一拍不能接管主机器人会话、改写消息或安排唤醒', async () => {
  const kv = new Map()
  const clock = { value: BASE_AT }
  seedSession(kv, GROUP, BOT, clock)
  const original = kv.get(sessionKey(GROUP))
  const secondaryBot = '3094088999'
  const h = fixture({ kv, clock, botId: secondaryBot, seed: false })
  try {
    assert.equal(await h.runtime.ingestPoke({ group_id: GROUP, self_id: secondaryBot, target_id: secondaryBot, user_id: '40000' }), true)
    assert.equal(kv.get(sessionKey(GROUP)), original, '别的机器人拍一拍事件不能改主会话任何字段')
    assert.equal(h.writes.some(write => write.key === sessionKey(GROUP)), false)
    await sleep(1150)
    assert.equal(h.calls.length, 0, '越过 1 秒唤醒窗仍不能调用模型')
    assert.equal(h.events.length, 0)
    assert.equal(h.sent.length, 0)
    assert.equal(JSON.parse(kv.get(sessionKey(GROUP))).botId, BOT)
    assert.equal(JSON.parse(kv.get(sessionKey(GROUP))).seq, 0)
  } finally { h.runtime.stop() }
})

test('工具 reply 文本数组拒绝参数 JSON 和内部路径，普通数组转换成文本段后正常发送', async () => {
  const payloads = [
    { label: '参数 JSON', payload: [JSON.stringify({ tags: ['猫'], useCases: ['聊天'], leadText: '来一张表情' })], blocked: true },
    { label: '内部路径', payload: ['/opt/trss-yunzai'], blocked: true },
    { label: '普通文字', payload: ['找到一份公开游戏介绍', '我们可以接着聊它的玩法'], blocked: false },
  ]
  for (const { label, payload, blocked } of payloads) {
    let replyError
    const h = fixture({
      script: (_request, index) => index === 0 ? tools(toolCall('searchInformationTool', {})) : quiet(),
      async execute(_name, _args, event) {
        try { await event.reply(payload) } catch (error) { replyError = error }
        return replyError ? { ok: false, error: 'reply was rejected' } : { ok: true, result: 'reply delivered' }
      },
    })
    try {
      await h.ingest(`测试工具回复${label}`)
      await idle(h, 2)
      assert.equal(h.events.length, 1, label)
      if (blocked) {
        assert.ok(replyError, `${label}应由发送闸门拒绝`)
        assert.equal(h.sent.length, 0, `${label}不应发送到群`)
        assert.equal((await h.runtime.describeGroup(GROUP)).character.receipts.find(receipt => receipt.toolName === 'searchInformationTool').status, 'failed')
      } else {
        assert.equal(replyError, undefined)
        assert.equal(h.sent.length, 1)
        assert.deepEqual(h.sent[0].segments, payload.map(text => ({ type: 'text', data: { text } })))
        assert.equal(h.sent[0].groupId, GROUP)
        assert.equal((await h.runtime.describeGroup(GROUP)).character.receipts.find(receipt => receipt.toolName === 'searchInformationTool').status, 'succeeded')
      }
    } finally { h.runtime.stop() }
  }
})

const reviewed = (verdict, issues = []) => ({ choices: [{ message: { content: JSON.stringify({ verdict, issues }) } }], usage: { total_tokens: 7 }, model: 'isolated-reviewer' })

test('一致性退回后只允许修正收尾，成功保存目标才发送且审核费用计入', async () => {
  const ledger = [], reviews = []
  const invalid = toolCall('simFinishTurn', { choice: 'chat', reason: '聊天', messages: ['我晚点继续核对资料'], throughSeq: 1 })
  const valid = toolCall('simFinishTurn', { choice: 'schedule', reason: '决定继续', goal: finishGoal, messages: ['我晚点继续核对资料'], throughSeq: 1 })
  const h = fixture({ consistencyEnabled: true, script: (_r, i) => i === 0 ? tools(invalid) : tools(valid), recordTokens: row => ledger.push(row), review: async request => {
    const data = JSON.parse(request.messages[1].content); reviews.push(data)
    return reviews.length === 1 ? reviewed('revise', [{ code: 'missing_goal', reason: '后续安排没有目标' }]) : reviewed('accept')
  } })
  try {
    await h.ingest(); await idle(h, 2)
    assert.equal(h.sent.length, 1); assert.equal(reviews.length, 2)
    assert.match(storedToolReply(h, invalid).content, /本次未保存或发送/)
    assert.equal(turnContext(h.calls[1]).phase, 'closing')
    assert.equal((await h.runtime.describeGroup(GROUP)).character.goals.length, 1)
    assert.equal(reviews[0].state.goals.length, 0); assert.equal(reviews[1].state.goals.length, 1)
    assert.equal(ledger.filter(row => row.stage === 'character-consistency').length, 2)
    assert.equal(JSON.parse(h.kv.get(sessionKey(GROUP))).budget.tokens, 34)
  } finally { h.runtime.stop() }
})

test('中途聊天和直接记忆写入也受检查，退回不会发送或偷偷补状态', async () => {
  for (const candidate of [
    toolCall('simSendMessage', { continuation: 'chat', messages: ['我晚点独自继续研究'] }),
    toolCall('simCharacterMemory', { action: 'remember', kind: 'experience', epistemic: 'reported', content: '我已确认资料全都是真的', evidenceRefs: ['message:1'] }),
  ]) {
    let checks = 0
    const h = fixture({ consistencyEnabled: true, script: (_r, i) => i === 0 ? tools(candidate) : tools(toolCall('simFinishTurn', { choice: 'silent', reason: '放弃不一致表达' })), review: async () => { checks++; return reviewed('revise', [{ code: 'unsupported_fact', reason: '依据不支持此断言' }]) } })
    try {
      await h.ingest(); await idle(h, 2)
      assert.equal(checks, 1); assert.equal(h.sent.length, 0)
      assert.match(storedToolReply(h, candidate).content, /一致性检查/)
      const character = (await h.runtime.describeGroup(GROUP)).character
      assert.equal(character.memories.length, 0); assert.equal(character.goals.length, 0)
    } finally { h.runtime.stop() }
  }
})

test('不可用审核每回合最多三次，失败后不能用普通消息绕过', async () => {
  let checks = 0
  const h = fixture({ consistencyEnabled: true, maxToolRounds: 6, script: () => tools(
    toolCall('simFinishTurn', { choice: 'chat', reason: '普通交流', messages: ['这是一句待审核消息'] }),
    toolCall('simSendMessage', { continuation: 'chat', messages: ['试图绕过检查'] }),
  ), review: async () => { checks++; throw new Error('injected private provider failure') } })
  try {
    await h.ingest(); await idle(h, 6)
    assert.equal(checks, 3); assert.equal(h.sent.length, 0)
    assert.ok(h.calls.slice(1).every(request => request.tools.length === 1 && request.tools[0].function.name === 'simFinishTurn'))
    assert.equal((await h.runtime.describeGroup(GROUP)).character.memories.length, 0)
    assert.doesNotMatch(JSON.stringify(JSON.parse(h.kv.get(sessionKey(GROUP))).agentHistory), /private provider failure/)
  } finally { h.runtime.stop() }
})

test('审核默认关闭或显式关闭时普通消息与状态提交均不调用审核', async () => {
  for (const consistencyEnabled of [undefined, false]) {
    let checks = 0
    const h = fixture({ consistencyEnabled, review: async () => { checks++; throw new Error('disabled reviewer must not run') },
      script: (_request, index) => index === 0 ? tools(toolCall('simSendMessage', { messages: ['先聊一句'] })) : tools(toolCall('simFinishTurn', {
        choice: 'chat', reason: '结束普通交流', memories: [{ kind: 'experience', epistemic: 'reported', content: '群友介绍了一款游戏', evidenceRefs: ['message:1'] }], messages: ['谢谢介绍'], throughSeq: 1,
      })),
    })
    try {
      await h.ingest(); await idle(h, 2)
      assert.equal(checks, 0)
      assert.equal(h.sent.length, 2)
      assert.equal((await h.runtime.describeGroup(GROUP)).character.memories.length, 1)
    } finally { h.runtime.stop() }
  }
})

test('明确启用但未配置审核端口或独立后端时拒绝公告，仍能静默收尾', async () => {
  for (const missing of ['port', 'backend']) {
    let checks = 0
    const h = fixture({ consistencyEnabled: true,
      ...(missing === 'port' ? {} : { review: async () => { checks++; resolveCharacterConsistencyRoute({ useTools: true }); return reviewed('accept') } }),
      script: (_request, index) => index === 0 ? tools(toolCall('simFinishTurn', { choice: 'chat', reason: '普通交流', messages: ['未审核消息'] })) : tools(toolCall('simFinishTurn', { choice: 'silent', reason: '审核不可用，安静结束', throughSeq: 1 })),
    })
    try {
      await h.ingest(); await idle(h, 2)
      assert.equal(checks, missing === 'port' ? 0 : 1)
      assert.equal(h.sent.length, 0)
      assert.equal((await h.runtime.describeGroup(GROUP)).character.decision.kind, 'silent')
      assert.match(toolResult(h.calls[1], 'simFinishTurn'), /一致性检查未通过/)
    } finally { h.runtime.stop() }
  }
})

test('前两次普通提交通过后阻止非收尾第三次检查，保留最终收尾配额', async () => {
  let checks = 0
  const blocked = toolCall('simCharacterMemory', { action: 'remember', kind: 'interest', epistemic: 'inferred', content: '不能提前耗尽最后检查', evidenceRefs: ['message:1'] })
  const h = fixture({ consistencyEnabled: true, review: async () => { checks++; return reviewed('accept') },
    script: (_request, index) => [
      tools(toolCall('simSendMessage', { messages: ['先聊一句'] })),
      tools(toolCall('simCharacterMemory', { action: 'remember', kind: 'experience', epistemic: 'reported', content: '群友介绍了一款游戏', evidenceRefs: ['message:1'] })),
      tools(blocked),
      tools(toolCall('simFinishTurn', { choice: 'chat', reason: '合并到最终提交', memories: [{ kind: 'interest', epistemic: 'inferred', content: '有一点兴趣', evidenceRefs: ['message:1'] }], messages: ['最后说声谢谢'], throughSeq: 1 })),
    ][index] || quiet(),
  })
  try {
    await h.ingest(); await idle(h, 4)
    assert.equal(checks, 3)
    assert.match(storedToolReply(h, blocked).content, /保留.*收尾/)
    assert.equal(turnContext(h.calls[3]).phase, 'closing')
    assert.equal(h.sent.length, 2)
    const memories = (await h.runtime.describeGroup(GROUP)).character.memories
    assert.equal(memories.length, 2)
    assert.equal(memories.some(memory => memory.content === '不能提前耗尽最后检查'), false)
    assert.equal(memories.some(memory => memory.content === '有一点兴趣'), true)
  } finally { h.runtime.stop() }
})

test('管理员在回合中关闭审核后不再开始新审核请求', async () => {
  let enabled = true, checks = 0
  const h = fixture({ consistencyEnabled: () => enabled,
    review: async () => { checks++; enabled = false; return reviewed('accept') },
    script: (_request, index) => index === 0 ? tools(toolCall('simSendMessage', { messages: ['先聊一句'] })) : tools(toolCall('simFinishTurn', { choice: 'chat', reason: '普通收尾', messages: ['关闭审核后照常结束'], throughSeq: 1 })),
  })
  try {
    await h.ingest(); await idle(h, 2)
    assert.equal(checks, 1)
    assert.equal(h.sent.length, 2)
  } finally { h.runtime.stop() }
})
