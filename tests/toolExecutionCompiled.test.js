import test from 'node:test'
import assert from 'node:assert/strict'
import { createToolExecution } from '../dist/backend/modules/tools/infrastructure/toolExecution.js'
import { createSemanticToolIntent } from '../dist/backend/modules/tools/infrastructure/semanticToolIntent.js'
import {buildTurnInteractionContext} from '../dist/backend/modules/conversation/domain/turnInteractionContext.js'
import {buildDiagnosticContext} from '../dist/backend/modules/conversation/domain/diagnosticContext.js'
import {createTurnSessionStore} from '../utils/turnSession.js'
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

test('actual perception resolves a picture joke in the existing continuation request', async () => {
  const requests=[],replies=[]
  const api=createToolExecution({logger,resolveToolRoundLimit:()=>2,resolveEmojiTurnSkips:()=>[false],recordTurnPlanToolOutcome(){},buildChatRequestData:(_config,messages)=>{requests.push(structuredClone(messages));return{}},collectThinking(){}})
  const call={id:'read-image',type:'function',function:{name:'googleImageAnalysisTool',arguments:'{}'}}
  const session={rawUserText:'这个',interactionContext:buildTurnInteractionContext({rawUserText:'这个',botId:99,evidence:[{origin:'current',kind:'image',state:'reference_only',source:'https://example.invalid/image.png'}]})}
  const host={config:{},dedupeToolCalls:c=>c,getToolCallName:c=>c.function.name,normalizeAssistantToolMessage:m=>m,shouldRunTerminalToolsInBackground:()=>false,runToolCall:async c=>({toolCall:c,toolName:'googleImageAnalysisTool',result:'图中文字：本地模型才跑十分钟就开始散发赛博香水了。'}),isToolResultError:()=>false,buildImageVerificationSearchToolCall:()=>null,retryRequest:async()=>({choices:[{message:{role:'assistant',content:'这香水预热真快。'}}]}),handleTextResponse:async(text,_event,current)=>replies.push({text,context:current.interactionContext})}
  await api.processToolCalls(host,{tool_calls:[call]},{group_id:'123',msg:'这个'},session,[],[])
  assert.equal(requests.length,1,'only the existing tool summary request is used')
  assert.equal(session.interactionContext.kind,'banter')
  assert.ok(session.interactionContext.evidence.some(item=>item.origin==='tool' && item.state==='readable' && item.text.includes('十分钟')))
  assert.equal(replies[0].context,session.interactionContext)
  const updated=requests[0].filter(message=>message.role==='system').map(message=>message.content).join('\n')
  assert.match(updated,/【本轮互动】/)
  assert.match(updated,/十分钟/)
  assert.match(updated,/本轮是普通群聊/)
  assert.doesNotMatch(updated,/【希洛场景口吻】/,'a perception update must not introduce a default persona')
})

test('media evidence uses shared success/empty classification, preserving readable OCR words', async () => {
  for (const [result, state] of [
    ['{}', 'unavailable'],
    ['{"kind":"tool_outcome","status":"empty"}', 'unavailable'],
    ['{"kind":"tool_outcome","status":"not_found"}', 'unavailable'],
    ['{"analysis":"图中文字：错误地把机箱当电子香薰。"}', 'readable']
  ]) {
    const requests=[],sent=[]
    const api=createToolExecution({logger,resolveToolRoundLimit:()=>2,resolveEmojiTurnSkips:()=>[false],recordTurnPlanToolOutcome(){},buildChatRequestData:(_config,messages)=>{requests.push(structuredClone(messages));return{}},collectThinking(){}})
    const call={id:'perception',type:'function',function:{name:'googleImageAnalysisTool',arguments:'{}'}}
    const session={rawUserText:'这个',interactionContext:buildTurnInteractionContext({rawUserText:'这个'})}
    const host={config:{},dedupeToolCalls:c=>c,getToolCallName:c=>c.function.name,normalizeAssistantToolMessage:m=>m,shouldRunTerminalToolsInBackground:()=>false,runToolCall:async c=>({toolCall:c,toolName:'googleImageAnalysisTool',result}),isToolResultError:value=>value.includes('错误'),buildImageVerificationSearchToolCall:()=>null,retryRequest:async()=>({choices:[{message:{content:'这是图中文字。'}}]}),handleTextResponse:async text=>sent.push(text),handleToolFailureResponse:async()=>{}}
    await api.processToolCalls(host,{tool_calls:[call]},{msg:'这个'},session,[],[])
    const evidence=session.interactionContext.evidence.find(item=>item.toolCallId==='perception')
    assert.equal(evidence.state,state,result)
    if (state==='readable') {
      assert.equal(evidence.text,'图中文字：错误地把机箱当电子香薰。')
      const update=requests[0].find(message=>message.role==='system' && message.content.includes('【媒体证据已更新】')).content
      assert.match(update,/具体动作的结果/,'continuation and final guards use the same operational mode for ordinary analysis')
      assert.doesNotMatch(update,/【希洛场景口吻】/)
    } else assert.equal(requests.length,0,'unusable tool results retain the existing factual failure path')
  }
})

