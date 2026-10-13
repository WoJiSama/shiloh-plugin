import test from 'node:test'
import assert from 'node:assert/strict'
import { sendForwardBatches } from '../utils/forwardBatches.js'
for (const [count,sizes] of [[0,[]],[100,[100]],[101,[100,1]],[200,[100,100]],[205,[100,100,5]],[400,[100,100,100,100]]]) {
 test(`${count} nodes split without loss in order`, async()=>{
  const nodes=Array.from({length:count},(_,i)=>i);const sent=[]
  const result=await sendForwardBatches(nodes,{makeForward:async batch=>batch,send:async payload=>{sent.push(payload);return {message_id:sent.length}}})
  assert.deepEqual(sent.map(batch=>batch.length),sizes);assert.deepEqual(sent.flat(),nodes);assert.equal(result,sizes.length)
 })
}
test('failure stops following batches and reports progress',async()=>{
 let calls=0
 await assert.rejects(sendForwardBatches(Array(250).fill(1),{makeForward:async batch=>batch,send:async()=> ++calls===2?false:{message_id:calls}}),/已发送 1 份/)
 assert.equal(calls,2)
})

test('actual archive command parser preserves QQ 前后=200 for two forwards', async () => {
 const { readFile } = await import('node:fs/promises')
 const source = await readFile(new URL('../apps/MessageManager.js',import.meta.url),'utf8')
 const start = source.indexOf('    parseArchiveSearch(')
 const end = source.indexOf('    buildArchiveHelp(',start)
 const parse = new Function(`return ({${source.slice(start,end)}}).parseArchiveSearch`)()
 const options = parse('#查聊天记录 群=763694201 qq=3906061530 前后=200',{group_id:123})
 assert.equal(options.limit,200);assert.equal(options.around,0);assert.equal(options.qq,'3906061530')
 const batches=[]
 await sendForwardBatches(Array.from({length:options.limit},(_,i)=>i),{makeForward:async nodes=>nodes,send:async nodes=>{batches.push(nodes);return {message_id:batches.length}}})
 assert.deepEqual(batches.map(nodes=>nodes.length),[100,100])
 const context=parse('#查聊天记录 qq=3906061530 上下文=200 数量=200',{group_id:123})
 assert.equal(context.around,50);assert.equal(context.limit,200)
})

test('archive parser and query support 400 instead of truncating to 200', async()=>{
 const {readFile}=await import('node:fs/promises')
 const source=await readFile(new URL('../apps/MessageManager.js',import.meta.url),'utf8')
 const start=source.indexOf('    parseArchiveSearch('),end=source.indexOf('    buildArchiveHelp(',start)
 const parse=new Function(`return ({${source.slice(start,end)}}).parseArchiveSearch`)()
 for(const command of ['#查聊天记录 qq=123456 前后=400','#查聊天记录 数量=400']) assert.equal(parse(command,{group_id:123}).limit,400)
 const { MessageArchiveManager } = await import('../utils/MessageArchiveManager.js')
 const fs=await import('node:fs/promises'),os=await import('node:os'),path=await import('node:path')
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'archive-limit-'))
 try {
  const manager = new MessageArchiveManager({ cwd: dir, logger: { warn() {} } })
  const groupDir = path.join(manager.getBaseDir(), 'group', '123')
  await fs.mkdir(groupDir, { recursive: true })
  const records = Array.from({ length: 500 }, (_, i) => manager.buildRecord({ message_type: 'group', group_id: 123, user_id: 123, message_id: i + 1, time: 1700000000 + i, message: [{ type: 'text', text: `record-${i}` }] }))
  await fs.writeFile(path.join(groupDir,'2023-11-14.ndjson'),records.map(r=>JSON.stringify(r)).join('\n'))
  const result = await manager.query({ groupId: 123, limit: 400 })
  assert.equal(result.length, 400)
  assert.deepEqual(result.map(item => item.message_id), records.slice(-400).map(item => item.message_id))
 }finally{await fs.rm(dir,{recursive:true,force:true})}
})
