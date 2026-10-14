import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {DeltaForceClient,buildObjectValueReportData,formatDailyKeywordResponse,unwrapApiData} from '../dist/backend/modules/games/infrastructure/DeltaForceClient.js'
import {DeltaForceObjectCache,normalizeDeltaForceObjects} from '../dist/backend/modules/games/infrastructure/DeltaForceObjectCache.js'
import {resolveNaturalDeltaForceToolCall} from '../dist/backend/modules/games/domain/deltaForceIntent.js'
test('compiled delta API keeps scalar daily passwords and ignores malformed price rows',()=>{
 assert.equal(formatDailyKeywordResponse({data:'1234'}),'三角洲今日密码\n1234')
 assert.equal(formatDailyKeywordResponse({data:[{mapName:'零号大坝',secret:'1234'}]}),'三角洲今日密码\n零号大坝：1234')
 assert.equal(buildObjectValueReportData({data:{list:[null,42,{objectName:'头盔',latestPrice:123}]}}).rows.length,1)
 assert.deepEqual(unwrapApiData({result:[1,2]}),[1,2])
})
test('compiled delta client surfaces remote error and bounds requests',async()=>{
 const calls=[];const client=new DeltaForceClient({enabled:true,apiBaseUrl:'https://example.test/',apiKey:'fixture'},{fetchImpl:async(url,options)=>{calls.push({url,options});return new Response('{"data":{"list":[]}}')}})
 await client.searchObjectValue({keyword:'头盔',limit:999});assert.match(calls[0].url,/limit=20/);assert.equal(calls[0].options.headers['X-API-Key'],'fixture')
 const failed=new DeltaForceClient(client.config,{fetchImpl:async()=>new Response('{"message":"quota"}',{status:429})});await assert.rejects(failed.getDailyKeyword(),/quota/)
})
test('compiled delta cache coalesces refreshes and persists normalized objects',async()=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'delta-ts-'))
 try{const cachePath=path.join(directory,'cache.json');const cache=new DeltaForceObjectCache({cachePath});let count=0;const client={getObjectList:async()=>{count++;await new Promise(resolve=>setTimeout(resolve,5));return {data:{list:[{objectID:123,objectName:'头盔'}]}}}};await Promise.all([cache.refresh(client),cache.refresh(client)]);assert.equal(count,1);assert.equal(cache.getName(123),'头盔');assert.equal(new DeltaForceObjectCache({cachePath}).getName('123'),'头盔');assert.deepEqual(normalizeDeltaForceObjects(null),[])}finally{await fs.rm(directory,{recursive:true,force:true})}
})
test('compiled delta intent uses injected bot name',()=>{const result=resolveNaturalDeltaForceToolCall('希洛 三角洲 头盔价格走势 最近7天',{botName:'希洛'});assert.equal(result.params.operation,'price_history');assert.equal(result.params.days,7);assert.doesNotMatch(result.params.keyword,/希洛/)})
