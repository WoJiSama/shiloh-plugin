import {smartConversationKey} from '../../src/modules/conversation/domain/conversationIdentity.js'
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {evaluatePrivateChatGate,__resetPrivateChatForTest} from '../../src/modules/conversation/domain/privateChat.js'
import {createSmartDynamics} from '../../src/modules/conversation/domain/smartDynamics.js'
import {createGroupRuntime} from '../../src/modules/runtime/application/groupRuntime.js'
import {createSmartConversation,type SmartConversationHost,type ConversationState} from '../../src/modules/conversation/application/smartConversation.js'
import {createStrictConversation,type StrictConversationHost} from '../../src/modules/conversation/infrastructure/strictConversation.js'
import {createTimingGate,type TimingGateHost} from '../../src/modules/conversation/infrastructure/timingGate.js'
const logger={info(_m:string){},warn(_m:string){},error(_m:string,_e?:unknown){}}
function state():ConversationState {
 const runtime=createGroupRuntime<ReturnType<typeof setTimeout>,null,null>({now:()=>1000,cancelTimer:clearTimeout,peekTopic:()=>null,peekSocial:()=>null})
 return {...runtime.getSmartRuntimeState('g'),rerunEvent:null}
}
test('private entry and turn revalidation shares event acceptance, rejects new events and rechecks permissions',()=>{
 __resetPrivateChatForTest()
 const config={privateChat:{enabled:true,allowedUsers:['7'],cooldownSeconds:3}}
 const e={message_type:'private',user_id:7,self_id:1}
 assert.equal(evaluatePrivateChatGate({config,e,now:0}).allowed,true)
 assert.equal(evaluatePrivateChatGate({config,e,now:1}).allowed,true)
 assert.equal(evaluatePrivateChatGate({config,e:{...e},now:1}).reason,'cooldown')
 assert.equal(evaluatePrivateChatGate({config,e:{...e,self_id:2},now:1}).allowed,true)
 assert.equal(evaluatePrivateChatGate({config:{privateChat:{enabled:false}},e,now:1}).reason,'disabled')
 assert.equal(evaluatePrivateChatGate({config:{privateChat:{...config.privateChat,allowedUsers:['8']}},e,now:1}).reason,'not_allowed')
})
test('runtime latency contracts record objects, prune stale samples, average and cap retained samples',()=>{
 let now=1000; const s=state();const dynamics=createSmartDynamics(logger,()=>now)
 const host={config:{},getSmartState:()=>s,computeAvgReplyLatency:()=>0}
 dynamics.recordReplyLatency(host,'g',100);now=2000;dynamics.recordReplyLatency(host,'g',300)
 assert.deepEqual(s.replyLatencies,[{at:1000,ms:100},{at:2000,ms:300}]);assert.equal(dynamics.computeAvgReplyLatency(host,s),200)
 now=602000;assert.equal(dynamics.computeAvgReplyLatency(host,s),300)
 now=603000;assert.equal(dynamics.computeAvgReplyLatency(host,s),0)
 for(let i=0;i<70;i++) dynamics.recordReplyLatency(host,'g',20)
 assert.equal(s.replyLatencies.length,50)
 s.conversationPhase='focus';s.phaseUntil=1000;s.focusReplyCount=2
 assert.equal(dynamics.resolveConversationPhase(host,s),'cold');assert.equal(s.focusReplyCount,0)
})
function smartHost(s:ConversationState):SmartConversationHost{return {
 config:{enabled:true,smartTrigger:{inevitableAtReply:true}},isUserBlacklisted:()=>false,handleForbiddenWordHit:()=>false,handleMemorySelfCorrection(){},getSmartState:()=>s,checkTriggers:()=>true,
 scheduleSmartLockWatchdog(){},prefilterMessage:()=>({kind:'regular',reason:''}),scheduleDeferredGateCheck(){},detectGroupRepeat:()=>null,joinRepeat:async()=>false,
 resolveConversationPhase:()=> 'cold',resolveTalkValue:()=>1,idleCompensationMet:()=>false,runTimingGate:async()=>({decision:'no_action',reason:''}),
 scheduleMergedDirectTrigger:()=>true,handleRandomReplySmart:async()=>false,applyRateLimitGuard:()=>true,applyReplyDebounce:async()=>true,
 releaseSmartInFlight(s,_e,token){if(s.inFlightToken===token)s.inFlight=false},handleTool:async()=>true,scheduleWaitReply(){}
}}
test('smart lock is acquired before awaits; concurrent event queues and failed turn releases ownership',async()=>{
 const s=state(),host=smartHost(s);let rejectTurn:(error:Error)=>void=()=>{};let started:()=>void=()=>{}
 const start=new Promise<void>(resolve=>{started=resolve})
 host.handleTool=()=>{started();return new Promise((_resolve,reject)=>{rejectTurn=reject})}
 const runtime=createSmartConversation({logger,bot:()=>({uin:1}),now:()=>1000000,updateGroupTopic(){},updateGroupSocial(){},detectAttentionHook:()=>null,anchorEventConversation(){},resolveLongTaskFeedbackPolicy:()=>null})
 const first=runtime.handleRandomReplySmart(host,{group_id:'g',user_id:2,msg:'hello'})
 await start
 assert.equal(s.inFlight,true)
 assert.equal(await runtime.handleRandomReplySmart(host,{group_id:'g',user_id:3,msg:'second'}),false)
 assert.equal(s.queuedWhileInFlight,1);assert.ok(s.rerunEvent && typeof s.rerunEvent === 'object' && 'user_id' in s.rerunEvent);assert.equal(s.rerunEvent.user_id,3)
 rejectTurn(new Error('send failed'));await assert.rejects(first,/send failed/);assert.equal(s.inFlight,false)
})
function strictHost():StrictConversationHost{return {
 config:{enabled:true,excludeMessageTypes:[],trackAiConfig:{trackAiUrl:'https://example.test',trackAiApikey:'key',trackAiModel:'m'}},
 sendObservedReply:async()=>true,resolveChatCompletionUrl:x=>x,processBatchJudgments:async()=>{},isUserTalkingToBot:async()=>true,batchIsUserTalkingToBot:async()=>[],fallbackToSingleJudgment:async()=>[],
 handlePrivateChat:async()=>false,checkGroupPermission:()=>true,isCommand:()=>false,isUserBlacklisted:()=>false,handleForbiddenWordHit:()=>false,handleMemorySelfCorrection(){},
 expressionLearner:{updateGroupExpressions:async()=>{}},isMutedInGroup:async()=>false,isAutomaticTorrentDownloadEvent:()=>false,handleTool:async()=>true,handleRandomReplySmart:async()=>true,
 checkTriggers:()=>false,setTrackingWithTimer(){},scheduleMergedDirectTrigger:()=>true,formatTime:()=>'',addToBatchJudgment:async()=>false
}}
function strictRuntime(){return createStrictConversation({logger,bot:()=>({}),diceManager:{isLogActive:()=>false},globalStyleLearnerManager:{observeMessage(){},maybeAutoSummarize:async()=>{}},anchorEventConversation(){},getRedBagType:()=>({type:'normal',name:''}),isExclusiveForUser:()=>false,toolConfigHasName:()=>false})}
test('judgment queues isolate hosts; single-call rejection resolves false without hanging',async()=>{
 const runtime=strictRuntime(),a=strictHost(),b=strictHost();a.isUserTalkingToBot=async()=>{throw new Error('down')}
 const pa=runtime.addToBatchJudgment(a,'a','hello',[],{group_id:'g'}),pb=runtime.addToBatchJudgment(b,'b','hello',[],{group_id:'g'})
 await runtime.processBatchJudgments(a);assert.equal(await pa,false)
 await runtime.processBatchJudgments(b);assert.equal(await pb,true)
})
test('failed repeat delivery never commits cooldown, reply timestamp or keywords',async()=>{
 const host=strictHost(),s=state();host.sendObservedReply=async()=>{throw new Error('uncertain')}
 assert.equal(await strictRuntime().joinRepeat(host,{group_id:'g'},s,'repeat'),false)
 assert.equal(s.lastRepeatJoinAt,0);assert.deepEqual(s.recentReplyTimestamps,[]);assert.deepEqual(s.lastBotReplyKeywords,[])
})
test('timing gate fails closed on invalid payload and honors per-account identity',async()=>{
 let output='{"decision":"invalid"}',prompt=''
 const runtime=createTimingGate({logger,bot:()=>({uin:1,nickname:'main'}),resolvePersonaName:()=> 'account name',computeAddresseeSignal:()=>({groupAddressed:false,targetKind:'unknown',pronounWithoutBotAnchor:false}),buildPersonaTonePrompt:()=>'',getGroupTopicPrompt:()=>'',getGroupSocialPrompt:()=>'',detectAttentionHook:()=>null,sideLLMCall:async options=>{prompt=String(options?.messages?.[0]?.content);return {ok:true,content:output}}})
 const host:TimingGateHost={config:{trackAiConfig:{trackAiUrl:'https://example.test/v1/chat/completions',trackAiModel:'m',trackAiApikey:'key'}},getPersonaFor:()=>null,messageManager:{formatMessageHistory:async()=>''},computeGroupMsgRate5min:()=>0}
 assert.equal((await runtime.runTimingGate(host,{group_id:'g'},state())).reason,'invalid_decision');assert.match(prompt,/account name/)
 output='null';assert.equal((await runtime.runTimingGate(host,{group_id:'g'},state())).reason,'no_json')
 output='{"decision":"wait","wait_seconds":4}';assert.equal((await runtime.runTimingGate(host,{group_id:'g'},state())).wait_seconds,4)
})

