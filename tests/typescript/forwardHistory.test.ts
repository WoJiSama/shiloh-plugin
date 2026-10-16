import test from 'node:test'
import type {TestContext} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createArchiveManagerClass} from '../../src/modules/messaging/infrastructure/messageArchive.js'
import {createMessageManagerClass} from '../../src/modules/messaging/application/recentMessages.js'
import {createMessagePipelineClass} from '../../src/modules/messaging/infrastructure/messagePipeline.js'
import {createEventEnvelope, envelopeToRuntimeEvent} from '../../src/modules/messaging/infrastructure/eventEnvelope.js'
import {RedisJobStore} from '../../src/modules/messaging/infrastructure/redisJobStore.js'
import {KeyedSerialQueue} from '../../src/modules/messaging/infrastructure/keyedSerialQueue.js'
import {collectForwardContext, extractForwardIdsFromSegments} from '../../src/modules/conversation/infrastructure/groupContextResolver.js'
import {createPipelineForwardResolver} from '../../src/adapters/pipelineForwardContext.js'
import {parseForwardCompleteness} from '../../src/modules/conversation/domain/forwardCompleteness.js'
import {safeTruncateUnicode} from '../../src/modules/models/domain/unicodeText.js'
import type {EventJob, MessageSegment} from '../../src/contracts/pipeline.js'
import type {MessageEvent, RecentMessagePorts} from '../../src/contracts/recentMessages.js'
import type {PipelineOptions, PipelinePorts} from '../../src/contracts/messagePipeline.js'

const passthrough = async (message:MessageSegment[] = []) => message
function fixture(t:TestContext) {
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'forward-history-'))
 t.after(()=>fs.rmSync(cwd,{recursive:true,force:true}))
 const configDir=path.join(cwd,'plugins/shiloh-plugin/config')
 fs.mkdirSync(configDir,{recursive:true})
 fs.writeFileSync(path.join(configDir,'message.yaml'),'pluginSettings:\n  messageArchive:\n    enabled: true\n    retentionDays: 365000\n')
 const Archive = createArchiveManagerClass({
  getMentionTargetId:value=>(value as {qq?:unknown}).qq, safeTruncateUnicode,
  enrichBilibiliMessageSegments:passthrough,enrichDouyinMessageSegments:passthrough,enrichYoutubeMessageSegments:passthrough,enrichPixivMessageSegments:passthrough,
  formatBilibiliHistoryLinks:()=>'',formatBilibiliHistoryText:()=>'',formatDouyinHistoryLinks:()=>'',formatDouyinHistoryText:()=>'',
  formatYoutubeHistoryLinks:()=>'',formatYoutubeHistoryText:()=>'',formatPixivHistoryLinks:()=>'',formatPixivHistoryText:()=>'',qqFaceText:()=>'',queue:new KeyedSerialQueue()
 })
 const archive=new Archive({cwd,logger:{warn(){}}}), data=new Map<string,string>()
 const ports:RecentMessagePorts={
  redis:{get:async key=>data.get(key)||null,set:async(key,value)=>{data.set(key,value)},del:async(...keys)=>{keys.forEach(key=>data.delete(key))},keys:async()=>[...data.keys()]},
  bot:{uin:1,nickname:'bot'},logger:{info(){},warn(){},error(){}},queue:new KeyedSerialQueue(),scheduleJob(){},getUrl:async()=>({headers:{}}),
  formatTime:time=>new Date(time).toISOString(),parseTime:time=>Date.parse(time),refreshTencentImageUrl:async url=>url,
  enrichBilibiliMessageSegments:async value=>value||[],enrichDouyinMessageSegments:async value=>value||[],
  formatBilibiliHistoryText:()=>'',formatBilibiliHistoryLinks:()=>'',formatDouyinHistoryText:()=>'',formatDouyinHistoryLinks:()=>''
 }
 const Recent=createMessageManagerClass(ports), recent=new Recent()
 const pipelinePorts:PipelinePorts={
  enrichBilibili:passthrough,enrichDouyin:passthrough,enrichYoutube:passthrough,enrichPixiv:passthrough,
  extractBilibiliShareFromSegment:()=>null,extractBilibiliShareFromText:()=>null,extractDouyinShareFromText:()=>null,extractYoutubeShareFromText:()=>null,extractPixivShareFromText:()=>null,
  isResponsibleBot:async()=>true,isFederationSibling:async()=>false,markBotOnline(){},onlineBotList:async()=>['1'],
  createEventEnvelope:(event,postType)=>createEventEnvelope(event as Record<string,unknown>,postType)
 }
 const Pipeline=createMessagePipelineClass(pipelinePorts), store=new RedisJobStore()
 const pipeline=(resolve:PipelineOptions['resolveForwardContext'])=>{
  const instance=new Pipeline({store,recentManager:{recordMessage:(event,options)=>recent.recordMessage(event as unknown as MessageEvent,options)},archiveManager:archive,
   mediaOutbox:{enqueue:async()=>null,recover:async()=>0,stop(){}},...(resolve?{resolveForwardContext:resolve}:{})})
  t.after(()=>instance.stop())
  return instance
 }
 return {cwd,archive,recent,data,store,pipeline}
}
const event=(messageId=1)=>({message_type:'group',post_type:'message',self_id:1,group_id:42,user_id:2,message_id:messageId,time:Math.floor(Date.now()/1000),raw_message:'看看这份记录',sender:{user_id:2,nickname:'user'},message:[{type:'forward',id:'root'}]})

