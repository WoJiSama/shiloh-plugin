import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildMissingImageAnalysisReply,
  looksLikeImageAuthenticityRequest,
  looksLikeImageVerificationRequest,
  looksLikeVisualInspectionRequest,
  shouldAskForMissingImageForVisualRequest
} from '../utils/imageRequestGuard.js'

test('detects visual inspection requests without explicit image word', () => {
  assert.equal(looksLikeVisualInspectionRequest('@这里是希洛! 看看腿'), true)
  assert.equal(looksLikeVisualInspectionRequest('帮我看看这个细节'), true)
})

test('does not treat non-visual body advice as image inspection', () => {
  assert.equal(looksLikeVisualInspectionRequest('看看腿疼怎么办'), false)
  assert.equal(looksLikeVisualInspectionRequest('帮我看看腿怎么练'), false)
})

test('only asks for a missing image when the wording points to an image', () => {
  assert.equal(shouldAskForMissingImageForVisualRequest('@这里是希洛! 看看腿'), false)
  assert.equal(shouldAskForMissingImageForVisualRequest('帮我看看这个细节'), true)
  assert.equal(shouldAskForMissingImageForVisualRequest('看一下这张图的腿'), true)
})

test('treats commentary about prior chat as conversation rather than a missing image', () => {
  const cases = [
    '希洛你能不能锐评一下他上面一直找项目的事情',
    '锐评一下他上面说的话',
    '评价一下他前面的发言',
    '分析一下上面一直找工作的事情'
  ]
  for (const text of cases) {
    assert.equal(looksLikeVisualInspectionRequest(text), false, text)
    assert.equal(shouldAskForMissingImageForVisualRequest(text), false, text)
    assert.equal(looksLikeImageVerificationRequest(text), false, text)
  }
  assert.equal(looksLikeVisualInspectionRequest('锐评一下这张图里的穿搭'), true)
  assert.equal(shouldAskForMissingImageForVisualRequest('锐评一下这张图里的穿搭'), true)
  assert.equal(shouldAskForMissingImageForVisualRequest('评价一下上面的穿搭'), true)
})

test('detects image-grounded verification and latest-info requests', () => {
  assert.equal(looksLikeImageVerificationRequest('希洛，查一下这个是真的假的，看看现在最新的信息'), true)
  assert.equal(looksLikeImageVerificationRequest('帮我核实一下这张截图是不是真的'), true)
  assert.equal(looksLikeImageVerificationRequest('这图是不是AI生成的'), true)
})

test('does not treat unrelated realtime lookup as image verification', () => {
  assert.equal(looksLikeImageVerificationRequest('查一下今天深圳天气'), false)
  assert.equal(looksLikeImageVerificationRequest('最新版本是多少'), false)
})

test('separates content verification from image authenticity', () => {
  assert.equal(looksLikeImageAuthenticityRequest('希洛，查一下这个是真的假的，看看现在最新的信息'), false)
  assert.equal(looksLikeImageAuthenticityRequest('这张图是不是AI生成的'), true)
  assert.equal(looksLikeImageAuthenticityRequest('这张图片是不是P的'), true)
})

test('missing image reply asks for an image directly without inventing details', () => {
  const reply = buildMissingImageAnalysisReply()
  assert.ok(reply.includes('没有可看的图片'))
  assert.ok(reply.includes('图片') && reply.includes('原图'))
  assert.ok(!reply.includes('我怕乱讲'))
})
