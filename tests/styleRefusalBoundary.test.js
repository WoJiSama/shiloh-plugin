import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GlobalStyleLearnerManager } from '../domains/memory/GlobalStyleLearnerManager.js'

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'style-refusal-'))
  const manager = new GlobalStyleLearnerManager({ cwd })
  const config = { baseDir: path.join(cwd, 'style'), autoSummaryEnabled: false, semanticRecallEnabled: false }
  t.after(() => { if (manager.flushTimer) clearTimeout(manager.flushTimer); fs.rmSync(cwd, { recursive: true, force: true }) })
  return { manager, config }
}

test('a plain refusal is not automatically a negative expression pattern', t => {
  const { manager, config } = fixture(t)
  for (const [index, msg] of ['我不能保证明天一定有空。', '我无法替你决定，这件事我不想参与。', '不能满足这个要求，今天先聊到这里。'].entries()) {
    manager.observeMessage({ msg, user_id: String(80000 + index), group_id: '10086', message_id: String(index) }, config)
  }
  const memory = manager.readMemory(config)
  assert.equal(memory.dross.hard_refusal || 0, 0)
  assert.equal(memory.recentSignals.some(item => item.dross.includes('hard_refusal')), false)
  assert.equal(manager.getEssenceRules(memory).some(item => /再给替代方向/u.test(item.rule)), false)
  assert.match(manager.getEssenceRules(memory).map(item => item.rule).join('\n'), /可以简短拒绝或保留不同意见/u)
})

test('old refusal counters cannot inject an anti-refusal rule, while insults are still filtered', t => {
  const { manager, config } = fixture(t)
  const memory = manager.readMemory(config)
  memory.dross.hard_refusal = 100
  memory.samplePool.push({ text: '我不能替你付款。', dross: ['hard_refusal'], essence: [] })
  assert.equal(manager.getDrossRules(memory).some(item => item.key === 'hard_refusal'), false)
  assert.doesNotMatch(JSON.stringify(manager.buildSummaryMessages(memory, { summarySampleLimit: 40, maxAiRules: 6 })), /hard_refusal/u)
  manager.observeMessage({ msg: '你这个废物，滚开', user_id: '80000', group_id: '10086', message_id: 'insult' }, config)
  assert.equal(memory.dross.aggressive_attack, 1)
  assert.equal(manager.getDrossRules(memory).some(item => item.key === 'aggressive_attack'), true)
})
