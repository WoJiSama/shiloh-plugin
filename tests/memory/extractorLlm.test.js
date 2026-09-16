// tests/memory/extractorLlm.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryExtractor } from '../../domains/memory/engine/extractor.js'

test('extract returns [] when memory AI not configured', async () => {
  const ex = new MemoryExtractor({ memoryAiConfig: null })
  const ops = await ex.extract({ groupId: 'g', speakerQQ: '1', messages: [{ content: '我叫A' }], at: 1 })
  assert.deepEqual(ops, [])
})

test('extract parses fenced JSON array from chat response', async () => {
  const ex = new MemoryExtractor({ memoryAiConfig: { memoryAiUrl: 'u', memoryAiApikey: 'k' } })
  ex._callChat = async () => '```json\n[{"route":"self_statement","alias":"咖啡大人","confidence":0.9}]\n```'
  const ops = await ex.extract({ groupId: 'g', speakerQQ: '925640859', messages: [{ content: '以后叫我咖啡大人' }], at: 5 })
  assert.equal(ops.length, 1)
  assert.equal(ops[0].stream, 'alias')
  assert.equal(ops[0].qq, '925640859')
})

test('malformed chat response -> []', async () => {
  const ex = new MemoryExtractor({ memoryAiConfig: { memoryAiUrl: 'u', memoryAiApikey: 'k' } })
  ex._callChat = async () => 'sorry I cannot'
  const ops = await ex.extract({ groupId: 'g', speakerQQ: '1', messages: [{ content: 'x' }], at: 1 })
  assert.deepEqual(ops, [])
})
