import test from 'node:test'
import assert from 'node:assert/strict'
import {createRedisUtilities} from '../../src/modules/shared/infrastructure/redisUtilities.js'

test('Redis utility update ignores missing and malformed object shapes',async()=>{
 let value:string|null=null,writes=0
 const api=createRedisUtilities(()=>({exists:async()=>value!==null,get:async()=>value,set:async(_key,next)=>{value=next;writes++},del:async()=>1,keys:async()=>[],expire:async()=>1,ttl:async()=>10}))
 await api.redisExistAndUpdateObject('key','field','new');assert.equal(writes,0)
 value='[]';await api.redisExistAndUpdateObject('key','field','new');assert.equal(writes,0)
 value='{"field":"old"}';await api.redisExistAndUpdateObject('key','field','new');assert.deepEqual(await api.redisGetKey('key'),{field:'new'})
})
