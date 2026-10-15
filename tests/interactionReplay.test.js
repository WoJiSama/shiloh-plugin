// Offline replay of the real turn/composer/final-reply path. Stub replies test
// contracts and preservation, not the language model's conversational quality.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {createChatTurn} from '../dist/backend/modules/tools/infrastructure/chatTurn.js'
import {createTurnPromptComposer} from '../dist/backend/modules/conversation/infrastructure/turnPromptComposer.js'
import {buildMainSystemPrompt} from '../dist/backend/modules/conversation/domain/systemPromptTemplate.js'
import {resolvePromptLayerProfile} from '../dist/backend/modules/conversation/domain/promptLayers.js'
import {resolveGroupContextAssets, formatGroupContextImagePrompt} from '../dist/backend/modules/conversation/infrastructure/groupContextResolver.js'
import {createFinalReply} from '../dist/backend/modules/conversation/application/finalReply.js'
import {createOutputGuardPipeline} from '../dist/backend/modules/conversation/application/outputGuardPipeline.js'
import {recordTurnContinuity, loadTurnContinuity, buildTurnContinuityPrompt} from '../dist/backend/modules/conversation/application/turnContinuity.js'
import {planTextReplyMessages} from '../dist/backend/modules/conversation/domain/replyRhythm.js'
import {createTurnPlan, deriveTurnPlanRequest, formatTurnPlanLog} from '../dist/backend/modules/conversation/infrastructure/turnPlan.js'
import {buildChatRequestData} from '../dist/backend/modules/models/domain/modelGateway.js'
import {modelExecutor} from './helpers/modelExecutor.js'

const scenarios = JSON.parse(fs.readFileSync(new URL('./fixtures/interactionReplayScenarios.json', import.meta.url), 'utf8'))
let fixtureId = 0

