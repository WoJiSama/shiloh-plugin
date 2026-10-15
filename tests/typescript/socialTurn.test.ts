import {test} from 'node:test'
import assert from 'node:assert/strict'
import type {InteractionTarget, SocialAct, TurnInteractionContext} from '../../src/contracts/turnInteraction.js'
import {buildSocialContinuity, buildSocialTurnPrompt, buildTurnInteractionContext, buildTurnInteractionPrompt, parseSocialInterpretation, withTurnInteractionEvidence, withTurnSocialInterpretation} from '../../src/modules/conversation/domain/turnInteractionContext.js'
import {buildPersonaTonePrompt, resolvePersonaReplyMode} from '../../src/modules/conversation/domain/personaTonePolicy.js'
import {createTimingGate, type TimingGateHost} from '../../src/modules/conversation/infrastructure/timingGate.js'
import {createGroupRuntime} from '../../src/modules/runtime/application/groupRuntime.js'
import {createPersonaSnapshot} from '../../src/modules/conversation/infrastructure/personaSnapshot.js'
import {createTurnPromptComposer} from '../../src/modules/conversation/infrastructure/turnPromptComposer.js'
import {resolvePromptLayerProfile} from '../../src/modules/conversation/domain/promptLayers.js'
import {classifyIntentWithModel} from '../../src/modules/conversation/application/modelIntentClassifier.js'
import {buildBriefMessages, parseUnderstandingSocial, requestUnderstandingBrief} from '../../src/modules/conversation/infrastructure/understandingBrief.js'
import {createPromptContext, type PromptContextHost} from '../../src/modules/conversation/infrastructure/promptContext.js'

const persona = {personaId: 'first', personaVersion: 'v2', personaName: '安序'}
const snapshot = createPersonaSnapshot({botId: '99', personaId: 'first', persona: {name: '安序', tone: '冷静简洁'}, systemContent: '独立判断'})
const contextFor = (rawUserText: string) => buildTurnInteractionContext({rawUserText, botId: '99', persona, addressee: {targetKind: 'bot'}})

test('attention and praise questions share social mode across local, tone and generation', () => {
  const attention = contextFor('你为什么不理我呀')
  assert.equal(attention.social?.act, 'attention_bid')
  assert.equal(attention.allowPlayfulness, false)
  assert.equal(resolvePersonaReplyMode({userText: attention.rawUserText, interactionContext: attention}), 'social')
  assert.equal(resolvePersonaReplyMode({userText: attention.rawUserText}), 'social', 'callers without a context use the same local inference')
  assert.match(buildPersonaTonePrompt({interactionContext: attention}), /关注诉求/)
  assert.match(buildTurnInteractionPrompt(attention), /希望被回应/)
  assert.doesNotMatch(buildPersonaTonePrompt({interactionContext: attention}), /科普、技术、事实/)
  assert.equal(resolvePersonaReplyMode({userText: '你是什么小机灵鬼'}), 'social')
  assert.equal(resolvePersonaReplyMode({userText: '你这次解释数据库真清楚，挺厉害的。'}), 'social')
})

test('real fact questions remain precise with and without shared context', () => {
  for (const rawUserText of ['为什么天空是蓝色的？', 'Redis是什么？', '这一版每月多少元？']) {
    const context = contextFor(rawUserText)
    assert.equal(context.social?.act, 'factual_question', rawUserText)
    assert.equal(resolvePersonaReplyMode({userText: rawUserText}), 'precise', rawUserText)
    assert.equal(resolvePersonaReplyMode({interactionContext: context}), 'precise', rawUserText)
  }
})

test('criticism is handled as a correction rather than a fact lecture or forced apology', () => {
  const context = contextFor('别再阴阳怪气，认真回答我')
  assert.equal(context.social?.act, 'criticism')
  assert.equal(context.allowPlayfulness, false)
  assert.equal(resolvePersonaReplyMode({interactionContext: context}), 'precise')
  const tone = buildPersonaTonePrompt({interactionContext: context})
  assert.match(tone, /认真回应具体不满/)
  assert.match(tone, /不默认承认没有证据的过错/)
  assert.doesNotMatch(tone, /本轮是科普|顺着已有前提转一下/)
  assert.doesNotMatch(buildTurnInteractionPrompt(context), /先给判断和必要依据、步骤/)
})

