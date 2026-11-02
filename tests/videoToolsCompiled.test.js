import test from 'node:test'
import assert from 'node:assert/strict'
import {createVideoAnalysisTool} from '../dist/backend/modules/toolSupport/infrastructure/VideoAnalysisTool.js'
import {createSearchVideoTool} from '../dist/backend/modules/toolSupport/infrastructure/SearchVideoTool.js'
const logger={info(){},debug(){},error(){}}
function tool(extra={}){const Tool=createVideoAnalysisTool({loadConfig:()=>({videoAnalysisAiConfig:{videoAnalysisApiKey:'key'}}),getBot:()=>null,logger,...extra});return new Tool()}
test('compiled video analysis collects direct, quoted and forwarded URLs with stable deduplication',async()=>{
 const result=await tool().getVideo({message:[{type:'video',data:{file_url:'https://x/current.mp4'}}],getReply:async()=>({message:[{type:'video',url:'https://x/quoted.mp4'}]}),_groupContextAssets:{videos:[{source:'https://x/current.mp4'},{url:'https://x/forward.mp4'}]}})
 assert.deepEqual(result,['https://x/current.mp4','https://x/quoted.mp4','https://x/forward.mp4'])
})
test('compiled video analysis preserves upstream HTTP failure instead of alleging prohibited content',async()=>{
 const result=await tool({fetch:async()=>new Response('no credits',{status:429})}).func({}, {message:[{type:'video',url:'https://x/a.mp4?token=1'}]})
 assert.match(result.error,/HTTP 429/)
})
test('compiled video upload rejects missing public URL',async()=>{
 await assert.rejects(tool({fetch:async()=>new Response('{}')}).uploadToFreeService(Buffer.from('v'),'key'),/未返回有效URL/)
})
test('compiled video download rejects oversized content before consuming body',async()=>{
 let consumed=false
 const instance=tool({fetch:async()=>({ok:true,status:200,headers:new Headers({'content-length':String(65*1024*1024)}),get body(){consumed=true;throw new Error('should not read')}})})
 await assert.rejects(instance.getVideoUrl('https://x/download','key'),/视频处理失败/);assert.equal(consumed,false)
})
test('compiled video search decodes absent optional counts and removes HTML title markup',async()=>{
 let requests=0;const Tool=createSearchVideoTool({image:x=>x,sendvideos:async()=>{},fetch:async()=>++requests===1?new Response('',{headers:{'set-cookie':'bili=ok; Path=/'}}):new Response(JSON.stringify({data:{result:[{title:'<em>cat</em>',bvid:'BV123',pic:'//i.example/a.jpg',author:'me',pubdate:0}]}}))})
 const result=await new Tool().searchBilibili('cat');assert.match(result,/📺 cat/);assert.match(result,/点赞：0/);assert.match(result,/https:\/\/i.example\/a.jpg/)
})

test('仿真模式只搜不发：不自动回复、不拖视频，结果带分享指引且取相关度首位', async () => {
  const replies = []
  let sendvideosCalls = 0
  let requests = 0
  const Tool = createSearchVideoTool({
    image: x => x,
    sendvideos: async () => { sendvideosCalls += 1 },
    fetch: async () => ++requests === 1
      ? new Response('', { headers: { 'set-cookie': 'bili=ok; Path=/' } })
      : new Response(JSON.stringify({ data: { result: [
        { title: '<em>最相关</em>', bvid: 'BVTop1', pic: '//i.example/top.jpg', author: 'a', pubdate: 0, play: 10, like: 2, duration: '1:00' },
        { title: '次相关', bvid: 'BVTop2', pic: '//i.example/2.jpg', author: 'b', pubdate: 0, play: 5, like: 1, duration: '2:00' }
      ] } })),
  })
  const event = { reply: async s => replies.push(s), simulation: true }
  const out = await new Tool().func({ keyword: 'cat' }, event)
  const result = JSON.stringify(out)
  assert.equal(replies.length, 0, '仿真模式不自动往群里发')
  assert.equal(sendvideosCalls, 0, '仿真模式不自动拖视频')
  assert.ok(result.includes('BVTop1'), '取相关度首位而非随机')
  assert.ok(!result.includes('BVTop2') || result.includes('simShareVideoCard'), '')
  assert.ok(result.includes('simShareVideoCard'), '结果带分享指引')
})