function fixture(scenario, {confirmed = true, directToBot = false, realPlanning = false, gatewayConfig, optionalEmoji = false} = {}) {
  const groupId = 900000 + ++fixtureId
  const captures = {compose: [], guards: [], requests: [], planInputs: [], gatewayRequests: [], loads: [], writes: [], episodes: [], archived: [], saved: [], enhanced: [], sent: [], errors: [], mainCalls: 0, intentCalls: 0}
  const logger = {info() {}, warn() {}, debug() {}, error(message, error) { captures.errors.push({message, error}) }}
  const trace = {id: `replay-${groupId}`, setTrigger() {}, setIntent() {}, addModelCall() {}, addTool() {}, finish: () => ({modelCalls: [], tools: []})}
  const members = new Map([[99, {user_id: 99, nickname: '测试机器人', role: 'member'}], [202, {user_id: 202, nickname: '测试群友', role: 'member'}], [303, {user_id: 303, nickname: '另一只机器人', role: 'member'}]])
  const group = {group_name: '脱敏回放群', getMemberMap: async () => members, pickMember: id => ({info: members.get(Number(id)) || {}})}
  const event = {message_type: 'group', group_id: groupId, user_id: 202, self_id: 99, message_id: `input-${groupId}`, msg: scenario.rawUserText,
    message: [{type: 'text', text: scenario.rawUserText}], sender: members.get(202), group,
    bot: {uin: 99, nickname: '测试机器人', pickGroup: () => group}}
  if (scenario.imageSource) event.message.push({type: 'image', url: scenario.imageSource})
  if (scenario.videoSource) event.message.push({type: 'video', url: scenario.videoSource})
  if (scenario.quote) {
    const quote = scenario.quote
    event.reply_id = quote.messageId
    event.getReply = async () => ({message_id: quote.messageId, user_id: quote.userId,
      sender: {user_id: quote.userId, nickname: quote.name}, message: [{type: 'text', text: quote.text}]})
    event._quotedPromptContext = {text: quote.text, messageId: quote.messageId, userId: quote.userId, senderUserId: quote.userId, senderName: quote.name}
  }
  const availableTools = optionalEmoji ? [{type: 'function', function: {name: 'sendLocalEmojiTool', description: '可选表情反应', parameters: {type: 'object', properties: {}}}}] : []
  const session = {tools: availableTools, groupUserMessages: []}
  const storage = new Map()
  const redis = {get: async key => storage.get(key) ?? null, set: async (key, value) => { storage.set(key, value) }}
  const composer = createTurnPromptComposer(logger)
  const guards = createOutputGuardPipeline({manager: {guardReply: text => text}, info() {}})
  const final = createFinalReply({
    randomUUID: () => `tool-${groupId}`, logger, bot: () => event.bot,
    buildGenericChatFailureReply: () => '未取得结果。', extractModrinthForwardItems: () => [], stripModrinthForwardMarkers: text => text,
    applyOutputPersonaGuards: (text, options) => { captures.guards.push(options); return guards.applyOutputPersonaGuards(text, options) },
    findRecentBotImage: async () => null,
    recordEpisode: options => captures.episodes.push(options),
    recordTurnContinuity: async options => { captures.writes.push(options); return recordTurnContinuity({...options, redis}) },
    getActiveConversation: () => undefined, trackingKey: e => `${e.self_id}:${e.group_id}:${e.user_id}`,
    rememberPersonaReply() {}, rememberStyleReply() {}
  })
  const gateway = gatewayConfig ? modelExecutor(async (url, options) => {
    captures.gatewayRequests.push({url, body: JSON.parse(options.body)})
    return new Response(JSON.stringify({choices: [{message: {role: 'assistant', content: scenario.modelReply}}]}))
  }) : null
  const host = {
    config: {enabled: true, groupHistory: true, systemContent: '你是测试机器人。', persona: {name: '测试机器人'}, promptLayerCache: {enabled: false},
      episodicMemory: {enabled: true, proactiveEnabled: false}, memorySystem: {enabled: false}, emotionSystem: {enabled: false}, expressionLearning: {enabled: false}, personProfileInjection: {enabled: false}, ...gatewayConfig},
    tools: availableTools, toolInstances: {}, _groupLimiters: new Map(),
    isUserBlacklisted: () => false, scheduleMergedToolRequest: () => true, refreshLocalToolRegistry: async () => {}, waitForMCPReady: async () => {},
    beginConversationTask: async () => ({messageId: event.message_id}), getOrCreateSession: () => session, clearSession() {},
    handleActiveDrawStatusQuestion: async () => false,
    buildMessageContent: async (_sender, args, images) => `[2026-01-01 12:00:00] 测试群友(qq号:202)[群身份:member]: 在群里说: ${args}${images.length ? '\n[图片素材引用]' : ''}${scenario.quote ? `\n[回复 ${scenario.quote.name} 的消息: ${scenario.quote.text}]` : ''}`,
    resolvePrimaryModelIntent: async () => { captures.intentCalls++; return null },
    getSmartState: () => ({}), getPersonaFor: () => ({name: '测试机器人'}), getChatConfig() { return this.config },
    getCurrentGroupContext: async () => ({groupId, groupName: '脱敏回放群'}), getBasicGroupContext: () => ({groupId, groupName: '脱敏回放群'}),
    buildMergedDirectTriggerPrompt: () => '',
    messageManager: {getMessages: async () => [], recordMessage: async record => captures.archived.push(record)},
    getTaskStatus: async () => null, formatTaskStatusForPrompt: () => '', resolveUnderstandingPrompt: async () => '',
    trimMessageHistory: messages => messages, filterChatByQQ: messages => messages, formatMessages: messages => messages,
    getToolsByName: names => availableTools.filter(tool => names.includes(tool.function.name)), getImageGenerationReferenceImages: images => images,
    retryRequest: async (requestData, toolContent, _retries, toolName, options) => {
      captures.mainCalls++
      return gateway ? gateway.YTapi(requestData, host.config, toolContent, toolName, options) : {choices: [{message: {content: scenario.modelReply}}]}
    },
    buildMissingToolCommitmentCall: () => null,
    handleTextResponse: (text, e, current, messages) => final.handleTextResponse(host, text, e, current, messages),
    processToolSpecificMessage: text => text, getTextImageTemplateForFinalReply: () => false,
    sendSegmentedMessage: async (_e, text) => { captures.sent.push(text); return confirmed ? `reply-${groupId}` : null },
    sendObservedReply: async () => { throw new Error('unexpected platform send') },
    saveGroupUserMessages: async (...args) => captures.saved.push(args), updateEnhancedSystems: async (...args) => captures.enhanced.push(args),
    finishConversationTask: async () => {}, recordReplyLatency() {}, formatTime: () => '12:00', setTrackingWithTimer() {}
  }
  const ports = {
    logger, botIdentity: e => e.bot, isAiConversationEnabled: () => true, evaluatePrivateChatGate: () => ({allowed: true}),
    resolveConversationContext: e => ({kind: 'group', botId: String(e.self_id), userId: String(e.user_id), conversationId: `group:${e.group_id}`, groupId: String(e.group_id)}),
    createTurnTrace: () => trace, resolveTurnTraceArchiveDir: () => '/tmp',
    createOutboundArbiter: () => ({wrapEvent: e => e, beginToolOutcomes() {}, enqueue() {}, settle() {}, resolveToolOutcomes() {}}),
    getOrCreateGroupLimiter: () => task => task(), cacheGroupName: async () => {}, resolveGroupContextAssets, formatGroupContextImagePrompt,
    TakeImages: async () => [], shouldRequireImageEditBase: () => false, resolveRecentBotImage: async () => null, resolveRecentUserImage: async () => null,
    prepareImageEditAssets: () => null, resolveAvatarEditBase: () => null, resolveAvatarInspectionTargets: () => null, resolveAvatarDrawReference: () => null,
    shouldAskForMissingImageForVisualRequest: () => false, selectToolIntentCandidates: () => [], shouldSkipIntentModel: () => true,
    resolveDeterministicToolIntent: () => null, hasExcelWorkbookContext: () => false, hasRecentPixivSearch: () => false,
    loadTurnContinuity: async options => { captures.loads.push(options); return loadTurnContinuity({...options, redis}) },
    computeAddresseeSignal: () => ({targetKind: directToBot ? 'bot' : scenario.quote && scenario.quote.userId !== '99' ? 'other' : 'bot'}), buildAddresseePrompt: () => '',
    resolvePromptLayerProfile, buildTurnContinuityPrompt, delay: async () => {},
    formatGroupWorkflowTeachingPrompt: () => '', formatGroupKnowledgeTeachingPrompt: () => '', formatIdentityBindingsPrompt: () => '',
    mcpManager: {getMCPSystemPrompts: () => ''}, rollPersonaMood: () => null, getMidtermMemoryManager: () => null,
    composeTurnPromptLayers: async options => { captures.compose.push(options); return composer.composeTurnPromptLayers(options) },
    getGroupTopicPrompt: () => '', getGroupSocialPrompt: () => '', getSemanticMemoryRuntime: () => null, hasTemporalDeixis: () => false,
    recallUserEpisodes: () => [], buildUserCallbackPrompt: () => '', buildMainSystemPrompt, containsInternalStatusLeak: () => false,
    resolveHistorySelectionBudget: () => ({mode: 'compact', recentCount: 3, relevantCount: 0, maxMessages: 3}), selectRelevantGroupHistory: messages => messages,
    shouldUseExcelWorkbookTool: () => false, buildExcelToolParams: () => null,
    resolveToolRoute: async () => ({toolChoice: optionalEmoji ? 'auto' : 'none', forcedToolCall: null, toolScopeLocked: !optionalEmoji, applied: []}),
    // Keep a preselected reaction candidate eligible so the real turn plan must
    // resolve the conflict between serious interaction and optional expression.
    filterToolsForMessageIntent: tools => tools,
    createTurnPlan: input => {
      captures.planInputs.push(input)
      return realPlanning ? createTurnPlan(input) : {id: `plan-${groupId}`, intent: 'chat', execution: {mode: 'chat', modelProfile: 'chat', toolChoice: 'none'},
        capabilities: {required: [], optional: [], available: []}, context: {historyMode: 'compact', selectedHistoryCount: 0}, presentation: {kind: 'text'}, observability: {routeReason: 'offline_replay'}}
    },
    isEducationalExplanationRequest: () => false, classifyEmojiToolExposure: () => '', resolveCardPresentation: () => '',
    deriveTurnPlanRequest: realPlanning ? deriveTurnPlanRequest : () => ({toolChoice: 'none'}), formatTurnPlanLog: realPlanning ? formatTurnPlanLog : () => '', cardAcknowledgement: () => '', buildToolIntentDisclosure: () => '',
    buildChatRequestData: (_config, messages, tools, choice) => {
      captures.requests.push(structuredClone(messages))
      return realPlanning ? buildChatRequestData(_config, messages, tools, choice) : {messages, tools, tool_choice: choice}
    },
    collectThinking() {}, extractEmbeddedToolCalls: () => ({calls: [], remainder: ''}), sendThinkingForward: async () => {},
    recordTurnDiagnostics() {}, buildCommittedActionReply: () => '', buildDrawFailureNoteMessage: () => '', takeDrawFailureNote: () => null
  }
  const api = createChatTurn(ports)
  return {api, host, event, session, captures,
    run: () => api.handleToolInner(host, event),
    seedContinuity: (record = scenario.continuity) => record ? recordTurnContinuity({...record, groupId, userId: 202, redis}) : Promise.resolve(),
    readContinuity: (botId = '99') => loadTurnContinuity({groupId, userId: 202, botId, redis})}
}