test('model teasing cannot override explicit work, danger, criticism or delivery', () => {
  const cases: [string, SocialAct][] = [
    ['不开玩笑，CPU 92℃ 还冒烟，怎么办？', 'help_request'],
    ['机箱烫手，帮我看看', 'help_request'],
    ['电源漏电怎么办', 'help_request'],
    ['帮我排查故障，顺便吐槽电子体香', 'help_request'],
    ['帮我计算运行两小时的电费，顺便吐槽电子体香', 'help_request'],
    ['讲讲数据库事务', 'help_request'],
    ['别再阴阳怪气，认真回答我', 'criticism'],
    ['发一下成图结果', 'delivery']
  ]
  for (const [text, expected] of cases) {
    const context = contextFor(text)
    const updated = withTurnSocialInterpretation(context, {act: 'teasing', confidence: 0.99, activeBit: '电子体香'}, 'gate_model')
    assert.equal(updated.social?.act, expected, text)
    assert.equal(updated.social?.source, 'local', text)
    assert.equal(updated.allowPlayfulness, false, text)
    assert.equal(updated.social?.activeBit, undefined, text)
  }
})

test('model target interpretation cannot replace explicit addressing or quote attribution', () => {
  const quoted = buildTurnInteractionContext({rawUserText: '你在说啥', botId: '99', persona,
    quote: {userId: '202', messageId: 'other-message', text: '通勤界的显眼包。'}})
  const unchanged = withTurnSocialInterpretation(quoted, {act: 'teasing', confidence: 0.95, target: 'bot'}, 'gate_model')
  assert.deepEqual(unchanged.target, quoted.target)
  assert.equal(unchanged.target.kind, 'other')
  const addressed = buildTurnInteractionContext({rawUserText: '看他这句话', botId: '99', persona, addressee: {targetKind: 'bot'},
    quote: {userId: '202', messageId: 'other-message', text: '通勤界的显眼包。'}})
  const direct = withTurnSocialInterpretation(addressed, {act: 'teasing', confidence: 0.95, target: 'other'}, 'intent_model')
  assert.equal(direct.target.kind, 'bot')
  assert.equal(direct.evidence.find(item => item.origin === 'quote')?.speaker?.userId, '202')
  assert.equal(direct.previousBotReply, undefined)
  const unknown = buildTurnInteractionContext({rawUserText: '你说呢', botId: '99', persona})
  assert.equal(withTurnSocialInterpretation(unknown, {act: 'conversation', confidence: 0.79, target: 'bot'}).target.kind, 'unknown')
  assert.deepEqual(withTurnSocialInterpretation(unknown, {act: 'conversation', confidence: 0.92, target: 'bot'}).target, {kind: 'bot', source: 'interpretation'})
  const first = withTurnSocialInterpretation(unknown, {act: 'conversation', confidence: 0.82, target: 'bot'})
  assert.equal(withTurnSocialInterpretation(first, {act: 'conversation', confidence: 0.95, target: 'other'}, 'understanding_model').target.kind, 'other', 'a stronger model inference may refine an earlier interpretation')
  assert.equal(withTurnSocialInterpretation(first, {act: 'conversation', confidence: 0.8, target: 'other'}, 'understanding_model').target.kind, 'bot', 'weaker hints do not replace an already resolved model target')
})

test('a protected local act keeps the model-resolved target across the scoped Gate handoff', () => {
  const text = '帮我排查CPU故障'
  const gate = withTurnSocialInterpretation(buildTurnInteractionContext({rawUserText: text, botId: '99', persona}),
    {act: 'teasing', confidence: 0.95, target: 'bot'}, 'gate_model')
  assert.equal(gate.social?.source, 'local')
  assert.equal(gate.social?.act, 'help_request')
  const turn = buildTurnInteractionContext({rawUserText: text, botId: '99', persona, social: gate.social})
  assert.equal(turn.social?.act, 'help_request')
  assert.equal(turn.social?.source, 'local')
  assert.equal(turn.target.kind, 'bot')
  assert.equal(turn.target.source, 'interpretation')
})

