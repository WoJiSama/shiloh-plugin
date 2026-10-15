import test from 'node:test'
import assert from 'node:assert/strict'
import {createTaskStatus} from '../dist/backend/modules/conversation/infrastructure/taskStatus.js'
import {BananaTool} from '../dist/backend/modules/toolSupport/infrastructure/BananaTool.js'
import {createGoogleImageEditTool} from '../dist/backend/modules/toolSupport/infrastructure/GoogleImageEditTool.js'
import {sendImageReliably} from '../dist/backend/modules/image/infrastructure/reliableImageSender.js'
const logger={info(){},warn(){},error(){}}
function fixture(rows=new Map(),storeOverrides={}){
 const store={get:async key=>rows.get(key)||null,set:async(key,value)=>{rows.set(key,value);return 'OK'},del:async key=>rows.delete(key),...storeOverrides}
 const api=createTaskStatus({store:()=>store,logger,activeDedupeToolRuns:new Map()})
 const host={TASK_STATUS_PREFIX:'status:',ACTIVE_TOOL_TASK_PREFIX:'active:',config:{},getToolRunKey:(g,u,t)=>`${g}:${u}:${t}`}
 for(const [name,fn] of Object.entries(api))host[name]=(...args)=>fn(host,...args)
 return {host,rows,store}
}
const event=(extra={})=>({self_id:99,group_id:10,user_id:20,message_id:30,reply:async()=>({message_id:40}),...extra})
function fact(extra={}){return {taskId:'job-30',requestMessageId:'30',toolName:'bananaTool',source:'live_job',observedAt:Date.now(),execution:'running',result:'unknown',delivery:{state:'not_attempted'},followUp:{state:'unknown'},...extra}}
async function put(host,e,actionFacts=fact()){await host.saveTaskStatus({event:e,groupId:e.group_id,userId:e.user_id,messageId:e.message_id,status:'',toolName:actionFacts.toolName,actionFacts})}
const query={recentRequestMessageIds:['30']}

test('action facts isolate bot, requester, group and private scopes without migrating legacy status',async()=>{
 const {host}=fixture(),e=event()
 await host.saveTaskStatus({groupId:10,userId:20,messageId:30,status:'tool_success',toolName:'bananaTool'})
 assert.deepEqual((await host.getTurnActionFacts(e,query)).tasks,[])
 await put(host,e)
 assert.equal((await host.getTurnActionFacts(e,query)).tasks.length,1)
 for(const other of [event({self_id:98}),event({group_id:11}),event({user_id:21}),event({group_id:undefined})])assert.equal((await host.getTurnActionFacts(other,query)).tasks.length,0)
 assert.equal((await host.getTurnActionFacts(event({self_id:undefined}),query)).lookup,'unavailable')
 const privateEvent=event({group_id:undefined});await put(host,privateEvent,fact({taskId:'private-job'}))
 assert.equal((await host.getTurnActionFacts(privateEvent,query)).tasks[0].taskId,'private-job')
 assert.equal((await host.getTurnActionFacts(e,query)).tasks[0].taskId,'job-30')
})

test('explicit references are exact and never fall back to a recent task',async()=>{
 const {host}=fixture(),e=event();await put(host,e)
 assert.equal((await host.getTurnActionFacts(e,{referenceMessageId:'missing',recentRequestMessageIds:['30']})).tasks.length,0)
 assert.equal((await host.getTurnActionFacts(e,{referenceMessageId:'30',recentRequestMessageIds:['missing']})).tasks.length,1)
})

test('queued lifecycle facts survive outer generic success and multiple tools remain distinct',async()=>{
 const {host}=fixture(),e=event();await put(host,e,fact({execution:'queued'}))
 await put(host,e,fact({source:'task_record',execution:'completed'}))
 await put(host,e,fact({toolName:'searchInformationTool',source:'task_record',taskId:'search',execution:'completed'}))
 const facts=await host.getTurnActionFacts(e,query)
 assert.equal(facts.tasks.length,2)
 assert.equal(facts.tasks.find(t=>t.toolName==='bananaTool').execution,'queued')
 assert.equal(facts.tasks.find(t=>t.toolName==='bananaTool').result,'unknown')
 assert.equal(facts.tasks.find(t=>t.toolName==='bananaTool').delivery.state,'not_attempted')
})