test('account scoped smart state and freshness keys preserve the legacy namespace separately',()=>{
 const a=smartConversationKey(7,{self_id:1}),b=smartConversationKey(7,{bot:{uin:2}})
 assert.notEqual(a,b);assert.notEqual(a,7);assert.equal(smartConversationKey(7),7)
 assert.equal(smartConversationKey(7,{self_id:1}),smartConversationKey('7',{self_id:'1'}))
 const runtime=createGroupRuntime<ReturnType<typeof setTimeout>,null,null>({now:()=>1000,cancelTimer:clearTimeout,peekTopic:()=>null,peekSocial:()=>null})
 runtime.getSmartRuntimeState(a).inFlight=true
 assert.equal(runtime.getSmartRuntimeState(b).inFlight,false)
 assert.equal(runtime.getSmartRuntimeState(7).inFlight,false)
})

test('strict tracking model receives event bot identity through direct, queued and fallback judgments',async()=>{
 const requests:{messages:{content:string}[]}[]=[]
 const runtime=createStrictConversation({logger,bot:()=>({uin:1,nickname:'main bot'}),fetch:async(_url,init)=>{requests.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify({choices:[{message:{content:'true'}}]}),{status:200})},diceManager:{isLogActive:()=>false},globalStyleLearnerManager:{observeMessage(){},maybeAutoSummarize:async()=>{}},anchorEventConversation(){},getRedBagType:()=>({type:'normal',name:''}),isExclusiveForUser:()=>false,toolConfigHasName:()=>false})
 const host=strictHost(),e={group_id:7,user_id:8,self_id:2,bot:{uin:2,nickname:'secondary bot'}}
 host.isUserTalkingToBot=(message,history,event)=>runtime.isUserTalkingToBot(host,message,history,event)
 assert.equal(await runtime.isUserTalkingToBot(host,'hello',[],e),true)
 assert.match(requests[0]?.messages[0]?.content || '',/secondary bot.*QQ号2/s)
 const queued=runtime.addToBatchJudgment(host,'key','hello',[],e);await runtime.processBatchJudgments(host);assert.equal(await queued,true)
 assert.match(requests[1]?.messages[0]?.content || '',/secondary bot.*QQ号2/s)
 await runtime.fallbackToSingleJudgment(host,[{conversationKey:'key',userMessage:'hello',chatHistory:[],e,resolve(){}}])
 assert.match(requests[2]?.messages[0]?.content || '',/secondary bot.*QQ号2/s)
 await runtime.isUserTalkingToBot(host,'legacy')
 assert.match(requests[3]?.messages[0]?.content || '',/main bot.*QQ号1/s)
})


