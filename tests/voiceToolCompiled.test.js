import test from 'node:test'
import assert from 'node:assert/strict'
import {createVoiceTool} from '../dist/backend/modules/media/infrastructure/VoiceTool.js'
function fixture(config,receipt){
 let sends=0,syntheses=0
 const Tool=createVoiceTool({getBridge:()=>({config:{voiceSystem:config}}),guardReply:text=>text,record:file=>({type:'record',file})})
 const tool=new Tool()
 tool.buildProvider=()=>({synthesizeToFile:async()=>{syntheses++;return {filePath:'/tmp/shiloh-voice-fixture-missing.mp3'}}})
 return {tool,event:{reply:async()=>{sends++;return receipt}},counts:()=>({sends,syntheses})}
}
test('compiled voice tool does not synthesize when disabled',async()=>{
 const f=fixture({enabled:false},{message_id:1})
 assert.match(await f.tool.func({text:'hello'},f.event),/没开启/)
 assert.deepEqual(f.counts(),{sends:0,syntheses:0})
})
test('compiled voice delivery requires a receipt and never retries unknown result',async()=>{
 const f=fixture({enabled:true},undefined)
 assert.match(await f.tool.func({text:'hello'},f.event),/未确认/)
 assert.deepEqual(f.counts(),{sends:1,syntheses:1})
 const sent=fixture({enabled:true},{message_id:1})
 assert.match(await sent.tool.func({text:'hello'},sent.event),/语音已发送/)
})
