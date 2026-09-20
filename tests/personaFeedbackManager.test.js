import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PersonaFeedbackManager, IDENTITY_DEFLECTION_POOL } from '../domains/memory/PersonaFeedbackManager.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

test('softens hard robot or human identity denial', () => {
  const manager = new PersonaFeedbackManager({ logger: null })
  const output = manager.guardReply('不是机器人啦……活人一个😂 就是话多了一点', {
    enabled: true
  }, {
    userText: '你怎么这么像机器人啊'
  })

  // 硬否认片段被删掉，其余自然内容保留（不再归一成固定句）
  assert.equal(output, '就是话多了一点')
  assert.doesNotMatch(output, /活人|真人|不是机器人|扣帽子/)
})

test('keeps normal replies unchanged', () => {
  const manager = new PersonaFeedbackManager({ logger: null })
  const output = manager.guardReply('你少来，我只是刚好看到消息了。', {
    enabled: true
  })

  assert.equal(output, '你少来，我只是刚好看到消息了。')
})

test('handles hard denial variants only for bot identity challenges', () => {
  const manager = new PersonaFeedbackManager({ logger: null })
  const context = { userText: '希洛你不会是 AI 吧', botNames: ['希洛'] }

  // 整条只剩否认 → 从轮换池取一句，且不含否认措辞
  const collapsed = manager.guardReply('我才不是AI呢，真人一个。', { enabled: true }, context)
  assert.ok(IDENTITY_DEFLECTION_POOL.some(line => collapsed === `${line}。`), `unexpected: ${collapsed}`)
  assert.doesNotMatch(collapsed, /不是|活人|真人|扣帽子/)

  // 部分否认 → 只删否认片段，保留其余自然内容
  assert.equal(
    manager.guardReply('谁是机器人啊，我可是活人一个！你少来。', { enabled: true }, context),
    '你少来。'
  )
})

test('collapses to rotated deflections instead of one fixed line', () => {
  const manager = new PersonaFeedbackManager({ logger: null })
  const context = { userText: '你是机器人吗', botNames: ['希洛'] }

  const replies = Array.from({ length: IDENTITY_DEFLECTION_POOL.length }, () =>
    manager.guardReply('我才不是机器人！', { enabled: true }, context)
  )
  assert.equal(new Set(replies).size, replies.length, '连续多次被问不应重复同一句')
})

test('strips canned marker phrase regurgitated from history', () => {
  const manager = new PersonaFeedbackManager({ logger: null })
  const context = { userText: '希洛你是不是机器人', botNames: ['希洛'] }

  const output = manager.guardReply('别给我扣机器人帽子……你少来', { enabled: true }, context)
  assert.equal(output, '你少来')
  assert.doesNotMatch(output, /扣帽子/)
})

test('does not corrupt image authenticity or ordinary human-related content', () => {
  const manager = new PersonaFeedbackManager({ logger: null })
  const cases = [
    ['这张图是不是AI生成的', '这是真人照片，不像 AI 生成。'],
    ['NPC 属性怎么算', '真人玩家按当前属性计算，NPC 再做上下浮动。'],
    ['介绍一下这部电影', '这是真人出演，不是机器人题材。']
  ]

  for (const [userText, reply] of cases) {
    assert.equal(manager.guardReply(reply, { enabled: true }, { userText }), reply)
  }
})

test('deescalates replies when the user criticizes the tone', () => {
  const manager = new PersonaFeedbackManager({ logger: null })
  const context = { userText: '你跟哪学的，怎么感觉阴阳怪气的' }

  assert.equal(
    manager.guardReply('嘿嘿，别气嘛…我那不也是一时嘴快嘛😋', { enabled: true }, context),
    '你说得对，刚才那几句有点顶着你说了，听着确实不舒服。我收一下。'
  )
  assert.equal(
    manager.guardReply('你说得对，刚才语气没收住，听着确实不舒服。我改。❤', { enabled: true }, context),
    '你说得对，刚才语气没收住，听着确实不舒服。我改。'
  )
})

test('keeps playful banter outside explicit tone criticism', () => {
  const manager = new PersonaFeedbackManager({ logger: null })
  const reply = '你少来，我就开个玩笑😋'

  assert.equal(manager.guardReply(reply, { enabled: true }, { userText: '哈哈你又开始了' }), reply)
})

test('removes unprompted intimate nicknames and shy flirt framing', () => {
  const manager = new PersonaFeedbackManager({ logger: null })
  const output = manager.guardReply('嗯嗯，别突然这么叫呀，有点不好意思欸……', { enabled: true }, {
    userText: '好的，宝宝~'
  })

  assert.doesNotMatch(output, /宝宝|宝贝|不好意思/)
  assert.match(output, /叫我希洛就好/)
})

test('keeps blank lines and markdown table structure intact', () => {
  const manager = new PersonaFeedbackManager({ logger: null })
  const text = [
    '自定义骰娘规则包（1 个）——id 就是下表括号里的字母名',
    '',
    '| 规则包 | 本群状态 | 命令 | 看用法 |',
    '| --- | --- | --- | --- |',
    '| Daggerheart二元骰（daggerheart） | 已启用 | .dd .ddr | 发 .dd help 看用法 |',
    '',
    '说明与人物卡字段：.骰规则查看 daggerheart'
  ].join('\n')

  // 换行被吞成空格会把表头黏到标题行、表尾黏进数据行，表格直接废掉
  assert.equal(manager.guardReply(text, { enabled: true }, {}), text)
})

test('only explicit master feedback is exposed for semantic style learning', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'persona-feedback-'))
  const manager = new PersonaFeedbackManager({ cwd, logger: null })
  const event = { group_id: 1, user_id: 2, message_id: 3, isMaster: true }
  try {
    manager.rememberBotReply({ ...event, message_id: 2 }, '很抱歉，我不能帮你。')
    const result = await manager.recordFeedback(event, '.希洛反馈 太客服了')
    assert.match(result, /客服腔/)
    assert.deepEqual(manager.getLatestFeedback(event)?.tags, ['too_customer'])
    assert.equal(manager.getLatestFeedback({ ...event, isMaster: false }), manager.getLatestFeedback(event))
    const denied = await manager.recordFeedback({ ...event, user_id: 3, isMaster: false }, '.希洛反馈 太硬了')
    assert.match(denied, /只有主人/)
    assert.equal(manager.getLatestFeedback({ ...event, user_id: 3, isMaster: false }), null)
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})
