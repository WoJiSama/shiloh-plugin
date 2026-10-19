import test from 'node:test'
import assert from 'node:assert/strict'
import {createChatTurn} from '../dist/backend/modules/tools/infrastructure/chatTurn.js'
import {createTurnPlan, deriveTurnPlanRequest} from '../dist/backend/modules/conversation/infrastructure/turnPlan.js'
import {buildChatRequestData} from '../dist/backend/modules/models/domain/modelGateway.js'
import {createChatHistoryTool} from '../dist/backend/modules/qqTools/infrastructure/ChatHistoryTool.js'
function fixture(privateChat=false,{text='查资料',targetKind,profile='chat'}={}){
 const log={info(){},warn(){},error(){},debug(){}}
 const trace={id:'trace',setTrigger(){},setIntent(){},addModelCall(){},addTool(){},finish:()=>({modelCalls:[],tools:[]})}
 const members=new Map([[1,{user_id:1,nickname:'bot',role:'member'}],[2,{user_id:2,nickname:'user',role:'member'}]])
 const group={getMemberMap:async()=>members,pickMember:()=>({info:{role:'member'}})}
 let groupQueries=0
 const e={message_type:privateChat?'private':'group',...(privateChat?{}:{group_id:123,group}),user_id:2,msg:text,sender:{user_id:2,nickname:'user',role:'member'},self_id:1,bot:{uin:1,nickname:'bot',pickGroup(id){groupQueries++;if(privateChat)throw new Error('private chat must not query a group');return group}}}
 const session={tools:[{function:{name:'searchInformationTool'}}],groupUserMessages:[]}
 const sent=[],finished=[],smartEvents=[],latencyEvents=[],diagnostics=[],understanding=[],order=[]
 const ports={logger:log,botIdentity:event=>event.bot,isAiConversationEnabled:()=>true,evaluatePrivateChatGate:()=>({allowed:true}),resolveConversationContext:()=>({}),createTurnTrace:()=>trace,resolveTurnTraceArchiveDir:()=>'/tmp',createOutboundArbiter:()=>({wrapEvent:e=>e,beginToolOutcomes(){},enqueue(){},settle(){}}),getOrCreateGroupLimiter:()=>task=>task(),cacheGroupName:async()=>{},resolveGroupContextAssets:async()=>({images:[],currentImages:[],quotedImages:[],forwardImages:[],videos:[],files:[]}),formatGroupContextImagePrompt:()=>'',TakeImages:async()=>[],shouldRequireImageEditBase:()=>false,resolveRecentBotImage:async()=>null,resolveAvatarEditBase:()=>null,resolveAvatarInspectionTargets:()=>null,resolveAvatarDrawReference:()=>null,shouldAskForMissingImageForVisualRequest:()=>false,selectToolIntentCandidates:()=>['searchInformationTool'],shouldSkipIntentModel:()=>false,resolveDeterministicToolIntent:()=>({toolName:'searchInformationTool'}),hasExcelWorkbookContext:()=>false,hasRecentPixivSearch:()=>false,loadTurnContinuity:async()=>null,computeAddresseeSignal:()=>({targetKind}),buildAddresseePrompt:()=>'',resolvePromptLayerProfile:()=>({profile}),buildTurnContinuityPrompt:()=>'',delay:async()=>{},formatGroupWorkflowTeachingPrompt:()=>'',formatGroupKnowledgeTeachingPrompt:()=>'',formatIdentityBindingsPrompt:()=>'',mcpManager:{getMCPSystemPrompts:()=>''},rollPersonaMood:()=>null,getMidtermMemoryManager:()=>null,composeTurnPromptLayers:async()=>{order.push('compose');return{layerValues:{},report:{},prompt:''}},getGroupTopicPrompt:()=>'',getGroupSocialPrompt:()=>'',getSemanticMemoryRuntime:()=>null,hasTemporalDeixis:()=>false,recallUserEpisodes:()=>[],buildUserCallbackPrompt:()=>'',buildMainSystemPrompt:()=>'',containsInternalStatusLeak:()=>false,resolveHistorySelectionBudget:()=>({mode:'compact',recentCount:3,relevantCount:0,maxMessages:3}),selectRelevantGroupHistory:messages=>messages,shouldUseExcelWorkbookTool:()=>false,buildExcelToolParams:()=>null,resolveToolRoute:async()=>({toolChoice:'none',forcedToolCall:null,toolScopeLocked:true,applied:[]}),createTurnPlan:()=>({id:'plan',intent:'chat',execution:{mode:'chat',modelProfile:'chat',toolChoice:'none'},capabilities:{required:[],optional:[],available:[]},context:{historyMode:'compact',selectedHistoryCount:0},presentation:{kind:'text'},observability:{routeReason:'test'}}),isEducationalExplanationRequest:()=>false,classifyEmojiToolExposure:()=>'',resolveCardPresentation:()=> 'text',deriveTurnPlanRequest:()=>({toolChoice:'none'}),formatTurnPlanLog:()=>'',cardAcknowledgement:()=>'',buildToolIntentDisclosure:()=>'',buildChatRequestData:()=>({}),collectThinking(){},extractEmbeddedToolCalls:()=>({calls:[],remainder:''}),sendThinkingForward:async()=>{},recordTurnDiagnostics:entry=>diagnostics.push(entry),buildCommittedActionReply:()=>''}
 const host={config:{enabled:true,groupHistory:true,episodicMemory:{enabled:false}},tools:session.tools,toolInstances:{searchInformationTool:{}},_groupLimiters:new Map(),sendObservedReply:async()=>{},isUserBlacklisted:()=>false,scheduleMergedToolRequest:()=>true,refreshLocalToolRegistry:async()=>{},waitForMCPReady:async()=>{},beginConversationTask:async()=>({}),getOrCreateSession:()=>session,handleActiveDrawStatusQuestion:async()=>false,clearSession(){},buildMessageContent:async()=>e.msg,resolvePrimaryModelIntent:async()=>{throw new Error('deterministic request must skip intent model')},getSmartState:(id,event)=>{smartEvents.push(event);return{}},getPersonaFor:()=>({name:'bot'}),getChatConfig:()=>({}),getCurrentGroupContext:async()=>({}),getBasicGroupContext:()=>({}),buildMergedDirectTriggerPrompt:()=>'',messageManager:{getMessages:async()=>[{message_id:'old',sender:{user_id:2,nickname:'user',role:'member'},content:'earlier'}]},getTaskStatus:async()=>null,formatTaskStatusForPrompt:()=>'',resolveUnderstandingPrompt:async context=>{understanding.push(context);order.push('understanding');return ''},trimMessageHistory:m=>m,filterChatByQQ:m=>m,formatMessages:m=>m,getToolsByName:()=>[],retryRequest:async()=>({choices:[{message:{content:'完成'}}]}),buildMissingToolCommitmentCall:()=>null,handleTextResponse:async text=>sent.push(text),finishConversationTask:async()=>finished.push(true),recordReplyLatency:(id,ms,event)=>latencyEvents.push(event)}
 return {api:createChatTurn(ports),ports,host,e,session,sent,finished,smartEvents,latencyEvents,diagnostics,understanding,order,get groupQueries(){return groupQueries}}
}

