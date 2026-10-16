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

const lowConfig = { ...config, useTools: true, chatAiConfig: { ...config.chatAiConfig, chatReasoningEffort: 'low' }, toolsAiConfig: { ...config.toolsAiConfig, toolsAiApikey: 'fixture-tools-key' } }
const forcedToolRequest = { ...request, tools: [{ type: 'function', function: { name: 'run', parameters: { type: 'object' } } }], tool_choice: { type: 'function', function: { name: 'run' } } }
const complexRequest = { messages: [{ role: 'user', content: '分析刚才转发里几个人的方案，比较一下为什么失败。' }] }

test('tool requests inherit global low effort while retaining their backend, credentials and forced action', async () => {
 const calls = []
 const { YTapi } = modelExecutor(async (url, options) => {
  calls.push({ url, headers: options.headers, body: JSON.parse(options.body) }); return success()
 })
 const result = await YTapi(forcedToolRequest, lowConfig)
 assert.equal(result.choices[0].message.content, 'ok')
 assert.equal(calls.length, 1)
 assert.equal(calls[0].url, 'https://tools.invalid/v1/chat/completions')
 assert.equal(calls[0].headers.Authorization, 'Bearer fixture-tools-key')
 assert.equal(calls[0].body.model, 'tools')
 assert.equal(calls[0].body.reasoning_effort, 'low')
 assert.deepEqual(calls[0].body.tools, forcedToolRequest.tools)
 assert.deepEqual(calls[0].body.tool_choice, forcedToolRequest.tool_choice)
})

test('adaptive complex backend inherits global low and respects its independent effort', async () => {
 for (const toolsReasoningEffort of ['', 'medium']) {
  const calls = []
  const { YTapi } = modelExecutor(async (url, options) => {
   calls.push({ url, body: JSON.parse(options.body) }); return success()
  })
  await YTapi(complexRequest, { ...lowConfig, toolsAiConfig: { ...lowConfig.toolsAiConfig, toolsReasoningEffort } })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://tools.invalid/v1/chat/completions')
  assert.equal(calls[0].body.model, 'tools')
  assert.equal(calls[0].body.reasoning_effort, toolsReasoningEffort || 'low')
  assert.equal(calls[0].body.tools, undefined)
 }
})

test('empty planner response retains resolved effort when continuing on the chat backend', async () => {
 const calls = []
 const { YTapi } = modelExecutor(async (url, options) => {
  calls.push({ url, body: JSON.parse(options.body) })
  return calls.length === 1 ? new Response(JSON.stringify({ choices: [{ message: { content: '' } }] })) : success()
 })
 await YTapi({ ...forcedToolRequest, tool_choice: 'auto' }, { ...lowConfig, toolsAiConfig: { ...lowConfig.toolsAiConfig, toolsReasoningEffort: 'medium' } })
 assert.deepEqual(calls.map(call => call.body.model), ['tools', 'chat'])
 assert.deepEqual(calls.map(call => call.body.reasoning_effort), ['medium', 'medium'])
 assert.equal(calls[1].body.tools, undefined)
 assert.equal(calls[1].body.tool_choice, undefined)
})

test('adaptive text fallback preserves the outgoing effort rather than reverting to the model default', async () => {
 const calls = []
 const { YTapi } = modelExecutor(async (url, options) => {
  calls.push({ url, body: JSON.parse(options.body) })
  return calls.length === 1 ? new Response('unavailable', { status: 503 }) : success()
 })
 await YTapi(complexRequest, { ...lowConfig, toolsAiConfig: { ...lowConfig.toolsAiConfig, toolsReasoningEffort: 'medium' } })
 assert.deepEqual(calls.map(call => call.body.model), ['tools', 'chat'])
 assert.deepEqual(calls.map(call => call.body.reasoning_effort), ['medium', 'medium'])
})

