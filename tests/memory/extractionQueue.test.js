import {test} from 'node:test'
import assert from 'node:assert/strict'
import {MemoryManager} from '../../domains/memory/MemoryManager.js'
import {createFakeRedis} from './helpers/fakeRedis.js'

const SCOPE={botId:'b1',personaId:'p1',personaVersion:'v1',personaName:'希洛'}
const AT=Date.parse('2026-10-15T23:59:00+08:00')
function manager(redis=createFakeRedis(),config={}) {
  return new MemoryManager({enabled:true,userExtractMaxBatchMessages:1,userExtractDebounceSeconds:3600,extractRetryBaseMs:300000,extractRetryMaxAttempts:3,groupExtractMinIntervalMinutes:10,...config},{redis})
}
function stopTimers(m) {
  for(const buffers of [m.userBuffers,m.groupBuffers])for(const buf of buffers.values())if(buf.timer)clearTimeout(buf.timer)
}
function deferred(){let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}}
const failure=()=>({status:'failed',reason:'transport',retryable:true})
const empty=()=>({status:'success',ops:[]})

// Original input and source clocks must survive both failed transport and a new
// manager instance; this uses only shared in-memory Redis, never a live service.
test('failed extraction persists full utterance, source clock and bounded retry state across restart',async()=>{
  const redis=createFakeRedis()
  const first=manager(redis)
  const raw='我明天考试。\n'+('这是原文，不是模型摘要。'.repeat(70))
  first.extractor.extract=async()=>failure()
  try {
    const failed=await first.extractAndSaveMemories('g','111',raw,'',{at:AT,personaSource:SCOPE})
    assert.equal(failed.status,'failed')
    const stored=await first.store.getPendingExtractions('g')
    assert.equal(stored.length,1)
    assert.equal(stored[0].messages[0].content,raw)
    assert.equal(stored[0].messages[0].at,AT)
    assert.deepEqual(stored[0].personaSource,SCOPE)
    assert.equal(stored[0].attempts,1)
    assert.ok(stored[0].retryAt>0)
    stopTimers(first)
    const second=manager(redis)
    try {
      await second.restorePendingExtractions('g')
      let seen
      second.extractor.extract=async input=>{seen=input;return empty()}
      assert.equal((await second.retryPendingExtractions({groupId:'g',now:stored[0].retryAt-1})).length,0)
      const results=await second.retryPendingExtractions({groupId:'g',now:stored[0].retryAt+1})
      assert.equal(results[0].status,'success')
      assert.equal(seen.messages[0].content,raw)
      assert.equal(seen.messages[0].at,AT)
      assert.equal(seen.at,AT)
      assert.deepEqual(await second.store.getPendingExtractions('g'),[])
      const meta=await second.store.getMeta('g')
      assert.ok(meta.lastExtractAt>0)
      assert.equal(meta.failureCount,0)
      assert.equal(meta.lastExtractStatus,'success')
    } finally {stopTimers(second)}
  } finally {stopTimers(first)}
})

test('retry exhaustion is durable, retains original text and never loops indefinitely',async()=>{
  const redis=createFakeRedis(),m=manager(redis)
  let calls=0
  m.extractor.extract=async()=>{calls++;return failure()}
  try {
    await m.extractAndSaveMemories('g','111','我明天面试','',{at:AT,personaSource:SCOPE})
    for(let n=0;n<2;n++){
      const [pending]=await m.store.getPendingExtractions('g')
      await m.retryPendingExtractions({now:pending.retryAt+1})
    }
    assert.equal(calls,3)
    const [pending]=await m.store.getPendingExtractions('g')
    assert.equal(pending.retryExhausted,true)
    assert.equal(pending.attempts,3)
    assert.equal(pending.retryAt,0)
    assert.equal(pending.messages[0].content,'我明天面试')
    assert.equal((await m.store.getMeta('g')).lastExtractAt,0)
    assert.equal((await m.retryPendingExtractions({now:Date.now()+86400000})).length,0)
    const restarted=manager(redis)
    try {
      await restarted.restorePendingExtractions('g')
      restarted.extractor.extract=async()=>{calls++;return empty()}
      assert.equal((await restarted.retryPendingExtractions({now:Date.now()+86400000})).length,0)
      assert.equal((await restarted.extractAndSaveMemories('g','111','新消息','',{at:AT+1000,personaSource:SCOPE})).reason,'retry-exhausted')
      assert.equal(calls,3)
      assert.equal((await restarted.adminStatus({groupId:'g'})).group.pendingExtractions,1)
    } finally {stopTimers(restarted)}
  } finally {stopTimers(m)}
})

