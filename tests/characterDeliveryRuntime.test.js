import assert from 'node:assert/strict'
import test from 'node:test'
import { createSimulationRuntime } from '../dist/backend/modules/simulation/infrastructure/simulationRuntime.js'
import { createDefaultSimSession } from '../dist/backend/modules/simulation/domain/simConfig.js'
import { characterKey } from '../dist/backend/modules/simulation/domain/characterState.js'
import { hostSimulationSender } from './helpers/simulationHostSender.mjs'

const BOT = '3094088525'
const GROUP = '10086'
const AT = 1_790_000_000_000
const SESSION_KEY = `shiloh:sim:g:${GROUP}`
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let sequence = 0
const call = (name, args) => ({ id: `delivery-${++sequence}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const response = (...calls) => ({ role: 'assistant', content: '', tool_calls: calls })
const finish = messages => call('simFinishTurn', { choice: 'chat', reason: '回应当前话题', messages, throughSeq: 1 })
const send = messages => call('simSendMessage', { continuation: 'chat', messages })

/** Uses the compiled production runtime with isolated storage and captured QQ transport. */
function fixture({ script, transport, hostTransport, maxSendsPerTurn = 5, extraTools = [], card = false, poke, qzone } = {}) {
  const state = createDefaultSimSession(AT)
  state.bootstrapSent = true
  state.botId = BOT
  state.wakeConfig.triggers.probability = 0
  state.nextProactiveCheckAt = 0
  const kv = new Map([[SESSION_KEY, JSON.stringify(state)]])
  const sent = [], requests = [], errors = []
  const runtime = createSimulationRuntime({
    redis: {
      async get(key) { return kv.get(key) ?? null },
      async set(key, value) { kv.set(key, value); return 'OK' },
      async del(...keys) { return keys.reduce((count, key) => count + Number(kv.delete(key)), 0) },
    },
    now: () => AT, random: () => 0,
    logger: { info() {}, warn() {}, error(...items) { errors.push(items.map(String).join(' ')) } },
    getSelf: () => ({ id: BOT, name: '希洛' }),
    getPersona: () => ({ personaId: 'shiloh', persona: { name: '希洛' }, systemContent: '喜欢独立游戏' }),
    getSection: () => ({
      enabled: true, allGroups: false, groups: [GROUP],
      toolPolicy: { mode: 'legacy' }, extraTools: extraTools.map(tool => tool.name),
      wake: { probability: 0, batchWindowMs: 1000, maxWakePerMinute: 100, maxWakePerHour: 100, proactiveProbability: 0 },
      turn: { maxToolRounds: 8, maxSendsPerTurn, minSendGapMs: 0, maxTurnsPerDay: 100 },
      rhythm: { enabled: false }, mood: { enabled: false }, wakeGate: { enabled: false }, userStyle: { enabled: false },
      ...(qzone ? { qzone: { enabled: true } } : {}),
    }),
    getExecutionConfig: () => ({ useTools: true }),
    getExtraTools: names => extraTools.filter(tool => names.includes(tool.name)),
    ...(card ? { resolveBilibiliCard: async () => ({ ok: true, title: '合成视频', cardJson: '{"app":"test"}' }) } : {}),
    ...(poke ? { pokeMember: poke } : {}),
    ...(qzone ? { qzoneInteract: qzone } : {}),
    async YTapi(request) {
      requests.push(structuredClone(request))
      const message = await script(request, requests.length - 1)
      return { choices: [{ message, finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop' }], usage: { total_tokens: 10 }, model: 'isolated-delivery-test' }
    },
    async sendGroupMessage(groupId, segments) {
      const receipt = hostTransport ? await hostTransport(groupId, segments, BOT) : transport ? await transport({ groupId, segments, kv, sent }) : { ok: true, messageId: `sent-${sent.length + 1}` }
      if (receipt.ok) sent.push({ groupId, segments })
      return receipt
    },
  })
  return {
    runtime, kv, sent, requests,
    session: () => JSON.parse(kv.get(SESSION_KEY)),
    reply: tool => JSON.parse(kv.get(SESSION_KEY)).agentHistory.find(item => item.role === 'tool' && item.tool_call_id === tool.id)?.content,
    async run(minCalls = 1) {
      await runtime.ingest({ group_id: GROUP, self_id: BOT, user_id: '40000', message_type: 'group', atBot: true,
        msg: '聊聊刚才的话题', message: [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: '聊聊刚才的话题' } }], sender: { nickname: '群友' } })
      const deadline = Date.now() + 6000
      while (Date.now() < deadline) {
        if (requests.length >= minCalls && !(await runtime.describeGroup(GROUP)).running) return
        await sleep(20)
      }
      assert.fail(`隔离回合未结束：${errors.join(' | ')}`)
    },
  }
}

test('同回合收尾去重使用完整正文，百字后不同的消息仍各发送一次', async () => {
  const prefix = '这段共同的上下文'.repeat(16)
  const first = `${prefix}甲`, second = `${prefix}乙`
  const closing = finish([first, second, second])
  const h = fixture({ script: (_request, index) => index === 0 ? response(send([first])) : response(closing) })
  try {
    await h.run(2)
    assert.deepEqual(h.sent.map(item => item.segments.find(segment => segment.type === 'text').data.text), [first, second])
    const result = JSON.parse(h.reply(closing))
    assert.equal(result.sendStatus, 'succeeded')
    assert.equal(result.sent, 1)
    assert.equal(result.duplicatesSkipped, 2)
    assert.equal(h.session().sendTimes.length, 2)
  } finally { h.runtime.stop() }
})

test('收尾全部为本回合已发送正文时可零发送完成，并明确去重数量', async () => {
  const text = '这条消息已经表达过了'
  const closing = finish([text])
  const h = fixture({ script: (_request, index) => index === 0 ? response(send([text])) : response(closing), maxSendsPerTurn: 1 })
  try {
    await h.run(2)
    assert.equal(h.sent.length, 1)
    const result = JSON.parse(h.reply(closing))
    assert.equal(result.sendStatus, 'succeeded')
    assert.equal(result.sent, 0)
    assert.equal(result.duplicatesSkipped, 1)
    assert.equal(result.readStatus, 'succeeded')
  } finally { h.runtime.stop() }
})

test('批次剩余额度不足时整批拒绝，不先发送可容纳的前半段', async () => {
  const closing = finish(['这批的第一条', '这批的第二条'])
  const h = fixture({ script: (_request, index) => index === 0 ? response(send(['此前的一条消息'])) : response(closing), maxSendsPerTurn: 2 })
  try {
    await h.run(2)
    assert.equal(h.sent.length, 1)
    const result = JSON.parse(h.reply(closing))
    assert.equal(result.sendStatus, 'failed')
    assert.equal(result.sent, 0)
    assert.equal(result.readStatus, 'failed')
    assert.equal(h.session().sendTimes.length, 1)
  } finally { h.runtime.stop() }
})

test('整批预检出站清理失败时零发送，不能先发送正常的第一条', async () => {
  const closing = finish(['这条是普通聊天消息', 'TypeError: internal private implementation exploded in backend'])
  const h = fixture({ script: () => response(closing) })
  try {
    await h.run()
    assert.equal(h.sent.length, 0)
    const result = JSON.parse(h.reply(closing))
    assert.equal(result.sendStatus, 'failed')
    assert.equal(result.sent, 0)
    assert.equal(h.session().sendTimes.length, 0)
  } finally { h.runtime.stop() }
})

test('真实传输第二条失败保留首条发送计数和落盘证据，不自动重发', async () => {
  const closing = finish(['已经发出的第一条', '网关失败的第二条'])
  let attempts = 0, persistedBeforeFailure = -1
  const h = fixture({ script: () => response(closing), transport: async ({ kv }) => {
    attempts++
    if (attempts === 2) {
      persistedBeforeFailure = JSON.parse(kv.get(SESSION_KEY)).sendTimes.length
      return { ok: false, error: 'injected transport failure' }
    }
    return { ok: true, messageId: 'confirmed-first-message' }
  } })
  try {
    await h.run()
    assert.equal(attempts, 2)
    assert.equal(h.sent.length, 1)
    assert.equal(persistedBeforeFailure, 1, '下一次传输前已确认发送的预算应落盘')
    const result = JSON.parse(h.reply(closing))
    assert.equal(result.saved, true)
    assert.equal(result.sendStatus, 'failed')
    assert.equal(result.sent, 1)
    assert.equal(result.readStatus, 'failed')
    assert.equal(h.session().sendTimes.length, 1)
    assert.equal(h.requests.length, 1)
  } finally { h.runtime.stop() }
})

test('首条传输已提交但回执丢失记为 unknown，同批和后续收尾均不得重发', async () => {
  const text = '回执丢失但可能已经送达的消息'
  const initial = send([text])
  const closing = finish([text])
  const delivered = []
  const h = fixture({
    script: (_request, index) => index === 0 ? response(initial, send([text])) : response(closing),
    transport: async ({ segments }) => {
      delivered.push(segments.find(segment => segment.type === 'text').data.text)
      throw new Error('injected timeout after gateway accepted message')
    },
  })
  try {
    await h.run(2)
    assert.deepEqual(delivered, [text])
    const character = JSON.parse(h.kv.get(characterKey({ botId: BOT, personaId: 'shiloh', groupId: GROUP })))
    assert.equal(character.receipts.find(receipt => receipt.toolName === 'simSendMessage').status, 'unknown')
    assert.match(h.reply(initial), /"status":"unknown"/)
    assert.equal(h.session().sendTimes.length, 0, '未取得确认不能伪造已成功发送计数')
    assert.equal(h.session().lastReadThroughSeq, 0, '未确认发送不能标读')
  } finally { h.runtime.stop() }
})

test('额外工具的纯文本 e.reply 与收尾共用本回合确认正文，不能重复发送', async () => {
  const text = '额外工具已经发出的普通文本'
  const closing = finish([text])
  const external = {
    name: 'deliveryReplyTool', description: '隔离发送回归工具', parameters: { type: 'object', properties: {}, required: [] },
    async execute(_args, event) { await event.reply(text); return { ok: true } },
  }
  const h = fixture({ extraTools: [external], script: (_request, index) => index === 0 ? response(call(external.name, {})) : response(closing) })
  try {
    await h.run(2)
    assert.deepEqual(h.sent.map(item => item.segments.find(segment => segment.type === 'text').data.text), [text])
    const result = JSON.parse(h.reply(closing))
    assert.equal(result.sendStatus, 'succeeded')
    assert.equal(result.sent, 0)
    assert.equal(result.duplicatesSkipped, 1)
    assert.equal(h.session().sendTimes.length, 1)
  } finally { h.runtime.stop() }
})

test('额外工具带引用和提及的混合正文只去重文本，保留实际发送段结构', async () => {
  const first = '首次回复中的已确认正文', second = '混合回复中新增的正文'
  const quote = { type: 'reply', data: { id: 'quoted-message' } }
  const mention = { type: 'at', data: { qq: '40000' } }
  const segment = text => ({ type: 'text', data: { text } })
  const closing = finish([second])
  const external = {
    name: 'deliveryReplyTool', description: '隔离分段发送回归工具', parameters: { type: 'object', properties: {}, required: [] },
    async execute(_args, event) {
      await event.reply([quote, mention, segment(first)])
      await event.reply([quote, mention, segment(first), segment(second)])
      return { ok: true }
    },
  }
  const h = fixture({ extraTools: [external], script: (_request, index) => index === 0 ? response(call(external.name, {})) : response(closing) })
  try {
    await h.run(2)
    assert.deepEqual(h.sent.map(item => item.segments), [
      [quote, mention, segment(first)],
      [quote, mention, segment(second)],
    ])
    const result = JSON.parse(h.reply(closing))
    assert.equal(result.sendStatus, 'succeeded')
    assert.equal(result.sent, 0)
    assert.equal(result.duplicatesSkipped, 1)
    assert.equal(h.session().sendTimes.length, 2)
  } finally { h.runtime.stop() }
})

test('整批消息超过配置发送上限时零发送，不在归一参数时截掉尾条', async () => {
  const closing = finish(['第一条完整消息', '第二条完整消息', '第三条完整消息'])
  const h = fixture({ maxSendsPerTurn: 2, script: () => response(closing) })
  try {
    await h.run()
    assert.equal(h.sent.length, 0)
    assert.match(h.reply(closing), /^error: .*尚未保存或发送/)
    assert.equal(h.session().lastReadThroughSeq, 0)
  } finally { h.runtime.stop() }
})

test('宿主发送前明确拒绝仍允许同回合修正，不能误锁为未知副作用', async () => {
  let checks = 0, attempts = 0
  const text = '修正已知阻碍后可以发送的消息'
  const hostTransport = hostSimulationSender({
    settings: () => ({ simulation: { enabled: ++checks > 1 } }),
    bot: () => ({ pickGroup: () => ({ async sendMsg() { attempts++; return { message_id: 'corrected-send' } } }) }),
  })
  const initial = send([text]), corrected = send([text]), closing = finish([text])
  const h = fixture({ hostTransport, script: (_request, index) => index === 0 ? response(initial, corrected) : response(closing) })
  try {
    await h.run(2)
    assert.equal(attempts, 1); assert.equal(h.sent.length, 1)
    assert.match(h.reply(initial), /^error:/)
    assert.match(h.reply(corrected), /"status":"succeeded"/)
    const result = JSON.parse(h.reply(closing))
    assert.equal(result.sendStatus, 'succeeded'); assert.equal(result.sent, 0); assert.equal(result.duplicatesSkipped, 1)
    assert.notEqual(result.deliveryUnknown, true)
  } finally { h.runtime.stop() }
})

for (const first of ['text', 'reply', 'card']) test(`真实宿主 ${first} 回执未知后所有出站均停止，不经其他工具绕过`, async () => {
  let attempts = 0, pokes = 0, interactions = 0
  const hostTransport = hostSimulationSender({ bot: () => ({ pickGroup: () => ({ async sendMsg() { attempts++; throw new Error('accepted by gateway before timeout') } }) }) })
  const text = '可能已经被平台接受的文本'
  const external = { name: 'deliveryReplyTool', description: '隔离工具', parameters: { type: 'object', properties: {}, required: [] }, async execute(_args, event) { await event.reply(text); return { ok: true } } }
  const cardCall = () => call('simShareVideoCard', { url: 'https://www.bilibili.com/video/BVtest' })
  const initial = first === 'text' ? send([text]) : first === 'reply' ? call(external.name, {}) : cardCall()
  const closing = finish([text])
  const h = fixture({ hostTransport, card: true, extraTools: [external],
    poke: async () => { pokes++; return { ok: true } },
    qzone: async () => { interactions++; return { ok: true } },
    script: (_request, index) => index === 0 ? response(initial, send([text]), cardCall(), call(external.name, {}), call('simSendPoke', { userId: '40000' }), call('simQzoneInteract', { action: 'comment', userId: '40000', tid: 'one', text: '这条评论不应发出' })) : response(closing),
  })
  try {
    await h.run(2)
    assert.equal(attempts, 1); assert.equal(pokes, 0); assert.equal(interactions, 0)
    const character = JSON.parse(h.kv.get(characterKey({ botId: BOT, personaId: 'shiloh', groupId: GROUP })))
    assert.equal(character.receipts.find(receipt => receipt.toolName === initial.function.name).status, 'unknown')
    const result = JSON.parse(h.reply(closing))
    assert.equal(result.deliveryUnknown, true); assert.equal(result.sent, 0); assert.equal(result.readStatus, 'failed')
    assert.equal(h.session().sendTimes.length, 0)
  } finally { h.runtime.stop() }
})
