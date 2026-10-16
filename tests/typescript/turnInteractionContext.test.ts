import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {buildSocialContinuity, buildTurnInteractionContext, buildTurnInteractionPrompt, withTurnInteractionEvidence, withTurnSocialInterpretation} from '../../src/modules/conversation/domain/turnInteractionContext.js'
import type {InteractionKind, TurnEvidence} from '../../src/contracts/turnInteraction.js'

interface Scenario {
  id: string
  rawUserText: string
  expectedKind: InteractionKind
  imageSource?: string
  readableImageText?: string
  videoSource?: string
  quote?: {userId: string; messageId: string; name: string; text: string}
  continuity?: {botId: string; lastReply: string}
}

const scenarios = JSON.parse(fs.readFileSync(path.resolve('tests/fixtures/interactionReplayScenarios.json'), 'utf8')) as Scenario[]
const speaker = {userId: '202', name: '测试群友'}

test('six sanitized replay scenarios retain current words and their interaction boundaries', () => {
  assert.equal(scenarios.length, 6)
  assert.equal(new Set(scenarios.map(item => item.id)).size, 6)
  for (const scenario of scenarios) {
    const evidence: TurnEvidence[] = []
    if (scenario.imageSource) evidence.push({origin: 'current', kind: 'image', state: 'reference_only', source: scenario.imageSource})
    if (scenario.videoSource) evidence.push({origin: 'current', kind: 'video', state: 'reference_only', source: scenario.videoSource})
    const context = buildTurnInteractionContext({
      rawUserText: scenario.rawUserText, botId: '99', speaker, evidence,
      ...(scenario.quote ? {quote: {...scenario.quote, label: scenario.quote.name}} : {}),
      ...(scenario.continuity ? {continuity: scenario.continuity} : {})
    })
    assert.equal(context.kind, scenario.expectedKind, scenario.id)
    assert.equal(context.rawUserText, scenario.rawUserText, scenario.id)
    assert.ok(buildTurnInteractionPrompt(context).includes(scenario.rawUserText), scenario.id)
    if (scenario.imageSource || scenario.videoSource) {
      const media = context.evidence.find(item => item.kind !== 'text')
      assert.equal(media?.state, 'reference_only', scenario.id)
      assert.equal(media?.text, undefined, 'a URL is not extracted media content')
    }
  }
})

test('actual readable image evidence can explain a deictic reaction without changing its raw text', () => {
  const scenario = scenarios.find(item => item.id === 'local-model-image-meme')!
  const initial = buildTurnInteractionContext({rawUserText: '这个', botId: '99', speaker,
    evidence: [{origin: 'current', kind: 'image', state: 'reference_only', source: scenario.imageSource!}]})
  assert.equal(initial.kind, 'conversation')
  const resolved = withTurnInteractionEvidence(initial, [{origin: 'tool', kind: 'image', state: 'readable', text: scenario.readableImageText!, toolName: 'imageReader'}])
  assert.equal(resolved.kind, 'banter')
  assert.equal(resolved.rawUserText, '这个')
  assert.equal(initial.kind, 'conversation', 'adding perception evidence must not mutate the original turn')
  assert.ok(resolved.evidence.some(item => item.state === 'readable' && item.text === scenario.readableImageText))
})

test('a changed duration remains new evidence rather than a copied joke', () => {
  const scenario = scenarios.find(item => item.id === 'duration-variant')!
  const context = buildTurnInteractionContext({rawUserText: '这个', botId: '99', speaker,
    evidence: [{origin: 'current', kind: 'image', state: 'readable', text: scenario.readableImageText!}]})
  const prompt = buildTurnInteractionPrompt(context)
  assert.equal(context.kind, 'banter')
  assert.match(prompt, /十分钟/)
  assert.doesNotMatch(prompt, /两(?:个)?小时|硅脂/)
})

test('explicit seriousness wins over a bot quote and readable old joke', () => {
  const context = buildTurnInteractionContext({rawUserText: '不开玩笑，认真问，CPU 92℃ 怎么排查散热？', botId: '99', speaker,
    quote: {userId: '99', text: '这算电子体香吗？'},
    evidence: [{origin: 'forward', kind: 'text', state: 'readable', text: '这算赛博香水吗？'}]})
  assert.equal(context.kind, 'serious_answer')
  assert.equal(context.allowPlayfulness, false)
  assert.equal(context.previousBotReply?.source, 'quote')
  const updated = withTurnInteractionEvidence(context, [{origin: 'tool', kind: 'image', state: 'readable', text: '电子体香', toolName: 'imageReader'}])
  assert.equal(updated.kind, 'serious_answer')
  assert.equal(updated.allowPlayfulness, false)
})