test('unconfigured extraction remains pending without counting a failure or empty success',async()=>{
  const redis=createFakeRedis(),m=manager(redis)
  try {
    const result=await m.extractAndSaveMemories('g','111','我在上海做后端','',{at:AT,personaSource:SCOPE})
    assert.equal(result.status,'skipped')
    assert.equal(result.reason,'unconfigured')
    const meta=await m.store.getMeta('g')
    assert.equal(meta.lastExtractAt,0)
    assert.equal(meta.failureCount,0)
    assert.equal(meta.lastExtractStatus,'skipped')
    assert.equal((await m.store.getPendingExtractions('g'))[0].lastFailure,'unconfigured')
    const next=manager(redis)
    try {
      await next.getContextualMemoryPrompt('g','111','hi',AT)
      assert.equal([...next.userBuffers.values()][0].timer,null)
    }finally{stopTimers(next)}
  }finally{stopTimers(m)}
})

test('one flush owns each batch, while messages arriving during extraction remain durable',async()=>{
  const m=manager(),entered=deferred(),finish=deferred()
  let calls=0
  m.extractor.extract=async()=>{calls++;entered.resolve();await finish.promise;return empty()}
  try {
    const first=m.extractAndSaveMemories('g','111','第一句，我明天考试','',{at:AT,personaSource:SCOPE})
    await entered.promise
    const [key]=m.userBuffers.keys()
    assert.equal((await m._flushUserBuffer(key)).reason,'in-flight')
    assert.equal((await m.extractAndSaveMemories('g','111','第二句，考数学','',{at:AT+1000,personaSource:SCOPE})).reason,'in-flight')
    assert.equal((await m.store.getPendingExtractions('g'))[0].messages.length,2)
    finish.resolve()
    assert.equal((await first).status,'success')
    const [pending]=await m.store.getPendingExtractions('g')
    assert.deepEqual(pending.messages.map(row=>row.content),['第二句，考数学'])
    assert.equal(calls,1)
    m.extractor.extract=async()=>{calls++;return empty()}
    await m._flushUserBuffer(key)
    assert.deepEqual(await m.store.getPendingExtractions('g'),[])
    assert.equal(calls,2)
  }finally{finish.resolve();stopTimers(m)}
})

test('cold restoration completes before accepting new input and pending caps reject explicitly',async()=>{
  const redis=createFakeRedis(),old=manager(redis,{userExtractMaxBatchMessages:10,extractPendingMaxMessages:2})
  try {
    assert.equal((await old.extractAndSaveMemories('g','111','旧消息','',{at:AT,personaSource:SCOPE})).queued,true)
    stopTimers(old)
    const next=manager(redis,{userExtractMaxBatchMessages:10,extractPendingMaxMessages:2,extractPendingMaxBatches:1})
    try {
      assert.equal((await next.extractAndSaveMemories('g','111','新消息','',{at:AT+1000,personaSource:SCOPE})).queued,true)
      assert.equal((await next.extractAndSaveMemories('g','111','超限消息','',{at:AT+2000,personaSource:SCOPE})).reason,'pending-full')
      assert.equal((await next.extractAndSaveMemories('g','222','其他用户消息','',{at:AT,personaSource:SCOPE})).reason,'pending-batches-full')
      const [pending]=await next.store.getPendingExtractions('g')
      assert.deepEqual(pending.messages.map(row=>row.content),['旧消息','新消息'])
    }finally{stopTimers(next)}
  }finally{stopTimers(old)}
})