test('only grounded bit excerpts are accepted; model-authored pending questions and stance are discarded', () => {
  const context = buildTurnInteractionContext({rawUserText: '这个', botId: '99', persona, addressee: {targetKind: 'bot'},
    evidence: [{origin: 'forward', kind: 'text', state: 'readable', text: '通勤界的显眼包。', messageId: 'forward-bit'}]})
  const model = {act: 'teasing', confidence: 0.94, activeBit: '通勤界的显眼包', pendingInteraction: {text: '一起吃饭吗？'}, previousStance: {kind: 'playful', text: '我们从小认识。'}}
  const parsed = parseSocialInterpretation(model)!
  assert.deepEqual(Object.keys(parsed).sort(), ['act', 'activeBit', 'confidence'])
  const grounded = withTurnSocialInterpretation(context, model, 'understanding_model')
  assert.deepEqual(grounded.social?.activeBit, {text: '通勤界的显眼包', source: 'forward', messageId: 'forward-bit'})
  assert.equal(grounded.social?.pendingInteraction, undefined)
  assert.equal(grounded.social?.previousStance, undefined)
  const hallucinated = withTurnSocialInterpretation(context, {...model, activeBit: '昨天我们一起吃饭'}, 'understanding_model')
  assert.equal(hallucinated.social?.activeBit, undefined)
  const unread = buildTurnInteractionContext({rawUserText: '这个', evidence: [{origin: 'forward', kind: 'image', state: 'reference_only', text: '通勤界的显眼包'}]})
  assert.equal(withTurnSocialInterpretation(unread, model).social?.activeBit, undefined)
})

test('invalid and low-confidence social hints leave the existing context intact', () => {
  const context = contextFor('你为什么不理我呀')
  for (const value of [null, [], 'teasing', {act: 'bad', confidence: 1}, {act: 'unknown', confidence: 0.9}, {act: 'teasing', confidence: '0.9'}, {act: 'teasing', confidence: 0.7}, {act: 'teasing', confidence: 1.01}, {act: 'teasing', confidence: Number.NaN}]) {
    assert.equal(withTurnSocialInterpretation(context, value), context)
  }
})

test('confirmed social continuity preserves a real bit, question and stance only in its bot and persona revision', () => {
  const first = contextFor('这电子体香真绝')
  const reply = '这瓶电子体香预热挺快。你给它选哪个香调？'
  const social = buildSocialContinuity(first, reply)
  const continuity = {botId: '99', persona, lastReply: reply, social}
  const next = buildTurnInteractionContext({rawUserText: '然后呢', botId: '99', persona, continuity, addressee: {targetKind: 'bot'}})
  assert.equal(next.social?.act, 'teasing')
  assert.equal(next.social?.activeBit?.text, reply)
  assert.equal(next.social?.pendingInteraction?.text, '你给它选哪个香调？')
  assert.equal(next.social?.previousStance?.kind, 'playful')
  for (const wrong of [{...continuity, botId: '100'}, {...continuity, persona: {...persona, personaId: 'second'}}, {...continuity, persona: {...persona, personaVersion: 'v1'}}]) {
    const switched = buildTurnInteractionContext({rawUserText: '然后呢', botId: '99', persona, continuity: wrong, addressee: {targetKind: 'bot'}})
    assert.equal(switched.social?.activeBit, undefined)
    assert.equal(switched.social?.pendingInteraction, undefined)
    assert.equal(switched.social?.previousStance, undefined)
  }
  const serious = buildTurnInteractionContext({rawUserText: '帮我排查CPU故障', botId: '99', persona, continuity})
  assert.equal(serious.social?.activeBit, undefined)
  assert.equal(withTurnInteractionEvidence(serious, [{origin: 'tool', kind: 'image', state: 'readable', text: '电子体香'}]).social?.activeBit, undefined)
  const forged = buildTurnInteractionContext({rawUserText: '然后呢', botId: '99', persona,
    continuity: {...continuity, social: {activeBit: '昨天吃了饭', pendingInteraction: '今晚见面吗？', stance: 'playful'}}})
  assert.equal(forged.social?.activeBit, undefined)
  assert.equal(forged.social?.pendingInteraction?.text, '你给它选哪个香调？', 'fallback only extracts a question actually present in the confirmed reply')
})