test('quoted words from another bot are evidence without becoming this bot\'s previous reply', () => {
  const context = buildTurnInteractionContext({rawUserText: '这句什么意思', botId: '99', speaker,
    quote: {userId: '303', messageId: 'other-message', label: '另一只机器人', text: '我一般忘了吃。'},
    continuity: {botId: '303', lastReply: '我一般忘了吃。'}})
  assert.equal(context.target.kind, 'other')
  assert.equal(context.target.userId, '303')
  assert.equal(context.target.messageId, 'other-message')
  assert.equal(context.previousBotReply, undefined)
  assert.ok(context.evidence.some(item => item.origin === 'quote' && item.text === '我一般忘了吃。'))
  assert.doesNotMatch(buildTurnInteractionPrompt(context), /你确实说过的上句/)
})

test('only verified continuity from this bot supplies a previous stance', () => {
  const verified = buildTurnInteractionContext({rawUserText: '然后呢', botId: '99', speaker,
    continuity: {botId: '99', lastReply: '背景已经换成傍晚了。'}})
  assert.deepEqual(verified.previousBotReply, {text: '背景已经换成傍晚了。', source: 'verified_continuity'})
  const legacy = buildTurnInteractionContext({rawUserText: '然后呢', botId: '99', speaker,
    continuity: {lastReply: '归属未知的旧回复。'}})
  assert.equal(legacy.previousBotReply, undefined)
})

test('the previous stance belongs to this persona revision as well as this bot', () => {
  const persona = {personaId: 'first', personaVersion: 'v2', personaName: '甲'}
  const verified = buildTurnInteractionContext({rawUserText: '然后呢', botId: '99', speaker, persona,
    continuity: {botId: '99', persona: {...persona}, lastReply: '当前人格的新立场。'}})
  assert.deepEqual(verified.previousBotReply, {text: '当前人格的新立场。', source: 'verified_continuity'})
  for (const previous of [undefined, {...persona, personaId: 'second'}, {...persona, personaVersion: 'v1'}]) {
    const context = buildTurnInteractionContext({rawUserText: '然后呢', botId: '99', speaker, persona,
      continuity: {botId: '99', persona: previous, lastReply: '不属于当前人格版本的旧立场。'}})
    assert.equal(context.previousBotReply, undefined)
  }
  const unscoped = buildTurnInteractionContext({rawUserText: '然后呢', botId: '99', speaker,
    continuity: {botId: '99', persona, lastReply: '有明确人格来源的回复。'}})
  assert.equal(unscoped.previousBotReply, undefined, 'legacy callers cannot adopt a scoped stance without naming its persona')
})

test('a same-account quote with unknown or old persona provenance remains attributed evidence', () => {
  const persona = {personaId: 'current', personaVersion: 'v2', personaName: '当前人格'}
  for (const quotedPersona of [undefined, {...persona, personaId: 'old'}, {...persona, personaVersion: 'v1'}]) {
    const context = buildTurnInteractionContext({rawUserText: '你这句什么意思', botId: '99', speaker, persona,
      quote: {userId: '99', persona: quotedPersona, text: '我是原来那个人格。', messageId: 'same-bot-old-persona'}})
    assert.equal(context.target.kind, 'bot', 'the account attribution remains known')
    assert.equal(context.previousBotReply, undefined, 'the account alone does not prove the current persona said it')
    assert.ok(context.evidence.some(item => item.origin === 'quote' && item.speaker?.userId === '99' && item.text === '我是原来那个人格。'))
    const prompt = buildTurnInteractionPrompt(context)
    assert.match(prompt, /引用只证明标注账号说过这些话/)
    assert.doesNotMatch(prompt, /你确实说过的上句/)
  }
  const verified = buildTurnInteractionContext({rawUserText: '你这句什么意思', botId: '99', speaker, persona,
    quote: {userId: '99', persona: {...persona}, text: '这是当前人格自己的原话。'}})
  assert.deepEqual(verified.previousBotReply, {text: '这是当前人格自己的原话。', source: 'quote'})
})

