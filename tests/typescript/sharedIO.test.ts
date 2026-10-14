import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createRequestClient} from '../../src/modules/shared/infrastructure/request.js'
import {createSharedBrowser} from '../../src/modules/shared/infrastructure/sharedBrowser.js'
import {fetchDownloadToFile} from '../../src/modules/shared/infrastructure/parallelDownload.js'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
test('request preserves existing query and headers, encodes false data and returns native buffers',async()=>{
 let url='',body:unknown,content=''
 const client=createRequestClient({fetch:async(input,init)=>{url=String(input);body=init?.body;content=new Headers(init?.headers).get('Content-Type') || '';return new Response('ok')}})
 const result=await client.post('https://example.test/p?existing=1#hash',{params:{new:'a b'},headers:{'content-type':'application/json'},data:false,responseType:'buffer'})
 assert.equal(new URL(url).searchParams.get('existing'),'1');assert.equal(new URL(url).searchParams.get('new'),'a b');assert.equal(body,'false');assert.equal(content,'application/json');assert.deepEqual(result,Buffer.from('ok'))
})
test('request errors preserve original cause and never reference undefined ReplyError',async()=>{
 const failure=new Error('offline'),client=createRequestClient({fetch:async()=>{throw failure}})
 await assert.rejects(client.get('https://example.test'),error=>error instanceof Error&&error.cause===failure&&/offline/.test(error.message))
 await assert.rejects(client.get('https://example.test',{origError:true}),error=>error===failure)
 assert.equal(client.getAgent(),false);assert.equal(client.verifyIsProxy('https://example.test'),false)
})
test('late disconnect from closing browser does not clear replacement browser promise',async()=>{
 class Browser {listener=()=>{};connected=true;isConnected(){return this.connected}on(_event:'disconnected',listener:()=>void){this.listener=listener}async close(){this.connected=false}}
 const instances:Browser[]=[];const runtime=createSharedBrowser(async()=>{const b=new Browser();instances.push(b);return b},1)
 const first=await runtime.getSharedBrowser();runtime.scheduleSharedBrowserClose();await new Promise(resolve=>setTimeout(resolve,10))
 const second=await runtime.getSharedBrowser();first.listener();assert.equal(await runtime.getSharedBrowser(),second);assert.equal(instances.length,2)
 runtime.scheduleSharedBrowserClose()
})
test('single stream download writes bytes and rejects declared oversize payload',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'shared-io-'));try{
 const file=join(dir,'result');await fetchDownloadToFile('https://example.test/a',file,{fetchImpl:async()=>new Response('abc')});assert.equal(await readFile(file,'utf8'),'abc')
 await assert.rejects(fetchDownloadToFile('https://example.test/a',file,{maxBytes:2,fetchImpl:async()=>new Response('abc',{headers:{'content-length':'3'}})}),/安全上限/)
 }finally{await rm(dir,{recursive:true,force:true})}
})
