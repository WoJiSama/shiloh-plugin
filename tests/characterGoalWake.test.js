import assert from 'node:assert/strict'
import test from 'node:test'
import { createSimulationRuntime } from '../dist/backend/modules/simulation/infrastructure/simulationRuntime.js'
import { createDefaultSimSession } from '../dist/backend/modules/simulation/domain/simConfig.js'
import { characterKey, createCharacterGoal, createEmptyCharacterState } from '../dist/backend/modules/simulation/domain/characterState.js'
import { mergeWakeReason } from '../dist/backend/modules/simulation/domain/wakeTrigger.js'

const BOT = '3094088525', GROUP = '10086', BASE_AT = 1_790_000_000_000
const SESSION_KEY = `shiloh:sim:g:${GROUP}`
const SCOPE = { botId: BOT, personaId: 'shiloh', groupId: GROUP }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let sequence = 0
const toolCall = name => ({ id: `goal-wake-${++sequence}`, type: 'function', function: { name, arguments: '{}' } })

/** Real scheduler and compiled runtime; synthetic clock, storage, model, tool and QQ. */
function fixture() {
  const state = createDefaultSimSession(BASE_AT)
  state.bootstrapSent = true
  state.botId = BOT
  state.wakeConfig.triggers.probability = 0
  state.nextProactiveCheckAt = 0
  const kv = new Map([[SESSION_KEY, JSON.stringify(state)]])
  const clock = { value: BASE_AT }, requests = [], events = [], errors = []
  const search = {
    name: 'searchInformationTool', description: '隔离目标推进工具', parameters: { type: 'object', properties: {}, required: [] },
    async execute(_args, event) { events.push(event); return { ok: true, result: '目标检查取得的合成资料' } },
  }
  const runtime = createSimulationRuntime({
    redis: {
      async get(key) { return kv.get(key) ?? null },
      async set(key, value) { kv.set(key, value); return 'OK' },
      async del(...keys) { return keys.reduce((count, key) => count + Number(kv.delete(key)), 0) },
    },
    now: () => clock.value, random: () => 0.99,
    logger: { info() {}, warn(...items) { errors.push(items.map(String).join(' ')) }, error(...items) { errors.push(items.map(String).join(' ')) } },
    getSelf: () => ({ id: BOT, name: '希洛' }),
    getPersona: () => ({ personaId: SCOPE.personaId, persona: { name: '希洛' }, systemContent: '喜欢独立游戏' }),
    getSection: () => ({
      enabled: true, allGroups: false, groups: [GROUP],
      toolPolicy: { mode: 'legacy' }, extraTools: [search.name],
      wake: { probability: 0, batchWindowMs: 1000, maxWakePerMinute: 100, maxWakePerHour: 100, proactiveProbability: 0 },
      turn: { maxToolRounds: 8, minSendGapMs: 0, maxTurnsPerDay: 100 },
      rhythm: { enabled: false }, mood: { enabled: false }, wakeGate: { enabled: false }, userStyle: { enabled: false },
    }),
    getExecutionConfig: () => ({ useTools: true }),
    getExtraTools: names => names.includes(search.name) ? [search] : [],
    async YTapi(request) {
      requests.push(structuredClone(request))
      const message = requests.length === 1
        ? { role: 'assistant', content: '', tool_calls: [toolCall(search.name)] }
        : { role: 'assistant', content: '' }
      return { choices: [{ message, finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop' }], usage: { total_tokens: 10 }, model: 'isolated-goal-wake-test' }
    },
    async sendGroupMessage() { assert.fail('本调度回归不得发送 QQ 消息') },
  })
  return {
    runtime, kv, clock, requests, events,
    character: () => JSON.parse(kv.get(characterKey(SCOPE))),
    async ingest(at = false) {
      await runtime.ingest({ group_id: GROUP, self_id: BOT, user_id: '40000', message_type: 'group', atBot: at,
        msg: at ? '请先处理我的问题' : '刚才聊到的公开玩法资料',
        message: at ? [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: '请先处理我的问题' } }] : [], sender: { nickname: '群友' } })
    },
    seedDueGoal({ replyCheck = true } = {}) {
      const character = createCharacterGoal(createEmptyCharacterState(SCOPE), {
        id: 'goal-due', title: '核对公开玩法资料', motivation: '延续已保存的研究兴趣', nextStep: '查询公开资料',
        completionCriteria: '取得公开来源供后续核对', stopConditions: ['管理员取消'], evidenceRefs: ['message:1'],
      }, ['message:1'], clock.value)
      kv.set(characterKey(SCOPE), JSON.stringify(character))
      clock.value = character.goals[0].nextCheckAt
      const saved = JSON.parse(kv.get(SESSION_KEY))
      saved.nextReplyCheckAt = replyCheck ? clock.value - 1 : 0
      kv.set(SESSION_KEY, JSON.stringify(saved))
      return character.goals[0]
    },
    async idle() {
      const deadline = Date.now() + 6000
      while (Date.now() < deadline) {
        if (requests.length >= 2 && !(await runtime.describeGroup(GROUP)).running) return
        await sleep(20)
      }
      assert.fail(`隔离回合未结束：${errors.join(' | ')}`)
    },
  }
}

function focusedGoal(request) {
  const context = request.messages.filter(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('【本轮执行检查】')).at(-1)?.content
  assert.ok(context)
  return JSON.parse(context.slice(context.lastIndexOf('【本轮执行检查】')).split('\n')[1]).focusedGoalId
}

test('目标到期合并优先于自动回音等检查，真实消息、托付和开场仍优先', () => {
  const goal = { kind: 'characterGoal', detail: 'goal-due' }
  for (const kind of ['replyCheck', 'timeout', 'interestUpdate', 'proactiveCheck']) {
    assert.deepEqual(mergeWakeReason({ kind }, goal).reason, goal, kind)
    assert.deepEqual(mergeWakeReason(goal, { kind }).reason, goal, kind)
  }
  for (const kind of ['atMention', 'question', 'continuation', 'speaker', 'session', 'nameMention', 'keyword', 'anyMessage', 'probability', 'commitment', 'admin', 'bootstrap']) {
    const higher = { kind }
    assert.deepEqual(mergeWakeReason(goal, higher).reason, higher, kind)
    assert.deepEqual(mergeWakeReason(higher, goal).reason, higher, kind)
  }
})

test('同一 sweep 的到期目标与回音检查并存时绑定自主目标并实际推进', async () => {
  const h = fixture()
  try {
    await h.ingest()
    const goal = h.seedDueGoal()
    await h.runtime.sweepOnce()
    await h.idle()
    assert.equal((await h.runtime.describeGroup(GROUP)).lastWakeReason, 'characterGoal')
    assert.equal(focusedGoal(h.requests[0]), goal.id)
    assert.equal(h.character().goals[0].attempts, 1)
    assert.equal(h.events.length, 1)
    assert.equal(h.events[0].simulationActor.kind, 'autonomous')
    assert.equal('user_id' in h.events[0], false)
    assert.equal(h.character().receipts.find(receipt => receipt.toolName === 'searchInformationTool').goalId, goal.id)
  } finally { h.runtime.stop() }
})

test('目标和回音已排期后真实 @ 仍升级唤醒，不借用户回合自动推进目标', async () => {
  const h = fixture()
  try {
    await h.ingest()
    h.seedDueGoal()
    await h.runtime.sweepOnce()
    await h.ingest(true)
    await h.idle()
    assert.equal((await h.runtime.describeGroup(GROUP)).lastWakeReason, 'atMention')
    assert.equal(focusedGoal(h.requests[0]), null)
    assert.equal(h.character().goals[0].attempts, 0)
    assert.equal(h.events[0].simulationActor.kind, 'user')
    assert.equal(h.events[0].user_id, 40000)
  } finally { h.runtime.stop() }
})

test('仅 @ 模式下到期目标不安排模型回合或目标检查', async () => {
  const h = fixture()
  try {
    await h.ingest()
    h.seedDueGoal({ replyCheck: false })
    await h.runtime.setGroupReplyMode(GROUP, 'atOnly')
    await h.runtime.sweepOnce()
    await sleep(1150)
    assert.equal(h.requests.length, 0)
    assert.equal(h.events.length, 0)
    assert.equal(h.character().goals[0].attempts, 0)
    assert.equal(h.character().receipts.length, 0)
  } finally { h.runtime.stop() }
})
