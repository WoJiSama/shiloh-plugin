import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {createPixivSearch} from '../dist/backend/modules/media/infrastructure/pixivSearch.js'
import {downloadPixivArchiveImage} from '../dist/backend/modules/media/infrastructure/pixivMediaRelay.js'
const item={id:'12345',title:'one',userName:'artist',pageCount:1,xRestrict:0}
function sessions(){return createPixivSearch({getRedis:()=>undefined,getSharedBrowser:async()=>{throw new Error('unused')},scheduleSharedBrowserClose(){}})}
test('compiled Pixiv session separates bot and group/private namespaces',async()=>{
 const search=sessions();await search.savePixivSearchSession({self_id:1,group_id:10},{keyword:'cat',order:'popular',orderSource:'ranking',items:[item]})
 assert.equal(await search.loadPixivSearchSession({self_id:2,group_id:10}),null)
 assert.equal(await search.loadPixivSearchSession({self_id:1,user_id:10}),null)
 assert.equal((await search.loadPixivSearchSession({self_id:1,group_id:10})).orderSource,'ranking')
})
test('compiled Pixiv rejects malformed Redis session instead of trusting it',async()=>{
 const search=sessions();const redis={get:async()=>JSON.stringify({keyword:'cat',order:'newest',savedAt:Date.now(),items:[{id:{evil:1}}]}),set:async()=>{}}
 assert.equal(await search.loadPixivSearchSession({group_id:999},{redis}),null)
})
test('compiled Pixiv removes partial files when download stream fails',async()=>{
 const directory=path.join(os.tmpdir(),'shiloh-plugin-pixiv-archive');await fs.mkdir(directory,{recursive:true});const before=new Set(await fs.readdir(directory));let chunks=0
 const result=await downloadPixivArchiveImage('https://i.pximg.net/test.jpg',{fetchImpl:async()=>new Response(new ReadableStream({pull(controller){if(chunks++===0)controller.enqueue(new Uint8Array([1,2,3]));else controller.error(new Error('connection interrupted'))}}))})
 assert.equal(result,'');assert.deepEqual((await fs.readdir(directory)).filter(file=>!before.has(file)),[])
})
