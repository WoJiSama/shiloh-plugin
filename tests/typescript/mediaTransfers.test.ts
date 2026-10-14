import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createDouyinMessage} from '../../src/modules/media/infrastructure/douyinMessage.js'
import {extractPlayUrlFromJson,extractNoteImagesFromJson} from '../../src/modules/media/infrastructure/douyinBrowserResolver.js'
import {createTorrentDownloadTool} from '../../src/modules/media/infrastructure/TorrentDownloadTool.js'
import {parseTorrentMetadata,normalizeTorrentDownloadConfig} from '../../src/modules/media/infrastructure/torrentDownload.js'
const logger={info(_m:string){},warn(_m:string){}}
test('douyin enrichment collapses concurrent requests and preserves static failure backoff',async()=>{
 let staticCalls=0,browserCalls=0
 const runtime=createDouyinMessage({browserResolver:async()=>{browserCalls++;return null},logger})
 const options={cacheTtlMs:0,fetchImpl:async()=>{staticCalls++;return new Response('no SSR',{status:503})}}
 const card={type:'douyin',short_url:'https://v.douyin.com/a/'}
 await Promise.all([runtime.enrichDouyinShare(card,options),runtime.enrichDouyinShare(card,options)])
 assert.equal(staticCalls,1);assert.equal(browserCalls,1)
 await runtime.enrichDouyinShare({...card,short_url:'https://v.douyin.com/b/'},options)
 assert.equal(staticCalls,1);assert.equal(browserCalls,2)
})
test('browser JSON extraction terminates cycles and selects only a work gallery',()=>{
 const data:Record<string,unknown>={misc:{images:[{url_list:['https://example.test/ad']}]},item:{aweme_id:'123456',images:[{url_list:['https://example.test/work']}]}};data.self=data
 assert.deepEqual(extractNoteImagesFromJson(data),['https://example.test/work'])
 data.video={play_addr:{url_list:['https://example.test/video.mp4']}}
 assert.equal(extractPlayUrlFromJson(data),'https://example.test/video.mp4')
})
test('torrent metadata parser rejects traversal and malformed integer payloads',()=>{
 assert.throws(()=>parseTorrentMetadata('d4:infod6:lengthi1e4:name2:..ee'),/不安全/)
 assert.throws(()=>parseTorrentMetadata('d4:infod6:lengthi-1e4:name1:aee'),/超出支持范围/)
})
test('torrent listing fallback is restricted to preparation failures, never uncertain sends',async()=>{
 const runtime=createTorrentDownloadTool({cwd:'/tmp',bot:()=>undefined,redis:()=>null,image:path=>path,logger,fileSender:async()=>{},cardRenderer:async()=>'/tmp/card.png',deleteTorrentCard:async()=>{}})
 const tool=new runtime.TorrentDownloadTool({configProvider:()=>normalizeTorrentDownloadConfig({enabled:true})})
 const metadata={name:'folder',files:[{index:1,relativePath:['folder','one'],size:1}],totalBytes:1}
 let sends=0
 await assert.rejects(tool.sendSelectionListing({reply:async()=>{sends++;throw new Error('lost receipt')}},metadata,{}),/lost receipt/)
 assert.equal(sends,1)
 for(const receipt of [undefined,false])await assert.rejects(tool.sendSelectionListing({reply:async()=>{sends++;return receipt}},metadata,{}),/未确认/)
 assert.equal(sends,3)
 tool.cardRenderer=async()=>{throw new Error('render unavailable')}
 await tool.sendSelectionListing({reply:async()=>{sends++}},metadata,{})
 assert.equal(sends,4)
})
test('torrent event decoder preserves bound private file capabilities and sender identity',async()=>{
 const {parseTorrentEvent}=await import('../../src/modules/media/infrastructure/TorrentDownloadTool.js')
 const peer={calls:0,async sendFile(_file:string,_name:string){this.calls++;return true}}
 const event=parseTorrentEvent({reply:async()=>{},friend:peer,group:peer,sender:{user_id:42},_turnId:'turn',bot:{pickFriend:()=>peer}})
 await event.friend?.sendFile?.('/tmp/file','file')
 await event.bot?.pickFriend?.(42).sendFile?.('/tmp/file','file')
 assert.equal(peer.calls,2);assert.equal(event.sender?.user_id,42);assert.equal(event._turnId,'turn')
})