for (const scenario of scenarios) {
  test(`offline interaction replay preserves boundaries through the real reply path: ${scenario.id}`, async () => {
    const f = fixture(scenario)
    await f.seedContinuity()
    assert.equal(await f.run(), true)
    assert.deepEqual(f.captures.errors, [])
    assert.equal(f.captures.mainCalls, 1)
    assert.equal(f.captures.intentCalls, 0, 'the lightweight interaction context must not introduce another model request')
    assert.equal(f.session.rawUserText, scenario.rawUserText)
    assert.notEqual(f.session.userContent, scenario.rawUserText, 'the model transport wrapper is distinct from current user words')
    const context = f.session.interactionContext
    assert.equal(context.kind, scenario.expectedKind)
    assert.equal(context.rawUserText, scenario.rawUserText)
    assert.equal(f.captures.compose[0].turn.interactionContext, context)
    assert.equal(f.captures.guards[0].interactionContext, context)
    assert.equal(f.captures.guards[0].userText, scenario.rawUserText)
    const system = f.captures.requests[0].find(message => message.role === 'system').content
    assert.match(system, /【本轮互动】/)
    assert.ok(system.includes(scenario.rawUserText))
    assert.deepEqual(f.captures.sent, [scenario.modelReply], 'stub output is preserved; its creativity is not an automated claim')
    assert.equal(f.captures.archived.length, 1)
    assert.equal(f.captures.episodes[0].summary, scenario.rawUserText)
    assert.equal(String(f.captures.writes[0].botId), '99')
    assert.equal(String(f.captures.loads[0].botId), '99')
    assert.equal((await f.readContinuity()).lastReply, scenario.modelReply)
    assert.equal(await f.readContinuity('303'), null, 'another bot must not inherit the confirmed reply')
    if (scenario.imageSource) {
      const image = context.evidence.find(item => item.kind === 'image')
      assert.equal(image.state, 'reference_only')
      assert.equal(image.text, undefined)
      assert.match(system, /证据 current\/image：仅有素材引用/)
      assert.doesNotMatch(system, /仅凭图片链接就已看过|硅脂/)
    }
    if (scenario.id === 'duration-variant') assert.doesNotMatch(system, /两(?:个)?小时/)
    if (scenario.videoSource) {
      const video = context.evidence.find(item => item.kind === 'video')
      assert.equal(video.state, 'reference_only')
      assert.match(system, /证据 current\/video：仅有素材引用/)
      assert.equal(context.previousBotReply, undefined)
      assert.equal(context.target.kind, 'other')
      assert.ok(system.includes('他俩吃饭像饕餮。'))
    }
    if (scenario.id === 'serious-cooling-fault') {
      assert.equal(context.allowPlayfulness, false)
      assert.equal(context.previousBotReply.text, scenario.quote.text)
      assert.match(system, /当前需要认真回答/)
    }
    if (scenario.id === 'delivery-second-beat') {
      assert.equal(context.previousBotReply.text, scenario.continuity.lastReply)
      assert.equal(context.previousBotReply.source, 'verified_continuity')
      assert.deepEqual(planTextReplyMessages(f.captures.sent[0], {userText: scenario.rawUserText}).messages,
        ['背景已经换成傍晚了。', '你看看这次的光线合不合适。'])
    }
  })
}