test('restart, stale active records and expired records cannot authorize current work',async()=>{
 const {host,rows}=fixture(),e=event();await put(host,e)
 const restarted=fixture(rows)
 assert.equal((await restarted.host.getTurnActionFacts(e,query)).tasks[0].execution,'unknown')
 await put(host,e,fact({observedAt:Date.now()-9*60000}))
 assert.equal((await host.getTurnActionFacts(e,query)).tasks[0].execution,'unknown')
 const key=[...rows.keys()].find(key=>key.startsWith('status:v2:'))
 const stored=JSON.parse(rows.get(key));stored.expiresAt=Date.now()-1;rows.set(key,JSON.stringify(stored))
 assert.deepEqual((await host.getTurnActionFacts(e,query)).tasks,[])
})

test('lookup failure is unavailable and malformed sent receipts cannot become task facts',async()=>{
 const {host}=fixture(new Map(),{get:async()=>{throw Error('fixture unavailable')}})
 assert.equal((await host.getTurnActionFacts(event(),query)).lookup,'unavailable')
 const healthy=fixture();await put(healthy.host,event(),fact({delivery:{state:'sent'}}))
 assert.deepEqual((await healthy.host.getTurnActionFacts(event(),query)).tasks,[])
})

test('legacy draw shortcut cannot bypass scope or expiry and never promises unregistered sending',async()=>{
 const {host}=fixture(),sent=[],e=event({message_id:31})
 host.sendObservedReply=async(_e,payload)=>sent.push(payload)
 host.messageManager={getMessages:async()=>[{message_id:30,sender:{user_id:20}}]}
 await host.updateUserToolTaskStatus({groupId:10,userId:20,messageId:30,toolName:'bananaTool',status:'running'})
 assert.equal(await host.handleActiveDrawStatusQuestion(e,'图呢'),false)
 await put(host,event(),fact({execution:'queued'}))
 assert.equal(await host.handleActiveDrawStatusQuestion(e,'图呢'),true)
 assert.doesNotMatch(JSON.stringify(sent),/直接发|出来了|会继续|成图会/)
 assert.equal(await host.handleActiveDrawStatusQuestion({...e,self_id:98},'图呢'),false)
 assert.equal(await host.handleActiveDrawStatusQuestion({...e,reply_id:'missing'},'图呢'),false)
})

function bananaFixture(host){
 const ports={getBridge:()=>host,getRedis:()=>null,getBot:()=>null,normalizeImageUrls:async x=>x,guardReply:x=>x,segment:{image:buffer=>({type:'image',buffer}),at:id=>({type:'at',qq:id})},logger,resolveImageBuffer:async()=>Buffer.from('fixture'),getImageBufferMetadata:async()=>({width:1,height:1,format:'png'}),formatMessageSendFailure:()=> 'explicit rejection',isMessageSendFailed:()=>false,isUrlAvailable:async()=>false,imageService:{}}
 return new BananaTool({},ports)
}

test('actual image send persists terminal product receipt and excludes earlier progress',async()=>{
 const {host}=fixture(),tool=bananaFixture(host),e=event();await tool.recordActionFact(e,{execution:'running'})
 await e.reply('progress')
 assert.equal((await host.getTurnActionFacts(e,query)).tasks[0].delivery.state,'not_attempted')
 await tool.replyImageToRequester(e,'image')
 const actual=(await host.getTurnActionFacts(e,query)).tasks[0]
 assert.equal(actual.execution,'completed');assert.equal(actual.result,'available');assert.deepEqual(actual.delivery,{state:'sent',messageId:'40'})
})

test('image exceptions and unknown receipts stop retries, preserving product separately',async()=>{
 for(const send of [async()=>undefined,async()=>({retcode:0}),async()=>{throw Error('lost receipt')}]){
  const {host}=fixture(),tool=bananaFixture(host);let attempts=0
  const e=event({reply:async payload=>{attempts++;return send(payload)}})
  await assert.rejects(tool.replyImageToRequester(e,'image'))
  const actual=(await host.getTurnActionFacts(e,query)).tasks[0]
  assert.equal(attempts,1);assert.equal(actual.result,'available');assert.equal(actual.delivery.state,'unknown')
 }
})

test('only explicit image rejection allows fallback and a failed status with an id is not sent',async()=>{
 const {host}=fixture(),tool=bananaFixture(host);let attempts=0
 const e=event({reply:async()=>++attempts===1?{status:'failed',retcode:100,message_id:'rejected'}:{message_id:'confirmed'}})
 await tool.replyImageToRequester(e,'image')
 assert.equal(attempts,2);assert.deepEqual((await host.getTurnActionFacts(e,query)).tasks[0].delivery,{state:'sent',messageId:'confirmed'})
})

test('reliable sender requires a message receipt and never retries unknown results',async()=>{
 for(const result of [undefined,{retcode:0},{status:'failed',retcode:100,message_id:'bad'}]){
  let sends=0;await assert.rejects(sendImageReliably({reply:async()=>{sends++;return result}},Buffer.from('fixture'),{buildMessage:x=>x}));assert.equal(sends,1)
 }
 assert.deepEqual(await sendImageReliably({reply:async()=>({message_id:'good'})},Buffer.from('fixture'),{buildMessage:x=>x}),{message_id:'good'})
})

