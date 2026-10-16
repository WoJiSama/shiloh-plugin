import {test} from 'node:test'
import assert from 'node:assert/strict'
import {buildSocialContinuity, buildTurnInteractionContext, buildTurnInteractionPrompt, withTurnInteractionEvidence, withTurnSocialInterpretation} from '../../src/modules/conversation/domain/turnInteractionContext.js'
import {loadTurnContinuity, recordTurnContinuity} from '../../src/modules/conversation/application/turnContinuity.js'

const persona = {personaId: 'social-pragmatics', personaVersion: 'v1', personaName: '岚'}
const scope = {botId: '99', persona, speaker: {userId: '202', name: '小禾'}, addressee: {targetKind: 'bot'}}
const quote = {userId: '404', messageId: 'peer-message', label: '小林', text: '阿青，你为什么不理我呀'}

test('third-party appraisal keeps the current request distinct from the quoted attention bid', () => {
  for (const rawUserText of [
    '这句是小林在问阿青，不是在叫你。你觉得是撒娇还是认真埋怨？',
    '你看他这句，是在撒娇还是生气？',
    '这是朋友发给阿青的话，你觉得是什么语气？'
  ]) {
    const context = buildTurnInteractionContext({...scope, rawUserText, quote})
    assert.equal(context.kind, 'conversation', rawUserText)
    assert.equal(context.social?.act, 'conversation', rawUserText)
    assert.equal(context.social?.observedExchange?.request.text, rawUserText)
    assert.deepEqual(context.social?.observedExchange?.utterance, {text: quote.text, source: 'quote', messageId: quote.messageId})
    assert.deepEqual(context.social?.observedExchange?.speaker, {userId: quote.userId, name: quote.label})
    assert.equal(context.target.kind, 'bot', 'the current user can address the bot while asking it to appraise someone else')
    assert.equal(context.previousBotReply, undefined)
    for (const act of ['attention_bid', 'teasing', 'comfort']) {
      const interpreted = withTurnSocialInterpretation(context, {act, confidence: 0.99, target: 'bot'}, 'understanding_model')
      assert.equal(interpreted.social?.act, 'conversation', 'a model must not turn the observed act into a direct request to this bot')
      assert.deepEqual(interpreted.social?.observedExchange, context.social?.observedExchange)
    }
    const prompt = buildTurnInteractionPrompt(context)
    assert.match(prompt, /当前是旁观点评/)
    assert.match(prompt, /直接回答当前用户请你判断的意思或语气/)
    assert.match(prompt, /不把自己当成被埋怨或被撒娇的对象/)
    assert.doesNotMatch(prompt, /先回应对方希望被理会/)
  }
})

test('literal attention, own verified speech and an unrelated request do not acquire an observed exchange', () => {
  const attention = buildTurnInteractionContext({...scope, rawUserText: '你为什么不理我呀'})
  assert.equal(attention.social?.act, 'attention_bid')
  assert.equal(attention.social?.observedExchange, undefined)
  const direct = buildTurnInteractionContext({...scope, rawUserText: '你为什么不理我呀', quote})
  assert.equal(direct.social?.act, 'attention_bid', 'an old peer quote alone does not change a new direct request')
  assert.equal(direct.social?.observedExchange, undefined)
  const own = buildTurnInteractionContext({...scope, rawUserText: '你这句什么意思？',
    quote: {...quote, userId: '99', persona, text: '这是我已确认说过的话。'}})
  assert.equal(own.social?.act, 'clarification')
  assert.equal(own.social?.observedExchange, undefined)
  assert.equal(own.previousBotReply?.source, 'quote')
  const unrelated = buildTurnInteractionContext({...scope, rawUserText: '你觉得Redis是什么？', quote})
  assert.equal(unrelated.social?.act, 'factual_question')
  assert.equal(unrelated.social?.observedExchange, undefined)
  const missing = buildTurnInteractionContext({...scope, rawUserText: '这句是撒娇还是埋怨？',
    evidence: [{origin: 'forward', kind: 'image', state: 'reference_only', text: quote.text}]})
  assert.equal(missing.social?.observedExchange, undefined, 'unread media cannot establish the utterance being appraised')
  for (const rawUserText of ['我是在向你撒娇，你觉得呢？', '你觉得我这句话算撒娇吗？']) {
    const current = buildTurnInteractionContext({...scope, rawUserText, quote})
    assert.equal(current.social?.observedExchange, undefined, 'an old quote cannot own the current speaker’s words')
  }
})

