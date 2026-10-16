import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'

const directory = path.dirname(fileURLToPath(import.meta.url))
const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'))
const baseline = read('baseline.json')
const candidate = read('candidate.json')
const scenarios = read('../../../tests/fixtures/p0-social-grounding-scenarios.json')
const historyClock = 'seed_context_fixed_2026-01-01T04:00:00Z; new_turns_use_wall_clock_or_explicit_scenario_at'
for (const run of [baseline, candidate]) assert.equal(run.metadata.historyClock, historyClock)
const historyWithTime = messages => messages.map((message, index) => ({
  ...message,
  timeReceivedByModel: new Date(Date.parse('2026-01-01T04:00:00Z') - (messages.length - index) * 30000 + 8 * 3600000).toISOString().replace('.000Z', '+08:00')
}))
const sameProtocolFields = ['runnerHash', 'scenariosHash', 'memoryHelperHash', 'configHash', 'effectiveConfigHash', 'personaHash', 'personaLibraryHash', 'repetitions']
const key = row => `${row.id}:${row.sampleIndex}:${row.turnIndex}`
for (const run of [baseline, candidate]) {
  assert.equal(run.complete, true)
  assert.equal(run.results.length, 60)
  assert.equal(run.platformMessagesSent, 0)
  assert.equal(run.productionStoreWrites, 0)
}
for (const field of sameProtocolFields) assert.deepEqual(candidate.metadata[field], baseline.metadata[field], field)
assert.deepEqual(candidate.results.map(key), baseline.results.map(key))
const quantile = (values, fraction) => [...values].sort((a,b)=>a-b)[Math.ceil(values.length*fraction)-1]
function summarize(run) {
  const network = run.results.flatMap(row=>row.network)
  const latency = run.results.map(row=>row.replyElapsedMs ?? row.elapsedMs)
  return {
    commit:run.commit, complete:run.complete, turns:run.results.length,
    structuralPassed:run.results.filter(row=>!row.failures.length).length,
    structuralDifferences:run.results.filter(row=>row.failures.length).map(row=>({key:key(row),failures:row.failures})),
    httpRequests:network.length, http200:network.filter(row=>row.status===200).length,
    explicitLow:network.filter(row=>row.generation?.reasoning_effort==='low').length,
    repairTurns:run.results.filter(row=>row.grounding?.repairAttempted).length,
    fallbackTurns:run.results.filter(row=>row.grounding?.fallback).length,
    replyLatencyMs:{p50:quantile(latency,.5),p95:quantile(latency,.95),max:Math.max(...latency)},
    platformMessagesSent:run.platformMessagesSent,productionStoreWrites:run.productionStoreWrites,
    semanticEvaluation:'requires_entire_conversation_review; HTTP_and_structure_are_not_quality_scores'
  }
}
const summary = {sameProtocolFields,baseline:summarize(baseline),candidate:summarize(candidate)}
fs.writeFileSync(path.join(directory,'summary.json'),JSON.stringify(summary,null,2)+'\n')

const grouped = run => Map.groupBy(run.results,row=>`${row.id}:${row.sampleIndex}`)
const left = grouped(baseline), right = grouped(candidate)
const cases = [], mapping = []
for (const [group, first] of left) {
  const other = right.get(group)
  const scenario = scenarios.find(item=>item.id===first[0].id)
  const id = `case-${String(cases.length+1).padStart(2,'0')}`
  const candidateIsA = createHash('sha256').update(`state-followup-20261016-${group}`).digest()[0] % 2 === 0
  const turns = [scenario,...(scenario.followups||[])]
  const transcript = rows => rows.map((row,index)=>({
    user:row.input,assistant:row.output,
    ...(turns[index].quote?{quote:turns[index].quote}:{}),
    knownTaskFacts:turns[index].taskFacts ?? scenario.taskFacts ?? null,
    expected:row.expected
  }))
  cases.push({id,recentContext:historyWithTime(scenario.recentContext||[]),initialQuote:scenario.quote||null,
    semanticChecks:scenario.semanticChecks||[],manualReview:scenario.manualReview||[],
    A:transcript(candidateIsA?other:first),B:transcript(candidateIsA?first:other)})
  mapping.push({id,group,candidate:candidateIsA?'A':'B',baseline:candidateIsA?'B':'A'})
}
fs.writeFileSync(path.join(directory,'blind-mapping.json'),JSON.stringify(mapping,null,2)+'\n')
const blindDirectory = process.argv[2]
const conversations = {
  instructions:'Read each full conversation, including new user information and quoted speaker ownership. Score evidence fidelity, object/quantity/stance continuity, uptake of new information, and naturalness separately. Do not infer quality from labels or length. Quote each hard error exactly. Each case randomizes A/B independently.',
  historyClockDisclosure:'Seed history includes the per-message times shown above. Later user turns use the actual 2026-10-16 wall clock. Seed context timestamps and the user saying 刚才 can conflict. These timestamps were present in model history but omitted in the initial anonymous export. A matching delivered-message ID in recentContext identifies the timestamped message. Do not infer a delivery date merely from a task observedAt value.',
  cases
}
fs.writeFileSync(path.join(directory,'blind-conversations.json'),JSON.stringify(conversations,null,2)+'\n')
if (blindDirectory) {
  fs.mkdirSync(blindDirectory,{recursive:true})
  fs.writeFileSync(path.join(blindDirectory,'conversations.json'),JSON.stringify(conversations,null,2)+'\n')
}
console.log(JSON.stringify(summary,null,2))
