import test from 'node:test'
import assert from 'node:assert/strict'
import {createPipelineForwardResolver} from '../../src/adapters/pipelineForwardContext.js'
import {collectForwardContext, extractForwardIdsFromSegments} from '../../src/modules/conversation/infrastructure/groupContextResolver.js'
import {findForwardCompleteness, formatForwardCompleteness, parseForwardCompleteness} from '../../src/modules/conversation/domain/forwardCompleteness.js'

const forward = [{type:'forward',id:'root'}]
const envelope = {groupId:'42',message:forward}

test('forward metadata validates totals, states, distinct ids and detached values before reuse', async () => {
 const context = await collectForwardContext({getForwardMsg:async()=>[{message:[{type:'text',text:'observed'}]}]},forward)
 const raw = {...context.completeness,providerToken:'do not persist',entries:context.completeness.entries.map(item=>({...item,rawConfig:'do not persist'}))}
 const parsed = parseForwardCompleteness(raw)!
 assert.deepEqual(parsed,context.completeness)
 assert.notEqual(parsed.entries,raw.entries)
 assert.notEqual(parsed.entries[0],raw.entries[0])
 assert.doesNotMatch(JSON.stringify(parsed),/providerToken|rawConfig/)
 const invalid:unknown[] = [null,[],{}, {...raw,version:2}, {...raw,processedNodes:-1}, {...raw,knownTotalNodes:2}, {...raw,totalExact:false},
  {...raw,failedForwardIds:['unknown']}, {...raw,entries:[...raw.entries,...raw.entries]}, {...raw,entries:[{...raw.entries[0],totalNodes:null}]},
  {...raw,state:'unavailable'}, {...raw,nodeLimitReached:true}, {...raw,entries:[{...raw.entries[0],processedNodes:0}]},
  {...raw,entries:[{...raw.entries[0],state:'unavailable',reason:'fetch_failed'}]}]
 for(const value of invalid)assert.equal(parseForwardCompleteness(value),undefined)
 assert.equal(findForwardCompleteness([{type:'forward_context',completeness:{state:'complete'}}]),undefined)
 assert.deepEqual(findForwardCompleteness([{type:'forward_context',completeness:raw}]),parsed)
 assert.deepEqual(findForwardCompleteness([],{completeness:raw}),parsed)
 assert.equal(formatForwardCompleteness(undefined),'')
})

test('pipeline resolver retains partial completeness and applies one explicit node budget', async () => {
 let fetches = 0
 const group = {getForwardMsg:async()=>{fetches++;return Array.from({length:81},(_,index)=>({message:[{type:'text',text:`node-${index}`}]}))}}
 const resolve = createPipelineForwardResolver({
  getBot:()=>({pickGroup:()=>group}),extractForwardIdsFromSegments,
  collectForwardContext:async(_group,message,limits)=>{assert.equal(limits.maxNodes,80);assert.equal(limits.maxLines,undefined);return collectForwardContext(group,message,limits)}
 })
 const result = await resolve(envelope)
 assert.equal(fetches,1)
 assert.equal(result?.completeness?.state,'partial')
 assert.equal(result?.completeness?.processedNodes,80)
 assert.equal(result?.completeness?.omittedKnownNodes,1)
 assert.match(result?.text || '',/部分展开/)
})

test('pipeline resolver keeps unread forwards retryable and attaches validated failure details', async () => {
 const group = {getForwardMsg:async()=>{throw new Error('expired')}}
 const resolve = createPipelineForwardResolver({getBot:()=>({pickGroup:()=>group}),extractForwardIdsFromSegments,collectForwardContext:async(_group,message,limits)=>collectForwardContext(group,message,limits)})
 await assert.rejects(resolve(envelope),(error:unknown)=>{
  assert.ok(error && typeof error==='object' && 'code' in error && 'completeness' in error)
  assert.equal(error.code,'forward_context_unavailable')
  const completeness = parseForwardCompleteness(error.completeness)
  assert.equal(completeness?.state,'unavailable')
  assert.deepEqual(completeness?.failedForwardIds,['root'])
  return true
 })
})
