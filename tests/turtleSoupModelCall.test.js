import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {modelExecutor} from './helpers/modelExecutor.js'
import {createTurtleSoupModelCall} from '../dist/backend/modules/games/infrastructure/turtleSoup/turtleSoupModelCall.js'

function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'soup-model-call-'))
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}))
  const plugin=path.join(dir,'plugins/shiloh-plugin')
  fs.mkdirSync(path.join(plugin,'config'),{recursive:true})
  const write=(model)=>fs.writeFileSync(path.join(plugin,'config/message.yaml'),JSON.stringify({pluginSettings:{chatAiConfig:{chatApiUrl:'https://models.invalid/v1',chatApiModel:model,chatApiKey:'fixture-key'}}}))
  write('default-model')
  return {dir,plugin,write}
}

test('bot model selection reaches the actual gateway and settings reload from host or plugin roots',async t=>{
  const {dir,plugin,write}=fixture(t),calls=[]
  const {YTapi}=modelExecutor(async(url,init)=>{
    calls.push({url,body:JSON.parse(init.body)})
    return new Response(JSON.stringify({choices:[{message:{content:'valid reply'}}]}))
  })
  const call=createTurtleSoupModelCall({cwd:dir,executeModel:YTapi})
  const messages=[{role:'user',content:'stage prompt'}]
  assert.equal(await call(messages,{model:'writer-model',temperature:0.2}),'valid reply')
  await call(messages,{model:'review-model'})
  write('updated-default')
  await createTurtleSoupModelCall({cwd:plugin,executeModel:YTapi})(messages)
  assert.deepEqual(calls.map(entry=>entry.body.model),['writer-model','review-model','updated-default'])
  assert.equal(calls[0].body.temperature,0.2)
  assert.equal(calls[0].url,'https://models.invalid/v1/chat/completions')
})

test('bot stage cancellation aborts the actual fetch without a backend fallback',async t=>{
  const {dir}=fixture(t),controller=new AbortController(),reason=new Error('stage timed out')
  let calls=0
  const {YTapi}=modelExecutor(async(_url,init)=>{
    calls++
    assert.equal(init.signal,controller.signal)
    controller.abort(reason)
    throw reason
  })
  const call=createTurtleSoupModelCall({cwd:dir,executeModel:YTapi})
  await assert.rejects(()=>call([{role:'user',content:'prompt'}],{signal:controller.signal}),error=>error===reason)
  assert.equal(calls,1)
})
