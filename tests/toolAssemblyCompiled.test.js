import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createToolAssembly} from '../dist/backend/modules/tools/infrastructure/toolAssembly.js'
const logger={info(){},warn(){},error(){}}
function setup(extra={}){
 const calls=[],mcpManager={aliases:{size:0},tools:{size:0},getAllTools:()=>[],configure:s=>calls.push(['configure',s]),rememberServerConfig:(name,cfg)=>calls.push(['remember',name,cfg]),connectServer:async(name,cfg)=>{calls.push(['connect',name,cfg]);return true}}
 const api=createToolAssembly({logger,mcpManager,parseToolConfigEntry:entry=>({name:String(entry).replace(/\(dedupe\)$/,'').trim(),dedupe:String(entry).includes('(dedupe)')}),...extra})
 const host={config:{oneapi_tools:['test(dedupe)','sendLocalEmojiTool','waitTool'],emojiSystem:{enabled:false},chatTriggerMode:'strict'},functionMap:new Map(['test','sendLocalEmojiTool','waitTool'].map(name=>[name,{name,description:name,parameters:{type:'object',properties:{}}}])),sessionStore:{refreshTools:tools=>calls.push(['refresh',tools])},syncDedupeToolConfig:(...args)=>api.syncDedupeToolConfig(host,...args),getToolsByName:(...args)=>api.getToolsByName(host,...args),updateToolsList:(...args)=>api.updateToolsList(host,...args),mergeConfigPreserveUser:(defaults,user)=>({...defaults,...user}),mergeMCPConfig:(...args)=>api.mergeMCPConfig(host,...args)}
 return{api,host,calls}
}
test('compiled tool assembly enforces emoji/wait gates and refreshes session tool lists',()=>{
 const {api,host,calls}=setup()
 api.updateToolsList(host)
 assert.deepEqual(host.tools.map(t=>t.function.name),['test','waitTool'])
 assert.deepEqual([...host.dedupeToolNames],['test'])
 assert.equal(calls[0][0],'refresh')
 host.config.emojiSystem.enabled=true
 api.updateToolsList(host)
 assert.equal(host.tools.length,3)
})
test('compiled MCP startup copies defaults and connects only enabled validated servers',async()=>{
 const root=await mkdtemp(join(tmpdir(),'shiloh-mcp-'))
 try{
  await mkdir(join(root,'config_default'))
  await writeFile(join(root,'config_default','mcp-servers.yaml'),'settings:\n  autoReconnect: false\nservers:\n  enabled:\n    enabled: true\n    type: stdio\n    command: fake\n  disabled:\n    enabled: false\n')
  const {api,host,calls}=setup({pluginRoot:root})
  await api.initMCP(host)
  assert.equal(calls.filter(c=>c[0]==='remember').length,2)
  assert.deepEqual(calls.filter(c=>c[0]==='connect').map(c=>c[1]),['enabled'])
  assert.equal(calls.find(c=>c[0]==='configure')[1].autoReconnect,false)
 }finally{await rm(root,{recursive:true,force:true})}
})
test('compiled request recovery retries compatibility failures through injected gateway',async()=>{
 let count=0
 const {api,host}=setup({YTapi:async request=>{count++;return count===1?{error:'thinking mode does not support this tool_choice'}:{choices:[{message:{content:'ok'}}]}}})
 const result=await api.retryRequest(host,{tool_choice:{type:'function',function:{name:'test'}}},'',1)
 assert.equal(count,2)
 assert.equal(result.choices[0].message.content,'ok')
})
