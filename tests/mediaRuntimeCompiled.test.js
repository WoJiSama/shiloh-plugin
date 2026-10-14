import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import {createSendVideos} from '../dist/backend/modules/media/infrastructure/sendvideos.js'
import {BilibiliAPI} from '../dist/backend/modules/media/infrastructure/BilibiliVideoSummary.js'
import {BilibiliParser} from '../dist/backend/modules/media/infrastructure/bilibilivideoanalysis.js'
import {withYoutubeYtDlpAuth} from '../dist/backend/modules/media/infrastructure/youtubeAuth.js'

const result=index=>({url:`https://example.test/${index}`,success:true,text:'video',videoUrl:`https://example.test/${index}.mp4`})
test('compiled sendvideos caps successful deliveries and isolates simultaneous request cleanup',async()=>{
 const directories=[]
 let ready
 const bothStarted=new Promise(resolve=>{ready=resolve})
 let first=true
 const send=createSendVideos({
  parse:async()=>[result(1),result(2),result(3)],video:file=>({type:'video',file}),
  download:async(_url,file,options)=>{
   assert.equal(options.maxBytes,30*1024*1024);assert.equal(options.timeoutMs,40000)
   const dir=path.dirname(file)
   if(!directories.includes(dir)){directories.push(dir);if(directories.length===2)ready()}
   await fs.writeFile(file,'video');await bothStarted
  }
 })
 const seen=[]
 const event={reply:async message=>{seen.push(message.file);assert.equal(await fs.readFile(message.file,'utf8'),'video');if(first){first=false;await new Promise(resolve=>setTimeout(resolve,10))}}}
 await Promise.all([send('a',event),send('b',event)])
 assert.equal(directories.length,2);assert.equal(seen.length,4)
 for(const dir of directories)await assert.rejects(fs.stat(dir),{code:'ENOENT'})
})

test('compiled sendvideos cleans a failed download and continues to the next item',async()=>{
 const files=[],delivered=[]
 const send=createSendVideos({parse:async()=>[result(1),result(2)],video:file=>({type:'video',file}),download:async(url,file)=>{files.push(file);await fs.writeFile(file,'partial');if(url.endsWith('1.mp4'))throw new Error('download failed')}})
 await send('video',{reply:async item=>delivered.push(item)})
 assert.equal(delivered.length,1)
 for(const file of files)await assert.rejects(fs.stat(file),{code:'ENOENT'})
})

test('compiled Bilibili summary decodes provider data and signs deterministic query fields',async()=>{
 const api=new BilibiliAPI('test')
 const summary=await api.formatVideoSummary({data:{model_result:{summary:'概要',outline:[{part_outline:[{timestamp:61,content:'章节'}]}],subtitle:[{part_subtitle:[{start_timestamp:2,content:'弹幕'}]}]}}})
 assert.match(summary,/【视频摘要】\n概要/);assert.match(summary,/01:01 - 章节/);assert.match(summary,/00:02 - 弹幕/)
 assert.equal(await api.formatVideoSummary(null),'暂无视频总结')
 assert.throws(()=>api.generateWbiQuery({bvid:'BV123'}),/WBI/)
 api.wbiKeys={img_key:'a'.repeat(32),sub_key:'b'.repeat(32)}
 const query=api.generateWbiQuery({bvid:'BV123',cid:4})
 assert.match(query,/^bvid=BV123&cid=4&wts=\d+&w_rid=[a-f0-9]{32}$/)
})

test('compiled Bilibili parser consumes valid provider data without leaking unknown object fields',async()=>{
 const parser=new BilibiliParser(async url=>({url,headers:{getSetCookie:()=>['session=test; Secure']},json:async()=>url.includes('conclusion')?{data:{model_result:{summary:'摘要'}}}:url.includes('player/playurl')?{code:0,data:{durl:[{url:'https://media.test/video.mp4'}]}}:{code:0,data:{aid:1,cid:2,title:'标题',owner:{mid:3,name:'作者'},desc:'简介',stat:{like:12},duration:65}}}))
 const parsed=await parser.parseVideo('https://www.bilibili.com/video/BV1XAR5YzE9e')
 assert.equal(parsed.videoUrl,'https://media.test/video.mp4');assert.match(parsed.text,/标题/);assert.match(parsed.text,/摘要/)
 await assert.rejects(parser.parseVideo('invalid'),/无效的B站视频链接/)
})

test('compiled YouTube auth removes private credential files when downloader throws',async()=>{
 let directory
 await assert.rejects(withYoutubeYtDlpAuth({cookieHeader:'SID=secret',poToken:'token'},async args=>{
  directory=path.dirname(args[1]);assert.equal((await fs.stat(args[1])).mode&0o777,0o600)
  throw new Error('downloader failure')
 }),/downloader failure/)
 await assert.rejects(fs.stat(directory),{code:'ENOENT'})
})
