import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { MediaOutbox } from "../utils/messagePipeline/mediaOutbox.js"
import { MediaArtifactStore } from "../utils/messagePipeline/mediaArtifactStore.js"
import { RedisJobStore } from "../utils/messagePipeline/redisJobStore.js"
import { createFakeRedis } from "./helpers/fakeRedis.js"

function envelope(groupId, messageId) {
  return {
    eventId: `event:${groupId}:${messageId}`,
    botId: "3094088525",
    groupId: String(groupId),
    messageId: String(messageId)
  }
}

function longBilibiliCard() {
  return {
    type: "bilibili",
    title: "same video",
    bvid: "BV1234567890",
    duration: 1801,
    page_url: "https://www.bilibili.com/video/BV1234567890",
    cover_url: "https://image.example/cover.jpg"
  }
}

const mediaDependencies = {
  enrichBilibili: async card => card,
  enrichDouyin: async card => card,
  buildBilibili: async (card, { segmentApi }) => ({
    segments: ["\n（视频超过30分钟，未附带视频本体）", segmentApi.image(card.cover_url)],
    tempFiles: []
  }),
  buildDouyin: async () => ({ segments: [], tempFiles: [] })
}

test("same media in two groups creates and sends two independent delivery jobs", async () => {
  const store = new RedisJobStore({ redis: createFakeRedis() })
  const sent = []
  const outbox = new MediaOutbox({
    store,
    ...mediaDependencies,
    gateway: { sendGroupForward: async args => { sent.push(args); return { retcode: 0, messageId: sent.length } } },
    logger: { info() {}, warn() {} }
  })
  outbox.stopped = true
  const left = await outbox.enqueue({ envelope: envelope(609235590, 11), media: longBilibiliCard() })
  const right = await outbox.enqueue({ envelope: envelope(953676639, 12), media: longBilibiliCard() })
  await Promise.all([outbox.process(left.id), outbox.process(right.id)])

  assert.deepEqual(sent.map(item => String(item.groupId)).sort(), ["609235590", "953676639"])
  assert.equal((await store.get("delivery", left.id)).state, "sent")
  assert.equal((await store.get("delivery", right.id)).state, "sent")
})

test("simultaneous deliveries share metadata refresh and persist stage timings", async () => {
  const store = new RedisJobStore({ redis: createFakeRedis() })
  let refreshes = 0
  const sent = []
  const outbox = new MediaOutbox({
    store,
    enrichBilibili: async card => {
      refreshes += 1
      await new Promise(resolve => setTimeout(resolve, 10))
      return card
    },
    enrichDouyin: async card => card,
    buildBilibili: async () => ({ segments: [], tempFiles: [], artifactLeases: [] }),
    buildDouyin: async () => ({ segments: [], tempFiles: [], artifactLeases: [] }),
    gateway: { sendGroupForward: async args => { sent.push(args); return { retcode: 0, messageId: sent.length } } },
    logger: { info() {}, warn() {} }
  })
  outbox.stopped = true
  const left = await outbox.enqueue({ envelope: envelope(609235590, 21), media: longBilibiliCard() })
  const right = await outbox.enqueue({ envelope: envelope(953676639, 22), media: longBilibiliCard() })
  await Promise.all([outbox.process(left.id), outbox.process(right.id)])

  assert.equal(refreshes, 1)
  assert.equal(sent.length, 2)
  for (const id of [left.id, right.id]) {
    const job = await store.get("delivery", id)
    assert.equal(job.state, "sent")
    assert.ok(job.timings.refresh >= 9)
    assert.ok(job.timings.total >= job.timings.send)
  }
})

