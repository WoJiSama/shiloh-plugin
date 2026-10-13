import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MessageArchiveManager } from '../utils/MessageArchiveManager.js'
import { sendForwardBatches } from '../utils/forwardBatches.js'

test('typed archive preserves 400 records, ignores invalid lines, and batches added headings within 100 nodes', async t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'typed-archive-'))
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }))
  const manager = new MessageArchiveManager({ cwd, logger: { warn() {} } })
  const dir = path.join(manager.getBaseDir(), 'group', '123456')
  fs.mkdirSync(dir, { recursive: true })
  const records = Array.from({ length: 400 }, (_, i) => manager.buildRecord({ message_type: 'group', group_id: 123456, user_id: 42, message_id: i + 1, time: 1700000000 + i, message: [{ type: 'text', text: `record-${i}` }] }))
  const file = path.join(dir, '2023-11-14.ndjson')
  fs.writeFileSync(file, records.map(item => JSON.stringify(item)).join('\n') + '\nnull\n{"timestamp":"bad"}\n')
  const found = await manager.query({ groupId: 123456, limit: 400 })
  assert.equal(found.length, 400)
  assert.deepEqual(found.map(item => item.message_id), records.map(item => item.message_id))
  const batches = []
  const nodes = ['heading', ...found.map(item => manager.formatRecord(item))]
  await sendForwardBatches(nodes, { makeForward: batch => batch, send: async batch => { batches.push(batch); return { retcode: 0, data: { message_id: batches.length } } } })
  assert.deepEqual(batches.map(batch => batch.length), [100, 100, 100, 100, 1])
  assert.deepEqual(batches.flat(), nodes)
  assert.equal(await manager.appendRecordOnce(file, records[0]), false)
})