test('tool continuation refreshes actual action facts while preserving diagnostic context',async()=>{
 const requests=[],queries=[]
 const api=createToolExecution({logger,resolveToolRoundLimit:()=>2,resolveEmojiTurnSkips:()=>[false],recordTurnPlanToolOutcome(){},buildChatRequestData:(_config,messages)=>{requests.push(structuredClone(messages));return{}},collectThinking(){}})
 const call={id:'schedule',type:'function',function:{name:'reminderTool',arguments:'{}'}}
 const diagnosticContext=buildDiagnosticContext({rawUserText:'我的电脑有焦味，已经拔掉电源了',speakerId:'20'})
 assert.ok(diagnosticContext)
 const session={rawUserText:'好了发我',interactionContext:{...buildTurnInteractionContext({rawUserText:'好了发我',botId:99}),diagnosticContext}}
 const facts={scope:{botId:'99',conversationId:'group:10',userId:'20'},observedAt:Date.now(),lookup:'ok',tasks:[{taskId:'reminder-1',requestMessageId:'30',toolName:'reminderTool',source:'reminder',observedAt:Date.now(),execution:'queued',result:'unknown',delivery:{state:'not_attempted'},followUp:{state:'registered',kind:'reminder',id:'reminder-1',dueAt:Date.now()+600000}}]}
 const host={config:{},dedupeToolCalls:c=>c,getToolCallName:c=>c.function.name,normalizeAssistantToolMessage:m=>m,shouldRunTerminalToolsInBackground:()=>false,runToolCall:async c=>({toolCall:c,toolName:'reminderTool',result:'提醒已创建'}),isToolResultError:()=>false,buildImageVerificationSearchToolCall:()=>null,getTurnActionFacts:async(e,q)=>{queries.push([e,q]);return facts},retryRequest:async()=>({choices:[{message:{content:'已登记提醒。'}}]}),handleTextResponse:async()=>{}}
 const e={self_id:99,group_id:10,user_id:20,message_id:30,msg:'好了发我'}
 await api.processToolCalls(host,{tool_calls:[call]},e,session,[],[])
 assert.equal(queries.length,1)
 assert.deepEqual(queries[0][1].recentRequestMessageIds,['30'])
 assert.equal(session.interactionContext.actionFacts.tasks[0].followUp.id,'reminder-1')
 assert.equal(session.interactionContext.diagnosticContext,diagnosticContext)
 const prompt=requests[0].filter(row=>row.role==='system').map(row=>row.content).join('\n')
 assert.match(prompt,/【任务事实已更新】/);assert.match(prompt,/已核验提醒登记 reminder-1/)
})

