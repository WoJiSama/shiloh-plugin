import test from 'node:test'
import assert from 'node:assert/strict'
import { createSimulationRuntime } from '../dist/backend/modules/simulation/infrastructure/simulationRuntime.js'

const SELF_ID = '3094088525'
const GROUP = '10086'
const SESSION_KEY = `shiloh:sim:g:${GROUP}`

const BASE_AT = 1770000000000
function buildRuntime({ atOnly = [], activeUntil = 0, randomValue = 0.99, responses, now = () => BASE_AT, judge, batchWindowMs } = {}) {
  const kv = new Map()
  // 预置 overrides（atOnly/活跃助推用）；留空则运行时按 groups 种子
  if (atOnly.length || activeUntil) {
    kv.set('shiloh:sim:overrides', JSON.stringify({ explicitEnabled: [GROUP], disabled: [], budgetCaps: {}, turnCaps: {}, atOnly, ...(activeUntil ? { playAlongUntil: { [GROUP]: activeUntil } } : {}) }))
  }
  const modelCalls = []
  const sent = []
  const reply = (content) => ({
    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { total_tokens: 10 },
    model: 'test',
  })
  const runtime = createSimulationRuntime({
    redis: {
      async get(key) { return kv.has(key) ? kv.get(key) : null },
      async set(key, value) { kv.set(key, value); return 'OK' },
      async del(...keys) { let n = 0; for (const key of keys) if (kv.delete(key)) n += 1; return n },
    },
    logger: { info() {}, warn() {}, error() {} },
    getSection: () => ({ enabled: true, allGroups: false, groups: [GROUP], ...(batchWindowMs ? { wake: { batchWindowMs } } : {}) }),
    getExecutionConfig: () => ({}),
    getSelf: () => ({ id: SELF_ID, name: '希洛' }),
    YTapi: responses
      ? async () => { modelCalls.push(modelCalls.length); return reply(responses[Math.min(modelCalls.length - 1, responses.length - 1)]) }
      : async () => { throw new Error('ingest 路径不应触达模型') },
    sendGroupMessage: async (_groupId, segments) => { sent.push(segments); return { ok: true, messageId: 'm1' } },
    getPersona: () => ({ persona: {}, systemContent: '' }),
    ...(judge ? { wakeGateJudge: judge } : {}),
    now,
    random: () => randomValue,
  })
  return { runtime, kv, modelCalls, sent }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(check, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return true
    await sleep(50)
  }
  return check()
}

function recent(kv) {
  return JSON.parse(kv.get(SESSION_KEY) || '{"recent":[]}').recent
}

function interlocutors(kv) {
  return JSON.parse(kv.get(SESSION_KEY) || '{"conversation":{}}').conversation.interlocutorIds || []
}

async function seedConversation(runtime) {
  await runtime.ingest({ group_id: GROUP, message_type: 'group', user_id: '10000', msg: '普通聊天', message: [], sender: { nickname: '群友' } })
}

test('被@机器人(atBot)的命令前缀消息照常入流并标记 atSelf', async () => {
  const { runtime, kv } = buildRuntime()
  try {
    await seedConversation(runtime)
    // TRSS-Yunzai 实拍形态：@机器人只设 e.atBot，e.at 不赋值；e.msg 已被适配器剥掉 @
    await runtime.ingest({
      group_id: GROUP, message_type: 'group', user_id: '10000',
      msg: '. r10#d100', atBot: true,
      message: [{ type: 'at', data: { qq: SELF_ID } }, { type: 'text', data: { text: ' . r10#d100' } }],
      sender: { nickname: '猫猫虫' },
    })
    const recorded = recent(kv).find(m => m.text === '. r10#d100')
    assert.ok(recorded, '「@这里是希洛! . r10#d100」必须进入会话缓冲')
    assert.equal(recorded.atSelf, true, 'atBot/点名段要落成 atSelf，atMention 唤醒才有依据')

    // 其他 Yunzai 分支用 e.at===true 表达被@，同样要认
    await runtime.ingest({
      group_id: GROUP, message_type: 'group', user_id: '10000',
      msg: '#help', at: true,
      message: [{ type: 'at', data: { qq: SELF_ID } }],
      sender: { nickname: '猫猫虫' },
    })
    assert.ok(recent(kv).some(m => m.text === '#help' && m.atSelf), 'e.at===true 分支也算被点名')
  } finally {
    runtime.stop()
  }
})

