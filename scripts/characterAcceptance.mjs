// Read-only assessment of saved shadow-replay evidence. Never calls a model or QQ.
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { summarize, assessEvent, validateScenarios, assessmentVersion } from './characterReplay.mjs'
import { hashReplayValue } from './conversationQualityReplay.mjs'

export const usage = 'Usage: node scripts/characterAcceptance.mjs --candidate results.json [--baseline results.json] [--review review.json] --output-dir fresh-directory\nReads saved reports only; never contacts models, QQ, Redis or workers. Generates acceptance.json, report.md and a pending review.json. Exit 1 means failed evidence or review, 2 means remaining acceptance evidence. Real-group observation and deployment are always pending in this shadow-report tool.'
const sha256 = value => createHash('sha256').update(value).digest('hex')
const isObject = value => value && typeof value === 'object' && !Array.isArray(value)
const same = (a, b) => hashReplayValue({ value: a }) === hashReplayValue({ value: b })
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const fail = message => { throw new Error(message) }
const safeLabel = value => String(value).replace(/[\r\n|`<>]/gu, ' ').slice(0, 180)
const consistencyIssueCodes = new Set(['missing_goal', 'missing_opinion', 'unsupported_fact', 'state_claim', 'duplicate_message'])
function validConsistencyOutput(output) {
  try {
    if (typeof output !== 'string' || output.length > 8192) return false
    const value = JSON.parse(output)
    return isObject(value) && Object.keys(value).every(key => ['verdict', 'issues'].includes(key)) &&
      ['accept', 'revise'].includes(value.verdict) && Array.isArray(value.issues) && value.issues.length <= 5 &&
      (value.verdict === 'accept' ? value.issues.length === 0 : value.issues.length > 0) &&
      value.issues.every(issue => isObject(issue) && Object.keys(issue).every(key => ['code', 'reason'].includes(key)) &&
        consistencyIssueCodes.has(issue.code) && typeof issue.reason === 'string' && !!issue.reason.trim() && issue.reason.length <= 300)
  } catch { return false }
}
const ownFields = (value, fields, label) => {
  if (!isObject(value) || Object.keys(value).some(key => !fields.includes(key))) fail(`Invalid ${label} fields`)
}

export function parseOptions(argv = [], cwd = process.cwd()) {
  const values = new Map(), options = new Set(['--candidate', '--baseline', '--review', '--output-dir'])
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]
    if ((!options.has(key) && key !== '--help') || values.has(key)) fail(`Unknown or duplicate option: ${key}`)
    if (key === '--help') { values.set(key, true); continue }
    const value = argv[++index]
    if (!value || value.startsWith('--')) fail(`Missing value: ${key}`)
    values.set(key, value)
  }
  if (!values.has('--help') && (!values.has('--candidate') || !values.has('--output-dir'))) fail('--candidate and --output-dir are required')
  const resolve = name => values.has(name) ? path.resolve(cwd, values.get(name)) : undefined
  return { help: values.has('--help'), candidate: resolve('--candidate'), baseline: resolve('--baseline'), review: resolve('--review'), outputDir: resolve('--output-dir') }
}

function readJson(file) {
  const stat = fs.statSync(file)
  if (!stat.isFile() || stat.size > 100 * 1024 * 1024) fail('Evidence must be a JSON file no larger than 100MB')
  const bytes = fs.readFileSync(file)
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch { fail(`Cannot parse JSON evidence: ${path.basename(file)}`) }
  return { value, sha256: sha256(bytes), name: path.basename(file) }
}

/** Validate saved facts and recompute observations; the saved summary is never authoritative. */
export function inspectReplay(document) {
  if (!isObject(document) || !isObject(document.metadata) || !Array.isArray(document.results)) fail('Invalid replay document')
  const metadata = document.metadata, failures = []
  const version = metadata.assessmentVersion
  const stages = version >= 5 ? ['main', 'reflection', 'consistency'] : ['main', 'reflection']
  if (metadata.schemaVersion !== 1 || !['scripted_offline', 'injected_test', 'live_model'].includes(metadata.mode)) fail('Unsupported replay schema or mode')
  if (![4, assessmentVersion].includes(version) || !Array.isArray(metadata.scenarioManifest) || !metadata.scenarioManifest.length) fail(`Replay lacks a supported assessment v4/v${assessmentVersion} manifest; rerun the current characterReplay runner`)
  for (const key of ['runnerHash', 'scenariosHash', 'effectiveConfigHash', 'buildManifestHash', 'personaHash', 'scenarioManifestHash']) if (!validHash(metadata[key])) fail(`Invalid replay fingerprint: ${key}`)
  if (!same(metadata.scenarioManifestHash, hashReplayValue(metadata.scenarioManifest))) failures.push('scenario_manifest_hash_mismatch')
  if (!Number.isSafeInteger(metadata.repetitions) || metadata.repetitions < 1 || metadata.repetitions > 5) fail('Invalid replay repetitions')
  if (assessmentVersion >= 3 && (typeof metadata.runId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(metadata.runId) || typeof metadata.startedAtISO !== 'string' || !Number.isFinite(Date.parse(metadata.startedAtISO)))) failures.push('missing_run_identity')
  if (['generation', 'clock', 'search', 'storage', 'platform', 'personaSource', 'seed'].some(key => typeof metadata[key] !== 'string' || !metadata[key])) failures.push('missing_recorded_execution_conditions')
  if (assessmentVersion >= 3 && ['feeds', 'worker', 'reflection'].some(key => typeof metadata[key] !== 'string' || !metadata[key])) failures.push('missing_activity_execution_conditions')
  if (version >= 5 && (typeof metadata.consistency !== 'string' || !metadata.consistency)) failures.push('missing_consistency_execution_conditions')
  if (!isObject(metadata.simulationOverrides) || ['maxCalls', 'maxHttp', 'maxDurationMs'].some(key => !Number.isSafeInteger(metadata[key]) || metadata[key] < 1)) failures.push('missing_recorded_execution_limits')
  if (document.complete !== true) failures.push('incomplete_replay')
  if (document.platformMessagesSent !== 0 || document.productionStoreWrites !== 0) failures.push('shadow_isolation_not_confirmed')
  if (!document.results.length) failures.push('empty_results')

  const expected = new Map(), scenarioIds = new Set(), samples = []
  for (const scenario of metadata.scenarioManifest) {
    ownFields(scenario, ['id', 'events'], 'scenario manifest')
    if (typeof scenario.id !== 'string' || !scenario.id.trim() || scenarioIds.has(scenario.id) || !Array.isArray(scenario.events) || !scenario.events.length) fail('Invalid or duplicate manifest scenario')
    scenarioIds.add(scenario.id)
    for (const [index, event] of scenario.events.entries()) {
      ownFields(event, ['eventIndex', 'eventHash', 'expect'], 'event manifest')
      if (event.eventIndex !== index || !validHash(event.eventHash) || !isObject(event.expect)) fail('Invalid manifest event')
      // Reuse the runner's explicit expectation contract, so misspelled checks cannot disappear.
      validateScenarios([{ id: 'manifest-validation', events: [{ kind: 'message', text: 'manifest validation', expect: event.expect }] }])
    }
    for (let sampleIndex = 1; sampleIndex <= metadata.repetitions; sampleIndex++) {
      const sampleId = `${scenario.id}:sample-${sampleIndex}`
      samples.push({ sampleId, scenario: scenario.id, sampleIndex, expectedEvents: scenario.events.length })
      for (const event of scenario.events) expected.set(JSON.stringify([scenario.id, sampleIndex, event.eventIndex]), event)
    }
  }
  const seen = new Set(), observations = [], recomputedResults = [], sampleResults = new Map(), sampleToolCallIds = new Map()
  let behaviorChecks = 0
  for (const result of document.results) {
    if (!isObject(result) || typeof result.scenario !== 'string' || !Number.isSafeInteger(result.sampleIndex) || !Number.isSafeInteger(result.eventIndex) || !['passed', 'failed', 'skipped'].includes(result.status)) fail('Invalid replay result identity or status')
    if (!['message', 'passive', 'goal-check', 'idle-check', 'background-check'].includes(result.kind)) fail('Invalid replay result event kind')
    for (const field of ['calls', 'network', 'sent', 'errors', 'structuralFailures']) if (!Array.isArray(result[field])) fail(`Invalid result ${field}`)
    if (assessmentVersion >= 3) {
      for (const field of ['toolResults', 'feeds', 'workers', 'reflections']) if (!Array.isArray(result[field])) failures.push(`missing_activity_evidence:${result.scenario}:${result.sampleIndex}:${result.eventIndex}:${field}`)
      for (const field of ['beforeActivities', 'activities']) {
        const activities = result[field]
        if (!isObject(activities) || !['works', 'subscriptions', 'shared', 'sharedPending'].every(key => Array.isArray(activities[key])) || !isObject(activities.reflection)) failures.push(`missing_activity_state:${result.scenario}:${result.sampleIndex}:${result.eventIndex}:${field}`)
      }
      if (result.calls.some(call => !stages.includes(call?.stage))) failures.push(`missing_call_stage:${result.scenario}:${result.sampleIndex}:${result.eventIndex}`)
      const callIds = result.calls.map(call => call?.id)
      if (callIds.some(id => typeof id !== 'string' || !id) || new Set(callIds).size !== callIds.length) failures.push(`invalid_call_identity:${result.scenario}:${result.sampleIndex}:${result.eventIndex}`)
      if (Array.isArray(result.reflections) && result.reflections.length !== result.calls.filter(call => call.stage === 'reflection').length) failures.push(`reflection_evidence_count_mismatch:${result.scenario}:${result.sampleIndex}:${result.eventIndex}`)
      for (const evidence of result.toolResults || []) {
        if (!isObject(evidence) || !['main', 'reflection'].includes(evidence.stage) || typeof evidence.toolCallId !== 'string' || !evidence.toolCallId || typeof evidence.content !== 'string' || !validHash(evidence.hash) || evidence.hash !== hashReplayValue({ toolCallId: evidence.toolCallId, content: evidence.content })) failures.push(`invalid_tool_result_evidence:${result.scenario}:${result.sampleIndex}:${result.eventIndex}`)
      }
      if ((assessmentVersion >= 4 || metadata.toolResults) && result.status !== 'skipped') {
        const sampleKey = JSON.stringify([result.scenario, result.sampleIndex])
        const previousIds = sampleToolCallIds.get(sampleKey) || new Set()
        const currentCalls = result.calls.flatMap(call => (call.toolCalls || []).map(tool => ({ id: tool.id, name: tool.function?.name, stage: call.stage })))
        const requestedToolCallIds = [...new Set(currentCalls.map(tool => tool.id))]
        if (currentCalls.some(tool => previousIds.has(tool.id)) || requestedToolCallIds.length !== currentCalls.length) failures.push(`reused_tool_call_id:${result.scenario}:${result.sampleIndex}:${result.eventIndex}`)
        for (const id of requestedToolCallIds) previousIds.add(id)
        sampleToolCallIds.set(sampleKey, previousIds)
        if ((result.toolResults || []).some(evidence => !currentCalls.some(tool => tool.id === evidence.toolCallId && tool.name === evidence.name && tool.stage === evidence.stage))) failures.push(`orphan_tool_result_evidence:${result.scenario}:${result.sampleIndex}:${result.eventIndex}`)
        const returnedIds = (result.toolResults || []).map(evidence => evidence.toolCallId)
        if (new Set(returnedIds).size !== returnedIds.length) failures.push(`duplicate_tool_result_evidence:${result.scenario}:${result.sampleIndex}:${result.eventIndex}`)
        const missingToolCallIds = requestedToolCallIds.filter(id => !(result.toolResults || []).some(evidence => evidence.toolCallId === id))
        if (!same(result.toolResultCapture, { complete: !missingToolCallIds.length, requestedToolCallIds, missingToolCallIds })) failures.push(`invalid_tool_result_coverage:${result.scenario}:${result.sampleIndex}:${result.eventIndex}`)
        if (missingToolCallIds.length && result.status === 'passed') failures.push(`incomplete_tool_result_capture:${result.scenario}:${result.sampleIndex}:${result.eventIndex}`)
      }
      const reflectionIds = new Set()
      for (const evidence of result.reflections || []) {
        const call = result.calls.find(item => item.id === evidence?.callId && item.stage === 'reflection')
        if (!call || reflectionIds.has(evidence?.callId) || evidence.requestHash !== call.requestHash || evidence.status !== (call.error ? 'failed' : 'succeeded') || (evidence.status === 'succeeded' && (!same(evidence.usage, call.usage) || evidence.output !== call.output)) || (evidence.status === 'failed' && evidence.error !== call.error)) failures.push(`invalid_reflection_evidence:${result.scenario}:${result.sampleIndex}:${result.eventIndex}`)
        reflectionIds.add(evidence?.callId)
      }
      if (version >= 5) {
        const marker = `${result.scenario}:${result.sampleIndex}:${result.eventIndex}`
        if (!Array.isArray(result.consistencyChecks)) failures.push(`missing_consistency_evidence:${marker}`)
        if (result.consistencyChecks?.length !== result.calls.filter(call => call.stage === 'consistency').length) failures.push(`consistency_evidence_count_mismatch:${marker}`)
        const ids = new Set()
        for (const evidence of result.consistencyChecks || []) {
          const call = result.calls.find(item => item.id === evidence?.callId && item.stage === 'consistency')
          if (!call || ids.has(evidence?.callId) || evidence.requestHash !== call.requestHash || evidence.status !== (call.error ? 'failed' : 'succeeded') ||
            !Number.isFinite(evidence.elapsedMs) || evidence.elapsedMs < 0 || evidence.elapsedMs !== call.elapsedMs ||
            (evidence.status === 'succeeded' && (!same(evidence.usage, call.usage) || evidence.output !== call.output)) ||
            (evidence.status === 'failed' && evidence.error !== call.error)) failures.push(`invalid_consistency_evidence:${marker}`)
          if (call && !call.error && !validConsistencyOutput(call.output)) failures.push(`invalid_consistency_verdict:${marker}`)
          ids.add(evidence?.callId)
        }
        if (result.calls.some(call => call.stage === 'consistency' && (call.tools?.length || call.toolCalls?.length)) ||
          (result.toolResults || []).some(reply => reply.stage === 'consistency')) failures.push(`consistency_tool_execution:${marker}`)
      }
    }
    if (!isObject(result.expect)) fail('Invalid result expectations')
    const key = JSON.stringify([result.scenario, result.sampleIndex, result.eventIndex]), event = expected.get(key)
    if (!event) failures.push(`unexpected_event:${key}`)
    if (seen.has(key)) failures.push(`duplicate_event:${key}`)
    seen.add(key)
    const sampleKey = JSON.stringify([result.scenario, result.sampleIndex]), previous = sampleResults.get(sampleKey)
    if (previous && result.eventIndex <= previous.eventIndex) failures.push(`event_order_mismatch:${key}`)
    if (previous?.character && !same(result.beforeCharacter, previous.character)) failures.push(`character_continuity_mismatch:${key}`)
    if (assessmentVersion >= 3 && previous?.activities && !same(result.beforeActivities, previous.activities)) failures.push(`activity_continuity_mismatch:${key}`)
    if (!Number.isSafeInteger(result.at) || (previous && result.at < previous.at)) failures.push(`event_clock_mismatch:${key}`)
    sampleResults.set(sampleKey, result)
    if (event && (result.eventHash !== event.eventHash || !same(result.expect, event.expect))) failures.push(`event_manifest_mismatch:${key}`)
    for (const call of result.calls) {
      if (!isObject(call)) fail('Invalid captured model call')
      if (call.error) failures.push(`model_call_failed:${key}`)
      if (call.settled === false) failures.push(`model_call_unsettled:${key}`)
      if (call.usage?.total_tokens !== undefined && (!Number.isFinite(call.usage.total_tokens) || call.usage.total_tokens < 0)) fail('Invalid reported token usage')
      if (metadata.mode === 'live_model' && (!validHash(call.requestHash) || !Array.isArray(call.tools) || call.tools.some(tool => typeof tool !== 'string'))) failures.push(`missing_call_conditions:${key}`)
    }
    if (metadata.mode === 'live_model') for (const request of result.network) {
      if (!isObject(request) || !isObject(request.generation) || !isObject(request.generation.parameters) || !validHash(request.generation.hash) || request.generation.hash !== hashReplayValue(request.generation.parameters)) failures.push(`missing_or_invalid_generation_evidence:${key}`)
      if (assessmentVersion >= 3 && !stages.includes(request?.stage)) failures.push(`missing_http_stage:${key}`)
    }
    const before = result.beforeCharacter
    if (!isObject(before) || !['memories', 'goals', 'receipts'].every(field => Array.isArray(before[field]))) failures.push(`missing_before_character:${key}`)
    let behavior = {}
    if (result.status !== 'skipped') {
      if (!isObject(result.character) || !['memories', 'goals', 'receipts'].every(field => Array.isArray(result.character[field]))) failures.push(`missing_character:${key}`)
      else {
        if (!same(result.character.scope, before?.scope)) failures.push(`character_scope_changed:${key}`)
        if (result.sent.some(message => !isObject(message) || String(message.groupId) !== String(result.character.scope?.groupId))) failures.push(`send_scope_mismatch:${key}`)
        try { behavior = assessEvent({ kind: result.kind, expect: event?.expect || result.expect }, result) }
        catch { failures.push(`invalid_assessment_state:${key}`) }
        if (!same(behavior, result.behavior || {})) failures.push(`behavior_evidence_mismatch:${key}`)
        behaviorChecks += Object.keys(behavior).length
      }
    }
    if (result.errors.length || result.structuralFailures.length) failures.push(`runtime_or_structure_error:${key}`)
    observations.push({ scenario: result.scenario, sampleIndex: result.sampleIndex, eventIndex: result.eventIndex, status: result.status, behavior })
    recomputedResults.push({ ...result, behavior })
  }
  for (const key of expected.keys()) if (!seen.has(key)) failures.push(`missing_event:${key}`)
  const summary = summarize(recomputedResults)
  if (version < 5) { delete summary.consistencyCalls; delete summary.consistencyElapsedMs; delete summary.unsettledCalls }
  if (!same(summary, document.summary)) failures.push('saved_summary_mismatch')
  const uniqueFailures = [...new Set(failures)]
  const integrity = uniqueFailures.length ? 'failed' : 'passed'
  const engineering = integrity === 'passed' && !summary.failedEvents && !summary.skippedEvents ? 'passed' : 'failed'
  const behavior = summary.behaviorMisses ? 'failed' : behaviorChecks && engineering === 'passed' ? 'passed' : 'pending'
  const successfulHttpRequests = document.results.flatMap(result => result.network).filter(item => Number.isInteger(item.status) && item.status >= 200 && item.status < 300).length
  const liveModel = metadata.mode !== 'live_model' ? 'pending' : engineering === 'failed' || behavior === 'failed' ? 'failed' : summary.logicalCalls && successfulHttpRequests && behavior === 'passed' ? 'passed' : 'pending'
  return {
    mode: metadata.mode, integrity, integrityFailures: uniqueFailures, engineering, behavior, liveModel,
    assessmentVersion: metadata.assessmentVersion, repetitions: metadata.repetitions,
    ...(metadata.runId ? { runId: metadata.runId, startedAtISO: metadata.startedAtISO } : {}),
    fingerprints: Object.fromEntries(['runnerHash', 'scenariosHash', 'effectiveConfigHash', 'buildManifestHash', 'personaHash', 'scenarioManifestHash'].map(key => [key, metadata[key]])),
    expectedEvents: expected.size, behaviorChecks, successfulHttpRequests, summary, observations,
    samples: samples.filter(sample => Array.from({ length: sample.expectedEvents }, (_, eventIndex) => JSON.stringify([sample.scenario, sample.sampleIndex, eventIndex])).every(key => seen.has(key))),
  }
}

export function compareReplays(candidate, baseline, candidateHash, baselineHash) {
  if (!baseline) return { status: 'pending', reason: 'baseline_not_provided', singleVariableAttribution: false }
  const comparableFields = ['runnerHash', 'scenariosHash', 'personaHash', 'assessmentVersion', 'scenarioManifestHash', 'generation', 'simulationOverrides', 'clock', 'search', 'feeds', 'worker', 'reflection', 'consistency', 'storage', 'platform', 'toolResults', 'personaSource', 'seed', 'repetitions', 'maxCalls', 'maxHttp', 'maxDurationMs']
  const differences = comparableFields.filter(field => !same(candidate.metadata[field], baseline.metadata[field]))
  const observedGeneration = document => [...new Set(document.results.flatMap(result => result.network).map(request => hashReplayValue({ stage: request.stage, parameters: Object.fromEntries(Object.entries(request.generation?.parameters || {}).filter(([key]) => key !== 'model')) })))].sort()
  const observedTools = document => [...new Set(document.results.flatMap(result => result.calls).filter(call => Array.isArray(call.tools)).map(call => hashReplayValue({ stage: call.stage, tools: [...call.tools].sort() })))].sort()
  if (!same(observedGeneration(candidate), observedGeneration(baseline))) differences.push('observed_generation_parameters')
  if (!same(observedTools(candidate), observedTools(baseline))) differences.push('observed_tool_inventory')
  const configChanged = candidate.metadata.effectiveConfigHash !== baseline.metadata.effectiveConfigHash
  if (candidateHash === baselineHash) differences.push('same_evidence_file')
  if (candidate.metadata.assessmentVersion >= 3 && candidate.metadata.runId === baseline.metadata.runId) differences.push('same_run_identity')
  if (candidate.metadata.mode !== 'live_model' || baseline.metadata.mode !== 'live_model') differences.push('requires_two_live_model_runs')
  return {
    status: differences.length ? 'incompatible' : 'available', differences, configChanged,
    singleVariableAttribution: false,
    attribution: configChanged ? 'Effective configuration differs; these observations cannot isolate one changed variable.' : 'Matching recorded conditions allow observation comparison; hashes do not establish a causal improvement.',
    modelChanged: candidate.metadata.model !== baseline.metadata.model,
    buildChanged: candidate.metadata.buildManifestHash !== baseline.metadata.buildManifestHash,
  }
}

export function reviewTemplate(candidateSha256, samples) {
  return { schemaVersion: 1, candidateSha256, items: samples.map(({ sampleId }) => ({ sampleId, reviewer: '', verdict: 'pending', comment: '' })) }
}

export function validateReview(review, candidateSha256, samples) {
  ownFields(review, ['schemaVersion', 'candidateSha256', 'items'], 'review')
  if (review.schemaVersion !== 1 || review.candidateSha256 !== candidateSha256 || !Array.isArray(review.items)) fail('Review is not bound to the exact candidate evidence SHA256')
  const expected = new Set(samples.map(sample => sample.sampleId)), seen = new Set()
  for (const item of review.items) {
    ownFields(item, ['sampleId', 'reviewer', 'verdict', 'comment'], 'review item')
    if (!expected.has(item.sampleId) || seen.has(item.sampleId)) fail('Review has an unknown or duplicate sample')
    if (!['pending', 'accepted', 'rejected'].includes(item.verdict) || typeof item.reviewer !== 'string' || item.reviewer.length > 120 || typeof item.comment !== 'string' || item.comment.length > 2000) fail('Invalid review verdict, reviewer or comment')
    if (item.verdict !== 'pending' && (!item.reviewer.trim() || !item.comment.trim())) fail('Accepted or rejected reviews require a named reviewer and comment')
    seen.add(item.sampleId)
  }
  if (seen.size !== expected.size) fail('Review is missing candidate samples')
  return { status: review.items.some(item => item.verdict === 'rejected') ? 'rejected' : review.items.length && review.items.every(item => item.verdict === 'accepted') ? 'accepted' : 'pending', items: review.items }
}

function markdown(report) {
  const lines = [
    '# 角色影子回放验收', '',
    `候选证据 SHA256：\`${report.candidate.sha256}\``, '',
    `模式：${safeLabel(report.candidate.mode)}。阶段 7：**待真实群观察与部署验证**。`, '',
    '| 项目 | 结果 |', '| --- | --- |',
    `| 证据完整性 | ${report.candidate.integrity} |`,
    `| 工程执行 | ${report.candidate.engineering} |`,
    `| 本事件行为检查 | ${report.candidate.behavior} |`,
    `| 实模样本 | ${report.candidate.liveModel} |`,
    `| 对照条件 | ${report.comparison.status} |`,
    `| 人工评审 | ${report.humanReview.status} |`, '',
    `事件 ${report.candidate.summary.events}/${report.candidate.expectedEvents}；失败 ${report.candidate.summary.failedEvents}；跳过 ${report.candidate.summary.skippedEvents}；行为未达 ${report.candidate.summary.behaviorMisses}。`, '',
    `模型调用 ${report.candidate.summary.logicalCalls}，HTTP 请求 ${report.candidate.summary.httpRequests}，已报告 tokens ${report.candidate.summary.reportedTokens}，usage 缺失 ${report.candidate.summary.callsWithoutUsage}；金额未知。`, '',
    '离线或注入模型只能证明工程行为。工程通过不能替代自然度、跨天稳定性或真实群体验验收；本工具不自动判定阶段 7 完成。', '',
    '阅读候选 results.json 中每个样本的完整输入、输出、工具调用/结果与前后状态，然后填写 review.json 的 reviewer、verdict 和 comment，再使用 --review 生成新目录。不得把脚本输出作为实模体验。', '',
    '## 样本', '', '| 样本 | 事件数 | 人工结论 |', '| --- | --- | --- |',
  ]
  for (const sample of report.candidate.samples) lines.push(`| ${safeLabel(sample.sampleId)} | ${sample.expectedEvents} | ${report.humanReview.items.find(item => item.sampleId === sample.sampleId)?.verdict || 'pending'} |`)
  if (report.candidate.integrityFailures.length) lines.push('', '## 证据问题', '', ...report.candidate.integrityFailures.map(item => `- ${safeLabel(item)}`))
  if (report.comparison.differences?.length) lines.push('', '## 对照条件差异', '', ...report.comparison.differences.map(item => `- ${safeLabel(item)}`))
  if (report.comparison.attribution) lines.push('', report.comparison.attribution)
  lines.push('', '真实群跨天观察、打扰反馈、实际费用、暂停/回退和部署状态仍须提供独立证据。', '')
  return lines.join('\n')
}