test('uncertain delivery leaves no confirmed stance, episode, archive or learning', async () => {
  const scenario = scenarios.find(item => item.id === 'ordinary-refusal')
  const f = fixture(scenario, {confirmed: false})
  assert.equal(await f.run(), true)
  assert.deepEqual(f.captures.errors, [])
  assert.equal(f.session.responseAttempted, true)
  assert.deepEqual(f.captures.sent, [scenario.modelReply])
  assert.deepEqual(f.captures.writes, [])
  assert.deepEqual(f.captures.episodes, [])
  assert.deepEqual(f.captures.archived, [])
  assert.deepEqual(f.captures.saved, [])
  assert.deepEqual(f.captures.enhanced, [])
  assert.equal(await f.readContinuity(), null)
})

test('an unrelated bot continuity record cannot seed this bot\'s reply stance', async () => {
  const scenario = scenarios.find(item => item.id === 'ordinary-refusal')
  const f = fixture(scenario)
  await f.seedContinuity({botId: '303', lastReply: '我一般忘了吃。'})
  assert.equal(await f.run(), true)
  assert.equal(f.session.interactionContext.previousBotReply, undefined)
  const system = f.captures.requests[0].find(message => message.role === 'system').content
  assert.doesNotMatch(system, /我一般忘了吃/)
})