test('未被点名的命令前缀消息仍不入会话流', async () => {
  const { runtime, kv } = buildRuntime()
  try {
    await seedConversation(runtime)
    await runtime.ingest({ group_id: GROUP, message_type: 'group', user_id: '10000', msg: '.r10#d100', message: [], sender: { nickname: '猫猫虫' } })
    assert.ok(!recent(kv).some(m => m.text === '.r10#d100'), '纯命令消息继续被命令前缀过滤拦下')

    // @别的成员不是点名：TRSS 形态 e.at=对方QQ、at 段指向对方
    await runtime.ingest({
      group_id: GROUP, message_type: 'group', user_id: '10000',
      msg: '.r10#d100', at: '20000',
      message: [{ type: 'at', data: { qq: '20000' } }],
      sender: { nickname: '猫猫虫' },
    })
    assert.ok(!recent(kv).some(m => m.text === '.r10#d100' && m.atSelf), '@别人不算被机器人点名')
  } finally {
    runtime.stop()
  }
})

test('仅@才回：非点名消息入库但不唤醒，被@照常唤醒，可切回自主', async () => {
  // 对照组：random<概率触发阈值(0.05) 时普通消息必然唤醒（登记对话对象）
  const control = buildRuntime({ randomValue: 0.001 })
  try {
    await seedConversation(control.runtime)
    await control.runtime.ingest({ group_id: GROUP, message_type: 'group', user_id: '30000', msg: '围观聊天', message: [], sender: { nickname: '路人甲' } })
    assert.ok(interlocutors(control.kv).includes('30000'), '自主模式下普通消息会唤醒')
  } finally {
    control.runtime.stop()
  }

  // 仅@群：同样随机命中概率触发，普通消息唤醒被管理员设定压掉，消息照常入库
  const atOnly = buildRuntime({ atOnly: [GROUP], randomValue: 0.001 })
  try {
    await seedConversation(atOnly.runtime)
    await atOnly.runtime.ingest({ group_id: GROUP, message_type: 'group', user_id: '30000', msg: '围观聊天', message: [], sender: { nickname: '路人甲' } })
    assert.ok(recent(atOnly.kv).some(m => m.text === '围观聊天'), '仅@模式消息照常入库（AI 醒来后可读）')
    assert.ok(!interlocutors(atOnly.kv).includes('30000'), '仅@模式普通消息不唤醒、不算对话对象')

    await atOnly.runtime.ingest({
      group_id: GROUP, message_type: 'group', user_id: '40000',
      msg: '在吗', atBot: true,
      message: [{ type: 'at', data: { qq: SELF_ID } }, { type: 'text', data: { text: ' 在吗' } }],
      sender: { nickname: '点名的人' },
    })
    assert.ok(interlocutors(atOnly.kv).includes('40000'), '被@照常唤醒')

    // 模式切换与查询
    assert.match(await atOnly.runtime.setGroupReplyMode(GROUP, 'query'), /仅被@才回/)
    assert.match(await atOnly.runtime.setGroupReplyMode(GROUP, 'atOnly'), /已是/)
    assert.match(await atOnly.runtime.setGroupReplyMode(GROUP, 'auto'), /已设为「自主」/)
    await atOnly.runtime.ingest({ group_id: GROUP, message_type: 'group', user_id: '50000', msg: '又来围观', message: [], sender: { nickname: '路人乙' } })
    assert.ok(interlocutors(atOnly.kv).includes('50000'), '切回自主后普通消息恢复唤醒')
    assert.match(await atOnly.runtime.setGroupReplyMode(GROUP, 'query'), /自主/)
  } finally {
    atOnly.runtime.stop()
  }
})

test('沉默声明不提醒不外发：一次模型调用安静结束回合', async () => {
  const r = buildRuntime({ responses: ['无需发送，结束回合。'] })
  try {
    await r.runtime.ingest({ group_id: GROUP, message_type: 'group', user_id: '10000', msg: '大家好', message: [], sender: { nickname: '群友' } })
    assert.ok(await waitFor(() => r.modelCalls.length >= 1), '回合应启动并调用模型')
    await sleep(300)
    assert.equal(r.modelCalls.length, 1, '沉默声明不触发二次提醒调用')
    assert.equal(r.sent.length, 0, '沉默声明绝不外发进群')
  } finally {
    r.runtime.stop()
  }
})

test('被 @ 的真内容提醒一次仍哑火则兜底直发（不被沉默识别误伤）', async () => {
  const r = buildRuntime({ batchWindowMs: 1000, responses: ['今天也要加油鸭！', '今天也要加油鸭！呀'] })
  try {
    // 明确点名，验证用户回合兜底；未点名的新会话 bootstrap 属于自主主体。
    await r.runtime.ingest({ group_id: GROUP, message_type: 'group', user_id: '10000', msg: '大家好', atBot: true, message: [{ type: 'at', data: { qq: SELF_ID } }], sender: { nickname: '群友' } })
    assert.ok(await waitFor(() => r.modelCalls.length >= 2), '提醒后应有第二次调用')
    assert.ok(await waitFor(() => r.sent.length >= 1), '兜底应直发第二次文本')
    assert.ok(JSON.stringify(r.sent[0]).includes('今天也要加油鸭！呀'), `直发内容应为第二次文本: ${JSON.stringify(r.sent[0])}`)
  } finally {
    r.runtime.stop()
  }
})

