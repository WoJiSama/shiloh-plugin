import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import sharp from 'sharp'
import { normalizeCustomSize } from '../dist/backend/modules/image/domain/imageInput.js'
import { createImageResource } from '../dist/backend/modules/image/infrastructure/imageResource.js'
const source = await fs.readFile(new URL('../src/modules/platform/infrastructure/console/consoleServer.ts', import.meta.url), 'utf8')
test('custom dimensions reject zero', () => {
  assert.throws(() => normalizeCustomSize('0x0'))
  assert.equal(normalizeCustomSize('720×1280'), '720x1280')
})
test('image materializer rejects fake and zero-size images and retains original bytes', async () => {
  const materialize = createImageResource()
  await assert.rejects(materialize('base64://' + Buffer.from('<html>error</html>').toString('base64')), /无效/)
  const zero = Buffer.alloc(24); zero.write('PNG', 1)
  await assert.rejects(materialize(zero), /无效/)
  const buffer = await sharp({ create: { width: 72, height: 128, channels: 3, background: 'blue' } }).png().toBuffer()
  assert.deepEqual((await materialize('base64://' + buffer.toString('base64'))).buffer, buffer)
})
test('resource URL download validates size and aborts before fetching', async () => {
  let calls = 0
  const materialize = createImageResource({ fetch: async () => { calls++; return new Response(new Uint8Array(100)) }, maxBytes: 50 })
  const controller = new AbortController(); controller.abort()
  await assert.rejects(materialize('https://fake.invalid/image', controller.signal), /取消/)
  assert.equal(calls, 0)
  await assert.rejects(materialize('https://fake.invalid/image'), /大小/)
})
test('console uses shared service and cancellation remains scoped to authenticated owner', () => {
  assert.match(source, /await imageService\.run\(configs/)
  assert.match(source, /signal.owner === \(session\?\.username/)
  assert.match(source, /materializeImageResult\(rawImages\[index\]!?, cancelSignal.signal\)/)
  assert.doesNotMatch(source, /function (buildImageGenerationPayload|parseImageGenerationPayload|runImageCandidate)\(/)
})

test('resource cancellation interrupts an in-progress reference download', async () => {
  const controller = new AbortController()
  let downloadSignal
  const materialize = createImageResource({ fetch: async (_url, options) => {
    downloadSignal = options.signal
    return new Response(new ReadableStream({
      start(stream) { options.signal.addEventListener('abort', () => stream.error(new DOMException('aborted', 'AbortError')), { once: true }) }
    }))
  } })
  const pending = materialize('https://fake.invalid/reference', controller.signal)
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await assert.rejects(pending, /取消/)
  assert.equal(downloadSignal.aborted, true)
  assert.match(source, /loadReference: async \(value, signal\)/)
  assert.match(source, /materializeImageResult\(value, signal\)/)
})
