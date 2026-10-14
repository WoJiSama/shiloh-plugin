// Read-only shadow replay of the compiled conversation path. Sends and user stores stay in memory.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
const args=process.argv.slice(2);
if(args.includes('--help')){
  console.log('Usage: node scripts/conversationQualityReplay.mjs [--dry-run] [--plugin-root path] [--config-root path] [--scenarios file] [--output-dir path] [--scenario id] [--label name]\nWithout --dry-run this calls the configured model. It never connects to QQ or writes user memory.');
  process.exit(0);
}
const acceptedFlags=new Set(['--dry-run','--plugin-root','--config-root','--scenarios','--output-dir','--scenario','--label']);
for(let i=0;i<args.length;i++){
  if(!acceptedFlags.has(args[i]))throw new Error(`Unknown replay option: ${args[i]}`);
  if(args[i]!=='--dry-run'&&(!args[++i]||args[i].startsWith('--')))throw new Error('Replay option requires a value');
}
const option=(name,fallback)=>{const index=args.indexOf(name);return index<0?fallback:args[index+1]};
const pluginRoot=path.resolve(option('--plugin-root',process.env.BL_SHADOW_PLUGIN_ROOT||process.cwd()));
const configRoot=path.resolve(option('--config-root',process.env.BL_SHADOW_CONFIG_ROOT||pluginRoot));
const outputDir=path.resolve(option('--output-dir',process.env.BL_SHADOW_OUTPUT_DIR||`/tmp/bl-conversation-quality-${Date.now()}`));
const dryRun=args.includes('--dry-run');
const runLabel=option('--label',dryRun?'offline_stub':'candidate');
const scenariosFile=path.resolve(option('--scenarios',path.join(path.dirname(fileURLToPath(import.meta.url)),'../tests/fixtures/conversationQualityReplayScenarios.json')));
fs.mkdirSync(outputDir,{recursive:true,mode:0o700});
const manifestFile=path.join(pluginRoot,'release-manifest.json');
const commit=fs.existsSync(manifestFile)?JSON.parse(fs.readFileSync(manifestFile,'utf8')).commit:'unreleased_local';
const require=createRequire(path.join(pluginRoot,'package.json'));
const YAML=require('yaml');
const load=p=>import(pathToFileURL(path.join(pluginRoot,'dist/backend',p)).href);
const {createChatTurn}=await load('modules/tools/infrastructure/chatTurn.js');
const {createTurnPromptComposer}=await load('modules/conversation/infrastructure/turnPromptComposer.js');
const {buildMainSystemPrompt}=await load('modules/conversation/domain/systemPromptTemplate.js');
const {resolvePromptLayerProfile}=await load('modules/conversation/domain/promptLayers.js');
const {resolveGroupContextAssets,formatGroupContextImagePrompt}=await load('modules/conversation/infrastructure/groupContextResolver.js');
const {createFinalReply}=await load('modules/conversation/application/finalReply.js');
const {createOutputGuardPipeline}=await load('modules/conversation/application/outputGuardPipeline.js');
const {recordTurnContinuity,loadTurnContinuity,buildTurnContinuityPrompt}=await load('modules/conversation/application/turnContinuity.js');
const {planTextReplyMessages}=await load('modules/conversation/domain/replyRhythm.js');
const {createModelExecutor}=await load('modules/models/application/modelExecution.js');
const {executeChatRequestWithRecovery}=await load('modules/models/application/chatRequestRecovery.js');
const {fetchWithTimeout}=await load('adapters/modelFetch.js');
const {buildChatRequestData}=await load('modules/models/domain/modelGateway.js');
const {resolveChatCompletionUrl}=await load('modules/models/domain/chatCompletionUrl.js');
const {resolveAgentBackend,shouldAcceptPlannerTextResponse,summarizeToolResultForAgent}=await load('modules/conversation/domain/agentIntelligence.js');
const {removeToolPromptsFromMessages}=await load('modules/foundation/domain/textUtils.js');
const {createTurnPlan,deriveTurnPlanRequest,formatTurnPlanLog}=await load('modules/conversation/infrastructure/turnPlan.js');
const {mergeDeepConfig}=await load('modules/config/infrastructure/configStore.js');
const {decodeHostConfig}=await load('modules/host/infrastructure/hostConfig.js');
const {createPersonaLibrary}=await load('modules/conversation/infrastructure/personaLibrary.js');
const {createPersonaFeedbackModule}=await load('modules/memory/infrastructure/personaFeedbackManager.js');
const {isToneCorrectionMessage}=await load('modules/conversation/application/chatFailureReply.js');
const {createMessageFormatting}=await load('modules/conversation/application/messageFormatting.js');
const filterIndex=args.indexOf('--scenario');
const filter=filterIndex<0?'':String(args[filterIndex+1]||'');
const readConfig=file=>{const doc=YAML.parse(fs.readFileSync(file,'utf8'));return doc?.pluginSettings||doc||{}};
const defaults=readConfig(path.join(pluginRoot,'config_default/message.yaml'));
const supplied=dryRun?{}:readConfig(path.join(configRoot,'config/message.yaml'));
const config=decodeHostConfig(mergeDeepConfig(defaults,supplied));
const library=createPersonaLibrary({libraryPath:path.join(configRoot,'config/persona-library.yaml'),getBasePersona:()=>config.persona});
const identity=library.resolve({messageType:'group',groupId:'609235590',selfId:'3094088525'});
const persona=identity.persona;
config.persona=persona;
const secrets=[];
const collect=(value,key='')=>{if(Array.isArray(value)){for(const item of value)collect(item,key)}else if(value&&typeof value==='object'){for(const [k,v]of Object.entries(value))collect(v,k)}else if(/(?:api.?key|token|password|secret)$/i.test(key)&&typeof value==='string'&&value.length>8){secrets.push(value)}};
collect(config);
const scrub=value=>{let s=String(value);for(const secret of secrets)s=s.split(secret).join('[REDACTED]');return s.replace(/Bearer\s+[A-Za-z0-9._-]+/gi,'Bearer [REDACTED]')};
// Production history compacts whitespace. Compare all words without requiring
// the original bubble/newline layout to survive that transport formatting.
const historyText=value=>String(value).replace(/\s+/gu,' ').trim();
const baseScenarios=JSON.parse(fs.readFileSync(scenariosFile,'utf8'));
const scenarios=baseScenarios.filter(s=>!filter||s.id.includes(filter));
const fileHash=file=>fs.existsSync(file)?createHash('sha256').update(fs.readFileSync(file)).digest('hex'):null;
const runtimePaths=['modules/tools/infrastructure/chatTurn.js','modules/conversation/domain/personaSource.js','modules/conversation/domain/personaTonePolicy.js','modules/conversation/domain/systemPromptTemplate.js','modules/conversation/domain/systemContentSource.js','modules/conversation/domain/agentIntelligence.js','modules/conversation/infrastructure/turnPromptComposer.js','modules/conversation/infrastructure/turnPlan.js','modules/conversation/domain/turnPlanPolicy.js','modules/models/application/modelExecution.js','modules/conversation/application/finalReply.js'];
const metadata={pluginRoot,configRoot,runnerHash:fileHash(fileURLToPath(import.meta.url)),scenariosHash:fileHash(scenariosFile),configHash:dryRun?null:fileHash(path.join(configRoot,'config/message.yaml')),personaLibraryHash:dryRun?null:fileHash(path.join(configRoot,'config/persona-library.yaml')),runtimeHashes:Object.fromEntries(runtimePaths.map(file=>[file,fileHash(path.join(pluginRoot,'dist/backend',file))]))};
if(!scenarios.length)throw new Error('no matching scenarios');
console.log(JSON.stringify({type:'start',dryRun,commit,label:runLabel,metadata,persona:persona.name,personaSource:identity.source,scenarios:scenarios.length,adapters:'in_memory_send_and_store',tools:'disabled',enhancedLearning:'disabled'}));
let fixtureId = 0

