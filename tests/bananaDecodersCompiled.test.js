import test from 'node:test'
import assert from 'node:assert/strict'
import {parseDrawRecord,parseDrawOptions,parseDrawEvent} from '../dist/backend/modules/toolSupport/infrastructure/bananaDecoders.js'
import {BananaTool} from './helpers/bananaFixture.js'
test('durable draw decoder rejects malformed records and filters reference images',()=>{
 assert.equal(parseDrawRecord(null),null)
 assert.equal(parseDrawRecord({id:'job'}),null)
 const result=parseDrawRecord({id:'job',scopeKey:'group:123',opts:{prompt:'draw',images:['https://img',123,null]}})
 assert.deepEqual(result.opts.images,['https://img'])
 assert.deepEqual(parseDrawOptions({prompt:123,images:42}),{})
 assert.throws(()=>parseDrawEvent({reply:42}),/reply/)
})
test('compiled queue removes malformed persistent jobs without attempting provider calls',async()=>{
 const previous=globalThis.redis,values=new Map([['ytbot:image_draw_job:bad','{"unrelated":true}'],['ytbot:image_draw_queue:group:invalid','["bad"]']])
 globalThis.redis={get:async key=>values.get(key)||null,set:async(key,value)=>values.set(key,value),del:async key=>values.delete(key)}
 try{const tool=new BananaTool();await tool.processDurableDrawQueue('group:invalid');assert.equal(values.has('ytbot:image_draw_queue:group:invalid'),false);assert.equal(tool.getDrawQueueState('group:invalid').activeTask,null)}finally{globalThis.redis=previous}
})
