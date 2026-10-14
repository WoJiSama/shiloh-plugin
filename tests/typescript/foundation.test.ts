import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, rm, writeFile, readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {createSingleFlightResolver} from '../../src/modules/foundation/infrastructure/singleFlightResolver.js'
import {withFileLock} from '../../src/modules/foundation/infrastructure/fileLock.js'
import {removeToolPromptsFromMessages} from '../../src/modules/foundation/domain/textUtils.js'

test('single flight deduplicates pending work and expires cache before lookup', async () => {
 let now=0, calls=0
 const resolve=createSingleFlightResolver(async (value:string) => {calls++;return value}, {ttlMs:10,now:()=>now})
 const first=resolve('key','one')
 assert.equal(resolve('key','two'),first)
 assert.equal(await first,'one')
 now=11
 assert.equal(await resolve('key','two'),'two')
 assert.equal(calls,2)
})
test('single flight failures retry and distinct keys execute serially',async()=>{
 let active=0, peak=0, calls=0
 const resolve=createSingleFlightResolver(async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,5));active--;if(++calls===1)throw Error('first');return calls})
 const first=resolve('a'); const second=resolve('b')
 await assert.rejects(first,/first/);assert.equal(await second,2)
 assert.equal(await resolve('a'),3);assert.equal(peak,1)
})
test('file lock releases on error and does not remove another owner token',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'shiloh-lock-'));const lock=path.join(dir,'state.lock')
 try {
 await assert.rejects(withFileLock(lock,async()=>{throw Error('work failed')}),/work failed/)
 assert.equal(await withFileLock(lock,async()=>42),42)
 await withFileLock(lock,async()=>{await writeFile(lock,'new-owner')})
 assert.equal(await readFile(lock,'utf8'),'new-owner')
 await assert.rejects(withFileLock(lock,async()=>0,{timeoutMs:0}),/另一个进程/)
 }finally{await rm(dir,{recursive:true,force:true})}
})
test('tool prompt removal preserves multimodal messages and unrelated sections',()=>{
 const multimodal={role:'system',content:[{type:'text',text:'hello'}]}
 assert.equal(removeToolPromptsFromMessages([multimodal])[0],multimodal)
 assert.equal(removeToolPromptsFromMessages([{role:'system',content:'前文\n【可用工具】\nsecret\n【角色】\nname'}])[0]?.content,'前文\n【角色】\nname')
})

test('proxy fetch without proxy consumes local HTTP response and propagates callback error', async()=>{
 const {createServer}=await import('node:http')
 const {fetchWithProxy,resetProxiedFetchPool}=await import('../../src/modules/foundation/infrastructure/proxiedFetch.js')
 const server=createServer((_request,response)=>{response.writeHead(200,{'Content-Type':'application/json'});response.end('{"ok":true}')})
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 try{
 const address=server.address();if(!address||typeof address==='string')throw Error('missing address')
 const url=`http://127.0.0.1:${address.port}/`
 assert.deepEqual(await fetchWithProxy(url,{},res=>res.json()),{ok:true})
 await assert.rejects(fetchWithProxy(url,{},async res=>{await res.text();throw Error('consumer failed')}),/consumer failed/)
 }finally{resetProxiedFetchPool();server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
})
