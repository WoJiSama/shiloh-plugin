import test from 'node:test'
import assert from 'node:assert/strict'
import { createSimulationRuntime } from '../dist/backend/modules/simulation/infrastructure/simulationRuntime.js'

const SELF_ID = '3094088525'
const GROUP = '10086'
const SESSION_KEY = `shiloh:sim:g:${GROUP}`

function buildRuntime() {
  const kv = new Map()
  const runtime = createSimulationRuntime({
    redis: {
      async get(key) { return kv.has(key) ? kv.get(key) : null },
      async set(key, value) { kv.set(key, value); return 'OK' },
      async del(...keys) { let n = 0; for (const key of keys) if (kv.delete(key)) n += 1; return n },
    },
    logger: { info() {}, warn() {}, error() {} },
    getSection: () => ({ enabled: true, allGroups: false, groups: [GROUP] }),
    getExecutionConfig: () => ({}),
    getSelf: () => ({ id: SELF_ID, name: '希洛' }),
    YTapi: async () => { throw new Error('ingest 路径不应触达模型') },
    sendGroupMessage: async () => ({ ok: true }),
    getPersona: () => ({ persona: {}, systemContent: '' }),
    now: () => 1770000000000,
    random: () => 0.99,
  })
  return { runtime, kv }
}

function recent(kv) {
  return JSON.parse(kv.get(SESSION_KEY) || '{"recent":[]}').recent
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
