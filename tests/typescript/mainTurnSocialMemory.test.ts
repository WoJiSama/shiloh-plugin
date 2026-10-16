import test from 'node:test'
import assert from 'node:assert/strict'
import {createChatTurn} from '../../src/modules/tools/infrastructure/chatTurn.js'
import {createFinalReply, type FinalEvent, type FinalReplyHost} from '../../src/modules/conversation/application/finalReply.js'
import {createPersonaSnapshot} from '../../src/modules/conversation/infrastructure/personaSnapshot.js'
import {createTurnPromptComposer} from '../../src/modules/conversation/infrastructure/turnPromptComposer.js'
import {buildTurnInteractionContext,withTurnSocialInterpretation} from '../../src/modules/conversation/domain/turnInteractionContext.js'
import {collectForwardContext} from '../../src/modules/conversation/infrastructure/groupContextResolver.js'
import type {ChatTurnEvent,ChatTurnHost,ChatTurnPorts,ChatTurnSession,PendingSocialState} from '../../src/contracts/chatTurn.js'
import type {MemoryExtractionMessage,MemoryExtractionMeta} from '../../src/contracts/memoryEngine.js'

const captured = createPersonaSnapshot({botId:99,personaId:'first',persona:{name:'甲',tone:'简洁冷静'},systemContent:'甲的独立判断'})
const replacement = createPersonaSnapshot({botId:99,personaId:'second',persona:{name:'乙',tone:'活泼直率'},systemContent:'乙的独立判断'})
type ComposeOptions = Parameters<ReturnType<typeof createTurnPromptComposer>['composeTurnPromptLayers']>[0]

