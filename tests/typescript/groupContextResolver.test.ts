import {test} from 'node:test'
import assert from 'node:assert/strict'
import {collectForwardContext,normalizeMessageSegments,resolveGroupContextAssets} from '../../src/modules/conversation/infrastructure/groupContextResolver.js'
test('untrusted forward payload shapes fail safely and recursive snapshots remain bounded',async()=>{
 assert.deepEqual(normalizeMessageSegments({message:[null,3,{type:'text',text:'valid'}]}),[{},{},{type:'text',text:'valid'}])
 let requests=0
 const cycle:Record<string,unknown>={type:'text',text:'safe'};cycle.cycle=cycle;cycle.buffer=Buffer.from('omit');cycle.callback=()=>{}
 const result=await collectForwardContext({getForwardMsg:async()=>{requests++;return {messages:[{sender:{nickname:'a'},message:[cycle,{type:'forward',id:'root'}]}]}}},[{type:'forward',id:'root'}],{maxDepth:2,maxLines:3})
 assert.ok(requests<=2);assert.match(result.text,/safe/)
 assert.doesNotThrow(()=>JSON.stringify(result.forwardNodes))
 const segment=result.forwardNodes[0]?.nodes[0]?.message[0]
 assert.equal(segment?.callback,undefined);assert.equal(segment?.buffer,undefined);assert.equal(segment?.cycle,undefined)
})
test('reply source preserves owner identity and deduplicates media URLs by stable file id',async()=>{
 const result=await resolveGroupContextAssets({e:{message:[{type:'image',url:'https://example.test/a?fileid=1&rkey=a'}]},reply:{sender:{user_id:7,card:'owner'},message:[{type:'image',url:'https://example.test/a?fileid=1&rkey=b'}]}})
 assert.equal(result.replyTargetUserId,'7');assert.equal(result.replyTargetLabel,'owner');assert.equal(result.images.length,1);assert.equal(result.quotedImages[0]?.senderName,'owner')
})
