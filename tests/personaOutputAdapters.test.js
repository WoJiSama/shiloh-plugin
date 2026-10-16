import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {TextImageTool} from '../functions/functions_tools/TextImageTool.js'
import {pluginBridge} from '../utils/pluginBridge.js'
import {createPersonaSnapshot} from '../dist/backend/modules/conversation/infrastructure/personaSnapshot.js'

test('actual card adapter uses the captured persona and guard with inherited conversation identity',async t=>{
 const originalBridge=pluginBridge.instance,originalSegment=globalThis.segment
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'persona-card-adapter-'))
 t.after(async()=>{pluginBridge.instance=originalBridge;globalThis.segment=originalSegment;await fs.rm(directory,{recursive:true,force:true})})
 globalThis.segment={image:file=>({type:'image',file})}
 for(const hasGuard of [true,false]){
  const snapshot=createPersonaSnapshot({botId:99,persona:{name:'甲'},...(hasGuard?{personaGuard:{enabled:true}}:{})})
  pluginBridge.instance={config:{persona:{name:'乙'},personaGuard:{enabled:false}},getPersonaFor:()=>({name:'乙'})}
  const tool=new TextImageTool()
  let rendered,sends=0
  tool.renderChatImage=async({text})=>{rendered=text;const file=path.join(directory,`card-${hasGuard}.png`);await fs.writeFile(file,'fixture');return file}
  const event=Object.assign(Object.create({self_id:99,group_id:1,user_id:2,bot:{uin:99,nickname:'账号别名'}}),{_personaSnapshot:snapshot,msg:'你好',reply:async()=>{sends++;return {message_id:1}}})
  await tool.func({text:'欸，别突然这么叫呀，有点不好意思啦。',template:'chat'},event)
  assert.equal(rendered,'叫我甲就好。')
  assert.equal(sends,1)
 }
})
