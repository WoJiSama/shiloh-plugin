import test from 'node:test'
import assert from 'node:assert/strict'
import {createFinalReply} from '../dist/backend/modules/conversation/application/finalReply.js'
import {createMemoryReplies} from '../dist/backend/modules/conversation/application/memoryReplies.js'
import {createPersonaSnapshot} from '../dist/backend/modules/conversation/infrastructure/personaSnapshot.js'
import {buildTurnInteractionContext} from '../dist/backend/modules/conversation/domain/turnInteractionContext.js'
import {buildDiagnosticContext} from '../dist/backend/modules/conversation/domain/diagnosticContext.js'
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
 for(const candidate of ['我现在再发一次。','我现在发给你。','我现在重跑。','上次发给你的时候被拦下来了。','之前那次投递被拒。','不过之前发的时候投递被拒了。','不过上次你要发的时候被拒了。','不过之前你要投递的时候被明确拒绝过。','做好了，就是还没发——之前你那边拒绝收，就一直搁着。','原因我还没查到，等确认了我再跟你说。','没发出来过。','还没欸。','第一张图的还没弄好。',
  '还没出来欸……刚才只记了要处理，这会儿没查到跑完的结果。我这边现在没法直接看进度，等有实际产出我再发你，不瞎猜状态。',
  '你要的话我现在再发一次试试。']){
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
 host.retryRequest=async()=>({choices:[{message:{content:'我还没核实到进度，自动补发安排也尚未确认。'}}]})
 host.sendSegmentedMessage=async(_e,text)=>{sent.push(text);return 'r'}
 await api.handleTextResponse(host,'好了我第一时间发你。',event,session,[])
 assert.equal(reads.length,2);assert.ok(reads.every(query=>query.referenceMessageId==='original-request'))
 assert.equal(sent[0],'我还没核实到进度，自动补发安排也尚未确认。')
})
test('qualified task claims and contradictions never become the next turn history',async()=>{
 const cases=[
  {candidate:'第一张的蓝色背景还没出来欸，这边没查到完成记录。',raw:'我问的是这张图，出来了吗？',tasks:[],corrected:'第一张的处理结果还没核实，不能确认是否完成。'},
  {candidate:'第一张蓝底的还没出来，我这边没查到做完的记录。',raw:'我问的是这张图，出来了吗？',tasks:[],corrected:'第一张的处理结果还没核实，不能确认是否完成。'},
  {candidate:'这张我这边没查到做好的记录，还不算出来哦。',raw:'我问的是这张图，出来了吗？',tasks:[],corrected:'第一张的处理结果还没核实，不能确认是否完成。'},
  {candidate:'这个我还没法确认欸，手上没有处理结果的记录，不好说现在是好了还是卡着。等我确认到就第一时间发你。',raw:'刚才改背景的图出来了吗？',tasks:[],corrected:'这次图片处理的结果尚未核实，暂时不能确认是否完成。'},
  {candidate:'这个我还没确认到结果欸，进度和图都没拿到。有了我发你。',raw:'刚才改背景的图出来了吗？',tasks:[],corrected:'这次图片处理的结果尚未核实，暂时不能确认是否完成。'},
  {candidate:'改背景那个任务确实是登记了的，在排队中，不过产物我这儿还没查到确认结果，所以现在没法直接给你图。',raw:'刚才改背景的图出来了吗？我只登记了考试提醒，图好了会自动发我吗？',tasks:[{source:'reminder',toolName:'reminderTool',execution:'queued',followUp:{state:'registered',kind:'reminder',id:'exam',dueAt:Date.now()+60_000}}],corrected:'这次图片处理的结果尚未核实；考试提醒不能证明图片处理进度。'},
  {candidate:'所以现在图在我这儿没有。',raw:'所以我现在没收到，是还没做好吗？',tasks:[{execution:'completed',result:'available',delivery:{state:'failed'}}],corrected:'图已经做好了，上次发送没有成功，具体原因还没确认。'},
  {candidate:'我这边本来也没挂着这个任务。',raw:'我取消了完成后发送，那图任务也没了吗？',tasks:[{execution:'running',result:'unavailable',delivery:{state:'not_attempted'},source:'live_job'}],corrected:'图任务还在处理，当前没有完成后自动发送的安排。'}
 ]
 for(const item of cases){
  const {api,event,host,archived,saved,enhanced}=fixture(),sent=[],messages=[],session={interactionContext:taskInteraction(),actionFactsQuery:{referenceMessageId:'original-request'}}
  session.interactionContext.rawUserText=item.raw
  session.interactionContext.actionFacts.tasks=item.tasks.map(change=>({taskId:'job',requestMessageId:'original-request',toolName:'imageEdit',source:'task_record',observedAt:Date.now(),execution:'unknown',result:'unknown',delivery:{state:'unknown'},followUp:{state:'none'},...change}))
  let repairs=0
  host.retryRequest=async()=>{repairs++;return {choices:[{message:{content:item.corrected}}]}}
  host.sendSegmentedMessage=async(_e,text)=>{sent.push(text);return 'state-corrected'}
  await api.handleTextResponse(host,item.candidate,event,session,messages)
  assert.equal(repairs,1,item.candidate)
  assert.equal(session.replyGrounding.fallback,false,item.candidate)
  assert.deepEqual(sent,[item.corrected],item.candidate)
  assert.equal(messages.at(-1).content,item.corrected)
  assert.equal(archived.length,1)
  assert.equal(archived[0].message[0].text,item.corrected)
  assert.equal(saved.length,1)
  assert.equal(enhanced[0][2],item.corrected)
  assert.doesNotMatch(JSON.stringify(messages),new RegExp(item.candidate.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')))
 }
})
test('an explicit later user request can lead to another reply without a background registration',async()=>{
 const {api,event,host,archived}=fixture(),sent=[],messages=[],session={interactionContext:taskInteraction()}
 const candidate='你吃完回来在群里问一声就行，我到时候现查状态，有结果直接发你。'
 let repairs=0
 host.retryRequest=async()=>{repairs++;throw Error('ordinary user-triggered response must not regenerate')}
 host.sendSegmentedMessage=async(_e,text)=>{sent.push(text);return 'user-triggered'}
 await api.handleTextResponse(host,candidate,event,session,messages)
 assert.equal(repairs,0)
 assert.deepEqual(sent,[candidate])
 assert.equal(archived[0].message[0].text,candidate)
 assert.equal(messages.at(-1).content,candidate)
})
test('diagnostic certainty and active sniffing are corrected before sending or learning',async()=>{
 const cases=[
  {raw:'CPU满载82℃，没有焦糊味，也没有冒烟，一直正常运行。我只想了解这个温度该怎么判断。',candidate:'82℃满载这个数本身不算危险信号，一般CPU规格里Tjunction上限在100℃左右，82℃还留有余量。',corrected:'当前型号和测点尚未确认，82℃本身是否危险还不能确定，需要对照对应型号的规格。'},
  {raw:'CPU满载82℃，没有焦糊味，也没有冒烟，一直正常运行。我只想了解这个温度该怎么判断。',candidate:'满载时有没有自动降频（频率被压下来说明触发了温度墙，那82℃就偏临界了）',corrected:'降频不一定由温度导致，可能还有功耗限制；当前型号和测点尚未确认，不能判断82℃是否临界。'},
  {raw:'维修师傅已经检查了我的电脑，确认CPU没有触发温度墙。CPU满载82℃。',candidate:'CPU已经触发温度墙。',corrected:'按你转述的检查，CPU没有触发温度墙；仍需结合型号和测点对照温度规格。'},
  {raw:'维修师傅已经检查了我的电脑，更换了损坏电源，确认没有其他电气损坏，允许受控开机。现在能测什么？',candidate:'师傅已经排查过并放行的话，可以让师傅在场做受控开机，先听风扇转速是否正常、闻有没有异味，看能不能点亮进系统。',corrected:'按师傅的放行范围做非接触观察，若自然察觉新的异常气味，停止运行并通知现场检修人员。'}
 ]
 for(const item of cases){
  const {api,event,host,archived,saved,enhanced}=fixture(),sent=[],messages=[]
  const interactionContext=buildTurnInteractionContext({rawUserText:item.raw,botId:'99',speaker:{userId:'2'}})
  interactionContext.diagnosticContext=buildDiagnosticContext({rawUserText:item.raw,speakerId:'2'})
  const session={interactionContext};let repairs=0
  host.retryRequest=async(_request,_tools,retries,_toolName,options)=>{repairs++;assert.equal(retries,0);assert.equal(options.generation.reasoningEffort,'low');return {choices:[{message:{content:item.corrected}}]}}
  host.sendSegmentedMessage=async(_e,text)=>{sent.push(text);return 'diagnostic-corrected'}
  await api.handleTextResponse(host,item.candidate,event,session,messages)
  assert.equal(repairs,1,item.candidate)
  assert.equal(session.replyGrounding.fallback,false,item.candidate)
  assert.deepEqual(sent,[item.corrected])
  assert.equal(messages.at(-1).content,item.corrected)
  assert.equal(archived[0].message[0].text,item.corrected)
  assert.equal(saved.length,1)
  assert.equal(enhanced[0][2],item.corrected)
 }
})
test('a repaired task reply cannot contradict a different known state dimension',async()=>{
 const {api,event,host,archived}=fixture(),sent=[],messages=[],session={interactionContext:taskInteraction(),actionFactsQuery:{referenceMessageId:'original-request'}}
 session.interactionContext.rawUserText='图出来了吗？还会自动发吗？'
 session.interactionContext.actionFacts.tasks=[{taskId:'job',requestMessageId:'original-request',toolName:'imageEdit',source:'task_record',observedAt:Date.now(),execution:'completed',result:'available',delivery:{state:'failed'},followUp:{state:'none'}}]
 let repairs=0
 host.retryRequest=async()=>{repairs++;return {choices:[{message:{content:'图已经做好了，不过我这边本来也没挂着这个任务。'}}]}}
 host.sendSegmentedMessage=async(_e,text)=>{sent.push(text);return 'state-fallback'}
 await api.handleTextResponse(host,'图在我这儿没有。',event,session,messages)
 assert.equal(repairs,1)
 assert.equal(session.replyGrounding.fallback,true)
 assert.ok(session.replyGrounding.remaining.length)
 assert.match(sent[0],/已有可用结果|图已经做好/u)
 assert.match(sent[0],/发送没有成功/u)
 assert.match(sent[0],/没有.*自动|不.*自动/u)
 assert.equal(messages.at(-1).content,sent[0])
 assert.equal(archived[0].message[0].text,sent[0])
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
