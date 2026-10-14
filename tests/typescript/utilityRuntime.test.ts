import test from 'node:test'
import assert from 'node:assert/strict'
import {createRedisUtilities} from '../../src/modules/shared/infrastructure/redisUtilities.js'
import {createWaitTool} from '../../src/modules/toolSupport/infrastructure/WaitTool.js'

test('Redis utility update ignores missing and malformed object shapes',async()=>{
 let value:string|null=null,writes=0
 const api=createRedisUtilities(()=>({exists:async()=>value!==null,get:async()=>value,set:async(_key,next)=>{value=next;writes++},del:async()=>1,keys:async()=>[],expire:async()=>1,ttl:async()=>10}))
 await api.redisExistAndUpdateObject('key','field','new');assert.equal(writes,0)
 value='[]';await api.redisExistAndUpdateObject('key','field','new');assert.equal(writes,0)
 value='{"field":"old"}';await api.redisExistAndUpdateObject('key','field','new');assert.deepEqual(await api.redisGetKey('key'),{field:'new'})
})
test('wait tool checks current configuration and clamps delay without changing event identity',async()=>{
 const calls:unknown[][]=[];let enabled=false
 const Tool=createWaitTool({getInstance:()=>({config:{chatTriggerMode:'smart',smartTrigger:{waitToolEnabled:enabled}},scheduleWaitReply:(...args)=>calls.push(args)})})
 const tool=new Tool(),event={group_id:'g'}
 assert.match(await tool.func({seconds:100},event),/未启用/)
 enabled=true;assert.match(await tool.func({seconds:100},event),/60 秒/)
 assert.equal(calls[0]?.[0],event);assert.equal(calls.length,1)
})
