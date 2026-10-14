import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createGoogleImageAnalysisTool} from '../dist/backend/modules/toolSupport/infrastructure/GoogleAnalysisTool.js'
function fixture(){
 const loaded=[]
 const Tool=createGoogleImageAnalysisTool({loadConfig:()=>({analysisAiConfig:{analysisApiUrl:'https://example.test/v1/chat/completions',analysisApiKey:'test',analysisApiModel:'vision'}}),normalizeImageUrls:async urls=>urls,imageLoader:async url=>{loaded.push(url);return 'data:image/png;base64,YQ=='},progressReplyFactory:async()=> '正在识别',guardReply:text=>text,callApi:async()=>({}),logger:{info(){},warn(){}}})
 return {loaded,tool:new Tool({fetchImpl:async()=>new Response(JSON.stringify({choices:[{message:{content:'图像内容'}}]}),{status:200}),progressDelayMs:60000})}
}
test('compiled analysis preserves distinct avatar query identities while deduplicating expiring image tokens',async()=>{
 const {loaded,tool}=fixture()
 const urls=['https://q1.qlogo.cn/g?b=qq&nk=111&s=640','https://q1.qlogo.cn/g?b=qq&nk=222&s=640','https://q1.qlogo.cn/g?b=qq&nk=111&s=640','https://gchat.qpic.cn/download?fileid=a&rkey=old','https://gchat.qpic.cn/download?fileid=a&rkey=new']
 const result=await tool.func({images:urls,prompt:'比较头像'},{msg:'比较头像',reply:async()=>({message_id:1})})
 assert.deepEqual(loaded,[urls[0],urls[1],urls[3]])
 assert.equal(result.evidence.imageCount,3)
})
test('compiled analysis consumes progress budget after ambiguous reply rejection',async()=>{
 const {tool}=fixture();let sends=0
 const event={msg:'看看图',_progressReplyState:{sent:false,reserved:false},reply:async()=>{sends++;throw new Error('receipt lost')}}
 assert.equal(await tool.sendProgress(event),false)
 assert.deepEqual(event._progressReplyState,{sent:true,reserved:false})
 assert.equal(await tool.sendProgress(event),false);assert.equal(sends,1)
})
test('compiled analysis releases progress reservation if content generation fails before delivery',async()=>{
 const {tool}=fixture();let sends=0
 const event={_progressReplyState:{sent:false,reserved:false},reply:async()=>{sends++}}
 tool.progressReplyFactory=async()=>{throw new Error('model offline')}
 assert.equal(await tool.sendProgress(event),false)
 assert.deepEqual(event._progressReplyState,{sent:false,reserved:false});assert.equal(sends,0)
})
