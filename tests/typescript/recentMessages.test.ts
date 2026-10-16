import test from 'node:test'
import assert from 'node:assert/strict'
import { createMessageManagerClass } from '../../src/modules/messaging/application/recentMessages.js'
import type { MessageEvent, RecentMessagePorts } from '../../src/contracts/recentMessages.js'
import type { PersonaScope } from '../../src/contracts/persona.js'
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
 assert.equal((await manager.getMessages('group',42)).find(item=>item.event_id==='9')?.at,109000)
 await manager.recordMessage({...event,event_id:'0'})
 assert.equal((await manager.getMessages('group',42)).length,10)
 assert.equal((await manager.getMessages('group',43)).length,0)
 data.set(manager.getRedisKey('group',42),'[null]')
 await assert.rejects(manager.getMessages('group',42,{throwOnError:true}),/格式无效/)
})

function personaFixture() {
 const data = new Map<string, string>()
 const ports: RecentMessagePorts = {
  redis: {get:async key=>data.get(key) || null,set:async(key,value)=>{data.set(key,value)},del:async(...keys)=>{keys.forEach(key=>data.delete(key))},keys:async()=>[...data.keys()]},
  bot:{uin:1,nickname:'bot'},logger:{info(){},warn(){},error(){}},queue:new KeyedSerialQueue(),scheduleJob(){},getUrl:async()=>({headers:{}}),
  formatTime:time=>new Date(time).toISOString(),parseTime:time=>Date.parse(time),refreshTencentImageUrl:async url=>url,
  enrichBilibiliMessageSegments:async value=>value||[],enrichDouyinMessageSegments:async value=>value||[],
  formatBilibiliHistoryText:()=>'',formatBilibiliHistoryLinks:()=>'',formatDouyinHistoryText:()=>'',formatDouyinHistoryLinks:()=>''
 }
 const Manager = createMessageManagerClass(ports)
 return {manager: new Manager(), data}
}

test('sent messages persist a detached four-field persona source without snapshot configuration', async () => {
 const {manager, data} = personaFixture()
 const expected: PersonaScope = {botId:'1', personaId:'first', personaVersion:'v1', personaName:'甲'}
 const source = {...expected, persona:{name:'甲', privateConfig:'not-history'}, systemContent:'private prompt'}
 const event = {message_type:'group',group_id:42,time:100,sender:{user_id:1,nickname:'bot'},source:'send',personaSource:source,message:[{type:'text',text:'甲的回复'}]}
 const formatted = await manager.recordMessage(event, {throwOnError:true})
 assert.deepEqual(formatted?.personaSource, expected)
 assert.notEqual(formatted?.personaSource, source)
 source.personaVersion = 'v2'
 const stored = (await manager.getMessages('group',42))[0]!
 assert.deepEqual(stored.personaSource, expected)
 const persisted = data.get(manager.getRedisKey('group',42))!
 assert.doesNotMatch(persisted, /privateConfig|private prompt|systemContent/)
 assert.equal(stored.sender.user_id, 1)
})

test('group history retains distinct persona sources and leaves old messages without invented provenance', async () => {
 const {manager} = personaFixture()
 const event = {message_type:'group',group_id:42,time:100,sender:{user_id:1,nickname:'bot'},source:'send',message:[{type:'text',text:'同账号消息'}]}
 const first = {botId:'1',personaId:'first',personaVersion:'v1',personaName:'甲'}
 const second = {...first,personaId:'second',personaName:'乙'}
 const revised = {...first,personaVersion:'v2'}
 await manager.recordMessage({...event,event_id:'legacy'}, {throwOnError:true})
 for (const [index, personaSource] of [first, second, revised].entries()) {
  await manager.recordMessage({...event,event_id:`scoped-${index}`,time:101+index,personaSource}, {throwOnError:true})
 }
 const messages = await manager.getMessages('group',42)
 assert.deepEqual(messages.map(item=>item.personaSource),[revised,second,first,undefined])
 assert.equal(Object.hasOwn(messages[3]!, 'personaSource'),false)
})

test('only complete sources belonging to the sent account are accepted from events or stored history', async () => {
 const {manager, data} = personaFixture()
 const valid: PersonaScope = {botId:'1',personaId:'first',personaVersion:'v1',personaName:'甲'}
 const event = {message_type:'group',group_id:42,time:100,sender:{user_id:1,nickname:'bot'},source:'send',message:[{type:'text',text:'消息'}]}
 const invalidSources: unknown[] = [null,[],{}, {...valid,botId:'2'}, {...valid,botId:1}, {...valid,personaId:''}, {...valid,personaVersion:' '}, {...valid,personaName:''}]
 for (const personaSource of invalidSources) {
  const formatted = await manager.formatMessage({...event,personaSource} as MessageEvent & {sender:{user_id:number;nickname:string}})
  assert.equal(Object.hasOwn(formatted,'personaSource'),false)
 }
 const incoming = await manager.formatMessage({...event,source:'receive',personaSource:valid})
 assert.equal(Object.hasOwn(incoming,'personaSource'),false)
 const legacy = await manager.formatMessage(event)
 const rows = [
  {...legacy,event_id:'valid',personaSource:{...valid,systemContent:'do not return'}},
  {...legacy,event_id:'legacy'},
  ...invalidSources.map((personaSource,index)=>({...legacy,event_id:`invalid-${index}`,personaSource})),
  {...legacy,event_id:'received',source:'receive',personaSource:valid}
 ]
 data.set(manager.getRedisKey('group',42),JSON.stringify(rows))
 const messages = await manager.getMessages('group',42,{throwOnError:true})
 assert.deepEqual(messages.find(item=>item.event_id==='valid')?.personaSource,valid)
 assert.ok(messages.filter(item=>item.event_id!=='valid').every(item=>!Object.hasOwn(item,'personaSource')))
 assert.doesNotMatch(JSON.stringify(messages),/do not return/)
})
