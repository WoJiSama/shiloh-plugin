import assert from 'node:assert/strict'
import test from 'node:test'
import { extractImageResult } from '../../src/modules/image/domain/imageResult.js'
import { selectImageEditBase, canUseRecentImage } from '../../src/modules/image/domain/imageSourcePolicy.js'
import { classifyImageTaskPolicy } from '../../src/modules/image/domain/imageTaskPolicy.js'
import { classifyImageFailure, buildImageFailureReply } from '../../src/modules/image/domain/imageFailurePolicy.js'
import { buildVisibleFailureDetail } from '../../src/modules/models/domain/visibleFailure.js'
import { serializeMultipartFormData } from '../../src/modules/image/infrastructure/multipartFormData.js'

test('image result extraction retains URI/base64 and rejects non-image prose', () => {
  assert.equal(extractImageResult('![image](data:image/png;base64,YQ==)'), 'base64://YQ==')
  assert.equal(extractImageResult('result https://example.com/a.png?key=1'), 'https://example.com/a.png?key=1')
  assert.equal(extractImageResult(null), null)
})
test('edit sources prefer current and recent sources require continuation', () => {
  assert.equal(selectImageEditBase({ currentImages: ['current'], replyImages: ['reply'] }).source, 'current')
  assert.equal(selectImageEditBase({ recentImage: 'recent' }).origin, 'missing')
  assert.equal(canUseRecentImage({ isContinuation: true, recentSenderId: 1, botId: '1', ageMs: 0 }), true)
  assert.equal(canUseRecentImage({ isContinuation: true, recentSenderId: 2, botId: '1', ageMs: 0 }), false)
  assert.equal(classifyImageTaskPolicy({ text: '修改这张图片的背景' }), 'image_edit_missing_base')
})
test('error classification and visible redaction preserve actionable status', () => {
  assert.equal(classifyImageFailure('429 quota exceeded'), 'rate_limit')
  assert.match(buildImageFailureReply('401 unauthorized'), /鉴权/)
  const detail = buildVisibleFailureDetail(new Error('429 Bearer sk-secretabcdefgh'))
  assert.match(detail, /429/)
  assert.doesNotMatch(detail, /secretabcdefgh/)
})
test('multipart serializes native data with exact body length and rejects invalid input', async () => {
  const data = new FormData()
  data.append('prompt', '画图')
  const result = await serializeMultipartFormData(data)
  assert.equal(result.headers['Content-Length'], String(result.body.length))
  assert.match(result.headers['Content-Type'], /boundary=/)
  assert.match(result.body.toString(), /画图/)
  await assert.rejects(serializeMultipartFormData('not form data'), /boundary/)
})
test('multipart rejects malformed legacy method results at the boundary', async () => {
  await assert.rejects(serializeMultipartFormData({ getHeaders: () => null, getBuffer: () => Buffer.from('data') }), /boundary/)
  await assert.rejects(serializeMultipartFormData({ getHeaders: () => ({ 'content-type': 123 }), getBuffer: () => Buffer.from('data') }), /boundary/)
  await assert.rejects(serializeMultipartFormData({ getHeaders: () => ({}), getBuffer: () => 'not bytes' }), /为空/)
})
