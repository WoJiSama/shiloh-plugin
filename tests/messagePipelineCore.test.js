import assert from "node:assert/strict"
import { test } from "node:test"
import { createEventEnvelope, envelopeToRuntimeEvent } from "../utils/messagePipeline/eventEnvelope.js"
import { KeyedSerialQueue } from "../utils/messagePipeline/keyedSerialQueue.js"
import { getMissingRedisJobCapabilities, RedisJobStore } from "../utils/messagePipeline/redisJobStore.js"
import { DeliveryError, DeliveryGateway } from "../utils/messagePipeline/deliveryGateway.js"
import { createFakeRedis } from "./helpers/fakeRedis.js"

test("event envelope keeps same content in different groups as distinct events", () => {
  const base = {
    post_type: "message",
    message_type: "group",
    self_id: 3094088525,
    user_id: 925640859,
    message_id: 123,
    time: 1784517000,
    raw_message: "same-card",
    message: [{ type: "text", text: "same-card" }],
    sender: { user_id: 925640859, nickname: "user" }
  }
  const left = createEventEnvelope({ ...base, group_id: 609235590 })
  const right = createEventEnvelope({ ...base, group_id: 953676639 })
  assert.notEqual(left.eventId, right.eventId)
  assert.equal(left.conversationId, "609235590")
  assert.equal(right.conversationId, "953676639")
  assert.equal(envelopeToRuntimeEvent(left).message_type, "group")
})

test("event envelope explicitly reads non-enumerable runtime fields", () => {
  const event = { group_id: 609235590, user_id: 1, message_id: 2, message: [] }
  Object.defineProperty(event, "message_type", { value: "group", enumerable: false })
  Object.defineProperty(event, "self_id", { value: 3094088525, enumerable: false })
  const envelope = createEventEnvelope(event)
  assert.equal(envelope.messageType, "group")
  assert.equal(envelope.botId, "3094088525")
})

test("redis job store creates jobs and claims leases idempotently", async () => {
  const redis = createFakeRedis()
  const store = new RedisJobStore({ redis })
  assert.equal(await store.create("event", "a", { id: "a", state: "pending" }), true)
  assert.equal(await store.create("event", "a", { id: "a", state: "pending" }), false)
  assert.equal((await store.list("event")).length, 1)
  const token = await store.acquireLock("event", "a", 1000)
  assert.ok(token)
  assert.equal(await store.acquireLock("event", "a", 1000), "")
  await store.releaseLock("event", "a", token)
  assert.ok(await store.acquireLock("event", "a", 1000))
})

test("durable runtime capability check rejects silent in-memory degradation", () => {
  assert.deepEqual(getMissingRedisJobCapabilities(null), ["get", "set", "del", "eval", "scan"])
  assert.deepEqual(getMissingRedisJobCapabilities(createFakeRedis()), [])
})

test("stale lock owner cannot release a newer lease", async () => {
  const redis = createFakeRedis()
  const store = new RedisJobStore({ redis })
  const oldToken = await store.acquireLock("event", "lease", 1000)
  const key = store.key("lock:event", "lease")
  await redis.set(key, "new-owner", { XX: true, PX: 1000 })
  assert.equal(await store.releaseLock("event", "lease", oldToken), 0)
  assert.equal(await redis.get(key), "new-owner")
})

test("keyed queue serializes one group while another group proceeds", async () => {
  const queue = new KeyedSerialQueue()
  const order = []
  let release
  const gate = new Promise(resolve => { release = resolve })
  const first = queue.run("group-a", async () => {
    order.push("a1-start")
    await gate
    order.push("a1-end")
  })
  const second = queue.run("group-a", async () => order.push("a2"))
  await queue.run("group-b", async () => order.push("b1"))
  assert.deepEqual(order, ["a1-start", "b1"])
  release()
  await Promise.all([first, second])
  assert.deepEqual(order, ["a1-start", "b1", "a1-end", "a2"])
})

test("delivery gateway resolves a bot after restart and validates retcode", async () => {
  const calls = []
  const bot = { sendApi: async (action, params) => { calls.push({ action, params }); return { retcode: 0, data: { message_id: 88 } } } }
  const gateway = new DeliveryGateway({ botRoot: () => ({ bots: { "3094088525": bot } }) })
  const receipt = await gateway.sendGroupForward({
    botId: "3094088525",
    groupId: "609235590",
    nodes: [{ user_id: 1, nickname: "bot", message: ["ok"] }]
  })
  assert.equal(receipt.messageId, 88)
  assert.equal(calls[0].params.group_id, 609235590)

  const failed = new DeliveryGateway({ botRoot: () => ({ bots: { "1": { sendApi: async () => ({ retcode: 1200, wording: "send failed" }) } } }) })
  await assert.rejects(
    failed.sendGroupForward({ botId: "1", groupId: "2", nodes: [] }),
    error => error instanceof DeliveryError && error.retcode === 1200
  )
})

test("delivery gateway extends the OneBot timeout only while forwarding media", async () => {
  const adapter = { id: "QQ", name: "OneBotv11", timeout: 60_000 }
  let timeoutDuringSend = 0
  const root = {
    adapter: [adapter],
    bots: {
      "1": {
        async sendApi() {
          timeoutDuringSend = adapter.timeout
          return { retcode: 0, data: { message_id: 99 } }
        }
      }
    }
  }
  const gateway = new DeliveryGateway({ botRoot: () => root })
  await gateway.sendGroupForward({ botId: "1", groupId: "2", nodes: [] })
  assert.equal(timeoutDuringSend, 15 * 60 * 1000)
  assert.equal(adapter.timeout, 60_000)
})

test("delivery gateway rejects missing receipts and does not retry uncertain transport errors", async () => {
  const missing = new DeliveryGateway({
    botRoot: () => ({ bots: { "1": { sendApi: async () => undefined } } })
  })
  await assert.rejects(
    missing.sendGroupForward({ botId: "1", groupId: "2", nodes: [] }),
    error => error instanceof DeliveryError && error.uncertain && error.retryable === false
  )

  const transport = new DeliveryGateway({
    botRoot: () => ({ bots: { "1": { sendApi: async () => { throw new Error("connection reset") } } } })
  })
  await assert.rejects(
    transport.sendGroupForward({ botId: "1", groupId: "2", nodes: [] }),
    error => error instanceof DeliveryError && error.uncertain && error.retryable === false
  )
})

test("delivery gateway emits the shared delivery receipt log", async () => {
  const lines = []
  const gateway = new DeliveryGateway({
    botRoot: () => ({ bots: { "1": { sendApi: async () => ({ retcode: 0, data: { message_id: 123 } }) } } }),
    logger: { info: line => lines.push(line), warn: line => lines.push(line) }
  })
  await gateway.sendGroupForward({ botId: "1", groupId: "2", nodes: [{ message: ["ok"] }] })
  assert.ok(lines.some(line => line.includes("[Delivery] status=sent channel=group_forward group=2") && line.includes("message=123")))
})
