import {test} from 'node:test'
import assert from 'node:assert/strict'
import {collectForwardContext,normalizeMessageSegments,resolveGroupContextAssets} from '../../src/modules/conversation/infrastructure/groupContextResolver.js'
import {parseForwardCompleteness} from '../../src/modules/conversation/domain/forwardCompleteness.js'
const forward = (id: string) => ({type:'forward', id})
const node = (text: string, extra: Record<string, unknown>[] = []) => ({sender:{user_id:7, nickname:'speaker'}, message:[{type:'text', text}, ...extra]})
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

test('one fetch supplies both text and snapshots while the default node budget reports every known omission', async () => {
 let requests = 0
 const result = await collectForwardContext({getForwardMsg:async()=>{requests++;return Array.from({length:101},(_,index)=>node(`row-${index}-fetch-${requests}`))}},[forward('root')])
 assert.equal(requests,1)
 assert.equal(result.forwardNodes[0]?.nodes.length,80)
 assert.equal(result.completeness.processedNodes,80)
 assert.equal(result.completeness.knownTotalNodes,101)
 assert.equal(result.completeness.omittedKnownNodes,21)
 assert.equal(result.completeness.totalExact,false)
 assert.equal(result.completeness.state,'partial')
 assert.equal(result.completeness.nodeLimitReached,true)
 assert.match(result.text,/已处理 80 条，已知至少 101 条/)
 assert.match(result.text,/row-79-fetch-1/)
 assert.doesNotMatch(result.text,/row-80-|fetch-2/)
 assert.match(JSON.stringify(result.forwardNodes),/row-79-fetch-1/)
 assert.doesNotMatch(JSON.stringify(result.forwardNodes),/row-80-|fetch-2/)
 assert.deepEqual(parseForwardCompleteness(result.completeness),result.completeness)
})

test('explicit maxNodes and legacy maxLines reserve parent nodes before recursive children', async () => {
 const group = {getForwardMsg:async(id:string)=>id==='root' ? [node('root-first',[forward('child')]),node('root-second')] : [node('child-first'),node('child-second'),node('child-third')]}
 for (const options of [{maxNodes:3},{maxLines:3}]) {
  const result = await collectForwardContext(group,[forward('root')],options)
  assert.equal(result.completeness.processedNodes,3)
  assert.equal(result.completeness.knownTotalNodes,5)
  assert.equal(result.completeness.omittedKnownNodes,2)
  assert.equal(result.forwardNodes[0]?.nodes.length,1)
  assert.equal(result.forwardNodes[0]?.nodes[0]?.nested_forwards[0]?.nodes.length,2)
  assert.doesNotMatch(result.text,/root-second|child-third/)
  assert.equal(result.completeness.entries.find(item=>item.forwardId==='root')?.processedNodes,1)
  assert.deepEqual(parseForwardCompleteness(result.completeness),result.completeness)
 }
})

test('unread nested forwards have unknown totals and are not fetched outside the depth budget', async () => {
 const requests:string[] = []
 const result = await collectForwardContext({getForwardMsg:async(id:string)=>{requests.push(id);return [node('root',[forward('child')])]}},[forward('root')],{maxDepth:1})
 assert.deepEqual(requests,['root'])
 assert.deepEqual(result.completeness.depthLimitedForwardIds,['child'])
 assert.equal(result.completeness.entries.find(item=>item.forwardId==='child')?.totalNodes,null)
 assert.equal(result.completeness.totalExact,false)
 assert.equal(result.completeness.state,'partial')
 assert.deepEqual(parseForwardCompleteness(result.completeness),result.completeness)
})

test('a forward first skipped for depth is still fetched once when explicitly present as a shallower root', async () => {
 const requests:string[] = []
 const result = await collectForwardContext({getForwardMsg:async(id:string)=>{requests.push(id);return [node(id,id==='root'?[forward('child')]:[forward('root')])]}},[forward('root'),forward('child')],{maxDepth:1})
 assert.deepEqual(requests,['root','child'])
 assert.equal(result.completeness.processedNodes,2)
 assert.equal(result.completeness.snapshotTruncated,true)
 assert.doesNotThrow(()=>JSON.stringify(result.forwardNodes))
 assert.deepEqual(parseForwardCompleteness(result.completeness),result.completeness)
})