export async function main(argv = process.argv.slice(2), { log = console.log } = {}) {
  const options = parseOptions(argv)
  if (options.help) { log(usage); return { exitCode: 0 } }
  // Validate all inputs before creating a result directory. Never overwrite old evidence.
  if (fs.existsSync(options.outputDir)) fail('Output directory already exists; choose a fresh directory')
  const candidateFile = readJson(options.candidate), candidate = inspectReplay(candidateFile.value)
  const baselineFile = options.baseline ? readJson(options.baseline) : undefined
  const baseline = baselineFile ? inspectReplay(baselineFile.value) : undefined
  const comparison = compareReplays(candidateFile.value, baselineFile?.value, candidateFile.sha256, baselineFile?.sha256)
  const review = options.review ? readJson(options.review).value : reviewTemplate(candidateFile.sha256, candidate.samples)
  const humanReview = validateReview(review, candidateFile.sha256, candidate.samples)
  const report = {
    schemaVersion: 1,
    candidate: { file: candidateFile.name, sha256: candidateFile.sha256, ...candidate },
    ...(baseline ? { baseline: { file: baselineFile.name, sha256: baselineFile.sha256, ...baseline } } : {}),
    comparison, humanReview,
    stage7: { status: 'pending', realGroupObservation: 'not_provided', deployment: 'not_verified', reason: 'Shadow reports cannot replace actual cross-day group observation and deployment evidence.' },
    evidenceTrust: 'Fingerprints check local consistency and bind review to saved bytes; they do not authenticate a provider, a human reviewer or an actual independent deployment.',
  }
  const failed = candidate.integrity === 'failed' || candidate.engineering === 'failed' || candidate.behavior === 'failed' || humanReview.status === 'rejected' || baseline?.integrity === 'failed' || baseline?.engineering === 'failed' || baseline?.behavior === 'failed' || (comparison.status === 'incompatible' && candidate.mode === 'live_model' && baseline?.mode === 'live_model')
  report.shadowAcceptance = failed ? 'failed' : candidate.liveModel === 'passed' && baseline?.liveModel === 'passed' && comparison.status === 'available' && humanReview.status === 'accepted' ? 'passed' : 'pending'
  report.exitCode = failed ? 1 : 2
  fs.mkdirSync(options.outputDir, { mode: 0o700 })
  fs.writeFileSync(path.join(options.outputDir, 'acceptance.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 })
  fs.writeFileSync(path.join(options.outputDir, 'review.json'), JSON.stringify(review, null, 2), { flag: 'wx', mode: 0o600 })
  fs.writeFileSync(path.join(options.outputDir, 'report.md'), markdown(report), { flag: 'wx', mode: 0o600 })
  log(JSON.stringify({ outputDir: options.outputDir, shadowAcceptance: report.shadowAcceptance, stage7: 'pending', exitCode: report.exitCode }))
  return report
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = (await main()).exitCode } catch (error) { console.error(error.message); process.exitCode = 1 }
}
