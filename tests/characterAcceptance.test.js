import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { inspectReplay, compareReplays, reviewTemplate, validateReview, parseOptions, main } from '../scripts/characterAcceptance.mjs'
import { summarize, assessmentVersion } from '../scripts/characterReplay.mjs'
import { hashReplayValue } from '../scripts/conversationQualityReplay.mjs'

const h = hashReplayValue
const noLog = () => {}
const scope = { botId: 'bot', personaId: 'persona', groupId: '99000002' }
const emptyCharacter = () => ({ schemaVersion: 1, scope, revision: 0, paused: false, memories: [], goals: [], receipts: [] })
const emptyActivities = () => ({ works: [], subscriptions: [], reflection: { schemaVersion: 1 }, shared: [], sharedPending: [] })
function fixture({ mode = 'scripted_offline', repetitions = 1, eventCount = 1 } = {}) {
  const scenarioManifest = [{ id: 'quiet-check', events: Array.from({ length: eventCount }, (_, eventIndex) => ({ eventIndex, eventHash: h({ eventIndex }), expect: { noSend: true } })) }]
  const results = Array.from({ length: repetitions }, (_, index) => scenarioManifest[0].events.map(event => ({
    scenario: 'quiet-check', sampleIndex: index + 1, eventIndex: event.eventIndex, eventHash: event.eventHash,
    kind: 'message', input: '真实会话内容只存在于输入报告', at: 1794196800000 + event.eventIndex * 1000, expect: event.expect,
    status: 'passed', calls: mode === 'live_model' ? [{ id: 'main-1', stage: 'main', requestHash: h('request'), usage: { total_tokens: 12 }, model: 'fixture-model', toolCalls: [], tools: ['simDecide'] }] : [],
    network: mode === 'live_model' ? [{ stage: 'main', status: 200, generation: { parameters: { model: 'fixture-model', temperature: 0.7, max_tokens: 2048 }, hash: h({ model: 'fixture-model', temperature: 0.7, max_tokens: 2048 }) } }] : [], sent: [], searches: [], warnings: [], errors: [], structuralFailures: [],
    beforeCharacter: emptyCharacter(), character: emptyCharacter(), behavior: { noMessageSent: true },
    beforeActivities: emptyActivities(), activities: emptyActivities(), toolResults: [], feeds: [], workers: [], reflections: [],
  }))).flat()
  return {
    complete: true, platformMessagesSent: 0, productionStoreWrites: 0,
    metadata: {
      schemaVersion: 1, mode, assessmentVersion, runId: randomUUID(), startedAtISO: '2026-11-09T10:00:00.000Z', scenarioManifest, scenarioManifestHash: h(scenarioManifest),
      runnerHash: h('runner'), scenariosHash: h('scenarios'), effectiveConfigHash: h('config'), buildManifestHash: h('build'), personaHash: h('persona'),
      repetitions, model: mode === 'live_model' ? 'fixture-model' : null,
      generation: 'fixture-generation', simulationOverrides: { tools: 'fixed-tools' }, clock: 'fixed-clock',
      search: 'synthetic_fixture', feeds: 'synthetic_fixture', worker: 'synthetic_fixture', reflection: 'separate_model_port', storage: 'fresh_in_memory_per_sample', platform: 'captured_only', personaSource: 'fixture', seed: 'empty',
      maxCalls: 60, maxHttp: 80, maxDurationMs: 600000,
    }, results, summary: summarize(results),
  }
}
function scratch(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-character-acceptance-test-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}
function saved(directory, name, document) {
  const filename = path.join(directory, name)
  fs.writeFileSync(filename, JSON.stringify(document))
  return filename
}

