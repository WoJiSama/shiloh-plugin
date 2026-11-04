import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createEmotionManagerClass} from '../dist/backend/modules/memory/application/emotionManager.js'
import {createPersonProfileClass} from '../dist/backend/modules/memory/application/personProfileInjector.js'

test('emotion persistence isolates bots and rejects malformed stored state', async () => {
 const data=new Map(), errors=[]
 const Emotion=createEmotionManagerClass({store:{get:async key=>data.get(key)||null,set:async(key,value)=>data.set(key,value)},logger:{error:message=>errors.push(message),debug:()=>{}}})
 const manager=new Emotion()
 await manager.saveEmotion('group',{mood:0.9,energy:0.4,lastUpdate:Date.now(),recentEvents:[]},'bot-a')
 assert.equal((await manager.getEmotion('group','bot-a')).mood,0.9)
 assert.equal((await manager.getEmotion('group','bot-b')).mood,0.6)
 data.set(manager.getRedisKey('group','bot-b'),'{"mood":"bad","energy":0.2}')
 assert.equal((await manager.getEmotion('group','bot-b')).mood,0.6)
 assert.equal(errors.length,1)
})

test('profile keeps current speaker messages without duplicating own persona',async()=>{
 const Profile=createPersonProfileClass({getConfig:()=>({personProfileInjection:{enabled:true},persona:{enabled:true,name:'default'}}),getPersonaFor:()=>({enabled:true,name:'group persona'}),getMessages:async()=>[{sender:{user_id:7},raw_message:'my recent message'},{sender:{user_id:8},raw_message:'other private context'}]})
 const result=await new Profile().build('group',7,{sender:{nickname:'speaker'}})
 assert.doesNotMatch(result,/group persona|固定人设/)
 assert.match(result,/my recent message/)
 assert.doesNotMatch(result,/default|other private context/)
})

test('profile injects cross-group learned profile and degrades without it',async()=>{
 const seen=[]
 const withProfile=createPersonProfileClass({getConfig:()=>({personProfileInjection:{enabled:true}}),getPersonaFor:()=>null,getMessages:async()=>[],getCrossGroupProfile:async id=>{seen.push(id);return {name:'小鱼',interests:['明日方舟'],taboos:['别叫全名']}}})
 const text=await new withProfile().build('group',7,{sender:{nickname:'speaker'}})
 assert.equal(String(seen[0]),'7','按 QQ 读档案')
 assert.match(text,/跨群档案: 称呼「小鱼」/)
 assert.match(text,/明日方舟/)
 assert.doesNotMatch(text,/speaker：/, '展示名前缀不重复')

 const noPort=createPersonProfileClass({getConfig:()=>({personProfileInjection:{enabled:true}}),getPersonaFor:()=>null,getMessages:async()=>[{sender:{user_id:7},raw_message:'hi'}]})
 const plain=await new noPort().build('group',7,{sender:{nickname:'speaker'}})
 assert.doesNotMatch(plain,/跨群档案/,'无端口/无档案时不注入')

 const broken=createPersonProfileClass({getConfig:()=>({personProfileInjection:{enabled:true}}),getPersonaFor:()=>null,getMessages:async()=>[],getCrossGroupProfile:async()=>{throw new Error('redis down')}})
 const degraded=await new broken().build('group',7,{sender:{nickname:'speaker'}})
 assert.doesNotMatch(degraded,/跨群档案/,'读取失败静默降级')
})
