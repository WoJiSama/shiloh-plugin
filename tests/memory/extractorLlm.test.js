// tests/memory/extractorLlm.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MemoryExtractor } from '../../domains/memory/engine/extractor.js'

test('extract reports unconfigured separately from successful empty extraction', async () => {
  const ex = new MemoryExtractor({ memoryAiConfig: null })
  const ops = await ex.extract({ groupId: 'g', speakerQQ: '1', messages: [{ content: '我叫A' }], at: 1 })
  assert.deepEqual(ops, {status:'skipped',reason:'unconfigured'})
})

test('extract parses fenced JSON array from chat response', async () => {
  const ex = new MemoryExtractor({ memoryAiConfig: { memoryAiUrl: 'u', memoryAiApikey: 'k' } })
  ex._callChat = async () => '```json\n[{"route":"self_statement","alias":"咖啡大人","confidence":0.9}]\n```'
  const result = await ex.extract({ groupId: 'g', speakerQQ: '925640859', messages: [{ content: '以后叫我咖啡大人',at:5 }], at: 5 })
  assert.equal(result.status,'success')
  const ops = result.ops
  assert.equal(ops.length, 1)
  assert.equal(ops[0].stream, 'alias')
  assert.equal(ops[0].qq, '925640859')
})

test('malformed chat response is a retryable extraction failure', async () => {
  const ex = new MemoryExtractor({ memoryAiConfig: { memoryAiUrl: 'u', memoryAiApikey: 'k' } })
  ex._callChat = async () => 'sorry I cannot'
  const ops = await ex.extract({ groupId: 'g', speakerQQ: '1', messages: [{ content: 'x' }], at: 1 })
  assert.deepEqual(ops, {status:'failed',reason:'invalid-output',retryable:true})
})

test('transport failure, blank body and invalid shapes never count as empty success', async () => {
  const ex = new MemoryExtractor({ memoryAiConfig: { memoryAiUrl: 'u', memoryAiApikey: 'k' } })
  const input = {groupId:'g',speakerQQ:'1',messages:[{content:'明天考试',at:1}],at:1}
  for (const content of ['', '{}', '[null]', '[{"route":"bogus"}]', '解释如下：[]',
    '[{"route":"self_statement"}]','[{"route":"user_preference","content":false}]','[{"route":"group_consensus","content":"  "}]']) {
    ex._callChat = async () => content
    assert.deepEqual(await ex.extract(input),{status:'failed',reason:'invalid-output',retryable:true},content)
  }
  ex._callChat = async () => { throw new Error('timeout') }
  assert.deepEqual(await ex.extract(input),{status:'failed',reason:'transport',retryable:true})
  ex._callChat = async () => '[]'
  assert.deepEqual(await ex.extract(input),{status:'success',ops:[]})
})

test('nonempty extraction requires a valid source row and multi-row batches cannot acknowledge unindexed facts',async()=>{
  const ex = new MemoryExtractor({ memoryAiConfig: { memoryAiUrl: 'u', memoryAiApikey: 'k' } })
  const input={groupId:'g',speakerQQ:'111',messages:[{content:'明天考试',at:1},{content:'后天面试',at:86400001}],at:10}
  for(const sourceIndex of [undefined,null,0,-1,3,true,'1',1.5]){
    ex._callChat=async()=>JSON.stringify([{route:'self_statement',content:'明天考试',eventInDays:1,sourceIndex}])
    assert.deepEqual(await ex.extract(input),{status:'failed',reason:'invalid-output',retryable:true})
  }
  ex._callChat=async()=>'[{"route":"self_statement","content":"明天考试","eventInDays":1,"sourceIndex":1}]'
  const valid=await ex.extract(input)
  assert.equal(valid.status,'success')
  assert.equal(valid.ops[0].fact.eventAt,86400001)
  ex._callChat=async()=>'[{"route":"ordinary_chat"}]'
  assert.deepEqual(await ex.extract(input),{status:'success',ops:[]})
})

test('extract prompt keeps utterance clock, source and third-party attribution boundary', async () => {
  const ex = new MemoryExtractor({ memoryAiConfig: { memoryAiUrl: 'u', memoryAiApikey: 'k' } })
  let prompts
  ex._callChat = async (messages) => {prompts=messages;return '[]'}
  const at=Date.parse('2026-10-15T23:59:00+08:00')
  await ex.extract({groupId:'g',speakerQQ:'',messages:[{content:'我明天考试',at,role:'user',source:'forward'},{content:'未知时间的原文',source:'quote'}],at:at+86400000})
  assert.match(prompts[0].content,/没有可信原作者 QQ 时不得/)
  assert.match(prompts[1].content,/来源：forward；发言时间：2026-10-15 23:59:00 Asia\/Shanghai/)
  assert.match(prompts[1].content,/来源：quote；发言时间：未知；不得推断相对日期/)
  assert.doesNotMatch(prompts[1].content,/2026-10-16/)
})
