import assert from 'node:assert/strict'
import test from 'node:test'
import { createSimulationRuntime } from '../dist/backend/modules/simulation/infrastructure/simulationRuntime.js'
import { createDefaultSimSession } from '../dist/backend/modules/simulation/domain/simConfig.js'
import { CHARACTER_MIN_WAKE_MS, beginCharacterGoalAttempt, characterKey, createCharacterGoal, createEmptyCharacterState } from '../dist/backend/modules/simulation/domain/characterState.js'

const BOT = '3094088525'
const GROUP = '10086'
const OTHER_GROUP = '10087'
const BASE_AT = 1_790_000_000_000
const sessionKey = groupId => `shiloh:sim:g:${groupId}`
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let callSequence = 0
const toolCall = (name, args) => ({ id: `test-call-${++callSequence}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })
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
  groups = [GROUP], script = () => quiet(), execute, writeFault,
  proactiveProbability = 0, seed = true,
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
      extraTools: toolDefinitions.map(tool => tool.name), toolPolicy: { mode: 'legacy' },
      wake: { probability: 0, batchWindowMs: 1000, maxWakePerMinute: 100, maxWakePerHour: 100, proactiveProbability, proactiveIdleMs: 60_000 },
      turn: { maxToolRounds: 8, minSendGapMs: 0, maxTurnsPerDay: 100 },
      rhythm: { enabled: false }, mood: { enabled: false }, wakeGate: { enabled: false }, userStyle: { enabled: false },
    }),
    getExecutionConfig: () => ({ useTools: true }),
    getExtraTools: names => toolDefinitions.filter(tool => names.includes(tool.name)),
    async YTapi(request) {
      calls.push(structuredClone(request))
      const message = await script(request, calls.length - 1)
      return { choices: [{ message, finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop' }], usage: { total_tokens: 10 }, model: 'offline-test' }
    },
    async sendGroupMessage(groupId, segments) { sent.push({ groupId, segments }); return { ok: true, messageId: `sent-${sent.length}` } },
  })
  return {
    runtime, kv, clock, identity, botId, calls, events, sent, errors, writes,
    scope: (groupId = GROUP) => ({ botId, personaId: identity.id, groupId }),
    async ingest(text = '看看这个游戏', userId = '40000', { at = true, groupId = GROUP } = {}) {
      return runtime.ingest({ group_id: groupId, self_id: botId, user_id: userId, message_type: 'group', msg: text,
        atBot: at, message: at ? [{ type: 'at', data: { qq: botId } }, { type: 'text', data: { text } }] : [], sender: { nickname: `群友${userId}` } })
    },
  }
}

async function idle(harness, minCalls, groupId = GROUP) {
  await waitFor(async () => harness.calls.length >= minCalls && !(await harness.runtime.describeGroup(groupId)).running, `回合结束（模型调用至少 ${minCalls} 次）：${harness.errors.join(' | ')}`)
}

function toolResult(request, name) {
  return [...request.messages].reverse().find(message => message.role === 'tool' && message.name === name)?.content
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
    await idle(h, 4)
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
