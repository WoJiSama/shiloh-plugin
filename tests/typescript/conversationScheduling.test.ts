import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createConversationScheduling,type SchedulingHost,type ScheduledEvent} from '../../src/modules/conversation/infrastructure/conversationScheduling.js'
import {createMutedGroupPolicy} from '../../src/modules/conversation/infrastructure/mutedGroupPolicy.js'
import {createGroupRuntime} from '../../src/modules/runtime/application/groupRuntime.js'
import {smartConversationKey} from '../../src/modules/conversation/domain/conversationIdentity.js'
import type {ConversationState} from '../../src/modules/conversation/application/smartConversation.js'
const logger={info(_s:string){},warn(_s:string){},error(_s:string,_e?:unknown){}}
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
function fixture(){
 const runtime=createConversationScheduling({logger,resolveToolRequestMergeMs:()=>5,shouldBypassMergeForExcel:()=>false,isDrawTaskStatusInquiry:()=>false})
 const states=createGroupRuntime<ReturnType<typeof setTimeout>,null,null>({now:Date.now,cancelTimer:clearTimeout,peekTopic:()=>null,peekSocial:()=>null})
 const stateMap=new Map<string|number,ConversationState>()
 const events:ScheduledEvent[]=[]
 const host:SchedulingHost={config:{enabled:true,chatTriggerMode:'smart'},resolveTalkValue:()=>1,computeAvgReplyLatency:()=>1,checkGroupPermission:()=>true,isUserBlacklisted:()=>false,isMutedInGroup:async()=>false,
 handleRandomReplySmart:async e=>{events.push(e)},handleTool:async e=>{events.push(e)},getSmartState(g,e){const key=smartConversationKey(g,e);let s=stateMap.get(key);if(!s){s={...states.getSmartRuntimeState(key),rerunEvent:null};stateMap.set(key,s)}return s},
 getDirectTriggerMergeMs:()=>5,getDirectTriggerMergeMaxMessages:()=>2,getMergeMsForEvent:()=>5,isMergeableDirectTrigger:()=>true,isMergeableToolRequest:()=>true,isCommand:()=>false,isAutomaticTorrentDownloadEvent:()=>false,isLikelyToolRequestText:()=>true,
 buildMergedDirectTriggerEvent:(e,m)=>runtime.buildMergedDirectTriggerEvent(host,e,m),buildMergedToolRequestEvent:(e,m)=>runtime.buildMergedToolRequestEvent(host,e,m),getSmartLockTimeoutMs:()=>5,releaseSmartInFlight:(s,e,t)=>runtime.releaseSmartInFlight(host,s,e,t)}
 return {runtime,host,events}
}
test('merge timers isolate accounts and retain the newest bounded inputs',async()=>{
 const {runtime,host,events}=fixture();const event={group_id:7,user_id:8,self_id:1,msg:'first'}
 runtime.scheduleMergedDirectTrigger(host,event,async e=>{events.push(e)})
 runtime.scheduleMergedDirectTrigger(host,{...event,msg:'second'},async e=>{events.push(e)})
 runtime.scheduleMergedDirectTrigger(host,{...event,msg:'third'},async e=>{events.push(e)})
 runtime.scheduleMergedDirectTrigger(host,{...event,self_id:2,msg:'other bot'},async e=>{events.push(e)})
 await sleep(30);assert.equal(events.length,2)
 assert.equal(events[0]?._mergedDroppedMessageCount,1);assert.deepEqual(events[0]?._mergedOriginalTexts,['second','third']);assert.equal(events[1]?.msg,'other bot')
})
test('stale lock release cannot unlock a newer turn; owner releases and reruns exactly once',()=>{
 const {runtime,host,events}=fixture(),e={group_id:7,self_id:1},s=host.getSmartState(7,e)
 s.inFlight=true;s.inFlightToken=2;s.needsRerun=true;s.rerunEvent=e
 runtime.releaseSmartInFlight(host,s,e,1);assert.equal(s.inFlight,true);assert.equal(events.length,0)
 runtime.releaseSmartInFlight(host,s,e,2);assert.equal(s.inFlight,false);assert.equal(events.length,1)
 runtime.releaseSmartInFlight(host,s,e,2);assert.equal(events.length,1)
})
test('deferred and wait callbacks recheck enabled state and cancellation removes pending timers',async()=>{
 const {runtime,host,events}=fixture(),e={group_id:7,self_id:1},s=host.getSmartState(7,e)
 host.config.smartTrigger={minDeferredMs:5,maxDeferredMs:5};runtime.scheduleDeferredGateCheck(host,e,s)
 host.config.enabled=false;await sleep(20);assert.equal(events.length,0)
 runtime.scheduleWaitReply(host,e,0.01,'test');runtime.cancelPendingConversation(host,7,e)
 await sleep(20);assert.equal(events.length,0);assert.equal(s.waitTimers.size,0)
})
test('mute cache distinguishes bot accounts in the same group',async()=>{
 const runtime=createMutedGroupPolicy(()=>({uin:1}))
 assert.equal(await runtime.isMutedInGroup({group_id:7,self_id:1,group:{mute_left:60}}),true)
 assert.equal(await runtime.isMutedInGroup({group_id:7,self_id:2,group:{}}),false)
})
