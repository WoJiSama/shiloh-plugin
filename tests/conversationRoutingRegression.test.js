import { test } from "node:test"
import { readPluginSources, readSource } from "./helpers/pluginSources.js"
import assert from "node:assert/strict"
import fs from "node:fs"
import { createTurnPlan, deriveTurnPlanRequest } from "../dist/backend/modules/conversation/infrastructure/turnPlan.js"
import { buildChatRequestData } from "../dist/backend/modules/models/domain/modelGateway.js"

const source = readPluginSources()
const routeSource = readSource("utils/routeDecision.js")
const semanticSource = readSource("apps/lib/semanticToolIntent.js")



test("explicit image generation is forced before semantic planning", () => {
  // 规则表顺序即裁决优先级:显式生图规则必须排在语义规划器之前
  const forced = routeSource.indexOf("name: \"explicitImageGeneration\"")
  const planner = routeSource.indexOf("name: \"semanticPlanner\"")
  assert.ok(forced > 0 && planner > forced)
  assert.ok(routeSource.includes("显式生图请求直接使用 bananaTool"))
})

test("the semantic planner ignores emoji-only candidates", () => {
  assert.match(source + semanticSource, /hasSemanticPlannerCandidate\(knownToolCandidates\)\s*\?\s*knownToolCandidates\s*:\s*\[\]/)
})

test("high-confidence emoji reactions bypass model tool selection", () => {
  // 表情快路规则已迁入 routeDecision;强制路先于主链路的通用暴露过滤(规则表整体先于 filter 执行)
  assert.match(routeSource, /const reaction = resolveForcedReactionEmoji\(ctx\.intentText\)/)
  assert.match(routeSource, /强制发送反应表情/)
  assert.ok(routeSource.indexOf("name: \"forcedReactionEmoji\"") < routeSource.indexOf("name: \"semanticPlanner\""))
  assert.ok(source.includes("轻松闲聊仅启用 sendLocalEmojiTool"), "通用暴露过滤仍在主链路收尾")
})

test("ordinary casual emoji replies retain the optional tool for model selection", () => {
  const emoji = { type: "function", function: { name: "sendLocalEmojiTool", parameters: { type: "object", properties: {} } } }
  const plan = createTurnPlan({ intentText: "哈哈", availableCapabilities: [emoji.function.name] })
  assert.deepEqual(plan.capabilities.required, [])
  assert.deepEqual(plan.capabilities.optional, [emoji.function.name])
  assert.equal(plan.execution.mode, "tool")
  const request = buildChatRequestData({ useTools: true }, [{ role: "user", content: "哈哈" }], [emoji], deriveTurnPlanRequest(plan).toolChoice)
  assert.deepEqual(request.tools, [emoji])
  assert.equal(request.tool_choice, "auto", "the model can choose either the admitted reaction or ordinary text")
})

test("knowledge replies use TurnPlan instead of optional emoji capability routing", () => {
  const emoji = { type: "function", function: { name: "sendLocalEmojiTool", parameters: { type: "object", properties: {} } } }
  const plan = createTurnPlan({ responseKind: "knowledge", intentText: "解释什么是比热容", availableCapabilities: [emoji.function.name], requiredCapabilities: [emoji.function.name] })
  assert.deepEqual(plan.capabilities.required, [], "an optional emoji candidate cannot turn a knowledge answer into a required action")
  assert.equal(plan.execution.mode, "chat")
  assert.equal(plan.presentation.kind, "knowledge")
  const request = buildChatRequestData({ useTools: true }, [{ role: "user", content: "解释什么是比热容" }], [emoji], deriveTurnPlanRequest(plan).toolChoice)
  assert.equal(request.tools, undefined)
  assert.equal(request.tool_choice, undefined)
})

test("card replies acknowledge before generation and keep the card body free of process text", () => {
  // resolveCardPresentation 迁至 utils/turnPresentation.js,卡面正文边界层迁至 utils/turnPromptComposer.js
  const presentationSrc = readSource("utils/turnPresentation.js")
  const composerSrc = readSource("utils/turnPromptComposer.js")
  assert.match(presentationSrc, /function resolveCardPresentation/)
  assert.ok(source.includes('cardAcknowledgement(') || source.includes('from "./lib/textPolicy.js"'), '卡面确认函数可用(已迁 lib)')
  assert.match(source, /session\.cardPresentation = resolveCardPresentation/)
  assert.match(source, /const cardRequestText = \[args, msg, userContent\]/)
  assert.doesNotMatch(source, /isEducationalExplanationRequest\(currentIntentText\) \? "knowledge" : "chat"\n\s*\)\n\s*\? \[/)
  assert.match(source, /承诺类确认已入队/)
  assert.match(composerSrc, /卡面正文边界/)
  assert.match(source, /已剥离模型开场/)
  const acknowledgement = source.indexOf("const acknowledgement = cardAcknowledgement")
  const request = source.indexOf("const requestData = buildChatRequestData(host.config,", acknowledgement)
  assert.ok(acknowledgement > 0 && request > acknowledgement)
})

test("committed memory actions override later generic chat failures", () => {
  assert.match(source, /recordActionOutcomes\(session, "group_knowledge", savedKnowledgeEntries\)/)
  assert.match(source, /const committedReply = buildCommittedActionReply\(context\?\.session\)/)
})

test("proactive freshness is anchored to the source message and checked before sending", () => {
  assert.match(source, /e\._incomingMessageAt = incomingAt/)
  assert.match(source, /markProactiveReply\(e, e\?\._incomingMessageAt/)
  const freshness = source.indexOf("shouldCancelProactiveReply(e")
  const sanitize = source.indexOf("sanitizeFinalReplyText(output)", freshness)
  assert.ok(freshness > 0 && sanitize > freshness)
})

test("all direct replies in the main agent use one observed delivery method", () => {
  const directReplies = source.match(/await e\.reply\(/g) || []
  assert.equal(directReplies.length, 1)
  assert.match(source, /async (?:function )?sendObservedReply\(/)
})
