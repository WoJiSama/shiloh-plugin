import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { test } from "node:test"
import { MessagePipeline } from "../utils/messagePipeline/messagePipeline.js"
import { RedisJobStore } from "../utils/messagePipeline/redisJobStore.js"
import { createEventEnvelope } from "../utils/messagePipeline/eventEnvelope.js"
import { createFakeRedis } from "./helpers/fakeRedis.js"

function rawEvent(groupId, messageId) {
  const event = {
    post_type: "message",
    group_id: groupId,
    user_id: 925640859,
    message_id: messageId,
    time: 1784517000,
    raw_message: "same-card",
    message: [{ type: "bilibili", title: "same-card", duration: 1801 }],
    sender: { user_id: 925640859, nickname: "user" }
  }
  Object.defineProperty(event, "message_type", { value: "group", enumerable: false })
  Object.defineProperty(event, "self_id", { value: 3094088525, enumerable: false })
  return event
}

function buildPipeline({ redis = createFakeRedis(), delayMs = 0, enrichBilibili, enrichYoutube, enrichPixiv, emojiCollector, resolveForwardContext } = {}) {
  const recent = []
  const archive = []
  const deliveries = []
  const store = new RedisJobStore({ redis })
  const mediaOutbox = {
    async enqueue(value) { deliveries.push(value); return value },
    async recover() { return 0 },
    stop() {}
  }
  const pipeline = new MessagePipeline({
    store,
    recentManager: { async recordMessage(event) { recent.push(event) } },
    archiveManager: {
      shouldRecord() { return true },
      shouldRecordNotice() { return true },
      async recordMessage(event) { archive.push(event) },
      async recordNotice(event) { archive.push(event) }
    },
    mediaOutbox,
    emojiCollector,
    logger: { info() {}, warn() {} },
    enrichBilibili: enrichBilibili || (async message => {
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs))
      return message
    }),
    enrichDouyin: async message => message,
    enrichYoutube: enrichYoutube || (async message => message),
    enrichPixiv: enrichPixiv || (async message => message),
    resolveForwardContext
  })
  return { pipeline, store, recent, archive, deliveries, redis }
}

test("raw listener captures identical cross-group events before business throttling", async () => {
  const { pipeline, store, recent, archive, deliveries } = buildPipeline({ delayMs: 40 })
  const bot = new EventEmitter()
  pipeline.start(bot)
  bot.emit("message", rawEvent(609235590, 201))
  bot.emit("message", rawEvent(953676639, 202))
  await new Promise(resolve => setTimeout(resolve, 100))

  const jobs = await store.list("event")
  assert.equal(jobs.length, 2)
  assert.ok(jobs.every(job => job.state === "completed"))
  assert.deepEqual(recent.map(item => String(item.group_id)).sort(), ["609235590", "953676639"])
  assert.equal(archive.length, 2)
  assert.equal(deliveries.length, 2)
  pipeline.stop()
})

test("duplicate raw delivery of one event runs consumers once", async () => {
  const { pipeline, store, recent, deliveries } = buildPipeline()
  const event = rawEvent(609235590, 203)
  const envelopeId = pipeline.handleRawEvent(event, "message")
  pipeline.handleRawEvent(event, "message")
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal((await store.get("event", envelopeId)).state, "completed")
  assert.equal(recent.length, 1)
  assert.equal(deliveries.length, 1)
  pipeline.stop()
})

test("media enqueue is not blocked by metadata enrichment", async () => {
  const { pipeline, recent, deliveries } = buildPipeline({ delayMs: 80 })
  pipeline.handleRawEvent(rawEvent(609235590, 205), "message")
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(deliveries.length, 1)
  assert.equal(recent.length, 0)
  await new Promise(resolve => setTimeout(resolve, 90))
  assert.equal(recent.length, 1)
  pipeline.stop()
})

test("raw CQ JSON is detected even when the normalized message array is empty", async () => {
  const { pipeline, deliveries } = buildPipeline()
  const event = rawEvent(609235590, 208)
  event.message = []
  event.raw_message = `[CQ:json,data=${JSON.stringify({
    prompt: "[QQ小程序]哔哩哔哩",
    meta: { detail_1: { desc: "raw card", qqdocurl: "https://b23.tv/JvNsiRF" } }
  })}]`
  pipeline.handleRawEvent(event, "message")
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(deliveries.length, 1)
  assert.equal(deliveries[0].media.type, "bilibili")
  pipeline.stop()
})

test("plain b23.tv links enter the Bilibili media pipeline", async () => {
  const { pipeline, deliveries } = buildPipeline()
  const event = rawEvent(609235590, 209)
  event.raw_message = "https://b23.tv/SqfuVXT"
  event.message = [{ type: "text", text: event.raw_message }]
  pipeline.handleRawEvent(event, "message")
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(deliveries.length, 1)
  assert.equal(deliveries[0].media.type, "bilibili")
  assert.equal(deliveries[0].media.short_url, "https://b23.tv/SqfuVXT")
  pipeline.stop()
})

