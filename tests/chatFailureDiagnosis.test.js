import { test } from "node:test"
import assert from "node:assert/strict"
import { probeChatBackend, runChatFailureDiagnosis, getCachedDiagnosisLine } from "../utils/chatFailureDiagnosis.js"

const okFetch = async () => ({ ok: true, status: 200 })
const timeoutFetch = async (url, init) => {
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })), 20)
    init?.signal?.addEventListener("abort", () => { clearTimeout(t); reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })) })
  })
}
const refuseFetch = async () => { throw new TypeError("fetch failed") }
const serverErrorFetch = async () => ({ ok: false, status: 503 })

test("单后端探测:正常/超时/连不上/5xx 四种分类", async () => {
  assert.equal((await probeChatBackend({ url: "http://a/v1", apiKey: "k", model: "m", fetchImpl: okFetch })).kind, "ok")
  const timeout = await probeChatBackend({ url: "http://a/v1", apiKey: "k", model: "m", fetchImpl: timeoutFetch, timeoutMs: 50 })
  assert.equal(timeout.kind, "timeout")
  const refused = await probeChatBackend({ url: "http://a/v1", apiKey: "k", model: "m", fetchImpl: refuseFetch })
  assert.equal(refused.kind, "connect_fail")
  const bad = await probeChatBackend({ url: "http://a/v1", apiKey: "k", model: "m", fetchImpl: serverErrorFetch })
  assert.equal(bad.kind, "http_503")
  assert.equal((await probeChatBackend({ url: "http://a/v1", apiKey: "", fetchImpl: okFetch })).kind, "unconfigured")
})

test("全链诊断:并行探测产出报告并进入缓存,快照可同步读取", async () => {
  const settings = {
    chatAiConfig: { chatApiUrl: "http://chat/v1", chatApiKey: "k1", chatApiModel: "m1" },
    searchAiConfig: { searchApiUrl: "http://search/v1", searchApiKey: "k2", searchApiModel: "m2" },
    toolsAiConfig: { toolsAiUrl: "http://tools/v1", toolsAiApikey: "k3", toolsAiModel: "m3" },
    memoryAiConfig: { memoryAiUrl: "http://mem/v1", memoryAiApikey: "", memoryAiModel: "m4" }
  }
  const fetchImpl = async (url) => String(url).includes("search") ? (async () => { throw new TypeError("fetch failed") })() : { ok: true, status: 200 }
  const report = await runChatFailureDiagnosis({ settings, logger: null, fetchImpl })
  assert.equal(report.backends.length, 4)
  assert.equal(report.backends.find(b => b.label === "主对话").ok, true)
  assert.equal(report.backends.find(b => b.label === "联网搜索").kind, "connect_fail")
  assert.equal(report.backends.find(b => b.label === "上下文记忆").kind, "unconfigured")
  const line = getCachedDiagnosisLine()
  assert.match(line, /主对话✅/)
  assert.match(line, /联网搜索❌/)
})
