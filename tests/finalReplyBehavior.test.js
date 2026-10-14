import test from 'node:test'
import assert from 'node:assert/strict'
import {createFinalReply} from '../dist/backend/modules/conversation/application/finalReply.js'
import {createMemoryReplies} from '../dist/backend/modules/conversation/application/memoryReplies.js'
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
