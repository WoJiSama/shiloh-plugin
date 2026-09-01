import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { sendCompleteLocalFile } from "../utils/messagePipeline/deliveryGateway.js"

test("complete music files use OneBot group-file upload with intact downloadable bytes", async () => {
  const filePath = path.join(os.tmpdir(), `music-upload-${Date.now()}.mp3`)
  await fs.writeFile(filePath, Buffer.from("complete-mp3"))
  const calls = []
  try {
    const result = await sendCompleteLocalFile({
      group_id: 9527,
      bot: {
        async sendApi(action, payload) {
          calls.push({ action, payload })
          return { status: "ok", retcode: 0, data: { file_id: "music-file" } }
        }
      }
    }, filePath, { fileName: "测试音乐.mp3", maxBytes: 1024 })

    assert.equal(result.channel, "upload_group_file")
    assert.equal(calls.length, 1)
    assert.equal(calls[0].action, "upload_group_file")
    assert.equal(calls[0].payload.group_id, 9527)
    assert.equal(calls[0].payload.name, "测试音乐.mp3")
    assert.match(calls[0].payload.file, /^base64:\/\//)
    assert.equal(
      Buffer.from(calls[0].payload.file.slice("base64://".length), "base64").toString(),
      "complete-mp3"
    )
  } finally {
    await fs.unlink(filePath).catch(() => {})
  }
})

test("complete music file delivery falls back to the adapter file API", async () => {
  const filePath = path.join(os.tmpdir(), `music-upload-fallback-${Date.now()}.mp3`)
  await fs.writeFile(filePath, Buffer.from("fallback-mp3"))
  const sent = []
  try {
    const result = await sendCompleteLocalFile({
      group_id: 9527,
      bot: { sendApi: async () => ({ status: "failed", wording: "group API unavailable" }) },
      group: {
        async sendFile(file, name) {
          sent.push({ file, name })
          return { retcode: 0 }
        }
      }
    }, filePath, { fileName: "后备音乐.mp3" })

    assert.equal(result.channel, "sendFile")
    assert.deepEqual(sent, [{ file: pathToFileUrl(filePath), name: "后备音乐.mp3" }])
  } finally {
    await fs.unlink(filePath).catch(() => {})
  }
})

test("music delivery never treats a rejected file upload as success", async () => {
  const filePath = path.join(os.tmpdir(), `music-upload-failed-${Date.now()}.mp3`)
  await fs.writeFile(filePath, Buffer.from("failed-mp3"))
  try {
    await assert.rejects(
      sendCompleteLocalFile({
        group_id: 9527,
        bot: { sendApi: async () => ({ retcode: 1200, wording: "upload rejected" }) },
        group: { sendFile: async () => ({ status: "failed", wording: "fallback rejected" }) }
      }, filePath, { fileName: "失败音乐.mp3" }),
      /upload rejected.*fallback rejected/
    )
  } finally {
    await fs.unlink(filePath).catch(() => {})
  }
})

test("music share sends a real file before its merged metadata and playable record", async t => {
  globalThis.plugin ||= class {}
  globalThis.logger ||= { info() {}, warn() {}, error() {}, debug() {}, mark() {} }
  globalThis.Bot ||= { uin: 3094088525, nickname: "希洛" }
  globalThis.segment = { record: file => ({ type: "record", data: { file } }) }

  let MessageRecordPlugin
  try {
    ;({ MessageRecordPlugin } = await import("../apps/MessageManager.js"))
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      t.diagnostic(`本机缺少既有 TRSS 运行依赖，音乐完整交付集成测试留给线上: ${error.message}`)
      return
    }
    throw error
  }

  const originalFetch = globalThis.fetch
  const order = []
  const replies = []
  const forwardNodes = []
  let uploadedFilePath = ""
  try {
    globalThis.fetch = async () => new Response(Buffer.from("generated-music"), {
      status: 200,
      headers: { "content-type": "audio/mpeg", "content-length": "15" }
    })
    const e = {
      group_id: 9527,
      user_id: 10001,
      self_id: 3094088525,
      bot: {
        async sendApi(action, payload) {
          order.push(action)
          assert.equal(action, "upload_group_file")
          assert.equal(Buffer.from(payload.file.slice("base64://".length), "base64").toString(), "generated-music")
          return { status: "ok", retcode: 0 }
        }
      },
      group: {
        async makeForwardMsg(nodes) {
          order.push("makeForwardMsg")
          forwardNodes.push(...nodes)
          return { type: "forward", data: { id: "music-forward" } }
        }
      },
      async reply(message) {
        order.push(message?.type === "record" ? "record" : "reply")
        if (message?.type === "record") uploadedFilePath = message.data.file
        replies.push(message)
        return { retcode: 0 }
      }
    }

    const instance = Object.create(MessageRecordPlugin.prototype)
    await instance.sendMusicShare(e, {
      title: "测试歌曲",
      artist: "测试歌手",
      sourceUrl: "https://music.163.com/song/media/outer/url?id=1"
    })

    assert.equal(order[0], "upload_group_file")
    assert.equal(order[1], "makeForwardMsg")
    assert.ok(replies.some(item => item?.type === "forward"))
    assert.ok(replies.some(item => item?.type === "record"))
    assert.equal(forwardNodes.length, 1)
    assert.match(forwardNodes[0].message, /可下载文件：测试歌曲-测试歌手-.+\.mp3/)
    assert.equal(JSON.stringify(forwardNodes).includes('"type":"file"'), false)
  } finally {
    globalThis.fetch = originalFetch
    if (uploadedFilePath) await fs.unlink(uploadedFilePath).catch(() => {})
  }
})

test("automatic music relay stays silent when the source has no audio", async t => {
  globalThis.plugin ||= class {}
  globalThis.logger ||= { info() {}, warn() {}, error() {}, debug() {}, mark() {} }
  globalThis.Bot ||= { uin: 3094088525, nickname: "希洛" }

  let MessageRecordPlugin
  try {
    ;({ MessageRecordPlugin } = await import("../apps/MessageManager.js"))
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      t.diagnostic(`本机缺少既有 TRSS 运行依赖，音乐完整交付集成测试留给线上: ${error.message}`)
      return
    }
    throw error
  }

  const originalFetch = globalThis.fetch
  const replies = []
  try {
    globalThis.fetch = async () => new Response("not audio", {
      status: 200,
      headers: { "content-type": "text/html" }
    })
    const e = {
      group_id: 9527,
      user_id: 10001,
      self_id: 3094088525,
      async reply(message) { replies.push(message) }
    }

    const instance = Object.create(MessageRecordPlugin.prototype)
    await instance.sendMusicShare(e, {
      title: "不可播放歌曲",
      artist: "测试歌手",
      sourceUrl: "https://music.163.com/song/media/outer/url?id=1"
    }, { notifyFailure: false })

    assert.deepEqual(replies, [])
  } finally {
    globalThis.fetch = originalFetch
  }
})

function pathToFileUrl(filePath) {
  return new URL(`file://${filePath}`).href
}
