import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

test("recent message storage is idempotent under concurrent retries", async t => {
  globalThis.logger ||= { info() {}, warn() {}, error() {}, debug() {} }
  let MessageManager
  try {
    ;({ MessageManager } = await import("../utils/MessageManager.js"))
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") return t.skip(error.message)
    throw error
  }
  const previousRedis = globalThis.redis
  const previousBot = globalThis.Bot
  const data = new Map()
  globalThis.redis = {
    async get(key) { return data.get(key) || null },
    async set(key, value) { data.set(key, value); return "OK" },
    async del(key) { data.delete(key) }
  }
  globalThis.Bot = { uin: 3094088525, nickname: "希洛" }
  try {
    const manager = new MessageManager({ cacheExpireSeconds: 3600 })
    const event = {
      event_id: "event-1",
      message_type: "group",
      group_id: 609235590,
      user_id: 925640859,
      message_id: 100,
      time: 1784517000,
      raw_message: "hello",
      message: [{ type: "text", text: "hello" }],
      sender: { user_id: 925640859, nickname: "user", role: "member" }
    }
    await Promise.all([
      manager.recordMessage(event, { preEnrichedMessage: event.message, throwOnError: true }),
      manager.recordMessage(event, { preEnrichedMessage: event.message, throwOnError: true })
    ])
    const redisKey = "ytbot:messages:group:609235590"
    assert.equal(JSON.parse(data.get(redisKey)).length, 1)

    const newer = { ...event, event_id: "event-newer", message_id: 102, time: event.time + 1, raw_message: "newer", message: [{ type: "text", text: "newer" }] }
    await manager.recordMessage(newer, { preEnrichedMessage: newer.message, throwOnError: true })
    await manager.recordMessage(event, { preEnrichedMessage: event.message, throwOnError: true })
    assert.deepEqual(JSON.parse(data.get(redisKey)).map(item => item.event_id), ["event-newer", "event-1"])

    const beforeReadFailure = data.get(redisKey)
    globalThis.redis.get = async () => { throw new Error("redis unavailable") }
    await assert.rejects(
      manager.recordMessage({ ...newer, event_id: "event-failed", message_id: 103 }, {
        preEnrichedMessage: newer.message,
        throwOnError: true
      }),
      /redis unavailable/
    )
    assert.equal(data.get(redisKey), beforeReadFailure)

    const fileText = await manager.formatMessageContent({
      message_type: "group",
      message: [{ type: "file", name: "sheet.xlsx", url: "https://files.example/sheet.xlsx" }]
    })
    assert.match(fileText, /https:\/\/files\.example\/sheet\.xlsx/)
  } finally {
    globalThis.redis = previousRedis
    globalThis.Bot = previousBot
  }
})

test("NDJSON archive appends one line for the same durable event", async t => {
  globalThis.logger ||= { info() {}, warn() {}, error() {}, debug() {} }
  let MessageArchiveManager
  const originalReadFile = fs.promises.readFile
  let archiveReadCount = 0
  fs.promises.readFile = async (file, ...args) => {
    if (String(file).endsWith(".ndjson")) archiveReadCount++
    return await originalReadFile.call(fs.promises, file, ...args)
  }
  try {
    ;({ MessageArchiveManager } = await import("../utils/MessageArchiveManager.js"))
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") return t.skip(error.message)
    throw error
  }
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "message-archive-idempotence-"))
  const configDir = path.join(cwd, "plugins/shiloh-plugin/config_default")
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, "message.yaml"), [
    "pluginSettings:",
    "  messageArchive:",
    "    enabled: true",
    "    includePrivate: false",
    "    baseDir: data/message_archive",
    // 事件时间戳是固定旧日期(2026-07-20);保留期必须覆盖它,
    // 否则写后异步触发的 cleanupExpired 会把"刚写的过期文件"删掉,读断言变成竞态
    "    retentionDays: 3650"
  ].join("\n"))
  try {
    const manager = new MessageArchiveManager({ cwd, logger: globalThis.logger })
    const event = {
      event_id: "event-2",
      message_type: "group",
      group_id: 609235590,
      user_id: 925640859,
      message_id: 101,
      time: 1784517000,
      raw_message: "hello",
      message: [{ type: "text", text: "hello" }],
      sender: { user_id: 925640859, nickname: "user", role: "member" }
    }
    await Promise.all([
      manager.recordMessage(event, { preEnrichedMessage: event.message, throwOnError: true }),
      manager.recordMessage(event, { preEnrichedMessage: event.message, throwOnError: true })
    ])
    await manager.recordMessage({ ...event, event_id: "event-3", message_id: 102 }, {
      preEnrichedMessage: event.message,
      throwOnError: true
    })
    const file = path.join(cwd, "plugins/shiloh-plugin/data/message_archive/group/609235590/2026-07-20.ndjson")
    const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/)
    assert.equal(lines.length, 2)
    assert.equal(archiveReadCount, 1)
  } finally {
    fs.promises.readFile = originalReadFile
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})
