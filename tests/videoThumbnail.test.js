import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { createVideoThumbnail } from '../utils/messagePipeline/videoThumbnail.js'
import { DeliveryGateway } from '../utils/messagePipeline/deliveryGateway.js'

test('generated thumbnail lives until delivery cleanup', async () => {
  const thumbnail = await createVideoThumbnail('/tmp/input.mp4', { runner: async (exe,args,opts) => {
    assert.equal(exe,'ffmpeg'); assert.equal(opts.timeout,30000)
    await fs.writeFile(args.at(-1), 'jpeg')
  } })
  assert.equal(await fs.readFile(thumbnail.file,'utf8'),'jpeg')
  await thumbnail.cleanup()
  await assert.rejects(fs.stat(thumbnail.file))
})
test('thumbnail generation failure reports known error', async () => {
  await assert.rejects(createVideoThumbnail('/tmp/input.mp4', { runner: async () => { throw new Error('ffmpeg unavailable') } }), /video_thumbnail_missing/)
})
test('same account forwards serialize across groups; different accounts proceed', async () => {
  let release; let started
  const gate = new Promise(resolve => { release=resolve })
  const seen = []
  const signal = new Promise(resolve => { started=resolve })
  const bot = { async sendApi(api,args) { seen.push(args.group_id); if(args.group_id===1) { started(); await gate }; return {retcode:0,data:{message_id:args.group_id}} } }
  const gateway = new DeliveryGateway({ botRoot: () => ({bots:{a:bot,b:bot}}) })
  const a=gateway.sendGroupForward({botId:'a',groupId:1,nodes:[]}); await signal
  const b=gateway.sendGroupForward({botId:'a',groupId:2,nodes:[]})
  await gateway.sendGroupForward({botId:'b',groupId:3,nodes:[]})
  assert.deepEqual(seen,[1,3]); release(); await Promise.all([a,b]); assert.deepEqual(seen,[1,3,2])
})
test('explicit preprocessing failure is certain; text fallback uses ordinary send', async () => {
  const seen=[]
  const gateway=new DeliveryGateway({botRoot:()=>({sendApi:async(api,args)=>{seen.push(api); if(api==='send_group_forward_msg') throw new Error('上传转发消息资源失败：1/2'); return {retcode:0,data:{message_id:1}}}})})
  await assert.rejects(gateway.sendGroupForward({botId:1,groupId:2,nodes:[]}), error=>error.uncertain===false)
  await gateway.sendGroupText({botId:1,groupId:2,text:'link'})
  assert.deepEqual(seen,['send_group_forward_msg','send_group_msg'])
})
