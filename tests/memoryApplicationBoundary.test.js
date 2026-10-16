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
