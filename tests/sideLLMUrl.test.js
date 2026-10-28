import test from 'node:test'
import assert from 'node:assert/strict'
import { sideLLMCall } from '../dist/backend/adapters/sideLLM.js'

const okResponse = () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) })

test('sideLLMCall 给渠道基址补全 /chat/completions，完整地址保持不变', async () => {
  const endpoints = []
  const fetchImpl = async url => { endpoints.push(url); return okResponse() }
  await sideLLMCall({ url: 'https://open.bigmodel.cn/api/coding/paas/v4', apikey: 'k', model: 'm', messages: [{ role: 'user', content: 'q' }], fetchImpl })
  await sideLLMCall({ url: 'https://open.bigmodel.cn/api/coding/paas/v4/', apikey: 'k', model: 'm', messages: [{ role: 'user', content: 'q' }], fetchImpl })
  await sideLLMCall({ url: 'https://api.deepseek.com/chat/completions', apikey: 'k', model: 'm', messages: [{ role: 'user', content: 'q' }], fetchImpl })
  await sideLLMCall({ url: 'https://x.test/v1', apikey: 'k', model: 'm', messages: [{ role: 'user', content: 'q' }], fetchImpl })
  assert.equal(endpoints[0], 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions')
  assert.equal(endpoints[1], 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions')
  assert.equal(endpoints[2], 'https://api.deepseek.com/chat/completions')
  assert.equal(endpoints[3], 'https://x.test/v1/chat/completions')
})
