import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { collectBotStyleIds, isBotStyleSource } from '../dist/backend/modules/conversation/domain/styleSourceFilter.js'
import { GlobalStyleLearnerManager } from '../domains/memory/GlobalStyleLearnerManager.js'

test('机器人名单合并配置外部 bot 与自家全部账号', () => {
  const ids = collectBotStyleIds(['111', 222, 'bad', ''], { uin: 333, bots: { '444': {}, 'not-id': {} } })
  assert.deepEqual(ids.sort(), ['111', '222', '333', '444'])
  assert.equal(isBotStyleSource(444, ids), true)
  assert.equal(isBotStyleSource('999', ids), false)
  assert.equal(isBotStyleSource(undefined, ids), false)
})

function buildManager() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'style-p2-'))
  const manager = new GlobalStyleLearnerManager({ cwd })
  return { manager, config: { baseDir: path.join(cwd, 'style') }, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) }
}

test('被引用/回复接住的消息进高价值样本池并参与总结', () => {
  const { manager, config, cleanup } = buildManager()
  try {
    // 群友 A 发言（进观察环）
    manager.observeMessage({ msg: '这游戏最近更新后手感好了很多', user_id: '1000', group_id: '100', message_id: 'm1' }, config)
    // 群友 B 引用 A 的消息接话
    manager.observeMessage({ msg: '真的假的，我今晚试试', user_id: '2000', group_id: '100', message_id: 'm2', source: { user_id: '1000', message_id: 'm1' } }, config)
    const memory = manager.readMemory(config)
    assert.equal(memory.goodSamplePool.length, 1, '被接住的样本应入池')
    assert.ok(memory.goodSamplePool[0].text.includes('手感好了很多'))
    // 同一条再被引用不重复入池
    manager.observeMessage({ msg: '同问', user_id: '3000', group_id: '100', message_id: 'm3', source: { user_id: '1000', message_id: 'm1' } }, config)
    assert.equal(manager.readMemory(config).goodSamplePool.length, 1, '按 hash 去重')
    // 总结提示词带上高价值样本
    const cfg = manager.normalizeInputConfig(config)
    const messages = manager.buildSummaryMessages(manager.readMemory(config), cfg, { retry: false })
    assert.ok(JSON.stringify(messages).includes('goodSamples'), '总结消息应包含 goodSamples 字段')
  } finally {
    cleanup()
  }
})

test('高价值样本池随记忆持久化往返', () => {
  const { manager, config, cleanup } = buildManager()
  try {
    manager.observeMessage({ msg: '被接住的经典发言内容', user_id: '1000', group_id: '100', message_id: 'm1' }, config)
    manager.observeMessage({ msg: '接住它', user_id: '2000', group_id: '100', message_id: 'm2', source: { user_id: '1000', message_id: 'm1' } }, config)
    const before = manager.readMemory(config).goodSamplePool
    manager.writeMemory(config)
    // 新实例（模拟 bot 重启）读盘
    const reloaded = new GlobalStyleLearnerManager({ cwd: path.dirname(config.baseDir) }).readMemory(config)
    assert.deepEqual(reloaded.goodSamplePool.map(item => item.text), before.map(item => item.text))
  } finally {
    cleanup()
  }
})

test('buildPrompt 注入实战验证有效的话术', () => {
  const { manager, config, cleanup } = buildManager()
  try {
    const memory = manager.readMemory(config)
    memory.totalSamples = 100
    memory.autoEvolution.candidates = [
      { key: 'k1', sceneKey: 'greeting', scene: '打招呼', replyStyle: 'casual', strategy: '先叫名字再抛具体问题', positive: 9, negative: 1, speakers: ['a', 'b'], status: 'active', createdAt: '', lastSeenAt: '' },
      { key: 'k2', sceneKey: 'joke', scene: '接梗', replyStyle: 'short', strategy: '降权的旧话术', positive: 1, negative: 8, speakers: ['a'], status: 'demoted', createdAt: '', lastSeenAt: '' }
    ]
    manager.writeMemory(config)
    const prompt = manager.buildPrompt(config)
    assert.ok(prompt.includes('实战验证有效（打招呼）：先叫名字再抛具体问题'), prompt)
    assert.ok(!prompt.includes('降权的旧话术'), '被降权的话术不注入')
  } finally {
    cleanup()
  }
})