test('a three-turn quantity joke survives confirmed-send continuity and richer perception', async () => {
  const continuityScope = {groupId: 'quantity-joke-pragmatics', userId: '202', botId: '99', persona}
  const first = buildTurnInteractionContext({...scope, rawUserText: '开个玩笑，我宣布你今天的工资是三块饼干'})
  const firstReply = '三块饼干也敢发工资，老板你是真会省。'
  await recordTurnContinuity({...continuityScope, lastReply: firstReply, social: buildSocialContinuity(first, firstReply)})
  const second = buildTurnInteractionContext({...scope, rawUserText: '先扣两块，刚刚溜号了，哈哈', continuity: await loadTurnContinuity(continuityScope)})
  assert.equal(second.kind, 'banter')
  assert.equal(second.social?.activeBit?.text, second.rawUserText, 'the current change is grounded in current words')
  assert.deepEqual(second.social?.continuation, {kind: 'bit', previous: {text: firstReply, source: 'verified_continuity'}})
  assert.equal(second.social?.previousStance?.kind, 'playful')
  const enriched = withTurnInteractionEvidence(second, [{origin: 'tool', kind: 'image', state: 'unavailable', toolName: 'imageReader'}])
  assert.equal(enriched.kind, 'banter', 'an unread unrelated image does not erase the existing interaction')
  assert.deepEqual(enriched.social?.continuation, second.social?.continuation)
  const secondReply = '只剩一块了？我这班越上越穷。'
  await recordTurnContinuity({...continuityScope, lastReply: secondReply, social: buildSocialContinuity(enriched, secondReply)})
  const third = buildTurnInteractionContext({...scope, rawUserText: '剩下那块也不能吃，是年终奖', continuity: await loadTurnContinuity(continuityScope)})
  assert.equal(third.kind, 'banter')
  assert.equal(third.social?.continuation?.previous.text, secondReply)
  assert.equal(third.social?.activeBit?.text, third.rawUserText)
  assert.match(buildTurnInteractionPrompt(third), /沿用已有的数量、对象和态度/)
})

test('changed quantities and specific answers can extend other verified jokes without relying on biscuit words', () => {
  const first = buildTurnInteractionContext({...scope, rawUserText: '开个玩笑，给你五天魔法假期'})
  const reply = '五天魔法假期，先把我的工位变没。想看哪个咒语？'
  const continuity = {botId: '99', persona, lastReply: reply, social: buildSocialContinuity(first, reply)}
  for (const rawUserText of ['先扣两天', '那就看工位消失术', '魔法假期还能续杯吗']) {
    const next = buildTurnInteractionContext({...scope, rawUserText, continuity})
    assert.equal(next.kind, 'banter', rawUserText)
    assert.equal(next.social?.continuation?.kind, 'bit', rawUserText)
  }
  const question = buildTurnInteractionContext({...scope, rawUserText: '开个玩笑，饼干工资你选哪个口味'})
  const questionReply = '先选工资口味，巧克力还是香草？'
  const choice = buildTurnInteractionContext({...scope, rawUserText: '巧克力，别再扣了',
    continuity: {botId: '99', persona, lastReply: questionReply, social: buildSocialContinuity(question, questionReply)}})
  assert.equal(choice.kind, 'banter')
  assert.equal(choice.social?.pendingInteraction?.text, questionReply)
  const answered = buildSocialContinuity(choice, '巧克力那块归我，账先封存。')
  assert.equal(answered.pendingInteraction, undefined, 'a confirmed answer does not persist the previous question again')
})

