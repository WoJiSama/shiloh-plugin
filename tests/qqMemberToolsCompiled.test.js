import test from 'node:test'
import assert from 'node:assert/strict'
import {createMemberInfoTool} from '../dist/backend/modules/qqTools/infrastructure/MemberInfoTool.js'
import {createMentionMembersTool} from '../dist/backend/modules/qqTools/infrastructure/MentionMembersTool.js'
import {createMentionAdminsTool} from '../dist/backend/modules/qqTools/infrastructure/MentionAdminsTool.js'
import {createReactionTool} from '../dist/backend/modules/qqTools/infrastructure/ReactionTool.js'
import {createRecallTool} from '../dist/backend/modules/qqTools/infrastructure/RecallTool.js'
import {createChatHistoryTool} from '../dist/backend/modules/qqTools/infrastructure/ChatHistoryTool.js'
import {createQQZoneTool} from '../dist/backend/modules/qqTools/infrastructure/QQZoneTool.js'
test('compiled member query and recall use event bot and preserve source message identity',async()=>{
 const calls=[];const bot={tag:'event',async sendApi(action,params){assert.equal(this.tag,'event');calls.push({action,params});return {status:'ok',data:{user_id:7,nickname:'Name'}}}};const ports={getBot:()=>({sendApi(){throw Error('wrong bot')}})}
 const Member=createMemberInfoTool(ports);const info=await new Member().func({}, {group_id:1,user_id:7,bot});assert.equal(info.success,true);assert.equal(info.data.nickname,'Name')
 const Recall=createRecallTool(ports);const result=await new Recall().func({}, {bot,source:{message_id:'42'}});assert.equal(result.success,true);assert.equal(calls[1].params.message_id,'42')
})
test('compiled member mentions normalize string map keys, preserve ambiguity and actual receipt',async()=>{
 const Tool=createMentionMembersTool();let sends=0;const group={async getMemberMap(){return new Map([['1',{user_id:1,card:'same'}],['2',{user_id:2,card:'same'}]])},async sendMsg(){sends++;return {message_id:'sent'}}};const tool=new Tool()
 assert.match(await tool.func({targets:['same']},{group_id:1,group}),/未找到/);assert.equal(sends,0)
 const result=JSON.parse(await tool.func({targets:['1','1']},{group_id:1,group}));assert.equal(result.count,1);assert.equal(sends,1)
 group.sendMsg=async()=>({status:'failed',retcode:120});assert.match(await tool.func({targets:['1']},{group_id:1,group}),/发送失败/)
 group.sendMsg=async()=>undefined;assert.equal(JSON.parse(await tool.func({targets:['1']},{group_id:1,group})).deliveryState,'unknown')
})
test('compiled admin mentions exclude current bot and owner unless requested',async()=>{
 let sent;const Tool=createMentionAdminsTool();const group={async getMemberMap(){return new Map([[1,{user_id:1,role:'admin'}],[2,{user_id:2,role:'admin'}],[3,{user_id:3,role:'owner'}]])},async sendMsg(message){sent=message;return {message_id:5}}};const result=JSON.parse(await new Tool().func({}, {group_id:1,bot:{uin:1},group}));assert.equal(result.count,1);assert.deepEqual(sent.filter(s=>s.type==='at').map(s=>s.data.qq),['2'])
})
test('compiled reaction and recall reject contradictory failure receipts',async()=>{
 const bot={sendApi:async()=>({status:'ok',retcode:100})};const Reaction=createReactionTool();const result=await new Reaction().func({message_id:'42',count:-2},{group_id:1,bot});assert.equal(result.success,false);assert.equal(result.requested_count,1)
 const Recall=createRecallTool();assert.equal((await new Recall().func({message_id:'42'},{bot})).success,false)
})
test('compiled chat history tolerates primitive events and preserves chronological text',async()=>{
 const Tool=createChatHistoryTool();const tool=new Tool();assert.equal((await tool.func({},null)).status,'unavailable');const history=await tool.func({}, {msg:{historyData:'[new] B: latest\n[old] A: 发送了一张图片'}});assert.equal(history.status,'found');assert.match(history.summary,/A: \[图片\]\nB: latest/)
})
test('compiled qzone rejects missing deletion items and invalid positions without mutation',async()=>{
 let deletes=0;const Tool=createQQZoneTool(()=>({setQzone:async()=>({code:0}),getQzone:async()=>({msglist:[]}),delQzone:async()=>{deletes++;return {subcode:0}}}));const tool=new Tool();assert.match(await tool.func({type:true,pos:-1},{}),/第几个/);assert.match(await tool.func({type:true,pos:1},{}),/未获取/);assert.equal(deletes,0)
})