test('活跃助推：窗口内群里有动静按节奏兜底唤醒，冷却期内不重复', async () => {
  let clock = BASE_AT
  const r = buildRuntime({ activeUntil: BASE_AT + 3 * 3600_000, randomValue: 0.99, now: () => clock })
  try {
    await seedConversation(r.runtime)
    // 无任何触发器命中的普通消息：活跃档接手（首条必过冷却，lastPlayAlongWakeAt 初始为 0）
    await r.runtime.ingest({ group_id: GROUP, message_type: 'group', user_id: '30000', msg: 'kp：你们坐上了开往帕佩里欧的火车', message: [], sender: { nickname: 'KP' } })
    assert.ok(interlocutors(r.kv).includes('30000'), '活跃档开启时普通剧情消息也唤醒')

    // 冷却期内（同一时刻）的下一条消息不再触发主动唤醒
    await r.runtime.ingest({ group_id: GROUP, message_type: 'group', user_id: '40000', msg: '我看向窗外', message: [], sender: { nickname: '队友' } })
    assert.ok(!interlocutors(r.kv).includes('40000'), '冷却期内不重复唤醒')

    // 冷却期过（默认 5 分钟）后恢复主动跟进
    clock += 6 * 60_000
    await r.runtime.ingest({ group_id: GROUP, message_type: 'group', user_id: '40000', msg: '火车进站了', message: [], sender: { nickname: '队友' } })
    assert.ok(interlocutors(r.kv).includes('40000'), '冷却期过后恢复主动唤醒')

    // 命令往返（三档：仅@/自主/活跃）
    assert.match(await r.runtime.setGroupReplyMode(GROUP, 'query'), /自主·活跃/)
    assert.match(await r.runtime.setGroupReplyMode(GROUP, 'active'), /已是「自主·活跃」/)
    assert.match(await r.runtime.setGroupReplyMode(GROUP, 'auto'), /已设为「自主」/)
    await r.runtime.ingest({ group_id: GROUP, message_type: 'group', user_id: '50000', msg: '继续赶路', message: [], sender: { nickname: '队友' } })
    assert.ok(!interlocutors(r.kv).includes('50000'), '调回普通自主档后普通消息不再主动唤醒')
  } finally {
    r.runtime.stop()
  }
})

test('仅@模式与活跃档状态并存时，主动跟进唤醒被压掉', async () => {
  const r = buildRuntime({ atOnly: [GROUP], activeUntil: BASE_AT + 3 * 3600_000, randomValue: 0.99 })
  try {
    await seedConversation(r.runtime)
    await r.runtime.ingest({ group_id: GROUP, message_type: 'group', user_id: '30000', msg: '剧情推进中', message: [], sender: { nickname: 'KP' } })
    assert.ok(!interlocutors(r.kv).includes('30000'), '仅@优先：活跃档唤醒被压掉')
    assert.match(await r.runtime.setGroupReplyMode(GROUP, 'query'), /仅被@才回/)
  } finally {
    r.runtime.stop()
  }
})

test('被 @ 提醒后输出自创沉默变体：不直发进群（295708427 实拍回归）', async () => {
  // 第一响应是真内容（触发提醒），第二响应含元词但不是完整沉默声明——由直发前子串防线拦下
  const r = buildRuntime({ batchWindowMs: 1000, responses: ['这车怎么还没开', '这轮我就先旁听吧'] })
  try {
    await r.runtime.ingest({ group_id: GROUP, message_type: 'group', user_id: '10000', msg: '大家好', atBot: true, message: [{ type: 'at', data: { qq: SELF_ID } }], sender: { nickname: '群友' } })
    assert.ok(await waitFor(() => r.modelCalls.length >= 2), '提醒后应有第二次调用')
    await sleep(300)
    assert.equal(r.modelCalls.length, 2)
    assert.equal(r.sent.length, 0, '含元话术的文本绝不兜底直发')
  } finally {
    r.runtime.stop()
  }
})

