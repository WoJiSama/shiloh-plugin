import {test} from 'node:test'
import assert from 'node:assert/strict'
import {groundFinalReply} from '../../src/modules/conversation/application/groundedReply.js'
import {buildTurnInteractionContext} from '../../src/modules/conversation/domain/turnInteractionContext.js'
import type {TurnInteractionContext} from '../../src/contracts/turnInteraction.js'

const context = (): TurnInteractionContext => ({...buildTurnInteractionContext({rawUserText: '刚才改背景的图出来了吗？', botId: '99', speaker: {userId: '2'}}), actionFacts: {
  scope:{botId:'99',conversationId:'group:1',userId:'2'},observedAt:Date.now(),lookup:'ok',tasks:[]
}})

test('ordinary content passes verbatim with no extra model call', async () => {
  let calls = 0
  const candidate = '你妹妹今天不是回家了吗？有点不好意思啦，不过谢谢你。'
  const result = await groundFinalReply({candidate,context:buildTurnInteractionContext({rawUserText:'和我聊会儿',botId:'99'}),regenerate:async()=>{calls++;return 'wrong'}})
  assert.equal(result.text,candidate)
  assert.equal(calls,0)
  assert.equal(result.audit.repairAttempted,false)
})

test('an unverified commitment gets one full correction with original user and evidence', async () => {
  let calls = 0
  const result = await groundFinalReply({candidate:'还没出来，好了我第一时间发你。',context:context(),regenerate:async(candidate,instruction)=>{
    calls++
    assert.match(candidate,/第一时间发你/u)
    assert.match(instruction,/未确认不能升级成尚未产出/u)
    assert.match(instruction,/刚才改背景的图出来了吗/u)
    return '我还没核实到那次处理的结果，暂时不能确认进度。'
  }})
  assert.equal(calls,1)
  assert.equal(result.audit.fallback,false)
  assert.match(result.text,/不能确认/u)
  assert.equal(result.audit.original,'还没出来，好了我第一时间发你。')
})

test('invalid, empty and failed repairs fall back without a second model call', async () => {
  for (const reply of ['有结果我会通知你。','',undefined,'throw']) {
    let calls = 0
    const result = await groundFinalReply({candidate:'好了我第一时间发你。',context:context(),regenerate:async()=>{
      calls++;if(reply==='throw')throw new Error('network');return reply
    }})
    assert.equal(calls,1)
    assert.equal(result.audit.fallback,true)
    assert.match(result.text,/不能确认/u)
    assert.doesNotMatch(result.text,/第一时间发你|会通知你/u)
  }
})

test('a cancelled callback during repair cannot authorize a late promise', async () => {
  let reads = 0
  const initial=context()
  const result=await groundFinalReply({candidate:'还没出来，好了我第一时间发你。',context:initial,
    refresh:async()=>{reads++;return reads===1?{...initial,actionFacts:{...initial.actionFacts!,tasks:[{taskId:'t',requestMessageId:'request',toolName:'imageEdit',source:'live_job',observedAt:Date.now(),execution:'running',result:'unknown',delivery:{state:'unknown'},followUp:{state:'registered',kind:'job_completion',id:'callback'}}]}}:initial},
    regenerate:async()=> '好了我第一时间发你。'})
  assert.equal(reads,3)
  assert.equal(result.audit.fallback,true)
  assert.match(result.text,/不能确认/u)
})

test('empty and failed repairs refresh cancelled registration before building a fallback',async()=>{
 for(const repair of ['','throw']){
  let reads=0
  const initial=context()
  const registered={...initial,actionFacts:{...initial.actionFacts!,tasks:[{taskId:'t',requestMessageId:'r',toolName:'imageEdit',source:'live_job' as const,observedAt:Date.now(),execution:'running' as const,result:'unknown' as const,delivery:{state:'unknown' as const},followUp:{state:'registered' as const,kind:'job_completion' as const,id:'callback'}}]}}
  const result=await groundFinalReply({candidate:'图已经做好了。',context:registered,refresh:async()=>++reads===1?registered:initial,regenerate:async()=>{if(repair==='throw')throw new Error('timeout');return repair}})
  assert.equal(reads,2)
  assert.equal(result.audit.fallback,true)
  assert.doesNotMatch(result.text,/任务仍有效/u)
 }
})

test('failed final refresh cannot reuse a formerly live callback',async()=>{
 let reads=0
 const initial=context()
 const result=await groundFinalReply({candidate:'好了我第一时间发你。',context:initial,refresh:async()=>{if(++reads>1)throw new Error('store failed');return initial},regenerate:async()=>''})
 assert.equal(result.audit.fallback,true)
 assert.equal(result.context.actionFacts?.lookup,'unavailable')
 assert.deepEqual(result.context.actionFacts?.tasks,[])
})

test('fallback for an image question cannot borrow the queue of an exam reminder', async () => {
  const current = context()
  current.actionFacts!.tasks = [{taskId:'exam', requestMessageId:'exam-request', toolName:'reminderTool', source:'reminder', observedAt:Date.now(), execution:'queued', result:'unknown', delivery:{state:'not_attempted'}, followUp:{state:'registered',kind:'reminder',id:'exam',dueAt:Date.now()+60_000}}]
  const result = await groundFinalReply({candidate:'图还在排队，好了会自动发给你。', context:current, regenerate:async()=>''})
  assert.equal(result.audit.fallback,true)
  assert.match(result.text,/不能确认|未确认|没有核实/u)
  assert.doesNotMatch(result.text,/还在排队|正在处理|任务仍有效/u)
})
