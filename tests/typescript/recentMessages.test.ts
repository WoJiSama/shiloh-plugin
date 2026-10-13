import test from 'node:test'
import assert from 'node:assert/strict'
import { createMessageManagerClass } from '../../src/modules/messaging/application/recentMessages.js'
import type { RecentMessagePorts } from '../../src/contracts/recentMessages.js'
import { KeyedSerialQueue } from '../../src/modules/messaging/infrastructure/keyedSerialQueue.js'

test('compiled recent-message manager serializes concurrent writes and deduplicates events', async () => {
 const data = new Map<string,string>()
 const ports: RecentMessagePorts = {
  redis: {get:async key=>data.get(key) || null,set:async(key,value)=>{data.set(key,value)},del:async(...keys)=>{keys.forEach(key=>data.delete(key))},keys:async()=>[...data.keys()]},
  bot:{uin:1,nickname:'bot'},logger:{info(){},warn(){},error(){}},queue:new KeyedSerialQueue(),scheduleJob(){},getUrl:async()=>({headers:{}}),
  formatTime:time=>new Date(time).toISOString(),parseTime:time=>Date.parse(time),refreshTencentImageUrl:async url=>url,
  enrichBilibiliMessageSegments:async value=>value||[],enrichDouyinMessageSegments:async value=>value||[],
  formatBilibiliHistoryText:()=>'',formatBilibiliHistoryLinks:()=>'',formatDouyinHistoryText:()=>'',formatDouyinHistoryLinks:()=>''
 }
 const Manager = createMessageManagerClass(ports), manager = new Manager({groupMaxMessages:10})
 const event = {message_type:'group',group_id:42,time:100,sender:{user_id:2,nickname:'user'},message:[{type:'text',text:'hello'}]}
 await Promise.all(Array.from({length:10},(_,i)=>manager.recordMessage({...event,event_id:String(i),time:100+i})))
 assert.equal((await manager.getMessages('group',42)).length,10)
 await manager.recordMessage({...event,event_id:'0'})
 assert.equal((await manager.getMessages('group',42)).length,10)
 assert.equal((await manager.getMessages('group',43)).length,0)
 data.set(manager.getRedisKey('group',42),'[null]')
 await assert.rejects(manager.getMessages('group',42,{throwOnError:true}),/格式无效/)
})