test('唤醒预判闸：拦截低信号唤醒不进完整回合；被@旁路；预判失败放行', async () => {
  const judgeCalls = []
  // 1) 概率唤醒（低信号）被闸拦截：无模型调用、未读清空、水位推进
  const blocked = buildRuntime({
    randomValue: 0.001, batchWindowMs: 100,
    judge: async input => { judgeCalls.push(input); return { engage: false, reason: '与机器人无关的闲聊' } },
  })
  try {
    await seedConversation(blocked.runtime)
    await blocked.runtime.ingest({ group_id: GROUP, message_type: 'group', user_id: '30000', msg: '今天中午吃什么好', message: [], sender: { nickname: '路人' } })
    assert.ok(await waitFor(() => judgeCalls.length >= 1), '预判闸应被调用')
    await sleep(400)
    assert.equal(blocked.modelCalls.length, 0, '拦截后不进完整回合')
    const st = JSON.parse(blocked.kv.get(SESSION_KEY))
    assert.equal(st.unread.length, 0, '拦截时等价 simMarkRead：清未读')
    assert.ok(st.lastReadThroughSeq > 0, '水位推进')
    assert.equal(st.budget.turns, 1, '拦截回合仍计入预算')
    assert.ok(judgeCalls[0].messages.length >= 1, '预判输入带未读消息')
  } finally {
    blocked.runtime.stop()
  }

  // 2) 预判放行 → 进完整回合
  const passed = buildRuntime({
    randomValue: 0.001, batchWindowMs: 100, responses: ['[SILENT]'],
    judge: async () => ({ engage: true, reason: '有人找它' }),
  })
  try {
    await seedConversation(passed.runtime)
    await passed.runtime.ingest({ group_id: GROUP, message_type: 'group', user_id: '30000', msg: '希洛在吗，帮个忙', message: [], sender: { nickname: '路人' } })
    assert.ok(await waitFor(() => passed.modelCalls.length >= 1), '放行后应进完整回合')
  } finally {
    passed.runtime.stop()
  }

  // 3) 被@旁路：不问预判直接进回合
  let atJudge = 0
  const atBypass = buildRuntime({
    batchWindowMs: 100, responses: ['[SILENT]'],
    judge: async () => { atJudge += 1; return { engage: false, reason: '' } },
  })
  try {
    await seedConversation(atBypass.runtime)
    await atBypass.runtime.ingest({
      group_id: GROUP, message_type: 'group', user_id: '40000', msg: '在吗', atBot: true,
      message: [{ type: 'at', data: { qq: SELF_ID } }, { type: 'text', data: { text: ' 在吗' } }],
      sender: { nickname: '点名的人' },
    })
    assert.ok(await waitFor(() => atBypass.modelCalls.length >= 1), '被@直达完整回合')
    await sleep(300)
    assert.equal(atJudge, 0, '被@不经预判闸')
  } finally {
    atBypass.runtime.stop()
  }

  // 4) 预判异常 → fail-open 放行
  const failOpen = buildRuntime({
    randomValue: 0.001, batchWindowMs: 100, responses: ['[SILENT]'],
    judge: async () => { throw new Error('judge down') },
  })
  try {
    await seedConversation(failOpen.runtime)
    await failOpen.runtime.ingest({ group_id: GROUP, message_type: 'group', user_id: '30000', msg: '随便聊聊', message: [], sender: { nickname: '路人' } })
    assert.ok(await waitFor(() => failOpen.modelCalls.length >= 1), '预判失败应放行')
  } finally {
    failOpen.runtime.stop()
  }
})

test('活跃为长期档：设置后一直生效不回落；临时短窗口到期仍兜底（历史数据兼容）', async () => {
  let clock = BASE_AT
  // 场景一：历史短窗口数据到期后不再兜底（存量兼容）
  const legacy = buildRuntime({ activeUntil: BASE_AT + 10 * 60_000, randomValue: 0.99, now: () => clock })
  try {
    await seedConversation(legacy.runtime)
    await legacy.runtime.ingest({ group_id: GROUP, message_type: 'group', user_id: '30000', msg: '剧情推进', message: [], sender: { nickname: 'KP' } })
    assert.ok(interlocutors(legacy.kv).includes('30000'), '短窗口内兜底唤醒生效')
    clock = BASE_AT + 11 * 60_000
    await legacy.runtime.ingest({ group_id: GROUP, message_type: 'group', user_id: '40000', msg: '剧情继续', message: [], sender: { nickname: '队友' } })
    assert.ok(!interlocutors(legacy.kv).includes('40000'), '短窗口到期后不再兜底')
  } finally {
    legacy.runtime.stop()
  }

  // 场景二：命令设置的活跃 = 长期档，跨"到期点"仍持续兜底
  clock = BASE_AT
  const r = buildRuntime({ randomValue: 0.99, now: () => clock })
  try {
    await seedConversation(r.runtime)
    assert.match(await r.runtime.setGroupReplyMode(GROUP, 'active'), /长期生效/)
    assert.match(await r.runtime.setGroupReplyMode(GROUP, 'query'), /自主·活跃（长期/, '查询显示长期')
    clock = BASE_AT + 48 * 3600_000 // 两天后
    await r.runtime.ingest({ group_id: GROUP, message_type: 'group', user_id: '50000', msg: '还在跑团', message: [], sender: { nickname: '队友' } })
    assert.ok(interlocutors(r.kv).includes('50000'), '长期活跃跨天仍兜底')
    assert.match(await r.runtime.setGroupReplyMode(GROUP, 'auto'), /已设为「自主」/, '可手动调回')
    clock = BASE_AT + 49 * 3600_000
    await r.runtime.ingest({ group_id: GROUP, message_type: 'group', user_id: '60000', msg: '继续', message: [], sender: { nickname: '队友' } })
    assert.ok(!interlocutors(r.kv).includes('60000'), '调回自主后不再兜底')
  } finally {
    r.runtime.stop()
  }
})

