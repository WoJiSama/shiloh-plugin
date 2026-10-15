// Read-only shadow replay of the compiled conversation path. Sends and user stores stay in memory.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createReplayMemory} from './conversationReplayMemory.mjs';
export const replayUsage='Usage: node scripts/conversationQualityReplay.mjs [--dry-run] [--memory-integration] [--plugin-root path] [--config-root path] [--scenarios file] [--output-dir path] [--scenario id] [--label name] [--repetitions positive-integer]\nWithout --dry-run this calls the configured model. It never connects to QQ or production stores. --memory-integration uses real memory modules with an isolated store. Repetitions default to 1; use 5 to examine stability. Each sample starts a fresh in-memory conversation. Structural checks do not score naturalness.';

export function parseReplayOptions(args=[],env={},cwd=process.cwd()){
  const valueFlags=new Set(['--plugin-root','--config-root','--scenarios','--output-dir','--scenario','--label','--repetitions']);
  const switches=new Set(['--dry-run','--help','--memory-integration']);
  const values=new Map();
  for(let i=0;i<args.length;i++){
    const flag=args[i];
    if(!valueFlags.has(flag)&&!switches.has(flag))throw new Error(`Unknown replay option: ${flag}`);
    if(values.has(flag))throw new Error(`Duplicate replay option: ${flag}`);
    if(switches.has(flag)){values.set(flag,true);continue;}
    const value=args[++i];
    if(!value||value.startsWith('--'))throw new Error(`Replay option requires a value: ${flag}`);
    values.set(flag,value);
  }
  const repetitionText=values.get('--repetitions')??'1';
  const repetitions=Number(repetitionText);
  if(!/^[1-9]\d*$/.test(repetitionText)||!Number.isSafeInteger(repetitions))throw new Error('--repetitions must be a positive safe integer');
  const pluginRoot=path.resolve(cwd,values.get('--plugin-root')||env.BL_SHADOW_PLUGIN_ROOT||cwd);
  const dryRun=values.has('--dry-run');
  return {
    help:values.has('--help'),dryRun,repetitions,pluginRoot,memoryIntegration:values.has('--memory-integration'),
    configRoot:path.resolve(cwd,values.get('--config-root')||env.BL_SHADOW_CONFIG_ROOT||pluginRoot),
    outputDir:path.resolve(cwd,values.get('--output-dir')||env.BL_SHADOW_OUTPUT_DIR||`/tmp/bl-conversation-quality-${Date.now()}`),
    runLabel:values.get('--label')||(dryRun?'offline_stub':'candidate'),
    scenariosFile:path.resolve(cwd,values.get('--scenarios')||path.join(path.dirname(fileURLToPath(import.meta.url)),'../tests/fixtures/conversationQualityReplayScenarios.json')),
    scenarioFilter:values.get('--scenario')||''
  };
}

