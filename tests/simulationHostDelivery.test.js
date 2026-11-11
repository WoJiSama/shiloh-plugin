import assert from 'node:assert/strict'
import test from 'node:test'
import { hostSimulationSender } from './helpers/simulationHostSender.mjs'
import { createSimTools } from '../dist/backend/modules/simulation/infrastructure/simTools.js'
import { createDefaultSimSession } from '../dist/backend/modules/simulation/domain/simConfig.js'

test('真实宿主包装保留 sendMsg 已开始后的未知结果，不能降为确定失败', async () => {
  let attempts = 0
  const sender = hostSimulationSender({ bot: () => ({ pickGroup: () => ({ async sendMsg() { attempts++; throw new Error('gateway accepted but response lost') } }) }) })
  const result = await sender('10086', [{ type: 'text', data: { text: '可能已经送达' } }], '3094088525')
  assert.equal(attempts, 1)
  assert.equal(result.ok, false)
  assert.equal(result.unknown, true)
})

test('宿主调用前关闭或无群对象是明确失败，仍可修正后发送并保留 message_id', async () => {
  let enabled = false, available = false, attempts = 0
  const sender = hostSimulationSender({ settings: () => ({ simulation: { enabled } }), bot: selfId => ({ pickGroup: groupId => available ? { async sendMsg() { attempts++; return { data: { message_id: `${selfId}:${groupId}` } } } } : null }) })
  const closed = await sender('10086', [], '3094088525')
  assert.equal(closed.ok, false); assert.notEqual(closed.unknown, true)
  enabled = true
  const missing = await sender('10086', [], '3094088525')
  assert.equal(missing.ok, false); assert.notEqual(missing.unknown, true)
  assert.equal(attempts, 0)
  available = true
  const sent = await sender('10086', [], '3094088525')
  assert.equal(sent.ok, true); assert.equal(sent.messageId, '3094088525:10086'); assert.equal(attempts, 1)
})

test('消息协议保留合法完整五条，超过五条明确拒绝而非截掉尾条', async () => {
  const batches = []
  const tool = createSimTools({ requireExplicitContinuation: true, maxSendItems: () => 5, getState: () => createDefaultSimSession(1_790_000_000_000),
    sendMessage: async messages => { batches.push(messages); return { ok: true, sent: messages.length } },
  }).find(tool => tool.name === 'simSendMessage')
  const five = Array.from({ length: 5 }, (_, index) => `第${index + 1}条消息`)
  assert.equal(JSON.parse(await tool.execute({ continuation: 'chat', messages: five }, {})).sent, 5)
  assert.deepEqual(batches, [five])
  const tooMany = await tool.execute({ continuation: 'chat', messages: [...five, '第六条消息'] }, {})
  assert.match(tooMany, /^error:/)
  assert.equal(batches.length, 1)
})