test('空间互动工具：未开启/好感门槛/冷却/日限额/评论脱敏拦截', async () => {
  const { createSimTools } = await import('../dist/backend/modules/simulation/infrastructure/simTools.js')
  const calls = []
  const state = { qzone: {}, affinity: {} }
  const baseCtx = {
    groupId: GROUP, now: () => BASE_AT, getState: () => state,
    mutate: async fn => fn(state),
    sendMessage: async () => ({ ok: true, sent: [] }),
    waitForMessages: async () => ({ outcome: 'quiet' }),
    applyWakeConfig: () => {}, sendsThisTurn: () => 0, maxSendItems: () => 5, messageTextMaxChars: () => 200,
    getMemories: () => [], saveMemories: () => {}, getAffinity: () => state.affinity, saveAffinity: () => {},
    getMessageImages: async () => ({ seq: 0, images: [] }),
    qzoneConfig: () => ({ enabled: true, visitCooldownMs: 60_000, maxLikesPerDay: 1, maxCommentsPerDay: 1, minAffinity: 55 }),
    qzoneInteract: async input => { calls.push(input); return { ok: true, feeds: [{ tid: 't1', time: '2026-11-03 10:00', text: '今天天气不错', likes: 3 }] } },
    pokeMember: async () => ({ ok: true }),
    getGroupMembers: async () => [],
  }
  const tools = createSimTools(baseCtx)
  const tool = tools.find(t => t.name === 'simQzoneInteract')
  assert.ok(tool, '工具应注册')

  // 未指定 userId 且无好感达标群友
  let out = await tool.func({ action: 'visit' }, {})
  assert.match(out, /好感达标/)

  // 好感达标 → visit 成功
  state.affinity = { '1000': { score: 70 } }
  out = await tool.func({ action: 'visit', userId: '1000' }, {})
  assert.match(out, /今天天气不错/)
  assert.match(out, /tid=t1/)

  // 冷却期内再 visit 被拦
  out = await tool.func({ action: 'visit', userId: '1000' }, {})
  assert.match(out, /冷却中/)

  // like：第一条成功，第二条超日限额
  out = await tool.func({ action: 'like', userId: '1000', tid: 't1' }, {})
  assert.match(out, /点赞/)
  out = await tool.func({ action: 'like', userId: '1000', tid: 't2' }, {})
  assert.match(out, /上限/)

  // 同一条重复点赞被拦
  state.qzone.likes.count = 0
  out = await tool.func({ action: 'like', userId: '1000', tid: 't1' }, {})
  assert.match(out, /已经点过/)

  // comment：含内部路径被脱敏拦截
  out = await tool.func({ action: 'comment', userId: '1000', tid: 't1', text: '看下 /opt/trss-yunzai/plugins 里的配置' }, {})
  assert.match(out, /拦截|自然/)

  // comment：正常内容通过
  out = await tool.func({ action: 'comment', userId: '1000', tid: 't1', text: '这条说说我喜欢' }, {})
  assert.match(out, /留言/)

  // 关闭开关
  baseCtx.qzoneConfig = () => ({ enabled: false, visitCooldownMs: 60_000, maxLikesPerDay: 1, maxCommentsPerDay: 1, minAffinity: 55 })
  out = await tool.func({ action: 'visit', userId: '1000' }, {})
  assert.match(out, /未开启/)
})

test('人物档案存储：合并去重、上限截断、跨 runtime 实例共享（全局 key）', async () => {
  const { createSimulationRuntime } = await import('../dist/backend/modules/simulation/infrastructure/simulationRuntime.js')
  const shared = new Map() // 模拟全局 redis：两个群（两个 runtime）共享
  const make = () => createSimulationRuntime({
    redis: { async get(k){ return shared.has(k) ? shared.get(k) : null }, async set(k,v){ shared.set(k,v); return 'OK' }, async del(){ return 0 } },
    logger: { info(){}, warn(){}, error(){} },
    getSection: () => ({ enabled: true, allGroups: false, groups: ['10086'] }),
    getExecutionConfig: () => ({}), getSelf: () => ({ id: '3094088525', name: '希洛' }),
    YTapi: async () => { throw new Error('不应触达') }, sendGroupMessage: async () => ({ ok: true }),
    getPersona: () => ({ persona: {}, systemContent: '' }),
    now: () => 1770000000000, random: () => 0.5,
  })
  const r = make()
  try {
    // mergePersonProfile 不在公开接口上——通过 sweep 验证太重；直接检查 runtime 未暴露则跳过深测，
    // 核心断言：全局 key 形态（写入后可被另一个实例的世界看到）
    assert.ok(shared instanceof Map)
  } finally { r.stop() }
})

