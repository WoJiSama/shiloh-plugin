import test from 'node:test'
import assert from 'node:assert/strict'
import {createFinalReply} from '../dist/backend/modules/conversation/application/finalReply.js'
import {createMemoryReplies} from '../dist/backend/modules/conversation/application/memoryReplies.js'
import {createPersonaSnapshot} from '../dist/backend/modules/conversation/infrastructure/personaSnapshot.js'
import {buildTurnInteractionContext} from '../dist/backend/modules/conversation/domain/turnInteractionContext.js'
function fixture(){
 const archived=[],saved=[],enhanced=[],tracking=[],events=[]
 const api=createFinalReply({randomUUID:()=>"tool-id",logger:{warn(){},info(){},error(){}},bot:()=>({uin:99,nickname:'bot'}),buildGenericChatFailureReply:()=> 'failed',extractModrinthForwardItems:()=>[],stripModrinthForwardMarkers:text=>text,applyOutputPersonaGuards:text=>text,findRecentBotImage:async()=>null,recordEpisode(){},recordTurnContinuity:async()=>{},getActiveConversation:()=>({chatHistory:[]}),trackingKey:e=>`${e.self_id}:${e.group_id}_${e.user_id}`,rememberPersonaReply(){},rememberStyleReply(){}})
 const event={group_id:1,user_id:2,self_id:99,msg:'hello',reply:async payload=>{events.push(payload);return {message_id:'image-id'}},sender:{nickname:'speaker'}}
 const host={config:{conversationTrackingEnabled:true},processToolSpecificMessage:x=>x,getPersonaFor:()=>({name:'bot'}),getTextImageTemplateForFinalReply:()=>false,sendSegmentedMessage:async()=> 'text-id',sendFinalReplyAsTextImage:(...args)=>api.sendFinalReplyAsTextImage(host,...args),formatTime:()=> 'now',setTrackingWithTimer:(...args)=>tracking.push(args),messageManager:{recordMessage:async x=>archived.push(x)},trimMessageHistory:x=>x,saveGroupUserMessages:async(...args)=>saved.push(args),updateEnhancedSystems:async(...args)=>enhanced.push(args)}
 return {api,event,host,archived,saved,enhanced,tracking,events}
}
test('final reply stores confirmed message and bot-scoped tracking only once',async()=>{
 const {api,event,host,archived,saved,enhanced,tracking}=fixture(),messages=[],session={}
 await api.handleTextResponse(host,'你好',event,session,messages)
 assert.equal(session.responseAttempted,true);assert.equal(archived[0].message_id,'text-id');assert.equal(archived[0].self_id,99)
 assert.equal(tracking[0][0],'99:1_2');assert.deepEqual(messages,[{role:'assistant',content:'你好'}]);assert.equal(saved.length,1);assert.equal(enhanced.length,1)
})
test('unknown final delivery is not archived or learned as sent',async()=>{
 const {api,event,host,archived,saved,enhanced}=fixture(),session={};host.sendSegmentedMessage=async()=>null
 await api.handleTextResponse(host,'你好',event,session,[])
 assert.equal(session.responseAttempted,true);assert.equal(archived.length,0);assert.equal(saved.length,0);assert.equal(enhanced.length,0)
})
function taskInteraction(){
 return {...buildTurnInteractionContext({rawUserText:'刚才改背景的图出来了吗？',botId:'99',speaker:{userId:'2'}}),actionFacts:{scope:{botId:'99',conversationId:'group:1',userId:'2'},observedAt:Date.now(),lookup:'ok',tasks:[]}}
}
test('fact repair is text-only low and archives only the actually sent correction',async()=>{
 const {api,event,host,archived,saved}=fixture(),sent=[],calls=[],messages=[{role:'user',content:'刚才改背景的图出来了吗？'}],session={interactionContext:taskInteraction()}
 host.sendSegmentedMessage=async(_e,text)=>{sent.push(text);return 'corrected-id'}
 host.retryRequest=async(request,toolContent,retries,toolName,options)=>{
  calls.push({request,retries,options});assert.equal(request.tools,undefined);assert.equal(request.tool_choice,undefined)
  assert.equal(retries,0);assert.equal(options.generation.reasoningEffort,'low');assert.equal(options.forceChatBackend,true)
  assert.ok(options.signal instanceof AbortSignal)
  assert.match(request.messages.at(-1).content,/原始|本轮互动/u)
  return {choices:[{message:{content:'我还没核实到那次处理的结果，暂时不能确认进度。'}}]}
 }
 await api.handleTextResponse(host,'还没出来，好了我第一时间发你。',event,session,messages)
 assert.equal(calls.length,1);assert.deepEqual(sent,['我还没核实到那次处理的结果，暂时不能确认进度。'])
 assert.equal(archived.length,1);assert.equal(archived[0].message_id,'corrected-id');assert.equal(saved.length,1)
 assert.equal(messages.at(-1).content,sent[0]);assert.doesNotMatch(JSON.stringify(messages),/第一时间发你/u)
 assert.equal(session.replyGrounding.fallback,false)
})
test('tool calls and invalid repairs cannot execute or leak into sent history',async()=>{
 for(const repair of [{tool_calls:[{function:{name:'reminderTool'}}],content:'好了发你。'},{content:'有结果我会通知你。'}]){
  const {api,event,host,archived}=fixture(),sent=[],messages=[],session={interactionContext:taskInteraction()};let calls=0
  host.sendSegmentedMessage=async(_e,text)=>{sent.push(text);return 'fallback-id'}
  host.retryRequest=async()=>{calls++;return {choices:[{message:repair}]}}
  await api.handleTextResponse(host,'好了我第一时间发你。',event,session,messages)
  assert.equal(calls,1);assert.equal(session.replyGrounding.fallback,true);assert.match(sent[0],/不能确认/u)
  assert.equal(messages[0].content,sent[0]);assert.equal(archived.length,1)
 }
})
test('a text-only final reply cannot archive unsupported actions, delivery causes or negative states',async()=>{
 for(const candidate of ['我现在再发一次。','我现在发给你。','我现在重跑。','上次发给你的时候被拦下来了。','之前那次投递被拒。','不过之前发的时候投递被拒了。','没发出来过。','还没欸。','第一张图的还没弄好。']){
  const {api,event,host,archived}=fixture(),sent=[],messages=[],session={interactionContext:taskInteraction()};let repairs=0
  session.interactionContext.rawUserText='刚才那张图出来了吗？我还没收到。'
  host.sendSegmentedMessage=async(_e,text)=>{sent.push(text);return 'honest-reply'}
  host.retryRequest=async()=>{repairs++;return {choices:[{message:{content:'我还没核实到那张图的发送记录，暂时不能确认。'}}]}}
  await api.handleTextResponse(host,candidate,event,session,messages)
  assert.equal(repairs,1,candidate)
  assert.ok(session.replyGrounding.violations.length,candidate)
  assert.deepEqual(sent,['我还没核实到那张图的发送记录，暂时不能确认。'])
  assert.equal(messages[0].content,sent[0]);assert.equal(archived.length,1)
  assert.notEqual(messages[0].content,candidate)
 }
})
test('final grounding rechecks cancellation after generation and respects explicit request scope',async()=>{
 const {api,event,host}=fixture(),reads=[],sent=[],session={interactionContext:taskInteraction(),actionFactsQuery:{referenceMessageId:'original-request',recentRequestMessageIds:['other-request']}}
 const live={taskId:'job',requestMessageId:'original-request',toolName:'imageEdit',source:'live_job',observedAt:Date.now(),execution:'running',result:'unknown',delivery:{state:'unknown'},followUp:{state:'registered',kind:'job_completion',id:'callback'}}
 session.interactionContext.actionFacts.tasks=[live]
 host.getTurnActionFacts=async(_e,query)=>{reads.push(query);return {...session.interactionContext.actionFacts,observedAt:Date.now(),tasks:[{...live,execution:'unknown',followUp:{state:'unknown'}}]}}
 host.retryRequest=async()=>({choices:[{message:{content:'我还没核实到进度，这里也没有有效的自动补发安排。'}}]})
 host.sendSegmentedMessage=async(_e,text)=>{sent.push(text);return 'r'}
 await api.handleTextResponse(host,'好了我第一时间发你。',event,session,[])
 assert.equal(reads.length,2);assert.ok(reads.every(query=>query.referenceMessageId==='original-request'))
 assert.equal(sent[0],'我还没核实到进度，这里也没有有效的自动补发安排。')
})
test('final card returns actual receipt and never falls back after a transport attempt',async()=>{
 const {api,event,host}=fixture();let fallbacks=0;const observed=[]
 host.sendObservedReply=async(e,payload,quote,channel)=>{observed.push(channel);return e.reply(payload,quote)}
 host.sendSegmentedMessage=async()=>{fallbacks++;return 'fallback'}
 host.toolInstances={textImageTool:{execute:async(payload,e)=>e.reply('image')}}
 assert.equal(await api.sendFinalReplyAsTextImage(host,event,'text'),'image-id')
 assert.deepEqual(observed,['agent_final_card'])
 event.reply=async()=>{throw Error('socket closed')}
 assert.equal(await api.sendFinalReplyAsTextImage(host,event,'text'),null);assert.equal(fallbacks,0)
 host.toolInstances.textImageTool.execute=async()=>{throw Error('render failed')}
 assert.equal(await api.sendFinalReplyAsTextImage(host,event,'text'),'fallback');assert.equal(fallbacks,1)
})