test('actual tool executor passes bot identity into dedupe and never infers result or delivery from success text',async()=>{
 const statuses=[],seen=[];let release
 const gate=new Promise(resolve=>{release=resolve})
 const api=createToolExecution({logger,mcpManager:{isMCPTool:()=>false},formatTurnPlanLog:()=>'',recordTurnPlanToolOutcome(){}})
 const host={config:{},toolInstances:{fixtureTool:{execute:async()=>''}},getToolCallName:c=>c.function.name,isDedupeTool:()=>true,getToolRunKey:(g,u,name,e)=>{seen.push(e.self_id);return `${e.self_id}:${g}:${u}:${name}`},saveTaskStatus:async value=>statuses.push(value),serializeToolResult:value=>value,isRawToolFailure:()=>false,isToolResultError:()=>false,executeTool:async()=>{await gate;return '执行成功'}}
 const call={id:'fixture',type:'function',function:{name:'fixtureTool',arguments:'{}'}},session=()=>({tools:[{function:{name:'fixtureTool'}}]})
 const first=api.runToolCall(host,call,{self_id:99,group_id:10,user_id:20,message_id:30},session())
 const second=api.runToolCall(host,{...call,id:'second'},{self_id:98,group_id:10,user_id:20,message_id:30},session())
 release();const results=await Promise.all([first,second])
 assert.deepEqual(seen,[99,98]);assert.equal(results.filter(result=>result.result==='执行成功').length,2)
 for(const status of statuses.filter(value=>value.status==='tool_success')){assert.equal(status.actionFacts.result,'unknown');assert.equal(status.actionFacts.delivery.state,'unknown');assert.equal(status.actionFacts.execution,'completed')}
})

test('uncertain delivery errors are not retried by the shared tool executor',async()=>{
 let attempts=0
 const api=createToolExecution({logger,mcpManager:{isMCPTool:()=>false}}),host={executeTool:(...args)=>api.executeTool(host,...args)}
 await assert.rejects(api.executeTool(host,{execute:async()=>{attempts++;throw Object.assign(Error('lost receipt'),{uncertain:true})}},{},{}),/lost receipt/)
 assert.equal(attempts,1)
})

function scopedExecutorFixture(tools) {
  const executions = [], requests = [], sent = []
  const controls = {afterExecute: async () => {}, responses: []}
  const store = createTurnSessionStore()
  const session = store.getOrCreate('in-flight', tools)
  const executeNamed = async (name, params) => {
    executions.push({name, params})
    await controls.afterExecute(name, params)
    return name === 'googleImageAnalysisTool' ? 'OCR：杭州地铁10月15日运行公告' : `${name}第${params.page || 1}页结果`
  }
  const api = createToolExecution({logger, resolveToolRoundLimit: () => 4, resolveEmojiTurnSkips: names => names.map(() => false),
    mcpManager: {isMCPTool: name => name.startsWith('mcp_'), executeToolByAlias: executeNamed},
    recordTurnPlanToolOutcome() {}, collectThinking() {}, formatTurnPlanLog: () => '', buildAgentProgressContext: () => '',
    buildChatRequestData: (_config, messages, requestTools, choice) => {
      const request = {messages, tools: requestTools, tool_choice: choice}
      requests.push(structuredClone(request))
      return request
    }})
  const host = {config: {}, toolInstances: Object.fromEntries(['googleImageAnalysisTool', 'searchInformationTool', 'unrelatedTool'].map(name => [name, {execute: params => executeNamed(name, params)}])),
    getToolCallName: call => call.function.name, dedupeToolCalls: calls => calls, normalizeAssistantToolMessage: message => message,
    shouldRunTerminalToolsInBackground: () => false, isDedupeTool: () => false,
    serializeToolResult: value => String(value), isRawToolFailure: value => /^error:/i.test(value), isToolResultError: value => /^error:/i.test(value),
    buildGroundedImageAnalysisPrompt: prompt => prompt || '读取图片', extractToolResultText: value => String(value),
    buildForcedToolCall: (name, params) => ({id: `call-${executions.length}`, type: 'function', function: {name, arguments: JSON.stringify(params)}}),
    retryRequest: async () => ({choices: [{message: controls.responses.shift() || {content: '已取得当前结果。'}}]}),
    handleTextResponse: async text => sent.push(text), handleToolFailureResponse: async () => { throw Error('unexpected failure summary') }}
  host.executeTool = (...args) => api.executeTool(host, ...args)
  host.runToolCall = (...args) => api.runToolCall(host, ...args)
  host.buildImageVerificationSearchToolCall = (...args) => api.buildImageVerificationSearchToolCall(host, ...args)
  return {api, host, store, session, controls, executions, requests, sent}
}
const scopedDefinition = name => ({type: 'function', function: {name, parameters: {type: 'object', properties: {page: {type: 'integer'}}, required: ['page']}}})

