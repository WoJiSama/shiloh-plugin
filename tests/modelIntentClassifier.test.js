import { test } from "node:test"
import assert from "node:assert/strict"

const CONFIG = {
  toolsAiConfig: {
    toolsAiUrl: "http://fake.local/v1",
    toolsAiApikey: "sk-test",
    toolsAiModel: "fake-model"
  }
}

function makeFetch(payload) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) })
    return {
      ok: true,
      json: async () => ({ choices: [{ message: { content: typeof payload === "function" ? payload() : payload } }] })
    }
  }
  fetchImpl.calls = calls
  return fetchImpl
}

test("模型判定：解析 JSON 输出并透传意图", async () => {
  const { classifyIntentWithModel } = await import("../core/intent/modelIntentClassifier.js")
  const fetchImpl = makeFetch('{"intent":"image_generate","confidence":0.93,"reason":"要求画星野"}')
  const result = await classifyIntentWithModel({ text: "希洛画一个星野", config: CONFIG, fetchImpl })
  assert.equal(result.intent, "image_generate")
  assert.equal(result.confidence, 0.93)
  // 请求体形状
  const body = fetchImpl.calls[0].body
  assert.equal(body.model, "fake-model")
  assert.equal(body.response_format.type, "json_object")
  assert.match(body.messages[1].content, /希洛画一个星野/)
})

test("模型判定：未知意图回退 chat；代码块包裹的 JSON 也能解析", async () => {
  const { classifyIntentWithModel } = await import("../core/intent/modelIntentClassifier.js")
  const r1 = await classifyIntentWithModel({ text: "测试", config: CONFIG, fetchImpl: makeFetch('{"intent":"hack_intent","confidence":0.9}') })
  assert.equal(r1.intent, "chat")
  const r2 = await classifyIntentWithModel({ text: "测试", config: CONFIG, fetchImpl: makeFetch('```json\n{"intent":"search","confidence":0.8}\n```') })
  assert.equal(r2.intent, "search")
})

test("模型判定：HTTP 错误/异常/未配置都返回 unavailable（调用方走正则兜底）", async () => {
  const { classifyIntentWithModel } = await import("../core/intent/modelIntentClassifier.js")
  const http500 = async () => ({ ok: false, status: 500, json: async () => ({}) })
  assert.equal((await classifyIntentWithModel({ text: "x", config: CONFIG, fetchImpl: http500 })).intent, "unavailable")
  const throwing = async () => { throw new Error("fetch failed") }
  assert.equal((await classifyIntentWithModel({ text: "x", config: CONFIG, fetchImpl: throwing })).intent, "unavailable")
  assert.equal((await classifyIntentWithModel({ text: "x", config: {}, fetchImpl: makeFetch("{}") })).intent, "unavailable")
  // 空消息直接 noise，不调模型
  const fetchImpl = makeFetch("{}")
  assert.equal((await classifyIntentWithModel({ text: "  ", config: CONFIG, fetchImpl })).intent, "noise")
  assert.equal(fetchImpl.calls.length, 0)
})

test("影子统计：等价类合并、分歧采样、unavailable 单独计数", async () => {
  const { recordShadowComparison, getShadowStats, areIntentsEquivalent } = await import("../core/intent/modelIntentClassifier.js")
  assert.equal(areIntentsEquivalent("image_generate", "image_edit"), true)
  assert.equal(areIntentsEquivalent("chat", "image_generate"), false)
  recordShadowComparison({ text: "a", regexIntent: "image_generate", modelIntent: "image_edit", confidence: 0.9 })
  recordShadowComparison({ text: "b", regexIntent: "chat", modelIntent: "search", confidence: 0.8 })
  recordShadowComparison({ text: "c", regexIntent: "chat", modelIntent: "unavailable", confidence: 0 })
  const stats = getShadowStats()
  assert.equal(stats.total, 3)
  assert.equal(stats.agree, 1)
  assert.equal(stats.unavailable, 1)
  assert.equal(stats.disagreementSamples.length, 1)
  assert.equal(stats.intentCounts.search, 1)
})
