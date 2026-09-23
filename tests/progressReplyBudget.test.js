import test from "node:test"
import assert from "node:assert/strict"
import { reserveProgressReply } from "../utils/progressReplyBudget.js"

test("allows only one committed progress reply per conversation turn", () => {
  const event = { _progressReplyState: { sent: false, reserved: false } }
  const first = reserveProgressReply(event)
  assert.ok(first)
  assert.equal(reserveProgressReply(event), null)

  first.commit()
  assert.equal(reserveProgressReply(event), null)
})

test("releases an unused reservation for a later tool stage", () => {
  const event = { _progressReplyState: { sent: false, reserved: false } }
  const first = reserveProgressReply(event)
  first.release()

  const second = reserveProgressReply(event)
  assert.ok(second)
  second.commit()
  assert.equal(event._progressReplyState.sent, true)
})

test("standalone tools without turn state keep their existing behavior", () => {
  assert.ok(reserveProgressReply({}))
})