function turnFixture(text='这个呢') {
 const errors:unknown[] = [], composed:{options:ComposeOptions;tone:string}[] = [], order:string[] = []
 const logger={info(){},warn(){},debug(){},error(...args:unknown[]){errors.push(args)}}
 const members=new Map([[99,{user_id:99,nickname:'账号昵称',role:'member'}],[202,{user_id:202,nickname:'群友',role:'member'}]])
 const group={getMemberMap:async()=>members,pickMember:()=>({info:{}})}
 const event:ChatTurnEvent={message_type:'group',group_id:42,user_id:202,self_id:99,message_id:'current',msg:text,
  message:[{type:'text',text}],sender:{user_id:202,nickname:'群友'},group,bot:{uin:99,nickname:'账号昵称',pickGroup:()=>group}}
 const session:ChatTurnSession={tools:[],groupUserMessages:[]}
 const assets:Awaited<ReturnType<ChatTurnPorts['resolveGroupContextAssets']>>={images:[],currentImages:[],quotedImages:[],forwardImages:[],videos:[]}
 const composer=createTurnPromptComposer()
 let current=replacement, briefCalls=0, intentCalls=0
 const ports:Partial<ChatTurnPorts>={
  logger,botIdentity:()=>({uin:99,nickname:'账号昵称'}),isAiConversationEnabled:()=>true,evaluatePrivateChatGate:()=>({allowed:true,reason:''}),
  resolveConversationContext:()=>({kind:'group',botId:'99',conversationId:'group:42',userId:'202'}),
  createTurnTrace:()=>({id:'trace',setTrigger(){},setIntent(){},addModelCall(){},addTool(){},finish:()=>({modelCalls:[],tools:[]})}),resolveTurnTraceArchiveDir:()=>'/tmp',
  createOutboundArbiter:()=>({wrapEvent:e=>e,beginToolOutcomes(){},enqueue(){},settle(){},resolveToolOutcomes(){}}),
  getOrCreateGroupLimiter:()=>work=>work(),cacheGroupName:async()=>{},resolveGroupContextAssets:async()=>assets,formatGroupContextImagePrompt:()=>'',
  TakeImages:async()=>[],shouldRequireImageEditBase:()=>false,resolveRecentBotImage:async()=>null,resolveRecentUserImage:async()=>null,
  prepareImageEditAssets:()=>null,resolveAvatarEditBase:()=>null,resolveAvatarInspectionTargets:()=>null,resolveAvatarDrawReference:()=>null,
  shouldAskForMissingImageForVisualRequest:()=>false,selectToolIntentCandidates:()=>[],shouldSkipIntentModel:()=>true,resolveDeterministicToolIntent:()=>null,
  hasExcelWorkbookContext:()=>false,hasRecentPixivSearch:()=>false,loadTurnContinuity:async()=>null,computeAddresseeSignal:()=>({targetKind:'bot'}),buildAddresseePrompt:()=>'',
  resolvePromptLayerProfile:()=>({profile:'chat'}),buildTurnContinuityPrompt:()=>'',delay:async()=>{},formatGroupWorkflowTeachingPrompt:()=>'',formatGroupKnowledgeTeachingPrompt:()=>'',formatIdentityBindingsPrompt:()=>'',
  mcpManager:{getMCPSystemPrompts:()=>''},rollPersonaMood:()=>null,getMidtermMemoryManager:()=>null,
  composeTurnPromptLayers:async raw=>{order.push('tone');const options=raw as ComposeOptions;const result=await composer.composeTurnPromptLayers(options);composed.push({options,tone:result.layerValues.personaTone||''});return result},
  getGroupTopicPrompt:()=>'',getGroupSocialPrompt:()=>'',getSemanticMemoryRuntime:()=>null,hasTemporalDeixis:()=>false,recallUserEpisodes:()=>[],buildUserCallbackPrompt:()=>'',
  buildMainSystemPrompt:()=> '主提示',containsInternalStatusLeak:()=>false,resolveHistorySelectionBudget:()=>({mode:'compact',recentCount:3,relevantCount:0,maxMessages:3}),selectRelevantGroupHistory:messages=>messages,
  shouldUseExcelWorkbookTool:()=>false,buildExcelToolParams:()=>null,resolveToolRoute:async()=>({toolChoice:'none',forcedToolCall:null,toolScopeLocked:true,applied:[]}),
  createTurnPlan:()=>({id:'plan',intent:'chat',execution:{mode:'chat',modelProfile:'chat',toolChoice:'none'},capabilities:{required:[],optional:[],available:[]},context:{historyMode:'compact',selectedHistoryCount:0},presentation:{kind:'text'},observability:{routeReason:'source-test'}}),
  isEducationalExplanationRequest:()=>false,classifyEmojiToolExposure:()=>'',resolveCardPresentation:()=>'',deriveTurnPlanRequest:()=>({toolChoice:'none'}),formatTurnPlanLog:()=>'',cardAcknowledgement:()=>'',buildToolIntentDisclosure:()=>'',
  buildChatRequestData:()=>({}),collectThinking(){},extractEmbeddedToolCalls:()=>({calls:[],remainder:''}),sendThinkingForward:async()=>{},recordTurnDiagnostics(){},buildCommittedActionReply:()=>'',buildDrawFailureNoteMessage:()=>'',takeDrawFailureNote:()=>null
 }
 const host:Partial<ChatTurnHost>={
  config:{enabled:true,persona:replacement.persona,systemContent:replacement.systemContent,groupHistory:true,episodicMemory:{enabled:false}},tools:[],toolInstances:{},_groupLimiters:new Map(),
  isUserBlacklisted:()=>false,scheduleMergedToolRequest:()=>true,refreshLocalToolRegistry:async()=>{},waitForMCPReady:async()=>{},beginConversationTask:async()=>({}),getOrCreateSession:()=>session,clearSession(){},
  sendObservedReply:async()=>null,handleActiveDrawStatusQuestion:async()=>false,buildMessageContent:async(_sender,args)=>args,
  resolvePrimaryModelIntent:async()=>{intentCalls++;return null},getSmartState:()=>({}),getPersonaFor:()=>current.persona,getPersonaSnapshotFor:()=>current,getChatConfig(){return this.config!},
  getCurrentGroupContext:async()=>({}),getBasicGroupContext:()=>({}),buildMergedDirectTriggerPrompt:()=>'',messageManager:{getMessages:async()=>[]},getTaskStatus:async()=>null,formatTaskStatusForPrompt:()=>'',
  resolveUnderstandingPrompt:async()=>{briefCalls++;order.push('understanding');return ''},trimMessageHistory:messages=>messages,filterChatByQQ:messages=>messages,formatMessages:messages=>messages,
  getToolsByName:()=>[],getImageGenerationReferenceImages:images=>images,retryRequest:async()=>({choices:[{message:{content:'接住这句'}}]}),buildMissingToolCommitmentCall:()=>null,handleTextResponse:async()=>{},finishConversationTask:async()=>{},recordReplyLatency(){}
 }
 const api=createChatTurn(ports as ChatTurnPorts)
 return {event,session,assets,host:host as ChatTurnHost,composed,order,errors,api,setSnapshot:(snapshot:typeof captured)=>{current=snapshot},counts:()=>({briefCalls,intentCalls})}
}

