import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GlobalStyleLearnerManager } from '../domains/memory/GlobalStyleLearnerManager.js'

test('learns same-speaker multi-message and emoji placement as one sequence sample', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'style-sequence-'))
  const originalBot = globalThis.Bot
  globalThis.Bot = { uin: '999' }
  const manager = new GlobalStyleLearnerManager({ cwd, logger: { warn() {}, info() {} } })
  const config = { baseDir: 'data/style', flushIntervalMs: 5000, sequenceWindowMs: 20000 }
  try {
    manager.observeMessage({ group_id: 1, user_id: 2, message_id: 10, msg: '笑死，这也能撞上', message: [{ type: 'text', text: '笑死，这也能撞上' }] }, config)
    manager.observeMessage({ group_id: 1, user_id: 2, message_id: 11, msg: '', message: [{ type: 'image', sub_type: 1, summary: '[动画表情]' }] }, config)
    manager.observeMessage({ group_id: 1, user_id: 2, message_id: 12, msg: '不过他确实挺累的', message: [{ type: 'text', text: '不过他确实挺累的' }] }, config)

    const memory = manager.readMemory(config)
    assert.equal(memory.totalSequenceSamples, 2)
    assert.equal(memory.featureCount.multi_message_sequence, 2)
    assert.equal(memory.featureCount.emoji_interleave_sequence, 2)
    assert.ok(memory.essence.multi_message_rhythm >= 2)
    const sequenceSample = memory.samplePool.find(item => item.sequence && /不过/.test(item.text))
    assert.match(sequenceSample?.text || '', /笑死.*\[下一条\].*\[表情包\].*\[下一条\].*不过/)
  } finally {
    manager.flushTimer && clearTimeout(manager.flushTimer)
    globalThis.Bot = originalBot
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('does not combine messages from different speakers', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'style-sequence-'))
  const manager = new GlobalStyleLearnerManager({ cwd, logger: { warn() {}, info() {} } })
  const config = { baseDir: 'data/style', flushIntervalMs: 5000 }
  try {
    manager.observeMessage({ group_id: 1, user_id: 2, message_id: 1, msg: '第一句' }, config)
    manager.observeMessage({ group_id: 1, user_id: 3, message_id: 2, msg: '第二句' }, config)
    assert.equal(Number(manager.readMemory(config).totalSequenceSamples) || 0, 0)
  } finally {
    manager.flushTimer && clearTimeout(manager.flushTimer)
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('speaker interruption breaks the previous speaker sequence', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'style-sequence-'))
  const manager = new GlobalStyleLearnerManager({ cwd, logger: { warn() {}, info() {} } })
  const config = { baseDir: 'data/style', flushIntervalMs: 5000 }
  try {
    manager.observeMessage({ group_id: 1, user_id: 2, message_id: 1, msg: '甲的第一句' }, config)
    manager.observeMessage({ group_id: 1, user_id: 3, message_id: 2, msg: '乙插了一句' }, config)
    manager.observeMessage({ group_id: 1, user_id: 2, message_id: 3, msg: '甲后来又说' }, config)
    assert.equal(Number(manager.readMemory(config).totalSequenceSamples) || 0, 0)
  } finally {
    manager.flushTimer && clearTimeout(manager.flushTimer)
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})