export function hashReplayValue(value){
  const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

// Keep this whitelist narrow: request bodies contain private system prompts and credentials.
export function generationEvidence(payload={}){
  const keys=['model','temperature','top_p','max_tokens','max_completion_tokens','reasoning_effort','presence_penalty','frequency_penalty','seed','stream'];
  const generation=Object.fromEntries(keys.filter(key=>payload[key]!==undefined).map(key=>[key,payload[key]]));
  return {parameters:generation,hash:hashReplayValue(generation)};
}

export function rebindReplayTaskFacts(declared,event,observedAt=Date.now(),query={}){
  const facts=Array.isArray(declared)?{tasks:declared}:declared||{};
  const requestIds=new Set(query.recentRequestMessageIds||[]);
  const tasks=(facts.tasks||[]).filter(task=>query.referenceMessageId?
    task.requestMessageId===query.referenceMessageId||task.delivery?.messageId===query.referenceMessageId:
    requestIds.has(task.requestMessageId));
  return {
    scope:{botId:String(event.self_id??event.bot?.uin??''),conversationId:event.group_id?`group:${event.group_id}`:`private:${event.user_id}`,userId:String(event.user_id??'')},
    observedAt,lookup:facts.lookup==='unavailable'?'unavailable':'ok',
    tasks:tasks.map(task=>({...structuredClone(task),observedAt}))
  };
}

export function createReplayScrubber(config={}){
  const privateValues=new Set();
  const collect=(value,key='',privateBranch='')=>{
    const sensitive=privateBranch||(/(?:api.?keys?|tokens?|password|secret|authorization)$/i.test(key)?'credential':/(?:systemContent|systemPrompt|identity|notes)$/i.test(key)?'prompt':'');
    if(Array.isArray(value)){for(const item of value)collect(item,key,sensitive);}
    else if(value&&typeof value==='object'){for(const [k,v]of Object.entries(value))collect(v,k,sensitive);}
    else if(sensitive&&typeof value==='string'&&value.length>(sensitive==='credential'?0:8)){
      privateValues.add(value);
      privateValues.add(JSON.stringify(value).slice(1,-1));
    }
  };
  collect(config);
  return value=>{
    let result=String(value);
    for(const secret of [...privateValues].sort((a,b)=>b.length-a.length))result=result.split(secret).join('[REDACTED]');
    return result.replace(/Bearer\s+[A-Za-z0-9._-]+/gi,'Bearer [REDACTED]');
  };
}

export function validateReplayScenarios(scenarios){
  if(!Array.isArray(scenarios)||!scenarios.length)throw new Error('Replay scenarios must be a nonempty array');
  const ids=new Set();
  for(const scenario of scenarios){
    if(typeof scenario.id!=='string'||!scenario.id.trim()||ids.has(scenario.id))throw new Error('Replay scenario ids must be unique nonempty strings');
    ids.add(scenario.id);
    if(scenario.followups!==undefined&&!Array.isArray(scenario.followups))throw new Error(`Invalid followups for ${scenario.id}`);
    for(const turn of [scenario,...(scenario.followups||[])]){
      if(typeof turn.rawUserText!=='string'||!turn.rawUserText.trim()||typeof turn.expectedKind!=='string')throw new Error(`Invalid replay turn for ${scenario.id}`);
    }
  }
  return scenarios;
}

// The orchestrator has no model/config imports. Injection makes session isolation
// and partial-failure retention verifiable without calling a model or the platform.
export async function runReplaySamples({scenarios,repetitions=1,createFixture,executeTurn,describeFailure=()=>({}),onResult=()=>{},scrub=String,now=Date.now}){
  validateReplayScenarios(scenarios);
  if(!Number.isSafeInteger(repetitions)||repetitions<1)throw new Error('repetitions must be a positive safe integer');
  const results=[];
  for(const originalScenario of scenarios){
    for(let sampleIndex=1;sampleIndex<=repetitions;sampleIndex++){
      const scenario=structuredClone(originalScenario);
      const turns=[scenario,...(scenario.followups||[])];
      let fixture,setupError,previousResult;
      try{fixture=await createFixture(scenario,{sampleIndex});await fixture.seedContinuity?.();}catch(error){setupError=error;}
      for(let turnIndex=0;turnIndex<turns.length;turnIndex++){
        const turn=turns[turnIndex];
        const startedAt=now();
        const context={fixture,scenario,turn,sampleIndex,turnIndex,previousResult};
        let result;
        try{
          if(setupError)throw setupError;
          result=await executeTurn(context);
        }catch(error){
          const partial=await describeFailure({...context,error});
          result={...partial,error:scrub(error instanceof Error?error.message:String(error)),failures:[...(partial.failures||[]),setupError?'session_setup_failed':'exception']};
        }
        result={...result,id:scenario.id,sampleIndex,sampleId:`${scenario.id}:sample-${sampleIndex}`,turnIndex,input:turn.rawUserText,elapsedMs:result.elapsedMs??now()-startedAt,failures:result.failures||[]};
        results.push(result);
        // Checkpoint errors are fatal: silently losing evidence would invalidate a run.
        await onResult(result,results);
        previousResult=result;
      }
      await fixture?.dispose?.();
    }
  }
  return results;
}

export function writeReplayCheckpoint(file,document){
  const temporary=`${file}.tmp`;
  fs.writeFileSync(temporary,JSON.stringify(document,null,2),{mode:0o600});
  fs.renameSync(temporary,file);
}

export async function main(argv=process.argv.slice(2),env=process.env){
const {help,pluginRoot,configRoot,outputDir,dryRun,runLabel,scenariosFile,scenarioFilter,repetitions,memoryIntegration}=parseReplayOptions(argv,env);
if(help){console.log(replayUsage);return {exitCode:0};}
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
const snapshotModule=path.join(pluginRoot,'dist/backend/modules/conversation/infrastructure/personaSnapshot.js');
const createSnapshot=fs.existsSync(snapshotModule)?(await import(pathToFileURL(snapshotModule))).createPersonaSnapshot:null;
const {createPersonaFeedbackModule}=await load('modules/memory/infrastructure/personaFeedbackManager.js');
const {isToneCorrectionMessage}=await load('modules/conversation/application/chatFailureReply.js');
const {createMessageFormatting}=await load('modules/conversation/application/messageFormatting.js');
const episodic=memoryIntegration?await load('modules/memory/infrastructure/episodicMemory.js'):null;
const {createPromptContext}=memoryIntegration?await load('modules/conversation/infrastructure/promptContext.js'):{};
const readConfig=file=>{const doc=YAML.parse(fs.readFileSync(file,'utf8'));return doc?.pluginSettings||doc||{}};
const defaults=readConfig(path.join(pluginRoot,'config_default/message.yaml'));
const supplied=dryRun?{}:readConfig(path.join(configRoot,'config/message.yaml'));
const config=decodeHostConfig(mergeDeepConfig(defaults,supplied));
const library=dryRun?null:createPersonaLibrary({libraryPath:path.join(configRoot,'config/persona-library.yaml'),getBasePersona:()=>config.persona});
const identity=dryRun?{persona:config.persona,source:'default_dry_run'}:library.resolve({messageType:'group',groupId:'609235590',selfId:'3094088525'});
const persona=identity.persona;
config.persona=persona;
const scrub=createReplayScrubber(config);
// Production history compacts whitespace. Compare all words without requiring
// the original bubble/newline layout to survive that transport formatting.
const historyText=value=>String(value).replace(/\s+/gu,' ').trim();
const baseScenarios=validateReplayScenarios(JSON.parse(fs.readFileSync(scenariosFile,'utf8')));
const scenarios=baseScenarios.filter(s=>!scenarioFilter||s.id.includes(scenarioFilter));
const fileHash=file=>fs.existsSync(file)?createHash('sha256').update(fs.readFileSync(file)).digest('hex'):null;
const runtimePaths=['modules/tools/infrastructure/chatTurn.js','modules/conversation/domain/personaSource.js','modules/conversation/domain/personaTonePolicy.js','modules/conversation/domain/systemPromptTemplate.js','modules/conversation/domain/systemContentSource.js','modules/conversation/domain/agentIntelligence.js','modules/conversation/infrastructure/turnPromptComposer.js','modules/conversation/infrastructure/turnPlan.js','modules/conversation/domain/turnPlanPolicy.js','modules/models/application/modelExecution.js','modules/conversation/application/finalReply.js'];
const compiledRoot=path.join(pluginRoot,'dist/backend');
const compiledHashes={};
const hashRuntime=directory=>{for(const item of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const file=path.join(directory,item.name);if(item.isDirectory())hashRuntime(file);else if(item.isFile()&&item.name.endsWith('.js'))compiledHashes[path.relative(compiledRoot,file).split(path.sep).join('/')]=fileHash(file);}};
hashRuntime(compiledRoot);
const metadata={schemaVersion:2,pluginRoot,configRoot,repetitions,runnerHash:fileHash(fileURLToPath(import.meta.url)),scenariosHash:fileHash(scenariosFile),selectedScenarioHashes:Object.fromEntries(scenarios.map(s=>[s.id,hashReplayValue(s)])),memoryIntegration,memoryHelperHash:fileHash(path.join(path.dirname(fileURLToPath(import.meta.url)),'conversationReplayMemory.mjs')),memoryPolicy:memoryIntegration?'real_extractor_store_retriever_and_episodic_isolated; vector_embedding_and_profile_learning_disabled':'disabled',configHash:dryRun?null:fileHash(path.join(configRoot,'config/message.yaml')),effectiveConfigHash:hashReplayValue(config),personaHash:hashReplayValue(persona),personaLibraryHash:dryRun?null:fileHash(path.join(configRoot,'config/persona-library.yaml')),runtimeTreeHash:hashReplayValue(compiledHashes),runtimeFileCount:Object.keys(compiledHashes).length,runtimeHashes:Object.fromEntries(runtimePaths.map(file=>[file,fileHash(path.join(compiledRoot,file))])),historyClock:'seed_context_fixed_2026-01-01T04:00:00Z; new_turns_use_wall_clock_or_explicit_scenario_at',runtimeClock:'real_wall_clock_not_frozen',taskFactsSource:'synthetic_fixture',outputPrivacy:'exact private config prompt and credential values are redacted; raw request bodies are never exported'};
if(!scenarios.length)throw new Error('no matching scenarios');
console.log(JSON.stringify({type:'start',dryRun,commit,label:runLabel,metadata,persona:persona.name,personaSource:identity.source,scenarios:scenarios.length,repetitions,totalSamples:scenarios.length*repetitions,adapters:'in_memory_send_and_store',tools:'disabled',enhancedLearning:memoryIntegration?'isolated_memory_enabled':'disabled'}));
let fixtureId = 0

async function fixture(initialScenario, {confirmed = true, directToBot = false} = {}) {
  let scenario=initialScenario;
  let turnIndex=0;
  const fixtureConfig=structuredClone(config);
  let currentPersona=structuredClone(initialScenario.personaOverride || persona);
  const replayTime=at=>new Date(at).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false});
  const initialTime=Date.parse('2026-01-01T04:00:00Z');
  const snapshotOptions={botId:99,personaId:identity.id||'default',persona:currentPersona,systemContent:fixtureConfig.systemContent||'',...(fixtureConfig.personaGuard?{personaGuard:fixtureConfig.personaGuard}:{})};
  const currentSnapshot=()=>createSnapshot?.(snapshotOptions);
  const history=(initialScenario.recentContext||[]).map((message,index)=>({
    message_id:message.messageId||`history-${fixtureId}-${index}`,time:replayTime(initialTime-((initialScenario.recentContext||[]).length-index)*30000),content:message.content,
    ...(message.role==='assistant'&&currentSnapshot()?{source:'send',personaSource:currentSnapshot()}:{}),
    sender:{user_id:Number(message.userId||(message.role==='assistant'?'99':'202')),nickname:message.role==='assistant'?currentPersona.name:(message.name||'测试群友'),role:'member'}
  }));
  const groupId = 900000 + ++fixtureId
  const captures = {compose: [], guards: [], requests: [], generation: [], actionFacts: [], loads: [], writes: [], episodes: [], archived: [], saved: [], enhanced: [], sent: [], errors: [], mainCalls: 0, intentCalls: 0, warnings: [], network: [], memoryNetwork:[], memoryRecalls:[], memoryWrites:[], understanding:[], modelOutput: ''}
  const logger = {info() {}, warn(...args) {captures.warnings.push(scrub(args.join(' ')))}, debug() {}, error(message, error) { captures.errors.push({message:scrub(String(message)), error:scrub(error instanceof Error ? error.message : String(error ?? ''))}) }}
  const trace = {id: `replay-${groupId}`, setTrigger() {}, setIntent() {}, addModelCall() {}, addTool() {}, finish: () => ({modelCalls: [], tools: []})}
  const members = new Map([[99, {user_id: 99, nickname: '测试机器人', role: 'member'}], [202, {user_id: 202, nickname: '测试群友', role: 'member'}], [303, {user_id: 303, nickname: '另一只机器人', role: 'member'}]])
  for(const message of initialScenario.recentContext||[])if(message.userId&&message.name)members.set(Number(message.userId),{user_id:Number(message.userId),nickname:message.name,role:'member'});
  const group = {group_name: '脱敏回放群', getMemberMap: async () => members, pickMember: id => ({info: members.get(Number(id)) || {}}),getForwardMsg:async()=>({messages:scenario.forwardNodes||Array.from({length:scenario.forwardCount||0},(_,i)=>({sender:{user_id:500+i,nickname:`群友${i+1}`},message:[{type:'text',text:i===84?'第85条最终决定：周六下午三点见。':`第${i+1}条：讨论聚会时间。`}]}))})}
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
  const redis = {get: async key => storage.get(key) ?? null, set: async (key, value) => { storage.set(key, value) },del:async key=>storage.delete(key)}
  const isolatedMemory=memoryIntegration?await createReplayMemory({load,config:fixtureConfig,redis,fetchImpl:fetchWithTimeout,scrub,dryRun,captures}):null;
  const episodeDir=path.join(outputDir,`isolated-episodes-${groupId}`);
  const enhancedJobs=[];
  const composer = createTurnPromptComposer(logger)
  const {PersonaFeedbackManager}=createPersonaFeedbackModule({isToneCorrectionMessage,logger});
  const guardManager=new PersonaFeedbackManager({cwd:outputDir,logger});
  const guards = createOutputGuardPipeline({manager:guardManager, info() {}})
  const final = createFinalReply({
    randomUUID: () => `tool-${groupId}`, logger, bot: () => event.bot,
    buildGenericChatFailureReply: () => '未取得结果。', extractModrinthForwardItems: () => [], stripModrinthForwardMarkers: text => text,
    applyOutputPersonaGuards: (text, options) => { captures.guards.push(options); return guards.applyOutputPersonaGuards(text, options) },
    findRecentBotImage: async () => null,
    recordEpisode: options => {captures.episodes.push(options);return episodic?.recordEpisode({...options,baseDir:episodeDir})},
    recordTurnContinuity: async options => { captures.writes.push(options); return recordTurnContinuity({...options, redis}) },
    getActiveConversation: () => undefined, trackingKey: e => `${e.self_id}:${e.group_id}:${e.user_id}`,
    rememberPersonaReply() {}, rememberStyleReply() {}
  })
  const host = {
    config: {...fixtureConfig, persona:currentPersona, enabled:true, groupHistory:true, turnTrace:{archiveEnabled:false}, promptLayerCache:{enabled:false}, episodicMemory:{enabled:true,proactiveEnabled:false}, memorySystem:{enabled:false}, emotionSystem:{enabled:false}, expressionLearning:{enabled:false}, personProfileInjection:{enabled:false}, midtermMemory:{enabled:false}, semanticMemory:{enabled:false}, knowledgeSystem:{enabled:false}, conversationTrackingEnabled:false, globalStyleLearning:{enabled:false}},
    tools: [], toolInstances: {}, _groupLimiters: new Map(),
    isUserBlacklisted: () => false, scheduleMergedToolRequest: () => true, refreshLocalToolRegistry: async () => {}, waitForMCPReady: async () => {},
    beginConversationTask: async () => ({messageId: event.message_id}), getOrCreateSession: () => session, clearSession() {},
    handleActiveDrawStatusQuestion: async () => false,
    buildMessageContent: async (_sender, args, images) => `[2026-01-01 12:00:00] 测试群友(qq号:202)[群身份:member]: 在群里说: ${args}${images.length ? '\n[图片素材引用]' : ''}${scenario.quote ? `\n[回复 ${scenario.quote.name} 的消息: ${scenario.quote.text}]` : ''}`,
    resolvePrimaryModelIntent: async () => { captures.intentCalls++; return null },
    getSmartState: () => ({}), getPersonaFor: e => e?._personaSnapshot?.persona || currentPersona, getChatConfig() { return this.config },
    ...(createSnapshot?{getPersonaSnapshotFor:currentSnapshot}:{}),
    getCurrentGroupContext: async () => ({groupId, groupName: '脱敏回放群'}), getBasicGroupContext: () => ({groupId, groupName: '脱敏回放群'}),
    buildMergedDirectTriggerPrompt: () => '',
    messageManager: {getMessages: async () => history.slice().reverse(), recordMessage: async record => {
      captures.archived.push(record);
      history.push({...record,at:record.time*1000,time:replayTime(record.time*1000),content:(record.message||[]).filter(s=>s.type==='text').map(s=>s.text).join('')});
    }},
    getTaskStatus: async () => null, formatTaskStatusForPrompt: () => '', resolveUnderstandingPrompt: async () => '',
    getTurnActionFacts:async(e,query={})=>{const declared=scenario.taskFacts??initialScenario.taskFacts;const facts=rebindReplayTaskFacts(declared,e,Date.now(),query);captures.actionFacts.push({query:structuredClone(query),facts});return facts;},
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
    saveGroupUserMessages: async (...args) => captures.saved.push(args), updateEnhancedSystems: async (...args) => {
      captures.enhanced.push(args);
      if(isolatedMemory){const job=final.updateEnhancedSystems(host,...args);enhancedJobs.push(job);return job;}
    },
    finishConversationTask: async () => {}, recordReplyLatency() {}, formatTime: () => '12:00', setTrackingWithTimer() {}
  }
  if(isolatedMemory){host.config.memorySystem={...host.config.memorySystem,enabled:true};host.memoryManager=isolatedMemory.manager;}
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
    loadTurnContinuity: async options => { captures.loads.push(options); return scenario.memoryOnly?null:loadTurnContinuity({...options, redis}) },
    computeAddresseeSignal: () => ({targetKind: directToBot ? 'bot' : scenario.quote && scenario.quote.userId !== '99' ? 'other' : 'bot'}), buildAddresseePrompt: () => '',
    resolvePromptLayerProfile, buildTurnContinuityPrompt, delay: async () => {},
    formatGroupWorkflowTeachingPrompt: () => '', formatGroupKnowledgeTeachingPrompt: () => '', formatIdentityBindingsPrompt: () => '',
    mcpManager: {getMCPSystemPrompts: () => ''}, rollPersonaMood: () => null, getMidtermMemoryManager: () => null,
    composeTurnPromptLayers: async options => { captures.compose.push(options); return composer.composeTurnPromptLayers(options) },
    getGroupTopicPrompt: () => '', getGroupSocialPrompt: () => '', getSemanticMemoryRuntime: () => null, hasTemporalDeixis: text => episodic?.hasTemporalDeixis(text)??false,
    recallEpisodes:options=>scenario.memoryOnly?[]:episodic?.recallEpisodes({...options,baseDir:episodeDir})||[],buildEpisodicPrompt:(...args)=>episodic?.buildEpisodicPrompt(...args)||'',
    recallUserEpisodes: options => episodic?.recallUserEpisodes({...options,baseDir:episodeDir})||[], buildUserCallbackPrompt: (...args) => episodic?.buildUserCallbackPrompt(...args)||'', buildMainSystemPrompt, containsInternalStatusLeak: () => false,
    resolveHistorySelectionBudget: () => ({mode: 'compact', recentCount: 3, relevantCount: 0, maxMessages: 3}), selectRelevantGroupHistory: messages => messages,
    shouldUseExcelWorkbookTool: () => false, buildExcelToolParams: () => null,
    resolveToolRoute: async () => ({toolChoice: 'none', forcedToolCall: null, toolScopeLocked: true, applied: []}),
    createTurnPlan,
    isEducationalExplanationRequest: () => false, classifyEmojiToolExposure: () => '', resolveCardPresentation: () => '',
    deriveTurnPlanRequest, formatTurnPlanLog, cardAcknowledgement: () => '', buildToolIntentDisclosure: () => '',
    buildChatRequestData: (_config, messages, tools, choice) => { captures.requests.push(structuredClone(messages));const data=buildChatRequestData(_config,messages,tools,choice);captures.generation.push(generationEvidence(data));return data; },
    collectThinking() {}, extractEmbeddedToolCalls: () => ({calls: [], remainder: ''}), sendThinkingForward: async () => {},
    recordTurnDiagnostics() {}, buildCommittedActionReply: () => '', buildDrawFailureNoteMessage: () => '', takeDrawFailureNote: () => null
  }
  if(memoryIntegration){
    const context=createPromptContext({formatAvatarDrawReferencePrompt:()=>'',info(){},fetchBrief:async (url,options,timeoutMs)=>{
      if(dryRun) return {ok:false,status:503};
      const started=Date.now();
      try{const response=await fetchWithTimeout(url,options,timeoutMs);captures.understanding.push({status:response.status,elapsedMs:Date.now()-started});return response;}
      catch(error){captures.understanding.push({status:null,elapsedMs:Date.now()-started,error:scrub(String(error?.message||error))});throw error;}
    }});
    for(const [name,method] of Object.entries(context))host[name]=(...args)=>method(host,...args);
  }
  const formatting=createMessageFormatting({botId:()=>event.self_id,error:()=>{}});
  host.formatTime=()=>formatting.formatTime(host);
  host.buildMessageContent=(...args)=>formatting.buildMessageContent(host,...args);
  host.formatMessages=(messages,e,current)=>formatting.formatMessages(host,messages,e,current);
  members.set(99,{user_id:99,nickname:currentPersona.name||'希洛',role:'member'});
  event.bot.nickname=currentPersona.name||'希洛';
  if(directToBot)event.message.unshift({type:'at',qq:99});
  const executor=createModelExecutor({
    fetch:async (url,options)=>{
      const payload=JSON.parse(options.body); const started=Date.now();
      const record={model:payload.model,urlHost:new URL(url).host,messageCount:payload.messages.length,systemChars:payload.messages.filter(x=>x.role==='system').reduce((n,x)=>n+String(x.content||'').length,0),generation:generationEvidence(payload).parameters,generationHash:generationEvidence(payload).hash};
      try{const response=await fetchWithTimeout(url,options,90000);captures.network.push({...record,status:response.status,elapsedMs:Date.now()-started});return response;}
      catch(error){captures.network.push({...record,status:null,elapsedMs:Date.now()-started,error:scrub(error instanceof Error?error.message:String(error))});throw error;}
    },
    logger:{info(){},warn(...args){captures.warnings.push(scrub(args.join(' ')))},error(...args){captures.errors.push({message:scrub(args.map(x=>typeof x==='string'?x:JSON.stringify(x)).join(' '))})}},
    removeToolPromptsFromMessages,resolveChatCompletionUrl,resolveAgentBackend,shouldAcceptPlannerTextResponse,summarizeToolResultForAgent
  });
  const api = createChatTurn(ports)
  return {api, host, event, session, captures,isolatedMemory,dispose:()=>isolatedMemory?.dispose(),
    run: async (turn=initialScenario) => {
      scenario=turn;
      if(turn.personaOverride){currentPersona=structuredClone(turn.personaOverride);snapshotOptions.persona=currentPersona;host.config.persona=currentPersona;}
      if(turn.personaId)snapshotOptions.personaId=turn.personaId;
      if(turn.botId){snapshotOptions.botId=Number(turn.botId);event.self_id=Number(turn.botId);event.bot={...event.bot,uin:Number(turn.botId)};}
      event.bot.nickname=currentPersona.name||'测试机器人';
      members.set(event.self_id,{user_id:event.self_id,nickname:event.bot.nickname,role:'member'});
      event.time=Math.floor((turn.at?Date.parse(turn.at):Date.now())/1000);
      event._receivedAt=Date.now();
      event.msg=turn.rawUserText;
      event.user_id=Number(turn.userId||initialScenario.userId||202);
      const nickname=turn.userName||initialScenario.userName||members.get(event.user_id)?.nickname||'测试群友';
      members.set(event.user_id,{user_id:event.user_id,nickname,role:'member'});
      event.sender=members.get(event.user_id);
      event.message_id=`input-${groupId}-${turnIndex++}`;
      event.message=[...(directToBot?[{type:'at',qq:event.self_id}]:[]),{type:'text',text:turn.rawUserText}];
      if(turn.imageSource)event.message.push({type:'image',url:turn.imageSource});
      if(turn.videoSource)event.message.push({type:'video',url:turn.videoSource});
      if(turn.forwardNodes||turn.forwardCount)event.message.push({type:'forward',id:`forward-${groupId}-${turnIndex}`});
      delete event.reply_id;delete event.getReply;delete event._quotedPromptContext;
      if(turn.quote){const q=turn.quote;event.reply_id=q.messageId;event.getReply=async()=>({message_id:q.messageId,user_id:q.userId,sender:{user_id:q.userId,nickname:q.name},message:[{type:'text',text:q.text}]});event._quotedPromptContext={text:q.text,messageId:q.messageId,userId:q.userId,senderUserId:q.userId,senderName:q.name}}
      const sentStart=captures.sent.length;
      if(turn.memoryOnly)history.length=0;
      history.push({self_id:event.self_id,source:'receive',message_id:event.message_id,at:event.time*1000,time:replayTime(event.time*1000),content:turn.rawUserText,sender:{user_id:event.user_id,nickname:event.sender.nickname,role:'member'}});
      const handled=await api.handleToolInner(host,event);
      captures.lastReplyElapsedMs=Date.now()-captures.turnStartedAt;
      const memoryStarted=Date.now();
      await Promise.all(enhancedJobs.splice(0));
      await isolatedMemory?.drain();
      captures.lastMemoryElapsedMs=Date.now()-memoryStarted;
      if(isolatedMemory)captures.lastMemorySnapshot=await isolatedMemory.snapshot(groupId);
      return handled;
    },
    seedContinuity: (record = scenario.continuity) => record ? recordTurnContinuity({...record, groupId, userId: 202, redis,...(currentSnapshot()?{persona:currentSnapshot()}:{})}) : Promise.resolve(),
    readContinuity: (botId = '99') => loadTurnContinuity({groupId, userId: 202, botId, redis,...(session.personaSnapshot?{persona:session.personaSnapshot}:{})})}
}


