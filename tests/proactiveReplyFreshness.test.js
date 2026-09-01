import { test } from "node:test"
import assert from "node:assert/strict"
import { markProactiveReply, shouldCancelProactiveReply } from "../utils/proactiveReplyFreshness.js"

test("cancels a proactive reply when a newer group message has arrived", () => {
  const event = markProactiveReply({}, 100)
  assert.equal(shouldCancelProactiveReply(event, 101), true)
})

test("keeps current proactive and all direct replies", () => {
  assert.equal(shouldCancelProactiveReply(markProactiveReply({}, 100), 100), false)
  assert.equal(shouldCancelProactiveReply({}, 999), false)
})