function fixture(initialScenario, {confirmed = true, directToBot = false} = {}) {
  let scenario=initialScenario;
  let turnIndex=0;
  const currentPersona=initialScenario.personaOverride || persona;
  const replayTime=at=>new Date(at).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false});
  const initialTime=Date.now();
  const history=(initialScenario.recentContext||[]).map((message,index)=>({
    message_id:`history-${fixtureId}-${index}`,time:replayTime(initialTime-((initialScenario.recentContext||[]).length-index)*30000),content:message.content,
    sender:{user_id:Number(message.userId||(message.role==='assistant'?'99':'202')),nickname:message.role==='assistant'?currentPersona.name:(message.name||'测试群友'),role:'member'}
  }));
  const groupId = 900000 + ++fixtureId
  const captures = {compose: [], guards: [], requests: [], loads: [], writes: [], episodes: [], archived: [], saved: [], enhanced: [], sent: [], errors: [], mainCalls: 0, intentCalls: 0, warnings: [], network: [], modelOutput: ''}
  const logger = {info() {}, warn(...args) {captures.warnings.push(scrub(args.join(' ')))}, debug() {}, error(message, error) { captures.errors.push({message:scrub(String(message)), error:scrub(error instanceof Error ? error.message : String(error ?? ''))}) }}
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
  const session = {tools: [], groupUserMessages: []}
  const storage = new Map()
  const redis = {get: async key => storage.get(key) ?? null, set: async (key, value) => { storage.set(key, value) }}
  const composer = createTurnPromptComposer(logger)
  const {PersonaFeedbackManager}=createPersonaFeedbackModule({isToneCorrectionMessage,logger});
  const guardManager=new PersonaFeedbackManager({cwd:outputDir,logger});
  const guards = createOutputGuardPipeline({manager:guardManager, info() {}})
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
  const host = {
    config: {...config, persona:currentPersona, enabled:true, groupHistory:true, turnTrace:{archiveEnabled:false}, promptLayerCache:{enabled:false}, episodicMemory:{enabled:true,proactiveEnabled:false}, memorySystem:{enabled:false}, emotionSystem:{enabled:false}, expressionLearning:{enabled:false}, personProfileInjection:{enabled:false}, midtermMemory:{enabled:false}, semanticMemory:{enabled:false}, knowledgeSystem:{enabled:false}, conversationTrackingEnabled:false, globalStyleLearning:{enabled:false}},
    tools: [], toolInstances: {}, _groupLimiters: new Map(),
    isUserBlacklisted: () => false, scheduleMergedToolRequest: () => true, refreshLocalToolRegistry: async () => {}, waitForMCPReady: async () => {},
    beginConversationTask: async () => ({messageId: event.message_id}), getOrCreateSession: () => session, clearSession() {},
    handleActiveDrawStatusQuestion: async () => false,
    buildMessageContent: async (_sender, args, images) => `[2026-01-01 12:00:00] 测试群友(qq号:202)[群身份:member]: 在群里说: ${args}${images.length ? '\n[图片素材引用]' : ''}${scenario.quote ? `\n[回复 ${scenario.quote.name} 的消息: ${scenario.quote.text}]` : ''}`,
    resolvePrimaryModelIntent: async () => { captures.intentCalls++; return null },
    getSmartState: () => ({}), getPersonaFor: () => currentPersona, getChatConfig() { return this.config },
    getCurrentGroupContext: async () => ({groupId, groupName: '脱敏回放群'}), getBasicGroupContext: () => ({groupId, groupName: '脱敏回放群'}),
    buildMergedDirectTriggerPrompt: () => '',
    messageManager: {getMessages: async () => history.slice().reverse(), recordMessage: async record => captures.archived.push(record)},
    getTaskStatus: async () => null, formatTaskStatusForPrompt: () => '', resolveUnderstandingPrompt: async () => '',
    trimMessageHistory: messages => messages, filterChatByQQ: messages => messages, formatMessages: messages => messages,
    getToolsByName: () => [], getImageGenerationReferenceImages: images => images,
    retryRequest: async (requestData,toolContent,retries=1,toolName,options={}) => {
      captures.mainCalls++;
      if(dryRun){captures.modelOutput='这是一条离线桩回复，用于检查提示传递。\n这句检查多行回复的历史传递。';return {choices:[{message:{content:captures.modelOutput}}]}}
      const response=await executeChatRequestWithRecovery(req=>executor.YTapi(req,host.config,toolContent,toolName,options),requestData,{retries,onRetry:({failure})=>captures.warnings.push(`model_retry:${failure.kind}`)});
      captures.modelOutput=String(response?.choices?.[0]?.message?.content||'');
      return response;
    },
    buildMissingToolCommitmentCall: () => null,
    handleTextResponse: (text, e, current, messages) => final.handleTextResponse(host, text, e, current, messages),
    processToolSpecificMessage: text => text, getTextImageTemplateForFinalReply: () => false,
    sendSegmentedMessage: async (_e, text) => { captures.sent.push(text); return confirmed ? `reply-${groupId}` : null },
    sendObservedReply: async () => { throw new Error('unexpected platform send') },
    sendFinalReplyAsTextImage:async (_e,text)=>{captures.sent.push(text);return confirmed?`card-${groupId}`:null},
    processToolCalls:async ()=>{throw new Error('tools disabled in shadow replay')},
    getFriendlyFailureMessage:()=> '影子回放模型调用失败',
    resolveForwardPromptFromSegments:async ()=>'',
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
    resolveToolRoute: async () => ({toolChoice: 'none', forcedToolCall: null, toolScopeLocked: true, applied: []}),
    createTurnPlan,
    isEducationalExplanationRequest: () => false, classifyEmojiToolExposure: () => '', resolveCardPresentation: () => '',
    deriveTurnPlanRequest, formatTurnPlanLog, cardAcknowledgement: () => '', buildToolIntentDisclosure: () => '',
    buildChatRequestData: (_config, messages, tools, choice) => { captures.requests.push(structuredClone(messages)); return buildChatRequestData(_config,messages,tools,choice) },
    collectThinking() {}, extractEmbeddedToolCalls: () => ({calls: [], remainder: ''}), sendThinkingForward: async () => {},
    recordTurnDiagnostics() {}, buildCommittedActionReply: () => '', buildDrawFailureNoteMessage: () => '', takeDrawFailureNote: () => null
  }
  const formatting=createMessageFormatting({botId:()=>99,error:()=>{}});
  host.formatTime=()=>formatting.formatTime(host);
  host.buildMessageContent=(...args)=>formatting.buildMessageContent(host,...args);
  host.formatMessages=(messages,e,current)=>formatting.formatMessages(host,messages,e,current);
  members.set(99,{user_id:99,nickname:currentPersona.name||'希洛',role:'member'});
  event.bot.nickname=currentPersona.name||'希洛';
  if(directToBot)event.message.unshift({type:'at',qq:99});
  const executor=createModelExecutor({
    fetch:async (url,options)=>{
      const payload=JSON.parse(options.body); const started=Date.now();
      const response=await fetchWithTimeout(url,options,90000);
      captures.network.push({model:payload.model,urlHost:new URL(url).host,status:response.status,elapsedMs:Date.now()-started,messageCount:payload.messages.length,systemChars:payload.messages.filter(x=>x.role==='system').reduce((n,x)=>n+String(x.content||'').length,0),generation:{temperature:payload.temperature,top_p:payload.top_p,max_tokens:payload.max_tokens,max_completion_tokens:payload.max_completion_tokens,reasoning_effort:payload.reasoning_effort}});
      return response;
    },
    logger:{info(){},warn(...args){captures.warnings.push(scrub(args.join(' ')))},error(...args){captures.errors.push({message:scrub(args.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' '))})}},
    removeToolPromptsFromMessages,resolveChatCompletionUrl,resolveAgentBackend,shouldAcceptPlannerTextResponse,summarizeToolResultForAgent
  });
  const api = createChatTurn(ports)
  return {api, host, event, session, captures,
    run: async (turn=initialScenario) => {
      scenario=turn;
      event.msg=turn.rawUserText;
      event.message_id=`input-${groupId}-${turnIndex++}`;
      event.message=[...(directToBot?[{type:'at',qq:99}]:[]),{type:'text',text:turn.rawUserText}];
      if(turn.imageSource)event.message.push({type:'image',url:turn.imageSource});
      if(turn.videoSource)event.message.push({type:'video',url:turn.videoSource});
      delete event.reply_id;delete event.getReply;delete event._quotedPromptContext;
      if(turn.quote){const q=turn.quote;event.reply_id=q.messageId;event.getReply=async()=>({message_id:q.messageId,user_id:q.userId,sender:{user_id:q.userId,nickname:q.name},message:[{type:'text',text:q.text}]});event._quotedPromptContext={text:q.text,messageId:q.messageId,userId:q.userId,senderUserId:q.userId,senderName:q.name}}
      const sentStart=captures.sent.length;
      const handled=await api.handleToolInner(host,event);
      history.push({message_id:event.message_id,time:replayTime(Date.now()),content:turn.rawUserText,sender:{user_id:202,nickname:'测试群友',role:'member'}});
      if(confirmed)history.push({message_id:`reply-${groupId}-${turnIndex}`,time:replayTime(Date.now()),content:captures.sent.slice(sentStart).join('\n'),sender:{user_id:99,nickname:currentPersona.name,role:'member'}});
      return handled;
    },
    seedContinuity: (record = scenario.continuity) => record ? recordTurnContinuity({...record, groupId, userId: 202, redis}) : Promise.resolve(),
    readContinuity: (botId = '99') => loadTurnContinuity({groupId, userId: 202, botId, redis})}
}


