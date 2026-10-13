import test from 'node:test'
import assert from 'node:assert/strict'
import { modelExecutor } from './helpers/modelExecutor.js'
const config = { providers: 'oneapi', chatAiConfig: { chatApiUrl: 'https://chat.invalid/v1', chatApiModel: 'chat', chatApiKey: 'fixture' }, toolsAiConfig: { toolsAiUrl: 'https://tools.invalid/v1', toolsAiModel: 'tools', toolsAiApikey: 'fixture' } }
const request = { messages: [{ role: 'user', content: 'hello' }] }
const success = () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }))
test('unsupported generation options retry once on same backend, retaining messages/model', async () => {
 const calls = []
 const { YTapi } = modelExecutor(async (url, options) => {
  calls.push({ url, body: JSON.parse(options.body) })
  return calls.length === 1 ? new Response('unsupported reasoning_effort', { status: 400 }) : success()
 })
 const result = await YTapi(request, config, undefined, undefined, { forceChatBackend: true, generation: { reasoningEffort: 'low', maxOutputTokens: 30 } })
 assert.equal(result.choices[0].message.content, 'ok')
 assert.equal(calls.length, 2)
 assert.equal(calls[0].url, calls[1].url)
 assert.equal(calls[0].body.reasoning_effort, 'low')
 assert.equal(calls[1].body.reasoning_effort, undefined)
 assert.deepEqual(calls[0].body.messages, calls[1].body.messages)
})
test('forced tool request cannot fall back to text after provider failure', async () => {
 let calls = 0
 const { YTapi } = modelExecutor(async () => { calls++; return new Response('denied', { status: 401 }) })
 const result = await YTapi({ ...request, tools: [{ type: 'function', function: { name: 'run' } }], tool_choice: 'required' }, { ...config, useTools: true })
 assert.match(result.error, /401/)
 assert.equal(calls, 1)
})
test('array response and malformed JSON have stable result contracts', async () => {
 const array = modelExecutor(async () => new Response(JSON.stringify([{ choices: [{ message: { content: 'array' } }] }])) )
 assert.equal((await array.YTapi(request, config)).choices[0].message.content, 'array')
 const malformed = modelExecutor(async () => new Response('not-json'))
 assert.match((await malformed.YTapi(request, config)).error, /JSON/)
})
test('caller cancellation is forwarded and cannot trigger backend fallback', async () => {
 const controller = new AbortController(), reason = new Error('caller stop')
 let calls = 0
 const { YTapi } = modelExecutor(async (_url, options) => {
  calls++; assert.equal(options.signal, controller.signal); controller.abort(reason); throw reason
 })
 await assert.rejects(YTapi(request, config, undefined, undefined, { signal: controller.signal }), error => error === reason)
 assert.equal(calls, 1)
})

test('forced tools failure identifies actual channel and model without URL credentials', async () => {
 const { YTapi } = modelExecutor(async () => new Response('quota exhausted', { status: 429 }))
 const result = await YTapi({ ...request, tools: [{ type: 'function', function: { name: 'run' } }], tool_choice: 'required' }, { ...config, useTools: true, toolsAiConfig: { ...config.toolsAiConfig, toolsAiUrl: 'https://user:password@tools.invalid/v1?token=secret' } })
 assert.match(result.error, /渠道=tools.invalid；模型=tools/)
 assert.match(result.error, /429/)
 assert.doesNotMatch(result.error, /password|token=secret/)
})
