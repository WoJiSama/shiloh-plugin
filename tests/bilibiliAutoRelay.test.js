import { test } from "node:test"
import assert from "node:assert/strict"

test("archive relay priority precedes the global chat handler", async t => {
  globalThis.plugin ||= class {}
  globalThis.logger ||= { info() {}, warn() {}, error() {}, debug() {}, mark() {} }
  try {
    const { MESSAGE_ARCHIVE_RECORDER_PRIORITY } = await import("../apps/MessageArchiveRecorder.js")
    assert.equal(MESSAGE_ARCHIVE_RECORDER_PRIORITY, 10050)
    assert.ok(MESSAGE_ARCHIVE_RECORDER_PRIORITY > 9999)
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      t.skip(`runtime dependency is not installed in this checkout: ${error.message}`)
      return
    }
    throw error
  }
})

test("a newly archived Bilibili card is immediately relayed back to the group", async t => {
  globalThis.plugin ||= class {}
  globalThis.Bot ||= { uin: 3094088525, nickname: "希洛" }
  globalThis.logger ||= { info() {}, warn() {}, error() {}, debug() {}, mark() {} }
  globalThis.segment = {
    image: url => ({ type: "image", url }),
    video: file => ({ type: "video", file }),
    reply: id => ({ type: "reply", id })
  }

  let MessageArchiveRecorder
  let messageArchiveManager
  try {
    ;({ MessageArchiveRecorder } = await import("../apps/MessageArchiveRecorder.js"))
    ;({ messageArchiveManager } = await import("../utils/MessageArchiveManager.js"))
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      t.diagnostic(`本机缺少既有运行依赖，自动搬运集成测试留给线上: ${error.message}`)
      return
    }
    throw error
  }

  const originalRecordMessage = messageArchiveManager.recordMessage
  const originalFetch = globalThis.fetch
  try {
    messageArchiveManager.recordMessage = async () => ({
      user_id: 925640859,
      message: [{
        type: "bilibili",
        title: "超长视频",
        bvid: "BV1234567890",
        duration: 1801,
        page_url: "https://www.bilibili.com/video/BV1234567890",
        cover_url: "https://image.example/cover.jpg"
      }]
    })
    globalThis.fetch = async () => { throw new Error("超长视频不应请求播放资源") }
    const recorder = Object.create(MessageArchiveRecorder.prototype)
    const replies = []
    await recorder.recordArchiveMessage({
      group_id: 609235590,
      user_id: 925640859,
      message_id: 123,
      group: { makeForwardMsg: async nodes => ({ type: "forward", nodes }) },
      reply: async message => replies.push(message)
    })

    assert.equal(replies.length, 1)
    assert.equal(replies[0]?.type, "forward")
    assert.equal(replies[0].nodes.length, 1)
    const info = replies[0].nodes[0].message
    assert.ok(info.some(item => typeof item === "string" && item.includes("B站视频搬一下")))
    assert.ok(info.some(item => typeof item === "string" && item.includes("视频 URL:https://www.bilibili.com/video/BV1234567890")))
    assert.ok(info.some(item => typeof item === "string" && item.includes("封面 URL:https://image.example/cover.jpg")))
    assert.ok(info.some(item => item?.type === "image"))
    assert.ok(info.some(item => typeof item === "string" && item.includes("超过30分钟")))
    assert.ok(!info.some(item => item?.type === "video"))
  } finally {
    messageArchiveManager.recordMessage = originalRecordMessage
    globalThis.fetch = originalFetch
  }
})