test('current text segments survive a long metadata wrapper and quoted first-person text', async () => {
  const scenario = scenarios.find(item => item.id === 'ordinary-refusal')
  const f = fixture(scenario)
  f.event.msg = `[引用记录与元数据:${'很长的引用说明'.repeat(40)}] ${scenario.rawUserText}`
  assert.equal(await f.run(), true)
  assert.deepEqual(f.captures.errors, [])
  assert.ok(f.session.userContent.length > 120)
  assert.equal(f.session.rawUserText, scenario.rawUserText)
  assert.equal(f.captures.guards[0].userText, scenario.rawUserText)
  assert.equal(f.captures.episodes[0].summary, scenario.rawUserText)
  assert.equal(f.captures.enhanced[0][1], scenario.rawUserText)
})

test('data.text message segments preserve the same user words and guard context as top-level text', async () => {
  const scenario = scenarios.find(item => item.id === 'ordinary-refusal')
  const topLevel = fixture(scenario)
  const nested = fixture(scenario)
  nested.event.message = [{type: 'text', data: {text: scenario.rawUserText}}]
  nested.event.msg = `[传输元数据:${'不属于正文'.repeat(40)}]`
  assert.equal(await topLevel.run(), true)
  assert.equal(await nested.run(), true)
  assert.deepEqual(nested.captures.errors, [])
  assert.equal(nested.session.rawUserText, topLevel.session.rawUserText)
  assert.equal(nested.session.interactionContext.rawUserText, scenario.rawUserText)
  assert.equal(nested.session.interactionContext.kind, topLevel.session.interactionContext.kind)
  assert.equal(nested.captures.guards[0].userText, topLevel.captures.guards[0].userText)
  assert.equal(nested.captures.episodes[0].summary, topLevel.captures.episodes[0].summary)
  assert.equal(nested.captures.enhanced[0][1], scenario.rawUserText)
  assert.deepEqual(nested.captures.sent, topLevel.captures.sent)
})

test('an explicit bot mention keeps the response directed to the bot while an other-bot quote stays attributed', async () => {
  const scenario = scenarios.find(item => item.id === 'unread-video-keeps-text')
  const f = fixture(scenario, {directToBot: true})
  f.event.message.unshift({type: 'at', qq: 99})
  f.event.message.push({type: 'at', qq: 303})
  assert.equal(await f.run(), true)
  assert.deepEqual(f.captures.errors, [])
  assert.deepEqual(f.session.interactionContext.target, {kind: 'bot', source: 'addressee', userId: '99'})
  assert.equal(f.session.interactionContext.previousBotReply, undefined)
  const quote = f.session.interactionContext.evidence.find(item => item.origin === 'quote' && item.kind === 'text')
  assert.deepEqual(quote.speaker, {userId: '303', name: scenario.quote.name})
  assert.equal(quote.messageId, scenario.quote.messageId)
  assert.equal(quote.text, scenario.quote.text)
  const system = f.captures.requests[0].find(message => message.role === 'system').content
  assert.match(system, /回应对象：bot（99）/)
  assert.doesNotMatch(system, /回应对象：other/)
  assert.ok(system.includes(scenario.quote.text))
})

function reasoningGatewayConfig(complexReasoningEffort = 'high') {
  return {
    providers: 'oneapi', useTools: false,
    chatAiConfig: {chatApiUrl: 'https://base.invalid/v1', chatApiModel: 'base-reply', chatApiKey: 'fixture-base-key', chatReasoningEffort: 'low', complexReasoningEffort},
    taskAiConfig: {casual: {apiUrl: 'https://casual.invalid/v1', model: 'casual-reply', apiKey: 'fixture-casual-key', reasoningEffort: 'low'}}
  }
}

