import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  generateMathQuestion,
  normalizeQuestionMaxNumber,
  normalizeQuestionOperators
} from '../domains/group-admin/groupGuardQuestion.js'

function sequenceRandom(values) {
  let index = 0
  return () => values[index++ % values.length]
}

test('normalizes question max number into safe bounds', () => {
  assert.equal(normalizeQuestionMaxNumber(undefined), 10)
  assert.equal(normalizeQuestionMaxNumber(0), 1)
  assert.equal(normalizeQuestionMaxNumber(8.9), 8)
  assert.equal(normalizeQuestionMaxNumber(999), 100)
})

test('normalizes question operators from aliases', () => {
  assert.deepEqual(normalizeQuestionOperators(['+', '减法', 'bad']), ['add', 'sub'])
  assert.deepEqual(normalizeQuestionOperators('add'), ['add'])
  assert.deepEqual(normalizeQuestionOperators([]), ['add', 'sub'])
})

test('generates addition question within configured range', () => {
  const question = generateMathQuestion(
    { questionMaxNumber: 10, questionOperators: ['add'] },
    sequenceRandom([0, 0.7, 0.5])
  )

  assert.equal(question.operator, 'add')
  assert.match(question.question, /^\d+ \+ \d+ = \?$/)
  const [a, b] = question.question.match(/\d+/g).map(Number)
  assert.ok(a + b <= 10)
  assert.equal(question.answer, String(a + b))
})

test('generates subtraction question with non-negative answer', () => {
  const question = generateMathQuestion(
    { questionMaxNumber: 10, questionOperators: ['sub'] },
    sequenceRandom([0, 0.7, 0.5])
  )

  assert.equal(question.operator, 'sub')
  assert.match(question.question, /^\d+ - \d+ = \?$/)
  const [a, b] = question.question.match(/\d+/g).map(Number)
  assert.ok(a <= 10)
  assert.ok(b <= a)
  assert.equal(question.answer, String(a - b))
})

test('group guard schema exposes join audit question settings', async () => {
  const { default: groupGuardSchema } = await import('../models/Guoba/schemas/groupGuard.js')
  const fields = groupGuardSchema.map(item => item.field).filter(Boolean)
  const labels = groupGuardSchema.map(item => item.label).filter(Boolean)

  assert.ok(labels.includes('群管理模块'))
  assert.ok(labels.includes('入群审核'))
  assert.ok(fields.includes('groupGuard.questionMaxNumber'))
  assert.ok(fields.includes('groupGuard.questionOperators'))
})
