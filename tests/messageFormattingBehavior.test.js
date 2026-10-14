import test from 'node:test'
import assert from 'node:assert/strict'
import {createMessageFormatting} from '../dist/backend/modules/conversation/application/messageFormatting.js'
import {extractForwardIdsFromSegments,getReplyTargetUserId,extractReadableTextFromSegments} from '../dist/backend/modules/conversation/domain/messageSegments.js'

test('quoted video remains actionable with sender and URL in formatted context',async()=>{
 const api=createMessageFormatting({botId:()=>99,error(){}})
 const event={getReply:async()=>({sender:{user_id:8,nickname:'quoted user'},message_id:'q',message:[{type:'video',url:'https://example.test/video'}]})}
 const host={resolveForwardPromptFromSegments:async()=>'',formatTime:()=> '[time]'}
 const result=await api.buildMessageContent(host,{user_id:7,nickname:'speaker'},'看这个',[],[],undefined,event)
 assert.match(result,/quoted user.*一段视频\(链接: https:\/\/example.test\/video\)/)
 assert.deepEqual(event._quotedPromptContext,{senderName:'quoted user',messageId:'q',text:'',mediaSummary:'一段视频'})
})
test('forward payload normalization preserves IDs and tolerates malformed payloads',()=>{
 assert.deepEqual(extractForwardIdsFromSegments([{type:'forward',id:'a'},{type:'json',data:JSON.stringify({app:'com.tencent.multimsg',meta:{detail:{resid:'b'}}})},{type:'json',data:'invalid'},{type:'forward',id:'a'}]),['a','b'])
 assert.equal(getReplyTargetUserId(null),undefined)
 assert.equal(getReplyTargetUserId({sender:{user_id:8}}),8)
 assert.equal(extractReadableTextFromSegments([{type:'text',text:'hello '},{type:'at',qq:8},{type:'image'}]),'hello @8[图片]')
})