test('short serious cooling questions reach high reasoning at the real model request despite an optional reaction', async () => {
  const scenario = {rawUserText: 'CPU已经92℃了，怎么散热？', modelReply: '先停止满载，让机器冷却，再检查散热。'}
  const f = fixture(scenario, {realPlanning: true, gatewayConfig: reasoningGatewayConfig(), optionalEmoji: true})
  assert.equal(await f.run(), true)
  assert.deepEqual(f.captures.errors, [])
  assert.equal(f.session.interactionContext.kind, 'serious_answer')
  assert.equal(f.captures.planInputs[0].interactionKind, f.session.interactionContext.kind, 'the current interaction must reach real planning')
  assert.deepEqual(f.captures.planInputs[0].availableCapabilities, ['sendLocalEmojiTool'])
  assert.equal(f.session.turnPlan.execution.mode, 'chat', 'serious questions cannot become optional emoji turns')
  assert.deepEqual(f.session.tools, [])
  assert.equal(f.captures.gatewayRequests.length, 1, 'one injected fetch proves the outgoing request, without backend retry or network access')
  const {url, body} = f.captures.gatewayRequests[0]
  assert.equal(url, 'https://base.invalid/v1/chat/completions')
  assert.equal(body.model, 'base-reply')
  assert.equal(body.reasoning_effort, 'high', 'serious short requests must override both base and casual low effort')
  assert.equal(body.tools, undefined)
  assert.match(body.messages.at(-1).content, /【本轮执行范围】/)
  assert.match(body.messages.at(-1).content, /这次回复不会新登记自动查询、重试、生成或稍后投递/)
  assert.match(body.messages.at(-1).content, /没有核验到登记则不能承诺稍后行动/)
  assert.deepEqual(f.captures.sent, [scenario.modelReply])
})

test('ordinary banter retains the casual low-effort model through real planning and model execution', async () => {
  const scenario = {rawUserText: '哈哈哈这个电子体香梗笑死我了', modelReply: '这回连香水钱都省了。'}
  const f = fixture(scenario, {realPlanning: true, gatewayConfig: reasoningGatewayConfig(), optionalEmoji: true})
  assert.equal(await f.run(), true)
  assert.deepEqual(f.captures.errors, [])
  assert.equal(f.session.interactionContext.kind, 'banter')
  assert.equal(f.captures.planInputs[0].interactionKind, f.session.interactionContext.kind)
  assert.deepEqual(f.captures.planInputs[0].availableCapabilities, ['sendLocalEmojiTool'])
  assert.equal(f.session.turnPlan.execution.modelProfile, 'casual')
  assert.equal(f.captures.gatewayRequests.length, 1)
  const {url, body} = f.captures.gatewayRequests[0]
  assert.equal(url, 'https://casual.invalid/v1/chat/completions')
  assert.equal(body.model, 'casual-reply')
  assert.equal(body.reasoning_effort, 'low', 'ordinary banter must retain configured casual effort')
  assert.ok(!body.messages.some(message => String(message.content).includes('【本轮执行范围】')), 'a tool-capable route must not receive a no-tools statement')
  assert.deepEqual(f.captures.sent, [scenario.modelReply])
})

test('disabling reasoning escalation preserves base low effort for a short serious question', async () => {
  const scenario = {rawUserText: 'CPU已经92℃了，怎么散热？', modelReply: '先停止满载，让机器冷却，再检查散热。'}
  const f = fixture(scenario, {realPlanning: true, gatewayConfig: reasoningGatewayConfig(false), optionalEmoji: true})
  assert.equal(await f.run(), true)
  assert.deepEqual(f.captures.errors, [])
  assert.equal(f.session.interactionContext.kind, 'serious_answer')
  assert.equal(f.captures.planInputs[0].interactionKind, 'serious_answer')
  assert.equal(f.session.turnPlan.execution.mode, 'chat')
  assert.equal(f.captures.gatewayRequests.length, 1)
  const {url, body} = f.captures.gatewayRequests[0]
  assert.equal(url, 'https://base.invalid/v1/chat/completions', 'disabling effort escalation must not reroute a serious turn to casual')
  assert.equal(body.model, 'base-reply')
  assert.equal(body.reasoning_effort, 'low', 'the existing base effort remains authoritative when escalation is off')
  assert.deepEqual(f.captures.sent, [scenario.modelReply])
})

