import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'

const directory = path.dirname(fileURLToPath(import.meta.url))
const baseline = JSON.parse(fs.readFileSync(path.join(directory, 'baseline.json')))
const candidate = JSON.parse(fs.readFileSync(path.join(directory, 'candidate.json')))
const scenarios = JSON.parse(fs.readFileSync(path.join(directory, '../../../tests/fixtures/p0-social-grounding-scenarios.json')))
assert.equal(baseline.complete, true)
assert.equal(candidate.complete, true)
assert.equal(baseline.results.length, 60)
assert.equal(candidate.results.length, 60)
const same = ['runnerHash', 'scenariosHash', 'memoryHelperHash', 'configHash', 'effectiveConfigHash', 'personaHash', 'personaLibraryHash', 'repetitions']
for (const field of same) assert.deepEqual(candidate.metadata[field], baseline.metadata[field], field)
const key = row => `${row.id}:${row.sampleIndex}:${row.turnIndex}`
assert.deepEqual(candidate.results.map(key), baseline.results.map(key))
const quantile = (values, fraction) => [...values].sort((a,b)=>a-b)[Math.ceil(values.length*fraction)-1]
function summarize(run) {
  const network = run.results.flatMap(row=>row.network)
  const repairs = run.results.filter(row=>row.grounding?.repairAttempted)
  const latency = run.results.map(row=>row.replyElapsedMs ?? row.elapsedMs)
  return {
    commit:run.commit, complete:run.complete, turns:run.results.length,
    structuralPassed:run.results.filter(row=>!row.failures.length).length,
    structuralDifferences:run.results.filter(row=>row.failures.length).map(row=>({key:key(row), failures:row.failures})),
    httpRequests:network.length, http200:network.filter(row=>row.status===200).length,
    explicitLow:network.filter(row=>row.generation?.reasoning_effort==='low').length,
    repairTurns:repairs.length, fallbackTurns:run.results.filter(row=>row.grounding?.fallback).length,
    repairs:repairs.map(row=>({key:key(row),violations:row.grounding.violations.map(value=>value.code),remaining:row.grounding.remaining.map(value=>value.code),fallback:row.grounding.fallback,repairError:row.grounding.repairError})),
    replyLatencyMs:{p50:quantile(latency,.5),p95:quantile(latency,.95),max:Math.max(...latency)},
    platformMessagesSent:run.platformMessagesSent, productionStoreWrites:run.productionStoreWrites,
    semanticEvaluation:'requires_complete_conversation_review; not inferred from these counters'
  }
}
const summary = {sameProtocolFields:same, baseline:summarize(baseline), candidate:summarize(candidate)}
fs.writeFileSync(path.join(directory,'summary.json'),JSON.stringify(summary,null,2)+'\n')

const grouped = run => Map.groupBy(run.results,row=>`${row.id}:${row.sampleIndex}`)
const left = grouped(baseline), right = grouped(candidate)
const cases = [], mapping = []
for (const [group, first] of left) {
  const other = right.get(group)
  const scenario = scenarios.find(item=>item.id===first[0].id)
  const id = `case-${String(cases.length+1).padStart(2,'0')}`
  const candidateIsA = createHash('sha256').update(`p0-social-blind-${group}`).digest()[0] % 2 === 0
  const turns = [scenario,...(scenario.followups||[])]
  const transcript = rows => rows.map((row,index)=>({
    user:row.input, assistant:row.output,
    ...(turns[index].quote?{quote:turns[index].quote}:{}),
    knownTaskFacts:turns[index].taskFacts ?? scenario.taskFacts ?? null,
    expected:row.expected
  }))
  cases.push({id,recentContext:scenario.recentContext||[], initialQuote:scenario.quote||null,
    semanticChecks:scenario.semanticChecks||[],manualReview:scenario.manualReview||[],
    A:transcript(candidateIsA?other:first),B:transcript(candidateIsA?first:other)})
  mapping.push({id,group,candidate:candidateIsA?'A':'B',baseline:candidateIsA?'B':'A'})
}
const blindDirectory = process.argv[2]
if (blindDirectory) {
  fs.mkdirSync(blindDirectory,{recursive:true})
  fs.writeFileSync(path.join(blindDirectory,'conversations.json'),JSON.stringify({instructions:'Read every entire conversation. Judge evidence fidelity, speaker/object/quantity/stance continuity, new information and naturalness separately. Kind labels, latency and word counts are not quality scores. State hard errors with exact quotes; a tie is valid.',cases},null,2)+'\n')
  fs.writeFileSync(path.join(directory,'blind-mapping.json'),JSON.stringify(mapping,null,2)+'\n')
}
console.log(JSON.stringify(summary))
