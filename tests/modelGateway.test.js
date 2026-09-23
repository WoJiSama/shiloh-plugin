// 模型请求薄网关测试:钉住请求体形状(工具注入开关/toolChoice 语义)、
// 模型名解析的原语义(oneapi 之外返回 undefined)、fetch 超时的错误转换。
import { test } from "node:test"
import assert from "node:assert/strict"
import { buildChatRequestData, resolveChatModel, fetchWithTimeout } from "../utils/modelGateway.js"

const CONFIG = {
  providers: "oneapi",
  chatAiConfig: { chatApiModel: "gpt-test" },
  useTools: true
}

test("resolveChatModel 保持原语义:oneapi 取 chatApiModel,其他 provider 为 undefined", () => {
  assert.equal(resolveChatModel(CONFIG), "gpt-test")
  assert.equal(resolveChatModel({ ...CONFIG, providers: "openai" }), undefined)
  assert.equal(resolveChatModel({}), undefined)
})

test("buildChatRequestData 基础形状:固定采样参数与模型名", () => {
  const data = buildChatRequestData(CONFIG, [{ role: "user", content: "hi" }], [], "auto")
  assert.equal(data.model, "gpt-test")
  assert.equal(data.temperature, 0.7)
  assert.equal(data.top_p, 0.9)
  assert.deepEqual(data.messages, [{ role: "user", content: "hi" }])
  assert.equal(data.tools, undefined, "空工具列表不注入 tools")
})

test("tools 注入语义:useTools 且有工具且 toolChoice 非 none 才注入", () => {
  const tools = [{ type: "function", function: { name: "t" } }]
  assert.deepEqual(buildChatRequestData(CONFIG, [], tools, "auto").tools, tools)
  assert.deepEqual(buildChatRequestData(CONFIG, [], tools, "none").tools, undefined, "toolChoice=none 不注入")
  assert.deepEqual(buildChatRequestData({ ...CONFIG, useTools: false }, [], tools, "auto").tools, undefined, "useTools 关闭不注入")
  const forced = buildChatRequestData(CONFIG, [], tools, { type: "function", function: { name: "t" } })
  assert.equal(forced.tool_choice.function.name, "t", "强制工具调用对象原样透传")
})

test("fetchWithTimeout:超时转换为可读错误,正常请求透传响应", async () => {
  await assert.rejects(
    () => fetchWithTimeout("https://10.255.255.1/no-route", { method: "GET" }, 50),
    /秒没有返回/,
    "超时应转换为可读错误而非裸 AbortError"
  )
  const response = await fetchWithTimeout("data:text/plain,ok", { method: "GET" }, 5000)
  assert.equal(response.status, 200)
})