test('a quote from a prior persona does not replace the current persona verified stance', () => {
  const persona = {personaId: 'current', personaVersion: 'v2', personaName: '当前人格'}
  const context = buildTurnInteractionContext({rawUserText: '那你现在怎么看', botId: '99', speaker, persona,
    quote: {userId: '99', persona: {...persona, personaVersion: 'v1'}, text: '旧版本原话。'},
    continuity: {botId: '99', persona, lastReply: '新版本已确认的上句。'}})
  assert.deepEqual(context.previousBotReply, {text: '新版本已确认的上句。', source: 'verified_continuity'})
  assert.ok(context.evidence.some(item => item.origin === 'quote' && item.text === '旧版本原话。'))
})

test('unavailable media only removes that evidence, leaving readable conversation and a specific gap', () => {
  const context = buildTurnInteractionContext({rawUserText: '我刚吃完，你们在说什么吃法？', botId: '99', speaker,
    quote: {userId: '202', text: '他们聊的是吃饭。'},
    evidence: [{origin: 'tool', kind: 'video', state: 'unavailable', toolName: 'videoReader'}]})
  assert.ok(context.evidence.some(item => item.kind === 'text' && item.state === 'readable' && item.text?.includes('吃饭')))
  assert.ok(context.evidence.some(item => item.kind === 'video' && item.state === 'unavailable'))
  const prompt = buildTurnInteractionPrompt(context)
  assert.match(prompt, /本轮未能读取/)
  assert.match(prompt, /仍可回应已知文字/)
  assert.match(prompt, /第二句若存在/)
})

test('explicit factual work remains serious when a joke is also requested', () => {
  for (const rawUserText of [
    '帮我计算一下运行两小时的电费，顺便吐槽这个电子体香',
    '请审查这份合同，赛博香水那段也看看'
  ]) {
    const context = buildTurnInteractionContext({rawUserText, botId: '99', speaker})
    assert.equal(context.kind, 'serious_answer', rawUserText)
    assert.equal(context.allowPlayfulness, false, rawUserText)
    assert.match(buildTurnInteractionPrompt(context), /当前需要认真回答/)
  }
  const pureJoke = buildTurnInteractionContext({rawUserText: '跑两小时就为了闻这个电子体香，帮我吐槽一下', botId: '99', speaker})
  assert.equal(pureJoke.kind, 'banter')
  assert.equal(pureJoke.allowPlayfulness, true)
})

test('perception from distinct calls survives a later failure from the same tool', () => {
  const initial = buildTurnInteractionContext({rawUserText: '这个', botId: '99', speaker})
  const first = withTurnInteractionEvidence(initial, [{origin: 'tool', kind: 'image', state: 'readable', text: '第一张图写着电子体香。', toolName: 'imageReader', toolCallId: 'image-call-1'}])
  const second = withTurnInteractionEvidence(first, [{origin: 'tool', kind: 'image', state: 'unavailable', toolName: 'imageReader', toolCallId: 'image-call-2'}])
  assert.ok(second.evidence.some(item => item.toolCallId === 'image-call-1' && item.state === 'readable' && item.text === '第一张图写着电子体香。'))
  assert.ok(second.evidence.some(item => item.toolCallId === 'image-call-2' && item.state === 'unavailable'))
  assert.equal(second.kind, 'banter', 'a second unread image does not invalidate the first readable image')
  const updated = withTurnInteractionEvidence(second, [{origin: 'tool', kind: 'image', state: 'readable', text: '第二张图也已读到。', toolName: 'imageReader', toolCallId: 'image-call-2'}])
  assert.equal(updated.evidence.filter(item => item.toolCallId === 'image-call-2').length, 1)
  assert.ok(updated.evidence.some(item => item.toolCallId === 'image-call-2' && item.state === 'readable'))
  assert.ok(updated.evidence.some(item => item.toolCallId === 'image-call-1' && item.state === 'readable'))
  assert.ok(second.evidence.some(item => item.toolCallId === 'image-call-2' && item.state === 'unavailable'), 'replacement does not mutate prior context')
})

