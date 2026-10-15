// Offline replay of the real turn/composer/final-reply path. Stub replies test
// contracts and preservation, not the language model's conversational quality.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createPersonaSnapshot} from '../dist/backend/modules/conversation/infrastructure/personaSnapshot.js'
import {createPersonaLibrary} from '../dist/backend/modules/conversation/infrastructure/personaLibrary.js'
import {createChatPlugin} from '../dist/backend/modules/host/infrastructure/chatPlugin.js'
import {resolveConversationContext} from '../dist/backend/adapters/conversationContext.js'
import * as episodic from '../dist/backend/modules/memory/infrastructure/episodicMemory.js'
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
import {createOutboundArbiter} from '../dist/backend/modules/messaging/application/outboundArbiter.js'

const scenarios = JSON.parse(fs.readFileSync(new URL('./fixtures/interactionReplayScenarios.json', import.meta.url), 'utf8'))
let fixtureId = 0

function fixture(scenario, {confirmed = true, directToBot = false, realPlanning = false, gatewayConfig, optionalEmoji = false, episodeBaseDir} = {}) {
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
    recordEpisode: options => { captures.episodes.push(options); if (episodeBaseDir) return episodic.recordEpisode({...options,baseDir:episodeBaseDir}) },
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
  return {api, ports, host, event, session, captures,
    run: () => api.handleToolInner(host, event),
    seedContinuity: (record = scenario.continuity) => record ? recordTurnContinuity({...record, groupId, userId: 202, redis,
      persona: createPersonaSnapshot({botId: event.self_id, persona: host.getPersonaFor(event), systemContent: host.config.systemContent || '', ...(host.config.personaGuard ? {personaGuard:host.config.personaGuard} : {})})}) : Promise.resolve(),
    readContinuity: (botId = '99') => loadTurnContinuity({groupId, userId: 202, botId, redis, ...(session.personaSnapshot ? {persona:session.personaSnapshot} : {})})}
}

test('an explicit chat decision survives an in-flight registry refresh and never executes native or embedded calls', async () => {
  const tools = ['searchInformationTool', 'reminderTool', 'mcp_reserve_table'].map(name => ({type:'function', function:{name,parameters:{type:'object',properties:{}}}}))
  for (const responseKind of ['native', 'embedded', 'text']) {
    const scenario = {rawUserText:'不用搜索，只讨论这句预约餐厅的玩笑。',modelReply:'这次只聊这句话。'}
    const f = fixture(scenario, {realPlanning:true})
    f.host.config.useTools = true
    f.session.tools = tools
    f.host.tools = tools
    const executed = []
    let repairs = 0
    f.host.getToolsByName = names => tools.filter(tool => names.includes(tool.function.name))
    f.host.processToolCalls = async message => executed.push(...message.tool_calls)
    f.host.buildMissingToolCommitmentCall = () => { repairs++; throw Error('No action was selected') }
    f.host.retryRequest = async request => {
      assert.equal(request.tool_choice, undefined, 'the real gateway omits tool fields for no-tool requests')
      assert.equal(request.tools, undefined)
      // Another message or registry update refreshes this in-flight session.
      f.session.tools = [...tools]
      return {choices:[{message:{content:scenario.modelReply,...(responseKind==='native'?{tool_calls:[{type:'function',function:{name:'searchInformationTool',arguments:'{}'}}]}:{})}}]}
    }
    const api = createChatTurn({...f.ports,
      selectToolIntentCandidates: () => ['searchInformationTool','reminderTool'],
      resolveToolRoute: async () => ({toolChoice:'none',forcedToolCall:null,toolScopeLocked:true,toolDecision:{intent:'chat',goal:'讨论玩笑'},applied:['semanticPlanner']}),
      extractEmbeddedToolCalls: () => responseKind==='embedded'?{calls:[{name:'reminderTool',params:{action:'create'}}],remainder:scenario.modelReply}:{calls:[],remainder:''}
    })
    assert.equal(await api.handleToolInner(f.host,f.event),true)
    assert.deepEqual(f.captures.errors,[])
    assert.equal(f.session.turnPlan.observability.routeReason,'semantic_chat')
    assert.deepEqual(f.session.turnPlan.capabilities.required,[])
    assert.deepEqual(executed,[])
    assert.equal(repairs,0)
    assert.deepEqual(f.captures.sent,[scenario.modelReply])
  }
})

