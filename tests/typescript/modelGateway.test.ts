import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFetchWithTimeout } from '../../src/adapters/modelFetch.js'
import { classifyChatRequestFailure, executeChatRequestWithRecovery } from '../../src/modules/models/application/chatRequestRecovery.js'

const waitingFetch: typeof fetch = async (_input, options) => new Promise<Response>((_resolve, reject) => {
  options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
})
test('transport timeout converts only its own deadline to friendly error', async () => {
  await assert.rejects(createFetchWithTimeout(waitingFetch)('https://fixture.invalid', {}, 5), /秒没有返回/)
  const original = new Error('socket unavailable')
  await assert.rejects(createFetchWithTimeout(async () => { throw original })('https://fixture.invalid'), error => error === original)
})
test('external cancellation reason and pre-aborted signal survive transport', async () => {
  const controller = new AbortController()
  const reason = new Error('caller cancelled')
  const request = createFetchWithTimeout(waitingFetch)('https://fixture.invalid', { signal: controller.signal }, 1000)
  controller.abort(reason)
  await assert.rejects(request, error => error === reason)
  let called = false
  await assert.rejects(createFetchWithTimeout(async () => { called = true; return new Response() })('https://fixture.invalid', { signal: controller.signal }), error => error === reason)
  assert.equal(called, false)
})
test('successful transport preserves response and removes external abort listener', async () => {
  const response = new Response('ok')
  const controller = new AbortController()
  let received: AbortSignal | null | undefined
  const fetcher: typeof fetch = async (_input, init) => { received = init?.signal; return response }
  const result = await createFetchWithTimeout(fetcher)('https://fixture.invalid', { signal: controller.signal })
  assert.equal(result.status, response.status)
  assert.equal(await result.text(), 'ok')
  controller.abort()
  assert.equal(received?.aborted, false)
})
test('balance exhaustion and thrown authentication failures do not retry', async () => {
  assert.equal(classifyChatRequestFailure({ error: '429 Too Many Requests 余额不足或无可用资源包,请充值。' })?.kind, 'balance')
  assert.equal(classifyChatRequestFailure({ error: '429 rate limit' })?.retryable, true)
  for (const message of ['429 insufficient_quota', '401 unauthorized', '400 invalid request']) {
    let calls = 0
    await executeChatRequestWithRecovery(async () => { calls++; throw new Error(message) }, {}, { retries: 3 })
    assert.equal(calls, 1)
  }
})
test('cancelled retry operation preserves cancellation and stops retries', async () => {
  const controller = new AbortController()
  const reason = new Error('stop')
  let calls = 0
  await assert.rejects(executeChatRequestWithRecovery(async () => {
    calls++; controller.abort(reason); throw reason
  }, {}, { retries: 3, signal: controller.signal }), error => error === reason)
  assert.equal(calls, 1)
})