test("plain YouTube and Pixiv links enter the same raw media pipeline", async () => {
  const { pipeline, deliveries } = buildPipeline()
  const youtube = rawEvent(609235590, 211)
  youtube.raw_message = "https://youtu.be/AbC_123-xYz"
  youtube.message = [{ type: "text", text: youtube.raw_message }]
  const pixiv = rawEvent(609235590, 212)
  pixiv.raw_message = "https://www.pixiv.net/artworks/12345678"
  pixiv.message = [{ type: "text", text: pixiv.raw_message }]
  pipeline.handleRawEvent(youtube, "message")
  pipeline.handleRawEvent(pixiv, "message")
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.deepEqual(deliveries.map(item => item.media.type).sort(), ["pixiv", "youtube"])
  pipeline.stop()
})

test("metadata enrichment failure preserves raw storage consumers", async () => {
  const { pipeline, store, recent, archive } = buildPipeline({
    enrichBilibili: async () => { throw new Error("metadata unavailable") }
  })
  const id = pipeline.handleRawEvent(rawEvent(609235590, 206), "message")
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal((await store.get("event", id)).state, "completed")
  assert.equal(recent.length, 1)
  assert.equal(archive.length, 1)
  assert.equal(recent[0].message[0].title, "same-card")
  pipeline.stop()
})

test("pipeline expands forward-only events into durable conversation context", async () => {
  const { pipeline, store, recent, archive } = buildPipeline({
    resolveForwardContext: async envelope => {
      assert.equal(envelope.groupId, "609235590")
      return {
        forwardIds: ["forward-1"],
        text: "解释机器人: 先说结论，再用例子拆开。",
        media: [{ type: "image", label: "合并转发中的第1张图片", source: "https://img.example/forward.jpg" }],
        forwardNodes: [{
          id: "forward-1",
          nodes: [{ user_id: "10001", nickname: "解释机器人", message: [{ type: "text", text: "先说结论" }], nested_forwards: [] }]
        }]
      }
    }
  })
  const event = rawEvent(609235590, 210)
  event.raw_message = "[CQ:forward,id=forward-1]"
  event.message = [{ type: "forward", id: "forward-1" }]
  const id = pipeline.handleRawEvent(event, "message")
  await new Promise(resolve => setTimeout(resolve, 30))

  const job = await store.get("event", id)
  assert.equal(job.state, "completed")
  assert.equal(job.envelope.forwardContext.text, "解释机器人: 先说结论，再用例子拆开。")
  assert.equal(recent[0].forward_context.forwardIds[0], "forward-1")
  assert.deepEqual(recent[0].message.at(-1), {
    type: "forward_context",
    text: "解释机器人: 先说结论，再用例子拆开。",
    forward_ids: ["forward-1"],
    media: [{ type: "image", label: "合并转发中的第1张图片", source: "https://img.example/forward.jpg" }],
    forward_nodes: [{
      id: "forward-1",
      nodes: [{ user_id: "10001", nickname: "解释机器人", message: [{ type: "text", text: "先说结论" }], nested_forwards: [] }]
    }]
  })
  assert.equal(archive[0].message.at(-1).type, "forward_context")
  pipeline.stop()
})

test("pipeline retries a forward context until the OneBot group becomes available", async () => {
  let calls = 0
  const { pipeline, store } = buildPipeline({
    resolveForwardContext: async () => {
      calls++
      if (calls === 1) {
        const error = new Error("OneBot forward context is not ready: OneBot returned no forward nodes")
        error.code = "forward_context_unavailable"
        throw error
      }
      return { forwardIds: ["forward-ready"], text: "展开完成", media: [] }
    }
  })
  pipeline.retryBaseMs = 1
  const event = rawEvent(609235590, 211)
  event.raw_message = "[CQ:forward,id=forward-ready]"
  event.message = [{ type: "forward", id: "forward-ready" }]
  const id = pipeline.handleRawEvent(event, "message")
  await new Promise(resolve => setTimeout(resolve, 80))
  const job = await store.get("event", id)
  assert.equal(calls, 2)
  assert.equal(job.state, "completed")
  assert.equal(job.envelope.forwardContext.text, "展开完成")
  pipeline.stop()
})

test("emoji auto-collection cannot hold the core event job open", async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  let started = false
  const { pipeline, store } = buildPipeline({
    emojiCollector: {
      async maybeAutoCollect() {
        started = true
        await gate
      }
    }
  })
  const event = rawEvent(609235590, 207)
  event.raw_message = "[image]"
  event.message = [{ type: "image", url: "https://example.test/emoji.png" }]
  const id = pipeline.handleRawEvent(event, "message")
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(started, true)
  assert.equal((await store.get("event", id)).state, "completed")
  release()
  pipeline.stop()
})

test("pipeline waits for a live lease and recovers only after it expires", async () => {
  const first = buildPipeline()
  const envelope = createEventEnvelope(rawEvent(609235590, 204), "message")
  const id = envelope.eventId
  const job = first.pipeline.createJob(envelope)
  job.state = "processing"
  job.ownerRunId = "old-process"
  job.leaseUntil = Date.now() + 600000
  await first.store.create("event", id, job)
  await first.store.acquireLock("event", id, 600000)

  const recovered = buildPipeline({ redis: first.redis })
  assert.equal(await recovered.pipeline.recover(), 1)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal((await recovered.store.get("event", id)).state, "processing")

  const expired = await recovered.store.get("event", id)
  expired.leaseUntil = Date.now() - 1000
  await recovered.store.save("event", id, expired)
  await recovered.store.clearLock("event", id)
  assert.equal(await recovered.pipeline.recover(), 1)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal((await recovered.store.get("event", id)).state, "completed")
  recovered.pipeline.stop()
})
