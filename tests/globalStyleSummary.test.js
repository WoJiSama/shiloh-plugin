import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { GlobalStyleLearnerManager } from "../utils/GlobalStyleLearnerManager.js"

const aiConfig = {
  memoryAiUrl: "https://summary.invalid/chat/completions",
  memoryAiModel: "reasoning-model",
  memoryAiApikey: "test-key"
}

function response(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data
  }
}

function completedResponse(overrides = {}) {
  return response({
    choices: [{
      finish_reason: "stop",
      message: {
        content: JSON.stringify({
          absorb: [{ label: "直答", rule: "先给结论，再按需要补充原因。", confidence: 0.9, reason: "短句样本稳定" }],
          avoid: [{ label: "客服腔", rule: "避免使用模板化客服措辞。", confidence: 0.85, reason: "负面样本明显" }]
        })
      }
    }],
    usage: { completion_tokens: 500 },
    ...overrides
  })
}

function createRuntime(fetchFn, configOverrides = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "style-summary-"))
  const warnings = []
  const manager = new GlobalStyleLearnerManager({
    cwd,
    fetchFn,
    logger: { warn(message) { warnings.push(String(message)) }, info() {} }
  })
  const config = {
    baseDir: "data/style",
    summarySampleLimit: 40,
    summaryMaxTokens: 2400,
    summaryRetryMaxTokens: 4000,
    summaryRetryTimeoutMs: 60000,
    summaryRetrySampleLimit: 20,
    summaryTimeoutMs: 30000,
    autoSummaryEnabled: true,
    autoSummaryMinTotalSamples: 20,
    autoSummaryMinNewSamples: 20,
    autoSummaryFailureCooldownMinutes: 30,
    ...configOverrides
  }
  const memory = manager.readMemory(config)
  memory.totalSamples = 40
  memory.samplePool = Array.from({ length: 40 }, (_, index) => ({
    text: `匿名表达样本 ${index + 1}`,
    essence: index % 2 ? ["short_first"] : [],
    dross: index % 2 ? [] : ["customer_tone"]
  }))
  return {
    cwd,
    manager,
    config,
    warnings,
    cleanup() {
      manager.flushTimer && clearTimeout(manager.flushTimer)
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  }
}

test("summary retries with fewer samples and a larger budget when reasoning consumes the first response", async t => {
  const requests = []
  const runtime = createRuntime(async (_url, options) => {
    const body = JSON.parse(options.body)
    requests.push(body)
    if (requests.length === 1) {
      return response({
        choices: [{ finish_reason: "length", message: { content: "", reasoning_content: "内部推理，不应被保存" } }],
        usage: {
          completion_tokens: 2400,
          completion_tokens_details: { reasoning_tokens: 2400 }
        }
      })
    }
    return completedResponse()
  })
  t.after(runtime.cleanup)

  const result = await runtime.manager.summarizeWithAI(runtime.config, aiConfig)
  assert.equal(requests.length, 2)
  assert.equal(requests[0].max_tokens, 2400)
  assert.equal(requests[1].max_tokens, 4000)
  assert.equal(JSON.parse(requests[0].messages[1].content).sanitizedSamples.length, 40)
  assert.equal(JSON.parse(requests[1].messages[1].content).sanitizedSamples.length, 20)
  assert.equal(JSON.parse(requests[1].messages[1].content).limits.maxAbsorb, 4)
  assert.equal(JSON.parse(requests[1].messages[1].content).limits.maxAvoid, 4)
  assert.match(requests[1].messages[0].content, /完整性重试/)
  assert.equal(result.sampleCount, 20)
  assert.equal(result.totalAbsorb, 1)
  assert.equal(result.totalAvoid, 1)
  assert.ok(runtime.warnings.some(message => /推理 2400 token/.test(message)))
  assert.doesNotMatch(JSON.stringify(runtime.manager.readMemory(runtime.config)), /内部推理/)
})

test("summary retries an incomplete JSON response without committing partial rules", async t => {
  let calls = 0
  const runtime = createRuntime(async () => {
    calls += 1
    if (calls === 1) {
      return response({
        choices: [{ finish_reason: "length", message: { content: "{\"absorb\":[{\"label\":\"局部\",\"rule\":\"不能提交局部规则\",\"confidence\":0.9}],\"avoid\":[" } }],
        usage: { completion_tokens: 2400 }
      })
    }
    assert.equal(runtime.manager.readMemory(runtime.config).aiRules.absorb.length, 0)
    return completedResponse()
  })
  t.after(runtime.cleanup)

  const result = await runtime.manager.summarizeWithAI(runtime.config, aiConfig)
  assert.equal(calls, 2)
  assert.equal(result.totalAbsorb, 1)
  assert.equal(runtime.manager.readMemory(runtime.config).aiSummary.count, 1)
})

test("summary normalizes a provider timeout and retries with the compact request", async t => {
  let calls = 0
  const runtime = createRuntime(async () => {
    calls += 1
    if (calls === 1) {
      const error = new Error("The operation was aborted due to timeout")
      error.name = "TimeoutError"
      error.code = 23
      throw error
    }
    return completedResponse()
  })
  t.after(runtime.cleanup)

  const result = await runtime.manager.summarizeWithAI(runtime.config, aiConfig)
  assert.equal(calls, 2)
  assert.equal(result.totalAbsorb, 1)
  assert.ok(runtime.warnings.some(message => /模型总结请求超时（30000ms）/.test(message)))
})

test("summary reports output exhaustion clearly and keeps memory unchanged after both attempts fail", async t => {
  let calls = 0
  const runtime = createRuntime(async (_url, options) => {
    calls += 1
    const maxTokens = JSON.parse(options.body).max_tokens
    return response({
      choices: [{ finish_reason: "length", message: { content: "", reasoning_content: "hidden" } }],
      usage: {
        completion_tokens: maxTokens,
        completion_tokens_details: { reasoning_tokens: maxTokens }
      }
    })
  })
  t.after(runtime.cleanup)

  await assert.rejects(
    () => runtime.manager.summarizeWithAI(runtime.config, aiConfig),
    /模型总结重试后仍失败：模型推理耗尽输出额度/
  )
  assert.equal(calls, 2)
  const memory = runtime.manager.readMemory(runtime.config)
  assert.equal(memory.aiRules.absorb.length, 0)
  assert.equal(memory.aiRules.avoid.length, 0)
  assert.equal(memory.aiSummary.count, 0)
})

test("automatic summary failure enters backoff instead of retrying on every message", async t => {
  let calls = 0
  const runtime = createRuntime(async (_url, options) => {
    calls += 1
    const maxTokens = JSON.parse(options.body).max_tokens
    return response({
      choices: [{ finish_reason: "length", message: { content: "", reasoning_content: "hidden" } }],
      usage: { completion_tokens_details: { reasoning_tokens: maxTokens } }
    })
  })
  t.after(runtime.cleanup)

  const first = await runtime.manager.maybeAutoSummarize(runtime.config, aiConfig)
  assert.equal(first.triggered, false)
  assert.ok(first.error)
  assert.equal(calls, 2)
  const memory = runtime.manager.readMemory(runtime.config)
  assert.ok(memory.aiSummary.lastAutoFailureAt)
  assert.equal(memory.aiSummary.autoFailureCount, 1)
  assert.equal(memory.aiSummary.lastAutoError, "output_limit")
  assert.equal(runtime.manager.getAutoSummaryState(runtime.config).failureCooldownReady, false)

  const second = await runtime.manager.maybeAutoSummarize(runtime.config, aiConfig)
  assert.equal(second.triggered, false)
  assert.equal(calls, 2)
})