test('partial forward evidence survives the real pipeline, recent JSON and independent archive round trip', async t => {
 const f=fixture(t)
 const context=await collectForwardContext({getForwardMsg:async()=>Array.from({length:81},(_,index)=>({sender:{user_id:9,nickname:'别人'},message:[{type:'text',text:`别人的原话-${index}`}]}))},event().message)
 const pipeline=f.pipeline(async()=>context)
 const envelope=createEventEnvelope(event())
 await f.store.create('event',envelope.eventId,pipeline.createJob(envelope))
 assert.equal(await pipeline.process(envelope.eventId),true)
 const saved=(await f.store.get<EventJob>('event',envelope.eventId))!
 assert.equal(saved.state,'completed')
 assert.deepEqual(saved.envelope.forwardContext?.completeness,context.completeness)
 const recent=(await f.recent.getMessages('group',42))[0]!
 assert.deepEqual(recent.forwardCompleteness,context.completeness)
 assert.equal(recent.raw_message,'看看这份记录')
 assert.equal(recent.forwardCompleteness?.state,'partial')
 const archived=(await f.archive.query({groupId:42}))[0]!
 assert.deepEqual(archived.forwardCompleteness,context.completeness)
 assert.equal(archived.raw_message,'看看这份记录')
 for(const record of [recent,archived]) {
  const segment=(record.message as MessageSegment[]).find(item=>item.type==='forward_context')!
  assert.deepEqual(segment.completeness,context.completeness)
  assert.match(String(segment.text),/^【转发读取范围】部分展开/)
  assert.doesNotMatch(JSON.stringify(segment.forward_nodes),/别人的原话-80/)
 }
})

test('unavailable forward state persists for diagnostics without stopping retry or leaking into completed history', async t => {
 const f=fixture(t)
 let available=false,fetches=0
 const group={getForwardMsg:async()=>{fetches++;if(!available)throw new Error('not ready');return [{message:[{type:'text',text:'ready'}]}]}}
 const resolver=createPipelineForwardResolver({getBot:()=>({pickGroup:()=>group}),extractForwardIdsFromSegments,collectForwardContext:async(_group,message,limits)=>collectForwardContext(group,message,limits)})
 const pipeline=f.pipeline(async envelope=>resolver(envelope)), envelope=createEventEnvelope(event())
 await f.store.create('event',envelope.eventId,pipeline.createJob(envelope))
 assert.equal(await pipeline.process(envelope.eventId),false)
 const failed=(await f.store.get<EventJob>('event',envelope.eventId))!
 assert.equal(failed.state,'retry_wait')
 assert.equal(failed.envelope.forwardContext,undefined)
 assert.equal(failed.envelope.forwardContextFailure?.state,'unavailable')
 assert.deepEqual(parseForwardCompleteness(failed.envelope.forwardContextFailure),failed.envelope.forwardContextFailure)
 assert.equal((await f.recent.getMessages('group',42)).length,0)
 assert.equal((await f.archive.query({groupId:42})).length,0)
 available=true
 await f.store.save('event',envelope.eventId,{...failed,nextRetryAt:0})
 assert.equal(await pipeline.process(envelope.eventId),true)
 const succeeded=(await f.store.get<EventJob>('event',envelope.eventId))!
 assert.equal(fetches,2)
 assert.equal(succeeded.envelope.forwardContext?.completeness?.state,'complete')
 assert.equal(Object.hasOwn(succeeded.envelope,'forwardContextFailure'),false)
 assert.equal((await f.recent.getMessages('group',42)).length,1)
 assert.equal((await f.archive.query({groupId:42})).length,1)
})