function gateHandoff(event:ChatTurnEvent):PendingSocialState {
 const context=withTurnSocialInterpretation(buildTurnInteractionContext({rawUserText:String(event.msg),botId:99,persona:captured,addressee:{targetKind:'bot'}}),{act:'teasing',target:'bot',confidence:0.96},'gate_model')
 return {state:context.social!,rawUserText:String(event.msg),groupId:String(event.group_id),userId:String(event.user_id),persona:captured}
}

test('main turn consumes a matching Gate social handoff once and pins its persona through tone', async()=>{
 const f=turnFixture()
 f.event._pendingPersonaSnapshot=captured
 f.event._pendingSocialState=gateHandoff(f.event)
 assert.equal(await f.api.handleToolInner(f.host,f.event),true)
 assert.deepEqual(f.errors,[])
 assert.equal(f.session.personaSnapshot,captured)
 assert.equal(f.composed[0]?.options.personaSnapshot,captured)
 assert.equal(f.composed[0]?.options.turn?.interactionContext?.social?.source,'gate_model')
 assert.equal(f.composed[0]?.options.turn?.interactionContext?.social?.act,'teasing')
 assert.deepEqual(f.counts(),{briefCalls:0,intentCalls:0})
 assert.equal(Object.hasOwn(f.event,'_pendingPersonaSnapshot'),false)
 assert.equal(Object.hasOwn(f.event,'_pendingSocialState'),false)
 f.event.msg='你好呀'
 f.event.message=[{type:'text',text:f.event.msg}]
 assert.equal(await f.api.handleToolInner(f.host,f.event),true)
 assert.equal(f.session.personaSnapshot,replacement)
 assert.equal(f.session.interactionContext?.social?.source,'local')
 assert.deepEqual(f.errors,[])
})

test('main turn ignores a Gate social handoff belonging to another input, user, group or persona revision', async()=>{
 for(const field of ['rawUserText','userId','groupId','persona'] as const) {
  const f=turnFixture('你好呀'), handoff=gateHandoff(f.event)
  f.event._pendingPersonaSnapshot=captured
  f.event._pendingSocialState={...handoff,...(field==='persona'?{persona:{...captured,personaVersion:'other'}}:{[field]:'other'})}
  assert.equal(await f.api.handleToolInner(f.host,f.event),true)
  assert.deepEqual(f.errors,[])
  assert.equal(f.session.interactionContext?.social?.source,'local',field)
  assert.equal(Object.hasOwn(f.event,'_pendingSocialState'),false)
 }
})

test('main turn awaits the understanding update before composing tone from the same social context', async()=>{
 const f=turnFixture()
 f.host.resolveUnderstandingPrompt=async raw=>{
  f.order.push('understanding')
  await Promise.resolve()
  const session=(raw as {session:ChatTurnSession}).session
  session.interactionContext=withTurnSocialInterpretation(session.interactionContext!,{act:'factual_question',target:'bot',confidence:0.95},'understanding_model')
  f.order.push('interpreted')
  return '已有依据的理解简报'
 }
 assert.equal(await f.api.handleToolInner(f.host,f.event),true)
 assert.deepEqual(f.errors,[])
 assert.deepEqual(f.order,['understanding','interpreted','tone'])
 assert.equal(f.composed[0]?.options.turn?.interactionContext,f.session.interactionContext)
 assert.equal(f.session.interactionContext?.social?.source,'understanding_model')
 assert.equal(f.session.interactionContext?.kind,'serious_answer')
 assert.equal(f.session.interactionContext?.allowPlayfulness,false)
 assert.match(f.composed[0]?.tone||'',/事实|精确|明确/)
})

test('empty forward collection does not invent an unread forward in ordinary chat',async()=>{
 const f=turnFixture('你好呀')
 const empty=(await collectForwardContext(null,[])).completeness
 f.assets.currentForwardCompleteness=empty
 f.assets.quotedForwardCompleteness=empty
 assert.equal(await f.api.handleToolInner(f.host,f.event),true)
 assert.deepEqual(f.errors,[])
 assert.equal(f.session.interactionContext?.evidence.some(item=>item.origin==='forward'),false)
})

