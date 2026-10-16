import test from 'node:test'
import assert from 'node:assert/strict'
import {createReminderRuntime} from '../dist/backend/modules/qqTools/infrastructure/ReminderTool.js'
const prefix='bl-chat:reminder:'
function setup(send=async()=>({message_id:'1'})){
 const data=new Map(),calls=[],logger={warn(){},error(){},info(){},debug(){}}
 const redis={get:async k=>data.get(k)||null,set:async(k,v,opts)=>{if(opts?.NX&&data.has(k))return null;data.set(k,v);return 'OK'},del:async k=>data.delete(k),eval:async(_s,{keys,arguments:args})=>{if(data.get(keys[0])===args[0])data.delete(keys[0])}}
 const bot={uin:'200',sendApi:async(...args)=>{calls.push(args);return send(...args)}}
 const runtime=createReminderRuntime({redis,logger,getBot:id=>!id||id==='200'?bot:undefined,mcpManager:{isMCPTool:()=>false,executeToolByAlias:async()=>{}}})
 const tool=new runtime.ReminderTool();return {data,calls,bot,redis,...runtime,tool}
}
function seed(r,id='one',extra={}){r.data.set(prefix+'pending:list',JSON.stringify([{id,trigger_time:1}]));r.data.set(prefix+'detail:'+id,JSON.stringify({id,user_id:'10',group_id:'20',bot_id:'200',message_id:null,content:'fixture',reminder_message:null,trigger_time:1,created_at:1,status:'pending',extra_action:null,retry_count:0,...extra}))}
test('compiled reminder keeps Beijing time and distinct IDs',()=>{const r=setup();assert.equal(r.tool.formatTime(Date.parse('2026-06-29T14:57:07Z')),'6月29日 22:57:07');assert.equal(r.tool.parseTime('2026-06-29T22:57:07'),Date.parse('2026-06-29T14:57:07Z'));assert.notEqual(r.tool.generateId('u'),r.tool.generateId('u'))})
test('compiled reminder persists event bot and enforces cancellation owner',async()=>{const r=setup();const reply=await r.tool.createReminder({user_id:'10',bot:r.bot},new Date(Date.now()+100000).toISOString(),'test','');assert.match(reply,/提醒已创建/);const pending=JSON.parse(r.data.get(prefix+'pending:list'));const stored=JSON.parse(r.data.get(prefix+'detail:'+pending[0].id));assert.equal(stored.bot_id,'200');assert.match(await r.tool.cancelReminder({user_id:'other'},stored.id),/只能取消自己的/);assert.ok(r.data.has(prefix+'detail:'+stored.id))})
test('compiled reminder uncertain delivery never retries or runs extra action twice',async()=>{for(const send of [async()=>undefined,async()=>{throw Error('lost')}]){const r=setup(send);seed(r);await r.checkPendingReminders({});await r.checkPendingReminders({});assert.equal(r.calls.length,1);assert.equal(JSON.parse(r.data.get(prefix+'detail:one')).status,'unknown')}})
test('compiled reminder retries only explicit rejection and uses original bot',async()=>{const r=setup(async()=>({retcode:100,status:'failed'}));seed(r);await r.checkPendingReminders({});assert.equal(r.calls[0][0],'send_group_msg');assert.equal(JSON.parse(r.data.get(prefix+'detail:one')).retry_count,1);assert.equal(JSON.parse(r.data.get(prefix+'pending:list')).length,1)})
test('compiled reminder refuses corrupted pending index without overwriting it',async()=>{const r=setup();r.data.set(prefix+'pending:list','{"broken":true}');await r.checkPendingReminders({});assert.equal(r.data.get(prefix+'pending:list'),'{"broken":true}');assert.equal(r.calls.length,0)})

test('registered reminder facts require exact bot, conversation, requester and both durable records',async()=>{
 const r=setup(),e={user_id:'10',group_id:'20',self_id:'200',message_id:'original',bot:r.bot}
 await r.tool.createReminder(e,new Date(Date.now()+100000).toISOString(),'fixture','')
 const own=await r.tool.getActionFacts(e);assert.equal(own.tasks.length,1);assert.equal(own.tasks[0].followUp.state,'registered')
 for(const other of [{...e,self_id:'201'},{...e,group_id:'21'},{...e,group_id:null},{...e,user_id:'11'}])assert.equal((await r.tool.getActionFacts(other)).tasks.length,0)
 assert.equal((await r.tool.getActionFacts(e,{referenceMessageId:'missing'})).tasks.length,0)
 r.data.set(prefix+'pending:list','[]')
 assert.notEqual((await r.tool.getActionFacts(e)).tasks[0]?.followUp.state,'registered')
})

