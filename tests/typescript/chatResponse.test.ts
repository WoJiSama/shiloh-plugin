import assert from 'node:assert/strict'
import test from 'node:test'
import { parseChatResponse } from '../../src/modules/models/domain/chatResponse.js'
import { sanitizeJsonValue } from '../../src/modules/models/domain/unicodeText.js'

test('response boundary rejects malformed consumed fields', () => {
  for (const value of [null, { choices: 'bad' }, { choices: [null] }, { choices: [{ message: [] }] }, { choices: [{ message: { tool_calls: [null] } }] }, { choices: [{ message: { tool_calls: [{ function: { arguments: {} } }] } }] }]) {
    assert.match(String(parseChatResponse(value).error), /Invalid response format/)
  }
})
test('optional legacy role and unknown provider extensions survive validation', () => {
  const response = { providerExtension: { version: 1 }, choices: [{ message: { content: 'ok', tool_calls: [{ function: { name: 'draw', arguments: '{}' } }] } }] }
  assert.equal(parseChatResponse(response), response)
  assert.deepEqual(parseChatResponse([response]), response)
})
test('array/object cycles are replaced while repeated noncyclic objects are preserved', () => {
  const array: unknown[] = []
  array.push(array)
  assert.deepEqual(sanitizeJsonValue(array), [null])
  const root: { children: unknown[] } = { children: [] }
  root.children.push(root)
  assert.deepEqual(sanitizeJsonValue(root), { children: [null] })
  const shared = { text: '\ud800' }
  assert.deepEqual(sanitizeJsonValue([shared, shared]), [{ text: '�' }, { text: '�' }])
})
