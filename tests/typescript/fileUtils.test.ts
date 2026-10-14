import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createFileUtils,type FileEvent,type FileUtilsPorts} from '../../src/modules/shared/infrastructure/fileUtils.js'
const quiet={debug(_s:string){},info(_s:string){},warn(_s:string){},error(_s:string){}}
function fixture(overrides:Partial<FileUtilsPorts>={}){return createFileUtils({cwd:'/tmp',logger:quiet,mimeTypes:{extension:()=>false,lookup:()=>false},redis:{get:async()=>null,set:async()=>{}},callOneBotApi:async()=>({data:[]}),image:path=>path,makeForwardMsg:async(_e,messages)=>messages,classifyMessageSegmentMedia:seg=>seg.type==='image'?'image':'other',...overrides})}
test('forward output is capped at 100 nodes and does not retry ambiguous delivery failure',async()=>{
 const sizes:number[]=[];const runtime=fixture(),e:FileEvent={reply:async payload=>{assert.ok(Array.isArray(payload));sizes.push(payload.length);return {message_id:sizes.length}}}
 await runtime.sendLongMessage(e,Array.from({length:201},(_,i)=>String(i)),[]);assert.deepEqual(sizes,[100,100,1])
 let calls=0;e.reply=async()=>{calls++;throw new Error('connection lost')}
 await assert.rejects(runtime.sendLongMessage(e,['text'],[]),/connection lost/);assert.equal(calls,1)
 assert.throws(()=>runtime.chunk([1],0),/正整数/)
})
test('file lookup uses explicit reply ID and preserves signed download URL without filename concatenation',async()=>{
 const actions:string[]=[];const runtime=fixture()
 const result=await runtime.getFileInfo({group_id:1,reply_id:'specific',reply:async()=>{},bot:{sendApi:async(action,params)=>{
 actions.push(action)
 if(action==='get_msg'){assert.equal(params.message_id,'specific');return {data:{message:[{type:'file',data:{file_id:'f',file:'report.pdf'}}]}}}
 return {data:{url:'https://example.test/file?signature=abc'}}
 }}})
 assert.equal(result.fileUrl,'https://example.test/file?signature=abc');assert.equal(result.fileName,'report.pdf');assert.deepEqual(actions,['get_msg','get_group_file_url'])
})
test('image extraction prefers quoted images and supports adapter nested data',async()=>{
 const runtime=fixture();const output=await runtime.TakeImages({reply:async()=>{},getReply:async()=>({message:[{type:'image',data:{url:'https://example.test/quoted.png'}}]}),message:[{type:'image',url:'https://example.test/current.png'}]})
 assert.deepEqual(output,['https://example.test/quoted.png'])
})
test('malformed RKey response does not leak objects into refresh candidates',async()=>{
 const runtime=fixture({callOneBotApi:async()=>({data:[null,{rkey:'&rkey=valid'},{value:'other'}]})})
 assert.deepEqual(await runtime.getNapcatRKeys(),['valid','other'])
})

test('saveData reports failure when neither Redis nor file storage succeeds',async()=>{
 const runtime=fixture({redis:{get:async()=>null,set:async()=>{throw new Error('offline')}}})
 const result=await runtime.saveData('key','/dev/null/invalid.json',{value:1})
 assert.deepEqual(result,{success:false})
})

test('forward unknown and explicit false receipts stop subsequent batches without retransmission',async()=>{
 for(const receipt of [undefined,false,{status:'failed'}]) {
  const runtime=fixture();let sends=0
  await assert.rejects(runtime.sendLongMessage({reply:async()=>{sends++;return receipt}},Array.from({length:200},()=> 'node'),[]),/未确认/)
  assert.equal(sends,1)
 }
})