test('a selected session-only MCP tool remains executable while a refresh cannot add unrelated tools', async () => {
  const selected = {type:'function',function:{name:'mcp_reserve_table',description:'合成订位能力',parameters:{type:'object',properties:{restaurant:{type:'string'}}}}}
  const unselected = {type:'function',function:{name:'searchInformationTool',parameters:{type:'object',properties:{}}}}
  const f = fixture({rawUserText:'请用已接入的订位系统提交双人预约。',modelReply:''},{realPlanning:true})
  f.host.config.useTools = true
  f.session.tools = [selected,unselected]
  f.host.tools = [selected,unselected]
  f.host.getToolsByName = () => { throw Error('MCP definition must come from the admitted session') }
  const executed = []
  f.host.processToolCalls = async (message,_e,session) => {
    executed.push(...message.tool_calls.map(call=>call.function.name))
    assert.deepEqual(session.tools.map(tool=>tool.function.name),['mcp_reserve_table'])
  }
  f.host.retryRequest = async request => {
    assert.deepEqual(request.tools.map(tool=>tool.function.name),['mcp_reserve_table'])
    f.session.tools = [selected,unselected]
    return {choices:[{message:{tool_calls:[
      {type:'function',function:{name:'mcp_reserve_table',arguments:'{"restaurant":"合成餐厅"}'}},
      {type:'function',function:{name:'searchInformationTool',arguments:'{}'}}
    ]}}]}
  }
  const api = createChatTurn({...f.ports,
    resolveToolRoute: async () => ({toolChoice:{type:'function',function:{name:'mcp_reserve_table'}},forcedToolCall:null,toolScopeLocked:true,toolDecision:{intent:'tool',toolName:'mcp_reserve_table',params:{restaurant:'合成餐厅'}},applied:['semanticPlanner']})
  })
  assert.equal(await api.handleToolInner(f.host,f.event),true)
  assert.deepEqual(f.captures.errors,[])
  assert.deepEqual(executed,['mcp_reserve_table'])
})