test('import and help perform no evidence reads, network requests or output writes', t => {
  const dir = scratch(t), output = path.join(dir, 'never-created')
  const moduleUrl = new URL('../scripts/characterAcceptance.mjs', import.meta.url).href
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    const original = fs.readFileSync;
    fs.readFileSync = (file,...args) => {if(String(file).endsWith('private.json')) throw new Error('private read'); return original(file,...args)};
    globalThis.fetch=()=>{throw new Error('network used')};
    const {main}=await import(${JSON.stringify(moduleUrl)});
    const result=await main(['--help','--candidate','private.json','--output-dir',${JSON.stringify(output)}],{log:()=>{}});
    console.log(JSON.stringify({exitCode:result.exitCode,outputExists:fs.existsSync(${JSON.stringify(output)})}));
  `], { cwd: dir, encoding: 'utf8', timeout: 5000 })
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout), { exitCode: 0, outputExists: false })
})

test('CLI rejects unknown, duplicate and missing arguments before creating output', () => {
  const options = parseOptions(['--candidate', 'results.json', '--output-dir', 'next'], '/tmp')
  assert.equal(options.candidate, '/tmp/results.json')
  for (const argv of [[], ['--candidate', 'x'], ['--candidate'], ['--unknown'], ['--help', '--help'], ['--candidate', 'a', '--candidate', 'b', '--output-dir', 'out']]) assert.throws(() => parseOptions(argv))
})

test('complete scripted evidence passes engineering only and every sample starts with pending review', async t => {
  const dir = scratch(t), candidate = saved(dir, 'offline.json', fixture({ repetitions: 2, eventCount: 2 })), output = path.join(dir, 'output')
  const report = await main(['--candidate', candidate, '--output-dir', output], { log: noLog })
  assert.equal(report.candidate.integrity, 'passed')
  assert.equal(report.candidate.engineering, 'passed')
  assert.equal(report.candidate.behavior, 'passed')
  assert.equal(report.candidate.liveModel, 'pending')
  assert.equal(report.shadowAcceptance, 'pending')
  assert.equal(report.stage7.status, 'pending')
  assert.equal(report.exitCode, 2)
  const review = JSON.parse(fs.readFileSync(path.join(output, 'review.json'), 'utf8'))
  assert.equal(review.items.length, 2)
  assert.ok(review.items.every(item => item.verdict === 'pending' && item.reviewer === '' && item.comment === ''))
  const markdown = fs.readFileSync(path.join(output, 'report.md'), 'utf8')
  assert.match(markdown, /真实群观察/)
  assert.equal(JSON.stringify(report).includes('真实会话内容只存在于输入报告'), false)
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(output, 'review.json')).mode & 0o777, 0o600)
})

test('empty, incomplete, missing, duplicate and unexpected events never count as accepted evidence', () => {
  const cases = [
    document => { document.results = []; document.summary = summarize([]) },
    document => { document.complete = false },
    document => { document.results.pop(); document.summary = summarize(document.results) },
    document => { document.results.push(structuredClone(document.results[0])); document.summary = summarize(document.results) },
    document => { document.results[0].sampleIndex = 99 },
  ]
  for (const mutate of cases) {
    const document = fixture({ eventCount: 2 }); mutate(document)
    const result = inspectReplay(document)
    assert.equal(result.integrity, 'failed')
    assert.equal(result.engineering, 'failed')
    assert.notEqual(result.liveModel, 'passed')
  }
})

test('saved optimistic summaries and forged behavior values are independently rejected', () => {
  const document = fixture()
  document.results[0].sent.push({ groupId: scope.groupId, segments: ['unexpected message'] })
  const result = inspectReplay(document)
  assert.equal(result.summary.capturedMessages, 1)
  assert.equal(result.summary.behaviorMisses, 1)
  assert.equal(result.behavior, 'failed')
  assert.ok(result.integrityFailures.includes('saved_summary_mismatch'))
  assert.ok(result.integrityFailures.some(value => value.startsWith('behavior_evidence_mismatch:')))
})

test('skipped dependency evidence has no behavior observations and still blocks acceptance', async t => {
  const document = fixture(), result = document.results[0]
  result.status = 'skipped'
  result.skipReason = 'model_created_no_due_goal'
  result.behavior = {}
  document.summary = summarize(document.results)
  const inspected = inspectReplay(document)
  assert.equal(inspected.integrity, 'passed')
  assert.equal(inspected.summary.behaviorMisses, 0)
  assert.equal(inspected.summary.skippedEvents, 1)
  assert.equal(inspected.engineering, 'failed')
  const dir = scratch(t), candidate = saved(dir, 'skipped.json', document)
  const report = await main(['--candidate', candidate, '--output-dir', path.join(dir, 'acceptance')], { log: noLog })
  assert.equal(report.shadowAcceptance, 'failed')
  assert.equal(report.exitCode, 1)
})

test('historical missing failure observations and skipped-summary inconsistencies remain detectable', () => {
  const missing = fixture()
  missing.results[0].status = 'failed'
  missing.results[0].errors.push('logical_call_budget_exhausted')
  missing.results[0].structuralFailures.push('exception')
  delete missing.results[0].behavior
  missing.summary = summarize(missing.results)
  assert.ok(inspectReplay(missing).integrityFailures.some(value => value.startsWith('behavior_evidence_mismatch:')))
  const stale = fixture()
  stale.results[0].status = 'skipped'
  stale.results[0].skipReason = 'model_created_no_due_goal'
  stale.results[0].behavior = { noMessageSent: false }
  stale.summary = summarize(stale.results)
  assert.ok(inspectReplay(stale).integrityFailures.includes('saved_summary_mismatch'))
})

test('per-sample continuity, event ordering, clock and captured send scope stay consistent', () => {
  for (const [mutate, marker] of [
    [document => { document.results.reverse() }, 'event_order_mismatch'],
    [document => { document.results[1].beforeCharacter.revision = 9 }, 'character_continuity_mismatch'],
    [document => { document.results[1].at = document.results[0].at - 1 }, 'event_clock_mismatch'],
    [document => { document.results[0].character.scope = { ...scope, groupId: 'other-group' } }, 'character_scope_changed'],
    [document => { document.results[0].sent = [{ groupId: 'other-group' }]; document.results[0].behavior = { noMessageSent: false }; document.summary = summarize(document.results) }, 'send_scope_mismatch'],
  ]) {
    const document = fixture({ eventCount: 2 }); mutate(document)
    const result = inspectReplay(document)
    assert.equal(result.integrity, 'failed')
    assert.ok(result.integrityFailures.some(value => value.startsWith(marker)), marker)
  }
})

test('manifest and event fingerprints, expectations and old assessments cannot silently change', () => {
  const absent = fixture(); delete absent.metadata.scenarioManifest
  assert.throws(() => inspectReplay(absent), /rerun/)
  const old = fixture(); old.metadata.assessmentVersion = 1
  assert.throws(() => inspectReplay(old), /rerun/)
  for (const mutate of [
    document => { document.metadata.scenarioManifestHash = h('wrong') },
    document => { document.results[0].eventHash = h('wrong') },
    document => { document.results[0].expect = {} },
    document => { delete document.results[0].beforeCharacter },
    document => { document.platformMessagesSent = 1 },
  ]) {
    const document = fixture(); mutate(document)
    assert.equal(inspectReplay(document).integrity, 'failed')
  }
  const mode = fixture(); mode.metadata.mode = 'unknown'
  assert.throws(() => inspectReplay(mode), /mode/)
})

test('live mode needs successful HTTP evidence rather than a metadata label', () => {
  const document = fixture({ mode: 'live_model' })
  assert.equal(inspectReplay(document).liveModel, 'passed')
  document.results[0].network = []; document.summary = summarize(document.results)
  assert.equal(inspectReplay(document).liveModel, 'pending')
  document.results[0].network = [{ status: 200 }]; document.summary = summarize(document.results)
  assert.equal(inspectReplay(document).integrity, 'failed')
})

test('current assessments require run identity, activity conditions and complete snapshots even for skipped events', () => {
  for (const [mutate, marker] of [
    [document => { delete document.metadata.runId }, 'missing_run_identity'],
    [document => { document.metadata.startedAtISO = 'not a date' }, 'missing_run_identity'],
    [document => { delete document.metadata.feeds }, 'missing_activity_execution_conditions'],
    [document => { delete document.results[0].beforeActivities }, 'missing_activity_state'],
    [document => { document.results[0].activities.reflection = [] }, 'missing_activity_state'],
    [document => { document.results[1].beforeActivities.works.push({ id: 'unrecorded-write' }) }, 'activity_continuity_mismatch'],
    ...['toolResults', 'feeds', 'workers', 'reflections'].map(field => [document => { document.results[0].status = 'skipped'; delete document.results[0][field] }, 'missing_activity_evidence']),
  ]) {
    const document = fixture({ eventCount: 2 }); mutate(document); document.summary = summarize(document.results)
    const result = inspectReplay(document)
    assert.equal(result.integrity, 'failed')
    assert.ok(result.integrityFailures.some(value => value.startsWith(marker)), marker)
  }
})

test('reflection evidence must correspond one-to-one with successful or failed reflection calls', () => {
  const withReflection = () => {
    const document = fixture(), result = document.results[0]
    const call = { id: 'reflection-1', stage: 'reflection', requestHash: h('reflection-request'), output: '{}', usage: null, toolCalls: [], tools: [] }
    result.calls.push(call)
    result.reflections.push({ callId: call.id, requestHash: call.requestHash, status: 'succeeded', output: call.output, usage: call.usage })
    document.summary = summarize(document.results)
    return document
  }
  assert.equal(inspectReplay(withReflection()).integrity, 'passed')
  for (const [mutate, marker] of [
    [document => { document.results[0].calls[0].stage = 'unknown' }, 'missing_call_stage'],
    [document => { delete document.results[0].calls[0].id }, 'invalid_call_identity'],
    [document => { document.results[0].reflections = [] }, 'reflection_evidence_count_mismatch'],
    [document => { document.results[0].reflections[0].requestHash = h('other-request') }, 'invalid_reflection_evidence'],
    [document => { document.results[0].reflections[0].output = '{"invented":true}' }, 'invalid_reflection_evidence'],
    [document => { document.results[0].reflections[0].status = 'failed'; document.results[0].reflections[0].error = 'invented failure' }, 'invalid_reflection_evidence'],
    [document => {
      const result = document.results[0]
      result.calls.push({ ...result.calls[0], id: 'reflection-2' })
      result.reflections.push({ ...result.reflections[0] })
    }, 'invalid_reflection_evidence'],
  ]) {
    const document = withReflection(); mutate(document); document.summary = summarize(document.results)
    const result = inspectReplay(document)
    assert.equal(result.integrity, 'failed')
    assert.ok(result.integrityFailures.some(value => value.startsWith(marker)), marker)
  }
  const failed = withReflection(), result = failed.results[0]
  result.calls[0].error = 'provider unavailable'
  Object.assign(result.reflections[0], { status: 'failed', error: 'provider unavailable' })
  failed.summary = summarize(failed.results)
  const inspected = inspectReplay(failed)
  assert.ok(inspected.integrityFailures.some(value => value.startsWith('model_call_failed')))
  assert.equal(inspected.integrityFailures.some(value => value.startsWith('invalid_reflection_evidence')), false)
  assert.equal(inspected.engineering, 'failed')
})

test('captured tool results require an exact content hash and a recorded invocation stage', () => {
  const document = fixture(), evidence = { stage: 'main', toolCallId: 'tool-1', content: '{"ok":true}' }
  evidence.hash = h({ toolCallId: evidence.toolCallId, content: evidence.content })
  document.results[0].toolResults.push(evidence)
  assert.equal(inspectReplay(document).integrity, 'passed')
  for (const mutate of [
    changed => { changed.results[0].toolResults[0].content = '{"ok":false}' },
    changed => { delete changed.results[0].toolResults[0].stage },
    changed => { changed.results[0].toolResults[0].hash = h('different content') },
  ]) {
    const changed = structuredClone(document); mutate(changed)
    assert.ok(inspectReplay(changed).integrityFailures.some(value => value.startsWith('invalid_tool_result_evidence')))
  }
})

test('captured model errors fail engineering even when event status and summary appear successful', () => {
  const document = fixture({ mode: 'live_model' })
  document.results[0].calls[0].error = 'provider unavailable'
  document.summary = summarize(document.results)
  const result = inspectReplay(document)
  assert.equal(result.summary.failedEvents, 0)
  assert.equal(result.engineering, 'failed')
  assert.equal(result.liveModel, 'failed')
  assert.ok(result.integrityFailures.some(value => value.startsWith('model_call_failed')))
})

test('comparison requires independent live evidence with matching scenario, person, runner and conditions', () => {
  const candidate = fixture({ mode: 'live_model' }), baseline = structuredClone(candidate)
  baseline.metadata.runId = randomUUID()
  baseline.metadata.buildManifestHash = h('older-build')
  baseline.metadata.effectiveConfigHash = h('older-config')
  baseline.metadata.model = 'other-model'
  const comparison = compareReplays(candidate, baseline, h('candidate-file'), h('baseline-file'))
  assert.equal(comparison.status, 'available')
  assert.equal(comparison.configChanged, true)
  assert.equal(comparison.singleVariableAttribution, false)
  assert.equal(comparison.modelChanged, true)
  assert.equal(comparison.buildChanged, true)
  assert.equal(compareReplays(candidate, baseline, 'same', 'same').status, 'incompatible')
  if (assessmentVersion >= 3) {
    const sameRun = structuredClone(baseline); sameRun.metadata.runId = candidate.metadata.runId
    assert.ok(compareReplays(candidate, sameRun, 'candidate', 'baseline').differences.includes('same_run_identity'))
  }
  for (const key of ['runnerHash', 'personaHash', 'scenariosHash', 'generation', 'clock', 'simulationOverrides', 'repetitions']) {
    const other = structuredClone(baseline); other.metadata[key] = 'different'
    assert.ok(compareReplays(candidate, other, 'candidate', 'baseline').differences.includes(key))
  }
  assert.equal(compareReplays(candidate, fixture(), 'candidate', 'offline').status, 'incompatible')
  assert.equal(compareReplays(candidate, undefined).status, 'pending')
  const changedGeneration = structuredClone(baseline)
  changedGeneration.results[0].network[0].generation.parameters.temperature = 0.2
  assert.ok(compareReplays(candidate, changedGeneration, 'candidate', 'baseline').differences.includes('observed_generation_parameters'))
  const changedTools = structuredClone(baseline)
  changedTools.results[0].calls[0].tools.push('extra-tool')
  assert.ok(compareReplays(candidate, changedTools, 'candidate', 'baseline').differences.includes('observed_tool_inventory'))
})

test('review is tied to exact candidate bytes and requires all distinct samples, named reviewers and reasons', () => {
  const samples = inspectReplay(fixture({ repetitions: 2 })).samples, candidateHash = h('candidate')
  const template = reviewTemplate(candidateHash, samples)
  assert.equal(validateReview(template, candidateHash, samples).status, 'pending')
  assert.throws(() => validateReview(template, h('other'), samples), /SHA256/)
  const missing = structuredClone(template); missing.items.pop()
  assert.throws(() => validateReview(missing, candidateHash, samples), /missing/)
  const duplicate = structuredClone(template); duplicate.items[1] = structuredClone(duplicate.items[0])
  assert.throws(() => validateReview(duplicate, candidateHash, samples), /duplicate/)
  const accepted = structuredClone(template); accepted.items[0].verdict = 'accepted'
  assert.throws(() => validateReview(accepted, candidateHash, samples), /reviewer and comment/)
  for (const item of accepted.items) { item.reviewer = 'reviewer'; item.verdict = 'accepted'; item.comment = 'Read the whole sample and verified its evidence.' }
  assert.equal(validateReview(accepted, candidateHash, samples).status, 'accepted')
  accepted.items[0].verdict = 'rejected'
  assert.equal(validateReview(accepted, candidateHash, samples).status, 'rejected')
})

test('even accepted human review cannot turn scripted mode or engineering errors into live acceptance', async t => {
  const dir = scratch(t), candidate = saved(dir, 'offline.json', fixture())
  const first = await main(['--candidate', candidate, '--output-dir', path.join(dir, 'first')], { log: noLog })
  const review = reviewTemplate(first.candidate.sha256, first.candidate.samples)
  for (const item of review.items) Object.assign(item, { reviewer: 'reviewer', verdict: 'accepted', comment: 'Reviewed the scripted sample, not live-model quality.' })
  const reviewFile = saved(dir, 'submitted-review.json', review)
  const reviewed = await main(['--candidate', candidate, '--review', reviewFile, '--output-dir', path.join(dir, 'reviewed')], { log: noLog })
  assert.equal(reviewed.humanReview.status, 'accepted')
  assert.equal(reviewed.shadowAcceptance, 'pending')
  assert.equal(reviewed.candidate.liveModel, 'pending')

  const failed = fixture({ mode: 'live_model' }); failed.results[0].status = 'failed'; failed.results[0].errors.push('provider error'); failed.summary = summarize(failed.results)
  const failedFile = saved(dir, 'failed-live.json', failed)
  const rejected = await main(['--candidate', failedFile, '--output-dir', path.join(dir, 'failure')], { log: noLog })
  assert.equal(rejected.exitCode, 1)
  assert.equal(rejected.shadowAcceptance, 'failed')
  const failedReview = reviewTemplate(rejected.candidate.sha256, rejected.candidate.samples)
  failedReview.items.forEach(item => Object.assign(item, { reviewer: 'reviewer', verdict: 'accepted', comment: 'Reviewer cannot override a recorded provider failure.' }))
  const failedReviewFile = saved(dir, 'failed-accepted-review.json', failedReview)
  const stillFailed = await main(['--candidate', failedFile, '--review', failedReviewFile, '--output-dir', path.join(dir, 'failure-reviewed')], { log: noLog })
  assert.equal(stillFailed.humanReview.status, 'accepted')
  assert.equal(stillFailed.shadowAcceptance, 'failed')
  assert.equal(stillFailed.exitCode, 1)
})

test('a fully reviewed comparable live pair still cannot satisfy actual-group or deployment evidence', async t => {
  const dir = scratch(t), candidate = saved(dir, 'candidate.json', fixture({ mode: 'live_model' }))
  const baseline = fixture({ mode: 'live_model' }); baseline.metadata.buildManifestHash = h('baseline-build')
  const baselineFile = saved(dir, 'baseline.json', baseline)
  const initial = await main(['--candidate', candidate, '--baseline', baselineFile, '--output-dir', path.join(dir, 'initial')], { log: noLog })
  const review = reviewTemplate(initial.candidate.sha256, initial.candidate.samples)
  review.items.forEach(item => Object.assign(item, { reviewer: 'human', verdict: 'accepted', comment: 'Compared full candidate and baseline conversation evidence.' }))
  const submitted = saved(dir, 'review-input.json', review)
  const report = await main(['--candidate', candidate, '--baseline', baselineFile, '--review', submitted, '--output-dir', path.join(dir, 'final')], { log: noLog })
  assert.equal(report.shadowAcceptance, 'passed')
  assert.equal(report.stage7.status, 'pending')
  assert.equal(report.stage7.realGroupObservation, 'not_provided')
  assert.equal(report.stage7.deployment, 'not_verified')
  assert.equal(report.exitCode, 2)
})

test('existing outputs and mismatched review files are preserved without partial new output', async t => {
  const dir = scratch(t), candidate = saved(dir, 'candidate.json', fixture()), output = path.join(dir, 'existing')
  fs.mkdirSync(output); fs.writeFileSync(path.join(output, 'acceptance.json'), 'original')
  await assert.rejects(main(['--candidate', candidate, '--output-dir', output], { log: noLog }), /already exists/)
  assert.equal(fs.readFileSync(path.join(output, 'acceptance.json'), 'utf8'), 'original')
  const wrong = saved(dir, 'wrong-review.json', reviewTemplate(h('wrong-file'), inspectReplay(fixture()).samples))
  const fresh = path.join(dir, 'must-not-create')
  await assert.rejects(main(['--candidate', candidate, '--review', wrong, '--output-dir', fresh], { log: noLog }), /SHA256/)
  assert.equal(fs.existsSync(fresh), false)
})
