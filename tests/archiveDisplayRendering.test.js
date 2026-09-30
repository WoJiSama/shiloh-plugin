import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

async function loadArchiveManager() {
  globalThis.logger ||= { info() {}, warn() {}, error() {}, debug() {} }
  try {
    return await import("../utils/MessageArchiveManager.js")
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") return null
    throw error
  }
}

function createManager(cwd) {
  const configDir = path.join(cwd, "plugins/shiloh-plugin/config_default")
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, "message.yaml"), [
    "pluginSettings:",
    "  messageArchive:",
    "    enabled: true",
    "    baseDir: data/message_archive",
    "    retentionDays: 3650"
  ].join("\n"))
}

const NAMES = { "925640859": "喝咖啡吗", "3906061530": "水水水水" }
const ctx = {
  resolveName: qq => NAMES[String(qq)] || String(qq),
  replyPreview: () => null,
  skipTypes: ["image", "bilibili"]
}

test("at 段用名字渲染,无上下文时保持 QQ 号", async t => {
  const loaded = await loadArchiveManager()
  if (!loaded) return t.skip("module not found")
  const { messageArchiveManager: mgr } = loaded
  const record = { message: [{ type: "text", text: " " }, { type: "at", qq: "3906061530" }, { type: "text", text: " 可以送我一杯奶茶喝嘛" }] }
  assert.equal(mgr.formatRecord(record, { compact: true, context: ctx }), "@水水水水 可以送我一杯奶茶喝嘛")
  assert.equal(mgr.formatRecord(record, { compact: true }), "@3906061530 可以送我一杯奶茶喝嘛")
})

test("回复段渲染为引用预览,查不到时带上下文则省略前缀", async t => {
  const loaded = await loadArchiveManager()
  if (!loaded) return t.skip("module not found")
  const { messageArchiveManager: mgr } = loaded
  const withPreview = { ...ctx, replyPreview: id => id === "872963841"
    ? { name: "喝咖啡吗", text: "member可还行" } : null }
  const record = { message: [{ type: "reply", id: "872963841" }, { type: "text", text: "这么高" }] }
  assert.equal(mgr.formatRecord(record, { compact: true, context: withPreview }), "[回复 喝咖啡吗：member可还行]这么高")
  assert.equal(mgr.formatRecord(record, { compact: true, context: ctx }), "这么高")
  assert.equal(mgr.formatRecord(record, { compact: true }), "[回复:872963841]这么高")
})

test("已携带真实媒体的段在文本中省略占位,无上下文时保留占位", async t => {
  const loaded = await loadArchiveManager()
  if (!loaded) return t.skip("module not found")
  const { messageArchiveManager: mgr } = loaded
  const record = { message: [{ type: "text", text: "看这个" }, { type: "image", summary: "动画表情" }] }
  assert.equal(mgr.formatRecord(record, { compact: true, context: ctx }), "看这个")
  assert.equal(mgr.formatRecord(record, { compact: true }), "看这个[图片:动画表情]")
  const imageOnly = { message: [{ type: "image", summary: "动画表情" }] }
  assert.equal(mgr.formatRecord(imageOnly, { compact: true, context: ctx }), "")
  assert.equal(mgr.formatRecord(imageOnly, { compact: true }), "[图片:动画表情]")
})

test("QQ 表情渲染为官方名字,未收录 id 用通用占位", async t => {
  const loaded = await loadArchiveManager()
  if (!loaded) return t.skip("module not found")
  const { messageArchiveManager: mgr } = loaded
  const record = { message: [{ type: "text", text: "绷" }, { type: "face", id: "14" }, { type: "face", id: "277" }] }
  assert.equal(mgr.formatRecord(record, { compact: true }), "绷[微笑][表情]")
})

test("通知按字段重新人话化,不再是 JSON 或裸操作符", async t => {
  const loaded = await loadArchiveManager()
  if (!loaded) return t.skip("module not found")
  const { messageArchiveManager: mgr } = loaded
  const base = { archive_kind: "notice", user_id: 925640859, operator_id: 925640859, target_id: 3906061530 }
  assert.equal(mgr.formatNoticeDisplay({ ...base, notice_type: "group.poke" }, ctx), "喝咖啡吗 戳了戳 水水水水")
  assert.equal(mgr.formatNoticeDisplay({ ...base, notice_type: "group.poke", target_id: null }, ctx), "喝咖啡吗 发起了戳一戳")
  assert.equal(
    mgr.formatNoticeDisplay({ ...base, notice_type: "group.ban", operator_id: 3906061530 }, ctx),
    "管理员 水水水水 禁言了 喝咖啡吗"
  )
  assert.equal(mgr.formatNoticeDisplay({ ...base, notice_type: "group.increase", operator_id: null }, ctx), "喝咖啡吗 加入了群聊")
  assert.equal(mgr.formatNoticeDisplay({ ...base, notice_type: "group.upload" }, ctx), "喝咖啡吗 上传了文件")
  assert.equal(
    mgr.formatNoticeDisplay({ ...base, notice_type: "group.decrease", operator_id: 3906061530 }, ctx),
    "喝咖啡吗 被管理员 水水水水 移出了群聊"
  )
  assert.equal(mgr.formatNoticeDisplay({ ...base, notice_type: "group.essence" }, ctx), "喝咖啡吗 设置了精华消息")
})