test('perception enrichment preserves valid model interpretation and verified own speech without mutating the previous context', () => {
  const base = buildTurnInteractionContext({rawUserText: '然后呢', botId: '99', persona, addressee: {targetKind: 'bot'},
    continuity: {botId: '99', persona, lastReply: '通勤界的显眼包。你要听后半段吗？'}})
  const interpreted = withTurnSocialInterpretation(base, {act: 'teasing', confidence: 0.9, activeBit: '通勤界的显眼包'}, 'gate_model')
  const updated = withTurnInteractionEvidence(interpreted, [{origin: 'tool', kind: 'image', state: 'readable', text: '另一个可读细节'}])
  assert.equal(updated.social?.act, 'teasing')
  assert.equal(updated.social?.source, 'gate_model')
  assert.equal(updated.social?.activeBit?.text, '通勤界的显眼包')
  assert.equal(updated.social?.pendingInteraction?.text, '你要听后半段吗？')
  assert.equal(interpreted.evidence.some(item => item.origin === 'tool'), false)
})

function gateHarness(output: string, targetKind: InteractionTarget['kind'] = 'bot') {
  let calls = 0, system = '', tone: TurnInteractionContext | undefined
  const runtime = createTimingGate({
    logger: {warn() {}}, bot: () => ({uin: 99}), resolvePersonaName: () => '安序',
    computeAddresseeSignal: () => ({groupAddressed: targetKind === 'group', targetKind, pronounWithoutBotAnchor: false}),
    buildPersonaTonePrompt(input) {tone = input.interactionContext; return buildPersonaTonePrompt({userText: input.userText, ...(tone ? {interactionContext: tone} : {})})},
    getGroupTopicPrompt: () => '', getGroupSocialPrompt: () => '', detectAttentionHook: () => null,
    sideLLMCall: async options => {calls++; system = String(options?.messages?.[0]?.content); return {ok: true, content: output}}
  })
  const host: TimingGateHost = {
    config: {trackAiConfig: {trackAiUrl: 'https://example.invalid/v1', trackAiModel: 'fixture', trackAiApikey: 'fixture'}},
    getPersonaSnapshotFor: () => snapshot, getPersonaFor: () => snapshot.persona,
    messageManager: {formatMessageHistory: async () => '群友: 最近的对话。'}, computeGroupMsgRate5min: () => 0
  }
  const group = createGroupRuntime<ReturnType<typeof setTimeout>, null, null>({now: () => 1000, cancelTimer: clearTimeout, peekTopic: () => null, peekSocial: () => null})
  const state = {...group.getSmartRuntimeState('g'), rerunEvent: null}
  return {runtime, host, state, calls: () => calls, system: () => system, tone: () => tone}
}

test('Gate piggybacks social on one existing request and uses the shared local tone before asking', async () => {
  const fixture = gateHarness('{"decision":"continue","social":{"act":"attention_bid","confidence":0.93,"target":"bot"}}')
  const result = await fixture.runtime.runTimingGate(fixture.host, {group_id: 'g', user_id: 7, self_id: 99, msg: '你为什么不理我呀'}, fixture.state)
  assert.equal(fixture.calls(), 1)
  assert.equal(fixture.tone()?.social?.act, 'attention_bid')
  assert.match(fixture.system(), /共享互动状态|关注诉求/)
  assert.match(fixture.system(), /"social"/)
  assert.equal(result.social?.act, 'attention_bid')
  assert.equal(result.social?.source, 'gate_model')
  assert.equal(result.personaSnapshot, snapshot)
})

test('Gate accepts legacy JSON and rejects corrupt or weak social without a second request', async () => {
  for (const extra of ['', ',"social":{"act":"teasing","confidence":0.2}', ',"social":{"act":"fake","confidence":1}', ',"social":null']) {
    const fixture = gateHarness(`{"decision":"continue"${extra}}`)
    const result = await fixture.runtime.runTimingGate(fixture.host, {group_id: 'g', msg: '你为什么不理我呀'}, fixture.state)
    assert.equal(result.decision, 'continue')
    assert.equal(result.social?.act, 'attention_bid')
    assert.equal(result.social?.source, 'local')
    assert.equal(fixture.calls(), 1)
  }
})