test('unsupported tool generation options retry once on the same backend without weakening a forced action', async () => {
 const calls = []
 const { YTapi } = modelExecutor(async (url, options) => {
  calls.push({ url, headers: options.headers, body: JSON.parse(options.body) })
  return calls.length === 1 ? new Response('unsupported reasoning_effort', { status: 400 }) : success()
 })
 await YTapi(forcedToolRequest, lowConfig, undefined, undefined, { generation: { reasoningEffort: 'low', maxOutputTokens: 50 } })
 assert.equal(calls.length, 2)
 assert.equal(calls[0].url, calls[1].url)
 assert.deepEqual(calls[0].headers, calls[1].headers)
 assert.equal(calls[0].body.reasoning_effort, 'low')
 assert.equal(calls[1].body.reasoning_effort, undefined)
 assert.equal(calls[1].body.max_tokens, undefined)
 for (const field of ['model', 'messages', 'tools', 'tool_choice']) assert.deepEqual(calls[0].body[field], calls[1].body[field])
})

test('provider-specific flat named choice remains intact through generation compatibility recovery', async () => {
 const calls = []
 const { YTapi } = modelExecutor(async (url, options) => {
  calls.push({ url, body: JSON.parse(options.body) })
  return calls.length === 1 ? new Response('unsupported reasoning_effort', { status: 400 }) : success()
 })
 await YTapi(forcedToolRequest, { ...lowConfig, toolsAiConfig: { ...lowConfig.toolsAiConfig, toolsAiUrl: 'https://api.souimagery.fun/v1/chat/completions' } })
 assert.equal(calls.length, 2)
 assert.equal(calls[0].url, calls[1].url)
 assert.equal(calls[0].body.reasoning_effort, 'low')
 assert.equal(calls[1].body.reasoning_effort, undefined)
 for (const call of calls) {
  assert.deepEqual(call.body.tool_choice, { type: 'function', name: 'run' })
  assert.deepEqual(call.body.tools, forcedToolRequest.tools)
 }
})

test('rejected optional parameters cannot cause an unlimited tool retry or forced text fallback', async () => {
 const calls = []
 const { YTapi } = modelExecutor(async (url, options) => {
  calls.push({ url, body: JSON.parse(options.body) })
  return new Response('unsupported reasoning_effort', { status: 400 })
 })
 const result = await YTapi(forcedToolRequest, lowConfig)
 assert.match(result.error, /400/)
 assert.equal(calls.length, 2)
 assert.ok(calls.every(call => call.url === 'https://tools.invalid/v1/chat/completions'))
 assert.ok(calls.every(call => JSON.stringify(call.body.tool_choice) === JSON.stringify(forcedToolRequest.tool_choice)))
})

test('tool-choice compatibility stays with its existing recovery and does not strip effort', async () => {
 const calls = []
 const { YTapi } = modelExecutor(async (_url, options) => {
  calls.push(JSON.parse(options.body)); return new Response('Thinking mode does not support this tool_choice', { status: 400 })
 })
 const result = await YTapi(forcedToolRequest, lowConfig)
 assert.match(result.error, /Thinking mode does not support this tool_choice/)
 assert.equal(calls.length, 1)
 assert.equal(calls[0].reasoning_effort, 'low')
 assert.deepEqual(calls[0].tool_choice, forcedToolRequest.tool_choice)
})

test('tool authentication, rate limit and upstream failures do not retry without generation parameters', async () => {
 for (const status of [401, 429, 503]) {
  let calls = 0
  const { YTapi } = modelExecutor(async () => { calls++; return new Response('unsupported reasoning_effort', { status }) })
  assert.match((await YTapi(forcedToolRequest, lowConfig)).error, new RegExp(String(status)))
  assert.equal(calls, 1)
 }
})

test('cancellation between tool compatibility attempts aborts without another request or fallback', async () => {
 const controller = new AbortController(), reason = new Error('stop tool compatibility')
 let calls = 0
 const { YTapi } = modelExecutor(async (_url, options) => {
  calls++; assert.equal(options.signal, controller.signal)
  controller.abort(reason)
  return new Response('unsupported reasoning_effort', { status: 400 })
 })
 await assert.rejects(YTapi(forcedToolRequest, lowConfig, undefined, undefined, { signal: controller.signal }), error => error === reason)
 assert.equal(calls, 1)
})