test('runtime serialization discloses clipping of deeply nested forward snapshots', async () => {
 const context=await collectForwardContext({getForwardMsg:async(id:string)=>[{message:[{type:'text',text:id},...(id==='root'?[{type:'forward',id:'child'}]:id==='child'?[{type:'forward',id:'grandchild'}]:[])]}]},event().message)
 assert.equal(context.completeness.state,'complete')
 const envelope={...createEventEnvelope(event()),forwardContext:context}
 const runtime=envelopeToRuntimeEvent(envelope,[...envelope.message,{type:'forward_context',text:context.text,forward_nodes:context.forwardNodes,completeness:context.completeness}])
 const top=runtime.forward_context as {completeness:unknown;text:string}
 const segment=runtime.message.at(-1)!
 for(const value of [top,segment]) {
  const completeness=parseForwardCompleteness(value.completeness)!
  assert.equal(completeness.state,'partial')
  assert.equal(completeness.snapshotTruncated,true)
  assert.equal(completeness.processedNodes,3)
  assert.match(String(value.text),/^【转发读取范围】部分展开/)
 }
 assert.doesNotThrow(()=>JSON.stringify(runtime))
})

test('archive stores only detached four-field persona provenance and never invents it for legacy or incoming records', async t => {
 const {archive}=fixture(t)
 const expected={botId:'1',personaId:'first',personaVersion:'v1',personaName:'甲'}
 const source={...expected,systemContent:'private prompt',persona:{providerKey:'private key'}}
 const sent={...event(),sender:{user_id:1,nickname:'bot'},user_id:1,source:'send',personaSource:source}
 const record=archive.buildRecord(sent)
 assert.deepEqual(record.personaSource,expected)
 assert.notEqual(record.personaSource,source)
 source.personaVersion='v2'
 assert.deepEqual(record.personaSource,expected)
 assert.doesNotMatch(JSON.stringify(record),/systemContent|providerKey|private prompt|private key/)
 const invalid:unknown[]=[null,[],{}, {...expected,botId:'2'}, {...expected,botId:1}, {...expected,personaId:''}, {...expected,personaVersion:' '}, {...expected,personaName:''}]
 for(const personaSource of invalid)assert.equal(Object.hasOwn(archive.buildRecord({...sent,personaSource}),'personaSource'),false)
 assert.equal(Object.hasOwn(archive.buildRecord({...sent,source:'receive'}),'personaSource'),false)
 assert.equal(Object.hasOwn(archive.buildRecord(event()),'personaSource'),false)
 const dir=path.join(archive.getBaseDir(),'group','42')
 fs.mkdirSync(dir,{recursive:true})
 const legacy=archive.buildRecord({...event(),user_id:1,sender:{user_id:1,nickname:'bot'},source:'send'})
 const rows=[{...legacy,message_id:1,personaSource:{...expected,systemContent:'do not return'}}, {...legacy,message_id:2},
  ...invalid.map((personaSource,index)=>({...legacy,message_id:10+index,personaSource})), {...legacy,message_id:99,source:'receive',personaSource:expected}]
 fs.writeFileSync(path.join(dir,'2026-10-15.ndjson'),rows.map(value=>JSON.stringify(value)).join('\n'))
 const found=await archive.query({groupId:42,limit:100})
 assert.deepEqual(found.find(item=>item.message_id===1)?.personaSource,expected)
 assert.ok(found.filter(item=>item.message_id!==1).every(item=>!Object.hasOwn(item,'personaSource')))
 assert.doesNotMatch(JSON.stringify(found),/do not return/)
})

test('archive rejects malformed completeness while retaining valid legacy segment metadata on read', async t => {
 const {archive}=fixture(t)
 const context=await collectForwardContext(null,event().message)
 const valid=archive.buildRecord({...event(),message:[{type:'forward_context',text:context.text,completeness:{...context.completeness,rawConfig:'do not return'}}]})
 assert.deepEqual(valid.forwardCompleteness,context.completeness)
 assert.doesNotMatch(JSON.stringify(valid),/rawConfig|do not return/)
 const malformed={...context.completeness,state:'complete',totalExact:true}
 const invalid=archive.buildRecord({...event(),message:[{type:'forward_context',text:'unknown history',completeness:malformed}],forwardCompleteness:malformed})
 assert.equal(Object.hasOwn(invalid,'forwardCompleteness'),false)
 assert.equal(Object.hasOwn(invalid.message[0]!,'completeness'),false)
 const dir=path.join(archive.getBaseDir(),'group','42')
 fs.mkdirSync(dir,{recursive:true})
 const {forwardCompleteness:_top,...legacy}=valid
 const rows=[{...legacy,message_id:1}, {...invalid,message_id:2,forwardCompleteness:malformed,message:[{type:'forward_context',text:'unknown',completeness:malformed}]}]
 fs.writeFileSync(path.join(dir,'2026-10-15.ndjson'),rows.map(value=>JSON.stringify(value)).join('\n'))
 const found=await archive.query({groupId:42})
 assert.deepEqual(found.find(item=>item.message_id===1)?.forwardCompleteness,context.completeness)
 const rejected=found.find(item=>item.message_id===2)!
 assert.equal(Object.hasOwn(rejected,'forwardCompleteness'),false)
 assert.equal(Object.hasOwn(rejected.message![0]!,'completeness'),false)
})
