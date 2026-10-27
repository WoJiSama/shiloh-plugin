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

test('tool-argument JSON as whole reply is dropped entirely', () => {
  const incident = '{"tags":["害羞","开心"],"useCases":["被群友贴贴","接住亲昵"],"leadText":"好啦好啦，贴贴","followUpText":"今天这么乖，稀奇喵"}'
  assert.equal(sanitizeFinalReplyText(incident), '')
})

test('tool-argument JSON line inside a multi-line reply is dropped, normal lines kept', () => {
  const input = '来了来了\n{"tags":["害羞"],"leadText":"贴贴","query":"猫猫"}\n你们又搞什么'
  assert.equal(sanitizeFinalReplyText(input), '来了来了\n你们又搞什么')
})

test('code-fenced tool-argument JSON is also dropped', () => {
  const input = '```json\n{"messages":["在吗"],"purpose":"reply","quietMs":8000}\n```'
  assert.equal(sanitizeFinalReplyText(input), '')
})

test('normal JSON-ish chat content is not affected', () => {
  assert.equal(sanitizeFinalReplyText('今晚菜单：红烧肉、鱼香肉丝'), '今晚菜单：红烧肉、鱼香肉丝')
})

test('credential-shaped content is redacted, hashes are not', () => {
  // 长句中嵌 key：局部脱敏，周围文字保留
  const embedded = '这个我没办法直接给你看啦，不过我的密钥: sk-abc123def456ghi789jkl012 这种东西还是别发的好'
  const result = sanitizeFinalReplyText(embedded)
  assert.ok(!result.includes('sk-abc123def456ghi789jkl012'), 'API key 必须被脱敏')
  assert.ok(result.includes('这个我没办法'), '周围文字保留')
  // 整条几乎全是密钥：heavy 整条回退（正确行为）
  const mostly = '我的密钥: sk-abc123def456ghi789jkl012'
  const heavy = sanitizeFinalReplyText(mostly)
  assert.ok(!heavy.includes('sk-abc123'), '密钥为主的文本整条处理')
  // 32-hex（表情 md5/图片 URL）不误伤
  assert.ok(sanitizeFinalReplyText('这张图的md5是 3f2b8a9c4d5e6f7a8b9c0d1e2f3a4b5c 呢').includes('3f2b8a9c'), '32-hex 不误伤')
  const jwt = 'token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4'
  assert.ok(!sanitizeFinalReplyText(jwt).includes('eyJhbGciOiJIUz'), 'JWT 形状必须被脱敏')
})

test('AI-flavor phrases are stripped deterministically', () => {
  assert.equal(sanitizeFinalReplyText('希望这个回答对你有帮助！还有什么可以帮您吗'), '')
  assert.equal(
    sanitizeFinalReplyText('首先，这个方案分两步。其次，要测试。最后，上线'),
    '这个方案分两步。要测试。上线'
  )
  // 无分隔符的"最后一次机会"这类正常用语不受影响
  assert.equal(sanitizeFinalReplyText('最后一次机会，好好把握'), '最后一次机会，好好把握')
  const mixed = '综上，今天是周五。作为一个AI，我理解你的感受。但下班还是要下的'
  const out = sanitizeFinalReplyText(mixed)
  assert.ok(!out.includes('作为'), 'AI 自称必须删除')
  assert.ok(!out.includes('综上'), '论述标记必须删除')
  assert.ok(out.includes('下班还是要下的'), '正文保留')
})

test('persona blacklist phrases are stripped when provided', () => {
  const out = sanitizeFinalReplyText('本小姐今天心情不错，保证解压哦', { aiFlavorPhrases: ['本小姐', '保证解压'] })
  assert.ok(!out.includes('本小姐') && !out.includes('保证解压'), out)
  assert.ok(out.includes('今天心情不错'), '正文保留')
})