test("same video in different groups waits for one shared download before both send", async () => {
  const store = new RedisJobStore({ redis: createFakeRedis() })
  const artifactStore = new MediaArtifactStore({ ttlMs: 0, maxEncodedBytes: 1024 })
  const sent = []
  let downloads = 0
  let startDownload
  let finishDownload
  const downloadStarted = new Promise(resolve => { startDownload = resolve })
  const downloadFinished = new Promise(resolve => { finishDownload = resolve })
  const outbox = new MediaOutbox({
    store,
    artifactStore,
    prepareConcurrency: 2,
    enrichBilibili: async card => card,
    enrichDouyin: async card => card,
    buildBilibili: async (card, { artifactStore: sharedStore, segmentApi }) => {
      const lease = await sharedStore.acquire(`bilibili:${card.bvid}:1:qn6`, async () => {
        downloads += 1
        startDownload()
        await downloadFinished
        const filePath = path.join(os.tmpdir(), `shared-video-${Date.now()}.mp4`)
        await fs.promises.writeFile(filePath, "shared video")
        return filePath
      })
      return { segments: [segmentApi.video(lease.filePath)], tempFiles: [], artifactLeases: [lease] }
    },
    buildDouyin: async () => ({ segments: [], tempFiles: [], artifactLeases: [] }),
    gateway: { sendGroupForward: async args => { sent.push(args); return { retcode: 0, messageId: sent.length } } },
    logger: { info() {}, warn() {} }
  })

  await outbox.enqueue({ envelope: envelope(609235590, 41), media: { ...longBilibiliCard(), bvid: "BVSHAREDQUEUE" } })
  await outbox.enqueue({ envelope: envelope(953676639, 42), media: { ...longBilibiliCard(), bvid: "BVSHAREDQUEUE" } })
  await downloadStarted
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(downloads, 1)
  assert.equal(sent.length, 0)

  finishDownload()
  for (let index = 0; index < 50 && sent.length < 2; index += 1) await new Promise(resolve => setTimeout(resolve, 10))
  assert.deepEqual(sent.map(item => String(item.groupId)).sort(), ["609235590", "953676639"])
  assert.equal(downloads, 1)
  outbox.stop()
})

test("YouTube uses the shared platform adapter and reuses one media artifact across groups", async () => {
  const store = new RedisJobStore({ redis: createFakeRedis() })
  const artifactStore = new MediaArtifactStore({ ttlMs: 0, maxEncodedBytes: 1024 })
  const sent = []
  let downloads = 0
  const outbox = new MediaOutbox({
    store,
    artifactStore,
    enrichYoutube: async card => ({ ...card, metadata_status: "resolved" }),
    buildYoutube: async (card, { artifactStore: sharedStore, segmentApi }) => {
      const lease = await sharedStore.acquire(`youtube:${card.video_id}:lowest-mp4`, async () => {
        downloads++
        const filePath = path.join(os.tmpdir(), `youtube-shared-${Date.now()}.mp4`)
        await fs.promises.writeFile(filePath, "video")
        return filePath
      })
      return { segments: [segmentApi.video(lease.filePath)], artifactLeases: [lease], tempFiles: [] }
    },
    gateway: { sendGroupForward: async args => { sent.push(args); return { retcode: 0, messageId: sent.length } } },
    logger: { info() {}, warn() {} }
  })
  outbox.stopped = true
  const media = { type: "youtube", video_id: "shared-youtube", title: "same", duration: 10, page_url: "https://www.youtube.com/watch?v=shared-youtube" }
  const left = await outbox.enqueue({ envelope: envelope(609235590, 51), media })
  const right = await outbox.enqueue({ envelope: envelope(953676639, 52), media })
  await Promise.all([outbox.process(left.id), outbox.process(right.id)])
  assert.equal(downloads, 1)
  assert.deepEqual(sent.map(item => String(item.groupId)).sort(), ["609235590", "953676639"])
  assert.match(sent[0].nodes[0].message[0], /^YouTube视频搬一下：分享了《same》/)
})

