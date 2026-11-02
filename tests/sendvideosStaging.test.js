import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSendVideos } from '../dist/backend/modules/media/infrastructure/sendvideos.js'

function fixture({ videoUrl = 'https://cdn.example/v.mp4', stageSegment } = {}) {
  const results = [{ success: true, videoUrl }]
  const replies = []
  const logs = []
  const sendvideos = createSendVideos({
    parse: async () => results,
    video: file => ({ type: 'video', data: { file: `file://${file}` } }),
    ...(stageSegment ? { stageSegment } : {}),
    download: async (_url, file) => { await fs.promises.writeFile(file, 'fake-mp4-bytes') },
    log: message => logs.push(message),
  })
  return {
    sendvideos,
    replies,
    logs,
    reply: async segment => { replies.push(segment) },
  }
}

test('配置暂存端口时，视频段先改写为 NapCat 可见路径再发送', async () => {
  const staged = []
  const ctx = fixture({
    stageSegment: async segment => {
      staged.push(segment)
      return { type: 'video', data: { file: 'file:///app/napcat/config/bl-chat-media/123.mp4' } }
    },
  })
  await ctx.sendvideos('看这个 https://www.bilibili.com/video/BV1', ctx)
  assert.equal(ctx.replies.length, 1, '应发送一条')
  assert.ok(String(ctx.replies[0].data.file).includes('/app/napcat/config/bl-chat-media'), '发送的是暂存后的段')
  assert.ok(staged[0].data.file.startsWith(`file://${path.join(os.tmpdir(), 'shiloh-plugin-sendvideos-')}`), '暂存端口收到原始本地路径段')
  assert.equal(ctx.logs.length, 0, '无错误日志')
})

test('未配置暂存端口时保持原有行为（本地路径直发）', async () => {
  const ctx = fixture()
  await ctx.sendvideos('https://www.bilibili.com/video/BV1', ctx)
  assert.equal(ctx.replies.length, 1)
  assert.ok(String(ctx.replies[0].data.file).includes('shiloh-plugin-sendvideos-'))
})

test('暂存抛错时不吞整条消息：按错误路径记录并跳过该视频', async () => {
  const ctx = fixture({ stageSegment: async () => { throw new Error('stage boom') } })
  await ctx.sendvideos('https://www.bilibili.com/video/BV1', ctx)
  assert.equal(ctx.replies.length, 0)
  assert.match(ctx.logs[0] || '', /视频处理失败/)
})
