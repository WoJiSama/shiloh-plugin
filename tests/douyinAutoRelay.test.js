import assert from "node:assert/strict"
import { Readable } from "stream"
import { test } from "node:test"

test("a short Douyin share is relayed as one merged forward message", async t => {
  globalThis.plugin ||= class {}
  globalThis.Bot ||= { uin: 3094088525, nickname: "希洛" }
  globalThis.logger ||= { info() {}, warn() {}, error() {}, debug() {}, mark() {} }
  globalThis.segment = {
    image: url => ({ type: "image", url }),
    video: file => ({ type: "video", file })
  }
  let MessageArchiveRecorder
  let messageArchiveManager
  try {
    ;({ MessageArchiveRecorder } = await import("../apps/MessageArchiveRecorder.js"))
    ;({ messageArchiveManager } = await import("../utils/MessageArchiveManager.js"))
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      t.diagnostic(`本机缺少既有运行依赖，抖音自动搬运集成测试留给线上: ${error.message}`)
      return
    }
    throw error
  }

  const originalRecordMessage = messageArchiveManager.recordMessage
  const originalFetch = globalThis.fetch
  try {
    const runtimeDouyin = {
      type: "douyin", title: "测试抖音", author: "测试作者", aweme_id: "7661206883327471737", duration: 16,
      page_url: "https://www.iesdouyin.com/share/video/7661206883327471737/",
      cover_url: "https://cover.example/cover.webp", play_url: "https://video.example/play",
      stats: { digg_count: 1 }
    }
    messageArchiveManager.recordMessage = async () => ({
      user_id: 925640859,
      // 持久归档没有临时播放 URL；实时字段仍必须保留供本体下载。
      message: [{ ...runtimeDouyin, play_url: undefined }],
      runtimeMessage: [runtimeDouyin]
    })
    globalThis.fetch = async () => ({
      ok: true,
      headers: { get: name => name === "content-length" ? "4" : null },
      body: Readable.toWeb(Readable.from(Buffer.from("mp4!")))
    })
    const replies = []
    const apiCalls = []
    await Object.create(MessageArchiveRecorder.prototype).recordArchiveMessage({
      group_id: 609235590,
      user_id: 925640859,
      message_id: 1,
      bot: { sendApi: async (action, params) => apiCalls.push({ action, params }) },
      group: { makeForwardMsg: async nodes => ({ type: "forward", nodes }) },
      reply: async message => replies.push(message)
    })
    assert.equal(replies.length, 0)
    assert.equal(apiCalls.length, 1)
    assert.equal(apiCalls[0].action, "send_group_forward_msg")
    assert.equal(apiCalls[0].params.group_id, 609235590)
    assert.equal(apiCalls[0].params.messages.length, 2)
    assert.match(apiCalls[0].params.messages[0].data.content[0].data.text, /抖音视频搬一下/)
    assert.match(apiCalls[0].params.messages[1].data.content[0].data.file || "", /^base64:\/\//)
  } finally {
    messageArchiveManager.recordMessage = originalRecordMessage
    globalThis.fetch = originalFetch
  }
})
