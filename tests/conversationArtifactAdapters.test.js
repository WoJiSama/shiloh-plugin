import test from 'node:test'
import assert from 'node:assert/strict'
import {createChatTurnDurabilityModule} from '../dist/backend/modules/conversation/application/chatTurnDurability.js'
import {createTurnPromptComposer} from '../dist/backend/modules/conversation/infrastructure/turnPromptComposer.js'

test('compiled turn recovery selects the recorded bot and retains trigger',async()=>{
 const sent=[]
 const api=createChatTurnDurabilityModule({getBot:id=>({uin:id,pickGroup:group=>({sendMsg:async value=>{sent.push({id,group,value});return {message_id:1}}})}),getRedis:()=>null})
 const event=api.rebuildChatTurnEvent({group_id:12,user_id:34,self_id:56,triggerContext:{mode:'direct'}})
 assert.equal(event.bot.uin,56)
 assert.equal(event._triggerContext.mode,'direct')
 await event.reply('ok')
 assert.deepEqual(sent,[{id:56,group:12,value:'ok'}])
})

test('compiled prompt composer tolerates optional synchronous loader with failing layers',async()=>{
 const {composeTurnPromptLayers}=createTurnPromptComposer()
 const result=await composeTurnPromptLayers({config:{promptLayerCache:{enabled:false},memorySystem:{enabled:true}},turn:{groupId:1,userId:2,messageText:'hello'},deps:{memoryManager:{getContextualMemoryPrompt:async()=>{throw new Error('offline')},getGroupWorkflowPrompt:async()=>'',getGroupKnowledgePrompt:async()=>''},globalStyleLearnerManager:{buildPrompt:()=> 'global style',buildRelevantPrompt:async()=>''}}})
 assert.equal(result.layerValues.globalStyle,'global style')
 assert.equal(result.layerValues.memory,'')
})