test("primary message recorder relays an archived Bilibili card", async t => {
  globalThis.plugin ||= class {}
  globalThis.Bot ||= { uin: 3094088525, nickname: "希洛" }
  globalThis.logger ||= { info() {}, warn() {}, error() {}, debug() {}, mark() {} }
  globalThis.segment = {
    image: url => ({ type: "image", url }),
    video: file => ({ type: "video", file })
  }
  let MessageRecordPlugin
  try {
    ;({ MessageRecordPlugin } = await import("../apps/MessageManager.js"))
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      t.skip(`runtime dependency is not installed in this checkout: ${error.message}`)
      return
    }
    throw error
  }
  const replies = []
  const record = {
    user_id: 925640859,
    runtimeMessage: [{
      type: "bilibili",
      title: "入口回归",
      bvid: "BV1PqNb6uEXY",
      duration: 1801,
      page_url: "https://www.bilibili.com/video/BV1PqNb6uEXY",
      cover_url: "https://image.example/cover.jpg"
    }]
  }
  const plugin = Object.create(MessageRecordPlugin.prototype)
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => { throw new Error("超长视频不应请求播放资源") }
    await plugin.autoRelayArchivedMedia({
      group_id: 609235590,
      user_id: 925640859,
      message_id: 99,
      group: { makeForwardMsg: async nodes => ({ type: "forward", nodes }) },
      reply: async message => replies.push(message)
    }, record)
    assert.equal(replies.length, 1)
    assert.equal(replies[0]?.type, "forward")
    assert.match(replies[0].nodes[0].message[0], /B站视频搬一下/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("primary message recorder uses the OneBot forward API even when video download is unavailable", async t => {
  globalThis.plugin ||= class {}
  globalThis.Bot ||= { uin: 3094088525, nickname: "希洛" }
  globalThis.logger ||= { info() {}, warn() {}, error() {}, debug() {}, mark() {} }
  globalThis.segment = { image: url => ({ type: "image", url }), video: file => ({ type: "video", file }) }
  let MessageRecordPlugin
  try {
    ;({ MessageRecordPlugin } = await import("../apps/MessageManager.js"))
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      t.skip(`runtime dependency is not installed in this checkout: ${error.message}`)
      return
    }
    throw error
  }
  const apiCalls = []
  const plugin = Object.create(MessageRecordPlugin.prototype)
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => { throw new Error("playback unavailable") }
    await plugin.autoRelayArchivedMedia({
      group_id: 609235590,
      message_id: 100,
      bot: { sendApi: async (action, params) => apiCalls.push({ action, params }) },
      reply: async () => { throw new Error("fallback reply should not run") }
    }, {
      user_id: 925640859,
      runtimeMessage: [{
        type: "bilibili",
        title: "直发回归",
        bvid: "BV1PqNb6uEXY",
        cid: 1,
        duration: 10,
        page_url: "https://www.bilibili.com/video/BV1PqNb6uEXY"
      }]
    })
    assert.equal(apiCalls.length, 1)
    assert.equal(apiCalls[0].action, "send_group_forward_msg")
    assert.equal(apiCalls[0].params.group_id, 609235590)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("short Bilibili videos are packed into one merged forward message", async t => {
  globalThis.plugin ||= class {}
  globalThis.Bot ||= { uin: 3094088525, nickname: "希洛" }
  globalThis.logger ||= { info() {}, warn() {}, error() {}, debug() {}, mark() {} }
  globalThis.segment = {
    image: url => ({ type: "image", url }),
    video: file => ({ type: "video", file }),
    reply: id => ({ type: "reply", id })
  }

  let MessageArchiveRecorder
  let messageArchiveManager
  try {
    ;({ MessageArchiveRecorder } = await import("../apps/MessageArchiveRecorder.js"))
    ;({ messageArchiveManager } = await import("../utils/MessageArchiveManager.js"))
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      t.diagnostic(`本机缺少既有运行依赖，自动搬运集成测试留给线上: ${error.message}`)
      return
    }
    throw error
  }

  const originalRecordMessage = messageArchiveManager.recordMessage
  const originalFetch = globalThis.fetch
  try {
    messageArchiveManager.recordMessage = async () => ({
      user_id: 925640859,
      message: [{
        type: "bilibili",
        title: "短视频",
        bvid: "BV1234567890",
        cid: 1,
        duration: 10,
        page_url: "https://www.bilibili.com/video/BV1234567890",
        cover_url: "https://image.example/cover.jpg"
      }]
    })
    globalThis.fetch = async url => {
      if (String(url).includes("x/player/playurl")) {
        return { ok: true, async json() { return { code: 0, data: { durl: [{ url: "https://video.example/short.mp4", size: 4 }] } } } }
      }
      const { Readable } = await import("stream")
      return {
        ok: true,
        headers: { get: name => name === "content-length" ? "4" : null },
        body: Readable.toWeb(Readable.from(Buffer.from("test")))
      }
    }
    const recorder = Object.create(MessageArchiveRecorder.prototype)
    const replies = []
    await recorder.recordArchiveMessage({
      group_id: 609235590,
      user_id: 925640859,
      message_id: 124,
      group: { makeForwardMsg: async nodes => ({ type: "forward", nodes }) },
      reply: async message => replies.push(message)
    })

    assert.equal(replies.length, 1)
    assert.equal(replies[0]?.type, "forward")
    assert.equal(replies[0].nodes.length, 2)
    assert.equal(replies[0].nodes[1].message[0]?.type, "video")
    assert.match(replies[0].nodes[1].message[0]?.file || "", /^base64:\/\//)
  } finally {
    messageArchiveManager.recordMessage = originalRecordMessage
    globalThis.fetch = originalFetch
  }
})
