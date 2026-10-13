import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MessagePipeline } from '../utils/messagePipeline/messagePipeline.js'
import { RedisJobStore } from '../utils/messagePipeline/redisJobStore.js'
import { createFakeRedis } from './helpers/fakeRedis.js'

// The old MessageArchiveRecorder and MessageRecordPlugin.autoRelayArchivedMedia
// were removed. Exercise the current raw-event -> persistent outbox boundary.
for (const duration of [10, 1801]) {
  test(`Bilibili ${duration}s card reaches the current archive and relay pipeline exactly once`, async () => {
    const store = new RedisJobStore({ redis: createFakeRedis() })
    const archived = []
    const queued = []
    const pipeline = new MessagePipeline({
      store,
      recentManager: { async recordMessage() {} },
      archiveManager: {
        shouldRecord: () => true,
        async recordMessage(event) { archived.push(event) }
      },
      mediaOutbox: {
        async enqueue(value) { queued.push(value); return value },
        async recover() { return 0 },
        stop() {}
      },
      logger: { info() {}, warn() {} },
      enrichBilibili: async message => message,
      enrichDouyin: async message => message,
      enrichYoutube: async message => message,
      enrichPixiv: async message => message
    })
    const card = {
      type: 'bilibili', title: '搬运回归', bvid: 'BV1234567890', duration,
      page_url: 'https://www.bilibili.com/video/BV1234567890',
      cover_url: 'https://image.example/cover.jpg'
    }
    const event = {
      post_type: 'message', message_type: 'group', self_id: 3094088525,
      group_id: 609235590, user_id: 925640859, message_id: duration,
      time: 1784517000, raw_message: '搬运回归', message: [card],
      sender: { user_id: 925640859, nickname: 'user' }
    }
    try {
      const id = pipeline.handleRawEvent(event, 'message')
      pipeline.handleRawEvent(event, 'message')
      const deadline = Date.now() + 3000
      while ((await store.get('event', id))?.state !== 'completed' && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert.equal((await store.get('event', id))?.state, 'completed')
      assert.equal(archived.length, 1)
      assert.equal(queued.length, 1)
      assert.equal(queued[0].media.bvid, card.bvid)
      assert.equal(queued[0].media.duration, duration)
      assert.equal(queued[0].media.page_url, card.page_url)
      assert.equal(queued[0].media.cover_url, card.cover_url)
    } finally {
      pipeline.stop()
    }
  })
}
