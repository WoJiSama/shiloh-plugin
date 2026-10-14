import test from 'node:test'
import assert from 'node:assert/strict'
import {createGoogleImageEditTool} from '../dist/backend/modules/toolSupport/infrastructure/GoogleImageEditTool.js'
function fixture(extra={}) {
 const rows=new Map(), sends=[]
 const store={set:async(k,v)=>rows.set(k,v),get:async k=>rows.get(k)||null,del:async k=>rows.delete(k),keys:async()=>[...rows.keys()]}
 const Tool=createGoogleImageEditTool({loadConfig:()=>({}),normalizeImageUrls:async x=>x,imageLoader:async()=>'',progressReplyFactory:async()=>'',guardReply:x=>x,callApi:async()=>null,logger:{info(){},warn(){}},getRedis:()=>store,getBot:id=>id==='22'?{uin:22,pickGroup:()=>({sendMsg:async message=>{sends.push(message);return {message_id:1}}})}:null,sendImageReliably:async()=>null,mimeTypes:{extension:()=>false,lookup:()=>false},...extra})
 return {tool:new Tool(),rows,sends}
}
test('compiled image edit SSE preserves split JSON and multibyte text',async()=>{
 const {tool}=fixture();const bytes=new TextEncoder().encode('data: {"choices":[{"delta":{"content":"图片 https://example.com/a.png"}}]}\n\ndata: [DONE]\n')
 const stream=new ReadableStream({start(controller){for(let i=0;i<bytes.length;i+=3)controller.enqueue(bytes.slice(i,i+3));controller.close()}})
 assert.equal(await tool.handleStreamResponse(new Response(stream)),'图片 https://example.com/a.png')
})
test('compiled image edit recovery retains jobs when owning bot unavailable',async()=>{
 const {tool,rows}=fixture();const job=tool.createDurableJob({images:['a'],prompt:'edit'},{group_id:1,user_id:2,self_id:99,message_id:3});await tool.persistDurableJob(job)
 await tool.recoverDurableJobs();assert.equal(rows.size,1)
})
test('compiled image edit does not replay delivery-attempted jobs',async()=>{
 const {tool,rows,sends}=fixture();const job=tool.createDurableJob({images:['a'],prompt:'edit'},{group_id:1,user_id:2,self_id:22,message_id:3});job.deliveryAttempted=true;await tool.persistDurableJob(job)
 let calls=0;tool.performImageEdit=async()=>{calls++;return 'ok'};await tool.recoverDurableJobs();assert.equal(calls,0);assert.equal(sends.length,0);assert.equal(rows.size,1)
})
test('compiled image edit recovery routes through persisted bot account',async()=>{
 const {tool,sends,rows}=fixture();const job=tool.createDurableJob({images:['a'],prompt:'edit'},{group_id:1,user_id:2,self_id:22,message_id:3});await tool.persistDurableJob(job)
 let recovered;tool.performImageEdit=async(_opts,event)=>{recovered=event.self_id;return 'ok'};await tool.recoverDurableJobs();assert.equal(recovered,'22');assert.equal(sends.length,1);assert.equal(rows.size,0)
})
test('compiled image edit provider trust uses actual user text',()=>{
 const {tool}=fixture({loadConfig:()=>({imageGenerationAiConfig:{providers:[{name:'Grok',apiUrl:'https://grok.example/v1',model:'grok-imagine',apiKey:'grok-key'}]}})})
 assert.deepEqual(tool.normalizeParameters({prompt:'去掉手机',images:['image'],provider:'gemini'},{userText:'希洛帮我去掉这个图手里的手机'}),{prompt:'去掉手机',images:['image']})
 assert.equal(tool.normalizeParameters({prompt:'去掉手机',images:['image'],provider:'Grok'},{userText:'希洛帮我用 Grok 去掉这个图手里的手机'}).provider,'Grok')
 assert.equal(tool.resolveRequestedProvider({}, {prompt:'模型擅自写了：用 Gemini 编辑'}, {msg:'希洛帮我去掉这个图手里的手机'}),'')
 assert.doesNotMatch(tool.description,/Google|Gemini/i)
})
