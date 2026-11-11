import assert from 'node:assert/strict'
import test from 'node:test'
import { planMessageDelivery } from '../dist/backend/modules/simulation/domain/messageDelivery.js'
import { createDefaultSimSession, defaultSimRuntimeConfig } from '../dist/backend/modules/simulation/domain/simConfig.js'

const AT = 1_790_000_000_000
function input(overrides = {}) {
  return { messages: ['第一条', '第二条'], deliveredTexts: [], state: createDefaultSimSession(AT), config: defaultSimRuntimeConfig(), at: AT, sendsThisTurn: 0, ...overrides }
}

test('批内与本回合已确认正文精确去重，保留首次出现的顺序', () => {
  const deliveredTexts = new Set(['已经说过的话'])
  const messages = ['新话一', '已经说过的话', '新话一', '新话二', '新话二']
  const result = planMessageDelivery(input({ messages, deliveredTexts }))
  assert.deepEqual(result, { ok: true, messages: ['新话一', '新话二'], duplicatesSkipped: 3 })
  assert.deepEqual([...deliveredTexts], ['已经说过的话'])
  assert.deepEqual(messages, ['新话一', '已经说过的话', '新话一', '新话二', '新话二'])
})

test('去重使用完整正文，百字以后不同的消息及相近语义都不合并', () => {
  const prefix = '相同的长上下文'.repeat(20)
  const messages = [`${prefix}甲`, `${prefix}乙`, '我喜欢这款游戏', '这款游戏我喜欢']
  assert.deepEqual(planMessageDelivery(input({ messages })), { ok: true, messages, duplicatesSkipped: 0 })
})

test('一整批都是已确认消息时即使各额度耗尽也可零发送确认', () => {
  const state = createDefaultSimSession(AT)
  state.sendTimes = Array(10).fill(AT)
  assert.deepEqual(planMessageDelivery(input({ messages: ['已发', '已发'], deliveredTexts: ['已发'], state, sendsThisTurn: 5 })), {
    ok: true, messages: [], duplicatesSkipped: 2,
  })
})

test('整批投影覆盖回合、分钟及小时额度，失败不修改真实状态', () => {
  for (const dimension of ['turn', 'minute', 'hour']) {
    const state = createDefaultSimSession(AT)
    if (dimension === 'minute') state.sendTimes = Array(7).fill(AT)
    if (dimension === 'hour') state.sendTimes = Array(9).fill(AT - 61_000)
    const before = structuredClone(state)
    const result = planMessageDelivery(input({ state, sendsThisTurn: dimension === 'turn' ? 4 : 0 }))
    assert.equal(result.ok, false, dimension)
    assert.match(result.error, /整批未发送/)
    assert.equal(result.duplicatesSkipped, 0)
    assert.deepEqual(state, before, dimension)
  }
})

test('按去重后的数量计算批次额度，成功规划也不消费预算', () => {
  const state = createDefaultSimSession(AT)
  const before = structuredClone(state)
  assert.deepEqual(planMessageDelivery(input({ messages: ['已发', '最后一条', '最后一条'], deliveredTexts: ['已发'], state, sendsThisTurn: 4 })), {
    ok: true, messages: ['最后一条'], duplicatesSkipped: 2,
  })
  assert.deepEqual(state, before)
})

test('批次不足仍返回已去重数量，重新规划不把未发送正文当成功', () => {
  const request = input({ messages: ['重复', '新话一', '新话二'], deliveredTexts: ['重复'], sendsThisTurn: 4 })
  const failed = planMessageDelivery(request)
  assert.equal(failed.ok, false)
  assert.equal(failed.duplicatesSkipped, 1)
  const later = planMessageDelivery({ ...request, sendsThisTurn: 0 })
  assert.deepEqual(later, { ok: true, messages: ['新话一', '新话二'], duplicatesSkipped: 1 })
})

test('频率窗口过期后整批可发送，窗口边界沿用原预算规则', () => {
  const state = createDefaultSimSession(AT)
  state.sendTimes = Array(10).fill(AT - 3600_000)
  assert.deepEqual(planMessageDelivery(input({ state })), { ok: true, messages: ['第一条', '第二条'], duplicatesSkipped: 0 })
})

test('被点名回合跳过小时级节流（被点名必须能回），分钟与回合额度仍生效', () => {
  // 小时窗打满：旁听回合整批被拒，点名回合放行
  const hourFull = createDefaultSimSession(AT)
  hourFull.sendTimes = Array(10).fill(AT - 61_000)
  assert.equal(planMessageDelivery(input({ state: hourFull })).ok, false, '非点名回合仍受小时闸')
  assert.equal(planMessageDelivery(input({ state: structuredClone(hourFull), directAddress: true })).ok, true, '点名回合跳过小时闸')
  // 分钟窗打满：点名回合照样被拦（防刷屏）
  const minuteFull = createDefaultSimSession(AT)
  minuteFull.sendTimes = Array(8).fill(AT - 5_000)
  assert.equal(planMessageDelivery(input({ state: minuteFull, directAddress: true })).ok, false, '分钟频控不豁免')
  // 回合上限：点名回合照样被拦
  assert.equal(planMessageDelivery(input({ state: createDefaultSimSession(AT), sendsThisTurn: 5, directAddress: true })).ok, false, '回合上限不豁免')
})