test('a previous chat decision cannot lock a later real search in a reused session', async () => {
  const search = {type:'function',function:{name:'searchInformationTool',parameters:{type:'object',properties:{query:{type:'string'}}}}}
  const f = fixture({rawUserText:'先别查，随便聊聊。',modelReply:'好，先聊。'},{realPlanning:true})
  f.host.config.useTools = true
  f.session.tools = [search]
  f.host.tools = [search]
  f.host.getToolsByName = () => [search]
  let turn = 0
  const executed = []
  f.host.processToolCalls = async message => executed.push(...message.tool_calls.map(call=>call.function.name))
  f.host.retryRequest = async () => turn===1?{choices:[{message:{content:'好，先聊。'}}]}:{choices:[{message:{tool_calls:[{type:'function',function:{name:'searchInformationTool',arguments:'{"query":"上海餐厅营业时间"}'}}]}}]}
  const api = createChatTurn({...f.ports,
    resolveToolRoute: async () => {
      assert.equal(f.session.toolDecision,null,'every turn clears the previous action decision')
      assert.equal(f.session.executionTools,undefined,'every turn clears the previous execution snapshot before routing')
      turn++
      return turn===1?{toolChoice:'none',forcedToolCall:null,toolScopeLocked:true,toolDecision:{intent:'chat'},applied:['semanticPlanner']}:
        {toolChoice:{type:'function',function:{name:'searchInformationTool'}},forcedToolCall:null,toolScopeLocked:true,toolDecision:{intent:'search',toolName:'searchInformationTool',params:{query:'上海餐厅营业时间'}},applied:['semanticPlanner']}
    }
  })
  assert.equal(await api.handleToolInner(f.host,f.event),true)
  assert.deepEqual(f.session.executionTools,[], 'the completed chat turn deliberately has an empty execution scope')
  f.event.msg='认真帮我查上海餐厅今天的营业时间。'
  f.event.message=[{type:'text',text:f.event.msg}]
  f.session.tools=[search]
  assert.equal(await api.handleToolInner(f.host,f.event),true)
  assert.deepEqual(f.captures.errors,[])
  assert.deepEqual(executed,['searchInformationTool'])
})

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
      assert.equal(video.text, undefined, 'an unread video provides no facts about its eating method')
      assert.equal(context.social.act, 'factual_question', 'the current question asks for a fact about the video')
      assert.ok(context.evidence.some(item => item.origin === 'current' && item.kind === 'text' && item.text === scenario.rawUserText))
      assert.match(system, /证据 current\/video：仅有素材引用/)
      assert.match(system, /仍可回应已知文字，把不确定性限于缺失部分/)
      assert.match(system, /一两句都可以/)
      assert.equal(context.previousBotReply, undefined)
      assert.equal(context.target.kind, 'other')
      assert.ok(context.evidence.some(item => item.origin === 'quote' && item.speaker?.userId === '303' && item.text === scenario.quote.text))
      assert.ok(system.includes('他俩吃饭像饕餮。'))
    }
    if (scenario.id === 'serious-cooling-fault') {
      assert.equal(context.allowPlayfulness, false)
      assert.equal(context.previousBotReply, undefined, 'a same-account quote without persona provenance remains evidence')
      assert.ok(context.evidence.some(item => item.origin === 'quote' && item.text === scenario.quote.text))
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

function reasoningGatewayConfig(complexReasoningEffort) {
  return {
    providers: 'oneapi', useTools: false,
    chatAiConfig: {chatApiUrl: 'https://base.invalid/v1', chatApiModel: 'base-reply', chatApiKey: 'fixture-base-key', chatReasoningEffort: 'low', complexReasoningEffort},
    taskAiConfig: {casual: {apiUrl: 'https://casual.invalid/v1', model: 'casual-reply', apiKey: 'fixture-casual-key', reasoningEffort: 'low'}}
  }
}

test('short serious cooling questions default to low at the real model request and retain their execution contract', async () => {
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
  assert.equal(body.reasoning_effort, 'low', 'serious interaction must not automatically increase the thinking budget')
  assert.equal(body.tools, undefined)
  assert.match(body.messages.at(-1).content, /【本轮执行范围】/)
  assert.match(body.messages.at(-1).content, /这次回复不会新登记自动查询、重试、生成或稍后投递/)
  assert.match(body.messages.at(-1).content, /没有核验到登记则不能承诺稍后行动/)
  assert.deepEqual(f.captures.sent, [scenario.modelReply])
})

test('an explicitly configured high budget still reaches the actual model request', async () => {
  const scenario = {rawUserText: 'CPU已经92℃了，怎么散热？', modelReply: '先停止满载，让机器冷却，再检查散热。'}
  const f = fixture(scenario, {realPlanning: true, gatewayConfig: reasoningGatewayConfig('high'), optionalEmoji: true})
  assert.equal(await f.run(), true)
  assert.deepEqual(f.captures.errors, [])
  assert.equal(f.session.interactionContext.kind, 'serious_answer')
  assert.equal(f.captures.gatewayRequests.length, 1)
  assert.equal(f.captures.gatewayRequests[0].body.reasoning_effort, 'high')
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
  assert.equal(body.reasoning_effort, 'low')
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

function useRealPersonaLibrary(f, t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'persona-turn-replay-'))
  t.after(() => fs.rmSync(dir,{recursive:true,force:true}))
  const {ExamplePlugin} = createChatPlugin({Plugin:class {},shared:{},logger:{}})
  const host = f.host
  host.personaLibrary = createPersonaLibrary({libraryPath:path.join(dir,'personas.yaml'),getBasePersona:()=>host.config.persona})
  for (const method of ['getPersonaFor','getPersonaSnapshotFor','getChatConfig']) host[method] = ExamplePlugin.prototype[method]
  return {library:host.personaLibrary,dir}
}

test('in-flight persona switch keeps prompt, guard, archive and memory on one snapshot; next turn adopts the new persona', async t => {
  const scenario = {rawUserText:'今天想聊点什么？',modelReply:'聊聊刚才那件事吧。'}
  const f = fixture(scenario)
  const {library} = useRealPersonaLibrary(f,t)
  const first = library.upsert({name:'甲',identity:'冷静克制',tone:'简练',speechStyle:['短句'],notes:'甲的设定'})
  const second = library.upsert({name:'乙',identity:'热情好奇',tone:'轻快',notes:'乙的设定'})
  library.setGroupBinding(f.event.group_id,first.id)
  f.host.config.systemContent = '原自定义 {personaName}'
  f.host.config.personaGuard = {enabled:true,badPatterns:['甲的规则']}
  let snapshot
  f.host.refreshLocalToolRegistry = async () => {
    snapshot = f.event._personaSnapshot
    library.setGroupBinding(f.event.group_id,second.id)
    f.host.config.systemContent = '新自定义 {personaName}'
    f.host.config.personaGuard = {enabled:false,badPatterns:['乙的规则']}
  }
  let moods = []
  const api = createChatTurn({...f.ports,resolveConversationContext,createOutboundArbiter,rollPersonaMood:persona => {moods.push(persona);return null}})
  assert.equal(await api.handleToolInner(f.host,f.event),true)
  assert.deepEqual(f.captures.errors,[])
  assert.equal(f.session.personaSnapshot,snapshot)
  assert.equal(f.session.context.persona.personaId,first.id)
  assert.equal(f.captures.compose[0].personaSnapshot,snapshot)
  assert.equal(moods[0],snapshot.persona)
  const system = f.captures.requests[0].find(message => message.role === 'system').content
  assert.match(system,/原自定义 甲/)
  assert.match(system,/冷静克制/)
  assert.doesNotMatch(system,/新自定义|乙的设定|热情好奇/)
  assert.deepEqual(f.captures.guards[0].personaGuard,{enabled:true,badPatterns:['甲的规则']})
  assert.equal(f.captures.archived[0].sender.nickname,'甲')
  assert.equal(f.captures.archived[0].personaSource,snapshot)
  assert.equal(f.captures.episodes[0].source,snapshot)
  assert.equal(f.captures.writes[0].persona,snapshot)
  assert.equal(f.captures.enhanced[0][3],snapshot)
  f.host.refreshLocalToolRegistry = async () => {}
  assert.equal(await api.handleToolInner(f.host,f.event),true)
  assert.equal(f.session.personaSnapshot.personaId,second.id)
  assert.equal(f.session.interactionContext.previousBotReply,undefined)
  const nextSystem = f.captures.requests[1].find(message => message.role === 'system').content
  assert.match(nextSystem,/新自定义 乙/)
  assert.match(nextSystem,/热情好奇/)
  assert.doesNotMatch(nextSystem,/甲的设定|原自定义/)
  assert.equal(f.captures.archived[1].sender.nickname,'乙')
})

test('real episode writes feed later turns with bot and persona ownership while public words remain shared', async t => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(),'persona-episode-replay-'))
  t.after(() => fs.rmSync(baseDir,{recursive:true,force:true}))
  const scenario = {rawUserText:'上次说的考试安排还记得吗？',modelReply:'记着你提过考试。'}
  const f = fixture(scenario,{episodeBaseDir:baseDir})
  const {library} = useRealPersonaLibrary(f,t)
  const first = library.upsert({name:'甲',tone:'简练'})
  const second = library.upsert({name:'乙',tone:'活泼'})
  library.setGroupBinding(f.event.group_id,first.id)
  const api = createChatTurn({...f.ports,resolveConversationContext,createOutboundArbiter,
    hasTemporalDeixis:episodic.hasTemporalDeixis,
    recallEpisodes:options => episodic.recallEpisodes({...options,baseDir}),
    buildEpisodicPrompt:episodic.buildEpisodicPrompt,
    recallUserEpisodes:options => episodic.recallUserEpisodes({...options,baseDir}),
    buildUserCallbackPrompt:episodic.buildUserCallbackPrompt
  })
  f.host.messageManager.getMessages = async () => f.captures.archived.map((row,index) => ({
    message_id:`prior-${index}`,source:'send',time:row.time,sender:row.sender,personaSource:row.personaSource,content:row.message[0].text
  })).reverse()
  const systems = () => f.captures.requests.map(messages => messages.find(item => item.role === 'system').content)
  assert.equal(await api.handleToolInner(f.host,f.event),true)
  const original = f.session.personaSnapshot
  assert.ok(fs.existsSync(path.join(baseDir,`${f.event.group_id}.ndjson`)))
  assert.equal(await api.handleToolInner(f.host,f.event),true)
  assert.match(systems()[1],/你回了/)
  assert.equal(f.session.interactionContext.previousBotReply.text,scenario.modelReply)
  assert.ok(f.captures.requests[1].some(item => item.role === 'assistant' && item.content.includes(scenario.modelReply)))

  library.setGroupBinding(f.event.group_id,second.id)
  assert.equal(await api.handleToolInner(f.host,f.event),true)
  assert.equal(f.session.interactionContext.previousBotReply,undefined)
  assert.ok(systems()[2].includes(scenario.rawUserText),'public user words remain available')
  assert.ok(systems()[2].includes('甲'),'other persona is explicitly named')
  assert.doesNotMatch(systems()[2],/你回了|你当时回/)
  assert.ok(!f.captures.requests[2].some(item => item.role === 'assistant'))
  assert.ok(f.captures.requests[2].some(item => item.role === 'user' && item.content.includes('[历史人格:甲')))

  f.event.self_id = 303
  f.event.bot = {...f.event.bot,uin:303,nickname:'另一只机器人'}
  assert.equal(await api.handleToolInner(f.host,f.event),true)
  assert.doesNotMatch(systems()[3],/你回了|你当时回/)
  assert.equal(f.session.interactionContext.previousBotReply,undefined)

  f.event.self_id = 99
  f.event.bot = {...f.event.bot,uin:99,nickname:'测试机器人'}
  library.setGroupBinding(f.event.group_id,first.id)
  library.upsert({name:'甲',tone:'修改后的语气'})
  assert.equal(await api.handleToolInner(f.host,f.event),true)
  assert.equal(f.session.personaSnapshot.personaId,original.personaId)
  assert.notEqual(f.session.personaSnapshot.personaVersion,original.personaVersion)
  assert.equal(f.session.interactionContext.previousBotReply,undefined)
  assert.doesNotMatch(systems()[4],/你回了|你当时回/)
  assert.deepEqual(f.captures.errors,[])
  assert.equal(f.captures.mainCalls,5,'source handling adds no model request')
})

