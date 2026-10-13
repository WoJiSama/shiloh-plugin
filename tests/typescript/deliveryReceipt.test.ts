import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeDeliveryReceipt } from '../../src/modules/messaging/domain/deliveryReceipt.js'

test('only a platform message id confirms delivery; unknown receipts never become success facts', () => {
  for (const value of [undefined, null, true, {}, { retcode: 0 }, { data: {} }]) assert.deepEqual(normalizeDeliveryReceipt(value), { state: 'unknown' })
  assert.deepEqual(normalizeDeliveryReceipt({ data: { message_id: 123 } }), { state: 'sent', messageId: '123' })
  assert.deepEqual(normalizeDeliveryReceipt({ message_id: 'abc' }), { state: 'sent', messageId: 'abc' })
})
test('explicit rejection wins over a message id and preserves platform code', () => {
  assert.deepEqual(normalizeDeliveryReceipt(false), { state: 'failed', code: null })
  assert.deepEqual(normalizeDeliveryReceipt({ status: 'failed', message_id: 'x' }), { state: 'failed', code: null })
  assert.deepEqual(normalizeDeliveryReceipt({ retcode: '1200' }), { state: 'failed', code: '1200' })
})