test('a real auto turn sends optional tools and trace records the gateway input', async()=>{
 const f=fixture(false,{text:'之前讨论了什么'}), requests=[], routing=[]
 f.host.config.useTools=true
 f.host.config.groupHistory=false
 f.host.tools=f.session.tools=[{type:'function',function:{name:'chatHistoryTool'}}]
 f.host.toolInstances={chatHistoryTool:{}}
 f.host.resolvePrimaryModelIntent=async()=>null
 f.host.retryRequest=async data=>{requests.push(data);return{choices:[{message:{content:'我来核对当前记录。'}}]}}
 const trace={id:'auto-trace',setTrigger(){},setIntent(){},addModelCall(){},addTool(){},setRoute:(...args)=>routing.push({route:args}),setToolRouting:value=>routing.push(value),finish:()=>({modelCalls:[],tools:[]})}
 f.api=createChatTurn({...f.ports,createTurnTrace:()=>trace,resolveDeterministicToolIntent:()=>null,selectToolIntentCandidates:()=>[],
   resolveToolRoute:async()=>({toolChoice:'auto',forcedToolCall:null,toolScopeLocked:false,applied:[]}),filterToolsForMessageIntent:tools=>tools,
   createTurnPlan,deriveTurnPlanRequest,buildChatRequestData})
 assert.equal(await f.api.handleToolInner(f.host,f.e),true)
 assert.equal(requests.length,1)
 assert.equal(requests[0].tool_choice,'auto')
 assert.deepEqual(requests[0].tools.map(tool=>tool.function.name),['chatHistoryTool'])
 assert.ok(routing.some(value=>value.route?.[0]==='tool'))
 assert.ok(routing.some(value=>value.requestTools?.includes('chatHistoryTool')))
 assert.ok(!requests[0].messages.some(message=>String(message.content).includes('没有可调用的工具')))
})

