import test from 'node:test'
import assert from 'node:assert/strict'
import {TotalTokens} from '../dist/backend/modules/toolSupport/infrastructure/CalculateToken.js'
import {processArray} from '../dist/backend/modules/toolSupport/infrastructure/messageGenerator.js'
import {createFileExtractor} from '../dist/backend/modules/toolSupport/infrastructure/fileExtraction.js'
import {createFileDownload,createTakeFiles,takeSourceMsg} from '../dist/backend/modules/toolSupport/infrastructure/UploadFile.js'
import {createUploadedFileProcessor} from '../dist/backend/modules/toolSupport/infrastructure/processUploadedFile.js'
import {SearchClient} from '../dist/backend/modules/toolSupport/infrastructure/SearchClient.js'
import {AbstractTool} from '../dist/backend/modules/toolSupport/infrastructure/AbstractTool.js'
const logger={log(){},error(){}}
test('compiled tokenizer counts textual multimodal content and history',async()=>{
 const usage=await TotalTokens([{type:'image_url',image_url:'ignored'},{type:'text',text:'hello'}],[{content:'hello'}])
 assert.equal(usage.completion_tokens,1);assert.equal(usage.prompt_tokens,1);assert.equal(usage.total_tokens,2)
 assert.equal((await TotalTokens(null)).total_tokens,0)
})
test('compiled message processor keeps system and recent user turns',async()=>{
 const messages=[{role:'system',content:'rules'},{role:'user',content:'old'},{role:'assistant',content:'answer'},{role:'user',content:'new'}]
 assert.deepEqual(await processArray(messages,1),[messages[0],messages[3]])
 assert.deepEqual(await processArray([],1),[])
})
test('compiled file extraction dispatches plain/PDF/office and returns null on PDF failure',async()=>{
 const extractor=createFileExtractor({logger,pdfParse:async buffer=>{if(buffer.toString()==='bad')throw Error('bad pdf');return{text:'pdf text'}},textract:{fromBufferWithMime(mime,buffer,options,callback){callback(null,'office text')}}})
 assert.equal(await extractor.extractFile('text/plain',Buffer.from('中文')),'中文')
 assert.equal(await extractor.extractFile('application/pdf',Buffer.from('pdf')),'pdf text')
 assert.equal(await extractor.extractFile('application/pdf',Buffer.from('bad')),null)
 assert.equal(await extractor.extractFile('application/docx',Buffer.from('doc')),'office text')
})
test('compiled downloads handle missing content type, expired resources and transport errors',async()=>{
 const make=response=>createFileDownload({get:async()=>response,lookup:()=>false,logger})
 assert.equal((await make({status:200,headers:{},data:Buffer.from('hello')}).getBufferFile('url','file')).buffer,Buffer.from('hello').toString('base64'))
 assert.equal((await make({status:200,headers:{'content-type':'application/json'},data:Buffer.from('{"retmsg":"expired"}')}).getBufferFile('url','file')).buffer,null)
 assert.equal((await make({status:404,headers:{},data:Buffer.from('no')}).getBufferFile('url','file')).buffer,null)
})
test('compiled source resolution handles empty messages and group file URLs without globals',async()=>{
 assert.equal(await takeSourceMsg({getReply:async()=>({message:[]})},{file:true}),false)
 assert.deepEqual(await takeSourceMsg({getReply:async()=>({message:[{type:'image',url:'https://image'}]})},{img:true}),['https://image'])
 assert.equal(await takeSourceMsg({group_id:1,group:{getFileUrl:async fid=>'url/'+fid},getReply:async()=>({message:[{type:'file',fid:'123'}]})},{file:true}),'url/123')
 assert.deepEqual(await createTakeFiles(async()=>({fileUrl:'u',fileName:'n'}))({}),[{fileUrl:'u',fileName:'n'}])
})
test('compiled uploaded-file processor does not invent null content on extraction failure',async()=>{
 const ports={getBufferFile:async()=>({buffer:'a'}),lookup:()=>false,extractFile:async()=>null,TotalTokens,logger}
 assert.equal(await createUploadedFileProcessor(ports)('u','n','question'),'question')
 ports.extractFile=async()=>'actual text'
 assert.match(await createUploadedFileProcessor(ports)('u','n','question'),/文件内容:\nactual text/)
})
test('compiled search parser returns actual citation list and validates questions',()=>{
 const client=new SearchClient()
 const result=client.parseResponse('{"contexts":[{"name":"title","url":"https://example.invalid","snippet":"description"}]}__LLM_RESPONSE__\n\nanswer [citation:1]\n\n__RELATED_QUESTIONS__\n\n["next"]')
 assert.equal(result.response,'answer');assert.equal(typeof result.list,'string');assert.match(result.list,/title/);assert.deepEqual(result.questions,['next'])
})
test('compiled abstract tool normalizes before validation and reports execution failure',async()=>{
 class Example extends AbstractTool {constructor(){super();this.name='test';this.description='test';this.parameters={type:'object',properties:{count:{type:'number'}},required:['count']}}async func(params){return params.count}}
 const tool=new Example()
 assert.equal(await tool.execute({count:'2'},{}),2)
 assert.match(await tool.execute({},{}),/缺少必填参数/)
 tool.func=async()=>{throw Error('failed')}
 assert.match(await tool.execute({count:2},{}),/^error: 工具 test 执行失败/)
})
