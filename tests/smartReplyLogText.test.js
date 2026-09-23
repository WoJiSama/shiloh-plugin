import test from "node:test"
import assert from "node:assert/strict"
import { sendSmartReply } from "../utils/SmartReply.js"

test("forceText keeps long structured dice output recordable instead of rendering a card", async () => {
  const replies = []
  const output = Array.from({ length: 10 }, (_, index) => `第${index + 1}轮：1d10=${index + 1}`).join("\n")
  const result = await sendSmartReply({
    async reply(message) {
      replies.push(message)
      return { message_id: "text-message" }
    }
  }, output, { kind: "diceLong", forceText: true })

  assert.equal(result.message_id, "text-message")
  assert.deepEqual(replies, [output])
})
