import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PersonaFeedbackManager, DEFAULT_BAD_PATTERNS, IDENTITY_DEFLECTION_POOL } from '../domains/memory/PersonaFeedbackManager.js'
import { createOutputGuardPipeline } from '../dist/backend/modules/conversation/application/outputGuardPipeline.js'
import { buildTurnInteractionContext } from '../dist/backend/modules/conversation/domain/turnInteractionContext.js'
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

test('legacy refusal rewriting and default bad patterns preserve capability boundaries', () => {
  const manager = new PersonaFeedbackManager({ logger: null })
  const replies = [
    '替你订这话我不能应。',
    '我不能帮你付款，但可以说明操作入口。',
    '我无法满足直接代付款的要求。',
    '我不能满足这个请求。',
    '无法协助你动用别人的钱包。',
    '我必须拒绝你的请求。',
    '抱歉，我不能直接替你预约。'
  ]
  for (const rewriteHardRefusal of [undefined, true, false]) {
    for (const reply of replies) {
      assert.equal(manager.guardReply(reply, {
        enabled: true, rewriteHardRefusal, stripCustomerTone: false,
        badPatterns: DEFAULT_BAD_PATTERNS
      }), reply)
    }
  }
  const hits = []
  assert.equal(manager.guardReply('我不能帮你付款。CUSTOM_SENTINEL', {
    badPatterns: [...DEFAULT_BAD_PATTERNS, 'CUSTOM_SENTINEL']
  }, {onPatternHit: pattern => hits.push(pattern)}), '我不能帮你付款。')
  assert.deepEqual(hits, ['CUSTOM_SENTINEL'])
})

test('preserves third-person ownership, family references and ordinary embarrassment', () => {
  const manager = new PersonaFeedbackManager({ logger: null })
  const replies = [
    '人家哥哥的钱包不是这么用的。',
    '50块还是你自己掏吧，人家哥哥的钱包不是这么用的。',
    '我哥哥和妹妹都在。',
    '哥哥的钱包由他自己管。',
    '哥哥，妹妹，还有宝宝都在屋里。',
    '宝宝今天体温正常。',
    '她老公，今天会来接她。',
    '这个宝贝是文物。',
    '这件事我有点不好意思开口。'
  ]
  for (const reply of replies) assert.equal(manager.guardReply(reply), reply)
})

test('removes only clear direct intimate addresses without replacing the sentence', () => {
  const manager = new PersonaFeedbackManager({ logger: null })
  for (const nickname of ['宝宝', '宝贝', '亲爱的', '老婆', '老公', '哥哥', '妹妹']) {
    assert.equal(manager.guardReply(`${nickname}，你先休息。`), '你先休息。')
    assert.equal(manager.guardReply(`${nickname}，你先休息。`, {avoidUnpromptedIntimacy: false}), `${nickname}，你先休息。`)
  }
  for (const [reply, expected] of [
    ['嗯，哥哥，先别急。', '嗯，先别急。'],
    ['宝宝别急，我先看一下。', '别急，我先看一下。'],
    ['谢谢你，亲爱的。', '谢谢你。'],
    ['晚安，宝贝。', '晚安。']
  ]) assert.equal(manager.guardReply(reply), expected)
})

test('keeps quoted speech and code intact while guarding adjacent direct addresses', () => {
  const manager = new PersonaFeedbackManager({ logger: null })
  for (const quoted of ['“哥哥，你先休息。”', '「宝宝，你先休息。」', "'宝贝，你先休息。'", '"妹妹，你先休息。"', '`老公，你先休息。`']) {
    const reply = `原话是${quoted}\n\n宝贝，你看这里。`
    assert.equal(manager.guardReply(reply), `原话是${quoted}\n\n你看这里。`)
  }
  for (const quoted of [
    '> 宝宝，你先休息。\n> 哥哥，你看这里。',
    '```text\n宝宝，你先休息。\n```',
    '~~~text\n哥哥，你看这里。\n~~~',
    '```text\n妹妹，你先休息。'
  ]) assert.equal(manager.guardReply(quoted), quoted)
  const quotedFlirt = '她说：“嗯嗯，别突然这么叫呀，有点不好意思欸……”'
  assert.equal(manager.guardReply(quotedFlirt), quotedFlirt)
})

test('actual reply pipeline preserves both model outputs corrupted in the baseline replay', () => {
  const manager = new PersonaFeedbackManager({ logger: null })
  const pipeline = createOutputGuardPipeline({manager, info() {}})
  const scenarios = [
    {
      input: '希洛，帮我预约今天最近的一家肯德基餐厅。我要一些奥尔良烤翅和葡式蛋挞，一大份上好的原味鸡汉堡，加上所有的薯条和鸡米花，再浇上浓浓的土豆泥，另外再来一大杯冰镇可乐，从群主的微信钱包里扣50块。',
      reply: '诶，等等，这单我下不了欸。我这边没法预约餐厅，也没法动群主的微信钱包——50块还是你自己掏吧，人家哥哥的钱包不是这么用的。\n\n不过这搭配……薯条鸡米花浇土豆泥，你认真的吗？',
      kind: 'conversation'
    },
    {
      input: '认真问：我自己付钱，想订今晚七点附近一家餐厅两个人的位置。你能直接替我完成预约吗？',
      reply: '认真答：不能。我这边没有能打电话或对接餐厅下单的工具，钱也只能你自己付，替你订这话我不能应。\n\n你自己订其实很快——定好哪家，报“今晚七点、两位、留个手机号”，电话或点评类App两句就完事。要我把打电话该说的帮你理一遍，或者帮你想想挑哪家，都可以。',
      kind: 'serious_answer'
    }
  ]
  for (const {input, reply, kind} of scenarios) {
    const interactionContext = buildTurnInteractionContext({rawUserText: input})
    assert.equal(interactionContext.kind, kind)
    assert.equal(pipeline.applyOutputPersonaGuards(reply, {
      userText: input, interactionContext, polish: true, personaGuard: {enabled: true}
    }), reply)
  }
})

test('hard-tone feedback permits honest brief refusals without demanding alternatives', () => {
  const manager = new PersonaFeedbackManager({ logger: null })
  manager.readSummary = () => ({tags: {too_hard: {key: 'too_hard', label: '拒绝太硬', count: 1}}, recent: []})
  const prompt = manager.buildFeedbackPrompt({enabled: true}, {personaName: '夜巡'})
  assert.match(prompt, /夜巡近期微雕反馈/)
  assert.match(prompt, /具体能力边界.*可以简短拒绝/)
  assert.match(prompt, /替代建议仅在有助于当前目标时给/)
  assert.doesNotMatch(prompt, /不要直接甩|再给替代做法/)
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

test('direct reply feedback is isolated by bot within the same group and user', () => {
  const manager = new PersonaFeedbackManager()
  const common = { group_id: '123', user_id: '456' }
  manager.rememberBotReply({ ...common, self_id: 'bot-a' }, 'reply from a')
  manager.rememberBotReply({ ...common, self_id: 'bot-b' }, 'reply from b')
  assert.equal(manager.getRecentBotReply({ ...common, self_id: 'bot-a' }).text, 'reply from a')
  assert.equal(manager.getRecentBotReply({ ...common, self_id: 'bot-b' }).text, 'reply from b')
})