test('user batches do not mix account, persona version or calendar day',async()=>{
  const m=manager(undefined,{userExtractMaxBatchMessages:10})
  try{
    for(const [scope,at,text] of [
      [SCOPE,AT,'今天的希洛'],
      [{...SCOPE,botId:'b2'},AT,'另一个账号'],
      [{...SCOPE,personaId:'p2'},AT,'另一个人格'],
      [{...SCOPE,personaVersion:'v2'},AT,'修改后人格'],
      [SCOPE,AT+120000,'午夜后的希洛']
    ])await m.extractAndSaveMemories('g','111',text,'',{at,personaSource:scope})
    const pending=await m.store.getPendingExtractions('g')
    assert.equal(pending.length,5)
    assert.ok(pending.every(entry=>entry.messages.length===1))
    assert.deepEqual(pending.map(entry=>entry.personaSource.botId),['b1','b2','b1','b1','b1'])
  }finally{stopTimers(m)}
})

test('failed group extraction does not start successful-extraction throttle',async()=>{
  const m=manager()
  try{
    m.extractor.extract=async()=>failure()
    const first=await m.extractAndSaveGroupMemories('g',[{content:'群里周三开会',at:AT,source:'user'}],{personaSource:SCOPE})
    assert.equal(first.status,'failed')
    assert.equal((await m.extractAndSaveGroupMemories('g',[{content:'群里周三开会',at:AT} ],{personaSource:SCOPE})).reason,'retry-wait')
    m.extractor.extract=async()=>empty()
    await m.retryPendingExtractions({now:first.nextRetryAt+1})
    assert.equal((await m.extractAndSaveGroupMemories('g',[{content:'新的群讨论',at:AT}],{personaSource:SCOPE})).reason,'throttled')
  }finally{stopTimers(m)}
})

for(const action of ['opt-out','disable','clear','clear-user']){
  test(`${action} cancels in-flight extraction and clears durable pending input`,async()=>{
    const redis=createFakeRedis(),m=manager(redis),entered=deferred(),finish=deferred()
    m.extractor.extract=async()=>{entered.resolve();await finish.promise;return {status:'success',ops:[{stream:'entityFact',qq:'111',authority:'self',fact:{text:'不应写回的个人事实',authority:'self',confidence:0.9,at:AT}}]}}
    try{
      const pending=m.extractAndSaveMemories('g','111','我在上海工作','',{at:AT,personaSource:SCOPE})
      await entered.promise
      if(action==='opt-out')await m.adminSetUserMemoryEnabled({groupId:'g',userId:'111',enabled:false})
      if(action==='disable')await m.adminSetGroupMemoryEnabled({groupId:'g',enabled:false})
      if(action==='clear')await m.adminClearMemories({groupId:'g'})
      if(action==='clear-user')await m.clearUserMemory('g','111')
      finish.resolve()
      assert.equal((await pending).reason,'cancelled')
      assert.deepEqual(await m.store.getPendingExtractions('g'),[])
      assert.equal((await m.store.getEntities('g'))['111'],undefined)
      const restarted=manager(redis)
      try{
        await restarted.restorePendingExtractions('g')
        assert.equal(restarted.userBuffers.size,0)
      }finally{stopTimers(restarted)}
    }finally{finish.resolve();stopTimers(m)}
  })
}

