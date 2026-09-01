import assert from "node:assert/strict"
import { test } from "node:test"
import { MEDIA_ARCHIVE_DISPATCH_PRIORITY, claimMediaRelay, relayArchivedMedia, resetMediaRelayDedupForTest, snapshotArchiveEvent } from "../utils/mediaArchiveRelay.js"

test("media archive dispatches before the global chat handler", () => {
  assert.ok(MEDIA_ARCHIVE_DISPATCH_PRIORITY > 9999)
})

test("media relay dedupes the same group message without mutating a reused event object", () => {
  resetMediaRelayDedupForTest()
  const reusedEvent = { group_id: 953676639, message_id: 101 }
  assert.equal(claimMediaRelay(reusedEvent), true)
  assert.equal(claimMediaRelay(reusedEvent), false)

  reusedEvent.group_id = 609235590
  reusedEvent.message_id = 202
  assert.equal(claimMediaRelay(reusedEvent), true)
  assert.equal(Object.hasOwn(reusedEvent, "_archiveMediaRelayed"), false)
})

test("reused event object relays distinct group messages independently", async () => {
  resetMediaRelayDedupForTest()
  const originalBot = globalThis.Bot
  const originalSegment = globalThis.segment
  const calls = []
  try {
    globalThis.Bot = { uin: 3094088525, nickname: "希洛" }
    globalThis.segment = { image: url => ({ type: "image", file: url }) }
    const reusedEvent = {
      group_id: 953676639,
      message_id: 301,
      bot: { sendApi: async (action, params) => calls.push({ action, params }) }
    }
    const record = {
      user_id: 925640859,
      runtimeMessage: [{
        type: "bilibili",
        title: "超长视频",
        duration: 1801,
        page_url: "https://www.bilibili.com/video/BV1test12345",
        cover_url: "https://image.example/cover.jpg"
      }]
    }
    await relayArchivedMedia(reusedEvent, record, { logger: { info() {}, warn() {} } })
    reusedEvent.group_id = 609235590
    reusedEvent.message_id = 302
    await relayArchivedMedia(reusedEvent, record, { logger: { info() {}, warn() {} } })

    assert.equal(calls.length, 2)
    assert.deepEqual(calls.map(call => call.params.group_id), [953676639, 609235590])
    assert.ok(calls.every(call => call.action === "send_group_forward_msg"))
  } finally {
    globalThis.Bot = originalBot
    globalThis.segment = originalSegment
  }
})

test("archive snapshot preserves non-enumerable message type and the original send target", async () => {
  const calls = []
  const event = { group_id: 953676639, message_id: 401, message: [{ type: "text", data: { text: "first" } }] }
  Object.defineProperty(event, "message_type", { value: "group", enumerable: false })
  event.bot = { sendApi: async (_, params) => calls.push(params.group_id) }

  const snapshot = snapshotArchiveEvent(event)
  event.group_id = 609235590
  event.message_id = 402
  event.message[0].data.text = "second"

  assert.equal(snapshot.message_type, "group")
  assert.equal(snapshot.group_id, 953676639)
  assert.equal(snapshot.message_id, 401)
  assert.equal(snapshot.message[0].data.text, "first")
  await snapshot.bot.sendApi("send_group_forward_msg", { group_id: snapshot.group_id })
  assert.deepEqual(calls, [953676639])
})
