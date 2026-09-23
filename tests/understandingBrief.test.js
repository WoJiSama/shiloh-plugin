// 理解简报测试:输入构造、成功判读、四类失败回退(超时/接口缺失/HTTP 错误/输出不合法)、
// 最终卡片组装(简报在前材料在后、长度受控)、主链路接线。
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  buildBriefMessages,
  requestUnderstandingBrief,
  composeModelBriefCard
} from "../utils/understandingBrief.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const MATERIALS = {
  intentText: "这个是怎么回事",
  signals: ["当前消息引用了其他消息", "用户用了指代词，需要结合引用、转发和近期对话消解"],
  quotedContext: "[回复 星野的消息: \"服务刚才报错了\"]",
  forwardContext: "",
  recentContext: "星野: 部署一直失败\n沃基: 昨天还好好的"
}

const VALID_BRIEF = "【用户意图】用户想知道引用里提到的服务报错原因\n【指代消解】“这个”指星野引用消息里报错的服务部署\n【需要上下文】昨天的部署是否正常;报错的具体信息\n【语气关系】着急排查,熟人语气"

function fakeFetch(content = VALID_BRIEF, { status = 200, delayMs = 0 } = {}) {
  return async () => {
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs))
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ choices: [{ message: { content } }] })
    }
  }
}

test("简报输入:材料按节拼装,系统提示词钉住四节结构", () => {
  const messages = buildBriefMessages(MATERIALS)
  assert.equal(messages.length, 2)
  assert.equal(messages[0].role, "system")
  for (const section of ["【用户意图】", "【指代消解】", "【需要上下文】", "【语气关系】"]) {
    assert.ok(messages[0].content.includes(section))
  }
  const user = messages[1].content
  assert.ok(user.includes("【用户当前原话/意图】"))
  assert.ok(user.includes("【引用内容摘录】"))
  assert.ok(user.includes("【近期可参考上下文】"))
  assert.ok(!user.includes("【合并转发/嵌套转发摘录】"), "空材料节不输出")
})

test("成功判读:返回 ok 与简报原文", async () => {
  const result = await requestUnderstandingBrief({
    apiUrl: "https://api.example/v1/chat/completions",
    apiKey: "sk-real",
    model: "cheap-model",
    materials: MATERIALS,
    fetchImpl: fakeFetch(),
    timeoutMs: 2000
  })
  assert.equal(result.ok, true)
  assert.ok(result.brief.includes("【用户意图】"))
})

test("接口未配置时明确回退原因", async () => {
  for (const partial of [{}, { apiUrl: "u", apiKey: "", model: "m" }, { apiUrl: "u", apiKey: "sk-xxx", model: "m" }]) {
    const result = await requestUnderstandingBrief({ ...partial, materials: MATERIALS, fetchImpl: fakeFetch(), timeoutMs: 100 })
    assert.equal(result.ok, false)
    assert.equal(result.reason, "api-not-configured")
  }
})

test("超时回退:卡住的请求在 timeoutMs 内返回 timeout", async () => {
  const hung = () => new Promise(() => {})
  const startedAt = Date.now()
  const result = await requestUnderstandingBrief({
    apiUrl: "https://api.example/v1/chat/completions",
    apiKey: "sk-real",
    model: "cheap-model",
    materials: MATERIALS,
    fetchImpl: hung,
    timeoutMs: 50
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, "timeout")
  assert.ok(Date.now() - startedAt < 500, "超时必须及时返回,不拖慢主回复")
})

test("HTTP 错误与不合法输出都回退", async () => {
  const http = await requestUnderstandingBrief({
    apiUrl: "u", apiKey: "sk-real", model: "m", materials: MATERIALS,
    fetchImpl: fakeFetch("", { status: 503 }), timeoutMs: 100
  })
  assert.equal(http.reason, "http-503")

  const garbage = await requestUnderstandingBrief({
    apiUrl: "u", apiKey: "sk-real", model: "m", materials: MATERIALS,
    fetchImpl: fakeFetch("好的,我来分析一下这个问题"), timeoutMs: 100
  })
  assert.equal(garbage.reason, "invalid-brief", "缺少四节结构的输出不接受")

  const tooShort = await requestUnderstandingBrief({
    apiUrl: "u", apiKey: "sk-real", model: "m", materials: MATERIALS,
    fetchImpl: fakeFetch("【用户意图】短"), timeoutMs: 100
  })
  assert.equal(tooShort.reason, "invalid-brief")
})

test("最终卡片:简报在前、原文材料为证据层、总长受 maxChars 控制", () => {
  const card = composeModelBriefCard({ brief: VALID_BRIEF, materials: MATERIALS, maxChars: 800 })
  assert.ok(card.startsWith("【理解简报】"))
  assert.ok(card.indexOf("【用户意图】") < card.indexOf("引用摘录"), "判读在证据之前")
  assert.ok(card.includes("引用摘录：[回复 星野的消息"))
  assert.ok(card.includes("近期上下文：星野: 部署一直失败"))
  assert.ok(card.includes("与原文材料冲突时以材料为准"), "证据优先原则必须在卡片里")
  assert.ok(card.length <= 800 + 10, "总长受控(允许截断误差)")

  const noEvidence = composeModelBriefCard({ brief: VALID_BRIEF, materials: { intentText: "x" }, maxChars: 800 })
  assert.ok(!noEvidence.includes("―― 原文材料"), "无材料时不输出证据层")
})

test("主链路接线:简报优先 + 失败回退规则卡 + 配置开关", () => {
  const src = [
    fs.readFileSync(path.join(root, "apps/test.js"), "utf8"),
    fs.readFileSync(path.join(root, "apps/lib/promptContext.js"), "utf8")
  ].join("\n")
  assert.ok(src.includes("await this.resolveUnderstandingPrompt({"), "注入点改为异步简报解析")
  assert.ok(src.includes("requestUnderstandingBrief({"), "模型简报调用已接线")
  assert.ok(src.includes("回退规则卡 reason="), "回退有观测日志")
  assert.ok(src.includes("briefEnabled: cfg.briefEnabled !== false"), "配置开关默认开启")
})