test("same-group later media prepares while the prior delivery is still sending", async () => {
  const store = new RedisJobStore({ redis: createFakeRedis() })
  const prepared = []
  const sent = []
  let releaseFirstSend
  let signalFirstSend
  const firstSendStarted = new Promise(resolve => { signalFirstSend = resolve })
  const outbox = new MediaOutbox({
    store,
    prepareConcurrency: 2,
    enrichBilibili: async card => card,
    enrichDouyin: async card => card,
    buildBilibili: async card => {
      prepared.push(card.bvid)
      await new Promise(resolve => setTimeout(resolve, 10))
      return { segments: [], tempFiles: [], artifactLeases: [] }
    },
    buildDouyin: async () => ({ segments: [], tempFiles: [], artifactLeases: [] }),
    gateway: {
      async sendGroupForward(args) {
        sent.push(args)
        if (sent.length === 1) {
          signalFirstSend()
          await new Promise(resolve => { releaseFirstSend = resolve })
        }
        return { retcode: 0, messageId: sent.length }
      }
    },
    logger: { info() {}, warn() {} }
  })
  const first = await outbox.enqueue({ envelope: envelope(609235590, 31), media: { ...longBilibiliCard(), bvid: "BVFIRST" } })
  const second = await outbox.enqueue({ envelope: envelope(609235590, 32), media: { ...longBilibiliCard(), bvid: "BVSECOND" } })

  await firstSendStarted
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.deepEqual(prepared.sort(), ["BVFIRST", "BVSECOND"])
  assert.equal(sent.length, 1)
  releaseFirstSend()
  for (let index = 0; index < 20 && sent.length < 2; index++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(sent.length, 2)
  assert.equal((await store.get("delivery", first.id)).state, "sent")
  assert.equal((await store.get("delivery", second.id)).state, "sent")
  outbox.stop()
})

test("delivery job retries from persisted state without duplicating a successful job", async () => {
  const store = new RedisJobStore({ redis: createFakeRedis() })
  let fail = true
  let sends = 0
  const outbox = new MediaOutbox({
    store,
    ...mediaDependencies,
    retryBaseMs: 100,
    gateway: {
      sendGroupForward: async () => {
        sends++
        if (fail) throw Object.assign(new Error("temporary"), { retryable: true })
        return { retcode: 0, messageId: 9 }
      }
    },
    logger: { info() {}, warn() {} }
  })
  outbox.stopped = true
  const job = await outbox.enqueue({ envelope: envelope(609235590, 13), media: longBilibiliCard() })
  await outbox.process(job.id)
  const waiting = await store.get("delivery", job.id)
  assert.equal(waiting.state, "retry_wait")
  assert.equal(waiting.attempts, 1)

  fail = false
  waiting.nextRetryAt = 0
  await store.save("delivery", job.id, waiting)
  await outbox.process(job.id)
  const sent = await store.get("delivery", job.id)
  assert.equal(sent.state, "sent")
  assert.equal(sent.attempts, 2)
  await outbox.process(job.id)
  assert.equal(sends, 2)
})

test("uncertain delivery failure is retained without automatic retry", async () => {
  const store = new RedisJobStore({ redis: createFakeRedis() })
  let sends = 0
  const outbox = new MediaOutbox({
    store,
    ...mediaDependencies,
    gateway: {
      async sendGroupForward() {
        sends++
        throw Object.assign(new Error("response lost"), { retryable: false, uncertain: true })
      }
    },
    logger: { info() {}, warn() {} }
  })
  outbox.stopped = true
  const job = await outbox.enqueue({ envelope: envelope(609235590, 15), media: longBilibiliCard() })
  await outbox.process(job.id)
  const failed = await store.get("delivery", job.id)
  assert.equal(failed.state, "failed")
  assert.equal(failed.uncertain, true)
  assert.equal(failed.nextRetryAt, 0)
  assert.equal(sends, 1)
})

test("media assembly failure still sends a visible information node", async () => {
  const store = new RedisJobStore({ redis: createFakeRedis() })
  let sent
  const outbox = new MediaOutbox({
    store,
    enrichBilibili: async card => card,
    enrichDouyin: async card => card,
    buildBilibili: async () => { throw new Error("download unavailable") },
    buildDouyin: async () => ({ segments: [], tempFiles: [] }),
    gateway: { sendGroupForward: async value => { sent = value; return { retcode: 0, messageId: 16 } } },
    logger: { info() {}, warn() {} }
  })
  outbox.stopped = true
  const job = await outbox.enqueue({ envelope: envelope(609235590, 16), media: longBilibiliCard() })
  await outbox.process(job.id)
  assert.equal((await store.get("delivery", job.id)).state, "sent")
  const text = sent.nodes[0].message.filter(item => typeof item === "string").join("")
  assert.match(text, /same video/)
  assert.match(text, /资源暂时获取失败/)
})

test("outbox waits for a live lease and recovers only after it expires", async () => {
  const store = new RedisJobStore({ redis: createFakeRedis() })
  const job = {
    version: 1,
    id: "bilibili:609235590:14",
    eventId: "event:14",
    platform: "bilibili",
    botId: "3094088525",
    groupId: "609235590",
    messageId: "14",
    media: longBilibiliCard(),
    state: "processing",
    attempts: 1,
    ownerRunId: "old-process",
    leaseUntil: Date.now() + 600000
  }
  await store.create("delivery", job.id, job)
  await store.acquireLock("delivery", job.id, 600000)

  const outbox = new MediaOutbox({
    store,
    ...mediaDependencies,
    gateway: { sendGroupForward: async () => ({ retcode: 0, messageId: 10 }) },
    logger: { info() {}, warn() {} }
  })
  assert.equal(await outbox.recover(), 1)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal((await store.get("delivery", job.id)).state, "processing")

  const expired = await store.get("delivery", job.id)
  expired.leaseUntil = Date.now() - 1000
  await store.save("delivery", job.id, expired)
  await store.clearLock("delivery", job.id)
  assert.equal(await outbox.recover(), 1)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal((await store.get("delivery", job.id)).state, "sent")
  outbox.stop()
})
