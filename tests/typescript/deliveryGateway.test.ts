import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createDeliveryGatewayModule } from '../../src/modules/messaging/infrastructure/deliveryGateway.js'

test('typed gateway preserves successful message identity and marks unknown receipt uncertain', async () => {
 const root = { sendApi: async () => ({ retcode: 0, data: { message_id: 'receipt-1' } }) }
 const module = createDeliveryGatewayModule({ botRoot: () => root, logDeliveryOutcome() {}, isForwardResourceFailure: () => false })
 const gateway = new module.DeliveryGateway()
 assert.equal((await gateway.sendGroupText({ botId: 1, groupId: 2, text: 'hello' })).messageId, 'receipt-1')
 const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'typed-file-'))
 const file = path.join(dir, 'file.bin'); await fs.writeFile(file, 'content')
 let fallback = 0
 try {
  await assert.rejects(module.sendCompleteLocalFile({ group_id: 1, bot: { sendApi: async () => undefined }, group: { sendFile: async () => { fallback++; return { retcode: 0 } } } }, file), error => error instanceof module.DeliveryError && error.uncertain && !error.retryable)
  assert.equal(fallback, 0)
 } finally { await fs.rm(dir, { recursive: true, force: true }) }
})
