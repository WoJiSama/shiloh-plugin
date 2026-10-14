import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createBingImageSearchTool} from '../../src/modules/content/infrastructure/BingImageSearchTool.js'
import {createEmojiSearchTool} from '../../src/modules/content/infrastructure/EmojiSearchTool.js'
import {createSendLocalEmojiTool} from '../../src/modules/content/infrastructure/SendLocalEmojiTool.js'
import {DEFAULT_EMOJI_CONFIG} from '../../src/modules/emoji/infrastructure/EmojiPackManager.js'
import type {EmojiItem,EmojiSelection} from '../../src/contracts/emoji.js'

test('Bing empty or duplicate responses terminate without manufacturing requested count',async()=>{
 let calls=0
 const {BingImageSearchTool}=createBingImageSearchTool({image:url=>url,sleep:async()=>{},fetchImpl:async()=>{calls++;return new Response(JSON.stringify({results:[]}))}})
 assert.deepEqual(await new BingImageSearchTool().searchImages('cat',10),[]);assert.equal(calls,3)
 const duplicate=createBingImageSearchTool({image:url=>url,sleep:async()=>{},fetchImpl:async()=>new Response(JSON.stringify({results:[{imageUrl:'https://example.test/a'},{imageUrl:'javascript:bad'}]}))})
 assert.deepEqual(await new duplicate.BingImageSearchTool().searchImages('cat',10),['https://example.test/a'])
})
test('Duitang repeated pages stop and uncertain first delivery prevents later batches',async()=>{
 let calls=0,sends=0
 const {EmojiSearchTool}=createEmojiSearchTool({image:url=>url,sleep:async()=>{},fetchImpl:async()=>{calls++;return new Response(JSON.stringify({data:{object_list:[{photo:{path:'https://example.test/a'}}]}}))}})
 assert.deepEqual(await new EmojiSearchTool().searchDuitangImages('cat',200),['https://example.test/a']);assert.equal(calls,2)
 const runtime=createEmojiSearchTool({image:url=>url,sleep:async()=>{},fetchImpl:async()=>new Response(null,{headers:{'content-type':'image/png'}}),sendImages:async()=>{sends++;throw new Error('ECONNRESET')}})
 const tool=new runtime.EmojiSearchTool();tool.searchDuitangImages=async()=>Array.from({length:10},(_,i)=>`https://example.test/${i}`)
 assert.match(await tool.func({keyword:'cat',count:10},{}),/已停止后续发送/);assert.equal(sends,1)
})
test('Bing forward success requires actual receipt and is never retried',async()=>{
 let sends=0
 const {BingImageSearchTool}=createBingImageSearchTool({image:url=>url,fetchImpl:async()=>new Response(null,{headers:{'content-type':'image/png'}}),sendForward:async()=>{sends++;return false}})
 const tool=new BingImageSearchTool();tool.searchWallpapers=async()=>['https://example.test/a']
 assert.match(await tool.func({query:'cat',count:1},{}),/未确认/);assert.equal(sends,1)
})
test('local emoji misses guide text and uncertain receipt never marks emoji used',async()=>{
 let selection:EmojiSelection={item:null,strategy:'no_match'},picks=0,sent=0,used=0
 const item:EmojiItem={hash:'test',file:'package.json',tags:['无语'],useCases:[],description:'',embedding:null,usedCount:0,lastUsedAt:null,registeredAt:'',isBanned:false}
 const {SendLocalEmojiTool}=createSendLocalEmojiTool({image:file=>({type:'image',file}),sleep:async()=>{},manager:{config:{...DEFAULT_EMOJI_CONFIG,enabled:true},refreshConfig:()=>{},onCatalogChanged:()=>()=>{},getSelectionVocabularySync:()=>({tags:['无语'],useCases:[]}),checkRateLimit:()=>({allowed:true,count:0,max:3,windowMinutes:1}),selectEmoji:async()=>selection,getAbsoluteFilePath:()=>`${process.cwd()}/package.json`,recordPick:()=>{picks++},recordSend:()=>{sent++},markUsed:async()=>{used++}}})
 const tool=new SendLocalEmojiTool(),event={group_id:1,reply:async()=>false}
 assert.match(await tool.func({tags:['无语']},event),/^本地.*纯文字回复/)
 selection={item:null,strategy:'empty'};assert.match(await tool.func({tags:['无语']},event),/^本地.*库是空/)
 selection={item,strategy:'test'};assert.match(await tool.func({tags:['无语']},event),/未确认/)
 assert.equal(picks,0);assert.equal(sent,0);assert.equal(used,0)
})