const results=[];
for(const scenario of scenarios){
  const f=fixture(scenario,{directToBot:true});
  await f.seedContinuity();
  const turns=[scenario,...(scenario.followups||[])];
  for(let turnIndex=0;turnIndex<turns.length;turnIndex++){
    const turn=turns[turnIndex];
    const startedAt=Date.now();
    const offsets=Object.fromEntries(['sent','requests','errors','warnings','network'].map(key=>[key,f.captures[key].length]));
    const intentCalls=f.captures.intentCalls;
    const failures=[];
    try{
      const handled=await f.run(turn);
      const c=f.session.interactionContext;
      const request=f.captures.requests[offsets.requests]||[];
      const system=request.find(m=>m.role==='system')?.content||'';
      const checks={handled:handled===true,kind:c?.kind===turn.expectedKind,rawBody:c?.rawUserText===turn.rawUserText,interactionLayer:system.includes('【本轮互动】'),target:c?.target?.kind==='bot',noExtraIntent:f.captures.intentCalls===intentCalls,modelResponded:Boolean(f.captures.modelOutput),finalOutput:f.captures.sent.slice(offsets.sent).some(t=>t!=='影子回放模型调用失败'),noRuntimeError:f.captures.errors.length===offsets.errors};
      if(turn.imageSource)checks.imageReferenceOnly=c?.evidence?.some(e=>e.kind==='image'&&e.state==='reference_only'&&!e.text);
      if(turn.videoSource){checks.videoReferenceOnly=c?.evidence?.some(e=>e.kind==='video'&&e.state==='reference_only'&&!e.text);checks.otherBotNotMe=!c?.previousBotReply;checks.quoteRetained=system.includes(turn.quote.text)}
      if(turn.expectedKind==='serious_answer'){
        checks.seriousWins=c?.allowPlayfulness===false;
        checks.seriousPlan=f.session.turnPlan?.execution?.modelProfile==='reasoning';
      }
      if(turnIndex===0&&scenario.continuity)checks.continuityRetained=c?.previousBotReply?.source==='verified_continuity';
      if(scenario.personaOverride){const p=scenario.personaOverride;checks.personaProjection=system.includes(p.name)&&system.includes(p.tone)&&p.speechStyle.every(style=>system.includes(style));}
      if(turnIndex>0){const previous=results.at(-1);checks.ownActualHistory=request.some(m=>historyText(m.content).includes(historyText(previous.output))&&String(m.content).includes('QQ号:99'));checks.previousUserHistory=request.some(m=>m.role==='user'&&historyText(m.content).includes(historyText(previous.input)));}
      for(const [key,ok]of Object.entries(checks))if(!ok)failures.push(key);
      const finalOutput=f.captures.sent.slice(offsets.sent).join('\n');
      const r={id:scenario.id,turnIndex,input:turn.rawUserText,expected:turn.expect||scenario.expect,personaName:f.host.config.persona.name,output:scrub(finalOutput),rawModelOutput:scrub(f.captures.modelOutput),guardChanged:finalOutput!==f.captures.modelOutput,elapsedMs:Date.now()-startedAt,network:f.captures.network.slice(offsets.network),plan:f.session.turnPlan?.execution,interaction:{kind:c?.kind,allowPlayfulness:c?.allowPlayfulness,target:c?.target,evidence:c?.evidence?.map(e=>({origin:e.origin,kind:e.kind,state:e.state})),previousReplySource:c?.previousBotReply?.source},checks,failures,errors:f.captures.errors.slice(offsets.errors),warnings:f.captures.warnings.slice(offsets.warnings)};
      results.push(r);console.log(JSON.stringify({type:'result',...r}));
    }catch(error){const r={id:scenario.id,turnIndex,elapsedMs:Date.now()-startedAt,error:scrub(error.message),failures:['exception']};results.push(r);console.log(JSON.stringify({type:'result',...r}))}
    fs.writeFileSync(path.join(outputDir,dryRun?'dry-results.json':'results.json'),JSON.stringify({commit,label:runLabel,metadata,structuralChecksOnly:true,results},null,2),{mode:0o600});
  }
}
const failed=results.filter(r=>r.failures.length);
console.log(JSON.stringify({type:'complete',structuralPassed:results.length-failed.length,totalTurns:results.length,semanticEvaluation:'manual_required',platformMessagesSent:0,productionStoreWrites:0}));
process.exitCode=failed.length?1:0;