test('vision-to-search keeps its original authorized scope across a real registry refresh', async () => {
  const initial = ['googleImageAnalysisTool', 'searchInformationTool'].map(scopedDefinition)
  const f = scopedExecutorFixture(initial)
  f.session.imageVerificationNeedsSearch = true
  f.controls.afterExecute = async name => {
    if (name === 'googleImageAnalysisTool') {
      await Promise.resolve()
      f.store.refreshTools([scopedDefinition('unrelatedTool')])
    }
  }
  await f.api.processToolCalls(f.host, {tool_calls: [f.host.buildForcedToolCall('googleImageAnalysisTool', {images: ['fixture.png']})]}, {msg: '查一下这个消息是真的吗'}, f.session, [], [], undefined, {syntheticToolCall: true})
  assert.deepEqual(f.executions.map(row => row.name), ['googleImageAnalysisTool', 'searchInformationTool'])
  assert.match(f.executions[1].params.query, /OCR：杭州地铁10月15日运行公告/)
  assert.equal(f.session.imageVerificationSearchDone, true)
  assert.deepEqual(f.session.executionTools, initial)
  assert.deepEqual(f.sent, ['已取得当前结果。'])
  assert.deepEqual(f.requests[0].tools, [], 'synthetic calls summarize without another tool model round')
})

test('registry refresh cannot add auto-search to a vision-only execution', async () => {
  const initial = [scopedDefinition('googleImageAnalysisTool')]
  const f = scopedExecutorFixture(initial)
  f.session.imageVerificationNeedsSearch = true
  f.controls.afterExecute = async () => { await Promise.resolve(); f.store.refreshTools([...initial, scopedDefinition('searchInformationTool')]) }
  await f.api.processToolCalls(f.host, {tool_calls: [f.host.buildForcedToolCall('googleImageAnalysisTool', {})]}, {msg: '这是什么'}, f.session, [], [], undefined, {syntheticToolCall: true})
  assert.deepEqual(f.executions.map(row => row.name), ['googleImageAnalysisTool'])
  assert.equal(f.session.imageVerificationSearchDone, undefined)
  assert.deepEqual(f.session.executionTools, initial)
  const denied = await f.api.runToolCall(f.host, f.host.buildForcedToolCall('searchInformationTool', {query: '新增动作'}), {}, f.session)
  assert.match(denied.result, /not available in this session/)
  assert.equal(f.executions.length, 1)
})

test('MCP native continuation keeps the original alias and schema while rejecting refreshed tools', async () => {
  const mcp = scopedDefinition('mcp_fixture_pages')
  mcp.function.parameters.properties.filter = {type: 'object', properties: {category: {type: 'string', enum: ['A', 'B']}}}
  const f = scopedExecutorFixture([mcp])
  f.controls.afterExecute = async () => { await Promise.resolve(); f.store.refreshTools([mcp, scopedDefinition('unrelatedTool')]) }
  f.controls.responses = [{tool_calls: [f.host.buildForcedToolCall(mcp.function.name, {page: 2}), f.host.buildForcedToolCall('unrelatedTool', {})]}, {content: '两页结果已取得。'}]
  await f.api.processToolCalls(f.host, {tool_calls: [f.host.buildForcedToolCall(mcp.function.name, {page: 1})]}, {}, f.session, [], [])
  assert.deepEqual(f.executions.map(row => [row.name, row.params.page]), [[mcp.function.name, 1], [mcp.function.name, 2]])
  assert.equal(f.requests.length, 2)
  for (const request of f.requests) assert.deepEqual(request.tools, [mcp])
  assert.deepEqual(f.sent, ['两页结果已取得。'])
})
