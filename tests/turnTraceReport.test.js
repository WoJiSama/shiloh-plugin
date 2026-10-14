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
