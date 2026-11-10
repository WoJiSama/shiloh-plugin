import assert from 'node:assert/strict'
import test from 'node:test'
import { createSimulationRuntime } from '../dist/backend/modules/simulation/infrastructure/simulationRuntime.js'
import { createDefaultSimSession } from '../dist/backend/modules/simulation/domain/simConfig.js'
import { addCharacterMemory, characterKey, createCharacterGoal, createEmptyCharacterState } from '../dist/backend/modules/simulation/domain/characterState.js'
import { createCharacterStore } from '../dist/backend/modules/simulation/infrastructure/characterStore.js'
import { createCharacterSharedSelf } from '../dist/backend/modules/simulation/infrastructure/characterSharedSelf.js'

const BOT = '3094088525'
const GROUP = '10086'
const OTHER_GROUP = '10087'
const BASE = Date.parse('2026-11-09T00:00:00Z')
const HOUR = 3600_000
const sessionKey = group => `shiloh:sim:g:${group}`
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let sequence = 0
const call = (name, args) => ({ id: `activity-call-${++sequence}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const tools = (...tool_calls) => ({ role: 'assistant', content: '', tool_calls })
const quiet = () => ({ role: 'assistant', content: '' })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

async function waitFor(check, description) {
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    if (await check()) return
    await sleep(20)
  }
  assert.fail(`等待超时：${description}`)
}

/** Compiled production runtime, with isolated persistence, model and adapter ports. */
function fixture({ groups = [GROUP], script = () => quiet(), fetchCharacterFeed, reflectCharacter, runCharacterWorker, characterWorkerAvailable, beforeSet } = {}) {
  const kv = new Map(), clock = { value: BASE }, calls = [], events = [], sent = [], errors = []
  const redis = {
    async get(key) { return kv.get(key) ?? null },
    async set(key, value) { await beforeSet?.(key, value); kv.set(key, value); return 'OK' },
    async del(...keys) { let removed = 0; for (const key of keys) if (kv.delete(key)) removed++; return removed },
  }
  kv.set('shiloh:sim:known', JSON.stringify(groups))
  for (const group of groups) {
    const state = createDefaultSimSession(clock.value)
    state.botId = BOT; state.bootstrapSent = true; state.wakeConfig.triggers.probability = 0
    state.nextProactiveCheckAt = BASE + 365 * 24 * HOUR
    kv.set(sessionKey(group), JSON.stringify(state))
  }
  const extra = {
    name: 'searchInformationTool', description: '隔离的公开信息查询', parameters: { type: 'object', properties: {} },
    async execute(args, event) { events.push({ args, event }); return { ok: true, result: '公开资料' } },
  }
  const runtimePorts = {
    redis, now: () => clock.value, random: () => 0.99,
    logger: { info() {}, warn(...args) { errors.push(args.join(' ')) }, error(...args) { errors.push(args.map(String).join(' ')) } },
    getSelf: () => ({ id: BOT, name: '希洛' }),
    getPersona: () => ({ personaId: 'shiloh', persona: { name: '希洛' }, systemContent: '喜欢探索与解谜' }),
    getSection: () => ({
      enabled: true, allGroups: false, groups, extraTools: [extra.name], toolPolicy: { mode: 'legacy' },
      wake: { probability: 0, batchWindowMs: 1000, maxWakePerMinute: 100, maxWakePerHour: 100, proactiveProbability: 0 },
      turn: { maxToolRounds: 6, minSendGapMs: 0, maxTurnsPerDay: 100 },
      rhythm: { enabled: false }, mood: { enabled: false }, wakeGate: { enabled: false }, userStyle: { enabled: false },
    }),
    getExecutionConfig: () => ({ useTools: true }), getExtraTools: names => names.includes(extra.name) ? [extra] : [],
    async YTapi(request) {
      calls.push(structuredClone(request))
      const message = await script(request, calls.length - 1)
      return { choices: [{ message, finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop' }], usage: { total_tokens: 10 }, model: 'offline-activities' }
    },
    async sendGroupMessage(groupId, segments) { sent.push({ groupId, segments }); return { ok: true, messageId: `sent-${sent.length}` } },
    ...(fetchCharacterFeed ? { fetchCharacterFeed } : {}), ...(reflectCharacter ? { reflectCharacter } : {}),
    ...(runCharacterWorker ? { runCharacterWorker } : {}), ...(characterWorkerAvailable ? { characterWorkerAvailable } : {}),
  }
  const runtime = createSimulationRuntime(runtimePorts)
  const scope = (groupId = GROUP) => ({ botId: BOT, personaId: 'shiloh', groupId })
  const characters = createCharacterStore({ redis, now: () => clock.value })
  return {
    runtime, kv, clock, calls, events, sent, errors, scope, redis, characters,
    peerRuntime: (overrides = {}) => createSimulationRuntime({ ...runtimePorts, redis: { ...redis }, ...overrides }),
    async memory(id, content, groupId = GROUP, kind = 'interest') {
      return characters.update(scope(groupId), state => addCharacterMemory(state, {
        id, kind, content, epistemic: kind === 'experience' ? 'reported' : 'inferred', evidenceRefs: ['message:1'],
      }, ['message:1'], clock.value))
    },
    async ingest(text = '请看看这个解谜游戏', { groupId = GROUP, at = true } = {}) {
      return runtime.ingest({ group_id: groupId, self_id: BOT, user_id: '40000', message_type: 'group', msg: text,
        atBot: at, message: at ? [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text } }] : [], sender: { nickname: '群友' } })
    },
  }
}

async function idle(h, minCalls, group = GROUP) {
  await waitFor(async () => h.calls.length >= minCalls && !(await h.runtime.describeGroup(group)).running, `回合结束 ${minCalls}：${h.errors.join(' | ')}`)
}
function toolResult(request, name) { return [...request.messages].reverse().find(message => message.role === 'tool' && message.name === name)?.content }
function receiptFrom(result) { return JSON.parse(result.match(/【运行时行动回执】(.*)$/u)[1]) }

test('旧会话在无机器人独立控制台保留群视图，拒绝空范围管理，收到真实消息后才绑定角色', async () => {
  const h = fixture()
  const state = JSON.parse(h.kv.get(sessionKey(GROUP)))
  delete state.botId
  state.seq = 3
  state.lastReadThroughSeq = 2
  state.agentHistory = [{ role: 'assistant', content: '历史会话内容' }]
  state.budget.turns = 7
  const message = { seq: 3, messageId: 'legacy-3', userId: '40000', name: '群友', text: '旧会话未读', at: BASE, atSelf: false, quoteToSelf: false }
  state.unread = [message]; state.recent = [message]
  h.kv.set(sessionKey(GROUP), JSON.stringify(state))
  h.kv.set('shiloh:sim:overrides', JSON.stringify({ explicitEnabled: [GROUP], disabled: [], budgetCaps: {}, turnCaps: {} }))
  let personaReads = 0
  const consoleRuntime = h.peerRuntime({
    getSelf: () => ({ id: '', name: '' }),
    getPersona: (_groupId, botId) => {
      assert.equal(botId, BOT, '仅允许已绑定会话解析实际机器人的人格')
      personaReads++
      return { personaId: 'shiloh', persona: { name: '希洛' }, systemContent: '喜欢探索与解谜' }
    },
  })
  try {
    const before = [...h.kv.entries()]
    for (const runtime of [consoleRuntime, h.runtime]) {
      const detail = await runtime.describeGroup(GROUP)
      assert.equal(detail.groupId, GROUP)
      assert.equal(detail.unreadCount, 1); assert.equal(detail.recentCount, 1)
      assert.equal(detail.historyLength, 1); assert.equal(detail.lastReadThroughSeq, 2)
      assert.equal(detail.budget.turns, 7)
      assert.equal(detail.character, null)
      assert.deepEqual(detail.characterBinding, { status: 'pending', botId: null, personaId: null, reason: '等待机器人收到本群消息后绑定角色' })
      assert.deepEqual(detail.activities, { works: [], subscriptions: [], reflection: null, shared: [], sharedPending: [], capabilities: [] })
      assert.deepEqual((await runtime.overview()).groups.map(group => group.groupId), [GROUP])
      assert.deepEqual((await runtime.lifeOverview()).threads, [])
      for (const action of ['pause', 'resume', 'cancel-goal', 'pause-goal', 'resume-goal', 'delete-memory']) {
        await assert.rejects(runtime.controlCharacter(GROUP, action, action === 'pause' || action === 'resume' ? undefined : 'record-1'), /尚未绑定机器人/)
      }
      for (const action of ['work-archive', 'work-delete', 'work-restore', 'subscription-pause', 'subscription-resume', 'subscription-remove', 'shared-approve', 'shared-delete', 'reflection-reset']) {
        await assert.rejects(runtime.controlActivity(GROUP, action, action === 'reflection-reset' ? undefined : 'record-1', action === 'work-restore' ? { revision: 1 } : undefined), /尚未绑定机器人/)
      }
    }
    assert.deepEqual([...h.kv.entries()], before, '读取与被拒绝的管理不得写角色、撤销版本或覆盖旧会话')
    assert.equal(personaReads, 0)
    assert.equal(h.calls.length, 0); assert.equal(h.sent.length, 0)
    await h.runtime.setLifeRhythm(1, 8)
    assert.deepEqual([...h.kv.entries()].filter(([key]) => key !== 'shiloh:sim:rhythm'), before, '全局作息编辑不能为未绑定群创建角色范围')
    await h.ingest('真正收到本群消息后建立绑定', { at: false })
    const bound = await consoleRuntime.describeGroup(GROUP)
    assert.deepEqual(bound.characterBinding, { status: 'bound', botId: BOT, personaId: 'shiloh' })
    assert.deepEqual(bound.character.scope, h.scope())
    assert.equal(bound.unreadCount, 2); assert.equal(bound.budget.turns, 7)
    assert.ok(personaReads > 0)
    assert.equal(h.calls.length, 0); assert.equal(h.sent.length, 0)
    assert.ok([...h.kv.keys()].filter(key => key.startsWith('shiloh:character:')).every(key => key.includes(`:${BOT}:shiloh:${GROUP}`)))
  } finally { h.runtime.stop(); consoleRuntime.stop() }
})

test('后台收尾写入等待期间的新消息保持序号与未读，点名触发在收尾后正常唤醒', async () => {
  for (const at of [false, true]) {
    const entered = deferred(), held = deferred(), sessionWrites = []
    let intercepted = false, background, incoming
    const h = fixture({ beforeSet: async (key, value) => {
      if (key !== sessionKey(GROUP)) return
      sessionWrites.push(JSON.parse(value))
      if (!intercepted) { intercepted = true; entered.resolve(); await held.promise }
    } })
    const text = at ? '后台收尾时点名的新消息' : '后台收尾时普通的新消息'
    try {
      background = h.runtime.sweepOnce()
      await entered.promise
      incoming = h.ingest(text, { at })
      // The save queue may keep ingest pending; inspect the live projection
      // before releasing the first Redis SET instead of awaiting ingest here.
      await waitFor(async () => /unread=1 recent=1/u.test(await h.runtime.groupStatus(GROUP)), '入站已修改实时会话或提交排队写入')
      assert.equal(h.calls.length, 0, '收尾持有会话时不能开启新的模型回合')
      held.resolve()
      await Promise.all([background, incoming])
      if (at) {
        await idle(h, 1)
        assert.equal((await h.runtime.describeGroup(GROUP)).lastWakeReason, 'atMention')
        assert.ok(JSON.stringify(h.calls[0].messages).includes(text))
        assert.ok(sessionWrites.some(state => state.pendingWakeReasons.some(reason => reason.kind === 'atMention')), '点名须在后台忙碌时保存为待处理触发')
      } else {
        await sleep(1100)
        assert.equal(h.calls.length, 0)
      }
      const session = JSON.parse(h.kv.get(sessionKey(GROUP)))
      assert.equal(session.seq, 1)
      assert.deepEqual(session.unread.map(message => [message.seq, message.text]), [[1, text]])
      assert.deepEqual(session.recent.map(message => [message.seq, message.text]), [[1, text]])
      assert.equal(h.sent.length, 0)
    } finally {
      held.resolve()
      await Promise.allSettled([background, incoming].filter(Boolean))
      h.runtime.stop()
    }
  }
})

test('作品与订阅经模型工具持久化，订阅更新自主唤醒且去重，不借用群友身份', async () => {
  let fetched = 0
  const lateFeed = deferred()
  const h = fixture({
    fetchCharacterFeed: async () => {
      fetched++
      if (fetched === 3) throw new Error('隔离测试的订阅读取失败')
      if (fetched === 4) await lateFeed.promise
      return [{ id: fetched === 4 ? 'release-late' : 'release-1', title: '解谜游戏发布更新', url: 'https://example.com/release/1', summary: '公开更新摘要', receivedAt: h.clock.value }]
    },
    script: (_request, index) => index === 0 ? tools(
      call('simWorkspace', { action: 'write', title: '我的游戏笔记', kind: 'note', content: '我想研究它的谜题设计。', evidenceRefs: ['message:1'] }),
      call('simSubscription', { action: 'add', title: '游戏更新', kind: 'rss', url: 'https://example.com/feed.xml', intervalHours: 1 }),
    ) : index === 2 ? tools(call('searchInformationTool', {})) : quiet(),
  })
  try {
    await h.ingest(); await idle(h, 2)
    let detail = await h.runtime.describeGroup(GROUP)
    assert.equal(detail.activities.works[0].versions[0].content, '我想研究它的谜题设计。')
    assert.deepEqual(detail.activities.works[0].versions[0].evidenceRefs, ['message:1'])
    assert.equal(detail.activities.subscriptions.length, 1)
    h.clock.value = detail.activities.subscriptions[0].nextPollAt
    await h.runtime.sweepOnce(); await idle(h, 4)
    detail = await h.runtime.describeGroup(GROUP)
    assert.equal(detail.lastWakeReason, 'interestUpdate')
    assert.equal(fetched, 1)
    assert.equal(detail.activities.subscriptions[0].items[0].id, 'release-1')
    assert.equal(h.events.length, 1)
    assert.equal(h.events[0].event.simulationActor.kind, 'autonomous')
    assert.equal('user_id' in h.events[0].event, false)
    assert.equal('sender' in h.events[0].event, false)
    h.clock.value = detail.activities.subscriptions[0].nextPollAt
    await h.runtime.sweepOnce(); await sleep(1100)
    assert.equal(fetched, 2)
    assert.equal(h.calls.length, 4, '相同订阅条目不再触发模型回合')
    detail = await h.runtime.describeGroup(GROUP)
    h.clock.value = detail.activities.subscriptions[0].nextPollAt
    await h.runtime.sweepOnce(); await sleep(1100)
    detail = await h.runtime.describeGroup(GROUP)
    assert.equal(fetched, 3)
    assert.equal(detail.activities.subscriptions[0].failures, 1)
    assert.equal(h.calls.length, 4, '订阅读取失败不能触发兴趣更新回合')
    assert.ok(detail.character.receipts.some(receipt => receipt.toolName === 'simSubscriptionPoll' && receipt.status === 'failed'))
    const previousPolls = new Set(detail.character.receipts.filter(receipt => receipt.toolName === 'simSubscriptionPoll').map(receipt => receipt.id))
    h.clock.value = detail.activities.subscriptions[0].nextPollAt
    const polling = h.runtime.sweepOnce()
    await waitFor(() => fetched === 4, '订阅读取等待返回')
    await h.runtime.controlCharacter(GROUP, 'pause')
    lateFeed.resolve(); await polling; await sleep(1100)
    detail = await h.runtime.describeGroup(GROUP)
    assert.equal(detail.activities.subscriptions[0].items.some(item => item.id === 'release-late'), false)
    assert.equal(detail.character.receipts.find(receipt => receipt.toolName === 'simSubscriptionPoll' && !previousPolls.has(receipt.id)).status, 'unknown', '取消中的抓取结果不能伪装成已确认失败')
    assert.equal(h.calls.length, 4, '暂停后迟到的订阅结果不能再触发自主回合')
    assert.equal(h.sent.length, 0)
  } finally { lateFeed.resolve(); h.runtime.stop() }
})

test('订阅更新自主回合的自然语言收尾不触发催发或兜底发送', async () => {
  const text = '刚看到订阅有更新，但群里一个多小时没人说话，我就不主动甩链接打扰了，安静记着，等有人聊到纸灯塔再说。继续潜水。'
  const h = fixture({
    fetchCharacterFeed: async () => [{ id: 'release-quiet', title: '纸灯塔更新', url: 'https://example.com/release/quiet', summary: '公开更新摘要', receivedAt: h.clock.value }],
    script: (_request, index) => index === 0 ? tools(call('simSubscription', {
      action: 'add', title: '纸灯塔更新', kind: 'rss', url: 'https://example.com/feed.xml', intervalHours: 1,
    })) : index === 1 ? quiet() : { role: 'assistant', content: text },
  })
  try {
    await h.ingest(); await idle(h, 2)
    h.clock.value = (await h.runtime.describeGroup(GROUP)).activities.subscriptions[0].nextPollAt
    await h.runtime.sweepOnce(); await idle(h, 3)
    const detail = await h.runtime.describeGroup(GROUP)
    assert.equal(detail.lastWakeReason, 'interestUpdate')
    assert.equal(detail.activities.subscriptions[0].items[0].id, 'release-quiet')
    assert.equal(h.calls.length, 3, '订阅回合不能因普通最终文本追加模型催发')
    assert.equal(h.sent.length, 0)
    assert.equal(detail.character.decision, undefined)
    const history = JSON.parse(h.kv.get(sessionKey(GROUP))).agentHistory
    assert.ok(history.some(message => message.role === 'assistant' && message.content === text))
    assert.equal(history.some(message => message.content?.includes('【系统提醒】你刚才写的这段话群友看不到')), false)
  } finally { h.runtime.stop() }
})

test('后台反思阻止重置和巡检重入，保留新消息，暂停后丢弃迟到结果且不发送', async () => {
  const held = deferred()
  let reflected = 0, signal
  const h = fixture({ reflectCharacter: async (request, _config, abortSignal) => {
    assert.equal(request.messages[0].role, 'system', '反思规则与来源保留在 system 消息')
    assert.equal(request.messages[1].role, 'user', '兼容不接受 system-only 请求的模型服务')
    assert.match(request.messages[1].content, /反思.*JSON/u)
    assert.equal(request.tools, undefined, '反思调用不得获得发送工具')
    reflected++; signal = abortSignal; await held.promise
    return { choices: [{ message: { content: JSON.stringify({ summary: '形成新观点', updates: [{ kind: 'opinion', content: '我更喜欢连贯线索', evidenceRefs: ['memory:source-a', 'memory:source-b'] }], goals: [] }) } }], usage: { total_tokens: 20 } }
  } })
  let background
  try {
    await h.memory('source-a', '我喜欢探索'); await h.memory('source-b', '我喜欢有线索的谜题')
    const initial = await h.runtime.describeGroup(GROUP)
    assert.equal(initial.activities.reflection.nextRunAt, BASE + 6 * HOUR)
    h.clock.value = initial.activities.reflection.nextRunAt
    background = h.runtime.sweepOnce()
    await waitFor(() => reflected === 1, '反思调用等待回执')
    assert.match(await h.runtime.resetGroup(GROUP), /后台.*进行中/)
    const revision = (await h.characters.load(h.scope())).revision
    await h.runtime.sweepOnce()
    assert.equal(reflected, 1)
    assert.equal((await h.characters.load(h.scope())).revision, revision, '重叠巡检不能修改反思的来源版本')
    await h.ingest('反思期间收到的新消息', { at: false })
    await h.runtime.controlCharacter(GROUP, 'pause')
    held.resolve(); await background
    const session = JSON.parse(h.kv.get(sessionKey(GROUP)))
    assert.ok(session.unread.some(message => message.text === '反思期间收到的新消息'))
    assert.ok(session.recent.some(message => message.text === '反思期间收到的新消息'))
    const character = await h.characters.load(h.scope())
    assert.equal(character.paused, true)
    assert.equal(character.memories.length, 2, '暂停后的反思不能落库')
    assert.equal(h.calls.length, 0)
    assert.equal(h.sent.length, 0)
    assert.equal(typeof signal.aborted, 'boolean')
  } finally { held.resolve(); if (background) await background; h.runtime.stop() }
})

test('共享只投影已批自我偏好；模型等待时撤销会拦截迟到发送并防止旧历史复活', async () => {
  const held = deferred()
  let waiting = false
  const preference = '我偏爱能够自由探索的独立解谜游戏'
  const privateText = '只有原群知道的私聊细节'
  const h = fixture({ groups: [GROUP, OTHER_GROUP], script: async (request, index) => {
    if (index === 0) {
      const prompt = JSON.stringify(request.messages)
      assert.ok(prompt.includes(preference))
      assert.equal(prompt.includes(privateText), false)
      assert.equal(prompt.includes(GROUP), false, '共享投影不能携带原群号')
      assert.equal(prompt.includes('sourceMemoryId'), false)
      waiting = true; await held.promise
      return tools(call('simSendMessage', { messages: ['撤销以后不得发送这段旧上下文'] }))
    }
    return quiet()
  } })
  try {
    await h.memory('own-interest', preference)
    await h.memory('private-experience', privateText, GROUP, 'experience')
    const shared = createCharacterSharedSelf({ redis: h.redis, scope: h.scope(), now: () => h.clock.value })
    const id = await shared.propose('own-interest')
    await h.runtime.controlActivity(GROUP, 'shared-approve', id)
    await h.ingest('你更喜欢什么游戏', { groupId: OTHER_GROUP })
    await waitFor(() => waiting, '另一群模型已读取共享偏好')
    await h.runtime.controlActivity(GROUP, 'shared-delete', id)
    held.resolve(); await idle(h, 2, OTHER_GROUP)
    assert.match(toolResult(h.calls[1], 'simSendMessage'), /^error:/)
    assert.equal(h.sent.length, 0)
    assert.deepEqual(JSON.parse(h.kv.get(sessionKey(OTHER_GROUP))).agentHistory, [])
    assert.deepEqual((await h.runtime.describeGroup(OTHER_GROUP)).activities.shared, [])
  } finally { held.resolve(); h.runtime.stop() }
})

test('独立控制台删除作品会撤销机器人迟到发送，撤销版本不被旧会话覆盖且旧历史不复活', async () => {
  const held = deferred(), entered = deferred()
  const content = '待撤销作品的私有正文标记'
  const versions = []
  let workId
  const h = fixture({ beforeSet: async (key, value) => { if (key.endsWith(':activity-version')) versions.push(value) }, script: async (request, index) => {
    if (index === 0) return tools(call('simWorkspace', { action: 'write', title: '本群作品', kind: 'note', content, evidenceRefs: ['message:1'] }))
    if (index === 2) return tools(call('simWorkspace', { action: 'read', id: workId }))
    if (index === 3) {
      assert.ok(JSON.stringify(request.messages).includes(content), '机器人已读到将被撤销的正文')
      entered.resolve(); await held.promise
      return tools(call('simSendMessage', { messages: [content] }))
    }
    if (index === 5) assert.equal(JSON.stringify(request.messages).includes(content), false, '后续回合不得复用删除前的模型历史')
    return quiet()
  } })
  const consoleRuntime = h.peerRuntime()
  try {
    await h.ingest(); await idle(h, 2)
    workId = (await h.runtime.describeGroup(GROUP)).activities.works[0].id
    await h.ingest('读一下本群作品，想分享就发出来')
    await entered.promise
    const oldSession = h.kv.get(sessionKey(GROUP))
    await consoleRuntime.controlActivity(GROUP, 'work-delete', workId)
    const versionKey = `${sessionKey(GROUP)}:activity-version`, revokedVersion = h.kv.get(versionKey)
    assert.ok(revokedVersion)
    assert.equal(versions.length, 2, '源修改前后各撤销一次，覆盖修改期间启动的回合')
    assert.notEqual(versions[0], versions[1])
    assert.equal(h.kv.get(sessionKey(GROUP)), oldSession, '独立控制台不得把旧会话整份写回覆盖入站和预算')
    held.resolve(); await idle(h, 5)
    assert.match(toolResult(h.calls[4], 'simSendMessage'), /^error:/)
    assert.equal(h.sent.length, 0, '删除成功后到达的旧模型结果不得发出')
    assert.equal(h.kv.get(versionKey), revokedVersion, '机器人旧会话收尾不能覆盖独立撤销版本')
    assert.deepEqual(JSON.parse(h.kv.get(sessionKey(GROUP))).agentHistory, [])
    assert.equal((await consoleRuntime.describeGroup(GROUP)).activities.works.length, 0)
    await h.ingest('开始一个新的话题'); await idle(h, 6)
    assert.equal(h.kv.get(versionKey), revokedVersion)
  } finally { held.resolve(); h.runtime.stop(); consoleRuntime.stop() }
})

test('独立控制台删除记忆不回写旧会话，机器人迟到正文与后续旧历史均被撤销', async () => {
  const held = deferred(), entered = deferred(), versions = []
  const content = '删除记忆的私有正文标记'
  const h = fixture({ beforeSet: async (key, value) => { if (key.endsWith(':activity-version')) versions.push(value) }, script: async (request, index) => {
    if (index === 0) {
      assert.ok(JSON.stringify(request.messages).includes(content))
      entered.resolve(); await held.promise
      return tools(call('simSendMessage', { messages: [content] }))
    }
    if (index === 2) assert.equal(JSON.stringify(request.messages).includes(content), false)
    return quiet()
  } })
  const consoleRuntime = h.peerRuntime()
  try {
    await h.memory('delete-source', content)
    await h.ingest('按你的记忆回应'); await entered.promise
    const before = h.kv.get(sessionKey(GROUP))
    await consoleRuntime.controlCharacter(GROUP, 'delete-memory', 'delete-source')
    assert.equal(h.kv.get(sessionKey(GROUP)), before, '控制台删除记忆也不能整份覆盖机器人会话')
    assert.equal(versions.length, 2)
    assert.notEqual(versions[0], versions[1])
    const version = h.kv.get(`${sessionKey(GROUP)}:activity-version`)
    held.resolve(); await idle(h, 2)
    assert.match(toolResult(h.calls[1], 'simSendMessage'), /^error:/)
    assert.equal(h.sent.length, 0)
    assert.deepEqual(JSON.parse(h.kv.get(sessionKey(GROUP))).agentHistory, [])
    assert.equal(h.kv.get(`${sessionKey(GROUP)}:activity-version`), version)
    await h.ingest('新的无关话题'); await idle(h, 3)
  } finally { held.resolve(); h.runtime.stop(); consoleRuntime.stop() }
})

test('工作器成功的完整万字产物自动保存为作品，模型只收作品引用；缺少状态回执不能伪造成功', async () => {
  const content = '研'.repeat(10_000)
  const executed = []
  const h = fixture({ characterWorkerAvailable: () => true,
    runCharacterWorker: async (task, scope, signal) => { executed.push({ task, scope, signal }); return { status: 'succeeded', summary: '研究草稿已返回', artifact: { title: '谜题设计研究', content } } },
    script: (_request, index) => index === 0 ? tools(call('simWorkerTask', { kind: 'research', instruction: '研究这款游戏的谜题设计', evidenceRefs: ['message:1'] })) : quiet(),
  })
  try {
    assert.equal((await h.runtime.describeGroup(GROUP)).activities.capabilities.find(item => item.name === '外部工作器').available, true)
    await h.ingest(); await idle(h, 2)
    assert.equal(executed.length, 1)
    assert.deepEqual(executed[0].scope, h.scope())
    const output = toolResult(h.calls[1], 'simWorkerTask')
    const result = JSON.parse(output.split('\n【运行时行动回执】')[0])
    const receipt = receiptFrom(output)
    assert.equal(result.status, 'succeeded')
    assert.ok(result.savedWork.id)
    assert.equal('artifact' in result, false, '正文不得被工具输出截断后交给模型')
    const detail = await h.runtime.describeGroup(GROUP)
    const work = detail.activities.works.find(item => item.id === result.savedWork.id)
    assert.equal(work.versions[0].content, content)
    assert.deepEqual(work.versions[0].evidenceRefs, [receipt.evidenceRef])
    assert.equal(receipt.status, 'succeeded')
    assert.equal(`receipt:${executed[0].task.taskId}`, receipt.evidenceRef)
    assert.equal(h.sent.length, 0)
  } finally { h.runtime.stop() }

  const invalid = fixture({ characterWorkerAvailable: () => true,
    runCharacterWorker: async () => ({ summary: '自称已完成但没有状态回执', artifact: { title: '不可信作品', content: '不能落库' } }),
    script: (_request, index) => index === 0 ? tools(call('simWorkerTask', { kind: 'research', instruction: '执行研究', evidenceRefs: ['message:1'] })) : quiet(),
  })
  try {
    await invalid.ingest(); await idle(invalid, 2)
    const output = toolResult(invalid.calls[1], 'simWorkerTask')
    assert.equal(receiptFrom(output).status, 'unknown')
    const detail = await invalid.runtime.describeGroup(GROUP)
    assert.equal(detail.activities.works.length, 0)
    assert.equal(detail.character.receipts.some(item => item.toolName === 'simWorkerTask' && item.status === 'succeeded'), false)
    assert.equal(invalid.sent.length, 0)
  } finally { invalid.runtime.stop() }
})

test('目标回合的工作器结果未知会暂停目标，后续巡检不自动重复提交', async () => {
  let submitted = 0
  const h = fixture({ characterWorkerAvailable: () => true,
    runCharacterWorker: async () => { submitted++; return { status: 'unknown', summary: '远端任务结果未能确认' } },
    script: (_request, index) => index === 0 ? tools(call('simWorkerTask', { kind: 'research', instruction: '研究线索设计', evidenceRefs: ['message:1'] })) : quiet(),
  })
  try {
    const state = createCharacterGoal(createEmptyCharacterState(h.scope()), {
      id: 'research-goal', title: '研究谜题线索', motivation: '我关注解谜设计', nextStep: '提交研究任务',
      completionCriteria: '获得经过确认的研究回执', stopConditions: ['管理员取消'], evidenceRefs: ['message:1'],
    }, ['message:1'], h.clock.value)
    h.kv.set(characterKey(h.scope()), JSON.stringify(state))
    await h.ingest('本轮研究的消息来源', { at: false })
    h.clock.value = state.goals[0].nextCheckAt
    await h.runtime.sweepOnce(); await idle(h, 2)
    let detail = await h.runtime.describeGroup(GROUP)
    assert.equal(detail.character.goals[0].status, 'paused')
    assert.equal(detail.character.receipts.find(item => item.toolName === 'simWorkerTask').status, 'unknown')
    assert.equal(submitted, 1)
    h.clock.value += HOUR
    await h.runtime.sweepOnce(); await sleep(1100)
    detail = await h.runtime.describeGroup(GROUP)
    assert.equal(detail.character.goals[0].status, 'paused')
    assert.equal(submitted, 1)
    assert.equal(h.calls.length, 2)
    assert.equal(h.sent.length, 0)
  } finally { h.runtime.stop() }
})
