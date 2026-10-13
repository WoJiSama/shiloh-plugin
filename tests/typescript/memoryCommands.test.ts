import test from 'node:test'
import assert from 'node:assert/strict'
import { createMemoryCommands } from '../../src/modules/memory/infrastructure/memoryCommands.js'
import { createGlobalStyleLearnerClass } from '../../src/modules/memory/infrastructure/globalStyleLearner.js'
import { createPersonaFeedbackModule } from '../../src/modules/memory/infrastructure/personaFeedbackManager.js'
import type { MemoryCommandPort } from '../../src/contracts/sharedRuntime.js'
function fixture() {
 let clears=0
 const memory:MemoryCommandPort={clearGroupRedis:async()=>0,adminClearMemories:async()=>{clears++;return{cleared:2}},adminStatus:async()=>({}),adminListMemories:async()=>({facts:[]}),getGroupWorkflowRules:async()=>[],getGroupKnowledgeEntries:async()=>[],adminDeleteGroupWorkflow:async()=>({deleted:false}),adminDeleteGroupKnowledge:async()=>({deleted:false}),adminDeleteMemory:async()=>({deleted:false}),clearUserMemory:async()=>({cleared:0}),adminSetUserMemoryEnabled:async()=>({enabled:true})}
 const Style=createGlobalStyleLearnerClass({botId:()=>1,buildExpressionObservation:()=>null})
 const Persona=createPersonaFeedbackModule({isToneCorrectionMessage:()=>false}).PersonaFeedbackManager
 const Commands=createMemoryCommands({PluginBase:class {},getSharedMemoryManager:()=>memory,getSharedConfig:()=>({}),globalStyleLearnerManager:new Style(),personaFeedbackManager:new Persona(),logger:{warn(){},error(){}},makeForwardMsg:async(_event,messages,title)=>({messages,title})})
 return {command:new Commands(),clears:()=>clears}
}
test('group clearing requires permission and two confirmations from the same user',async()=>{
 const {command,clears}=fixture();const replies:unknown[]=[]
 const event={group_id:'100',user_id:'1',sender:{role:'member'},reply:async(message:unknown)=>{replies.push(message)}}
 await command.clearGroupMemory(event);assert.equal(clears(),0)
 event.sender.role='owner'
 await command.clearGroupMemory(event);assert.equal(clears(),0);assert.match(String(replies.at(-1)),/30 秒/)
 await command.clearGroupMemory({...event,user_id:'2'});assert.equal(clears(),0)
 await command.clearGroupMemory(event);assert.equal(clears(),1)
})
test('memory forward renders sections and never resends after transport rejection',async()=>{
 const {command}=fixture();const payloads:unknown[]=[]
 await command.replyMemoryForward({reply:async payload=>{payloads.push(payload)}},'test',[{title:'mine',facts:[{text:'remember',tags:['fact']}]}])
 assert.equal(payloads.length,1);assert.match(JSON.stringify(payloads[0]),/remember/)
 let sends=0
 await assert.rejects(command.replyMemoryForward({reply:async()=>{sends++;throw new Error('unknown receipt')}},'test',[{title:'mine',facts:[]}]),/unknown receipt/)
 assert.equal(sends,1)
})
test('clear confirmation cannot be reused across bot accounts',async()=>{
 const {command,clears}=fixture()
 const event={group_id:'100',user_id:'1',isMaster:true,reply:async()=>undefined}
 await command.clearGroupMemory({...event,self_id:'10'})
 await command.clearGroupMemory({...event,self_id:'20'})
 assert.equal(clears(),0)
 await command.clearGroupMemory({...event,self_id:'10'})
 assert.equal(clears(),1)
})
test('command business catch does not retry or relabel uncertain reply failure',async()=>{
 for (const reason of [new Error('transport uncertain'),'primitive transport error',undefined]) {
  const {command}=fixture();let attempts=0
  const event={group_id:'100',user_id:'1',msg:'#删除记忆 example',reply:async()=>{attempts++;throw reason}}
  for (const invoke of [()=>command.listMyMemory(event),()=>command.listGroupMemory(event),()=>command.deleteMemory(event),()=>command.clearMyMemory(event),()=>command.disableMyMemory(event),()=>command.enableMyMemory(event)]) {
   attempts=0
   let caught=false
   try {await invoke()} catch(error) {caught=true;assert.equal(error,reason)}
   assert.equal(caught,true);assert.equal(attempts,1)
  }
 }
})
