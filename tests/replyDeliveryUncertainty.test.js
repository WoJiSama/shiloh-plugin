import test from 'node:test'
import assert from 'node:assert/strict'
import {replyRenderingFixture} from './helpers/replyRenderingFixture.js'
import {createSmartReply} from '../dist/backend/modules/conversation/application/smartReply.js'

test('unknown transport outcome does not retry segmented text or mentions',async()=>{
 for(const mentions of [false,true]) {
  const {api,host,event}=replyRenderingFixture()
  let attempts=0
  event.reply=async()=>{attempts++;throw Error('socket closed after request')}
  if(mentions){event.group={};host.convertAtInString=async()=>({hasAt:true,msgSegments:['hello']})}
  assert.equal(await api.sendSegmentedMessage(host,event,'hello',0),null)
  assert.equal(attempts,1)
 }
})
test('receipt without message id is counted as unknown without resend',async()=>{
 const failures=[],sends=[]
 const {api,host,event}=replyRenderingFixture({stats:()=>({recordFailure:x=>failures.push(x),recordSend:x=>sends.push(x)})})
 let attempts=0;event.reply=async()=>{attempts++;return {status:'ok'}}
 await api.sendObservedReply(host,event,'hello')
 assert.equal(attempts,1);assert.equal(sends.length,0);assert.equal(failures[0].code,'delivery_unknown')
})
test('smart card permits preparation fallback but never uncertain delivery fallback',async()=>{
 for(const afterSend of [false,true]){
  let attempts=0
  const api=createSmartReply({warn(){},getTextImageTool:async()=>({execute:async(payload,event)=>{if(afterSend)await event.reply('image');throw Error('failed')}})})
  await api.sendSmartReply({reply:async()=>{attempts++;if(afterSend)throw Error('socket closed');return {message_id:1}}},'text',{force:true})
  assert.equal(attempts,1)
 }
})
test('smart reply state advances only after a confirmed receipt',async()=>{
 for(const outcome of ['sent','unknown','throw']){
  const {api,host,event}=replyRenderingFixture()
  const state={lastBotReplyAt:0,lastBotReplyToUserId:null,lastBotReplyKeywords:[]}
  host.config.chatTriggerMode='smart';host.getSmartState=(group,e)=>{assert.equal(e,event);return state}
  event.reply=async()=>{assert.equal(state.lastBotReplyAt,0);if(outcome==='throw')throw Error('socket');return outcome==='sent'?{message_id:1}:null}
  await api.sendSegmentedMessage(host,event,'讨论科学原理',0)
  assert.equal(state.lastBotReplyAt>0,outcome==='sent')
  assert.equal(state.lastBotReplyToUserId,outcome==='sent'?'2':null)
  if(outcome!=='sent')assert.deepEqual(state.lastBotReplyKeywords,[])
 }
})