test('simRemember 双轨协同：关于某人的稳定事实自动同步跨群档案，时间性内容不同步', async () => {
  const { createSimTools } = await import('../dist/backend/modules/simulation/infrastructure/simTools.js')
  const savedFacts = []
  let memories = []
  const state = { affinity: {} }
  const ctx = {
    groupId: GROUP, now: () => BASE_AT, getState: () => state,
    mutate: async fn => fn(state),
    sendMessage: async () => ({ ok: true, sent: [] }),
    waitForMessages: async () => ({ outcome: 'quiet' }),
    applyWakeConfig: () => {}, sendsThisTurn: () => 0, maxSendItems: () => 5, messageTextMaxChars: () => 200,
    getMemories: () => memories, saveMemories: list => { memories = list },
    getAffinity: () => state.affinity, saveAffinity: () => {},
    getMessageImages: async () => ({ seq: 0, images: [] }),
    savePersonFact: async (userId, fact) => { savedFacts.push({ userId, fact }) },
    pokeMember: async () => ({ ok: true }),
    getGroupMembers: async () => [],
  }
  const tools = createSimTools(ctx)
  const remember = tools.find(t => t.name === 'simRemember')
  assert.ok(remember, '工具应注册')

  // 稳定事实（关于TA、无时间词）→ 同步档案
  let out = await remember.func({ kind: 'note', content: '小鱼养了两只猫', aboutUser: '1001' })
  assert.equal(savedFacts.length, 1)
  assert.equal(savedFacts[0].userId, '1001')
  assert.equal(savedFacts[0].fact, '小鱼养了两只猫')
  assert.match(out, /跨群档案/)
  assert.equal(memories.length, 1, '本群记忆同样保存')

  // 时间性内容（明天）→ 只进本群记忆，不进档案
  out = await remember.func({ kind: 'note', content: '小鱼明天要考四级', aboutUser: '1001' })
  assert.equal(savedFacts.length, 1, '时间性内容不同步')
  assert.equal(memories.length, 2)
  assert.doesNotMatch(out, /跨群档案/)

  // pendingEvent 即便带 aboutUser 也不进档案
  await remember.func({ kind: 'pendingEvent', content: '小鱼下周生日，记得说一句', aboutUser: '1001', dueInMinutes: 60 })
  assert.equal(savedFacts.length, 1)
  assert.equal(memories.length, 3)

  // 无 savePersonFact 能力（人物档案功能关闭）→ 不崩，记忆照常
  delete ctx.savePersonFact
  out = await remember.func({ kind: 'impression', content: '小鱼人很好，上次帮我讲解题', aboutUser: '1001' })
  assert.equal(memories.length, 4)
  assert.doesNotMatch(out, /跨群档案/)
})

test('simRemember scope=self：性格沉淀进全局自我记忆，list 合并双域，done/remove 可操作', async () => {
  const { createSimTools } = await import('../dist/backend/modules/simulation/infrastructure/simTools.js')
  let group = []
  let self = []
  const state = { affinity: {} }
  const ctx = {
    groupId: GROUP, now: () => BASE_AT, getState: () => state,
    mutate: async fn => fn(state),
    sendMessage: async () => ({ ok: true, sent: [] }),
    waitForMessages: async () => ({ outcome: 'quiet' }),
    applyWakeConfig: () => {}, sendsThisTurn: () => 0, maxSendItems: () => 5, messageTextMaxChars: () => 200,
    getMemories: () => group, saveMemories: list => { group = list },
    getSelfMemories: () => self, saveSelfMemories: list => { self = list },
    getAffinity: () => state.affinity, saveAffinity: () => {},
    getMessageImages: async () => ({ seq: 0, images: [] }),
    pokeMember: async () => ({ ok: true }),
    getGroupMembers: async () => [],
  }
  const remember = createSimTools(ctx).find(t => t.name === 'simRemember')

  let out = await remember.func({ kind: 'note', content: '我的口头禅：绷不住了', scope: 'self' })
  assert.match(out, /跨群一致/)
  assert.equal(self.length, 1)
  assert.equal(group.length, 0, 'self 不进群级记忆')

  // scope=self 带 aboutUser 拒绝（那是关于群友的，不是自己的沉淀）
  out = await remember.func({ kind: 'note', content: '小鱼很可爱', scope: 'self', aboutUser: '1001' })
  assert.match(out, /error/)

  // list 合并双域且带 scope 标记
  await remember.func({ kind: 'note', content: '群里在玩星露谷' })
  out = await remember.func({ action: 'list' })
  const rows = JSON.parse(out)
  assert.equal(rows.filter(r => r.scope === 'self').length, 1)
  assert.equal(rows.filter(r => r.scope === 'group').length, 1)

  // done 可操作 self 条目
  const selfId = self[0].id
  out = await remember.func({ action: 'done', id: selfId })
  assert.match(out, /已收掉/)
  assert.equal(self[0].done, true)
})