test('failed durable acknowledgement preserves input for idempotent at-least-once replay',async()=>{
  const redis=createFakeRedis(),m=manager(redis)
  m.extractor.extract=async()=>({status:'success',ops:[{stream:'entityFact',qq:'111',authority:'self',fact:{text:'喜欢喝茶',authority:'self',confidence:0.9,at:AT}}]})
  const remove=redis.del.bind(redis)
  let failedAck=false
  redis.del=async key=>{
    if(key.endsWith(':pending-extractions')&&!failedAck){failedAck=true;throw new Error('redis temporarily unavailable')}
    return remove(key)
  }
  try{
    const result=await m.extractAndSaveMemories('g','111','我喜欢喝茶','',{at:AT,personaSource:SCOPE})
    assert.equal(result.status,'failed')
    assert.equal((await m.store.getPendingExtractions('g'))[0].messages[0].content,'我喜欢喝茶')
    assert.equal((await m.store.getEntities('g'))['111'].facts.length,1)
    await m.retryPendingExtractions({now:result.nextRetryAt+1})
    assert.equal((await m.store.getEntities('g'))['111'].facts.length,1)
    assert.deepEqual(await m.store.getPendingExtractions('g'),[])
  }finally{stopTimers(m)}
})

test('reflection completion or failure never clears extraction failure state',async()=>{
  const m=manager()
  try{
    m.extractor.extract=async()=>failure()
    await m.extractAndSaveMemories('g','111','明天考试','',{at:AT,personaSource:SCOPE})
    const failed=await m.store.getMeta('g')
    m.reflector.consolidateEntity=async()=>({changed:false,facts:[]})
    m.reflector.reflectGroup=async()=>({insights:[]})
    await m._runReflection('g',{entityQQs:['111'],groupOverThreshold:true})
    assert.deepEqual(await m.store.getMeta('g'),failed)
  }finally{stopTimers(m)}
})

test('numeric and string group IDs share the same persistence queue',async()=>{
  const m=manager(),entered=deferred(),finish=deferred(),order=[]
  const first=m.enqueueGroup(123,async()=>{order.push('first-start');entered.resolve();await finish.promise;order.push('first-end')})
  const second=m.enqueueGroup('123',async()=>{order.push('second')})
  await entered.promise
  assert.deepEqual(order,['first-start'])
  finish.resolve()
  await Promise.all([first,second])
  assert.deepEqual(order,['first-start','first-end','second'])
})

test('opt-out filters new group histories by trusted author and excludes unknown forwarded authors',async()=>{
  const m=manager()
  try{
    await m.adminSetUserMemoryEnabled({groupId:'g',userId:'111',enabled:false})
    let seen
    m.extractor.extract=async input=>{seen=input;return empty()}
    const result=await m.extractAndSaveGroupMemories('g',[
      {content:'退出记忆的个人原文',authorQQ:'111',at:AT,source:'user'},
      {content:'另一位成员的群共识',authorQQ:'222',at:AT,source:'user'},
      {content:'旧历史作者未知的原文',at:AT},
      {content:'别人转发内的个人原文',authorQQ:'222',at:AT,source:'forward'},
      {content:'别人引用内的个人原文',authorQQ:'222',at:AT,source:'quote'}
    ],{personaSource:SCOPE})
    assert.equal(result.status,'success')
    assert.deepEqual(seen.messages.map(row=>[row.authorQQ,row.content]),[['222','另一位成员的群共识']])
  }finally{stopTimers(m)}
})

test('restart after opt-out meta write but before pending cleanup cannot resend opted-out or unknown group text',async()=>{
  const redis=createFakeRedis(),beforeCrash=manager(redis)
  beforeCrash.extractor.extract=async()=>failure()
  try{
    await beforeCrash.extractAndSaveGroupMemories('g',[
      {content:'退出记忆成员的原文',authorQQ:'111',at:AT},
      {content:'仍允许记忆的原文',authorQQ:'222',at:AT},
      {content:'旧版无作者原文',at:AT},
      {content:'转发包含未知原作者',authorQQ:'222',source:'forward',at:AT}
    ],{personaSource:SCOPE})
    const [original]=await beforeCrash.store.getPendingExtractions('g')
    assert.equal(original.messages.length,4)
    // Simulates the durable crash point: opt-out committed, old pending document
    // untouched. Restoring must enforce privacy without relying on clean shutdown.
    await beforeCrash.store.saveMeta('g',{...(await beforeCrash.store.getMeta('g')),optedOut:['111']})
    stopTimers(beforeCrash)
    const restarted=manager(redis)
    try{
      await restarted.restorePendingExtractions('g')
      const [safe]=await restarted.store.getPendingExtractions('g')
      assert.deepEqual(safe.messages.map(row=>row.content),['仍允许记忆的原文'])
      assert.equal(safe.messages[0].authorQQ,'222')
      let seen
      restarted.extractor.extract=async input=>{seen=input;return empty()}
      await restarted.retryPendingExtractions({now:original.retryAt+1})
      assert.deepEqual(seen.messages.map(row=>row.content),['仍允许记忆的原文'])
    }finally{stopTimers(restarted)}
  }finally{stopTimers(beforeCrash)}
})

