import test from 'node:test'
import assert from 'node:assert/strict'
import {createMessageFormatting} from '../dist/backend/modules/conversation/application/messageFormatting.js'
const api=createMessageFormatting({botId:()=>99,error(){}})
const host={formatTime:()=> '[time]',resolveForwardPromptFromSegments:async()=>''}
test('message formatting decodes quoted segments and writes context to the original event',async()=>{
  const event={message_id:{bad:true},getReply:async()=>({sender:{user_id:2,nickname:'成员'},message_id:123,message:[null,'引用文字',{type:'video',url:'https://example.com/v.mp4'}]})}
  const output=await api.buildMessageContent(host,{user_id:1,nickname:'发送者'},'看一下',[],[],undefined,event)
  assert.match(output,/引用文字/)
  assert.match(output,/https:\/\/example.com\/v.mp4/)
  assert.doesNotMatch(output,/\[object Object\]/)
  assert.equal(event._quotedPromptContext.messageId,'123')
  assert.match(event._quotedPromptContext.mediaSummary,/视频/)
})
test('message formatting tolerates malformed cached assets and quote payload',async()=>{
  const event={message_id:456,_groupContextAssets:123,getReply:async()=>({sender:{nickname:99},message:42,message_id:{bad:true}})}
  const output=await api.buildMessageContent(host,{user_id:1,nickname:'发送者'},'你好',[],[],undefined,event)
  assert.match(output,/消息ID:456/)
  assert.doesNotMatch(output,/\[object Object\]/)
})
