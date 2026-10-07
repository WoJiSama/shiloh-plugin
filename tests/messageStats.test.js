import { test } from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { fileURLToPath } from "node:url"

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

class FakeRedis {
  constructor() {
    this.data = new Map()
    this.expires = []
    this.failMode = false
  }
  async hincrby(key, field, n) {
    if (this.failMode) throw new Error("redis down")
    const hash = this.data.get(key) || {}
    hash[field] = (hash[field] || 0) + n
    this.data.set(key, hash)
  }
  async expire(key, ttl) {
    this.expires.push([key, ttl])
  }
  async hgetall(key) {
    return { ...(this.data.get(key) || {}) }
  }
}

test("recordReceive 写入天桶与小时桶,含群维度", async () => {
  const { MessageStatsEmitter, statsDayKey } = await import("../utils/messageStats.js")
  const redis = new FakeRedis()
  const stats = new MessageStatsEmitter({ redis, logger: null })
  await stats.recordReceive({ postType: "message", botId: "3094088525", groupId: "1079789636", userId: "123" })
  await stats.recordReceive({ postType: "message", botId: "3094088525", groupId: "1079789636", userId: "456" })

  const day = redis.data.get(statsDayKey())
  assert.equal(day["recv:3094088525"], 2)
  assert.equal(day["recv:3094088525:g:1079789636"], 2)
  const hourKeys = [...redis.data.keys()].filter(key => key.startsWith("shiloh:stats:h:"))
  assert.equal(hourKeys.length, 1)
  assert.equal(redis.data.get(hourKeys[0])["recv:3094088525"], 2)
  assert.ok(redis.expires.some(([key, ttl]) => key === statsDayKey() && ttl >= 90 * 86400), "天桶需要设置 TTL")
})

test("非 message 事件与 bot 自身消息不计收信", async () => {
  const { MessageStatsEmitter, statsDayKey } = await import("../utils/messageStats.js")
  const redis = new FakeRedis()
  const stats = new MessageStatsEmitter({ redis, logger: null })
  await stats.recordReceive({ postType: "notice", botId: "1", groupId: "2", userId: "3" })
  await stats.recordReceive({ postType: "message", botId: "1", groupId: "2", userId: "1" })
  const day = redis.data.get(statsDayKey())
  assert.equal(day, undefined)
})

test("recordSend / recordFailure 字段正确", async () => {
  const { MessageStatsEmitter, statsDayKey } = await import("../utils/messageStats.js")
  const redis = new FakeRedis()
  const stats = new MessageStatsEmitter({ redis, logger: null })
  await stats.recordSend({ botId: "A", groupId: "111", channel: "chat" })
  await stats.recordSend({ botId: "A", channel: "private" })
  await stats.recordFailure({ botId: "A", groupId: "111", channel: "media_forward", code: "retcode:1006514" })

  const day = redis.data.get(statsDayKey())
  assert.equal(day["send:A"], 2)
  assert.equal(day["send:A:ch:chat"], 1)
  assert.equal(day["send:A:ch:private"], 1)
  assert.equal(day["send:A:g:111"], 1)
  assert.equal(day["fail:A"], 1)
  assert.equal(day["fail:A:retcode:1006514"], 1)
})

test("enabled=false 时不产生任何写入", async () => {
  const { MessageStatsEmitter } = await import("../utils/messageStats.js")
  const redis = new FakeRedis()
  const stats = new MessageStatsEmitter({ redis, enabled: false })
  await stats.recordSend({ botId: "A", channel: "chat" })
  assert.equal(redis.data.size, 0)
  assert.equal(redis.expires.length, 0)
})

test("redis 故障时 fail-open 不抛异常", async () => {
  const { MessageStatsEmitter } = await import("../utils/messageStats.js")
  const redis = new FakeRedis()
  redis.failMode = true
  const stats = new MessageStatsEmitter({ redis, logger: null })
  await assert.doesNotReject(() => stats.recordSend({ botId: "A", channel: "chat" }))
})

test("readDailyStats 按号聚合群/通道/失败码", async () => {
  const { readDailyStats } = await import("../utils/messageStats.js")
  const redis = new FakeRedis()
  const key = "shiloh:stats:d:20261007"
  const seed = {
    "recv:A": 10,
    "recv:A:g:111": 6,
    "recv:A:g:222": 4,
    "send:A": 3,
    "send:A:ch:chat": 2,
    "send:A:ch:media_forward": 1,
    "send:A:g:111": 2,
    "fail:A": 2,
    "fail:A:retcode:1006514": 2,
    "recv:B": 5
  }
  redis.data.set(key, seed)
  const summary = await readDailyStats(redis, { day: "20261007" })
  assert.equal(summary.day, "20261007")
  assert.equal(summary.bots.A.recv, 10)
  assert.equal(summary.bots.A.send, 3)
  assert.equal(summary.bots.A.fail, 2)
  assert.equal(summary.bots.A.failCodes["retcode:1006514"], 2)
  assert.equal(summary.bots.A.groups["111"].recv, 6)
  assert.equal(summary.bots.A.groups["111"].send, 2)
  assert.equal(summary.bots.A.channels.chat, 2)
  assert.equal(summary.bots.B.recv, 5)
})

test("createStatsEmitterFromSettings 读取 message.yaml stats 段", async () => {
  const { createStatsEmitterFromSettings, MessageStatsEmitter } = await import("../utils/messageStats.js")
  const stats = createStatsEmitterFromSettings({ redis: new FakeRedis(), settings: { stats: { enabled: true, retentionDays: 30 } } })
  assert.ok(stats instanceof MessageStatsEmitter)
  assert.equal(stats.retentionDays, 30)
  const disabled = createStatsEmitterFromSettings({ redis: new FakeRedis(), settings: { stats: { enabled: false } } })
  assert.equal(disabled.enabled, false)
})
