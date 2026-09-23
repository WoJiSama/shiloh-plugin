import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"

const source = fs.readFileSync(new URL("../apps/test.js", import.meta.url), "utf8")
const routeSource = fs.readFileSync(new URL("../utils/routeDecision.js", import.meta.url), "utf8")
const semanticSource = fs.readFileSync(new URL("../apps/lib/semanticToolIntent.js", import.meta.url), "utf8")

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
  assert.match(source, /const initialToolNames = turnPlan\.capabilities\.required\.length/)
  assert.match(source, /: turnPlan\.capabilities\.optional/)
  assert.match(source, /this\.getToolsByName\(initialToolNames\)/)
})

test("knowledge replies use TurnPlan instead of optional emoji capability routing", () => {
  assert.match(source, /createTurnPlan/)
  assert.match(source, /requestedActionCapabilities = selectToolIntentCandidates/)
  assert.match(source, /responseKind: isEducationalExplanationRequest\(currentIntentText\) \? "knowledge" : "chat"/)
  assert.match(source, /formatTurnPlanLog\(turnPlan\)/)
  const genericEmojiExposure = source.indexOf("轻松闲聊仅启用 sendLocalEmojiTool")
  const executionRoute = source.indexOf("const turnPlan = createTurnPlan")
  // buildRequestData 已迁至 utils/modelGateway.js(buildChatRequestData),主链路改为直接调用
  const modelRequest = source.indexOf("const requestData = buildChatRequestData(this.config,")
  assert.ok(genericEmojiExposure > 0 && executionRoute > genericEmojiExposure && modelRequest > executionRoute)
})

test("card replies acknowledge before generation and keep the card body free of process text", () => {
  // resolveCardPresentation 迁至 utils/turnPresentation.js,卡面正文边界层迁至 utils/turnPromptComposer.js
  const presentationSrc = fs.readFileSync(new URL("../utils/turnPresentation.js", import.meta.url), "utf8")
  const composerSrc = fs.readFileSync(new URL("../utils/turnPromptComposer.js", import.meta.url), "utf8")
  assert.match(presentationSrc, /function resolveCardPresentation/)
  assert.ok(source.includes('cardAcknowledgement(') || source.includes('from "./lib/textPolicy.js"'), '卡面确认函数可用(已迁 lib)')
  assert.match(source, /session\.cardPresentation = resolveCardPresentation/)
  assert.match(source, /const cardRequestText = \[args, msg, userContent\]/)
  assert.doesNotMatch(source, /isEducationalExplanationRequest\(currentIntentText\) \? "knowledge" : "chat"\n\s*\)\n\s*\? \[/)
  assert.match(source, /承诺类确认已入队/)
  assert.match(composerSrc, /卡面正文边界/)
  assert.match(source, /已剥离模型开场/)
  const acknowledgement = source.indexOf("const acknowledgement = cardAcknowledgement")
  const request = source.indexOf("const requestData = buildChatRequestData(this.config,", acknowledgement)
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
  assert.match(source, /async sendObservedReply\(/)
})
