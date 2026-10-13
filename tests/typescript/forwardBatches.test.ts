import assert from 'node:assert/strict'
import test from 'node:test'
import { sendForwardBatches } from '../../src/modules/messaging/domain/forwardBatches.js'

test('forward batching preserves order and acknowledges progress only after each receipt', async () => {
  const nodes = Array.from({ length: 201 }, (_, i) => i)
  const events: string[] = []
  const received: number[] = []
  const count = await sendForwardBatches(nodes, {
    makeForward: batch => { events.push(`make:${batch.length}`); return { batch } },
    send: async payload => {
      await Promise.resolve()
      received.push(...payload.batch)
      events.push('receipt')
      return { retcode: '0' }
    },
    onProgress: (sent, total) => { events.push(`progress:${sent}/${total}`) }
  })
  assert.equal(count, 3)
  assert.deepEqual(received, nodes)
  assert.deepEqual(events, ['make:100', 'receipt', 'progress:1/3', 'make:100', 'receipt', 'progress:2/3', 'make:1', 'receipt', 'progress:3/3'])
})

for (const receipt of [false, { status: 'failed' }, { retcode: 1 }, { retcode: '5' }]) {
  test(`failed receipt ${JSON.stringify(receipt)} halts remaining batches`, async () => {
    let sent = 0
    const progress: number[] = []
    await assert.rejects(sendForwardBatches(Array.from({ length: 201 }, (_, i) => i), {
      makeForward: batch => batch,
      send: () => ++sent === 2 ? receipt : { retcode: 0 },
      onProgress: count => { progress.push(count) }
    }), /第 2\/3 份发送失败；已发送 1 份/)
    assert.equal(sent, 2)
    assert.deepEqual(progress, [1])
  })
}

test('empty input never builds, sends, or reports progress', async () => {
  const unexpected = () => { throw new Error('unexpected callback') }
  assert.equal(await sendForwardBatches([], { makeForward: unexpected, send: unexpected, onProgress: unexpected }), 0)
})

for (const failingStep of ['makeForward', 'send'] as const) {
  test(`${failingStep} rejection propagates without progress`, async () => {
    const error = new Error('transport unavailable')
    let progress = 0
    await assert.rejects(sendForwardBatches([1], {
      makeForward: batch => failingStep === 'makeForward' ? Promise.reject(error) : batch,
      send: () => failingStep === 'send' ? Promise.reject(error) : true,
      onProgress: () => { progress++ }
    }), error)
    assert.equal(progress, 0)
  })
}
