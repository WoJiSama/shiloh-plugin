import test from 'node:test'
import assert from 'node:assert/strict'
import {createQQApi} from '../dist/backend/modules/platform/infrastructure/QQApi.js'

test('QQ credentials and writes always use the event bot identity',async()=>{
 const calls=[]
 const bot={uin:22,cookies:{'qun.qq.com':'p_skey=abc=def; broken=%ZZ'},sendApi:async(name,params)=>{calls.push({name,params});return {data:{cookies:'event-cookie',token:123}}}}
 const Api=createQQApi({bot:()=>({uin:11,sendApi:async()=>{throw Error('wrong bot')}}),request:{get:async(url,options)=>{calls.push({url,options});return {ok:true}},post:async(url,options)=>{calls.push({url,options});return {ok:true}}}})
 const api=new Api({bot})
 assert.equal(api.getck('qun.qq.com',bot).p_skey,'abc=def')
 assert.equal(api.getck('qun.qq.com',bot).broken,'%ZZ')
 const cookie=api.getck('qun.qq.com',bot,true)[0]
 assert.ok(cookie.expires>Date.now()/1000);assert.ok(cookie.expires<Date.now()/1000+3700)
 await api.setQzone('hello')
 assert.equal(calls[1].options.data.hostuin,22)
 assert.equal(calls[1].options.headers.Cookie,'event-cookie')
})
test('malformed credentials stop before the HTTP request',async()=>{
 let requests=0
 const Api=createQQApi({bot:()=>({}),request:{get:async()=>requests++,post:async()=>requests++}})
 for(const response of [null,{data:{}},{data:{cookies:'',token:1}},{data:{cookies:'secret',token:{}}}]){
  const api=new Api({bot:{uin:22,sendApi:async()=>response}})
  await assert.rejects(()=>api.getQzone(),/凭据响应无效/)
 }
 assert.equal(requests,0)
})
