import assert from 'node:assert/strict'
import test from 'node:test'
import { readImageDimensions } from '../../src/modules/image/domain/imageDimensions.js'
import { assertGrokImageRatio, applyImageAspectRatioToConfigs, resolveImageAspectRatioIntent } from '../../src/modules/image/domain/imageAspectRatio.js'

test('zero canvas dimensions are invalid for PNG, GIF and JPEG', () => {
  const png = Buffer.alloc(24)
  png.write('PNG', 1); png.writeUInt32BE(100, 20)
  const gif = Buffer.alloc(10)
  gif.write('GIF89a'); gif.writeUInt16LE(100, 8)
  const jpeg = Buffer.from([255, 216, 255, 192, 0, 7, 8, 0, 100, 0, 0])
  for (const data of [png, gif, jpeg]) assert.equal(readImageDimensions(data), null)
  png.writeUInt32BE(60, 16)
  assert.deepEqual(readImageDimensions(png), { width: 60, height: 100 })
})

test('truncated JPEG marker padding is rejected safely', () => {
  assert.equal(readImageDimensions(Buffer.from([255, 216, 255, 255, 255, 255])), null)
})

test('invalid requested ratios and invalid returned dimensions cannot silently pass', () => {
  const model = 'grok-imagine-image'
  assert.throws(() => assertGrokImageRatio({ model, aspectRatio: 'invalid' }, { width: 100, height: 100 }), /请求画幅无效/)
  for (const width of [0, -1, Infinity, NaN]) {
    assert.throws(() => assertGrokImageRatio({ model, aspectRatio: '9:16' }, { width, height: 160 }), /无法验证/)
  }
  assert.throws(() => assertGrokImageRatio({ model, aspectRatio: '9:16' }, { width: 100, height: 100 }), /未遵守/)
  assert.doesNotThrow(() => assertGrokImageRatio({ model, aspectRatio: '9:16' }, { width: 90, height: 160 }))
})

test('provider candidates preserve extension fields and each receive their own ratio policy', () => {
  const candidates = applyImageAspectRatioToConfigs([
    { model: 'grok-imagine-image', channelId: 'first', size: '1024x1024' },
    { model: 'gpt-image-2', channelId: 'second', size: '1024x1024' }
  ], resolveImageAspectRatioIntent('9:16'))
  assert.equal(candidates[0]?.aspectRatio, '9:16')
  assert.equal(candidates[0]?.size, '')
  assert.equal(candidates[1]?.size, '1024x1536')
  assert.equal(candidates[1]?.channelId, 'second')
})
