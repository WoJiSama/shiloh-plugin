import { test } from "node:test"
import assert from "node:assert/strict"
import { createTurnPlan, deriveTurnPlanRequest } from "../utils/turnPlan.js"

test("optional emoji capability does not select the tool backend", () => {
  const plan = createTurnPlan({
    responseKind: "knowledge",
    intentText: "解释一下做 MC 模组要什么",
    availableCapabilities: ["sendLocalEmojiTool"]
  })
  assert.equal(plan.execution.mode, "chat")
  assert.equal(plan.execution.modelProfile, "fast")
  assert.deepEqual(plan.capabilities.required, [])
  assert.deepEqual(plan.capabilities.optional, ["sendLocalEmojiTool"])
  assert.equal(deriveTurnPlanRequest(plan).toolChoice, "none")
})

test("casual emoji candidates stay optional but reach the tool-capable short-chat backend", () => {
  const plan = createTurnPlan({
    responseKind: "chat",
    intentText: "希洛也是ai吗",
    availableCapabilities: ["sendLocalEmojiTool"],
    requiredCapabilities: ["sendLocalEmojiTool"]
  })
  assert.equal(plan.execution.mode, "tool")
  assert.equal(plan.execution.modelProfile, "casual")
  assert.deepEqual(plan.capabilities.required, [])
  assert.deepEqual(plan.capabilities.optional, ["sendLocalEmojiTool"])
  assert.equal(plan.observability.routeReason, "optional_reaction")
  assert.deepEqual(deriveTurnPlanRequest(plan), {
    toolChoice: "auto",
    requestOptions: { taskBackend: "casual", routeLabel: "短闲聊模型" }
  })
})

test("a committed tool action becomes a required capability", () => {
  const plan = createTurnPlan({
    responseKind: "chat",
    availableCapabilities: ["bananaTool", "sendLocalEmojiTool"],
    toolChoice: { type: "function", function: { name: "bananaTool" } },
    toolScopeLocked: true
  })
  assert.equal(plan.intent, "image")
  assert.equal(plan.execution.mode, "tool")
  assert.equal(plan.execution.modelProfile, "task")
  assert.deepEqual(plan.capabilities.required, ["bananaTool", "sendLocalEmojiTool"])
  assert.deepEqual(plan.capabilities.optional, [])
})

test("an open-ended search request exposes only its requested action", () => {
  const plan = createTurnPlan({
    responseKind: "chat",
    availableCapabilities: ["searchInformationTool", "bananaTool", "sendLocalEmojiTool"],
    requiredCapabilities: ["searchInformationTool"]
  })
  assert.equal(plan.execution.mode, "tool")
  assert.deepEqual(plan.capabilities.required, ["searchInformationTool"])
  assert.deepEqual(plan.capabilities.optional, ["bananaTool", "sendLocalEmojiTool"])
})

test("explicit rigorous knowledge requests may opt into reasoning", () => {
  const plan = createTurnPlan({
    responseKind: "knowledge",
    intentText: "请完整推导这个公式"
  })
  assert.equal(plan.execution.mode, "chat")
  assert.equal(plan.execution.modelProfile, "reasoning")
})

test("serious interaction excludes optional emoji before choosing the reasoning route", () => {
  const plan = createTurnPlan({
    intentText: "CPU 95℃正常吗",
    interactionKind: "serious_answer",
    availableCapabilities: ["sendLocalEmojiTool"],
    requiredCapabilities: ["sendLocalEmojiTool"]
  })
  assert.equal(plan.execution.mode, "chat")
  assert.equal(plan.execution.modelProfile, "reasoning")
  assert.equal(plan.presentation.kind, "text")
  assert.equal(plan.observability.routeReason, "serious_answer")
  assert.deepEqual(plan.capabilities.required, [])
  assert.deepEqual(deriveTurnPlanRequest(plan).requestOptions.generation, {reasoningEffort: "high"})
  assert.match(deriveTurnPlanRequest(plan).executionPrompt, /没有可调用的工具/)
  assert.equal(deriveTurnPlanRequest(plan, {chatAiConfig: {complexReasoningEffort: false}}).requestOptions.generation, undefined)
})

test("serious interaction preserves a required tool action", () => {
  const plan = createTurnPlan({
    intentText: "认真查一下设备召回公告",
    interactionKind: "serious_answer",
    availableCapabilities: ["searchInformationTool", "sendLocalEmojiTool"],
    requiredCapabilities: ["searchInformationTool"]
  })
  assert.equal(plan.execution.mode, "tool")
  assert.equal(plan.execution.modelProfile, "task")
  assert.deepEqual(plan.capabilities.required, ["searchInformationTool"])
  assert.equal(deriveTurnPlanRequest(plan).executionPrompt, undefined)
})

test("delivery status checks preserve evidence reasoning instead of selecting a casual reaction", () => {
  const plan = createTurnPlan({intentText: "刚才改背景的图出来了吗？", interactionKind: "delivery", availableCapabilities: ["sendLocalEmojiTool"]})
  assert.equal(plan.execution.mode, "chat")
  assert.equal(plan.execution.modelProfile, "reasoning")
  assert.equal(plan.observability.routeReason, "delivery_status")
  assert.equal(deriveTurnPlanRequest(plan).requestOptions.generation.reasoningEffort, "high")
  assert.match(deriveTurnPlanRequest(plan).executionPrompt, /不要替用户重新发起旧任务/)
})