test('unknown delivery status uses evidence reasoning and an explicit execution contract', async () => {
  const scenario = {rawUserText: '刚才改背景的图出来了吗？', modelReply: '还不能确认完成，我这边没有结果。', continuity: {botId: '99', route: 'tool', tools: [], lastReply: '收到，我先处理。'}}
  const f = fixture(scenario, {realPlanning: true, gatewayConfig: reasoningGatewayConfig(), optionalEmoji: true})
  await f.seedContinuity()
  assert.equal(await f.run(), true)
  assert.deepEqual(f.captures.errors, [])
  assert.equal(f.captures.planInputs[0].interactionKind, 'delivery')
  assert.equal(f.captures.gatewayRequests.length, 1)
  const {body} = f.captures.gatewayRequests[0]
  assert.equal(body.reasoning_effort, 'high')
  assert.equal(body.tools, undefined)
  assert.match(body.messages.at(-1).content, /不要替用户重新发起旧任务/)
  assert.ok(body.messages.some(message => String(message.content).includes('缺少结果时只说明尚未确认')))
})

test('runtime task facts reach the actual model request separately from historical commitments', async () => {
  const scenario={rawUserText:'刚才改背景的图出来了吗？',modelReply:'图已经生成了，发送结果还没确认。'}
  const f=fixture(scenario,{realPlanning:true,gatewayConfig:reasoningGatewayConfig()})
  f.host.messageManager.getMessages=async()=>[{message_id:'original',content:'把背景改成傍晚。',sender:{user_id:202,nickname:'测试群友',role:'member'}}]
  const queries=[]
  f.host.getTurnActionFacts=async(e,query)=>{
    queries.push(query)
    return {scope:{botId:'99',conversationId:`group:${e.group_id}`,userId:'202'},observedAt:Date.now(),lookup:'ok',tasks:[{taskId:'actual-task',requestMessageId:'original',toolName:'imageEdit',source:'task_record',observedAt:Date.now(),execution:'completed',result:'available',delivery:{state:'unknown'},followUp:{state:'none'}}]}
  }
  assert.equal(await f.run(),true)
  assert.deepEqual(queries[0].recentRequestMessageIds,['original'])
  const body=f.captures.gatewayRequests[0].body
  assert.ok(body.messages.some(message=>String(message.content).includes('已有产物；投递结果未确认')))
  assert.equal(f.session.interactionContext.actionFacts.tasks[0].delivery.state,'unknown')
})

test('task lookup failure cannot borrow another account and becomes an explicit evidence gap',async()=>{
 const scenario={rawUserText:'刚才改背景的图出来了吗？',modelReply:'现在还没有可确认的结果。'}
 for(const mode of ['throw','other_bot']){
  const f=fixture(scenario,{realPlanning:true,gatewayConfig:reasoningGatewayConfig()})
  f.host.getTurnActionFacts=async e=>{
   if(mode==='throw')throw Error('store unavailable')
   return {scope:{botId:'another-bot',conversationId:`group:${e.group_id}`,userId:'202'},observedAt:Date.now(),lookup:'ok',tasks:[]}
  }
  assert.equal(await f.run(),true)
  assert.equal(f.session.interactionContext.actionFacts.lookup,'unavailable')
  assert.ok(f.captures.gatewayRequests[0].body.messages.some(message=>String(message.content).includes('本次未能核验相关任务记录')))
 }
})

test('terse status followups and quoted requests refresh task facts rather than old assistant promises',async()=>{
 for(const scenario of [
  {rawUserText:'好了吗？'}, {rawUserText:'还在做吗？'}, {rawUserText:'那还会自动给我吗？'},
  {rawUserText:'怎么样？',quote:{userId:'202',messageId:'original',name:'测试群友',text:'把背景改成傍晚。'}}
 ]){
  const f=fixture({...scenario,modelReply:'图片已生成，发送尚未确认。'},{realPlanning:true,gatewayConfig:reasoningGatewayConfig()})
  let calls=0
  f.host.getTurnActionFacts=async e=>{
   calls++
   return {scope:{botId:'99',conversationId:`group:${e.group_id}`,userId:'202'},observedAt:Date.now(),lookup:'ok',tasks:[{taskId:'actual-task',requestMessageId:'original',toolName:'imageEdit',source:'task_record',observedAt:Date.now(),execution:'completed',result:'available',delivery:{state:'unknown'},followUp:{state:'none'}}]}
  }
  assert.equal(await f.run(),true);assert.equal(calls,1)
  assert.equal(f.session.interactionContext.actionFacts.tasks[0].execution,'completed')
  assert.ok(f.captures.gatewayRequests[0].body.messages.some(message=>String(message.content).includes('已有产物；投递结果未确认')))
 }
})

