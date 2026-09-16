// tests/memory/boundary.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyBoundary } from '../../domains/memory/engine/boundary.js'

test('tool/system feedback -> drop', () => {
  assert.equal(classifyBoundary('[tool_result] 调用结果: ok').verdict, 'drop')
  assert.equal(classifyBoundary('系统反馈信息：工具已全部执行完成').verdict, 'drop')
})

test('pure interjections / too short -> drop', () => {
  assert.equal(classifyBoundary('哈哈哈').verdict, 'drop')
  assert.equal(classifyBoundary('ok').verdict, 'drop')
  assert.equal(classifyBoundary(' 嗯 ').verdict, 'drop')
})

test('substantive message -> candidate', () => {
  assert.equal(classifyBoundary('记住，maela 是 @3188163302').verdict, 'candidate')
  assert.equal(classifyBoundary('我叫咖啡大人').verdict, 'candidate')
})

test('empty -> drop with reason', () => {
  const r = classifyBoundary('')
  assert.equal(r.verdict, 'drop')
  assert.equal(typeof r.reason, 'string')
})