test('legacy unknown-author group pending is discarded on cold restore when any member opted out',async()=>{
  const redis=createFakeRedis(),first=manager(redis)
  first.extractor.extract=async()=>failure()
  try{
    await first.extractAndSaveGroupMemories('g',[{content:'旧版没有作者的个人话语',at:AT}],{personaSource:SCOPE})
    await first.store.saveMeta('g',{...(await first.store.getMeta('g')),optedOut:['111']})
    stopTimers(first)
    const restarted=manager(redis)
    let calls=0
    restarted.extractor.extract=async()=>{calls++;return empty()}
    try{
      await restarted.getContextualMemoryPrompt('g','222','hi',AT)
      assert.deepEqual(await restarted.store.getPendingExtractions('g'),[])
      assert.equal(restarted.groupBuffers.size,0)
      await restarted.retryPendingExtractions({now:Date.now()+86400000})
      assert.equal(calls,0)
    }finally{stopTimers(restarted)}
  }finally{stopTimers(first)}
})

test('group retries recheck durable opt-out metadata immediately before the model request',async()=>{
  const m=manager()
  try{
    m.extractor.extract=async()=>failure()
    const first=await m.extractAndSaveGroupMemories('g',[
      {content:'后来退出的成员原文',authorQQ:'111',at:AT},
      {content:'仍可处理的群发言',authorQQ:'222',at:AT}
    ],{personaSource:SCOPE})
    // Another writer updated durable metadata after this manager cached the group.
    await m.store.saveMeta('g',{...(await m.store.getMeta('g')),optedOut:['111']})
    let seen
    m.extractor.extract=async input=>{seen=input;return failure()}
    await m.retryPendingExtractions({now:first.nextRetryAt+1})
    assert.deepEqual(seen.messages.map(row=>row.content),['仍可处理的群发言'])
    assert.deepEqual((await m.store.getPendingExtractions('g'))[0].messages.map(row=>row.content),['仍可处理的群发言'])
  }finally{stopTimers(m)}
})

test('overlapping group histories append new rows once during backoff and report pending limits',async()=>{
  const m=manager(undefined,{extractPendingMaxMessages:2})
  const original={content:'最初的群共识',authorQQ:'111',at:AT}
  const added={content:'稍后的群共识',authorQQ:'222',at:AT+1000}
  try{
    m.extractor.extract=async()=>failure()
    const first=await m.extractAndSaveGroupMemories('g',[original],{personaSource:SCOPE})
    assert.equal((await m.extractAndSaveGroupMemories('g',[original,added],{personaSource:SCOPE})).reason,'retry-wait')
    assert.equal((await m.extractAndSaveGroupMemories('g',[original,added],{personaSource:SCOPE})).reason,'retry-wait')
    const limited=await m.extractAndSaveGroupMemories('g',[original,added,{content:'超过限制的新共识',authorQQ:'222',at:AT+2000}],{personaSource:SCOPE})
    assert.equal(limited.reason,'pending-full')
    assert.equal(limited.rejectedMessages,1)
    const [pending]=await m.store.getPendingExtractions('g')
    assert.equal(pending.retryAt,first.nextRetryAt)
    assert.deepEqual(pending.messages.map(row=>row.content),['最初的群共识','稍后的群共识'])
  }finally{stopTimers(m)}
})