test('image edit separates progress receipts from final delivery and preserves unknown results',async()=>{
 for(const [receipt,state] of [[{message_id:'final'},'sent'],[{retcode:0},'unknown']]){
  const {host,store}=fixture()
  const Tool=createGoogleImageEditTool({loadConfig:()=>({}),normalizeImageUrls:async x=>x,imageLoader:async()=>'',progressReplyFactory:async()=>'',guardReply:x=>x,callApi:async()=>null,logger,getRedis:()=>store,getBridge:()=>host,getBot:()=>null,sendImageReliably:async(e)=>{const result=await e.reply('final image');if(!result?.message_id)throw Error('unknown');return result},mimeTypes:{extension:()=>false,lookup:()=>false}})
  const tool=new Tool();tool.generateConfiguredImageEdit=async()=> 'https://example.invalid/result.png';tool.extractImageUrl=x=>x
  const e=event({reply:async()=>receipt});await tool.recordActionFact(e,{execution:'running'})
  const result=await tool.performImageEdit({prompt:'edit',images:['image']},e,{skipProgressNotice:true})
  const actual=(await host.getTurnActionFacts(e,query)).tasks[0]
  assert.equal(actual.result,'available');assert.equal(actual.delivery.state,state);assert.equal(actual.followUp.state,'none')
  if(state==='sent')assert.equal(result,'图片编辑成功')
 }
})

test('production arbiter preserves image receipt through the real wrapped event',async()=>{
 const {createOutboundArbiter}=await import('../dist/backend/modules/messaging/application/outboundArbiter.js')
 const {host}=fixture(),tool=bananaFixture(host),e=createOutboundArbiter().wrapEvent(event())
 await tool.replyImageToRequester(e,'image')
 assert.deepEqual((await host.getTurnActionFacts(e,query)).tasks[0].delivery,{state:'sent',messageId:'40'})
})

test('a failed terminal persistence invalidates stale running authority in the same process',async()=>{
 const rows=new Map();let rejectWrites=false
 const {host}=fixture(rows,{set:async(key,value)=>{if(rejectWrites)throw Error('write unavailable');rows.set(key,value);return 'OK'}})
 const e=event();await put(host,e)
 rejectWrites=true
 await put(host,e,fact({execution:'completed',result:'available',delivery:{state:'sent',messageId:'40'}}))
 const actual=(await host.getTurnActionFacts(e,query)).tasks[0]
 assert.equal(actual.execution,'unknown')
 assert.notEqual(actual.delivery.state,'sent','a failed persistence must not fabricate a durable receipt')
})

test('a quoted confirmed delivery id resolves only its original task, never an unrelated latest request',async()=>{
 const {host}=fixture(),e=event()
 await put(host,e,fact({execution:'completed',result:'available',delivery:{state:'sent',messageId:'delivery-40'}}))
 await put(host,event({message_id:31}),fact({taskId:'unrelated',requestMessageId:'31',execution:'running'}))
 const facts=await host.getTurnActionFacts(e,{referenceMessageId:'delivery-40',recentRequestMessageIds:['31','30']})
 assert.equal(facts.tasks.length,1);assert.equal(facts.tasks[0].requestMessageId,'30');assert.equal(facts.tasks[0].delivery.messageId,'delivery-40')
 assert.equal((await host.getTurnActionFacts(e,{referenceMessageId:'not-confirmed',recentRequestMessageIds:['31','30']})).tasks.length,0)
})

test('draw shortcut considers the newest twelve requester messages rather than the oldest twelve',async()=>{
 const {host}=fixture(),sent=[]
 host.sendObservedReply=async(_e,payload)=>sent.push(payload)
 host.messageManager={getMessages:async()=>Array.from({length:14},(_,i)=>({message_id:100-i,sender:{user_id:20}}))}
 const e=event({message_id:101})
 await put(host,event({message_id:87}),fact({taskId:'old',requestMessageId:'87',execution:'queued'}))
 assert.equal(await host.handleActiveDrawStatusQuestion(e,'图呢'),false)
 await put(host,event({message_id:100}),fact({taskId:'new',requestMessageId:'100',execution:'queued'}))
 assert.equal(await host.handleActiveDrawStatusQuestion(e,'图呢'),true)
 assert.match(JSON.stringify(sent[0]),/"100"/)
 assert.doesNotMatch(JSON.stringify(sent[0]),/"87"/)
})