test('reminder receipts remain queryable after leaving the pending queue and unknown deliveries are not retried',async()=>{
 for(const [send,state]of [[async()=>({retcode:0,data:{message_id:'sent-id'}}),'sent'],[async()=>({retcode:0}),'unknown'],[async()=>{throw Error('unknown send')},'unknown']]){
  const r=setup(send),e={user_id:'10',group_id:'20',self_id:'200',message_id:'original',bot:r.bot}
  await r.tool.createReminder(e,new Date(Date.now()+100000).toISOString(),'fixture','')
  const [pending]=JSON.parse(r.data.get(prefix+'pending:list')),key=prefix+'detail:'+pending.id
  r.data.set(key,JSON.stringify({...JSON.parse(r.data.get(key)),trigger_time:1}))
  r.data.set(prefix+'pending:list',JSON.stringify([{id:pending.id,trigger_time:1}]))
  await r.checkPendingReminders({});await r.checkPendingReminders({});assert.equal(r.calls.length,1)
  const facts=await r.tool.getActionFacts(e,{referenceMessageId:'original'})
  assert.equal(facts.tasks[0].delivery.state,state)
  assert.notEqual(facts.tasks[0].followUp.state,'registered')
  if(state==='sent')assert.equal(facts.tasks[0].delivery.messageId,'sent-id')
 }
})

test('cancelled or half-created reminder never authorizes a future-send statement',async()=>{
 const r=setup(),e={user_id:'10',group_id:'20',self_id:'200',message_id:'original',bot:r.bot}
 await r.tool.createReminder(e,new Date(Date.now()+100000).toISOString(),'fixture','')
 const [pending]=JSON.parse(r.data.get(prefix+'pending:list'))
 assert.match(await r.tool.cancelReminder(e,pending.id),/已取消/)
 assert.equal((await r.tool.getActionFacts(e)).tasks.length,0)
 seed(r,'orphan',{trigger_time:Date.now()+100000,status:'pending',message_id:'original'})
 r.data.set(prefix+'pending:list','[]')
 assert.equal((await r.tool.getActionFacts(e)).tasks.length,0)
})

test('one corrupt reminder detail preserves independently verified own facts',async()=>{
 const r=setup(),e={user_id:'10',group_id:'20',self_id:'200',message_id:'original',bot:r.bot}
 await r.tool.createReminder(e,new Date(Date.now()+100000).toISOString(),'fixture','')
 const pending=JSON.parse(r.data.get(prefix+'pending:list'))
 r.data.set(prefix+'pending:list',JSON.stringify([...pending,{id:'broken-other',trigger_time:1}]))
 r.data.set(prefix+'detail:broken-other','invalid json')
 const facts=await r.tool.getActionFacts(e)
 assert.equal(facts.lookup,'unavailable');assert.equal(facts.tasks.length,1)
 assert.equal(facts.tasks[0].requestMessageId,'original');assert.equal(facts.tasks[0].followUp.state,'registered')
 r.data.set(prefix+'pending:list','invalid json')
 const partial=await r.tool.getActionFacts(e)
 assert.equal(partial.lookup,'unavailable');assert.equal(partial.tasks.length,1)
 assert.notEqual(partial.tasks[0].followUp.state,'registered')
 assert.equal(r.calls.length,0)
})

test('reminder facts have a query deadline and preserve completed independent reads',async()=>{
 const r=setup(),e={user_id:'10',group_id:'20',self_id:'200',message_id:'original',bot:r.bot}
 await r.tool.createReminder(e,new Date(Date.now()+100000).toISOString(),'fixture','')
 const pending=JSON.parse(r.data.get(prefix+'pending:list'))
 r.data.set(prefix+'pending:list',JSON.stringify([...pending,{id:'hanging-other',trigger_time:1}]))
 const get=r.redis.get
 r.redis.get=async key=>key===prefix+'detail:hanging-other'?new Promise(()=>{}):get(key)
 const started=Date.now(),facts=await r.tool.getActionFacts(e)
 assert.ok(Date.now()-started<4000)
 assert.equal(facts.lookup,'unavailable');assert.equal(facts.tasks.length,1)
 assert.equal(facts.tasks[0].followUp.state,'registered');assert.equal(r.calls.length,0)
})
