import assert from 'node:assert/strict'
import {Readable} from 'node:stream'
import {test} from 'node:test'
import {MediaOutbox} from '../utils/messagePipeline/mediaOutbox.js'
import {RedisJobStore} from '../utils/messagePipeline/redisJobStore.js'
import {buildDouyinArchiveRelaySegments} from '../utils/douyinMediaRelay.js'
import {createFakeRedis} from './helpers/fakeRedis.js'

test('a short Douyin share passes the current outbox and relays as one merged forward',async()=>{
 const previousFetch=globalThis.fetch
 const store=new RedisJobStore({redis:createFakeRedis()})
 const sent=[]
 const outbox=new MediaOutbox({store,logger:{info(){},warn(){}},
  enrichDouyin:async card=>({...card,play_url:'https://video.example/play',duration:16}),
  buildDouyin:buildDouyinArchiveRelaySegments,
  prepareThumbnail:async()=>({file:'base64://dGh1bWI=',cleanup:async()=>{}}),
  gateway:{sendGroupForward:async args=>{sent.push(args);return {retcode:0,messageId:'1'}}}
 })
 outbox.stopped=true
 try {
  globalThis.fetch=async()=>({ok:true,headers:{get:name=>name==='content-length'?'4':null},body:Readable.toWeb(Readable.from(Buffer.from('mp4!')))})
  const job=await outbox.enqueue({envelope:{eventId:'event:1',botId:'3094088525',groupId:'609235590',messageId:'1'},media:{type:'douyin',title:'测试抖音',author:'测试作者',aweme_id:'7661206883327471737',duration:16,page_url:'https://www.iesdouyin.com/share/video/7661206883327471737/',cover_url:'https://cover.example/cover.webp',play_url:'https://video.example/play'}})
  await outbox.process(job.id)
  assert.equal(sent.length,1)
  assert.equal(sent[0].groupId,'609235590')
  assert.equal(sent[0].nodes.length,2)
  assert.match(sent[0].nodes[0].message[0],/抖音视频搬一下/)
  assert.match(sent[0].nodes[1].message[0].file || sent[0].nodes[1].message[0].data?.file || '',/^base64:\/\//)
  assert.equal((await store.get('delivery',job.id)).state,'sent')
 }finally{globalThis.fetch=previousFetch;outbox.stop()}
})