test('Gate refuses another person as addressee, while an explicit bot addressee still wins over the quote', async () => {
  const output = '{"decision":"continue","social":{"act":"teasing","confidence":0.99,"target":"bot"}}'
  const other = gateHarness(output, 'unknown')
  const event = {group_id: 'g', user_id: 7, self_id: 99, msg: '你说呢', source: {user_id: 202, text: '通勤界的显眼包。'}}
  assert.equal((await other.runtime.runTimingGate(other.host, event, other.state)).decision, 'no_action')
  const direct = gateHarness(output, 'bot')
  const result = await direct.runtime.runTimingGate(direct.host, {...event, message: [{type: 'at', qq: 99}]}, direct.state)
  assert.equal(result.decision, 'continue')
  assert.equal(result.social?.target.kind, 'bot')
})

test('intent classification returns validated optional social from the same HTTP JSON response', async () => {
  let calls = 0, system = ''
  const fetchImpl: typeof fetch = async (_url, init) => {
    calls++
    const body = JSON.parse(String(init?.body)) as {messages: {content: string}[]}
    system = body.messages[0]!.content
    return new Response(JSON.stringify({choices: [{message: {content: JSON.stringify({intent: 'chat', confidence: 0.95,
      social: {act: 'attention_bid', confidence: 0.94, pendingInteraction: '凭空的问题'}})}}]}))
  }
  const result = await classifyIntentWithModel({text: '你为什么不理我呀', config: {intentAiConfig: {intentAiUrl: 'https://example.invalid/v1', intentAiApikey: 'fixture', intentAiModel: 'fixture'}}, fetchImpl})
  assert.equal(calls, 1)
  assert.equal(result.intent, 'chat')
  assert.deepEqual(result.social, {act: 'attention_bid', confidence: 0.94})
  assert.match(system, /social/)
})

const brief = '【用户意图】延续群聊中的比喻\n【指代消解】指刚才的形容\n【需要上下文】原话中的比喻\n【语气关系】调侃，熟悉程度无依据'

test('understanding keeps the four-section legacy brief and safely parses only its optional JSON social line', async () => {
  const modelText = `${brief}\n【社交判读】{"act":"teasing","confidence":0.94,"target":"bot","activeBit":"通勤界的显眼包","previousStance":{"text":"凭空回忆"}}`
  const expected = {act: 'teasing', confidence: 0.94, target: 'bot', activeBit: '通勤界的显眼包'}
  assert.deepEqual(parseUnderstandingSocial(modelText), expected)
  assert.equal(parseUnderstandingSocial(`${brief}\n【社交判读】{破损JSON}`), undefined)
  assert.equal(parseUnderstandingSocial(`${brief}\n【社交判读】{"act":"teasing","confidence":0.3}`), undefined)
  let calls = 0
  const result = await requestUnderstandingBrief({apiUrl: 'https://example.invalid/v1', apiKey: 'fixture', model: 'fixture',
    fetchImpl: async () => {calls++; return new Response(JSON.stringify({choices: [{message: {content: modelText}}]}))}})
  assert.equal(calls, 1)
  assert.equal(result.ok, true)
  assert.equal(result.brief, brief)
  assert.deepEqual(result.social, expected)
  const malformed = await requestUnderstandingBrief({apiUrl: 'https://example.invalid/v1', apiKey: 'fixture', model: 'fixture',
    fetchImpl: async () => new Response(JSON.stringify({choices: [{message: {content: `${brief}\n【社交判读】{\n"previousStance":"凭空回忆"\n}`}}]}))})
  assert.equal(malformed.ok, true)
  if (malformed.ok) {
    assert.equal(malformed.brief, brief)
    assert.equal(malformed.social, undefined)
  }
  assert.match(buildBriefMessages()[0]!.content, /熟悉程度没有证据就写无/)
})