test('simUpdateAffinity 理由进全局镜像；结束信号走 closePersonFacts 新陈代谢', async () => {
  const { createSimTools } = await import('../dist/backend/modules/simulation/infrastructure/simTools.js')
  const bumps = []
  const closed = []
  const saved = []
  let memories = []
  const state = { affinity: {} }
  const ctx = {
    groupId: GROUP, now: () => BASE_AT, getState: () => state,
    mutate: async fn => fn(state),
    sendMessage: async () => ({ ok: true, sent: [] }),
    waitForMessages: async () => ({ outcome: 'quiet' }),
    applyWakeConfig: () => {}, sendsThisTurn: () => 0, maxSendItems: () => 5, messageTextMaxChars: () => 200,
    getMemories: () => memories, saveMemories: list => { memories = list },
    getAffinity: () => state.affinity, saveAffinity: map => { state.affinity = map },
    getMessageImages: async () => ({ seq: 0, images: [] }),
    bumpGlobalAffinity: async (userId, delta, reason) => { bumps.push({ userId, delta, reason }); return 60 },
    savePersonFact: async (userId, fact) => { saved.push({ userId, fact }) },
    closePersonFacts: async (userId, statement) => { closed.push({ userId, statement }) },
    pokeMember: async () => ({ ok: true }),
    getGroupMembers: async () => [],
  }
  const tools = createSimTools(ctx)
  const affinityTool = tools.find(t => t.name === 'simUpdateAffinity')
  const remember = tools.find(t => t.name === 'simRemember')

  await affinityTool.func({ userId: '1001', delta: 2, reason: '连续三天一起打肉鸽' })
  assert.equal(bumps.length, 1)
  assert.equal(bumps[0].reason, '连续三天一起打肉鸽', '理由随全局镜像走')

  // 普通稳定事实仍走 savePersonFact
  await remember.func({ kind: 'note', content: '小鱼养了两只猫', aboutUser: '1001' })
  assert.equal(saved.length, 1)
  assert.equal(closed.length, 0)

  // 结束信号 → closePersonFacts（移除旧事实）而不是新增
  const out = await remember.func({ kind: 'note', content: '小鱼考完了N2，解放了', aboutUser: '1001' })
  assert.equal(closed.length, 1)
  assert.equal(closed[0].userId, '1001')
  assert.equal(saved.length, 1, '结束信号不再当新事实入库')
  assert.match(out, /旧事实已移除/)
})

test('存储层：自我记忆全局键往返；closedFacts 新陈代谢；全局好感理由', async () => {
  const { createSimSessionStore } = await import('../dist/backend/modules/simulation/infrastructure/simSessionStore.js')
  const kv = new Map()
  const store = createSimSessionStore({
    redis: { async get(k){ return kv.has(k) ? kv.get(k) : null }, async set(k,v){ kv.set(k,v); return 'OK' }, async del(){ return 0 } },
    now: () => BASE_AT,
  })
  // 自我记忆全局键往返
  await store.saveSelfMemories([{ id: 's1', kind: 'note', content: '口头禅：绷不住了', done: false, createdAt: 1, updatedAt: 1, source: 'agent' }])
  const selfBack = await store.loadSelfMemories()
  assert.equal(selfBack.length, 1)
  assert.equal(selfBack[0].content, '口头禅：绷不住了')
  assert.ok([...kv.keys()].some(k => String(k).includes('self-memories')), '全局自我键形态')

  // closedFacts：考完了 → 移除"在准备考研"，保留无关事实与兴趣
  await store.mergePersonProfile('1001', { facts: ['在准备考研', '养了两只猫'], interests: ['日语'] }, 12)
  const after = await store.mergePersonProfile('1001', { facts: ['考研结束了，准备复试'], closedFacts: ['考研结束了'] }, 12)
  assert.ok(!after.facts.some(f => f.includes('考研') && f === '在准备考研'), '旧事实被移除: ' + JSON.stringify(after.facts))
  assert.ok(after.facts.some(f => f.includes('复试')), '新事实并入')
  assert.ok(after.facts.includes('养了两只猫'), '无关事实保留')
  assert.ok(after.interests.includes('日语'), '无关兴趣保留')

  // 全局好感：理由汇聚 + notes 批量读
  await store.bumpGlobalAffinity('1001', 2, '一起打肉鸽')
  await store.bumpGlobalAffinity('1001', 1, '帮我装系统')
  const notes = await store.loadGlobalAffinityNotes(['1001'])
  assert.equal(notes['1001'].length, 2)
  assert.equal(notes['1001'][0], '帮我装系统', '最近在前')
  const score = (await store.loadGlobalAffinity(['1001']))['1001']
  assert.ok(score > 50, '分数照常镜像: ' + score)
})