const attempts=new WeakMap();
const describeTurn=({fixture:f,scenario,turn,turnIndex,previousResult},handled)=>{
      const {startedAt,offsets,intentCalls}=attempts.get(f)||{startedAt:Date.now(),offsets:Object.fromEntries(['sent','requests','generation','actionFacts','errors','warnings','network','memoryNetwork','memoryRecalls','memoryWrites','understanding'].map(key=>[key,0])),intentCalls:0};
      const failures=[];
      const c=f.session.interactionContext;
      const request=f.captures.requests[offsets.requests]||[];
      const system=request.find(m=>m.role==='system')?.content||'';
      const checks={handled:handled===true,kind:c?.kind===turn.expectedKind,rawBody:c?.rawUserText===turn.rawUserText,interactionLayer:system.includes('【本轮互动】'),target:c?.target?.kind===(turn.expectedTarget||'bot'),noExtraIntent:f.captures.intentCalls===intentCalls,modelResponded:Boolean(f.captures.modelOutput),finalOutput:f.captures.sent.slice(offsets.sent).some(t=>t!=='影子回放模型调用失败'),noRuntimeError:f.captures.errors.length===offsets.errors};
      if(turn.imageSource)checks.imageReferenceOnly=c?.evidence?.some(e=>e.kind==='image'&&e.state==='reference_only'&&!e.text);
      if(turn.videoSource){checks.videoReferenceOnly=c?.evidence?.some(e=>e.kind==='video'&&e.state==='reference_only'&&!e.text);if(turn.quote&&String(turn.quote.userId)!=='99')checks.otherBotNotMe=!c?.previousBotReply;if(turn.quote)checks.quoteRetained=system.includes(turn.quote.text)}
      if(turn.expectedKind==='serious_answer'){
        checks.seriousWins=c?.allowPlayfulness===false;
        checks.seriousPlan=f.session.turnPlan?.execution?.modelProfile==='reasoning';
      }
      if(turnIndex===0&&scenario.continuity)checks.continuityRetained=c?.previousBotReply?.source==='verified_continuity';
      if(scenario.personaOverride){const p=turn.personaOverride||f.host.config.persona;checks.personaProjection=system.includes(p.name)&&system.includes(p.tone)&&p.speechStyle.every(style=>system.includes(style));}
      if(memoryIntegration&&!dryRun&&turn.expectedRecall){checks.longTermRecall=f.captures.memoryRecalls.slice(offsets.memoryRecalls).some(r=>r.prompt.includes(turn.expectedRecall));}
      if(memoryIntegration&&!dryRun&&turn.expectedNewFact){
        const facts=Object.values(f.captures.lastMemorySnapshot?.entities||{}).flatMap(entity=>entity.facts||[]).concat(f.captures.lastMemorySnapshot?.facts||[]);
        checks.memoryCommitted=facts.some(fact=>fact.text?.includes(turn.expectedNewFact));
        checks.extractionCommitted=f.captures.memoryWrites.slice(offsets.memoryWrites).some(write=>write.result?.status==='success'||write.result?.written>0);
      }
      if(memoryIntegration&&!dryRun&&turn.expectedEventDate){
        const facts=Object.values(f.captures.lastMemorySnapshot?.entities||{}).flatMap(entity=>entity.facts||[]).concat(f.captures.lastMemorySnapshot?.facts||[]);
        checks.memoryEventDate=facts.some(fact=>fact.eventAt&&new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(fact.eventAt)===turn.expectedEventDate);
      }
      if(turnIndex>0&&previousResult&&!turn.memoryOnly){
        if(previousResult.output)checks.ownActualHistory=request.some(m=>historyText(m.content).includes(historyText(previousResult.output))&&String(m.content).includes(`QQ号:${previousResult.botId||99}`));
        checks.previousUserHistory=request.some(m=>m.role==='user'&&historyText(m.content).includes(historyText(previousResult.input)));
      }
      // Baseline runtimes may predate this port. Report capability separately;
      // never manufacture a structural failure solely to favor the candidate.
      const actionFactsCalls=f.captures.actionFacts.slice(offsets.actionFacts);
      if(c?.actionFacts){checks.actionFactsScoped=c.actionFacts.scope?.botId===String(f.event.self_id)&&c.actionFacts.scope?.conversationId===`group:${f.event.group_id}`&&c.actionFacts.scope?.userId===String(f.event.user_id);}
      for(const [key,ok]of Object.entries(checks))if(!ok)failures.push(key);
      const finalOutput=f.captures.sent.slice(offsets.sent).join('\n');
      return {expected:turn.expect||scenario.expect,semanticChecks:turn.semanticChecks||scenario.semanticChecks||[],manualReview:turn.manualReview||scenario.manualReview||[],botId:String(f.event.self_id),personaName:f.host.config.persona.name,personaHash:hashReplayValue(f.host.config.persona),scenarioHash:hashReplayValue(scenario),requestHash:hashReplayValue(request),generation:f.captures.generation.slice(offsets.generation),output:scrub(finalOutput),rawModelOutput:scrub(f.captures.modelOutput),guardChanged:finalOutput!==f.captures.modelOutput,elapsedMs:Date.now()-startedAt,network:f.captures.network.slice(offsets.network),replyElapsedMs:f.captures.lastReplyElapsedMs,memoryDrainElapsedMs:f.captures.lastMemoryElapsedMs,understanding:f.captures.understanding.slice(offsets.understanding),memory:memoryIntegration?{network:f.captures.memoryNetwork.slice(offsets.memoryNetwork),extractions:f.captures.memoryWrites.slice(offsets.memoryWrites),recalls:f.captures.memoryRecalls.slice(offsets.memoryRecalls),snapshot:f.captures.lastMemorySnapshot}:null,plan:f.session.turnPlan?.execution,actionFacts:{source:'synthetic_fixture',providerUsed:actionFactsCalls.length>0,calls:actionFactsCalls,context:c?.actionFacts||null},diagnosticContext:c?.diagnosticContext||null,interaction:{kind:c?.kind,allowPlayfulness:c?.allowPlayfulness,target:c?.target,evidence:c?.evidence?.map(e=>({origin:e.origin,kind:e.kind,state:e.state})),social:c?.social,previousReplySource:c?.previousBotReply?.source},checks,failures,errors:f.captures.errors.slice(offsets.errors),warnings:f.captures.warnings.slice(offsets.warnings)};
};
const resultFile=path.join(outputDir,dryRun?'dry-results.json':'results.json');
const replayDocument=(results,complete=false)=>({commit,label:runLabel,metadata,complete,structuralChecksOnly:true,semanticEvaluation:'manual_required',platformMessagesSent:0,productionStoreWrites:0,results});
writeReplayCheckpoint(resultFile,replayDocument([]));
const results=await runReplaySamples({
  scenarios,repetitions,scrub,
  createFixture:scenario=>fixture(scenario,{directToBot:scenario.directToBot!==false}),
  executeTurn:async context=>{
    const f=context.fixture;
    f.captures.modelOutput='';
    f.captures.turnStartedAt=Date.now();
    attempts.set(f,{startedAt:Date.now(),offsets:Object.fromEntries(['sent','requests','generation','actionFacts','errors','warnings','network','memoryNetwork','memoryRecalls','memoryWrites','understanding'].map(key=>[key,f.captures[key].length])),intentCalls:f.captures.intentCalls});
    const handled=await f.run(context.turn);
    return describeTurn(context,handled);
  },
  describeFailure:context=>context.fixture?describeTurn(context,undefined):{},
  onResult:(result,allResults)=>{writeReplayCheckpoint(resultFile,replayDocument(allResults));console.log(JSON.stringify({type:'result',...result}));}
});
const failed=results.filter(r=>r.failures.length);
writeReplayCheckpoint(resultFile,replayDocument(results,true));
console.log(JSON.stringify({type:'complete',structuralPassed:results.length-failed.length,totalTurns:results.length,totalSamples:scenarios.length*repetitions,repetitions,semanticEvaluation:'manual_required',platformMessagesSent:0,productionStoreWrites:0}));
return {exitCode:failed.length?1:0,results,metadata,resultFile};
}

const isMain=process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url;
if(isMain){
  try{process.exitCode=(await main()).exitCode;}
  catch(error){
    // Config/parser/model initialization errors can embed private YAML or prompts.
    // Argument validation messages are safe; all other details stay off stdout.
    const argumentError=/^(?:Unknown replay option:|Duplicate replay option:|Replay option requires a value:|--repetitions must)/.test(String(error?.message));
    console.error(JSON.stringify({type:'fatal',error:argumentError?error.message:'Replay initialization or evidence persistence failed; the run is incomplete.',name:error?.name||'Error'}));
    process.exitCode=1;
  }
}