test('ambiguous chat reuses the actual understanding adapter and updates shared state before prompt composition', async () => {
  let requests = 0
  const api = createPromptContext({formatAvatarDrawReferencePrompt: () => '', info() {}, fetchBrief: async (_url, init) => {
    requests++
    assert.match(String(init?.body), /当前共享互动状态尚有语用或对象歧义/)
    return new Response(JSON.stringify({choices: [{message: {content: `${brief}\n【社交判读】{"act":"teasing","confidence":0.94,"target":"bot","activeBit":"通勤界的显眼包"}`}}]}))
  }})
  const host: PromptContextHost = {
    config: {intentAiConfig: {intentAiUrl: 'https://example.invalid/v1', intentAiApikey: 'fixture', intentAiModel: 'fixture'}},
    getUnderstandingEnhancementConfig: () => api.getUnderstandingEnhancementConfig(host),
    shouldInjectUnderstandingContext: context => api.shouldInjectUnderstandingContext(host, context),
    gatherUnderstandingMaterials: context => api.gatherUnderstandingMaterials(host, context),
    buildUnderstandingContextPrompt: context => api.buildUnderstandingContextPrompt(host, context),
    getQuotedPromptContextText: (event, text) => api.getQuotedPromptContextText(host, event, text),
    getRecentPromptContextText: (messages, text, max) => api.getRecentPromptContextText(host, messages, text, max),
    extractForwardContextFromUserContent: text => api.extractForwardContextFromUserContent(host, text),
    getRecentDrawContextText: () => '', buildImageGenerationPrompt: () => ''
  }
  const session = {interactionContext: buildTurnInteractionContext({rawUserText: '这个', botId: '99', persona, addressee: {targetKind: 'bot'},
    evidence: [{origin: 'forward', kind: 'text', state: 'readable', text: '通勤界的显眼包。'}]})}
  assert.equal(session.interactionContext.social?.needsDisambiguation, true)
  const card = await api.resolveUnderstandingPrompt(host, {msg: '这个', currentIntentText: '这个', userContent: '这个', session,
    groupUserMessages: [{role: 'user', content: '群友: 通勤界的显眼包。'}]})
  assert.equal(requests, 1)
  assert.match(card, /理解简报/)
  assert.equal(session.interactionContext.social?.source, 'understanding_model')
  assert.equal(session.interactionContext.social?.act, 'teasing')
  assert.equal(session.interactionContext.social?.activeBit?.text, '通勤界的显眼包')
  assert.equal(session.interactionContext.social?.needsDisambiguation, false)
  assert.equal(resolvePersonaReplyMode({interactionContext: session.interactionContext}), 'social')
  assert.match(buildSocialTurnPrompt(session.interactionContext.social), /通勤界的显眼包/)
  const composed = await createTurnPromptComposer().composeTurnPromptLayers({config: {}, personaSnapshot: snapshot,
    profile: resolvePromptLayerProfile({modelIntent: 'chat'}), turn: {interactionContext: session.interactionContext}})
  assert.match(composed.prompt, /调侃接梗/)
  assert.match(composed.layerValues.personaTone!, /普通群聊/)
  assert.equal(composed.layerValues.solutionExplanation, '')
  assert.equal(api.shouldInjectUnderstandingContext(host, {userContent: '你好', session: {interactionContext: contextFor('你好')}}), false, 'ordinary chat does not add a fixed understanding request')
})

test('composer does not let quoted technical nouns or random mood override the shared social purpose', async () => {
  const banter = contextFor('本地模型运行十分钟，为什么像赛博香水？')
  const composer = createTurnPromptComposer()
  const result = await composer.composeTurnPromptLayers({config: {}, personaSnapshot: snapshot, profile: resolvePromptLayerProfile({hasImages: true}),
    turn: {messageText: banter.rawUserText, toneText: banter.rawUserText, interactionContext: banter}})
  assert.equal(result.layerValues.solutionExplanation, '')
  assert.match(result.layerValues.personaTone!, /普通群聊/)
  assert.doesNotMatch(result.prompt, /当前是技术方案、实现、排障/)
  const task = contextFor('帮我排查本地模型为什么异常退出')
  const serious = await composer.composeTurnPromptLayers({config: {}, turn: {toneText: task.rawUserText, interactionContext: task}})
  assert.match(serious.layerValues.solutionExplanation!, /方案式技术解释/)
  const attention = contextFor('你为什么不理我呀')
  const focused = await composer.composeTurnPromptLayers({config: {}, turn: {interactionContext: attention, moodHint: {name: '兴奋', hint: '多调侃一句'}}})
  assert.doesNotMatch(focused.layerValues.personaTone!, /本回合心情/)
  assert.match(focused.layerValues.personaTone!, /关注诉求/)
})