test('perception without call identities appends instead of replacing prior same-tool evidence', () => {
  const initial = buildTurnInteractionContext({rawUserText: '这个', botId: '99', speaker})
  const first = withTurnInteractionEvidence(initial, [{origin: 'tool', kind: 'image', state: 'readable', text: '电子体香这个梗可读。', toolName: 'imageReader'}])
  const second = withTurnInteractionEvidence(first, [{origin: 'tool', kind: 'image', state: 'unavailable', toolName: 'imageReader'}])
  const results = second.evidence.filter(item => item.toolName === 'imageReader')
  assert.equal(results.length, 2)
  assert.ok(results.some(item => item.state === 'readable' && item.text === '电子体香这个梗可读。'))
  assert.ok(results.some(item => item.state === 'unavailable'))
})

test('readable results survive the evidence limit when a forward contains twenty-four image references', () => {
  const evidence: TurnEvidence[] = Array.from({length: 24}, (_, index) => ({origin: 'forward', kind: 'image', state: 'reference_only', source: `https://assets.example.invalid/forward-${index}.png`}))
  const initial = buildTurnInteractionContext({rawUserText: '这个', botId: '99', speaker, evidence})
  const resolved = withTurnInteractionEvidence(initial, [{origin: 'tool', kind: 'image', state: 'readable', text: '十分钟就开始散发赛博香水。', toolName: 'imageReader', toolCallId: 'new-readable-image'}])
  assert.ok(resolved.evidence.length <= 24)
  assert.ok(resolved.evidence.some(item => item.toolCallId === 'new-readable-image' && item.state === 'readable'))
  assert.ok(resolved.evidence.some(item => item.origin === 'current' && item.kind === 'text' && item.text === '这个'))
  assert.equal(resolved.kind, 'banter')
  assert.match(buildTurnInteractionPrompt(resolved), /十分钟/)
})

test('direct bot addressee wins over quoted and mentioned others without losing quote attribution', () => {
  const context = buildTurnInteractionContext({rawUserText: '你看他这句', botId: '99', speaker,
    quote: {userId: '303', label: '另一只机器人', messageId: 'other-bot-message', text: '我一般忘了吃。'},
    mentionUserIds: ['303'], addressee: {targetKind: 'bot'}})
  assert.deepEqual(context.target, {kind: 'bot', source: 'addressee', userId: '99'})
  assert.equal(context.previousBotReply, undefined)
  const quote = context.evidence.find(item => item.origin === 'quote')
  assert.deepEqual(quote?.speaker, {userId: '303', name: '另一只机器人'})
  assert.equal(quote?.messageId, 'other-bot-message')
  assert.equal(quote?.text, '我一般忘了吃。')
  const prompt = buildTurnInteractionPrompt(context)
  assert.match(prompt, /回应对象：bot（99）/)
  assert.doesNotMatch(prompt, /回应对象：other|你确实说过的上句/)
})

test('verified continuity confirms prior speech, not literal experiences or task progress', () => {
  const context=buildTurnInteractionContext({rawUserText:'刚才改背景的图出来了吗？',botId:'99',speaker,continuity:{botId:'99',lastReply:'收到，我先处理。'}})
  const prompt=buildTurnInteractionPrompt(context)
  assert.equal(context.previousBotReply?.source,'verified_continuity')
  assert.match(prompt,/这是发言记录，不独立证明实体经历或任务当前状态/)
  assert.match(prompt,/缺少结果时只说明尚未确认/)
})

test('a normal new report sharing the same noun and quantity does not become this bot\'s old joke', () => {
  const persona = {personaId: 'social-report', personaVersion: 'v1', personaName: '岚'}
  const scope = {botId: '99', persona, speaker, addressee: {targetKind: 'bot'}}
  const first = buildTurnInteractionContext({...scope, rawUserText: '开个玩笑，给你三块饼干当工资'})
  const lastReply = '三块饼干，先把工资口味选好，巧克力还是香草？'
  const continuity = {botId: '99', persona, lastReply, social: buildSocialContinuity(first, lastReply)}
  for (const rawUserText of ['我今天烤了三块饼干，给同事带的', '我同事今天也分到三块饼干', '对了，我朋友送来三块饼干，包装挺好看']) {
    const current = buildTurnInteractionContext({...scope, rawUserText, continuity})
    assert.equal(current.kind, 'conversation', rawUserText)
    assert.equal(current.social?.continuation, undefined, rawUserText)
    assert.equal(current.social?.activeBit, undefined, rawUserText)
    assert.equal(current.social?.pendingInteraction, undefined, 'the old wage question does not burden this separate report')
    assert.equal(current.rawUserText, rawUserText)
    assert.ok(buildTurnInteractionPrompt(current).includes(rawUserText))
  }
  for (const rawUserText of ['我今天先扣你两块饼干', '我刚把剩下那块饼干存起来了']) {
    const continuing = buildTurnInteractionContext({...scope, rawUserText, continuity})
    assert.equal(continuing.kind, 'banter', 'a direct action or same-object reference can still extend the joke')
    assert.equal(continuing.social?.continuation?.kind, 'bit')
  }
})

