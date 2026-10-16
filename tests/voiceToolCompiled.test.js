import test from 'node:test'
import assert from 'node:assert/strict'
import {createVoiceTool} from '../dist/backend/modules/media/infrastructure/VoiceTool.js'
import {createPersonaSnapshot} from '../dist/backend/modules/conversation/infrastructure/personaSnapshot.js'
import {createPersonaFeedbackModule} from '../dist/backend/modules/memory/infrastructure/personaFeedbackManager.js'
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

test('voice text uses the turn persona and captured guard after live configuration changes',async()=>{
 const {PersonaFeedbackManager}=createPersonaFeedbackModule({isToneCorrectionMessage:()=>false})
 const manager=new PersonaFeedbackManager()
 for(const hasGuard of [true,false]){
  const snapshot=createPersonaSnapshot({botId:99,personaId:'a',persona:{name:'甲'},...(hasGuard?{personaGuard:{enabled:true}}:{})})
  const config={voiceSystem:{enabled:true},persona:{name:'乙'},personaGuard:{enabled:false}}
  const seen=[]
  const Tool=createVoiceTool({getBridge:()=>({config,getPersonaFor:()=>config.persona}),guardReply:(text,guard,context)=>{
   seen.push({guard,context});return manager.guardReply(text,guard,context)
  },record:file=>({type:'record',file})})
  const tool=new Tool()
  let synthesized
  tool.buildProvider=()=>({synthesizeToFile:async({text})=>{synthesized=text;return {filePath:'/tmp/shiloh-persona-voice-fixture-missing.mp3'}}})
  const event=Object.assign(Object.create({self_id:99,group_id:1,user_id:2,bot:{uin:99,nickname:'账号别名'}}),{_personaSnapshot:snapshot,msg:'你好',reply:async()=>({message_id:1})})
  assert.match(await tool.func({text:'欸，别突然这么叫呀，有点不好意思啦。'},event),/语音已发送/)
  assert.equal(synthesized,'叫我甲就好。')
  assert.equal(seen[0].guard,snapshot.personaGuard)
  assert.equal(seen[0].context.botNames[0],'甲')
 }
})