test('legacy same-account history remains named public evidence rather than this persona assistant history', async () => {
  const f = fixture({rawUserText:'上次说什么来着？',modelReply:'你在问之前那段聊天。'})
  f.host.messageManager.getMessages = async () => [{message_id:'legacy',time:'昨日',source:'send',sender:{user_id:99,nickname:'旧称呼'},content:'旧人格说过的话'}]
  assert.equal(await f.run(),true)
  assert.deepEqual(f.captures.errors,[])
  const history = f.captures.requests[0].find(item => item.content?.includes('旧人格说过的话'))
  assert.equal(history.role,'user')
  assert.match(history.content,/人格来源未记录/)
  assert.equal(f.session.interactionContext.previousBotReply,undefined)
})

test('TimingGate captures one persona across its awaits and hands the same snapshot to the main turn', async t => {
  const {createTimingGate} = await import('../dist/backend/modules/conversation/infrastructure/timingGate.js')
  const f = fixture({rawUserText:'甲，你怎么看？',modelReply:'先把刚才那点说清楚。'})
  const {library} = useRealPersonaLibrary(f,t)
  const a = library.upsert({name:'甲',identity:'冷静',preferences:['甲的偏好']})
  const b = library.upsert({name:'乙',identity:'活泼',preferences:['乙的偏好']})
  library.setGroupBinding(f.event.group_id,a.id)
  f.host.config.trackAiConfig = {trackAiUrl:'https://gate.invalid/v1',trackAiModel:'fixture',trackAiApikey:'fixture-key'}
  let system
  f.host.computeGroupMsgRate5min = () => 0
  f.host.messageManager.formatMessageHistory = async () => {
    library.setGroupBinding(f.event.group_id,b.id)
    return '群友正在讨论。'
  }
  const gate = createTimingGate({logger:{warn(){}},bot:()=>f.event.bot,resolvePersonaName:p=>p.name,
    computeAddresseeSignal:()=>({groupAddressed:false,targetKind:'bot',pronounWithoutBotAnchor:false}),
    buildPersonaTonePrompt:({persona})=>`人格态度:${persona.identity}`,getGroupTopicPrompt:()=>'',getGroupSocialPrompt:()=>'',detectAttentionHook:()=>null,
    sideLLMCall:async input => {system = input.messages[0].content;return {ok:true,content:'{"decision":"continue","reason":"direct"}'}}
  })
  const result = await gate.runTimingGate(f.host,f.event,{})
  assert.equal(result.decision,'continue')
  assert.match(system,/甲的偏好/)
  assert.match(system,/人格态度:冷静/)
  assert.doesNotMatch(system,/乙的偏好|人格态度:活泼/)
  assert.equal(result.personaSnapshot.personaId,a.id)
  f.event._pendingPersonaSnapshot = result.personaSnapshot
  assert.equal(await f.run(),true)
  assert.equal(f.session.personaSnapshot,result.personaSnapshot)
  assert.equal(f.event._pendingPersonaSnapshot,undefined,'the gate handoff is consumed once')
  assert.equal(await f.run(),true)
  assert.equal(f.session.personaSnapshot.personaId,b.id,'a separate later turn captures current persona')
  assert.deepEqual(f.captures.errors,[])
})