test('source-checked diagnostic history keeps a short follow-up serious before tone composition',async()=>{
 const f=turnFixture('那我能先开机试一下吗？')
 f.host.messageManager.getMessages=async()=>[{self_id:99,source:'receive',sender:{user_id:202,nickname:'群友'},content:'电脑电源那里有焦糊味，已经拔电了。别开玩笑，能怎么办？',at:Date.now()-10000,message_id:'previous'}]
 assert.equal(await f.api.handleToolInner(f.host,f.event),true)
 assert.deepEqual(f.errors,[])
 assert.equal(f.session.interactionContext?.diagnosticContext?.incident.status,'asserted')
 assert.equal(f.session.interactionContext?.kind,'serious_answer')
 assert.equal(f.session.interactionContext?.social?.act,'help_request')
 assert.equal(f.session.interactionContext?.allowPlayfulness,false)
 assert.equal(f.composed[0]?.options.turn?.interactionContext,f.session.interactionContext)
 assert.match(f.composed[0]?.tone||'',/事实|精确|明确/)
})

test('another member diagnostic report does not become the current speaker device state',async()=>{
 const f=turnFixture('那我能先开机试一下吗？')
 f.host.messageManager.getMessages=async()=>[{self_id:99,source:'receive',sender:{user_id:303,nickname:'另一位群友'},content:'电脑电源有焦糊味，已经拔电了。',at:Date.now()-10000,message_id:'other'}]
 assert.equal(await f.api.handleToolInner(f.host,f.event),true)
 assert.deepEqual(f.errors,[])
 assert.equal(f.session.interactionContext?.diagnosticContext?.incident.status,'unknown')
 assert.deepEqual(f.session.interactionContext?.diagnosticContext?.incident.signals,[])
 assert.equal(f.session.interactionContext?.diagnosticContext?.power,'unknown')
 assert.ok(f.session.interactionContext?.diagnosticContext?.sources.every(item=>item.origin==='current'))
 assert.equal(f.session.interactionContext?.kind,'conversation')
})

test('a positively framed device meme stays playful after diagnostic source resolution',async()=>{
 const f=turnFixture('这张梗图是CPU满载92℃冒烟，吐槽一下。')
 assert.equal(await f.api.handleToolInner(f.host,f.event),true)
 assert.deepEqual(f.errors,[])
 assert.equal(f.session.interactionContext?.diagnosticContext?.purpose,'figurative')
 assert.equal(f.session.interactionContext?.kind,'banter')
 assert.equal(f.session.interactionContext?.social?.act,'teasing')
 assert.equal(f.session.interactionContext?.allowPlayfulness,true)
})

function memoryFixture(history:unknown[]=[]) {
 const user:{text:string;meta:MemoryExtractionMeta}[] = [], group:{history:MemoryExtractionMessage[];meta:MemoryExtractionMeta}[] = []
 const final=createFinalReply({randomUUID:()=> 'tool',logger:{warn(){},info(){},error(){}},bot:()=>({uin:99,nickname:'账号昵称'}),buildGenericChatFailureReply:()=>'',
  extractModrinthForwardItems:()=>[],stripModrinthForwardMarkers:text=>text,applyOutputPersonaGuards:text=>text,findRecentBotImage:async()=>null,recordEpisode(){},recordTurnContinuity:async()=>{},getActiveConversation:()=>undefined,trackingKey:()=>'',rememberPersonaReply(){},rememberStyleReply(){}})
 const host={config:{memorySystem:{enabled:true}},getPersonaFor:()=>replacement.persona,
  messageManager:{getMessages:async()=>history},memoryManager:{
   extractAndSaveMemories:(_group:unknown,_user:unknown,text:string,_reply:string,meta:MemoryExtractionMeta)=>{user.push({text,meta});return Promise.resolve()},
   extractAndSaveGroupMemories:(_group:unknown,messages:MemoryExtractionMessage[],meta:MemoryExtractionMeta)=>{group.push({history:messages,meta});return Promise.resolve()}
  }} as unknown as FinalReplyHost
 const event:FinalEvent={group_id:42,user_id:202,self_id:99,message_id:'input',time:Date.parse('2026-01-31T23:50:00+08:00')/1000,_receivedAt:Date.parse('2026-02-01T01:00:00+08:00'),msg:'明天考试',sender:{nickname:'群友'},_personaSnapshot:replacement,reply:async()=>null}
 return {final,host,event,user,group}
}

test('enhanced memory preserves the original body, event clock and captured persona across the date boundary',async()=>{
 const f=memoryFixture(), raw=`${'长引言'.repeat(100)}我明天上午九点考试`
 await f.final.updateEnhancedSystems(f.host,f.event,raw,'回复',captured)
 assert.equal(f.user[0]?.text,raw)
 assert.equal(f.user[0]?.meta.at,Date.parse('2026-01-31T23:50:00+08:00'))
 assert.equal(f.user[0]?.meta.personaSource,captured)
 assert.equal(f.user[0]?.meta.heardFrom,'甲')
 assert.equal(f.group[0]?.meta.at,Date.parse('2026-01-31T23:50:00+08:00'))
 assert.equal(f.group[0]?.meta.personaSource,captured)
})

