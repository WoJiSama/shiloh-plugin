import { test } from 'node:test'
import assert from 'node:assert/strict'
import { GroupModerationManager, getSegmentText } from '../../src/modules/groupAdmin/infrastructure/GroupModerationManager.js'
import { AdCorpusStore } from '../../src/modules/groupAdmin/infrastructure/adCorpusStore.js'
import { normalizeGroupModerationConfig } from '../../src/modules/groupAdmin/domain/groupModerationRules.js'
import type { AdminEvent, AdminPorts, ModerationConfig } from '../../src/contracts/groupAdmin.js'

// 真实现场的纯视频消息：rkey URL 231 字符，整条 CQ 码 397 字符。
// 修复前超长判定把它整条当可见文本计数，群阈值调低时视频消息会被误撤回
const VIDEO_CQ =
  '[CQ:video,file=8a376bb6414a2a77bb0b5c66ecaf29d2.mp4,url=https://multimedia.nt.qq.com.cn/download?appid=1415&format=origin&orgfmt=t264&spec=0&rkey=CAMSqAGmgtos7rOgmriiewyYLxTSBwA8ik3tkVt7MNsczc6gjYmkYkvYOmL1iR4PLz9zADUzRjY8OTg2tnCcIpO--v1Vb5TWj_B4F1SjEvBam5komI1OohQxCMdbzMn7ckpE52-zgUH6vPQg81Sfm6JAtdbMboez2Z1K4Zm0_oJ_nxy-g8L0yERsjoUTgtXZLDeqjz9Rro0nlZOYX7jDzWl0t4itHxOJSvq-cDY,file_size=14508903]'

const ports: AdminPorts = { readSettings: () => ({}), getBot: () => undefined }

function manager() {
  return new GroupModerationManager(ports, new AdCorpusStore({ maxEntries: 1 }))
}

function overlongConfig(maxLength: number): ModerationConfig {
  return normalizeGroupModerationConfig({ overlongMessage: { enabled: true, maxLength, maxLines: 0, forwardEnabled: true } })
}

test('video/record/file 段渲染为占位符而不是空串', () => {
  assert.equal(getSegmentText({ type: 'video', data: { url: `https://x/rkey=${'y'.repeat(300)}` } }), '[视频]')
  assert.equal(getSegmentText({ type: 'record', data: {} }), '[语音]')
  assert.equal(getSegmentText({ type: 'file', data: {} }), '[文件]')
})

test('段数组纯视频消息的可见文本是 [视频] 占位符', () => {
  const e: AdminEvent = { message: [{ type: 'video', data: { file: 'a.mp4', url: `https://x/${'k'.repeat(300)}` } }] }
  assert.equal(manager().extractVisibleText(e), '[视频]')
  assert.equal(manager().extractVisibleTextRaw(e), '[视频]')
})

test('raw_message 兜底剥掉 CQ 码：纯视频不再被当成 397 字文本', () => {
  const e: AdminEvent = { raw_message: VIDEO_CQ }
  assert.equal(manager().extractVisibleText(e), '')
  // raw 版本按设计不 trim（行数判定用原文），剥码后只剩替换留下的空白
  assert.equal(manager().extractVisibleTextRaw(e).trim(), '')
})

test('无段数组时文字+视频混排只保留用户可见文字', () => {
  const e: AdminEvent = { raw_message: `看这个${VIDEO_CQ}` }
  assert.equal(manager().extractVisibleText(e), '看这个')
})

test('超长判定端到端：纯视频不再误触，真实长文本仍命中', () => {
  const m = manager()
  const config = overlongConfig(100)

  const videoOnly: AdminEvent = { raw_message: VIDEO_CQ }
  const videoVisible = m.extractVisibleText(videoOnly)
  assert.equal(m.checkOverlongMessage(videoVisible, config, m.extractVisibleTextRaw(videoOnly)), null)

  const longText: AdminEvent = { raw_message: '长'.repeat(150) }
  assert.ok(m.checkOverlongMessage(m.extractVisibleText(longText), config, m.extractVisibleTextRaw(longText)))
})

test('纯换行刷屏仍按原文行数触发超长（回归保护）', () => {
  const config = normalizeGroupModerationConfig({ overlongMessage: { enabled: true, maxLength: 1500, maxLines: 20, forwardEnabled: true } })
  const e: AdminEvent = { raw_message: '\n'.repeat(30) }
  assert.ok(manager().checkOverlongMessage(manager().extractVisibleText(e), config, manager().extractVisibleTextRaw(e)))
})