for (const failure of [false,true]) test(`real turn injects ${failure?'unavailable':'cached'} history without the current message`,async()=>{
 const f=fixture(false,{text:'上次聊了什么'}),reads=[]
 f.host.config.groupHistory=false
 f.host.tools=f.session.tools=[{function:{name:'chatHistoryTool'}}]
 f.host.toolInstances={chatHistoryTool:{}}
 f.e.message_id='current'
 f.host.messageManager.getMessages=async(...args)=>{reads.push(args);if(failure)throw Error('cache unavailable');return[
  {message_id:'current',content:'上次聊了什么',sender:{user_id:2}},
  {message_id:'earlier-source',content:'周六去公园',sender:{user_id:2},time:'2026-10-17 12:00:00'}]}
 assert.equal(await f.api.handleToolInner(f.host,f.e),true)
 assert.deepEqual(reads,[['group',123,{throwOnError:true}]])
 assert.equal(f.e._chatHistoryUnavailable,failure)
 assert.ok(!f.e._chatHistoryMessages.some(row=>row.message_id==='current'))
 const History=createChatHistoryTool(),tool=new History()
 const result=await tool.func({question:'上次聊了什么',keywords:[]},f.e)
 assert.equal(result.scope.source,'message_manager')
 assert.equal(result.status,failure?'unavailable':'found')
 if(!failure)assert.equal(result.messages[0].message_id,'earlier-source')
})

test('compiled group turn skips deterministic intent model, sends text and forwards event identity to state',async()=>{
 const f=fixture()
 assert.equal(await f.api.handleToolInner(f.host,f.e),true)
 assert.deepEqual(f.sent,['完成'])
 assert.equal(f.finished.length,1)
 assert.equal(f.smartEvents[0],f.e)
 assert.equal(f.latencyEvents[0],f.e)
 assert.equal(f.diagnostics.length,1)
 assert.equal(f.diagnostics[0].turnId,'trace')
})
test('compiled private turn handles history without querying missing group',async()=>{
 const f=fixture(true)
 assert.equal(await f.api.handleToolInner(f.host,f.e),true)
 assert.deepEqual(f.sent,['完成'])
 assert.equal(f.finished.length,1)
 assert.equal(f.groupQueries,0)
})

for (const scenario of [
 {name:'unambiguous chat skips understanding',text:'你好呀',targetKind:'bot',profile:'chat',briefCalls:0,needsDisambiguation:false},
 {name:'ambiguous chat reuses understanding before composing',text:'这个呢',targetKind:'bot',profile:'chat',briefCalls:1,needsDisambiguation:true},
 {name:'task profile retains understanding for a resolved addressee',text:'帮我查资料',targetKind:'bot',profile:'task',briefCalls:1,needsDisambiguation:false}
]) {
 test(`compiled turn ${scenario.name}`,async()=>{
  const f=fixture(false,scenario)
  assert.equal(await f.api.handleToolInner(f.host,f.e),true)
  assert.deepEqual(f.sent,['完成'])
  assert.equal(f.session.promptLayerProfile.profile,scenario.profile)
  assert.equal(f.session.interactionContext.social.needsDisambiguation,scenario.needsDisambiguation)
  assert.equal(f.understanding.length,scenario.briefCalls)
  assert.deepEqual(f.order,scenario.briefCalls?['understanding','compose']:['compose'])
  if(scenario.briefCalls){
   assert.equal(f.understanding[0].session,f.session)
   assert.equal(f.understanding[0].currentIntentText,scenario.text)
  }
 })
}
