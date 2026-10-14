import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import YAML from 'yaml'
import {decodeHostConfig} from '../dist/backend/modules/host/infrastructure/hostConfig.js'
import {createHostRedisMaintenance,decodeScanResult} from '../dist/backend/modules/host/infrastructure/hostRedisMaintenance.js'
test('compiled host decoder accepts repository defaults and rejects mistyped control fields',()=>{const config=decodeHostConfig(YAML.parse(fs.readFileSync(new URL('../config_default/message.yaml',import.meta.url),'utf8')).pluginSettings);assert.ok(Array.isArray(config.triggerPrefixes));for(const value of [{enabled:'false'},{smartTrigger:{replyDebounceMs:'slow'}},{privateChat:{enabled:'yes'}},{groupMaxMessages:NaN},{allowedGroups:{}},{memorySystem:{enabled:1}}])assert.throws(()=>decodeHostConfig(value));assert.equal(decodeHostConfig({extension:{custom:true}}).extension.custom,true)})
test('compiled redis maintenance handles object and tuple scan and preserves fresh tasks',async()=>{assert.deepEqual(decodeScanResult(['0',['a']]),{cursor:'0',keys:['a']});assert.deepEqual(decodeScanResult({cursor:0,keys:['a']}),{cursor:'0',keys:['a']});assert.throws(()=>decodeScanResult({cursor:'0',keys:[1]}));const data=new Map([['task:old',JSON.stringify({status:'running',updatedAt:1})],['task:new',JSON.stringify({status:'running',updatedAt:Date.now()})]]);const api=createHostRedisMaintenance({get:async k=>data.get(k)||null,set:async(k,v)=>data.set(k,v),del:async(...keys)=>keys.forEach(k=>data.delete(k)),keys:async()=>[],scan:async(_c,{MATCH})=>({cursor:0,keys:[...data.keys()].filter(k=>k.startsWith(MATCH.slice(0,-1)))})},{warn(){},info(){}});assert.equal((await api.markStaleToolTasksFailed({taskPrefix:'task:',activePrefix:'active:',staleMinutes:1,ttlSeconds:60})).marked,1);assert.equal(JSON.parse(data.get('task:old')).status,'tool_failed');assert.equal(JSON.parse(data.get('task:new')).status,'running')})
test('host decoder normalizes optional object nulls without leaking null into typed runtime',()=>{
 const input={privateChat:null,persona:null,memorySystem:null,taskAiConfig:null,emotionSystem:null,chatAiConfig:null};const decoded=decodeHostConfig(input);for(const key of Object.keys(input))assert.equal(decoded[key],undefined);assert.equal(input.privateChat,null)
})
test('host decoder validates nested memory backends and task secrets before runtime use',()=>{
 for(const input of [
  {memorySystem:{memoryAiConfig:{memoryAiUrl:42}}},
  {memorySystem:{memoryAiConfig:{memoryAiApikey:['unsupported-array']}}},
  {memorySystem:{embeddingAiConfig:{embeddingApiKey:{secret:'invalid'}}}},
  {taskAiConfig:{translation:{apiKey:7}}},
  {taskAiConfig:{translation:{apiKey:['valid',3]}}},
  {taskAiConfig:{translation:null}},
  {taskAiConfig:{translation:{complexity:{score:Infinity,signals:[]}}}},
  {chatAiConfig:{chatApiUrl:null}}
 ])assert.throws(()=>decodeHostConfig(input))
 const valid=decodeHostConfig({memorySystem:{memoryAiConfig:{memoryAiApikey:'secret'}},taskAiConfig:{translation:{apiKey:['a','b'],maxOutputTokens:300,complexity:{score:1,signals:['short']}}}});assert.deepEqual(valid.taskAiConfig.translation.apiKey,['a','b']);assert.equal(valid.memorySystem.memoryAiConfig.memoryAiApikey,'secret')
})
