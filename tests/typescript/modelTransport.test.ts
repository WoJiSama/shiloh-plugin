import test from 'node:test'
import assert from 'node:assert/strict'
import { sideLLMCall } from '../../src/adapters/sideLLM.js'
import { ThinkingProcessor } from '../../src/modules/models/domain/thinkingProcessor.js'
import { sanitizeJsonValue, safeTruncateUnicode } from '../../src/modules/models/domain/unicodeText.js'

test('side channel transport preserves request fields and validates empty responses', async () => {
  const fetchImpl: typeof fetch = async (_url, init) => {
    assert.deepEqual(JSON.parse(String(init?.body)), { model: 'fixture', messages: [{ role: 'user', content: 'test' }], temperature: 0.2, max_tokens: 8 })
    return Response.json({ choices: [{ message: { content: ' ok ' } }] })
  }
  const input = { url: 'https://fixture.invalid', apikey: 'fixture', model: 'fixture', messages: [{ role: 'user', content: 'test' }], maxTokens: 8 }
  assert.deepEqual(await sideLLMCall({ ...input, fetchImpl }), { ok: true, content: 'ok' })
  assert.deepEqual(await sideLLMCall({ ...input, fetchImpl: async () => Response.json({ choices: [] }) }), { ok: false, error: '模型返回空', status: 200 })
})
test('pre-cancelled side channel requests never invoke transport', async () => {
  const controller = new AbortController()
  controller.abort()
  const result = await sideLLMCall({ url: 'https://fixture.invalid', apikey: 'fixture', model: 'fixture', messages: [{ role: 'user', content: 'test' }], signal: controller.signal,
    fetchImpl: async () => { assert.fail('cancelled request must not be sent') } })
  assert.deepEqual(result, { ok: false, error: '模型请求已取消' })
})
test('thinking removal and Unicode normalization preserve visible text', () => {
  assert.equal(ThinkingProcessor.removeThinking('<think>hidden</think> visible'), 'visible')
  assert.equal(safeTruncateUnicode('😀a', 1), '😀')
  assert.deepEqual(sanitizeJsonValue({ content: '\ud800' }), { content: '�' })
  const cycle: { self?: unknown } = {}; cycle.self = cycle
  assert.deepEqual(sanitizeJsonValue(cycle), { self: null })
})

test('model deadline covers stalled body after immediate headers and preserves cancellation reason', async () => {
  const { createFetchWithTimeout } = await import('../../src/adapters/modelFetch.js')
  const transport = createFetchWithTimeout(async () => new Response(new ReadableStream({ start() {} })))
  await assert.rejects(transport('https://fixture.invalid', {}, 10), /请求超过/)
  const controller = new AbortController()
  const reason = new Error('user stopped body')
  const pending = transport('https://fixture.invalid', { signal: controller.signal }, 1000)
  setTimeout(() => controller.abort(reason), 10)
  await assert.rejects(pending, error => error === reason)
  const noContent = createFetchWithTimeout(async () => new Response(null, { status: 204 }))
  assert.equal((await noContent('https://fixture.invalid')).status, 204)
})