test('text-only turn respects a separately verified existing completion registration',async()=>{
 const f=fixture({rawUserText:'刚才的图出来了吗？',modelReply:'还在生成，完成后发送的安排仍有效。'},{realPlanning:true,gatewayConfig:reasoningGatewayConfig()})
 f.host.getTurnActionFacts=async e=>({scope:{botId:'99',conversationId:`group:${e.group_id}`,userId:'202'},observedAt:Date.now(),lookup:'ok',tasks:[{taskId:'actual-task',requestMessageId:'original',toolName:'imageEdit',source:'live_job',observedAt:Date.now(),execution:'running',result:'unavailable',delivery:{state:'not_attempted'},followUp:{state:'registered',kind:'job_completion',id:'followup'}}]})
 assert.equal(await f.run(),true)
 const messages=f.captures.gatewayRequests[0].body.messages
 assert.ok(messages.some(message=>String(message.content).includes('已核验仍有效的完成后投递任务')))
 assert.match(messages.at(-1).content,/不能因为本轮只有文字就否认既有登记/)
 assert.doesNotMatch(messages.at(-1).content,/回复发出后不会自动查询、重试、生成或稍后投递/)
})

test('legacy unscoped task status cannot leak into actual conversation history',async()=>{
 const f=fixture({rawUserText:'刚才的图出来了吗？',modelReply:'还没有可确认的结果。'},{realPlanning:true,gatewayConfig:reasoningGatewayConfig()})
 f.host.messageManager.getMessages=async()=>[
  {message_id:'original',content:'把背景改成傍晚。',sender:{user_id:202,nickname:'测试群友',role:'member'}},
  {message_id:'other-request',content:'另一位群友的请求。',sender:{user_id:303,nickname:'其他人',role:'member'}}
 ]
 let legacyReads=0
 f.host.getTaskStatus=async()=>{legacyReads++;return {status:'success',toolName:'imageEdit'}}
 f.host.formatTaskStatusForPrompt=()=> '旧的无作用域状态声称图片已经送达'
 assert.equal(await f.run(),true);assert.equal(legacyReads,0)
 assert.equal(f.session.interactionContext.actionFacts.lookup,'unavailable')
 assert.ok(f.captures.gatewayRequests[0].body.messages.every(message=>!String(message.content).includes('旧的无作用域状态声称图片已经送达')))
})

test('burnt-smell followup keeps prerequisites from the requester instead of the bot\'s old advice',async()=>{
 const scenario={rawUserText:'没看到烧痕，味也散了，现在能开机吗？',modelReply:'先保持断电，外观正常还不能排除损坏。'}
 const f=fixture(scenario,{realPlanning:true,gatewayConfig:reasoningGatewayConfig()})
 f.host.messageManager.getMessages=async()=>[
  {message_id:'advice',content:'先拔电源，等它凉下来。',sender:{user_id:99,nickname:'测试机器人',role:'member'}},
  {message_id:'incident',at:Date.now()-1000,content:'我电脑刚闻到焦糊味，已经拔掉电源线。',sender:{user_id:202,nickname:'测试群友',role:'member'}}
 ]
 assert.equal(await f.run(),true)
 const context=f.session.interactionContext.diagnosticContext
 assert.equal(context.incident.status,'asserted');assert.equal(context.power,'off')
 assert.equal(context.damageExclusion,'unknown')
 assert.ok(!context.allowedChecks.includes('operational_monitoring'))
 const messages=f.captures.gatewayRequests[0].body.messages
 assert.ok(messages.some(message=>String(message.content).includes('运行检测的前提尚不成立')))
})

test('old or untimed physical observations do not authorize current power state in the main turn',async()=>{
 for(const timestamp of [{at:Date.now()-86400000},{time:'2026-10-15 10:00:00'},{}]){
  const f=fixture({rawUserText:'那现在怎么检查风扇？',modelReply:'先确认已经断电并且凉透。'},{realPlanning:true,gatewayConfig:reasoningGatewayConfig()})
  f.host.messageManager.getMessages=async()=>[
   {message_id:'old-incident',...timestamp,content:'我电脑闻到焦糊味，已经拔掉电源线，机器已经完全凉透。',sender:{user_id:202,nickname:'测试群友',role:'member'}}
  ]
  assert.equal(await f.run(),true)
  const context=f.session.interactionContext.diagnosticContext
  assert.equal(context.incident.status,'asserted');assert.equal(context.power,'unknown')
  assert.ok(context.unmetPrerequisites.includes('power_isolated'));assert.ok(context.unmetPrerequisites.includes('cooled'))
 }
})
