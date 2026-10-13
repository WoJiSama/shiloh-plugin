import assert from "node:assert/strict"
import { test } from "node:test"
import { readPipelineJobs } from "../console/lib/pipelineJobs.js"
import { parseRedisReply, encodeRedisCommand } from "../console/lib/redisClient.js"

test("Redis nested SCAN replies and UTF8 commands parse without length errors", () => {
  const response = Buffer.from("*2\r\n$1\r\n0\r\n*2\r\n$1\r\na\r\n$1\r\nb\r\n")
  assert.deepEqual(parseRedisReply(response), { used: response.length, value: ["0", ["a", "b"]] })
  assert.equal(parseRedisReply(response.subarray(0, response.length - 1)), null)
  const command = encodeRedisCommand(["GET", "中文"])
  assert.match(command.toString(), /\$6\r\n中文/)
  assert.deepEqual(parseRedisReply(command).value, ["GET", "中文"])
})

test("task query filters, sorts retained records, and never treats durable state as current worker status", async () => {
  const records = {
    "ytbot:message_pipeline:event:e": JSON.stringify({ id: "e", state: "completed", updatedAt: 5, envelope: { botId: "1", groupId: "2", rawMessage: "should-not-return" } }),
    "ytbot:message_pipeline:delivery:d": JSON.stringify({ id: "d", state: "failed", updatedAt: 10, groupId: "2", platform: "youtube", lastError: "failed", media: { cookieHeader: "should-not-return" } }),
    "ytbot:message_pipeline:lock:event:e": "lock-token",
    "ytbot:message_pipeline:event:expired": null,
    "ytbot:message_pipeline:event:corrupt": "invalid-json"
  }
  const redis = { cmd: async (command, key) => command === "SCAN" ? ["0", Object.keys(records)] : records[key] }
  const view = await readPipelineJobs(redis, { limit: 1 }, { messagePipeline: { eventTtlMinutes: 60, deliveryTtlHours: 12 } })
  assert.equal(view.jobs.length, 1)
  assert.equal(view.jobs[0].id, "d")
  assert.equal(view.matchedInScan, 2)
  assert.equal(view.skippedRecords, 1)
  assert.equal(view.runtimeConfirmed, false)
  assert.equal(view.jobs[0].runtimeConfirmed, false)
  assert.deepEqual(view.retention, { eventMinutes: 60, deliveryHours: 12 })
  assert.equal(JSON.stringify(view).includes("should-not-return"), false)
  const failed = await readPipelineJobs(redis, { status: "failed" }, {})
  assert.equal(failed.jobs.length, 1)
  for (const query of [{ kind: "lock" }, { status: "active" }, { limit: 0 }, { limit: 201 }, { limit: 1.5 }]) await assert.rejects(readPipelineJobs(redis, query), { status: 400 })
})

test("bounded task scans expose truncation instead of claiming complete totals", async () => {
  const redis = { cmd: async command => command === "SCAN" ? ["5", ["ytbot:message_pipeline:event:e"]] : JSON.stringify({ id: "e", state: "processing" }) }
  const view = await readPipelineJobs(redis, {}, {}, { maxScans: 1 })
  assert.equal(view.scanTruncated, true)
  assert.equal(view.jobs[0].state, "processing")
  assert.equal(view.runtimeConfirmed, false)
})