test("消息表情回应通知从查询结果中隐藏", async t => {
  const loaded = await loadArchiveManager()
  if (!loaded) return t.skip("module not found")
  const { MessageArchiveManager } = loaded
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "archive-display-emoji-"))
  createManager(cwd)
  try {
    const mgr = new MessageArchiveManager({ cwd, logger: globalThis.logger })
    await mgr.recordNotice({
      event_id: "event-like", post_type: "notice", message_type: "group",
      notice_type: "group", sub_type: "msg_emoji_like",
      group_id: 609235590, user_id: 925640859, operator_id: 925640859,
      message_id: 1, time: 1784517000
    }, { throwOnError: true })
    await mgr.recordMessage({
      event_id: "event-after", message_type: "group", group_id: 609235590,
      user_id: 925640859, message_id: 2, time: 1784517001,
      raw_message: "正文", message: [{ type: "text", text: "正文" }],
      sender: { user_id: 925640859, nickname: "user", card: "user" }
    }, { preEnrichedMessage: [{ type: "text", text: "正文" }], throwOnError: true })
    const queried = await mgr.query({ groupId: "609235590", limit: 10 })
    assert.deepEqual(queried.map(item => item.event_id), ["event-after"])
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test("findMessagePreviews 按 message_id 反查原消息生成引用预览", async t => {
  const loaded = await loadArchiveManager()
  if (!loaded) return t.skip("module not found")
  const { MessageArchiveManager } = loaded
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "archive-display-preview-"))
  createManager(cwd)
  try {
    const mgr = new MessageArchiveManager({ cwd, logger: globalThis.logger })
    await mgr.recordMessage({
      event_id: "event-origin", message_type: "group", group_id: 609235590,
      user_id: 3906061530, message_id: 872963841, time: 1784517000,
      raw_message: "member可还行", message: [{ type: "text", text: "member可还行" }],
      sender: { user_id: 3906061530, nickname: "水水水水", card: "水水水水" }
    }, { preEnrichedMessage: [{ type: "text", text: "member可还行" }], throwOnError: true })
    const previews = await mgr.findMessagePreviews("609235590", ["872963841", "404"])
    assert.equal(previews.size, 1)
    assert.equal(previews.get("872963841").name, "水水水水")
    assert.equal(previews.get("872963841").text, "member可还行")
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test("视频与结构化消息用中性占位,不再透出长 URL 或英文类型名", async t => {
  const loaded = await loadArchiveManager()
  if (!loaded) return t.skip("module not found")
  const { messageArchiveManager: mgr } = loaded
  const record = {
    message: [
      { type: "video", file: "x.mp4", url: "https://multimedia.nt.qq.com.cn/download?appid=1415&format=origin" },
      { type: "json" },
      { type: "markdown" },
      { type: "forward", id: "7690088204187145424" }
    ]
  }
  assert.equal(mgr.formatRecord(record, { compact: true }), "[视频][卡片消息][卡片消息][聊天记录]")
})

test("raw_message 兜底路径同样应用名字解析与表情名", async t => {
  const loaded = await loadArchiveManager()
  if (!loaded) return t.skip("module not found")
  const { messageArchiveManager: mgr } = loaded
  const record = { message: [], raw_message: "[CQ:at,qq=3906061530] 看看[CQ:face,id=79][CQ:reply,id=123]补一句" }
  assert.equal(
    mgr.formatRecord(record, { compact: true, context: ctx }),
    "@水水水水 看看[强]补一句"
  )
})

test("CQ 图片码含实体括号的 summary 不再漏出 file/url 尾巴", async t => {
  const loaded = await loadArchiveManager()
  if (!loaded) return t.skip("module not found")
  const { messageArchiveManager: mgr } = loaded
  const raw = "[CQ:image,summary=&#91;动画表情&#93;,file=B2E36CB4.jpg,sub_type=1,url=https://multimedia.nt.qq.com.cn/download?appid=1407&amp;fileid=AbC&amp;rkey=XYZ,file_size=645489]"
  assert.equal(mgr.formatRecord({ message: [], raw_message: raw }, { compact: true, context: ctx }), "")
  assert.equal(mgr.formatRecord({ message: [], raw_message: raw }, { compact: true }), "[图片:动画表情]")
})
