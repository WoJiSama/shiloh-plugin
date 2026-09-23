import test from "node:test"
import assert from "node:assert/strict"

let resolveConfiguredTaskBackend = null
try {
  ;({ resolveConfiguredTaskBackend } = await import("../utils/apiClient.js"))
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error
}

const baseConfig = {
  chatAiConfig: {
    chatApiUrl: "https://chat.example/v1/chat/completions",
    chatApiModel: "grok-4.6",
    chatApiKey: "sk-test",
    chatReasoningEffort: "low"
  },
  taskAiConfig: {}
}

test("task 后端只配思考档时借用 chat 后端并覆盖 effort", { skip: !resolveConfiguredTaskBackend }, () => {
  const casual = resolveConfiguredTaskBackend(
    { ...baseConfig, taskAiConfig: { casual: { apiUrl: "", model: "", apiKey: "", reasoningEffort: "none" } } },
    "casual"
  )
  assert.equal(casual.apiUrl, baseConfig.chatAiConfig.chatApiUrl, "沿用 chat 地址")
  assert.equal(casual.model, "grok-4.6")
  assert.equal(casual.reasoningEffort, "none", "闲聊档 none 覆盖全局 low")
  assert.match(casual.label, /chat-effort/)
})

test("没配 effort 的空 task 后端维持原 chat 回退行为", { skip: !resolveConfiguredTaskBackend }, () => {
  const fallback = resolveConfiguredTaskBackend({ ...baseConfig, taskAiConfig: { casual: { apiUrl: "", reasoningEffort: "" } } }, "casual")
  assert.equal(fallback.reasoningEffort, "low", "继承 chatReasoningEffort")
  assert.match(fallback.label, /chat-fallback/)
})

test("配了完整地址的 task 后端不被 effort-only 逻辑影响", { skip: !resolveConfiguredTaskBackend }, () => {
  const full = resolveConfiguredTaskBackend(
    { ...baseConfig, taskAiConfig: { casual: { apiUrl: "https://t.example/v1", model: "m2", apiKey: "k2", reasoningEffort: "high" } } },
    "casual"
  )
  assert.equal(full.model, "m2")
  assert.equal(full.reasoningEffort, "high")
  assert.equal(full.label, "task:casual")
})
