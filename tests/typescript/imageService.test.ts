import test from 'node:test'
import assert from 'node:assert/strict'
import { createImageService } from '../../src/modules/image/application/imageService.js'
import type { ImageServicePorts } from '../../src/contracts/imageService.js'
const candidate={apiUrl:'https://fixture.invalid',apiKey:'fixture',model:'gpt-image-2',name:'primary'}
function fixture(fetcher:typeof fetch) {
 const ports:ImageServicePorts={fetch:fetcher,loadReference:async()=> 'data:image/png;base64,AQ==',encodeMultipart:async()=>({headers:{},body:'multipart'}),resolveImage:async image=>{if(image==='broken')throw new Error('invalid image');return new Uint8Array([1])},metadata:async()=>({width:900,height:1600})}
 return createImageService(ports)
}
test('multi-image generation uses count and validates each image before success',async()=>{
 let payload:Record<string,unknown>={}
 const service=fixture(async(_url,options)=>{payload=JSON.parse(String(options?.body));return new Response(JSON.stringify({data:[{url:'a'},{b64_json:'AQ=='}]}))})
 const result=await service.run([candidate],{operation:'generate',prompt:'draw',count:2,quality:'high'})
 assert.equal(payload.n,2);assert.equal(payload.quality,'high');assert.equal(result.images.length,2);assert.ok(result.images[0] instanceof Uint8Array);assert.equal(result.attempts.length,1)
})
test('invalid candidate resource triggers next provider and preserves attempt evidence',async()=>{
 let calls=0
 const service=fixture(async()=>new Response(JSON.stringify({data:[{url:++calls===1?'broken':'valid'}]})))
 const result=await service.run([candidate,{...candidate,name:'fallback'}],{operation:'generate',prompt:'draw'})
 assert.equal(calls,2);assert.equal(result.attempts[0]?.ok,false);assert.equal(result.attempts[1]?.ok,true)
})
test('image edit serializes references and Gemini chat path preserves native image result',async()=>{
 let calls=0
 const service=fixture(async()=>{calls++;return new Response(JSON.stringify(calls===1?{data:[{url:'edited'}]}:{choices:[{message:{images:[{image_url:{url:'gemini-result'}}]}}]}))})
 assert.equal((await service.run([candidate],{operation:'edit',prompt:'edit',images:['reference']})).images.length,1)
 assert.equal(await service.chat({},'draw',['reference']),'gemini-result')
})
test('external cancellation propagates without provider fallback',async()=>{
 const controller=new AbortController(),reason=new Error('stop');let calls=0
 const service=fixture(async()=>{calls++;controller.abort(reason);throw reason})
 await assert.rejects(service.run([candidate,candidate],{operation:'generate',prompt:'draw',signal:controller.signal}),/已取消/)
 assert.equal(calls,1)
})
test('empty 204 response is classified as empty image rather than response construction failure',async()=>{
 const service=fixture(async()=>new Response(null,{status:204}))
 await assert.rejects(service.run([candidate],{operation:'generate',prompt:'draw'}),/未接收到有效图片/)
})
test('multipart reference conversion receives cancellation signal',async()=>{
 const controller=new AbortController();let received:AbortSignal|undefined
 const service=createImageService({fetch:async()=>new Response(JSON.stringify({data:[{url:'ok'}]})),loadReference:async(_url,signal)=>{received=signal;return 'data:image/png;base64,AQ=='},encodeMultipart:async()=>({headers:{},body:'multipart'}),resolveImage:async()=>new Uint8Array([1]),metadata:async()=>({width:1,height:1})})
 await service.run([candidate],{operation:'edit',prompt:'draw',images:['reference'],signal:controller.signal})
 assert.equal(received,controller.signal)
})
