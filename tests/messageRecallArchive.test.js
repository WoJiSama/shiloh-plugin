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

function buildMessageEvent({ eventId, messageId, time, text = "hello" }) {
  return {
    event_id: eventId,
    message_type: "group",
    group_id: 609235590,
    user_id: 925640859,
    message_id: messageId,
    time,
    raw_message: text,
    message: [{ type: "text", text }],
    sender: { user_id: 925640859, nickname: "user", card: "user", role: "member" }
  }
}

function buildRecallNoticeEvent({ eventId, messageId, time, operatorId = 925640859 }) {
  return {
    event_id: eventId,
    post_type: "notice",
    message_type: "group",
    notice_type: "group",
    sub_type: "recall",
    group_id: 609235590,
    user_id: 925640859,
    operator_id: operatorId,
    message_id: messageId,
    time
  }
}

test("recall notice marks the original message and stays readable in queries", async t => {
  const loaded = await loadArchiveManager()
  if (!loaded) return t.skip("module not found")
  const { MessageArchiveManager } = loaded
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "message-archive-recall-"))
  createManager(cwd)
  try {
    const manager = new MessageArchiveManager({ cwd, logger: globalThis.logger })
    const day1 = 1784517000 // 2026-07-20 左右
    await manager.recordMessage(buildMessageEvent({ eventId: "event-msg-1", messageId: 501, time: day1 }), {
      preEnrichedMessage: [{ type: "text", text: "hello" }], throwOnError: true
    })
    await manager.recordNotice(buildRecallNoticeEvent({ eventId: "event-recall-1", messageId: 501, time: day1 + 60 }), {
      throwOnError: true
    })

    const file = path.join(cwd, "plugins/shiloh-plugin/data/message_archive/group/609235590/2026-07-20.ndjson")
    const records = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).map(JSON.parse)
    const message = records.find(item => item.event_id === "event-msg-1")
    assert.equal(message.recalled, true)
    assert.equal(message.recalled_by, 925640859)
    assert.ok(message.recalled_at > message.timestamp)

    const queried = await manager.query({ groupId: "609235590", limit: 10 })
    assert.equal(queried.length, 1, "纯撤回通知不应出现在查询结果里")
    assert.equal(queried[0].event_id, "event-msg-1")
    assert.match(manager.formatRecord(queried[0], { compact: true }), /^\[已撤回\] hello/)
    assert.match(manager.formatRecord(queried[0]), /\[已撤回\] hello/)
    assert.match(manager.formatRecord(queried[0]), /撤回于/)
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test("recall across days marks the older file and appends still work afterwards", async t => {
  const loaded = await loadArchiveManager()
  if (!loaded) return t.skip("module not found")
  const { MessageArchiveManager } = loaded
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "message-archive-recall-crossday-"))
  createManager(cwd)
  try {
    const manager = new MessageArchiveManager({ cwd, logger: globalThis.logger })
    const day1 = 1784517000
    const day2 = day1 + 86400 * 3
    await manager.recordMessage(buildMessageEvent({ eventId: "event-msg-old", messageId: 601, time: day1 }), {
      preEnrichedMessage: [{ type: "text", text: "old" }], throwOnError: true
    })
    await manager.recordNotice(buildRecallNoticeEvent({ eventId: "event-recall-old", messageId: 601, time: day2 }), {
      throwOnError: true
    })
    await manager.recordMessage(buildMessageEvent({ eventId: "event-msg-new", messageId: 602, time: day2, text: "new" }), {
      preEnrichedMessage: [{ type: "text", text: "new" }], throwOnError: true
    })

    const groupDir = path.join(cwd, "plugins/shiloh-plugin/data/message_archive/group/609235590")
    const files = fs.readdirSync(groupDir).filter(name => name.endsWith(".ndjson")).sort()
    assert.equal(files.length, 2)
    const day1Records = fs.readFileSync(path.join(groupDir, files[0]), "utf8").trim().split(/\r?\n/).map(JSON.parse)
    assert.equal(day1Records.length, 1)
    assert.equal(day1Records[0].recalled, true)

    const day2Records = fs.readFileSync(path.join(groupDir, files[1]), "utf8").trim().split(/\r?\n/).map(JSON.parse)
    assert.equal(day2Records.length, 2, "通知 + 新消息")
    assert.ok(day2Records.some(item => item.archive_kind === "notice"))
    assert.ok(day2Records.some(item => item.event_id === "event-msg-new"))

    const queried = await manager.query({ groupId: "609235590", limit: 10 })
    assert.deepEqual(queried.map(item => item.event_id), ["event-msg-old", "event-msg-new"])
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test("recall for a message missing from the archive is a no-op and idempotent re-recall is safe", async t => {
  const loaded = await loadArchiveManager()
  if (!loaded) return t.skip("module not found")
  const { MessageArchiveManager } = loaded
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "message-archive-recall-noop-"))
  createManager(cwd)
  try {
    const manager = new MessageArchiveManager({ cwd, logger: globalThis.logger })
    const day1 = 1784517000
    await manager.recordNotice(buildRecallNoticeEvent({ eventId: "event-recall-ghost", messageId: 999, time: day1 }), {
      throwOnError: true
    })
    const file = path.join(cwd, "plugins/shiloh-plugin/data/message_archive/group/609235590/2026-07-20.ndjson")
    let lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/)
    assert.equal(lines.length, 1)

    await manager.recordMessage(buildMessageEvent({ eventId: "event-msg-x", messageId: 700, time: day1 }), {
      preEnrichedMessage: [{ type: "text", text: "x" }], throwOnError: true
    })
    await manager.recordNotice(buildRecallNoticeEvent({ eventId: "event-recall-x1", messageId: 700, time: day1 + 10 }), {
      throwOnError: true
    })
    await manager.recordNotice(buildRecallNoticeEvent({ eventId: "event-recall-x2", messageId: 700, time: day1 + 20 }), {
      throwOnError: true
    })
    lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/)
    const message = lines.map(JSON.parse).find(item => item.event_id === "event-msg-x")
    assert.equal(message.recalled, true)
    assert.equal(message.recalled_at, (day1 + 10) * 1000, "重复撤回不覆盖首次标记")
    assert.equal(lines.length, 4, "ghost通知 + msg + 两条通知，无重复改写")
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})