test('outbound wrapper owns its persona even when the original event is reused during a tool stage', async t => {
  const f = fixture({rawUserText:'聊聊刚才那个梗。',modelReply:'我接着刚才说。'})
  const {library} = useRealPersonaLibrary(f,t)
  const a = library.upsert({name:'甲',tone:'简练'})
  const b = library.upsert({name:'乙',tone:'活泼'})
  library.setGroupBinding(f.event.group_id,a.id)
  let understandingCalls = 0
  f.host.resolveUnderstandingPrompt = async ({e}) => {
    understandingCalls++
    const original = e._personaSnapshot
    library.setGroupBinding(f.event.group_id,b.id)
    f.event._personaSnapshot = f.host.getPersonaSnapshotFor(f.event)
    assert.equal(e._personaSnapshot,original)
    assert.equal(f.host.getPersonaFor(e).name,'甲')
    return ''
  }
  const api = createChatTurn({...f.ports,createOutboundArbiter,resolvePromptLayerProfile:()=>({profile:'task'})})
  assert.equal(await api.handleToolInner(f.host,f.event),true)
  assert.equal(understandingCalls,1,'the awaited tool-stage hook actually runs')
  assert.deepEqual(f.captures.errors,[])
  assert.equal(f.captures.archived[0].sender.nickname,'甲')
})

test('a guard enabled during Gate handoff cannot enter a turn whose snapshot has no guard', async t => {
  const f = fixture({rawUserText:'接着聊聊。',modelReply:'接着刚才说。'})
  useRealPersonaLibrary(f,t)
  const snapshot = f.host.getPersonaSnapshotFor(f.event)
  assert.equal(snapshot.personaGuard,undefined)
  f.host.config.personaGuard = {enabled:true,badPatterns:['新规则']}
  f.event._pendingPersonaSnapshot = snapshot
  assert.equal(await f.run(),true)
  assert.equal(f.captures.compose[0].config.personaGuard,undefined)
  assert.equal(f.captures.guards[0].personaGuard,undefined)
  assert.equal(f.session.personaSnapshot,snapshot)
  assert.deepEqual(f.captures.errors,[])
})
