import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTurnTraceReport, collectTurnTraceRecords, formatTurnTraceReport } from '../dist/backend/scripts/turnTraceReport.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
test('aggregates malformed-safe trace records',()=>{
 const report=buildTurnTraceReport([{turnId:'a',intent:{kind:'chat',source:'fast_path_skip'},modelCalls:[{stage:'reply',ms:10}],tools:[{name:'x',ok:false}],failures:[{stage:'model'}],outbound:2,totalMs:20},{bad:true},null])
 assert.equal(report.turns,1); assert.equal(report.fastPathSkipCount,1); assert.equal(report.tools.failures,1); assert.deepEqual(report.modelStages.reply,{count:1,avg:10,p50:10,p95:10}); assert.match(formatTurnTraceReport(report),/回合数: 1/)
})
test('collects valid NDJSON and skips malformed lines',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'trace-report-')); try { const file=path.join(dir,'x.ndjson'); fs.writeFileSync(file,'{"turnId":"ok"}\nnot-json\n{"x":1}\n'); const out=collectTurnTraceRecords([file]); assert.equal(out.fileCount,1); assert.equal(out.records.length,2) } finally { fs.rmSync(dir,{recursive:true,force:true}) }
})

test('legacy report export keeps tuple API used by console',async()=>{
 const legacy=await import('../scripts/turn-trace-report.mjs')
 const report=legacy.buildTurnTraceReport([{turnId:'x',intent:{kind:'chat'},trigger:{mode:'strict'},route:{mode:'chat',profile:'casual'},tools:[{name:'tool',ok:false}],failures:[{stage:'send'}]}])
 assert.deepEqual(report.intents,[['chat',1]])
 assert.deepEqual(report.triggers,[['strict',1]])
 assert.deepEqual(report.routes,[['chat/casual',1]])
 assert.deepEqual(report.tools.topFailures,[['tool',1]])
 assert.deepEqual(report.failureStages,[['send',1]])
 assert.match(legacy.formatTurnTraceReport(report),/chat: 1/)
})

test('empty route and partial trace objects retain legacy grouping labels', () => {
 const report = buildTurnTraceReport([{turnId:'a', route:{mode:'',profile:''}, intent:{kind:''}}, {turnId:'b', route:{mode:'chat'}, intent:{}}])
 assert.deepEqual(report.routes, [['/',1], ['chat/undefined',1]])
 assert.deepEqual(report.intents, [['-',1], ['undefined',1]])
})

test('routing reports show the final destination and observed removal stage without treating forced calls as losses', () => {
 const report=buildTurnTraceReport([
  {turnId:'model',toolRouting:{candidates:['memberInfoTool'],beforeFilter:['memberInfoTool','searchInformationTool','reminderTool'],afterFilter:['memberInfoTool','reminderTool'],finalTools:['memberInfoTool'],requestTools:[],toolChoice:'none',executionPath:'model',planner:{status:'timeout',reason:'deadline'},applied:[]}},
  {turnId:'direct',toolRouting:{finalTools:['memberInfoTool'],requestTools:[],toolChoice:'memberInfoTool',executionPath:'forced',planner:{status:'skipped',reason:'deterministic'},applied:['deterministicManifest']}},
  {turnId:'available',toolRouting:{finalTools:['chatHistoryTool'],requestTools:['chatHistoryTool'],toolChoice:'auto',executionPath:'model',planner:{status:'unavailable'}}},
  {turnId:'legacy'},
  {turnId:'partial',toolRouting:{planner:{status:'running'}}}
 ])
 assert.equal(report.toolRouting.trackedTurns,4)
 assert.deepEqual(report.toolRouting.destinations,[['gateway_input_text',1],['forced_call',1],['gateway_input_tools',1],['unknown',1]])
 assert.deepEqual(report.toolRouting.lossStages,[['filter',1],['plan',1],['request',1]])
 assert.deepEqual(report.toolRouting.removedTools,[['filter/searchInformationTool',1],['plan/reminderTool',1],['request/memberInfoTool',1]])
 assert.deepEqual(report.toolRouting.routeRules,[['deterministicManifest',1]])
 assert.match(formatTurnTraceReport(report),/工具集合收窄环节（不等于漏调）/)
 assert.match(formatTurnTraceReport(report),/规划器状态/)
})