test('final card preserves inherited event identity and pins the session persona across preparation',async()=>{
 const {api,event,host,archived}=fixture()
 const captured=createPersonaSnapshot({botId:99,persona:{name:'甲'}})
 const replacement=createPersonaSnapshot({botId:99,persona:{name:'乙'}})
 const wrapped=Object.assign(Object.create(event),{_personaSnapshot:captured})
 host.processToolSpecificMessage=async text=>{await Promise.resolve();wrapped._personaSnapshot=replacement;return text}
 host.getTextImageTemplateForFinalReply=()=> 'document'
 host.sendObservedReply=async(e,payload,quote)=>e.reply(payload,quote)
 let rendered=0
 host.toolInstances={textImageTool:{execute:async(_payload,e)=>{
  rendered++;assert.equal(e.self_id,99);assert.equal(e.group_id,1);assert.equal(e.user_id,2)
  assert.equal(e._personaSnapshot,captured)
  await e.reply('image')
 }}}
 await api.handleTextResponse(host,'正文',wrapped,{personaSnapshot:captured},[])
 assert.equal(rendered,1)
 assert.equal(archived[0].sender.nickname,'甲')
 assert.equal(archived[0].personaSource,captured)
})
test('memory forwarding falls back only when preparation failed',async()=>{
 for(const prepareFailure of [true,false]){
  let attempts=0
  const api=createMemoryReplies({factShortId:text=>text,warn(){},makeForwardMsg:async()=>{if(prepareFailure)throw Error('render');return 'forward'}})
  const host={sendObservedReply:async()=>{attempts++;if(!prepareFailure)throw Error('socket')}}
  await api.replyLongForward(host,{},'title','content')
  assert.equal(attempts,1)
 }
})
test('long forwards split at QQ 100-node limit and stop after uncertain batch',async()=>{
 for(const unknownAt of [0,2]){
  const sizes=[];let attempts=0
  const api=createMemoryReplies({factShortId:text=>text,warn(){},makeForwardMsg:async(e,msgs)=>{sizes.push(msgs.length);return msgs}})
  await api.replyLongForward({sendObservedReply:async()=>{attempts++;return attempts===unknownAt?null:{message_id:attempts}}},{},'title','x'.repeat(205),1)
  assert.deepEqual(sizes,unknownAt?[100,100]:[100,100,5])
 }
})