test('mixed failures and loops are explicit while each failed id is requested only once', async () => {
 const requests:string[] = []
 const result = await collectForwardContext({getForwardMsg:async(id:string)=>{
  requests.push(id)
  if(id==='bad')throw new Error('expired forward')
  return [node('first',[forward('bad'),forward('root')]),node('second',[forward('bad')])]
 }},[forward('root'),forward('bad')])
 assert.deepEqual(requests,['root','bad'])
 assert.equal(result.completeness.state,'partial')
 assert.deepEqual(result.completeness.failedForwardIds,['bad'])
 assert.deepEqual(result.completeness.cycleForwardIds,['root'])
 assert.equal(result.completeness.knownTotalNodes,2)
 assert.equal(result.completeness.totalExact,false)
 assert.equal(result.completeness.entries.find(item=>item.forwardId==='bad')?.reason,'fetch_failed')
 assert.doesNotThrow(()=>JSON.stringify(result.forwardNodes))
 assert.deepEqual(parseForwardCompleteness(result.completeness),result.completeness)
})

test('unavailable, malformed and valid empty forward responses stay distinguishable', async () => {
 const unavailable = await collectForwardContext(null,[forward('offline')])
 const malformed = await collectForwardContext({getForwardMsg:async()=>({data:{error:'missing'}})},[forward('malformed')])
 const empty = await collectForwardContext({getForwardMsg:async()=>({data:{messages:[]}})},[forward('empty')])
 assert.equal(unavailable.completeness.state,'unavailable')
 assert.equal(unavailable.completeness.entries[0]?.reason,'fetch_failed')
 assert.match(unavailable.text,/未能读取/)
 assert.equal(malformed.completeness.state,'unavailable')
 assert.equal(malformed.completeness.entries[0]?.reason,'malformed_response')
 assert.equal(empty.completeness.state,'complete')
 assert.equal(empty.completeness.totalExact,true)
 assert.equal(empty.completeness.knownTotalNodes,0)
 for(const result of [unavailable,malformed,empty])assert.deepEqual(parseForwardCompleteness(result.completeness),result.completeness)
})

test('text, media and snapshot budgets remain visible even when the excerpt body is tiny', async () => {
 const segments = Array.from({length:101},(_,index)=>({type:'text',text:`part-${index}`}))
 const images = Array.from({length:13},(_,index)=>({type:'image',url:`https://images.test/${index}.png`}))
 const result = await collectForwardContext({getForwardMsg:async()=>[node('long content',[...segments,...images])]},[forward('root')],{maxText:5})
 assert.equal(result.completeness.textTruncated,true)
 assert.equal(result.completeness.mediaTruncated,true)
 assert.equal(result.completeness.snapshotTruncated,true)
 assert.equal(result.completeness.state,'partial')
 assert.equal(result.completeness.totalExact,true)
 assert.equal(result.images.length,12)
 assert.equal(result.forwardNodes[0]?.nodes[0]?.message.length,100)
 assert.match(result.text,/^【转发读取范围】部分展开/)
 assert.match(result.text,/正文因长度预算仅保留摘录/)
 assert.match(result.text,/未读或未展示部分不能说成已读/)
 assert.equal(result.text.split('\n').at(-1)?.length,5)
 assert.deepEqual(parseForwardCompleteness(result.completeness),result.completeness)
})

test('current and quoted forwards keep independent completeness instead of promoting either to complete', async () => {
 const result = await resolveGroupContextAssets({e:{message:[forward('ok')]},reply:{message:[forward('bad')]},group:{getForwardMsg:async(id:string)=>{if(id==='bad')throw new Error('expired');return [node('current')]}}})
 assert.equal(result.currentForwardCompleteness.state,'complete')
 assert.equal(result.quotedForwardCompleteness.state,'unavailable')
 assert.match(result.currentForwardText,/完整展开/)
 assert.match(result.quotedForwardText,/未能读取/)
 assert.match(result.forwardText,/未能读取/)
})
