import test from "node:test"
import assert from "node:assert/strict"

import { modelExecutor } from './helpers/modelExecutor.js'
const { resolveConfiguredTaskBackend } = modelExecutor()

const baseConfig = {
  chatAiConfig: {
    chatApiUrl: "https://chat.example/v1/chat/completions",
    chatApiModel: "grok-4.6",
    chatApiKey: "sk-test",
    chatReasoningEffort: "low"
  },
  taskAiConfig: {}
}

test("task 后端只配思考档时借用 chat 后端并覆盖 effort", () => {
  const casual = resolveConfiguredTaskBackend(
    { ...baseConfig, taskAiConfig: { casual: { apiUrl: "", model: "", apiKey: "", reasoningEffort: "none" } } },
    "casual"
  )
  assert.equal(casual.apiUrl, baseConfig.chatAiConfig.chatApiUrl, "沿用 chat 地址")
  assert.equal(casual.model, "grok-4.6")
  assert.equal(casual.reasoningEffort, "none", "闲聊档 none 覆盖全局 low")
  assert.match(casual.label, /chat-effort/)
})

test("没配 effort 的空 task 后端维持原 chat 回退行为", () => {
  const fallback = resolveConfiguredTaskBackend({ ...baseConfig, taskAiConfig: { casual: { apiUrl: "", reasoningEffort: "" } } }, "casual")
  assert.equal(fallback.reasoningEffort, "low", "继承 chatReasoningEffort")
  assert.match(fallback.label, /chat-fallback/)
})

test("配了完整地址的 task 后端不被 effort-only 逻辑影响", () => {
  const full = resolveConfiguredTaskBackend(
    { ...baseConfig, taskAiConfig: { casual: { apiUrl: "https://t.example/v1", model: "m2", apiKey: "k2", reasoningEffort: "high" } } },
    "casual"
  )
  assert.equal(full.model, "m2")
  assert.equal(full.reasoningEffort, "high")
  assert.equal(full.label, "task:casual")
})

const toolConfig = {
  ...baseConfig, useTools: true,
  toolsAiConfig: { toolsAiUrl: 'https://tools.example/v1', toolsAiModel: 'tools', toolsAiApikey: 'tool-key' },
  taskAiConfig: { casual: { apiUrl: 'https://casual.example/v1', model: 'casual', apiKey: 'casual-key', reasoningEffort: 'none' } }
}
const emojiRequest = { messages: [{ role: 'user', content: '哈哈哈' }], tools: [{ type: 'function', function: { name: 'sendLocalEmojiTool' } }], tool_choice: 'auto' }
const success = () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))

test('optional emoji borrows casual effort while preserving independent tool credentials and capability', async () => {
  const calls = []
  const { YTapi } = modelExecutor(async (url, options) => { calls.push({ url, headers: options.headers, body: JSON.parse(options.body) }); return success() })
  await YTapi(emojiRequest, toolConfig, undefined, undefined, { taskBackend: 'casual' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://tools.example/v1/chat/completions')
  assert.equal(calls[0].headers.Authorization, 'Bearer tool-key')
  assert.equal(calls[0].body.model, 'tools')
  assert.equal(calls[0].body.reasoning_effort, 'none', 'existing none remains an explicit passthrough value')
  assert.equal(calls[0].body.thinking, undefined, 'the gateway does not invent a provider-specific thinking switch')
  assert.deepEqual(calls[0].body.tools, emojiRequest.tools)
  assert.equal(calls[0].body.tool_choice, 'auto')
})

test('explicit generation beats independent tool effort, which beats task and global effort', async () => {
  for (const generation of [undefined, { reasoningEffort: 'low' }]) {
    const calls = []
    const { YTapi } = modelExecutor(async (_url, options) => { calls.push(JSON.parse(options.body)); return success() })
    await YTapi(emojiRequest, { ...toolConfig, toolsAiConfig: { ...toolConfig.toolsAiConfig, toolsReasoningEffort: 'medium' } }, undefined, undefined, { taskBackend: 'casual', ...(generation ? { generation } : {}) })
    assert.equal(calls[0].reasoning_effort, generation?.reasoningEffort || 'medium')
  }
})

test('optional-tool fallback preserves task effort and actually uses the selected fallback credentials', async () => {
  const calls = []
  const { YTapi } = modelExecutor(async (url, options) => {
    calls.push({ url, headers: options.headers, body: JSON.parse(options.body) })
    return calls.length === 1 ? new Response('unavailable', { status: 503 }) : success()
  })
  const result = await YTapi(emojiRequest, toolConfig, undefined, undefined, { taskBackend: 'casual' })
  assert.equal(result.choices[0].message.content, 'ok')
  assert.deepEqual(calls.map(call => call.body.model), ['tools', 'grok-4.6'])
  assert.equal(calls[1].url, baseConfig.chatAiConfig.chatApiUrl)
  assert.equal(calls[1].headers.Authorization, 'Bearer sk-test')
  assert.deepEqual(calls.map(call => call.body.reasoning_effort), ['none', 'none'])
  assert.equal(calls[1].body.tools, undefined)
  assert.equal(calls[1].body.tool_choice, undefined)
})