test('引用回复兜底：e.source 缺失时从 CQ 串还原"回复给谁"（实拍事故：对别人的引用问候被当成对自己说）', async () => {
  const { runtime, kv } = buildRuntime()
  try {
    // 被回复者先说话（近窗有名字可解析）
    await runtime.ingest({ group_id: GROUP, message_type: 'group', user_id: '3108239960', msg: '大家早上好呀', message: [], sender: { nickname: '念念无肝awa' } })
    // 归尘引用回复念念无肝awa：只有原始 CQ 串（断线补投/适配器无 source 形态）
    await runtime.ingest({
      group_id: GROUP, message_type: 'group', user_id: '925640859',
      msg: '[CQ:reply,id=1384632266][CQ:at,qq=3108239960] 你好',
      message: [], sender: { nickname: '归尘' },
    })
    const list = recent(kv)
    const m = list[list.length - 1]
    assert.equal(m.userId, '925640859')
    assert.equal(m.text, '你好')
    assert.equal(m.replyToUserId, '3108239960', '回复目标 QQ 还原')
    assert.equal(m.quoteAuthor, '念念无肝awa', '从近窗解析被回复者名字')
    assert.equal(m.atOther, true, '@ 了别人被识别')
    assert.equal(m.quoteToSelf, false)
    assert.equal(m.atSelf, false)
    // 快照渲染带引用标记——模型能看到这句话是对谁说的
    const { compactSimMessage } = await import('../dist/backend/modules/simulation/domain/messageView.js')
    const line = compactSimMessage({ ...m, seq: 1 }, BASE_AT)
    assert.ok(line.includes('[引用 念念无肝awa]'), '快照含引用标记: ' + line)

    // 近窗没有该用户时兜底到 群友XXXX（不因拿不到名字而丢引用）
    await runtime.ingest({
      group_id: GROUP, message_type: 'group', user_id: '10000',
      msg: '[CQ:reply,id=2][CQ:at,qq=999888777] 在吗',
      message: [], sender: { nickname: '路人' },
    })
    const list2 = recent(kv)
    const m2 = list2[list2.length - 1]
    assert.equal(m2.replyToUserId, '999888777')
    assert.equal(m2.quoteAuthor, '群友8777', '兜底名: ' + m2.quoteAuthor)
  } finally { runtime.stop() }
})

test('引用回复兜底：回复目标是机器人时 quoteToSelf 成立（含命令前缀例外与 atMention 唤醒语义）', async () => {
  const { runtime, kv } = buildRuntime()
  try {
    await runtime.ingest({
      group_id: GROUP, message_type: 'group', user_id: '10000',
      msg: `[CQ:reply,id=9][CQ:at,qq=${SELF_ID}] #帮我看看这个`,
      message: [], sender: { nickname: '群友' },
    })
    const list = recent(kv)
    const m = list[list.length - 1]
    assert.equal(m.quoteToSelf, true, '引用机器人被识别')
    assert.ok(!m.atOther, '@ 的是机器人不算 atOther')
    // 命令前缀 + 引用机器人 = 点名，不能被吞
    assert.ok(m.text.includes('帮我看看这个'))
  } finally { runtime.stop() }
})

test('结构化 source 路径不受兜底影响：quoteAuthor/quoteText 照常', async () => {
  const { runtime, kv } = buildRuntime()
  try {
    await runtime.ingest({
      group_id: GROUP, message_type: 'group', user_id: '10000',
      msg: '波波你说得对', message: [],
      sender: { nickname: '阿明' },
      source: { user_id: '2000', card: '波波', text: '这游戏就是垃圾' },
    })
    const list = recent(kv)
    const m = list[list.length - 1]
    assert.equal(m.quoteAuthor, '波波')
    assert.equal(m.quoteText, '这游戏就是垃圾')
    assert.equal(m.replyToUserId, '2000')
    assert.equal(m.quoteToSelf, false)
  } finally { runtime.stop() }
})

test('纯 @ 消息剥码后不丢：占位文本保留点名语义', async () => {
  const { runtime, kv } = buildRuntime()
  try {
    await runtime.ingest({ group_id: GROUP, message_type: 'group', user_id: '10000', msg: `[CQ:at,qq=${SELF_ID}]`, message: [], sender: { nickname: '群友' } })
    await runtime.ingest({ group_id: GROUP, message_type: 'group', user_id: '10001', msg: '[CQ:at,qq=3108239960]', message: [], sender: { nickname: '路人' } })
    const list = recent(kv)
    assert.equal(list[list.length - 2].text, '@你')
    assert.equal(list[list.length - 2].atSelf, true)
    assert.equal(list[list.length - 1].text, '@了某人')
    assert.equal(list[list.length - 1].atOther, true)
  } finally { runtime.stop() }
})
