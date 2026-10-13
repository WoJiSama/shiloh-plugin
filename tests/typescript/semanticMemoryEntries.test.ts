import test from 'node:test'
import assert from 'node:assert/strict'
import {createSemanticMemoryCommands} from '../../src/modules/memory/infrastructure/semanticMemoryCommands.js'
import {createSemanticMemoryWebApp} from '../../src/modules/memory/infrastructure/semanticMemoryWebApp.js'
test('semantic command rejects non-owner before accessing runtime and reports unavailable to owner',async()=>{
 let reads=0;const replies:string[]=[]
 const {SemanticMemoryPlugin}=createSemanticMemoryCommands({PluginBase:class{},getSemanticMemoryRuntime:()=>{reads++;return null},buildVisibleFailureDetail:String,logger:{info(){},error(){}}})
 const command=new SemanticMemoryPlugin()
 await command.handleCommand({msg:'.语义记忆 状态',reply:message=>replies.push(message)})
 assert.equal(reads,0);assert.match(replies[0]!,/仅主人或群主/)
 await command.handleCommand({msg:'.语义记忆 状态',isMaster:true,reply:message=>replies.push(message)})
 assert.equal(reads,1);assert.match(replies[1]!,/未启用/)
})
test('semantic HTTP endpoint checks token and returns unavailable without runtime',async()=>{
 const web=createSemanticMemoryWebApp(()=>null)
 type Handler=Parameters<Parameters<typeof web.registerSemanticMemoryWebApp>[0]['use']>[1]
 let handler:Handler|undefined;let status=200;let payload:unknown
 web.registerSemanticMemoryWebApp({use(_path,callback){handler=callback}},'/fixture',{token:'secret'})
 const response={set(){return this},status(value:number){status=value;return this},json(value:unknown){payload=value},type(){return this},send(){}}
 await handler!({path:'/api/playground',method:'GET',query:{},headers:{}},response,()=>{})
 assert.equal(status,401)
 await handler!({path:'/api/playground',method:'GET',query:{token:'secret'},headers:{}},response,()=>{})
 assert.equal(status,503);assert.deepEqual(payload,{error:'语义记忆未启用'})
})
