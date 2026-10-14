import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {EmojiPackManager} from '../dist/backend/modules/emoji/infrastructure/EmojiPackManager.js'
import {createEmojiPackPlugin} from '../dist/backend/modules/emoji/infrastructure/app.js'
import {decodeEmojiItem} from '../dist/backend/modules/emoji/infrastructure/emojiDecoders.js'

async function fixture(){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'emoji-compiled-'))
 const manager=new EmojiPackManager();manager.refreshConfig=()=>{}
 manager.config={...manager.config,enabled:true,useEmbedding:false,dbPath:path.join(directory,'emoji.ndjson'),storeDir:directory}
 return {manager,directory,cleanup:async()=>{if(manager.pendingWriteTimer)clearTimeout(manager.pendingWriteTimer);if(manager.maintenanceTimer)clearInterval(manager.maintenanceTimer);await fs.rm(directory,{recursive:true,force:true})}}
}

test('compiled emoji decoder rejects malformed identity and non-finite vectors',()=>{
 assert.equal(decodeEmojiItem(null),null);assert.equal(decodeEmojiItem({hash:'a'}),null)
 const item=decodeEmojiItem({hash:'a',file:'a.png',tags:['开心',99],embedding:[1,Infinity],usedCount:'2'})
 assert.deepEqual(item.tags,['开心']);assert.equal(item.embedding,null);assert.equal(item.usedCount,2)
})

test('compiled emoji catalog skips malformed persisted rows and selects only existing matching images',async()=>{
 const {manager,directory,cleanup}=await fixture()
 try{
  await fs.writeFile(path.join(directory,'a.png'),'a')
  await fs.writeFile(manager.dbPath,['broken-json',JSON.stringify({hash:'bad'}),JSON.stringify({hash:'a',file:'a.png',tags:['开心'],useCases:['庆祝'],description:'开心庆祝',registeredAt:'2026-01-01'}),JSON.stringify({hash:'b',file:'missing.png',tags:['开心'],useCases:[],description:'开心'})].join('\n'))
  const items=await manager.loadItems(true);assert.equal(items.length,2)
  const chosen=await manager.selectEmoji({tags:['开心'],useCases:['庆祝']},{groupId:1})
  assert.equal(chosen.item.hash,'a');assert.equal(chosen.strategy,'tag_scene')
  assert.equal((await manager.selectEmoji({tags:['哭泣'],query:'哭泣'})).strategy,'no_match')
 }finally{await cleanup()}
})

test('compiled emoji maintenance reports missing/restored assets and preserves untagged items when tagging disabled',async()=>{
 const {manager,directory,cleanup}=await fixture()
 try{
  manager.config.visionTagOnAdd=false
  await manager.saveItems([{hash:'a',file:'a.png',tags:[],useCases:[],description:'',embedding:null,usedCount:0,lastUsedAt:null,registeredAt:'2026-01-01',isBanned:false}])
  assert.equal((await manager.runMaintenance()).markedMissing,1)
  await fs.writeFile(path.join(directory,'a.png'),'image')
  const report=await manager.runMaintenance()
  assert.equal(report.unmarkedRestored,1);assert.equal(report.cleanedUntagged,0);assert.equal(report.total,1)
 }finally{await cleanup()}
})

test('compiled emoji group commands retain master rules and reject too-short delete prefixes without mutation',async()=>{
 let removed=0
 class Host{constructor(options){this.options=options}}
 const Plugin=createEmojiPackPlugin(Host,{manager:{removeByHashPrefix:async()=>{removed++;return {removed:1}}},takeImages:async()=>[],makeForwardMsg:async()=>null,image:file=>file})
 const plugin=new Plugin(),replies=[]
 assert.equal(plugin.options.rule.length,11)
 assert.ok(plugin.options.rule.every(rule=>rule.permission==='master'))
 await plugin.deleteEmoji({msg:'#表情包删除 ab',reply:async text=>replies.push(text)})
 assert.equal(removed,0);assert.match(replies[0],/至少 4 位/)
 await plugin.deleteEmoji({msg:'#表情包删除 abcd',reply:async text=>replies.push(text)})
 assert.equal(removed,1);assert.match(replies[1],/已删除 1 张/)
})
