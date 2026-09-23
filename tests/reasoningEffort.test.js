// 推理升档落地测试:复杂度判定扩容(多约束对比/排障/连环追问/规划)、
// chat 回合也可升档、reasoning 档请求真正携带 reasoning_effort、
// 配置可改档可关闭、其他档位不受影响。
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createTurnPlan, deriveTurnPlanRequest, needsDeliberateReasoning } from "../utils/turnPlan.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

function profileOf(intentText, responseKind = "knowledge") {
  return createTurnPlan({ responseKind, intentText }).execution.modelProfile
}

test("原有学术推导类关键词仍触发升档", () => {
  assert.equal(profileOf("请完整推导这个公式"), "reasoning")
  assert.equal(profileOf("严格证明一下这个结论"), "reasoning")
})

test("多约束对比类问法触发升档", () => {
  assert.equal(profileOf("A方案和B方案对比一下哪个好"), "reasoning")
  assert.equal(profileOf("这两个显卡比较一下,我该选哪个"), "reasoning")
})

test("故障排查类问法触发升档(即使 responseKind 是 chat)", () => {
  // 排障类被 isEducationalExplanationRequest 显式排除在 knowledge 之外,
  // 旧逻辑永远拿不到 reasoning 档;现在按内容判定,不再依赖 responseKind
  assert.equal(profileOf("为什么部署一直报错,配置我没动过", "chat"), "reasoning")
  assert.equal(profileOf("服务突然崩了怎么回事", "chat"), "reasoning")
})

test("连环追问(疑问信号≥3)触发升档,单一疑问不触发", () => {
  assert.equal(profileOf("这个怎么配置?为什么要这样?如果改了会影响什么?", "chat"), "reasoning")
  assert.equal(profileOf("这个怎么配置", "chat"), "adaptive")
})

test("方案规划类问法触发升档", () => {
  assert.equal(profileOf("迁移方案的步骤怎么排", "chat"), "reasoning")
})

test("短闲聊不被误伤:仍走 casual 提速路径", () => {
  const plan = createTurnPlan({
    responseKind: "chat",
    intentText: "哈哈哈笑死",
    availableCapabilities: ["sendLocalEmojiTool"]
  })
  assert.equal(plan.execution.modelProfile, "casual")
  assert.equal(needsDeliberateReasoning("哈哈哈笑死"), false)
})

test("reasoning 档请求默认携带 reasoning_effort: high", () => {
  const plan = createTurnPlan({ responseKind: "knowledge", intentText: "请完整推导这个公式" })
  const request = deriveTurnPlanRequest(plan)
  assert.deepEqual(request.requestOptions.generation, { reasoningEffort: "high" })
  assert.equal(request.requestOptions.routeLabel, "复杂知识推理")
  assert.equal(request.toolChoice, "none")
})

test("配置可改档与关闭", () => {
  const plan = createTurnPlan({ responseKind: "knowledge", intentText: "请完整推导这个公式" })
  assert.equal(
    deriveTurnPlanRequest(plan, { chatAiConfig: { complexReasoningEffort: "medium" } }).requestOptions.generation.reasoningEffort,
    "medium"
  )
  for (const off of ["false", "none", "", "无效值"]) {
    const request = deriveTurnPlanRequest(plan, { chatAiConfig: { complexReasoningEffort: off } })
    assert.equal(request.requestOptions.generation, undefined, `配置 ${off} 应关闭升档`)
    assert.equal(request.requestOptions.routeLabel, "复杂知识推理", "标签保留,便于观测")
  }
})

test("其他档位不受升档影响", () => {
  const fast = createTurnPlan({ responseKind: "knowledge", intentText: "解释一下做 MC 模组要什么" })
  assert.deepEqual(
    deriveTurnPlanRequest(fast).requestOptions,
    { forceChatBackend: true, routeLabel: "快速知识回复" }
  )
  const casual = createTurnPlan({
    responseKind: "chat",
    intentText: "希洛也是ai吗",
    availableCapabilities: ["sendLocalEmojiTool"],
    requiredCapabilities: ["sendLocalEmojiTool"]
  })
  assert.deepEqual(
    deriveTurnPlanRequest(casual).requestOptions,
    { taskBackend: "casual", routeLabel: "短闲聊模型" }
  )
  const adaptive = createTurnPlan({ responseKind: "chat", intentText: "这个怎么配置" })
  assert.deepEqual(deriveTurnPlanRequest(adaptive).requestOptions, {})
})

test("主链路已把配置传入 deriveTurnPlanRequest", () => {
  const src = fs.readFileSync(path.join(root, "apps/test.js"), "utf8")
  assert.ok(
    src.includes("deriveTurnPlanRequest(turnPlan, this.config)"),
    "主链路需传 config,否则 complexReasoningEffort 配置不生效"
  )
})
