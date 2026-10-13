import test from 'node:test'
import assert from 'node:assert/strict'
import { createPipelineRuntime } from '../../src/modules/messaging/infrastructure/runtime.js'
import type { RuntimeAssemblyPorts, RuntimeBundle } from '../../src/contracts/pipelineRuntime.js'
function fixture() {
 let installed:RuntimeBundle|null=null,created=0,stopped=0,adminStopped=0,failStart=false
 const store={},gateway={},bot={}
 const ports:RuntimeAssemblyPorts={
  getBot:()=>bot,getRedis:()=>({}),getLogger:()=>({}),getInstalled:()=>installed,setInstalled:value=>{installed=value},
  setPixivFetchProxy:()=>{},getMissingRedisJobCapabilities:()=>[],
  createJobStore:options=>{created++;assert.equal(options.eventTtlSeconds,360*60);assert.equal(options.deliveryTtlSeconds,24*3600);return store},
  createStats:()=>({}),createGateway:()=>gateway,createArtifactStore:options=>{assert.equal(options.maxIdleBytes,512*1024*1024);return{}},
  createOutbox:options=>{assert.equal(options.store,store);assert.equal(options.gateway,gateway);return {stop(){}}},
  createRecent:()=>({}),createPipeline:options=>{assert.equal(options.store,store);assert.equal(options.maxAttempts,5);return{stop(){stopped++},start(value){assert.equal(value,bot);if(failStart)throw new Error('start failed')}}},
  startAdminReport:options=>{assert.equal(options.store,store);return()=>{adminStopped++}},archiveManager:{},getBilibiliAuthCookie:()=>'',resolveForwardContext:async()=>null
 }
 return {ports,runtime:createPipelineRuntime(ports),fail:()=>{failStart=true},counts:()=>({created,stopped,adminStopped})}
}
test('compiled runtime assembly shares store and replaces old lifecycle once',()=>{
 const f=fixture();const first=f.runtime.installMessagePipeline();assert.ok(first.pipeline)
 f.runtime.installMessagePipeline();assert.deepEqual(f.counts(),{created:2,stopped:1,adminStopped:1})
})
test('disabled runtime stops previous runtime without constructing services',()=>{
 const f=fixture();f.runtime.installMessagePipeline()
 const disabled=f.runtime.installMessagePipeline({pluginSettings:{messagePipeline:{enabled:false}}})
 assert.equal(disabled.pipeline,null);assert.deepEqual(f.counts(),{created:1,stopped:1,adminStopped:1})
})
test('failed start cleans created pipeline and admin report and registers unavailable state',()=>{
 const f=fixture();f.fail();const result=f.runtime.installMessagePipeline()
 assert.equal(result.pipeline,null);assert.match(result.unavailableReason!,/start failed/)
 assert.deepEqual(f.counts(),{created:1,stopped:1,adminStopped:1})
 assert.equal(f.runtime.getInstalledMessagePipeline(),result)
})

test('assembly failure disposes allocated resources in reverse order',async()=>{
 const f=fixture(),released:string[]=[]
 f.ports.createStats=()=>({stop(){released.push('stats');return Promise.reject(new Error('cleanup failure'))}})
 f.ports.createArtifactStore=()=>({stop(){released.push('artifact')}})
 f.ports.createOutbox=()=>({stop(){released.push('outbox')}})
 f.ports.createPipeline=()=>{throw new Error('assembly failed')}
 const result=f.runtime.installMessagePipeline()
 assert.match(result.unavailableReason!,/assembly failed/)
 assert.deepEqual(released,['outbox','artifact','stats'])
 await new Promise(resolve=>setImmediate(resolve))
})
test('successful runtime dispose is idempotent and cleans all resources',()=>{
 const f=fixture(),released:string[]=[]
 f.ports.createStats=()=>({stop(){released.push('stats')}})
 f.ports.createArtifactStore=()=>({stop(){released.push('artifact')}})
 f.ports.createOutbox=()=>({stop(){released.push('outbox')}})
 const runtime=f.runtime.installMessagePipeline()
 runtime.dispose?.();runtime.dispose?.()
 assert.deepEqual(released,['outbox','artifact','stats'])
 assert.deepEqual(f.counts(),{created:1,stopped:1,adminStopped:1})
})
