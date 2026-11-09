// 委托记忆 compiled 集成测试:原文保真 / 权限 / 召回 / 上限。
import test from 'node:test'
import assert from 'node:assert/strict'
import {createDelegateMemoryRuntime} from '../dist/backend/modules/memory/infrastructure/delegateMemoryTool.js'

const key='bl-chat:delegated:20'
function setup(){
  const data=new Map(),logs=[]
  const redis={get:async k=>data.get(k)||null,set:async(k,v)=>{data.set(k,v);return 'OK'}}
  const runtime=createDelegateMemoryRuntime({redis,logger:{info:m=>logs.push(String(m)),warn(){},error(){}},loadConfig:()=>({})})
  return {data,logs,redis,...runtime,tool:new runtime.DelegateMemoryTool()}
}
const ev={group_id:20,user_id:10001,isMaster:false,sender:{nickname:'星野'}}

test('remember 存原文;recall 原样返回;群维度共享',async()=>{
  const r=setup()
  assert.match(await r.tool.execute({action:'remember',content:'周五要交报告',due_time:'2026-11-13T18:00:00+08:00'},ev),/记下了/)
  const entries=JSON.parse(r.data.get(key))
  assert.equal(entries.length,1)
  assert.equal(entries[0].content,'周五要交报告','原文锚定:存的就是原话')
  assert.equal(entries[0].owner,'10001')
  assert.equal(entries[0].dueAt,Date.parse('2026-11-13T18:00:00+08:00'))
  // 另一个人也能 recall 到(群维度),但 list 看不到别人的
  const other={...ev,user_id:20002,sender:{nickname:'坤'}}
  const recall=await r.tool.execute({action:'recall',query:'报告'},other)
  assert.match(recall,/周五要交报告/)
  assert.match(recall,/星野/)
  assert.match(await r.tool.execute({action:'list'},other),/还没托付我记过事/)
  assert.match(await r.tool.execute({action:'list'},ev),/周五要交报告/)
})

test('recall 无命中诚实说没有,不编造',async()=>{
  const r=setup()
  await r.tool.execute({action:'remember',content:'周五要交报告'},ev)
  const miss=await r.tool.execute({action:'recall',query:'完全无关的词'},ev)
  assert.match(miss,/没记住过/)
})

test('forget 权限:本人可删,他人不可,群主可以',async()=>{
  const r=setup()
  await r.tool.execute({action:'remember',content:'我的生日是 3 月 3 日'},ev)
  const entries=JSON.parse(r.data.get(key))
  const shortId=entries[0].id.slice(4,14)
  const other={...ev,user_id:20002}
  assert.match(await r.tool.execute({action:'forget',memory_id:shortId},other),/只能忘掉自己托付的/)
  assert.match(await r.tool.execute({action:'forget',memory_id:shortId},{...ev,isMaster:true}),/已忘掉/)
  assert.equal(JSON.parse(r.data.get(key)).length,0)
})

test('上限:每人 20 条封顶(用注入配置压到 2 验证)',async()=>{
  const data=new Map()
  const redis={get:async k=>data.get(k)||null,set:async(k,v)=>{data.set(k,v);return 'OK'}}
  const runtime=createDelegateMemoryRuntime({redis,logger:{warn(){},error(){},info(){}},loadConfig:()=>({maxPerOwner:2,maxPerGroup:50})})
  const tool=new runtime.DelegateMemoryTool()
  assert.match(await tool.execute({action:'remember',content:'第一条'},ev),/记下了/)
  assert.match(await tool.execute({action:'remember',content:'第二条'},ev),/记下了/)
  assert.match(await tool.execute({action:'remember',content:'第三条'},ev),/每人上限 2/)
})

test('群外(私聊)拒绝',async()=>{
  const r=setup()
  assert.match(await r.tool.execute({action:'remember',content:'x'},{...ev,group_id:undefined}),/群维度/)
})
