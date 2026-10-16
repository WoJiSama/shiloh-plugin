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
 for(const repair of [{tool_calls:[{function:{name:'reminderTool'}}],content:'好了发你。'},{content:'有结果我会通知你。'},{content:'等我确认到就回你。'}]){
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
const composedReplayCandidates=[
  {"candidate":"这个我现在没法给你准信欸。你之前发的那张我记得，但我这边没查到处理结果的记录，做得怎么样、出没出图都还没确认。\n\n我这边没有可核验的进度，不想瞎猜给你一个假答案。等我实际拿到图或者结果，再发给你。","raw":"刚才改背景的图出来了吗？","tasks":[],"corrected":"图片处理结果及完成后发送的安排尚未核实。你之后再问一声，我再查当前状态。"},
  {"candidate":"去吃吧。不过老实说，我这边没有查到会自动跟进的安排，所以不会“好了自动发你”。你要是吃完了想看进度，回来喊我一声，我再帮你查。","raw":"那我先去吃饭。好了你会自动发给我吗？","tasks":[],"corrected":"图片处理结果及完成后发送的安排尚未核实。你之后再问一声，我再查当前状态。"},
  {"candidate":"改图那件事还在处理中，具体好没好我这边没查到。自动发不行，你吃完回来喊我一声，我再去看结果。","raw":"那我先去吃饭。好了你会自动发给我吗？","tasks":[],"corrected":"图片处理结果及完成后发送的安排尚未核实。你之后再问一声，我再查当前状态。"},
  {"candidate":"做好了，图是有的。卡的是发出来那一步，不是还没做。你再等等，我想到办法就发你。","raw":"所以我现在没收到，是还没做好吗？","tasks":[{"taskId":"synthetic-task-001","requestMessageId":"synthetic-request-001","toolName":"imageEdit","source":"task_record","execution":"completed","result":"available","delivery":{"state":"failed"},"followUp":{"state":"none"},"observedAt":1792157677554}],"corrected":"图已经做好了，上次发送没有成功，后续再次发送的安排尚未核实。"},
  {"candidate":"我这边只核验到你的考试提醒登记了（2100年1月1日早上八点那个），改背景的图没有对应记录，所以现在没法确认它在跑，也不会好了自动发你。\n\n想要的话重新把图发我一次，我这轮能做就直接做。","raw":"刚才改背景的图出来了吗？我只登记了考试提醒，图好了会自动发我吗？","tasks":[{"taskId":"exam-reminder","requestMessageId":"exam-request","toolName":"reminderTool","source":"reminder","execution":"queued","result":"unknown","delivery":{"state":"not_attempted"},"followUp":{"state":"registered","kind":"reminder","id":"exam-reminder","dueAt":4102444800000},"observedAt":1792157892801}],"corrected":"图片处理及完成后发送的安排尚未核实；考试提醒不包含图片完成后的投递安排。"},
]
const capacityReplayCandidates=[
  {"candidate": "\u4f60\u90a3\u6761\u8003\u8bd5\u63d0\u9192\u662f\u767b\u8bb0\u4e0a\u4e86\uff0c2100\u5e741\u67081\u53f7\u65e9\u4e0a\u516b\u70b9\u89e6\u53d1\u3002\u6539\u80cc\u666f\u7684\u56fe\u8fd9\u8fb9\u6211\u8fd9\u8f6e\u6ca1\u67e5\u5230\u76f8\u5173\u8bb0\u5f55\uff0c\u505a\u6ca1\u505a\u597d\u3001\u51fa\u6765\u6ca1\u51fa\u6765\u90fd\u8fd8\u6ca1\u6cd5\u786e\u8ba4\uff0c\u4e5f\u5c31\u4e0d\u80fd\u66ff\u4f60\u6253\u5305\u7968\u3002\n\n\u201c\u597d\u4e86\u81ea\u52a8\u53d1\u201d\u8fd9\u79cd\u6ca1\u6709\u54e6\uff0c\u6ca1\u8fd9\u4e2a\u81ea\u52a8\u8ddf\u8fdb\u3002\u4f60\u8981\u662f\u8fd8\u60f3\u8981\uff0c\u76f4\u63a5\u518d\u6765\u627e\u6211\u8981\u4e00\u6b21\u5c31\u884c\uff0c\u6211\u5230\u65f6\u5019\u6309\u5f53\u8f6e\u80fd\u505a\u7684\u5e2e\u4f60\u67e5\u548c\u53d1\u3002", "raw": "\u521a\u624d\u6539\u80cc\u666f\u7684\u56fe\u51fa\u6765\u4e86\u5417\uff1f\u6211\u53ea\u767b\u8bb0\u4e86\u8003\u8bd5\u63d0\u9192\uff0c\u56fe\u597d\u4e86\u4f1a\u81ea\u52a8\u53d1\u6211\u5417\uff1f", "tasks": [{"taskId": "exam-reminder", "requestMessageId": "exam-request", "toolName": "reminderTool", "source": "reminder", "execution": "queued", "result": "unknown", "delivery": {"state": "not_attempted"}, "followUp": {"state": "registered", "kind": "reminder", "id": "exam-reminder", "dueAt": 4102444800000}, "observedAt": 1792162483918}], "corrected": "\u56fe\u7247\u5904\u7406\u7ed3\u679c\u53ca\u5b8c\u6210\u540e\u53d1\u9001\u7684\u5b89\u6392\u5c1a\u672a\u6838\u5b9e\uff1b\u8003\u8bd5\u63d0\u9192\u4e0d\u5305\u542b\u56fe\u7247\u5b8c\u6210\u540e\u7684\u6295\u9012\u5b89\u6392\u3002"},
  {"candidate": "\u6539\u80cc\u666f\u90a3\u4e2a\u8fd8\u5728\u5904\u7406\u4e2d\u6ca1\u51fa\u7ed3\u679c\uff0c\u505a\u597d\u6ca1\u6211\u8fd9\u4f1a\u513f\u8bf4\u4e0d\u597d\u3002\u53d1\u9001\u8fd9\u8fb9\u4e5f\u6ca1\u6302\u4e0a\u81ea\u52a8\u53d1\u7684\u5b89\u6392\uff0c\u6240\u4ee5\u4f60\u5403\u5b8c\u56de\u6765\u95ee\u6211\u4e00\u58f0\uff0c\u6211\u518d\u5e2e\u4f60\u770b\u3002", "raw": "\u90a3\u6211\u5148\u53bb\u5403\u996d\u3002\u597d\u4e86\u4f60\u4f1a\u81ea\u52a8\u53d1\u7ed9\u6211\u5417\uff1f", "tasks": [], "corrected": "\u56fe\u7247\u5904\u7406\u7ed3\u679c\u53ca\u5b8c\u6210\u540e\u53d1\u9001\u7684\u5b89\u6392\u5c1a\u672a\u6838\u5b9e\u3002"},
  {
    "candidate": "图是做好了，傍晚背景那版成品是有的。就是之前发给你那一下没发出去，具体原因我也没查到欸。\n\n这轮我手上没有能直接重发的工具，你现在再要一次的话，我下次拿到发送能力就给你补上。",
    "raw": "刚才的图出来了吗？",
    "tasks": [
      {
        "taskId": "synthetic-task-001",
        "requestMessageId": "synthetic-request-001",
        "toolName": "imageEdit",
        "source": "task_record",
        "execution": "completed",
        "result": "available",
        "delivery": {
          "state": "failed"
        },
        "followUp": {
          "state": "none"
        },
        "observedAt": 1792159132705
      }
    ],
    "corrected": "图已经做好了，上次发送没有成功，后续再次发送的安排尚未核实。"
  },
  {
    "candidate": "不是没做好，成品是有的。是发的那一步没成功，所以你才一直没收到。这轮我还是发不出去，等我有发送能力了再给你补。",
    "raw": "所以我现在没收到，是还没做好吗？",
    "tasks": [
      {
        "taskId": "synthetic-task-001",
        "requestMessageId": "synthetic-request-001",
        "toolName": "imageEdit",
        "source": "task_record",
        "execution": "completed",
        "result": "available",
        "delivery": {
          "state": "failed"
        },
        "followUp": {
          "state": "none"
        },
        "observedAt": 1792159135239
      }
    ],
    "corrected": "图已经做好了，上次发送没有成功，后续再次发送的安排尚未核实。"
  },
  {
    "candidate": "第一张图那张我这儿没查到完成的记录，之前也没发过欸。现在手头没法直接给你弄，你要方便的话把图再发一次，我看到就处理。",
    "raw": "我问的是这张图，出来了吗？",
    "tasks": [],
    "corrected": "第一张图片的处理结果和发送状态尚未核实。"
  }
]
test('qualified task claims and contradictions never become the next turn history',async()=>{
 const cases=[
  ...composedReplayCandidates,
  ...capacityReplayCandidates,
  {candidate:'图这边我还没查到结果，不确定好没好，别急哈。\n\n考试提醒那个是登记上了的，到 2100 年 1 月 1 号早上八点会触发。发图这事目前没有后续登记，所以就算图好了也不会自动发你，到时候你再喊我一声就行。',raw:'刚才改背景的图出来了吗？我只登记了考试提醒，图好了会自动发我吗？',tasks:[{source:'reminder',toolName:'reminderTool',execution:'queued',followUp:{state:'registered',kind:'reminder',id:'exam-reminder',dueAt:4102444800000}}],corrected:'图片处理结果及完成后发送的安排尚未核实；考试提醒不包含图片完成后的投递安排。'},
  {candidate:'你回来再问我，我再查，图真正出来后我再回你。',raw:'我问的是这张图，出来了吗？',tasks:[],corrected:'第一张图片的结果和后续通知安排尚未核实。你之后再问一声，我再查当前状态。'},
  {candidate:'这个我这边还没查到结果，进度我不敢乱说欸。\n\n任务我之前是接了的，现在有没有跑完还没确认，等我确认到就回你。',raw:'刚才改背景的图出来了吗？',tasks:[],corrected:'图片处理结果尚未核实，后续通知安排也尚未确认。你之后再问一声，我再查当前状态。'},
  {candidate:'这张还没确认好呢，第二张发出去的时候第一张的结果我这边没收到回执。等真的出来了我会直接发，不骗你。',raw:'我问的是这张图，出来了吗？',tasks:[],corrected:'第一张图片的结果和完成后发送的安排尚未核实，暂时不能确认。'},
  {candidate:'这次没查到有效的后续登记，所以做好了也不会自动发。原任务进度我也还没核实到，你吃完回来问一声，我再帮你看。',raw:'那我先去吃饭。好了你会自动发给我吗？',tasks:[],corrected:'图片处理的进度和完成后自动发送的安排尚未核实。你吃完回来问一声，我再查状态。'},
  {candidate:'图是做好了的，就是上次发送没成功。你要的话再发一次就收到了。',raw:'所以我现在没收到，是还没做好吗？',tasks:[{execution:'completed',result:'available',delivery:{state:'failed'}}],corrected:'图已经做好了，上次发送没有成功；再次发送是否成功仍需实际回执确认。'},
  {candidate:'查了下记录，目前只核验到你那条考试提醒的登记，改背景那张图没有对应的任务记录欸，所以我这边没法确认它在跑，也没有安排“好了自动发你”。\n\n你要是想改，可以再发一次图、明确说一声，我确认登记了再告诉你。',raw:'刚才改背景的图出来了吗？我只登记了考试提醒，图好了会自动发我吗？',tasks:[{source:'reminder',toolName:'reminderTool',execution:'queued',followUp:{state:'registered',kind:'reminder',id:'exam',dueAt:Date.now()+60_000}}],corrected:'图片处理及完成后发送的安排尚未核实；考试提醒不包含图片完成后的投递安排。'},
  {candidate:'不会自动发哦，我这边没那个功能。你吃完回来再喊我一声，我当场查，有就直接给你。',raw:'那我先去吃饭。好了你会自动发给我吗？',tasks:[],corrected:'这次完成后自动发送的安排尚未核实，不能保证会自动发。你吃完回来问一声就好。'},
  {candidate:'原任务还在跑没我不敢说死，但现在这个自动发送我这边没查到有效登记，所以好了不会自动发你。你吃完回来问我要结果，或者让我重新跑一次都行。',raw:'那我先去吃饭。好了你会自动发给我吗？',tasks:[],corrected:'图片处理的进度和完成后自动发送的安排尚未核实，不能确定。你吃完回来再问就好。'},
  {candidate:'不是没做好哦，傍晚那张已经做出来了。是发送那一步没成功，所以你没收到。原因我不确定，现在也没法替你自动补发。图还在，等能发的时候我给你发。',raw:'所以我现在没收到，是还没做好吗？',tasks:[{execution:'completed',result:'available',delivery:{state:'failed'}}],corrected:'图已经做好了，上次发送没有成功，具体原因尚未确认。'},
  {candidate:'不会啦。取消之后就没有完成后自动发的安排了。图要是之后真出了，就得你自己去任务页看，或者到时候再喊我。',raw:'我刚在任务页取消了完成后发送。那现在还会自动发吗？',tasks:[{source:'live_job',execution:'running',result:'unavailable',delivery:{state:'not_attempted'},followUp:{state:'none'}}],corrected:'按当前记录，图片任务仍在运行，已经没有完成后自动发送的安排；结果的领取位置尚未确认。'},
  {candidate:'第一张图这边我还没查到结果的记录，进度我这边确认不了。有实际产出我会直接发出来。',raw:'我问的是这张图，出来了吗？',tasks:[],corrected:'第一张图片的结果和完成后自动发送的安排尚未核实。'},
  {candidate:'查了下记录，这边只登记了你的考试提醒，没查到改背景那个图的任务记录，所以也不会自动发你。要改的话把图再发一遍，我看看这轮能不能直接给你弄。',raw:'刚才改背景的图出来了吗？我只登记了考试提醒，图好了会自动发我吗？',tasks:[{source:'reminder',toolName:'reminderTool',execution:'queued',followUp:{state:'registered',kind:'reminder',id:'exam',dueAt:Date.now()+60_000}}],corrected:'图片处理的结果和后续投递安排尚未核实；考试提醒不能证明图片任务状态。'},
  {candidate:'这个我现在没法确认欸，我这边没查到结果记录，说不准它是好了还是还在跑。等我实际确认到了再告诉你，不瞎猜。',raw:'刚才改背景的图出来了吗？',tasks:[],corrected:'图片处理的结果尚未核实，后续通知安排也尚未确认。'},
  {candidate:'不会自动发欸，我这边没有挂着那种到点推送的机制。你吃完回来说一声，我再帮你查一次。',raw:'那我先去吃饭。好了你会自动发给我吗？',tasks:[],corrected:'这次自动发送的安排尚未确认；你吃完回来问一声就好。'},
  {candidate:'图我这边没查到处理结果，还没法说好了没。至于自动发——你确实只登记了考试提醒，改图那个没有登记后续投递，所以图好了也不会自动发你，啦。要是有结果了我这边能确认到再说。',raw:'刚才改背景的图出来了吗？我只登记了考试提醒，图好了会自动发我吗？',tasks:[{source:'reminder',toolName:'reminderTool',execution:'queued',followUp:{state:'registered',kind:'reminder',id:'exam',dueAt:Date.now()+60_000}}],corrected:'图片处理的结果和后续投递安排尚未核实；考试提醒不能证明图片任务状态。'},
  {candidate:'查了下记录，改背景那张图目前没有确认产物，我没看到已经做完的结果。会自动发的只有你登记的考试提醒，图那边没有登记投递，好了不会自动发你——而且现在也不能确定它“会好”。要不你重新发一次图，我再看看？',raw:'刚才改背景的图出来了吗？我只登记了考试提醒，图好了会自动发我吗？',tasks:[{source:'reminder',toolName:'reminderTool',execution:'queued',followUp:{state:'registered',kind:'reminder',id:'exam',dueAt:Date.now()+60_000}}],corrected:'图片处理的结果和后续投递安排尚未核实；考试提醒不能证明图片任务状态。'},
  {candidate:'不是被你拒收或者屏蔽哦，具体原因我这边也没查到。',raw:'所以我现在没收到，是还没做好吗？',tasks:[{execution:'completed',result:'available',delivery:{state:'failed'}}],corrected:'图已经做好了，上次发送没有成功，具体原因尚未确认。'},
  {candidate:'第一张的蓝色背景还没出来欸，这边没查到完成记录。',raw:'我问的是这张图，出来了吗？',tasks:[],corrected:'第一张的处理结果还没核实，不能确认是否完成。'},
  {candidate:'第一张蓝底的还没出来，我这边没查到做完的记录。',raw:'我问的是这张图，出来了吗？',tasks:[],corrected:'第一张的处理结果还没核实，不能确认是否完成。'},
  {candidate:'这张我这边没查到做好的记录，还不算出来哦。',raw:'我问的是这张图，出来了吗？',tasks:[],corrected:'第一张的处理结果还没核实，不能确认是否完成。'},
  {candidate:'这个我还没法确认欸，手上没有处理结果的记录，不好说现在是好了还是卡着。等我确认到就第一时间发你。',raw:'刚才改背景的图出来了吗？',tasks:[],corrected:'这次图片处理的结果尚未核实，暂时不能确认是否完成。'},
  {candidate:'这个我还没确认到结果欸，进度和图都没拿到。有了我发你。',raw:'刚才改背景的图出来了吗？',tasks:[],corrected:'这次图片处理的结果尚未核实，暂时不能确认是否完成。'},
  {candidate:'第一张图这边还没查到确认的产出记录，进度我也说不好，不敢瞎答。确认了马上告诉你。',raw:'我问的是这张图，出来了吗？',tasks:[],corrected:'第一张图的处理结果尚未核实，后续通知安排也尚未确认。'},
  {candidate:'这个我现在还没确认到结果，上一轮我接了任务，但处理进度这边没有可查的记录，我不瞎猜状态。我这边确认到实际结果就直接发你。',raw:'刚才改背景的图出来了吗？',tasks:[],corrected:'图片处理的结果尚未核实，完成后自动发送的安排也尚未确认。'},
  {candidate:'第一张图的情况我这边还没确认到，做没做好、发没发都不好说死，不敢直接答“出来了”。第二张傍晚的是确定发了的。第一张等我拿到实际结果再跟你说，现在先不瞎猜。',raw:'我问的是这张图，出来了吗？',tasks:[],corrected:'第一张图片的处理和投递状态尚未核实，后续通知安排也尚未确认。'},
  {candidate:'我现在没有能自动推送的设置，这边没查到登记，不能空口答应你。你吃完回来在群里喊我一声，我再帮你确认。慢慢吃。',raw:'那我先去吃饭。好了你会自动发给我吗？',tasks:[],corrected:'我还没查到这次的自动发送安排，不能保证会自动发。你吃完回来问一声就好。'},
  {candidate:'不会自动发哦，我这边没挂这个提醒。要不你吃完回来说一声，我再重新跑一遍。',raw:'那我先去吃饭。好了你会自动发给我吗？',tasks:[],corrected:'我还没查到这次的自动发送安排，不能保证会自动发。你吃完回来问一声就好。'},
  {candidate:'取消了就不会自动发了，取消是即时生效的。',raw:'我刚在任务页取消了完成后发送。那现在还会自动发吗？',tasks:[{source:'live_job',execution:'running',result:'unavailable',delivery:{state:'not_attempted'},followUp:{state:'none'}}],corrected:'按当前记录，图任务仍在运行，已经没有完成后自动发送的安排。'},
  {candidate:'出来的图你可以自己在任务页拿，或者到时候再叫我发一遍也行。',raw:'我刚在任务页取消了完成后发送。那现在还会自动发吗？',tasks:[{source:'live_job',execution:'running',result:'unavailable',delivery:{state:'not_attempted'},followUp:{state:'none'}}],corrected:'按当前记录，图任务仍在运行，已经没有完成后自动发送的安排；结果的领取位置尚未确认。'},
  {candidate:'图早做好啦，就是那次发送没成功，不是还没做好。你要的话我现在手动发你。',raw:'所以我现在没收到，是还没做好吗？',tasks:[{execution:'completed',result:'available',delivery:{state:'failed'}}],corrected:'图已经做好了，上次发送没有成功，具体原因还没确认。'},
  {candidate:'改背景那个任务确实是登记了的，在排队中，不过产物我这儿还没查到确认结果，所以现在没法直接给你图。',raw:'刚才改背景的图出来了吗？我只登记了考试提醒，图好了会自动发我吗？',tasks:[{source:'reminder',toolName:'reminderTool',execution:'queued',followUp:{state:'registered',kind:'reminder',id:'exam',dueAt:Date.now()+60_000}}],corrected:'这次图片处理的结果尚未核实；考试提醒不能证明图片处理进度。'},
  {candidate:'改背景的图我这边没查到有登记记录，可能当时没接上，啦。考试提醒是登记了的，但那只是提醒，不会带图。图要发你的话，得重新弄一次才行。',raw:'刚才改背景的图出来了吗？我只登记了考试提醒，图好了会自动发我吗？',tasks:[{source:'reminder',toolName:'reminderTool',execution:'queued',followUp:{state:'registered',kind:'reminder',id:'exam',dueAt:Date.now()+60_000}}],corrected:'图片处理的结果尚未核实，不能确认是否需要重新处理；考试提醒不能证明图片进度。'},
  {candidate:'图这边没查到处理记录哦，改背景那张没登记上，所以也不会自动发你。你登记的只有考试提醒，2100年1月1号早上八点那个。要改背景的话，把图再发一次说一声，我看看这轮能不能接。',raw:'刚才改背景的图出来了吗？我只登记了考试提醒，图好了会自动发我吗？',tasks:[{source:'reminder',toolName:'reminderTool',execution:'queued',followUp:{state:'registered',kind:'reminder',id:'exam',dueAt:Date.now()+60_000}}],corrected:'改背景的图片任务记录尚未核实；考试提醒不能证明图片任务是否登记或完成。'},
  {candidate:'图还没确认出来欸，我这边没查到改图的记录。你登记的确实只有考试提醒，那个和图是两回事，所以不会自动发你。想要图的话，得重新跟我说一声改背景，我这边没有“好了自动发”的安排。',raw:'刚才改背景的图出来了吗？我只登记了考试提醒，图好了会自动发我吗？',tasks:[{source:'reminder',toolName:'reminderTool',execution:'queued',followUp:{state:'registered',kind:'reminder',id:'exam',dueAt:Date.now()+60_000}}],corrected:'图片任务状态尚未核实，不能断言必须重新发起；考试提醒不包含图片完成后的投递安排。'},
  {candidate:'所以现在图在我这儿没有。',raw:'所以我现在没收到，是还没做好吗？',tasks:[{execution:'completed',result:'available',delivery:{state:'failed'}}],corrected:'图已经做好了，上次发送没有成功，具体原因还没确认。'},
  {candidate:'我这边本来也没挂着这个任务。',raw:'我取消了完成后发送，那图任务也没了吗？',tasks:[{execution:'running',result:'unavailable',delivery:{state:'not_attempted'},source:'live_job'}],corrected:'图任务还在处理，当前没有完成后自动发送的安排。'}
 ]
 for(const item of cases){
  const {api,event,host,archived,saved,enhanced}=fixture(),sent=[],messages=[],session={interactionContext:taskInteraction()}
  session.interactionContext.rawUserText=item.raw
  session.interactionContext.actionFacts.tasks=item.tasks.map(change=>({taskId:'job',requestMessageId:'original-request',toolName:'imageEdit',source:'task_record',observedAt:Date.now(),execution:'unknown',result:'unknown',delivery:{state:'unknown'},followUp:{state:'none'},...change}))
  session.actionFactsQuery={recentRequestMessageIds:session.interactionContext.actionFacts.tasks.map(task=>task.requestMessageId)}
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
test('invalid composed task claims returned by repair fall back before history or learning',async()=>{
 for(const item of [...composedReplayCandidates,...capacityReplayCandidates]){
  const {api,event,host,archived,enhanced}=fixture(),sent=[],messages=[],session={interactionContext:taskInteraction()}
  session.interactionContext.rawUserText=item.raw
  session.interactionContext.actionFacts.tasks=item.tasks
  let repairs=0
  host.retryRequest=async()=>{repairs++;return {choices:[{message:{content:item.candidate}}]}}
  host.sendSegmentedMessage=async(_e,text)=>{sent.push(text);return 'composed-claim-fallback'}
  await api.handleTextResponse(host,'还没出来，好了我第一时间发你。',event,session,messages)
  assert.equal(repairs,1,item.candidate)
  assert.equal(session.replyGrounding.fallback,true,item.candidate)
  assert.equal(sent.length,1)
  assert.notEqual(sent[0],item.candidate)
  assert.equal(messages.at(-1).content,sent[0])
  assert.equal(archived[0].message[0].text,sent[0])
  assert.equal(enhanced[0][2],sent[0])
 }
})
test('an explicit later user request can lead to another reply without a background registration',async()=>{
 for(const candidate of ['你吃完回来在群里问一声就行，我到时候现查状态，有结果直接发你。','你回来再问我，我再查，确认到就回你。']){
 const {api,event,host,archived}=fixture(),sent=[],messages=[],session={interactionContext:taskInteraction()}
 let repairs=0
 host.retryRequest=async()=>{repairs++;throw Error('ordinary user-triggered response must not regenerate')}
 host.sendSegmentedMessage=async(_e,text)=>{sent.push(text);return 'user-triggered'}
 await api.handleTextResponse(host,candidate,event,session,messages)
 assert.equal(repairs,0)
 assert.deepEqual(sent,[candidate])
 assert.equal(archived[0].message[0].text,candidate)
 assert.equal(messages.at(-1).content,candidate)
 }
})
test('a repaired image-arrangement denial cannot borrow a reminder or enter sent history',async()=>{
 const {api,event,host,archived,saved,enhanced}=fixture(),sent=[],messages=[],session={interactionContext:taskInteraction()}
 const invalidRepair='图这边我还没查到结果，不确定好没好，别急哈。\n\n考试提醒那个是登记上了的，到 2100 年 1 月 1 号早上八点会触发。发图这事目前没有后续登记，所以就算图好了也不会自动发你，到时候你再喊我一声就行。'
 session.interactionContext.rawUserText='刚才改背景的图出来了吗？我只登记了考试提醒，图好了会自动发我吗？'
 session.interactionContext.actionFacts.tasks=[{taskId:'exam-reminder',requestMessageId:'exam-request',source:'reminder',toolName:'reminderTool',observedAt:Date.now(),execution:'queued',result:'unknown',delivery:{state:'not_attempted'},followUp:{state:'registered',kind:'reminder',id:'exam-reminder',dueAt:4102444800000}}]
 let repairs=0
 host.retryRequest=async()=>{repairs++;return {choices:[{message:{content:invalidRepair}}]}}
 host.sendSegmentedMessage=async(_e,text)=>{sent.push(text);return 'reminder-independent-fallback'}
 await api.handleTextResponse(host,'改背景的图没有登记到任务，所以也不会自动发你。',event,session,messages)
 assert.equal(repairs,1)
 assert.equal(session.replyGrounding.fallback,true)
 assert.equal(sent.length,1)
 assert.notEqual(sent[0],invalidRepair)
 assert.match(sent[0],/尚未核实/u)
 assert.equal(messages.at(-1).content,sent[0])
 assert.equal(archived[0].message[0].text,sent[0])
 assert.equal(saved.length,1)
 assert.equal(enhanced[0][2],sent[0])
 assert.doesNotMatch(JSON.stringify(messages),/所以就算图好了也不会自动发你/u)
})
test('completed results and past delivery failures keep their original wording without a new promise',async()=>{
 for(const candidate of [
  '做好了，就是发你那边失败了，不是还没弄完。你再问下某熟人或者管理员吧，我这边暂时发不了。',
  '不是没做好，图是完成了的，只是上次发给你没发成功，原因我也不确定。我这边现在没法主动重发，你要是想再要，就再跟我说一声，或者问问某熟人和管理员。'
 ]){
  const {api,event,host,archived,enhanced}=fixture(),sent=[],messages=[],session={interactionContext:taskInteraction()}
  session.interactionContext.rawUserText='所以我现在没收到，是还没做好吗？'
  session.interactionContext.actionFacts.tasks=[{taskId:'job',requestMessageId:'original-request',toolName:'imageEdit',source:'task_record',observedAt:Date.now(),execution:'completed',result:'available',delivery:{state:'failed'},followUp:{state:'none'}}]
  let repairs=0
  host.retryRequest=async()=>{repairs++;throw Error('past failure is not a new promise')}
  host.sendSegmentedMessage=async(_e,text)=>{sent.push(text);return 'past-failure'}
  await api.handleTextResponse(host,candidate,event,session,messages)
  assert.equal(repairs,0,candidate)
  assert.deepEqual(sent,[candidate])
  assert.equal(messages.at(-1).content,candidate)
  assert.equal(archived[0].message[0].text,candidate)
  assert.equal(enhanced[0][2],candidate)
 }
})
test('requested recreation and human activity keep their original final reply without a repair',async()=>{
 for(const [raw,candidate] of [
  ['把刚才的图重新生成一遍，背景换成蓝色。','这张图需要重新生成。'],
  ['刚才那张图出来了吗？','我妹妹刚刚做蛋糕。得重新弄一次才行。'],
  ['刚才那张图出来了吗？','我在练厨艺。得重新弄一次才行。']
 ]){
  const {api,event,host,archived,enhanced}=fixture(),sent=[],messages=[],session={interactionContext:taskInteraction()}
  session.interactionContext.rawUserText=raw
  let repairs=0
  host.retryRequest=async()=>{repairs++;throw Error('supported request or human activity must not regenerate')}
  host.sendSegmentedMessage=async(_e,text)=>{sent.push(text);return 'original-reply'}
  await api.handleTextResponse(host,candidate,event,session,messages)
  assert.equal(repairs,0,candidate)
  assert.deepEqual(sent,[candidate])
  assert.equal(archived[0].message[0].text,candidate)
  assert.equal(messages.at(-1).content,candidate)
  assert.equal(enhanced[0][2],candidate)
 }
})
test('diagnostic certainty and active sniffing are corrected before sending or learning',async()=>{
 const cases=[
  {"raw": "\u90a3\u6211\u80fd\u5148\u5f00\u673a\u8bd5\u4e00\u4e0b\u5417\uff1f", "history": [{"role": "user", "userId": "2", "text": "\u7535\u8111\u7535\u6e90\u90a3\u91cc\u6709\u7126\u7cca\u5473\uff0c\u5df2\u7ecf\u62d4\u7535\u4e86\u3002\u522b\u5f00\u73a9\u7b11\uff0c\u80fd\u600e\u4e48\u529e\uff1f"}], "candidate": "\u5148\u522b\u5f00\u673a\u3002\u7126\u7cca\u5473\u8bf4\u660e\u7535\u6e90\u53ef\u80fd\u6709\u95ee\u9898\uff0c\u635f\u574f\u8fd8\u6ca1\u6392\u9664\uff0c\u518d\u901a\u7535\u6709\u4e8c\u6b21\u635f\u574f\u751a\u81f3\u8d77\u706b\u7684\u98ce\u9669\uff0c\u8fd9\u6b21\u8bd5\u673a\u6362\u4e0d\u6765\u53ef\u9760\u7ed3\u8bba\u3002\u4fdd\u6301\u65ad\u7535\uff0c\u7b49\u5b83\u5b8c\u5168\u51b7\u5374\u540e\u53ea\u505a\u9759\u6001\u68c0\u67e5\uff08\u5916\u89c2\u3001\u7ebf\u6750\u6709\u6ca1\u6709\u70e7\u75d5\u53d8\u5f62\uff09\uff0c\u8981\u518d\u70b9\u4eae\u4e5f\u5f97\u7b49\u9001\u4fee\u786e\u8ba4\u6216\u6362\u4e0a\u65b0\u7535\u6e90\u4e4b\u540e\u3002", "corrected": "\u4fdd\u6301\u65ad\u7535\uff0c\u4e0d\u8981\u70b9\u4eae\u3002\u7b49\u540c\u4e00\u8bbe\u5907\u5b8c\u6210\u4e13\u4e1a\u68c0\u4fee\u5e76\u660e\u786e\u653e\u884c\u540e\uff0c\u518d\u6309\u653e\u884c\u8303\u56f4\u505a\u975e\u63a5\u89e6\u8fd0\u884c\u76d1\u6d4b\u3002"},
  {"raw": "\u7ef4\u4fee\u5e08\u5085\u5df2\u7ecf\u68c0\u67e5\u4e86\u521a\u624d\u8fd9\u53f0\u673a\u5668\u7684\u7535\u6e90\u3001\u7ebf\u6750\u548c\u677f\u5361\uff0c\u66f4\u6362\u4e86\u635f\u574f\u7535\u6e90\uff0c\u786e\u8ba4\u6ca1\u6709\u5176\u4ed6\u7535\u6c14\u635f\u574f\uff0c\u5e76\u8ba9\u6211\u5728\u5e97\u91cc\u505a\u53d7\u63a7\u5f00\u673a\u3002\u8ba4\u771f\u95ee\uff1a\u8fd9\u65f6\u80fd\u5148\u6d4b\u4ec0\u4e48\uff1f", "candidate": "\u65e2\u7136\u5e08\u5085\u67e5\u8fc7\u7535\u6e90\u3001\u7ebf\u6750\u548c\u677f\u5361\uff0c\u8fd8\u6362\u4e86\u7535\u6e90\uff0c\u5728\u5e97\u91cc\u53d7\u63a7\u5f00\u673a\u662f\u5408\u7406\u7684\u3002\u80fd\u6d4b\u7684\u8bdd\u6309\u8fd9\u4e2a\u987a\u5e8f\u6765\uff1a\n\n1. **\u70b9\u4eae\u548c\u81ea\u68c0**\uff1a\u5f00\u673a\u770b\u80fd\u4e0d\u80fd\u8fc7 POST/BIOS \u81ea\u68c0\uff0c\u6709\u6ca1\u6709\u62a5\u8b66\u58f0\u6216\u62a5\u9519\u7801\uff0cBIOS \u91cc\u770b\u7535\u538b\u3001\u6e29\u5ea6\u8bfb\u6570\u662f\u5426\u5728\u6b63\u5e38\u8303\u56f4\u3002\n2. **\u98ce\u6247\u89c2\u5bdf**\uff1a\u9694\u7740\u673a\u7bb1\u7f51\u5b54\u6216\u9762\u677f\u770b\u5404\u98ce\u6247\u8f6c\u4e0d\u8f6c\uff0c\u4e0d\u62c6\u4fa7\u677f\u51d1\u8fd1\u3002\n3. **\u8fdb\u7cfb\u7edf\u524d\u7684\u4fe1\u53f7**\uff1a\u5f00\u673a\u540e\u95fb\u6709\u6ca1\u6709\u5f02\u5473\u590d\u53d1\u3001\u542c\u6709\u6ca1\u6709\u5f02\u54cd\uff0c\u4e00\u65e6\u51fa\u73b0\u7acb\u523b\u65ad\u7535\u3002\n4. **\u77ed\u65f6\u4f4e\u8d1f\u8f7d**\uff1a\u5148\u8fdb\u7cfb\u7edf\u6216\u8fdb BIOS \u7a7a\u8f6c\u5341\u51e0\u5206\u949f\uff0c\u7a33\u5b9a\u518d\u9010\u6b65\u52a0\u8d1f\u8f7d\uff0c\u522b\u4e00\u4e0a\u6765\u5c31\u8dd1\u538b\u529b\u6d4b\u8bd5\u3002\n\n\u8981\u6ce8\u610f\uff1a\u77ed\u65f6\u70b9\u4eae\u6b63\u5e38\u53ea\u8bf4\u660e\u76ee\u524d\u6ca1\u89c2\u5bdf\u5230\u5f02\u5e38\uff0c\u4e0d\u7b49\u4e8e\u6574\u673a\u7edd\u5bf9\u5b89\u5168\u3002\u5e08\u5085\u786e\u8ba4\u7684\u8303\u56f4\u53ea\u8986\u76d6\u4ed6\u68c0\u67e5\u8fc7\u7684\u7535\u6e90\u3001\u7ebf\u6750\u548c\u677f\u5361\uff0c\u4e4b\u540e\u5934\u51e0\u5929\u7528\u7684\u65f6\u5019\u7559\u610f\u6e29\u5ea6\u548c\u6c14\u5473\uff0c\u6709\u4e0d\u5bf9\u52b2\u5c31\u505c\u3002", "corrected": "\u6309\u5e08\u5085\u7684\u653e\u884c\u8303\u56f4\u505a\u975e\u63a5\u89e6\u89c2\u5bdf\uff0c\u82e5\u81ea\u7136\u5bdf\u89c9\u65b0\u7684\u5f02\u5e38\u6c14\u5473\uff0c\u505c\u6b62\u8fd0\u884c\u5e76\u901a\u77e5\u73b0\u573a\u68c0\u4fee\u4eba\u5458\u3002"},
  {"raw": "认真问另一个情况：CPU满载82℃，没有焦糊味，也没有冒烟，一直正常运行。我只想了解这个温度该怎么判断。", "candidate": "82℃满载这数其实挺健康的，大多数CPU的温度墙在95~105℃，82℃离降频还有段距离。\n\n判断的话看三点：一是你的U的Tjunction上限（查型号规格就知道）；二是满载时频率有没有掉，没掉说明没撞温度墙；三是环境温度和散热条件，夏天机箱闷的话会整体高几度。无烟无味加上运行正常，这个温度本身不用担心。", "corrected": "当前型号和测点尚未确认，82℃本身是否危险还不能确定，需要对照对应型号的规格。"},
  {raw:'CPU满载82℃，没有焦糊味，也没有冒烟，一直正常运行。我只想了解这个温度该怎么判断。',candidate:'82℃满载这个数本身不算危险信号，一般CPU规格里Tjunction上限在100℃左右，82℃还留有余量。',corrected:'当前型号和测点尚未确认，82℃本身是否危险还不能确定，需要对照对应型号的规格。'},
  {raw:'CPU满载82℃，没有焦糊味，也没有冒烟，一直正常运行。我只想了解这个温度该怎么判断。',candidate:'满载时有没有自动降频（频率被压下来说明触发了温度墙，那82℃就偏临界了）',corrected:'降频不一定由温度导致，可能还有功耗限制；当前型号和测点尚未确认，不能判断82℃是否临界。'},
  {raw:'维修师傅已经检查了我的电脑，确认CPU没有触发温度墙。CPU满载82℃。',candidate:'CPU已经触发温度墙。',corrected:'按你转述的检查，CPU没有触发温度墙；仍需结合型号和测点对照温度规格。'},
  {raw:'维修师傅已经检查了刚才这台机器的电源、线材和板卡，更换了损坏电源，确认没有其他电气损坏，并让我在店里做受控开机。认真问：这时能先测什么？',candidate:'既然师傅已经检修放行，受控开机时先测这些：\n1. **先闻和看**：开机后站在机箱侧后方，留意是否再出现焦糊味或烟雾，一有异常立刻断电。\n4. **轻载观察**：进系统后先空转十分钟，不急着跑压力测试，摸机箱出风口风是不是温热但不烫手。',corrected:'按师傅的放行范围做非接触运行监测，查看软件读数和是否自然出现异常。若自然察觉新的焦味或烟雾，停止运行并通知现场检修人员。'},
  {raw:'维修师傅已经检查了我的电脑，更换了损坏电源，确认没有其他电气损坏，允许受控开机。现在能测什么？',candidate:'师傅已经排查过并放行的话，可以让师傅在场做受控开机，先听风扇转速是否正常、闻有没有异味，看能不能点亮进系统。',corrected:'按师傅的放行范围做非接触观察，若自然察觉新的异常气味，停止运行并通知现场检修人员。'}
 ]
 for(const item of cases){
  const {api,event,host,archived,saved,enhanced}=fixture(),sent=[],messages=[]
  const interactionContext=buildTurnInteractionContext({rawUserText:item.raw,botId:'99',speaker:{userId:'2'}})
  interactionContext.diagnosticContext=buildDiagnosticContext({rawUserText:item.raw,speakerId:'2',history:item.history})
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
test('diagnostic prohibitions and risk descriptions reach final history without an unnecessary repair',async()=>{
 const raw='电脑电源那里有焦糊味，已经拔电了。别开玩笑，能怎么办？'
 for(const candidate of [
  "\u5df2\u7ecf\u62d4\u7535\u5c31\u5bf9\u4e86\uff0c\u5148\u4fdd\u6301\u8fd9\u4e2a\u72b6\u6001\uff0c\u522b\u518d\u901a\u7535\u3002\n\n\u63a5\u4e0b\u6765\u80fd\u505a\u7684\uff1a\n- \u8ba9\u673a\u5668\u9759\u7f6e\u51b7\u5374\uff0c\u7535\u6e90\u522b\u6478\u522b\u62c6\uff0c\u4e5f\u522b\u51d1\u8fd1\u95fb\n- \u65ad\u7535\u72b6\u6001\u4e0b\u53ef\u4ee5\u770b\u4e00\u4e0b\u7535\u6e90\u5916\u58f3\u548c\u7ebf\u6750\u6709\u6ca1\u6709\u660e\u663e\u70e7\u75d5\u3001\u53d8\u5f62\uff0c\u770b\u5230\u5f02\u5e38\u5c31\u62cd\u7167\u7559\u8bc1\n- \u7126\u7cca\u5473\u5c5e\u4e8e\u7535\u6c14\u5f02\u5e38\u7684\u4fe1\u53f7\uff0c\u6ca1\u6cd5\u4ece\u5916\u9762\u786e\u8ba4\u662f\u7535\u6e90\u8fd8\u662f\u4e3b\u677f\u7684\u95ee\u9898\uff0c\u522b\u81ea\u5df1\u6392\u9664\u4efb\u4f55\u4e00\u79cd\n- \u4e4b\u540e\u4ea4\u7ef4\u4fee\u68c0\u6d4b\uff0c\u68c0\u4fee\u786e\u8ba4\u524d\u4e0d\u8981\u518d\u901a\u7535\u5f00\u673a\u2014\u2014\u5c31\u7b97\u770b\u8d77\u6765\u6ca1\u4e8b\u3001\u5473\u9053\u6563\u4e86\u4e5f\u4e0d\u7b97\u6392\u9664\n\n\u4eca\u665a\u5148\u522b\u60f3\u7740\u6551\u5b83\uff0c\u7761\u4e2a\u89c9\uff0c\u660e\u5929\u9001\u4fee\u5c31\u597d\u3002",
  "\u597d\uff0c\u8ba4\u771f\u8bf4\u3002\u62d4\u7535\u8fd9\u6b65\u505a\u5f97\u5bf9\uff0c\u73b0\u5728\u5c31\u4fdd\u6301\u65ad\u7535\uff0c\u522b\u518d\u63d2\u56de\u53bb\u3002\n\n\u63a5\u4e0b\u6765\uff1a\n- \u8ba9\u5b83\u9759\u7f6e\u51b7\u5374\u4e00\u6bb5\u65f6\u95f4\uff0c\u522b\u6478\u522b\u62c6\uff0c\u4e5f\u522b\u51d1\u8fd1\u95fb\n- \u51b7\u4e0b\u6765\u4e4b\u540e\uff0c\u65ad\u7535\u72b6\u6001\u4e0b\u770b\u770b\u7535\u6e90\u5916\u58f3\u3001\u7ebf\u6750\u548c\u63a5\u53e3\u6709\u6ca1\u6709\u660e\u663e\u70e7\u75d5\u6216\u53d8\u5f62\uff0c\u6709\u5c31\u62cd\u7167\u7559\u8bc1\n- \u7126\u7cca\u5473\u53ea\u80fd\u8bf4\u660e\u6709\u5f02\u5e38\uff0c\u4ece\u5916\u9762\u786e\u8ba4\u4e0d\u4e86\u662f\u7535\u6e90\u8fd8\u662f\u4e3b\u677f\u7684\u95ee\u9898\uff0c\u6240\u4ee5\u522b\u81ea\u5df1\u4e0b\u7ed3\u8bba\uff0c\u4e5f\u522b\u56e0\u4e3a\u770b\u8d77\u6765\u6ca1\u574f\u5c31\u5f53\u6ca1\u4e8b\n- \u9001\u7ef4\u4fee\u505a\u4e13\u4e1a\u68c0\u6d4b\uff0c\u68c0\u4fee\u653e\u884c\u4e4b\u524d\u4e0d\u8981\u518d\u901a\u7535\uff1b\u5c31\u7b97\u4e4b\u540e\u80fd\u70b9\u4eae\u3001\u80fd\u77ed\u65f6\u5f00\u673a\uff0c\u4e5f\u4e0d\u4ee3\u8868\u6574\u673a\u5b89\u5168\n\n\u4eca\u665a\u5b83\u5c31\u5148\u6b47\u7740\u5427\uff0c\u660e\u5929\u518d\u5904\u7406\u3002",
  '先别开。焦糊味说明电气损坏还没排除，现在通电试机等于拿整机冒险。保持断电，等这台机器经专业检修确认没问题放行后，才谈得上开机检测。',
  '不行，别开机。焦糊味还没排除是哪里烧了，再通电可能让故障扩大，甚至有起火风险。让它保持断电，直接送修吧。',
  '拔电对，先这样放着，别急着开机。\n\n焦糊味说明有异常，但具体哪里出问题、损坏到什么程度，现在没法断定。别自己拆、别凑近闻。等机器完全凉下来后，可以隔着看一眼电源外壳和出风口有没有烧痕、变形。不管有没有看到痕迹，都建议送修或找专业人员检测，确认安全之前别再通电——万一内部有损坏，带伤开机有连累其他部件的风险。\n\n现在保持断电就好。',
  '不建议自己开机测。再通电有风险，外面没有烧痕也不能证明里面没事。',
  '保持断电，送去让维修的当面检测。等检修确认排除问题了，再谈开机测试。',
  '电源、主板这些都有可能，得检查了才知道。最稳的是送维修，让师傅检测、排除电气损坏之后再考虑开机，就算之后看起来没事，也不能说明没损坏。',
  '之前有焦糊味，电气损坏还没被专业排除，直接通电有可能让损坏扩大。保持电源线拔着，交维修人员现场排查；等他们确认这台机器没问题、放行之后再通电测试。',
  '别自己开机。焦糊味说明可能有东西烧了，即使闻不到味也不能排除里面没坏，通电有风险。想试机的唯一前提是：拿到维修处让师傅拆开检查、确认没有电气损坏并放行之后，再由他们那边点亮测试。在那之前，线保持拔着就行。',
  '现在还不行。有焦糊味说明电源位置出现过异常，损坏还没排除，通电测试本身就有风险，而且就算能点亮也不代表没问题。先按之前说的：保持断电，静置放凉，等维修检测确认安全之后，才轮得到开机试。别自己抢这一步。',
  '通电测试之前最好先拿去维修检测，尤其别再接原电源开机试。',
  '不行，先别开。焦糊味说明里面可能有元件烧坏，再通电短路或扩大损坏的风险真实存在。想知道严重程度的话，等它彻底冷却后拔着电看外壳有没有烧痕、变形，这些也只能外部看看。具体坏没坏、坏在哪，得维修的人检测。忍住别按开机键哈。',
  '现在不行。这台机器的电气损坏还没排除，通电测试可能扩大损坏甚至有安全风险，运行检测的前提不存在。要试机，也得等专业检修确认这台电源和相关部件没问题、放行之后再说。'
 ]){
  const {api,event,host,archived,enhanced}=fixture(),sent=[],messages=[]
  const interactionContext=buildTurnInteractionContext({rawUserText:raw,botId:'99',speaker:{userId:'2'}})
  interactionContext.diagnosticContext=buildDiagnosticContext({rawUserText:raw,speakerId:'2'})
  let repairs=0
  host.retryRequest=async()=>{repairs++;throw Error('risk descriptions and prohibitions must remain intact')}
  host.sendSegmentedMessage=async(_e,text)=>{sent.push(text);return 'diagnostic-original'}
  await api.handleTextResponse(host,candidate,event,{interactionContext},messages)
  assert.equal(repairs,0,candidate)
  assert.deepEqual(sent,[candidate])
  assert.equal(messages.at(-1).content,candidate)
  assert.equal(archived[0].message[0].text,candidate)
  assert.equal(enhanced[0][2],candidate)
 }
})
test('unknown-temperature epistemic denials reach final history unchanged',async()=>{
 const raw='CPU满载82℃，没有焦糊味，也没有冒烟，一直正常运行。我只想了解这个温度该怎么判断。'
 for(const candidate of [
  '单看温度本身说明不了正常还是异常，得结合型号、测点和规格。',
  '单个82℃读数还没法直接判定正常或不正常。需要先确认CPU型号和传感器。',
  '单凭82℃这个读数判断不了正常还是异常，得结合条件看。'
 ]){
  const {api,event,host,archived,enhanced}=fixture(),sent=[],messages=[]
  const interactionContext=buildTurnInteractionContext({rawUserText:raw,botId:'99',speaker:{userId:'2'}})
  interactionContext.diagnosticContext=buildDiagnosticContext({rawUserText:raw,speakerId:'2'})
  let repairs=0
  host.retryRequest=async()=>{repairs++;throw Error('epistemic negation must remain intact')}
  host.sendSegmentedMessage=async(_e,text)=>{sent.push(text);return 'temperature-original'}
  await api.handleTextResponse(host,candidate,event,{interactionContext},messages)
  assert.equal(repairs,0,candidate)
  assert.deepEqual(sent,[candidate])
  assert.equal(messages.at(-1).content,candidate)
  assert.equal(archived[0].message[0].text,candidate)
  assert.equal(enhanced[0][2],candidate)
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

test('professional permission and operation explanations reach final history intact',async()=>{
 const cases=[
  {
    "raw": "认真问：已经断电放凉了，外面也看不到烧痕，味道散了。那我能开机测一下吗？",
    "candidate": "还是别开机。冒烟加焦糊味说明出现过异常，外面看不到烧痕、味道散了，只说明没观察到现象，不能排除里面有元件出问题——具体哪里坏、坏到什么程度，光靠这些判断不了，贸然通电有可能让损坏扩大。\n\n保持断电，送修或找专业人员检测，让他们确认可以开机了再开。忍一下，别省这一步。",
    "history": [
      {
        "role": "user",
        "userId": "2",
        "text": "认真问：我的台式机刚才有焦糊味，机箱后面还冒烟了，我现在该怎么处理？"
      }
    ]
  },
  {
    "raw": "那我能先开机试一下吗？",
    "candidate": "不能。开机就是重新通电，而电源位置的焦糊味还没被专业检测排除异常，再通电可能扩大损坏甚至有起火风险。\n\n先送去检修，等维修方明确说这台机器检测通过、可以正常使用了，再开机。",
    "history": [
      {
        "role": "user",
        "userId": "2",
        "text": "电脑电源那里有焦糊味，已经拔电了。别开玩笑，能怎么办？"
      }
    ]
  }
]
 for(const item of cases){
  const {api,event,host,archived,enhanced}=fixture(),sent=[],messages=[]
  const interactionContext=buildTurnInteractionContext({rawUserText:item.raw,botId:'99',speaker:{userId:'2'}})
  interactionContext.diagnosticContext=buildDiagnosticContext({rawUserText:item.raw,speakerId:'2',history:item.history})
  let repairs=0
  host.retryRequest=async()=>{repairs++;throw Error('scoped professional permission must not regenerate')}
  host.sendSegmentedMessage=async(_e,text)=>{sent.push(text);return 'scoped-operation'}
  await api.handleTextResponse(host,item.candidate,event,{interactionContext},messages)
  assert.equal(repairs,0,item.candidate)
  assert.deepEqual(sent,[item.candidate])
  assert.equal(messages.at(-1).content,item.candidate)
  assert.equal(archived[0].message[0].text,item.candidate)
  assert.equal(enhanced[0][2],item.candidate)
 }
})
