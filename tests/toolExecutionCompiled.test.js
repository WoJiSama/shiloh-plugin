import test from 'node:test'
import assert from 'node:assert/strict'
import { createToolExecution } from '../dist/backend/modules/tools/infrastructure/toolExecution.js'
import { createSemanticToolIntent } from '../dist/backend/modules/tools/infrastructure/semanticToolIntent.js'
const logger={info(){},warn(){},error(){}}

test('compiled executor dispatches MCP and retries local execution once',async()=>{
 const calls=[]
 const api=createToolExecution({logger,mcpManager:{isMCPTool:name=>name==='mcp_test',executeToolByAlias:async(name,params)=>{calls.push([name,params]);return 'remote'}}})
 const host={executeTool:(...args)=>api.executeTool(host,...args)}
 assert.equal(await api.executeTool(host,'mcp_test',{query:'x'},{}),'remote')
 let attempts=0
 const local={async execute(params,event){attempts++;if(attempts===1)throw new Error('temporary');return {params,event}}}
 assert.deepEqual(await api.executeTool(host,local,{value:1},{msg:'test'}),{params:{value:1},event:{msg:'test'}})
 assert.equal(attempts,2)
 assert.deepEqual(calls,[['mcp_test',{query:'x'}]])
})

test('compiled executor rejects malformed argument JSON before executing',async()=>{
 const api=createToolExecution({logger,mcpManager:{isMCPTool:()=>false}})
 const host={toolInstances:{testTool:{execute(){throw new Error('must not execute')}}}}
 const result=await api.runToolCall(host,{type:'function',function:{name:'testTool',arguments:'{' }},{},{tools:[{function:{name:'testTool'}}]})
 assert.match(result.result,/参数 JSON 解析失败/)
})

test('compiled emoji-only personal question continues to grounded text without undefined locals',async()=>{
 let text=''
 const api=createToolExecution({logger,resolveToolRoundLimit:()=>2,resolveEmojiTurnSkips:()=>[false],looksLikeDirectPersonalQuestion:value=>value==='在干嘛\n在干嘛',recordTurnPlanToolOutcome(){},buildChatRequestData:()=>({}),collectThinking(){}})
 const call={id:'one',type:'function',function:{name:'sendLocalEmojiTool',arguments:'{}'}}
 const host={config:{},dedupeToolCalls:c=>c,getToolCallName:c=>c.function.name,normalizeAssistantToolMessage:m=>m,shouldRunTerminalToolsInBackground:()=>false,runToolCall:async c=>({toolCall:c,toolName:'sendLocalEmojiTool',result:'已发送表情'}),isToolResultError:()=>false,buildImageVerificationSearchToolCall:()=>null,retryRequest:async()=>({choices:[{message:{role:'assistant',content:'在陪你聊天'}}]}),handleTextResponse:async value=>{text=value}}
 await api.processToolCalls(host,{tool_calls:[call]},{group_id:'123',msg:'在干嘛'},{rawArgs:'在干嘛'},[],[])
 assert.equal(text,'在陪你聊天')
})

test('compiled planner treats null and malformed JSON as no decision',()=>{
 const api=createSemanticToolIntent({logger})
 assert.equal(api.normalizeToolDecision({},null),null)
 assert.equal(api.extractJsonObject({},'{'),null)
 assert.deepEqual(api.extractJsonObject({},'```json\n{"intent":"chat"}\n```'),{intent:'chat'})
})
