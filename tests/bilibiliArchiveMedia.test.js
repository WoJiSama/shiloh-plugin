import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "fs"
import path from "path"
import { Readable } from "stream"

test("archive query attaches cover and only downloads video body at or below 30 minutes", async t => {
  globalThis.plugin ||= class {}
  globalThis.Bot ||= { uin: 3094088525, nickname: "希洛" }
  globalThis.logger ||= { info() {}, warn() {}, error() {}, debug() {}, mark() {} }
  globalThis.segment = {
    image: url => ({ type: "image", url }),
    video: file => ({ type: "video", file })
  }

  let MessageRecordPlugin
  const originalCwd = process.cwd()
  const trssRoot = path.resolve(originalCwd, "../..")
  if (fs.existsSync(path.join(trssRoot, "config/default_config"))) process.chdir(trssRoot)
  try {
    ;({ MessageRecordPlugin } = await import("../apps/MessageManager.js"))
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      t.diagnostic(`本机缺少既有运行依赖，完整归档媒体测试留给线上: ${error.message}`)
      return
    }
    throw error
  } finally {
    process.chdir(originalCwd)
  }

  const instance = Object.create(MessageRecordPlugin.prototype)
  instance.archiveManager = { formatRecord: () => "00:00 测试：B站视频" }
  const longResult = await instance.buildArchiveForwardMessages([{
    user_id: 1,
    sender: { nickname: "测试" },
    message: [{
      type: "bilibili",
      title: "长视频",
      bvid: "BV1111111111",
      cid: 1,
      duration: 1801,
      cover_url: "https://image.example/long.jpg"
    }]
  }])

  assert.equal(longResult.tempFiles.length, 0)
  assert.ok(longResult.messages[0].message.some(item => item?.type === "image"))
  assert.ok(longResult.messages[0].message.some(item => typeof item === "string" && item.includes("超过30分钟")))
  assert.ok(!longResult.messages[0].message.some(item => item?.type === "video"))

  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async url => {
      if (String(url).includes("x/player/playurl")) {
        return {
          ok: true,
          async json() {
            return {
              code: 0,
              data: {
                durl: [{
                  url: "https://video.example/short.mp4?token=temp",
                  length: 120000,
                  size: 4
                }]
              }
            }
          }
        }
      }
      return {
        ok: true,
        headers: { get: name => name === "content-length" ? "4" : null },
        body: Readable.toWeb(Readable.from(Buffer.from("test")))
      }
    }
    const shortResult = await instance.buildArchiveForwardMessages([{
      user_id: 1,
      sender: { nickname: "测试" },
      message: [{
        type: "bilibili",
        title: "短视频",
        bvid: "BV1234567890",
        cid: 987,
        duration: 120,
        page_count: 1,
        pages: [{ page: 1, cid: 987, title: "P1", duration: 120 }],
        cover_url: "https://image.example/short.jpg"
      }]
    }])

    assert.equal(shortResult.tempFiles.length, 1)
    assert.ok(fs.existsSync(shortResult.tempFiles[0]))
    assert.ok(shortResult.messages[0].message.some(item => item?.type === "image"))
    assert.ok(shortResult.messages[0].message.some(item => item?.type === "video"))
    await Promise.all(shortResult.tempFiles.map(file => fs.promises.unlink(file).catch(() => {})))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("archive query restores structured forward nodes and keeps old flattened records as text", async t => {
  globalThis.plugin ||= class {}
  globalThis.Bot ||= { uin: 3094088525, nickname: "希洛" }
  globalThis.logger ||= { info() {}, warn() {}, error() {}, debug() {}, mark() {} }
  let MessageRecordPlugin
  try {
    ;({ MessageRecordPlugin } = await import("../apps/MessageManager.js"))
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") return t.skip(error.message)
    throw error
  }

  const instance = Object.create(MessageRecordPlugin.prototype)
  instance.archiveManager = { formatRecord: () => "15:52:46 ()：[合并转发记录]\\n旧摘要" }
  const structured = {
    time: "2026-08-19 15:52:46",
    user_id: 3311464409,
    sender: { nickname: "()" },
    message: [{
      type: "forward_context",
      text: "不会作为查询节点正文",
      forward_nodes: [{
        id: "root",
        nodes: [{
          user_id: "10001",
          nickname: "原发送者",
          time: 1786693966,
          message: [{ type: "text", text: "这是地狱吗" }, { type: "image", url: "https://img.example/original.jpg" }, { type: "forward", id: "nested" }],
          nested_forwards: [{ id: "nested", nodes: [{ user_id: "10002", nickname: "嵌套发送者", message: [{ type: "text", text: "不要打开" }], nested_forwards: [] }] }]
        }]
      }]
    }]
  }
  const restored = await instance.buildArchiveForwardMessages([structured])
  assert.equal(restored.messages.length, 2)
  assert.match(restored.messages[0].message[0], /转发的合并聊天记录/)
  assert.equal(restored.messages[1].nickname, "原发送者")
  assert.deepEqual(restored.messages[1].message[1], { type: "image", url: "https://img.example/original.jpg" })
  assert.deepEqual(restored.messages[1].message[2], { type: "forward", id: "nested" })

  const expired = await instance.buildArchiveForwardMessages([structured], {
    getForwardMsg: async () => { throw new Error("forward expired") }
  })
  assert.equal(expired.messages.length, 3)
  assert.equal(expired.messages[2].nickname, "嵌套发送者")
  assert.deepEqual(expired.messages[2].message, [{ type: "text", text: "不要打开" }])
  assert.ok(!expired.messages[1].message.some(item => item?.type === "forward"))

  const fallback = await instance.buildArchiveForwardMessages([{ user_id: 1, sender: { nickname: "旧记录" }, message: [{ type: "forward_context", text: "旧摘要" }] }])
  assert.equal(fallback.messages.length, 1)
  assert.match(fallback.messages[0].message[0], /旧摘要/)
})
