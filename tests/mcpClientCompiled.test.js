import test from 'node:test'
import assert from 'node:assert/strict'
import {MCPClientManager} from '../dist/backend/modules/tools/infrastructure/MCPClient.js'

test('MCP compiled schema resolves refs and strips unsupported schema syntax',()=>{
 const manager=new MCPClientManager()
 const schema=manager.prepareInputSchema({type:'object',$defs:{mode:{type:'string',enum:['safe','fast'],default:'safe'}},properties:{mode:{$ref:'#/$defs/mode'},limit:{anyOf:[{type:'integer',enum:[1,2]},{type:'null'}]}},required:['mode','absent'],additionalProperties:false})
 assert.deepEqual(schema,{type:'object',properties:{mode:{type:'string',enum:['safe','fast']},limit:{type:'integer',description:'可选值：1、2'}},required:['mode']})
})

test('MCP compiled registry respects include/exclude, aliases, live notifications',async()=>{
 const manager=new MCPClientManager()
 let notifications=0
 manager.setToolsChangedCallback(()=>notifications++)
 manager.rememberServerConfig('group server',{enabled:true})
 await manager.refreshServerToolsFromNotification('group server',[
  {name:'allowed',inputSchema:{type:'object'}},
  {name:'excluded',inputSchema:{type:'object'}}
 ],{excludeTools:['excluded']})
 assert.equal(manager.getAllTools().length,1)
 assert.equal(manager.getAllTools()[0].function.name,'mcp_group_server_allowed')
 assert.equal(manager.getToolServer('mcp_group_server_allowed'),'group server')
 assert.equal(manager.getServersInfo()[0].toolCount,1)
 assert.equal(notifications,1)
 await manager.refreshServerToolsFromNotification('group server',[])
 assert.equal(manager.getAllTools().length,0)
})

test('MCP compiled execution preserves real names and structured results; batch isolates failures',async()=>{
 const manager=new MCPClientManager()
 const calls=[]
 manager.clients.set('server',{client:{async callTool(input){calls.push(input);return {content:[{type:'text',text:'hello'}],structuredContent:{count:1}}}},config:{},type:'fake'})
 await manager.refreshServerToolsFromNotification('server',[{name:'actual-name',inputSchema:{type:'object'}}])
 const alias=manager.getAllTools()[0].function.name
 const results=await manager.executeToolsBatch([{name:alias,args:{count:1}},{name:'mcp_missing'}])
 assert.equal(results[0].success,true)
 assert.match(results[0].result,/structuredContent: {"count":1}\nhello/)
 assert.equal(results[1].success,false)
 assert.match(results[1].error,/工具不存在/)
 assert.deepEqual(calls,[{name:'actual-name',arguments:{count:1}}])
})

test('MCP compiled close clears live tools and stale reconnect tokens cannot reconnect',async()=>{
 const manager=new MCPClientManager()
 manager.rememberServerConfig('server',{enabled:true})
 await manager.refreshServerToolsFromNotification('server',[{name:'tool',inputSchema:{type:'object'}}])
 manager.reloadToken=2
 manager.handleUnexpectedClose('server',1)
 assert.equal(manager.getAllTools().length,0)
 assert.equal(manager.reconnectTimers.size,0)
 await manager.disconnectAll()
 assert.equal(manager.serverConfigs.size,0)
})

test('MCP compiled transport factory gets cleaned HTTP headers without connecting',()=>{
 let observed
 const transport={start:async()=>{},close:async()=>{},send:async()=>{}}
 const manager=new MCPClientManager(undefined,(url,options)=>{observed={url:String(url),options};return transport})
 assert.equal(manager.createTransport('server',{type:'http',baseUrl:'https://example.invalid/mcp',headers:{Authorization:'"Bearer test"'}}),transport)
 assert.equal(observed.options.requestInit.headers.Authorization,'Bearer test')
 assert.equal(observed.url,'https://example.invalid/mcp')
})

test('MCP compiled prompt filters and result truncation preserve public behavior',()=>{
 const manager=new MCPClientManager()
 manager.serverConfigs.set('server',{connected:true,systemPrompt:'Rule',promptConditions:{groups:['123'],keywords:['help']}})
 assert.match(manager.getMCPSystemPrompts({groupId:'123',message:'HELP me'}),/Rule/)
 assert.equal(manager.getMCPSystemPrompts({groupId:'456',message:'help'}),'')
 assert.match(manager.formatMCPResultForModel({isError:true,content:[{type:'image',mimeType:'image/png'}]}),/error: MCP 工具返回错误/)
 assert.match(manager.formatMCPResultForModel('a'.repeat(200),100),/已截断/)
})