test('enhanced memory uses received time only when the event has no usable source time',async()=>{
 const f=memoryFixture()
 delete f.event.time
 await f.final.updateEnhancedSystems(f.host,f.event,'明天考试','回复',captured)
 assert.equal(f.user[0]?.meta.at,f.event._receivedAt)
})

test('group extraction excludes partial, unavailable and unknown forwarded history and preserves complete third-party provenance',async()=>{
 const segments=[{type:'forward',id:'root'}]
 const [partial,unavailable,complete]=await Promise.all([
  collectForwardContext({getForwardMsg:async()=>[{message:[{type:'text',text:'第一条'}]},{message:[{type:'text',text:'第二条'}]}]},segments,{maxNodes:1}),
  collectForwardContext(null,segments),
  collectForwardContext({getForwardMsg:async()=>[{message:[{type:'text',text:'可核对的第三方原话'}]}]},segments)
 ])
 const base={sender:{user_id:202,nickname:'群友'},at:Date.parse('2026-01-31T22:00:00+08:00')}
 const f=memoryFixture([
  {...base,content:'partial must not be extracted',forwardCompleteness:partial.completeness},
  {...base,content:'unavailable must not be extracted',forwardCompleteness:unavailable.completeness},
  {...base,content:'转发记录内容:第三方说我住山东',message:[{type:'forward_context',text:'第三方说我住山东'}]},
  {...base,content:'【转发读取范围】unknown must not be extracted'},
  {...base,content:'complete third-party text',forwardCompleteness:complete.completeness},
  {...base,content:'自己的普通陈述'}
 ])
 await f.final.updateEnhancedSystems(f.host,f.event,'只看可读内容','回复',captured)
 const input=f.group[0]!.history
 assert.equal(input.length,2)
 assert.ok(input.every(message=>!/partial must|unavailable must|unknown must|我住山东/.test(String(message.content))))
 assert.equal(input.find(message=>String(message.content).includes('complete third-party text'))?.source,'forward')
 assert.match(String(input.find(message=>message.source==='forward')?.content||''),/第三方转发，不能归为转发者自述/)
 assert.equal(input.find(message=>message.source==='forward')?.at,undefined)
 assert.equal(input.find(message=>message.source!=='forward')?.at,base.at)
 assert.ok(input.every(message=>message.authorQQ==='202'))
})

test('receiving self_id does not turn an actual group user into the authoring bot',async()=>{
 const at=Date.parse('2026-01-31T22:00:00+08:00')
 const f=memoryFixture([{self_id:99,source:'receive',sender:{user_id:303,nickname:'真实群友'},content:'明天我们小组答辩',at}])
 await f.final.updateEnhancedSystems(f.host,f.event,'这条需要记住','回复',captured)
 const heard=f.group[0]!.history[0]!
 assert.equal(heard.role,'user')
 assert.equal(heard.source,'receive')
 assert.equal(heard.at,at)
 assert.equal(heard.authorQQ,'303')
})

test('complete forward facts use the retained original segment rather than the clipped display summary',async()=>{
 const context=await collectForwardContext({getForwardMsg:async()=>[{sender:{user_id:303,nickname:'项目负责人'},message:[{type:'text',text:'项目发布改到周五上午十点，地点为三楼会议室。'}]}]},[{type:'forward',id:'root'}])
 assert.equal(context.completeness.state,'complete')
 const f=memoryFixture([{self_id:99,source:'receive',sender:{user_id:202,nickname:'转发者'},at:Date.parse('2026-01-31T22:00:00+08:00'),
  content:'转发记录内容:【转发读取范围】完整展开；展示摘要在这里已被截断…',forwardCompleteness:context.completeness,
  message:[{type:'forward',id:'root'},{type:'forward_context',text:context.text,completeness:context.completeness,forward_nodes:context.forwardNodes}]}])
 await f.final.updateEnhancedSystems(f.host,f.event,'看下这个安排','回复',captured)
 const input=f.group[0]!.history
 assert.equal(input.length,1)
 assert.equal(input[0]?.source,'forward')
 assert.equal(input[0]?.authorQQ,'202')
 assert.equal(input[0]?.at,undefined)
 assert.match(String(input[0]?.content),/项目负责人: 项目发布改到周五上午十点，地点为三楼会议室/)
 assert.match(String(input[0]?.content),/第三方转发，不能归为转发者自述/)
})
