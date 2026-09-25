import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripChatLogSpeakerPrefix, stripChatLogSpeakerPrefixes, sanitizeFinalReplyText } from '../utils/replySanitizer.js'

test('strips copied chat-log prefix and keeps reply text', () => {
  const input = '[2026-06-23 19:00:43] 某机器人(QQ号:3094088525): 啊？可视化...你现在让我变个进度条出来吗？'
  assert.equal(
    stripChatLogSpeakerPrefix(input),
    '啊？可视化...你现在让我变个进度条出来吗？'
  )
})

test('strips group-role history prefix with 在群里说', () => {
  const input = '[2026-06-23 19:00:43] 小明(qq号: 123456)[群身份: member]: 在群里说: 我看一下进度。'
  assert.equal(stripChatLogSpeakerPrefix(input), '我看一下进度。')
})

test('strips unbracketed history prefix', () => {
  const input = '2026-06-23 19:00:43 小明(QQ:123456): 先等我看一下。'
  assert.equal(stripChatLogSpeakerPrefix(input), '先等我看一下。')
})

test('strips prefixes per line without touching normal text', () => {
  const input = [
    '[19:00:43] 小明(QQ号:123456): 第一行',
    '普通说明：[2026-06-23 19:00:43] 这只是文字'
  ].join('\n')
  assert.equal(
    stripChatLogSpeakerPrefixes(input),
    ['第一行', '普通说明：[2026-06-23 19:00:43] 这只是文字'].join('\n')
  )
})

test('literal \\n still expands to newlines in plain prose', () => {
  assert.equal(
    sanitizeFinalReplyText('第一句\\n第二句\\n第三句'),
    ['第一句', '第二句', '第三句'].join('\n')
  )
})

test('latex commands starting with n survive literal-newline expansion', () => {
  const input = '光线方程:\\[ \\frac{d}{ds}\\left(n\\frac{d\\mathbf r}{ds}\\right)=\\nabla n \\]\\n其中 \\(\\nu\\)、\\(\\neq\\) 不受影响'
  const output = sanitizeFinalReplyText(input)
  assert.match(output, /\\nabla n/)
  assert.match(output, /\\nu/)
  assert.match(output, /\\neq/)
  assert.ok(!output.includes('\nabla'), '\\nabla 不能被劈成换行+abla')
})

test('math segments are masked from newline expansion entirely', () => {
  const input = '结论 \\[ a\\nb \\] 收尾' // 数学片段内部即使出现孤立 \\n 也不展开
  const output = sanitizeFinalReplyText(input)
  assert.ok(output.includes('\\[ a\\nb \\]'))
})
