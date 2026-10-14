import test from 'node:test'
import assert from 'node:assert/strict'
import { JinyanTool } from '../functions/functions_tools/JinyanTool.js'
import { PokeTool } from '../functions/functions_tools/PokeTool.js'
import { LikeTool } from '../functions/functions_tools/LikeTool.js'
import { ChangeCardTool } from '../functions/functions_tools/ChangeCardTool.js'
import { SendGiftTool } from '../functions/functions_tools/SendGiftTool.js'
import { GrabRedBagTool } from '../functions/functions_tools/GrabRedBagTool.js'

function fixture(sendApi = async()=>({status:'ok',retcode:0})) {
  const operations=[]
  const group={getMemberMap:async()=>new Map([[10,{user_id:10,role:'admin',nickname:'事件机器人'}],[20,{user_id:20,role:'member',nickname:'目标',shutup_time:0}]]),muteMember:async(id,time)=>{operations.push([id,time]);return true},muteAll:async()=>true,sendMsg:async()=>true}
  const bot={uin:10,sendApi,pickGroup:()=>group}
  return {operations,group,bot,event:{group_id:1,user_id:30,sender:{user_id:30,role:'admin'},bot}}
}
test('mute cannot use model supplied role or selfDecision to bypass event permissions',async()=>{
  const f=fixture(); f.event.sender.role='member'
  const result=await new JinyanTool().func({target:['20'],senderRole:'owner',selfDecision:true},f.event)
  assert.match(result,/无权/);assert.deepEqual(f.operations,[])
})
test('mute uses event bot membership and executes authorized target once',async()=>{
  const f=fixture();const result=await new JinyanTool().func({target:['20'],time:60},f.event)
  assert.equal(result.summary.success,1);assert.deepEqual(f.operations,[[20,60]])
})
test('change card rejects unauthorized edits to another member',async()=>{
  let sends=0;const f=fixture(async()=>{sends++;return {status:'ok'}});f.event.sender.role='member'
  const result=await new ChangeCardTool().func({target:'20',cardName:'新名',senderRole:'owner'},f.event)
  assert.match(result,/只有群主或管理员/);assert.equal(sends,0)
})
test('poke stops on unknown dispatch and never tries another transport or repetition',async()=>{
  const calls=[];const f=fixture(async(action)=>{calls.push(action);if(action==='get_group_member_list')return {status:'ok',data:[{user_id:20,nickname:'目标'}]};throw new Error('timeout after send')})
  const result=await new PokeTool().func({target:['20'],times:3},f.event)
  assert.deepEqual(calls,['get_group_member_list','send_group_poke']);assert.equal(result.success.count,0);assert.match(result.errors[0].error,/未确认/)
})
test('like clamps count and refuses malformed success responses',async()=>{
  const calls=[];const f=fixture(async(action,params)=>{calls.push([action,params]);return {}})
  const result=await new LikeTool().func({qq:'20',count:-3},f.event)
  assert.equal(result.status,'error');assert.deepEqual(calls,[['send_like',{user_id:20,times:1}]])
})
test('like does not fall back to API after friend transport times out',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return {status:'ok'}})
  f.bot.pickFriend=()=>({thumbUp:async()=>{throw new Error('timeout')}})
  const result=await new LikeTool().func({qq:'20'},f.event)
  assert.equal(result.status,'error');assert.equal(calls,0);assert.match(result.error,/未确认/)
})
test('gift rejects explicit failure object and uses event bot',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return {status:'failed',retcode:100}})
  const result=await new SendGiftTool().func({targetQQ:'20',targetNickname:'目标'},f.event)
  assert.match(result,/error:/);assert.equal(calls,1)
})
test('red bag respects explicit cancellation without lookup or send',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return {status:'ok'}})
  assert.match(await new GrabRedBagTool().func({confirm:false},f.event),/取消/);assert.equal(calls,0)
})
test('red bag does not grab after unknown password delivery',async()=>{
  let calls=0;const f=fixture(async()=>{calls++;return {status:'ok'}})
  f.group.sendMsg=async()=>{throw new Error('timeout')}
  f.event.getReply=async()=>({message:[{type:'wallet',data:{title:'口令',red_channel:32}}]})
  assert.match(await new GrabRedBagTool().func({},f.event),/口令发送结果未确认/);assert.equal(calls,0)
})
