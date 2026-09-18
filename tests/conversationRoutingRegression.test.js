import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"

const source = fs.readFileSync(new URL("../apps/test.js", import.meta.url), "utf8")

test("explicit image generation is forced before semantic planning", () => {
  const forced = source.indexOf("显式生图请求直接使用 bananaTool")
  const planner = source.indexOf("const semanticDecision =", forced)
  assert.ok(forced > 0)
  assert.ok(planner > forced)
})

test("the semantic planner ignores emoji-only candidates", () => {
  assert.match(source, /hasSemanticPlannerCandidate\(knownToolCandidates\)\s*\?\s*knownToolCandidates\s*:\s*\[\]/)
})

test("high-confidence emoji reactions bypass model tool selection", () => {
  assert.match(source, /const forcedReactionEmoji = resolveForcedReactionEmoji\(currentIntentText\)/)
  assert.match(source, /强制发送反应表情/)
  const forcedEmoji = source.indexOf("强制发送反应表情")
  const genericEmojiExposure = source.indexOf("轻松闲聊仅启用 sendLocalEmojiTool")
  assert.ok(forcedEmoji > 0 && genericEmojiExposure > forcedEmoji)
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
  const modelRequest = source.indexOf("const requestData = this.buildRequestData")
  assert.ok(genericEmojiExposure > 0 && executionRoute > genericEmojiExposure && modelRequest > executionRoute)
})

test("card replies acknowledge before generation and keep the card body free of process text", () => {
  assert.match(source, /function resolveCardPresentation/)
  assert.match(source, /function cardAcknowledgement/)
  assert.match(source, /session\.cardPresentation = resolveCardPresentation/)
  assert.match(source, /const cardRequestText = \[args, msg, userContent\]/)
  assert.doesNotMatch(source, /isEducationalExplanationRequest\(currentIntentText\) \? "knowledge" : "chat"\n\s*\)\n\s*\? \[/)
  assert.match(source, /承诺类确认已入队/)
  assert.match(source, /卡面正文边界/)
  assert.match(source, /已剥离模型开场/)
  const acknowledgement = source.indexOf("const acknowledgement = cardAcknowledgement")
  const request = source.indexOf("const requestData = this.buildRequestData", acknowledgement)
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