test('late shadow events are joined by turn id and never inflate turn or model counts', () => {
 const report=buildTurnTraceReport([
  {turnId:'one',intent:{kind:'chat',source:'fast_path_skip'},intentShadow:{status:'match',elapsedMs:1},modelCalls:[{stage:'main',ms:5}]},
  {event:'intent_shadow',parentTurnId:'one',intentShadow:{status:'mismatch',intent:'other_tool',confidence:0.95,elapsedMs:5}},
  {event:'intent_shadow',parentTurnId:'two',intentShadow:{status:'timeout',elapsedMs:10}}
 ])
 assert.equal(report.turns,1)
 assert.equal(report.fastPathSkipCount,1)
 assert.equal(report.modelStages.main.count,1)
 assert.equal(report.intentShadow.samples,2)
 assert.equal(report.intentShadow.mismatches,1)
 assert.deepEqual(report.intentShadow.statuses,[['mismatch',1],['timeout',1]])
 assert.match(formatTurnTraceReport(report),/快路影子: 2 次，分歧 1 次/)
})

test('explicit no-action decisions and committed scope narrowing are separate from unexplained tool losses', () => {
 const report=buildTurnTraceReport([
  {turnId:'explicit-chat',route:{reason:'semantic_chat'},toolRouting:{beforeFilter:['searchInformationTool'],afterFilter:[],finalTools:[],planner:{status:'chat'},toolChoice:'none'}},
  {turnId:'chat-route',route:{reason:'semantic_chat'},toolRouting:{afterFilter:['reminderTool'],finalTools:[],toolChoice:'none'}},
  {turnId:'selected',route:{reason:'committed_action'},toolRouting:{afterFilter:['memberInfoTool','reminderTool'],finalTools:['memberInfoTool'],toolChoice:'memberInfoTool',executionPath:'forced'}},
  {turnId:'optional-lost',route:{reason:'no_required_action'},toolRouting:{afterFilter:['chatHistoryTool'],finalTools:[],toolChoice:'none'}}
 ])
 assert.deepEqual(report.toolRouting.lossStages,[['plan',1]],'absence of a required action is not an explicit refusal')
 assert.deepEqual(report.toolRouting.intentionalReductions,[['filter/explicit_chat',1],['plan/explicit_chat',1],['plan/selected_tool',1]])
 assert.ok(report.toolRouting.reductionReasons.some(([reason])=>reason==='plan/no_required_action'))
 assert.match(formatTurnTraceReport(report),/明确不执行或选中工具后的收窄/)
})

test('normalized no-action is a planner loss even when routing already emptied the tools, while old chat traces remain compatible', () => {
 const report=buildTurnTraceReport([
  {turnId:'normalized-empty',route:{reason:'semantic_chat'},toolRouting:{candidates:['memberInfoTool'],beforeFilter:[],afterFilter:[],finalTools:[],requestTools:[],toolChoice:'none',planner:{status:'chat',reason:'normalized_no_action'}}},
  {turnId:'normalized-visible',route:{reason:'semantic_chat'},toolRouting:{beforeFilter:['memberInfoTool'],afterFilter:[],finalTools:[],requestTools:[],toolChoice:'none',planner:{status:'chat',reason:'normalized_no_action'}}},
  {turnId:'explicit',route:{reason:'semantic_chat'},toolRouting:{afterFilter:['reminderTool'],finalTools:[],planner:{status:'chat',reason:'explicit_chat'}}},
  {turnId:'legacy',route:{reason:'semantic_chat'},toolRouting:{afterFilter:['reminderTool'],finalTools:[],planner:{status:'chat'}}}
 ])
 assert.deepEqual(report.toolRouting.lossStages,[['planner',2]],'downstream emptying is not counted as a second initiating loss')
 assert.deepEqual(report.toolRouting.intentionalReductions,[['plan/explicit_chat',2]])
 assert.deepEqual(report.toolRouting.reductionReasons,[['planner/normalized_no_action',2],['plan/explicit_chat',2],['filter/normalized_no_action',1]])
 assert.match(formatTurnTraceReport(report),/planner\/normalized_no_action/)
})

test('gateway input snapshots do not claim final backend delivery or infer dispatch from a plan alone', () => {
 const report=buildTurnTraceReport([
  {turnId:'gateway',toolRouting:{finalTools:['chatHistoryTool'],requestTools:['chatHistoryTool'],toolChoice:'auto',executionPath:'model'}},
  {turnId:'not-dispatched',toolRouting:{finalTools:['chatHistoryTool'],toolChoice:'auto',executionPath:'model'}}
 ])
 assert.deepEqual(report.toolRouting.destinations,[['gateway_input_tools',1],['planned_tools',1]])
 const text=formatTurnTraceReport(report)
 assert.match(text,/requestTools = 模型网关入口暴露/)
 assert.match(text,/后续文字降级未追踪/)
})