test('matching bot and persona ownership is required even when the current words match the old quantity joke', () => {
  const persona = {personaId: 'social-ownership', personaVersion: 'v2', personaName: '安序'}
  const scope = {botId: '99', persona, speaker}
  const first = buildTurnInteractionContext({...scope, rawUserText: '开个玩笑，给你三块饼干当工资'})
  const lastReply = '三块饼干归我，先别扣。'
  const continuity = {botId: '99', persona, lastReply, social: buildSocialContinuity(first, lastReply)}
  const own = buildTurnInteractionContext({...scope, rawUserText: '先扣两块', continuity, addressee: {targetKind: 'bot'}})
  assert.equal(own.social?.continuation?.kind, 'bit')
  for (const previous of [{...continuity, botId: '303'}, {...continuity, persona: {...persona, personaId: 'other'}}, {...continuity, persona: {...persona, personaVersion: 'v1'}}]) {
    const foreign = buildTurnInteractionContext({...scope, rawUserText: '先扣两块', continuity: previous, addressee: {targetKind: 'bot'}})
    assert.equal(foreign.social?.continuation, undefined)
    assert.equal(foreign.social?.previousStance, undefined)
  }
  const peer = buildTurnInteractionContext({...scope, rawUserText: '先扣两块', continuity,
    quote: {userId: '303', label: '另一个群友', text: '三块饼干是阿青给我的。'}})
  assert.equal(peer.target.kind, 'other')
  assert.equal(peer.social?.continuation, undefined, 'the same unit in a peer-directed exchange does not transfer this bot\'s stance')
  assert.ok(peer.evidence.some(item => item.origin === 'quote' && item.speaker?.userId === '303'))

  const serious = buildTurnInteractionContext({...scope, rawUserText: '帮我核算三块饼干的热量', continuity, addressee: {targetKind: 'bot'}})
  assert.equal(withTurnSocialInterpretation(serious, {act: 'teasing', confidence: 0.99}, 'understanding_model').kind, 'serious_answer')
  assert.equal(serious.social?.continuation, undefined)

  for (const [rawUserText, act] of [['这三块饼干能存多久？', 'factual_question'], ['这三块饼干让我很不舒服', 'criticism']] as const) {
    const ambiguous = buildTurnInteractionContext({...scope, rawUserText, continuity, addressee: {targetKind: 'bot'}})
    const resolved = withTurnSocialInterpretation(ambiguous, {act, confidence: 0.99}, 'understanding_model')
    assert.equal(resolved.kind, 'serious_answer', 'existing understanding may still recognize a genuine question or attitude change')
    assert.equal(resolved.social?.continuation, undefined)
    assert.equal(resolved.social?.activeBit, undefined)
  }
})

test('a third-party appraisal followed by a direct attention bid keeps each speaker\'s judgments separate', () => {
  const persona = {personaId: 'social-speaker-change', personaVersion: 'v1', personaName: '岚'}
  const scope = {botId: '99', persona, speaker, addressee: {targetKind: 'bot'}}
  const first = buildTurnInteractionContext({...scope, rawUserText: '这是小林在问阿青。你觉得是撒娇还是埋怨？',
    quote: {userId: '303', label: '小林', text: '阿青，你为什么不理我呀'}})
  assert.equal(first.social?.observedExchange?.speaker?.userId, '303')
  assert.match(buildTurnInteractionPrompt(first), /语气词只能支持倾向/)
  const lastReply = '我觉得语气偏软，不过单凭这一句还不能确定是不是埋怨。'
  const second = buildTurnInteractionContext({...scope, rawUserText: '轮到我了：你为什么不理我呀',
    continuity: {botId: '99', persona, lastReply, social: buildSocialContinuity(first, lastReply)}})
  assert.equal(second.social?.act, 'attention_bid')
  assert.equal(second.social?.observedExchange, undefined)
  assert.equal(second.target.kind, 'bot')
  assert.match(buildTurnInteractionPrompt(second), /不把自己的分析说成用户提出的标准/)
})