test('timing gate保留当前人设参与偏好和全部边界，不注入固定接夸台词', async()=>{
 let prompt=''
 const runtime=createTimingGate({logger,bot:()=>({uin:1}),resolvePersonaName:()=> '安序',computeAddresseeSignal:()=>({groupAddressed:true,targetKind:'group',pronounWithoutBotAnchor:false}),buildPersonaTonePrompt:()=>'',getGroupTopicPrompt:()=>'',getGroupSocialPrompt:()=>'',detectAttentionHook:()=>null,sideLLMCall:async options=>{prompt=String(options?.messages?.[0]?.content);return {ok:true,content:'{"decision":"no_action"}'}}})
 const boundaries=Array.from({length:10},(_,i)=>`稳定边界${i}`)
 const host:TimingGateHost={config:{trackAiConfig:{trackAiUrl:'https://example.test',trackAiModel:'m',trackAiApikey:'key'}},getPersonaFor:()=>({name:'安序',preferences:['喜欢有依据的信息'],boundaries}),messageManager:{formatMessageHistory:async()=>''},computeGroupMsgRate5min:()=>0}
 await runtime.runTimingGate(host,{group_id:'g'},state())
 assert.match(prompt,/喜欢有依据的信息/)
 for(const boundary of boundaries)assert.ok(prompt.includes(boundary))
 assert.ok(!prompt.includes('我对大家都好呀'))
})
