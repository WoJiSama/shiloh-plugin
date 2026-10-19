import test from 'node:test'
import assert from 'node:assert/strict'
import {createIntentShadowSampler} from '../dist/backend/modules/conversation/application/intentShadow.js'

const flush = () => new Promise(resolve => setImmediate(resolve))
function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return {promise, resolve}
}
const options = overrides => ({enabled:true,isCasualFastPath:true,rate:1,classify:async()=>({intent:'chat',confidence:0.9}),onResult:()=>{},...overrides})

test('shadow evaluation is opt-in, sampled, and limited to genuine casual fast paths', async () => {
  const sample = createIntentShadowSampler({random:()=>0.5})
  let calls = 0
  const classify = async () => {calls++;return {intent:'chat',confidence:1}}
  assert.equal(sample(options({enabled:false,classify})),false)
  assert.equal(sample(options({isCasualFastPath:false,classify})),false)
  assert.equal(sample(options({rate:0.1,classify})),false)
  assert.equal(sample(options({rate:0,classify})),false)
  assert.equal(calls,0)
  assert.equal(sample(options({classify})),true)
  assert.equal(calls,0,'scheduling does not synchronously invoke or wait for the model')
  await flush()
  assert.equal(calls,1)
})

test('shadow observations distinguish disagreements from uncertainty and failure', async () => {
  const cases = [
    [{intent:'chat',confidence:0.9},'match'],
    [{intent:'noise',confidence:1},'match'],
    [{intent:'other_tool',confidence:0.9},'mismatch'],
    [{intent:'search',confidence:0.4},'unavailable'],
    [{intent:'search'},'unavailable'],
    [{intent:'unavailable',confidence:0},'unavailable'],
    [null,'unavailable']
  ]
  for (const [decision,status] of cases) {
    const results = []
    const sample = createIntentShadowSampler()
    assert.equal(sample(options({classify:async()=>decision,onResult:result=>results.push(result)})),true)
    await flush()
    assert.equal(results.length,1)
    assert.equal(results[0].status,status)
    assert.equal(results[0].elapsedMs>=0,true)
  }
  const results = []
  createIntentShadowSampler()(options({classify:async()=>{throw Error('model failed')},onResult:result=>results.push(result)}))
  await flush()
  assert.equal(results[0].status,'error')
})

test('an outstanding model consumes a slot and there is no background queue', async () => {
  const sample = createIntentShadowSampler()
  const pending = deferred()
  let calls = 0
  const request = options({maxConcurrent:1,classify:async()=>{calls++;return pending.promise}})
  assert.equal(sample(request),true)
  assert.equal(sample(request),false)
  await flush()
  assert.equal(calls,1)
  pending.resolve({intent:'chat',confidence:1})
  await flush()
  assert.equal(sample(options({})),true,'settlement releases the real concurrency slot')
  await flush()
  assert.equal(calls,1,'the rejected request was never queued')
})

test('timeout reports once and retains the slot until an uncooperative backend settles', async t => {
  t.mock.timers.enable({apis:['setTimeout']})
  let clock = 0
  const sample = createIntentShadowSampler({now:()=>clock})
  const pending = deferred()
  const results = []
  let signal
  assert.equal(sample(options({timeoutMs:20,classify:async input=>{signal=input.signal;return pending.promise},onResult:result=>results.push(result)})),true)
  await flush()
  clock = 20
  t.mock.timers.tick(20)
  assert.equal(results[0].status,'timeout')
  assert.equal(results[0].elapsedMs,20)
  assert.equal(signal.aborted,true)
  assert.equal(sample(options({})),false,'timing out cannot create more active backend calls')
  pending.resolve({intent:'search',confidence:1})
  await flush()
  assert.equal(results.length,1,'a late result cannot overwrite the timeout or add a second observation')
  assert.equal(sample(options({})),true)
  await flush()
})

test('observer failures do not escape as unhandled rejections or exhaust the budget', async () => {
  const sample = createIntentShadowSampler()
  sample(options({onResult:()=>{throw Error('logger failed')}}))
  await flush()
  assert.equal(sample(options({onResult:async()=>{throw Error('archive failed')}})),true)
  await flush()
  assert.equal(sample(options({})),true)
  await flush()
})