test('prior play cannot absorb a new task, correction, distress, unrelated topic or another persona', () => {
  const first = buildTurnInteractionContext({...scope, rawUserText: '开个玩笑，你的工资是三块饼干'})
  const reply = '三块饼干，老板先把口味交代一下？'
  const continuity = {botId: '99', persona, lastReply: reply, social: buildSocialContinuity(first, reply)}
  for (const rawUserText of ['认真问，那块显卡为什么这么烫？', '帮我计算三块饼干的热量', '别再阴阳怪气，我不喜欢这语气', '今天考砸了，有点难受，先别讲道理', '换个话题，我今天吃了饼干', '我刚到家，外面下雨了', '我刚刚到医院陪朋友', '那个新同事叫阿青']) {
    const next = buildTurnInteractionContext({...scope, rawUserText, continuity})
    assert.notEqual(next.kind, 'banter', rawUserText)
    assert.equal(next.social?.activeBit, undefined, rawUserText)
    assert.equal(next.social?.continuation?.kind === 'bit', false, rawUserText)
  }
  for (const previous of [{...continuity, botId: '100'}, {...continuity, persona: {...persona, personaVersion: 'old'}}, {...continuity, persona: {...persona, personaId: 'other'}}]) {
    const next = buildTurnInteractionContext({...scope, rawUserText: '剩下那块也不能吃，是年终奖', continuity: previous})
    assert.equal(next.kind, 'conversation')
    assert.equal(next.social?.continuation, undefined)
    assert.equal(next.social?.previousStance, undefined)
  }
})

test('a new named entity or explicit withdrawal ends a previously verified bit',()=>{
 const first = buildTurnInteractionContext({...scope,rawUserText:'开个玩笑，给你五天魔法假期'})
 const reply='五天魔法假期，先把工位变没。想看哪个咒语？'
 const continuity={botId:'99',persona,lastReply:reply,social:buildSocialContinuity(first,reply)}
 for(const rawUserText of ['那块主板昨天送修了','魔法假期先不说，我最近工资真发不出了','那个咒语我没兴趣，我现在工作遇到麻烦','我有个新同事也叫魔法师']){
  const current=buildTurnInteractionContext({...scope,rawUserText,continuity})
  assert.notEqual(current.kind,'banter',rawUserText)
  assert.equal(current.social?.continuation,undefined)
 }
})

test('style constraints do not erase an explicit current factual question',()=>{
 for(const rawUserText of ['先别讲道理，Redis是什么？','先不要给建议，数据库事务是什么？']){
  const current=buildTurnInteractionContext({...scope,rawUserText})
  assert.equal(current.kind,'serious_answer',rawUserText)
  assert.equal(current.social?.act,'factual_question')
  assert.equal(withTurnSocialInterpretation(current,{act:'comfort',confidence:0.99},'understanding_model').kind,'serious_answer')
 }
})

test('explicit quiet companionship keeps comfort through a sent reply and the next user turn', async () => {
  const continuityScope = {groupId: 'quiet-support-pragmatics', userId: '202', botId: '99', persona}
  const first = buildTurnInteractionContext({...scope, rawUserText: '今天考砸了，我现在有点难受，先别给我讲道理。'})
  assert.equal(first.kind, 'comfort')
  assert.equal(first.allowPlayfulness, false)
  const reply = '嗯，先不复盘，难受就先缓一会儿。'
  await recordTurnContinuity({...continuityScope, lastReply: reply, social: buildSocialContinuity(first, reply)})
  for (const rawUserText of ['嗯，就陪我待一会儿吧', '先安静陪着我就好', '不用说什么']) {
    const next = buildTurnInteractionContext({...scope, rawUserText, continuity: await loadTurnContinuity(continuityScope)})
    assert.equal(next.kind, 'comfort', rawUserText)
    assert.equal(next.social?.previousStance?.kind, 'supportive')
    assert.equal(next.social?.continuation?.kind, 'support', rawUserText)
    const model = withTurnSocialInterpretation(next, {act: 'teasing', confidence: 0.99}, 'understanding_model')
    assert.equal(model.kind, 'comfort', 'the existing model cannot erase explicit companionship in a verified support exchange')
    assert.match(buildTurnInteractionPrompt(next), /不追加建议、分析、连续追问/)
  }
  for (const rawUserText of ['现在帮我分析一下这次考试错在哪里', '换个话题，讲讲数据库事务', '不用说什么，Redis是什么？']) {
    const next = buildTurnInteractionContext({...scope, rawUserText, continuity: await loadTurnContinuity(continuityScope)})
    assert.equal(next.kind, 'serious_answer', rawUserText)
    assert.equal(next.social?.continuation, undefined)
  }
})
