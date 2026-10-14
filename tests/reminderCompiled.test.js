import test from 'node:test'
import assert from 'node:assert/strict'
import {createReminderRuntime} from '../dist/backend/modules/qqTools/infrastructure/ReminderTool.js'
const prefix='bl-chat:reminder:'
function setup(send=async()=>({message_id:'1'})){
 const data=new Map(),calls=[],logger={warn(){},error(){},info(){},debug(){}}
 const redis={get:async k=>data.get(k)||null,set:async(k,v,opts)=>{if(opts?.NX&&data.has(k))return null;data.set(k,v);return 'OK'},del:async k=>data.delete(k),eval:async(_s,{keys,arguments:args})=>{if(data.get(keys[0])===args[0])data.delete(keys[0])}}
 const bot={uin:'200',sendApi:async(...args)=>{calls.push(args);return send(...args)}}
 const runtime=createReminderRuntime({redis,logger,getBot:id=>!id||id==='200'?bot:undefined,mcpManager:{isMCPTool:()=>false,executeToolByAlias:async()=>{}}})
 const tool=new runtime.ReminderTool();return {data,calls,bot,...runtime,tool}
}
function seed(r,id='one',extra={}){r.data.set(prefix+'pending:list',JSON.stringify([{id,trigger_time:1}]));r.data.set(prefix+'detail:'+id,JSON.stringify({id,user_id:'10',group_id:'20',bot_id:'200',message_id:null,content:'fixture',reminder_message:null,trigger_time:1,created_at:1,status:'pending',extra_action:null,retry_count:0,...extra}))}
test('compiled reminder keeps Beijing time and distinct IDs',()=>{const r=setup();assert.equal(r.tool.formatTime(Date.parse('2026-06-29T14:57:07Z')),'6月29日 22:57:07');assert.equal(r.tool.parseTime('2026-06-29T22:57:07'),Date.parse('2026-06-29T14:57:07Z'));assert.notEqual(r.tool.generateId('u'),r.tool.generateId('u'))})
test('compiled reminder persists event bot and enforces cancellation owner',async()=>{const r=setup();const reply=await r.tool.createReminder({user_id:'10',bot:r.bot},new Date(Date.now()+100000).toISOString(),'test','');assert.match(reply,/提醒已创建/);const pending=JSON.parse(r.data.get(prefix+'pending:list'));const stored=JSON.parse(r.data.get(prefix+'detail:'+pending[0].id));assert.equal(stored.bot_id,'200');assert.match(await r.tool.cancelReminder({user_id:'other'},stored.id),/只能取消自己的/);assert.ok(r.data.has(prefix+'detail:'+stored.id))})
test('compiled reminder uncertain delivery never retries or runs extra action twice',async()=>{for(const send of [async()=>undefined,async()=>{throw Error('lost')}]){const r=setup(send);seed(r);await r.checkPendingReminders({});await r.checkPendingReminders({});assert.equal(r.calls.length,1);assert.equal(JSON.parse(r.data.get(prefix+'detail:one')).status,'unknown')}})
test('compiled reminder retries only explicit rejection and uses original bot',async()=>{const r=setup(async()=>({retcode:100,status:'failed'}));seed(r);await r.checkPendingReminders({});assert.equal(r.calls[0][0],'send_group_msg');assert.equal(JSON.parse(r.data.get(prefix+'detail:one')).retry_count,1);assert.equal(JSON.parse(r.data.get(prefix+'pending:list')).length,1)})
test('compiled reminder refuses corrupted pending index without overwriting it',async()=>{const r=setup();r.data.set(prefix+'pending:list','{"broken":true}');await r.checkPendingReminders({});assert.equal(r.data.get(prefix+'pending:list'),'{"broken":true}');assert.equal(r.calls.length,0)})
