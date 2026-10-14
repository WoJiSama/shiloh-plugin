import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createConversationEntryPolicy,type EntryHost} from '../../src/modules/conversation/infrastructure/conversationEntryPolicy.js'
import {createForbiddenWordGuard} from '../../src/modules/conversation/domain/forbiddenWordGuard.js'
import {createGroupRuntime} from '../../src/modules/runtime/application/groupRuntime.js'
import {__resetPrivateChatForTest} from '../../src/modules/conversation/domain/privateChat.js'
const logger={info(_m:string){},warn(_m:string){},mark(_m:string){}}
function fixture(){
 const guard=createForbiddenWordGuard(logger),events:string[]=[]
 const runtime=createConversationEntryPolicy({logger,bot:()=>({uin:1}),...guard,getSemanticMemoryRuntime:()=>null,resolveNaturalDeltaForceToolCall:()=>null,shouldUseExcelWorkbookTool:()=>false,extractValidBtihMagnetUri:()=>null})
 const group=createGroupRuntime<ReturnType<typeof setTimeout>,null,null>({now:()=>1,cancelTimer:clearTimeout,peekTopic:()=>null,peekSocial:()=>null})
 const host:EntryHost={config:{triggerPrefixes:['bot'],privateChat:{enabled:true,allowedUsers:['7'],cooldownSeconds:0},forbiddenWords:{words:['blocked'],replyText:'stop'}},
 isCommand:e=>runtime.isCommand(host,e),isUserBlacklisted:e=>runtime.isUserBlacklisted(host,e),handleForbiddenWordHit:e=>runtime.handleForbiddenWordHit(host,e),handleTool:async()=>{events.push('tool')},
 cancelPendingConversation(){events.push('cancel')},sendObservedReply:async()=>{events.push('notice')},getPersonaFor:()=>({}),getSmartState:()=>({...group.getSmartRuntimeState(1),rerunEvent:null})}
 return {runtime,host,events}
}
test('private entry applies command, permission and forbidden-word barriers before chat dispatch',async()=>{
 __resetPrivateChatForTest();const {runtime,host,events}=fixture(),e={message_type:'private',user_id:7,msg:'#command'}
 assert.equal(await runtime.handlePrivateChat(host,e),false);assert.deepEqual(events,[])
 e.msg='blocked';assert.equal(await runtime.handlePrivateChat(host,e),false);assert.deepEqual(events,['notice'])
 e.msg='hello';await runtime.handlePrivateChat(host,e);assert.deepEqual(events,['notice','tool'])
})
test('trigger detection uses event bot identity and blacklist normalizes configured IDs',()=>{
 const {runtime,host}=fixture()
 assert.equal(runtime.checkTriggers(host,{group_id:1,bot:{uin:2},message:[{type:'at',qq:2}]}),true)
 assert.equal(runtime.checkTriggers(host,{group_id:1,bot:{uin:2},message:[{type:'at',qq:1}]}),false)
 host.config.userBlacklist={enabled:true,users:[' 7 ']};assert.equal(runtime.isUserBlacklisted(host,{group_id:1,user_id:7}),true)
})
