import { test } from "node:test"
import assert from "node:assert/strict"
import { resolveInitialReplyExecutionRoute } from "../utils/replyExecutionRoute.js"

test("knowledge replies bypass an optional emoji-only tool route", () => {
  assert.deepEqual(resolveInitialReplyExecutionRoute({
    responseKind: "knowledge",
    toolNames: ["sendLocalEmojiTool"]
  }), { mode: "chat", reason: "knowledge_without_action" })
})

test("explicit and committed actions retain the tool route", () => {
  assert.equal(resolveInitialReplyExecutionRoute({
    responseKind: "knowledge",
    toolNames: ["sendLocalEmojiTool"],
    explicitEmojiRequest: true
  }).mode, "tool")
  assert.equal(resolveInitialReplyExecutionRoute({
    responseKind: "knowledge",
    toolNames: ["searchInformationTool"],
    toolScopeLocked: true
  }).mode, "tool")
})

test("ordinary emoji-eligible chat still lets the model choose a reaction", () => {
  assert.deepEqual(resolveInitialReplyExecutionRoute({
    responseKind: "chat",
    toolNames: ["sendLocalEmojiTool"]
  }), { mode: "tool", reason: "action_candidates" })
})
