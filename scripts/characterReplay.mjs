// Shadow replay of the compiled simulation runtime. Never imports the host adapter.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { hashReplayValue, generationEvidence, createReplayScrubber, writeReplayCheckpoint } from './conversationQualityReplay.mjs'
import { verifyBackend } from './lib/build-support.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BOT = '99000001', GROUP = '99000002'
const BASE_AT = Date.parse('2026-11-09T04:00:00Z')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
export const assessmentVersion = 3
const EXPECTATIONS = ['refusal', 'goalCreated', 'goalCompleted', 'opinion', 'revisedOpinion', 'noSend', 'noCall', 'waitAfterFailure', 'workCreated', 'workRevised', 'subscriptionAdded', 'feedUpdated', 'reflected', 'goalPaused', 'workerUnknown', 'noWorkerCall', 'noReflectionCall']
const ACTIVITY_FIELDS = ['works', 'subscriptions', 'reflection', 'shared', 'sharedPending']
const plainObject = value => !!value && typeof value === 'object' && !Array.isArray(value)
export const usage = 'Usage: node scripts/characterReplay.mjs [--dry-run] [--config-root path] [--output-dir path] [--scenario id] [--repetitions 1..5] [--max-calls 1..200] [--max-http 1..300] [--max-duration-ms 1..3600000]\nLive mode calls only the configured model. QQ, Redis, search and other external tools stay isolated. Dry mode uses scripted tool calls; it cannot assess model behavior or naturalness.'

export function parseOptions(argv = [], cwd = process.cwd()) {
  const values = new Map(), flags = new Set(['--help', '--dry-run'])
  const fields = new Set(['--config-root', '--output-dir', '--scenario', '--repetitions', '--max-calls', '--max-http', '--max-duration-ms'])
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if ((!flags.has(key) && !fields.has(key)) || values.has(key)) throw new Error(`Unknown or duplicate option: ${key}`)
    if (flags.has(key)) values.set(key, true)
    else {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error(`Missing value: ${key}`)
      values.set(key, value)
    }
  }
  const count = (key, fallback, max) => {
    const value = values.get(key) ?? String(fallback)
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) throw new Error(`Invalid ${key} (1..${max})`)
    return Number(value)
  }
  return {
    help: values.has('--help'), dryRun: values.has('--dry-run'), repetitions: count('--repetitions', 1, 5),
    maxCalls: count('--max-calls', 60, 200), maxHttp: count('--max-http', 80, 300),
    maxDurationMs: count('--max-duration-ms', 600_000, 3_600_000),
    configRoot: path.resolve(cwd, values.get('--config-root') || ROOT),
    outputDir: path.resolve(cwd, values.get('--output-dir') || `/tmp/bl-character-replay-${Date.now()}`),
    scenario: values.get('--scenario') || '',
  }
}

export function validateScenarios(scenarios) {
  const ids = new Set()
  if (!Array.isArray(scenarios) || !scenarios.length) throw new Error('Scenarios must be a nonempty array')
  for (const scenario of scenarios) {
    if (!plainObject(scenario) || typeof scenario.id !== 'string' || !scenario.id.trim() || ids.has(scenario.id)) throw new Error('Scenario ids must be unique')
    if (Object.keys(scenario).some(key => !['id', 'review', 'workerOutcome', 'events'].includes(key))) throw new Error('Invalid scenario field')
    if (scenario.workerOutcome !== undefined && !['succeeded', 'failed', 'unknown'].includes(scenario.workerOutcome)) throw new Error('Invalid scenario worker outcome')
    ids.add(scenario.id)
    if (!Array.isArray(scenario.events) || !scenario.events.length) throw new Error(`Missing events: ${scenario.id}`)
    for (const event of scenario.events) {
      if (!plainObject(event) || !['message', 'goal-check', 'idle-check', 'background-check', 'passive'].includes(event.kind)) throw new Error(`Invalid event kind: ${scenario.id}`)
      if (Object.keys(event).some(key => !['kind', 'text', 'advanceMs', 'advanceToNextGoalCheck', 'isolateBackgroundSchedule', 'expect', 'restart', 'searchOutcome', 'feedItemId', 'offline', 'offlineReflection'].includes(key))) throw new Error('Invalid event field')
      if (['message', 'passive'].includes(event.kind) && (typeof event.text !== 'string' || !event.text.trim())) throw new Error('Missing message text')
      if (event.advanceMs !== undefined && (!Number.isSafeInteger(event.advanceMs) || event.advanceMs < 0)) throw new Error('Invalid event time')
      if (event.advanceToNextGoalCheck !== undefined && (typeof event.advanceToNextGoalCheck !== 'boolean' || event.kind !== 'goal-check' || event.advanceMs !== undefined)) throw new Error('Invalid goal-check clock option')
      if (event.isolateBackgroundSchedule !== undefined && (typeof event.isolateBackgroundSchedule !== 'boolean' || event.kind !== 'background-check')) throw new Error('Invalid background schedule option')
      if (event.expect !== undefined && (!plainObject(event.expect) || Object.entries(event.expect).some(([key, value]) => !EXPECTATIONS.includes(key) || typeof value !== 'boolean'))) throw new Error('Invalid event expectations')
      if (event.restart !== undefined && typeof event.restart !== 'boolean') throw new Error('Invalid restart flag')
      if (event.searchOutcome !== undefined && !['succeeded', 'failed'].includes(event.searchOutcome)) throw new Error('Invalid search outcome')
      if (event.feedItemId !== undefined && (typeof event.feedItemId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/u.test(event.feedItemId))) throw new Error('Invalid feed item id')
      if (event.offlineReflection !== undefined && (!plainObject(event.offlineReflection) || Object.keys(event.offlineReflection).some(key => !['summary', 'updates', 'goals'].includes(key)) || typeof event.offlineReflection.summary !== 'string' || event.offlineReflection.summary.length > 500 || !Array.isArray(event.offlineReflection.updates) || event.offlineReflection.updates.length > 2 || !Array.isArray(event.offlineReflection.goals) || event.offlineReflection.goals.length > 1 || event.offlineReflection.updates.some(update => !plainObject(update) || Object.keys(update).some(key => !['kind', 'content', 'evidenceRefs', 'supersedes'].includes(key)) || !['opinion', 'interest'].includes(update.kind) || typeof update.content !== 'string' || !update.content.trim() || update.content.length > 600 || !Array.isArray(update.evidenceRefs) || !update.evidenceRefs.length || update.evidenceRefs.some(ref => typeof ref !== 'string' || !ref.trim()) || (update.supersedes !== undefined && typeof update.supersedes !== 'string')) || event.offlineReflection.goals.some(goal => !plainObject(goal) || Object.keys(goal).some(key => !['id', 'action', 'reason', 'nextStep'].includes(key)) || typeof goal.id !== 'string' || !goal.id.trim() || !['wait', 'abandon'].includes(goal.action) || typeof goal.reason !== 'string' || !goal.reason.trim() || goal.reason.length > 500 || (goal.nextStep !== undefined && typeof goal.nextStep !== 'string')))) throw new Error('Invalid offline reflection')
      if (event.offline !== undefined && (!Array.isArray(event.offline) || event.offline.some(round => !Array.isArray(round) || round.some(call => !plainObject(call) || Object.keys(call).some(key => !['name', 'args'].includes(key)) || typeof call.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]*$/u.test(call.name) || !plainObject(call.args))))) throw new Error('Invalid offline script')
    }
  }
  return scenarios
}

/** Only advance the synthetic clock; never create, extend or rewrite a goal. */
export function planGoalCheckAdvance(state, fromAt) {
  const goal = !state.paused && state.goals.filter(item => ['active', 'waiting'].includes(item.status) &&
    item.expiresAt > Math.max(fromAt, item.nextCheckAt) && item.attempts < item.maxAttempts &&
    !state.receipts.some(receipt => receipt.goalId === item.id && receipt.status === 'pending'))
    .sort((left, right) => left.nextCheckAt - right.nextCheckAt || left.createdAt - right.createdAt)[0]
  const toAt = goal ? Math.max(fromAt, goal.nextCheckAt) : fromAt
  return { mode: 'advance_to_next_eligible_goal', fromAt, toAt, advanceMs: toAt - fromAt,
    goalId: goal?.id ?? null, nextCheckAt: goal?.nextCheckAt ?? null, expiresAt: goal?.expiresAt ?? null }
}

/** Explicit fixture setup confined to the in-memory session and recorded verbatim. */
export function prepareBackgroundSchedule(state, at) {
  const snapshot = value => ({ nextReplyCheckAt: value.nextReplyCheckAt, pendingWakeReasons: structuredClone(value.pendingWakeReasons),
    wakeMode: value.wakeConfig.mode, sleepUntil: value.wakeConfig.sleepUntil ?? null, nextProactiveCheckAt: value.nextProactiveCheckAt })
  const next = structuredClone(state), before = snapshot(next)
  next.nextReplyCheckAt = 0; next.pendingWakeReasons = []
  next.wakeConfig.mode = 'diving'; delete next.wakeConfig.sleepUntil
  next.nextProactiveCheckAt = at + 7 * 86400000
  return { state: next, evidence: { fixture: true, at, before, after: snapshot(next) } }
}

/** Minimal public scenario contract for independent report completeness checks. */
export function scenarioManifest(scenarios) {
  validateScenarios(scenarios)
  return scenarios.map(scenario => ({ id: scenario.id, events: scenario.events.map((event, eventIndex) => ({ eventIndex, eventHash: hashReplayValue(event), expect: structuredClone(event.expect || {}) })) }))
}

export function summarize(results) {
  const calls = results.flatMap(r => r.calls || [])
  const usageRecords = calls.map(c => c.usage).filter(u => u && typeof u.total_tokens === 'number')
  return {
    events: results.length, failedEvents: results.filter(r => r.status === 'failed').length,
    skippedEvents: results.filter(r => r.status === 'skipped').length,
    behaviorMisses: results.reduce((sum, r) => sum + Object.values(r.behavior || {}).filter(v => v === false).length, 0),
    logicalCalls: calls.length, mainCalls: calls.filter(call => call.stage !== 'reflection').length, reflectionCalls: calls.filter(call => call.stage === 'reflection').length,
    feedFetches: results.reduce((sum, r) => sum + (r.feeds?.length || 0), 0), workerCalls: results.reduce((sum, r) => sum + (r.workers?.length || 0), 0),
    httpRequests: results.reduce((sum, r) => sum + (r.network?.length || 0), 0),
    capturedMessages: results.reduce((sum, r) => sum + (r.sent?.length || 0), 0),
    reportedTokens: usageRecords.reduce((sum, u) => sum + u.total_tokens, 0),
    callsWithoutUsage: calls.length - usageRecords.length, costCny: null, naturalness: 'requires_human_review',
  }
}

function replaceVariables(value, state, activities = {}) {
  const variables = {
    $goalId: state.goals.at(-1)?.id,
    $memoryId: state.memories.at(-1)?.id,
    $memoryRef: state.memories.at(-1) ? `memory:${state.memories.at(-1).id}` : undefined,
    $firstMemoryRef: state.memories[0] ? `memory:${state.memories[0].id}` : undefined,
    $previousMemoryRef: state.memories.at(-2) ? `memory:${state.memories.at(-2).id}` : undefined,
    $receiptRef: state.receipts.filter(r => r.toolName === 'searchInformationTool').at(-1)?.id,
    $workerReceiptRef: state.receipts.filter(r => r.toolName === 'simWorkerTask').at(-1) ? `receipt:${state.receipts.filter(r => r.toolName === 'simWorkerTask').at(-1).id}` : undefined,
    $workId: activities.works?.at(-1)?.id,
    $workRevision: activities.works?.at(-1)?.revision,
  }
  if (variables.$receiptRef) variables.$receiptRef = `receipt:${variables.$receiptRef}`
  if (typeof value === 'string' && value in variables) {
    if (variables[value] === undefined) throw new Error(`Offline script has unresolved ${value}`)
    return variables[value]
  }
  if (Array.isArray(value)) return value.map(v => replaceVariables(v, state, activities))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceVariables(v, state, activities)]))
  return value
}

export function assessEvent(event, result) {
  // A skipped dependency produced no behavior observation. Its skipped status
  // still blocks engineering acceptance independently of behavior totals.
  if (result.status === 'skipped') return {}
  const state = result.character, before = result.beforeCharacter, behavior = {}
  const wants = event.expect || {}
  const goals = state?.goals || [], oldGoals = before?.goals || [], memories = state?.memories || [], oldMemories = before?.memories || []
  const newMemories = before ? memories.filter(memory => !oldMemories.some(old => old.id === memory.id)) : []
  const changedGoal = goal => before && oldGoals.some(old => old.id === goal.id && JSON.stringify(old) !== JSON.stringify(goal))
  const explicitlyTransitionedGoal = goal => {
    const old = oldGoals.find(item => item.id === goal.id)
    const automaticAttempts = (state?.receipts || []).filter(receipt => receipt.goalId === goal.id && receipt.toolName === 'simGoalCheck' && !(before?.receipts || []).some(previous => previous.id === receipt.id)).length
    return changedGoal(goal) && old && Number.isSafeInteger(goal.revision) && Number.isSafeInteger(old.revision) && goal.revision > old.revision + automaticAttempts
  }
  const toolInputs = name => (result.calls || []).flatMap(call => (call.toolCalls || []).flatMap(toolCall => {
    if (toolCall.function?.name !== name) return []
    try { const args = JSON.parse(toolCall.function.arguments); return plainObject(args) ? [args] : [] } catch { return [] }
  }))
  const oldActivities = result.beforeActivities, activities = result.activities
  const hasActivities = oldActivities && activities && ACTIVITY_FIELDS.every(field => field in oldActivities && field in activities) &&
    Array.isArray(oldActivities.works) && Array.isArray(activities.works) && Array.isArray(oldActivities.subscriptions) && Array.isArray(activities.subscriptions) && plainObject(oldActivities.reflection) && plainObject(activities.reflection)
  const oldWorks = hasActivities ? oldActivities.works : [], works = hasActivities ? activities.works : []
  const oldSubscriptions = hasActivities ? oldActivities.subscriptions : [], subscriptions = hasActivities ? activities.subscriptions : []
  const newReceipts = before ? (state?.receipts || []).filter(receipt => !(before.receipts || []).some(old => old.id === receipt.id)) : []
  const currentWorkerReceipts = status => newReceipts.filter(receipt => receipt.toolName === 'simWorkerTask' && receipt.status === status &&
    (result.workers || []).some(worker => worker.task?.taskId === receipt.id && worker.result?.status === status))
  const createdWork = work => !oldWorks.some(old => old.id === work.id) && Array.isArray(work.versions) && work.versions.some(version => version.revision === work.revision &&
    (toolInputs('simWorkspace').some(args => args.action === 'write' && !args.id && args.content === version.content && args.title === work.title) ||
      currentWorkerReceipts('succeeded').some(receipt => (version.evidenceRefs || []).includes(`receipt:${receipt.id}`) &&
        (result.workers || []).some(worker => worker.task?.taskId === receipt.id && worker.result?.artifact?.content === version.content))))
  const refusal = ['unwilling', 'cannot', 'unauthorized'].includes(state?.decision?.kind) && before &&
    Number.isSafeInteger(result.at) && state.decision.at >= result.at && JSON.stringify(state.decision) !== JSON.stringify(before.decision) &&
    toolInputs('simDecide').some(args => Object.keys(args).every(key => ['kind', 'reason'].includes(key)) &&
          typeof args.kind === 'string' && args.kind.trim() === state.decision.kind && typeof args.reason === 'string' &&
          !!args.reason.trim() && args.reason.trim() === state.decision.reason)
  const checks = {
    refusal: ['refusalRecorded', !!refusal],
    goalCreated: ['goalCreatedByModel', !!before && goals.some(goal => !oldGoals.some(old => old.id === goal.id))],
    goalCompleted: ['goalCompletedWithReceipt', !!before && goals.some(goal => goal.status === 'completed' && oldGoals.find(old => old.id === goal.id)?.status !== 'completed' &&
      (goal.evidenceRefs || []).some(ref => (state?.receipts || []).some(receipt => ref === `receipt:${receipt.id}` && receipt.status === 'succeeded' && receipt.goalId === goal.id)))],
    opinion: ['opinionPersisted', newMemories.some(memory => memory.kind === 'opinion' && memory.epistemic === 'inferred')],
    revisedOpinion: ['opinionRevisionPersisted', newMemories.some(memory => memory.kind === 'opinion' && memory.epistemic === 'inferred' && memory.supersedes &&
      oldMemories.some(old => old.id === memory.supersedes && old.kind === 'opinion' && memory.createdAt > old.createdAt) &&
      (memory.evidenceRefs || []).includes(`memory:${memory.supersedes}`))],
    noSend: ['noMessageSent', (result.sent || []).length === 0],
    noCall: ['noModelCall', (result.calls || []).length === 0],
    waitAfterFailure: ['waitedAfterFailure', goals.some(goal => ['waiting', 'abandoned', 'failed'].includes(goal.status) && explicitlyTransitionedGoal(goal) &&
      toolInputs('simGoal').some(args => args.id === goal.id && ((args.action === 'wait' && goal.status === 'waiting') || (args.action === 'abandon' && goal.status === 'abandoned'))))],
    workCreated: ['workCreatedWithEvidence', !!hasActivities && works.some(createdWork)],
    workRevised: ['workRevisionPersisted', !!hasActivities && works.some(work => {
      const old = oldWorks.find(item => item.id === work.id)
      return old && work.revision > old.revision && (work.versions || []).some(version => version.revision === work.revision && !(old.versions || []).some(previous => previous.revision === version.revision) &&
        toolInputs('simWorkspace').some(args => args.action === 'write' && args.id === work.id && args.expectedRevision === old.revision && args.content === version.content))
    })],
    subscriptionAdded: ['subscriptionAddedByModel', !!hasActivities && subscriptions.some(subscription => !oldSubscriptions.some(old => old.id === subscription.id) &&
      toolInputs('simSubscription').some(args => args.action === 'add' && args.url === subscription.url && args.kind === subscription.kind && args.title === subscription.title))],
    feedUpdated: ['newFeedItemCommitted', !!hasActivities && subscriptions.some(subscription => (subscription.items || []).some(item =>
      !oldSubscriptions.find(old => old.id === subscription.id)?.seenIds?.includes(item.id) &&
      !(oldSubscriptions.find(old => old.id === subscription.id)?.items || []).some(old => old.id === item.id) &&
      (result.feeds || []).some(feed => feed.url === subscription.url && feed.kind === subscription.kind && (feed.items || []).some(fetched => fetched.id === item.id))))],
    reflected: ['independentOpinionPersisted', !!hasActivities && newMemories.some(memory => memory.id.startsWith('reflection-') && memory.kind === 'opinion' && memory.epistemic === 'inferred' &&
      (result.reflections || []).some(reflection => reflection.status === 'succeeded' && reflection.callId && (result.calls || []).some(call => call.id === reflection.callId && call.stage === 'reflection')) &&
      activities.reflection.lastRunAt >= result.at && activities.reflection.lastRunAt !== oldActivities.reflection.lastRunAt &&
      (memory.evidenceRefs || []).some(ref => !(oldActivities.reflection.processed || []).includes(ref) && (activities.reflection.processed || []).includes(ref)))],
    goalPaused: ['goalPausedAfterUnknownWorker', !!before && goals.some(goal => goal.status === 'paused' && oldGoals.find(old => old.id === goal.id)?.status !== 'paused' && currentWorkerReceipts('unknown').some(receipt => receipt.goalId === goal.id))],
    workerUnknown: ['workerUnknownReceiptRecorded', currentWorkerReceipts('unknown').length > 0],
    noWorkerCall: ['noWorkerSubmitted', Array.isArray(result.workers) && result.workers.length === 0],
    noReflectionCall: ['noReflectionModelCall', Array.isArray(result.reflections) && result.reflections.length === 0],
  }
  for (const [name, expected] of Object.entries(wants)) {
    if (!EXPECTATIONS.includes(name) || typeof expected !== 'boolean') throw new Error('Invalid event expectations')
    const [key, actual] = checks[name]
    behavior[key] = actual === expected
  }
  return behavior
}

// Exported injection is for runner tests, never for CLI configuration.
export async function main(argv = process.argv.slice(2), { model, turnTimeoutMs = 60_000, log = console.log } = {}) {
  const options = parseOptions(argv)
  if (options.help) { log(usage); return { exitCode: 0 } }
  const startedAtISO = new Date().toISOString(), runId = randomUUID()
  const runDeadline = Date.now() + options.maxDurationMs
  await verifyBackend(undefined, { source: true })
  const load = file => import(pathToFileURL(path.join(ROOT, 'dist/backend', file)).href)
  const [runtimeModule, configModule, stateModule, hostModule, mergeModule] = await Promise.all([
    load('modules/simulation/infrastructure/simulationRuntime.js'), load('modules/simulation/domain/simConfig.js'),
    load('modules/simulation/domain/characterState.js'), load('modules/host/infrastructure/hostConfig.js'),
    load('modules/config/infrastructure/configStore.js'),
  ])
  const { createSimulationRuntime } = runtimeModule
  const { createDefaultSimSession } = configModule
  const { characterKey } = stateModule
  const require = createRequire(path.join(ROOT, 'package.json')), YAML = require('yaml')
  const read = file => {
    try { const doc = YAML.parse(fs.readFileSync(file, 'utf8')); return doc?.pluginSettings || doc || {} }
    catch { throw new Error('Cannot parse replay configuration (private contents omitted)') }
  }
  const privateFile = path.join(options.configRoot, 'config/message.yaml')
  const defaults = read(path.join(ROOT, 'config_default/message.yaml'))
  const supplied = options.dryRun || model ? {} : fs.existsSync(privateFile) ? read(privateFile) : {}
  const config = hostModule.decodeHostConfig(mergeModule.mergeDeepConfig(defaults, supplied))
  if (config.simulation?.turnModel && config.toolsAiConfig) config.toolsAiConfig.toolsAiModel = config.simulation.turnModel
  // A failed tools request may use production fallback routing. Placeholder
  // defaults are not configured fallbacks and must never receive a request.
  for (const [section, keyField] of [['chatAiConfig', 'chatApiKey'], ['trackAiConfig', 'trackAiApikey'], ['searchAiConfig', 'searchApiKey'], ['memoryAiConfig', 'memoryAiApikey']]) {
    const keys = config[section]?.[keyField]
    const configured = (Array.isArray(keys) ? keys : [keys]).filter(k => typeof k === 'string' && k && !/sk-xxx|your[_ -]?key|请填/i.test(k))
    if (!configured.length) config[section] = {}
  }
  const scrub = createReplayScrubber({ ...config, systemPrompt: config.persona })
  const clean = value => JSON.parse(scrub(JSON.stringify(value)))
  const scenarioFile = path.join(ROOT, 'tests/fixtures/characterReplayScenarios.json')
  const scenarios = validateScenarios(JSON.parse(fs.readFileSync(scenarioFile, 'utf8'))).filter(s => !options.scenario || s.id.includes(options.scenario))
  if (!scenarios.length) throw new Error('No matching scenarios')
  const manifest = scenarioManifest(scenarios)
  // Never export full configuration, prompts, Authorization, or hidden model reasoning.
  const metadata = {
    schemaVersion: 1, assessmentVersion, runId, startedAtISO, scenarioManifest: manifest, scenarioManifestHash: hashReplayValue(manifest), mode: options.dryRun ? 'scripted_offline' : model ? 'injected_test' : 'live_model',
    runnerHash: hashReplayValue(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')),
    scenariosHash: hashReplayValue(scenarios), effectiveConfigHash: hashReplayValue(config),
    buildManifestHash: hashReplayValue(fs.readFileSync(path.join(ROOT, 'dist/backend/manifest.json'), 'utf8')),
    model: config.toolsAiConfig?.toolsAiModel || null, personaHash: hashReplayValue(config.persona || {}),
    clock: 'fixed initial event epoch; explicit event advances or opt-in earliest eligible model-created goal time; elapsed wall time within events; actual adjustments recorded',
    search: 'synthetic_fixture', feeds: 'synthetic_fixture; no_real_HTTP', worker: 'synthetic_fixture; scenario_fixed_outcome_for_all_submissions; no_external_worker_submission', reflection: 'separate_reflectCharacter_port; scripted_in_dry_mode; configured_memory_backend_in_live_mode',
    storage: 'fresh_in_memory_per_sample', platform: 'captured_only',
    toolResults: 'current_event_tool_replies_from_model_requests_and_final_persisted_session; no_extra_model_calls',
    generation: 'configured_executor_with_2048_output_token_cap; compatibility_retries_record_actual_parameters',
    simulationOverrides: { tools: 'character_and_activity_tools_plus_synthetic_search_and_worker', maxToolRounds: 6, maxSendsPerTurn: 3, waitMaxMs: 1000, auxiliaryModels: false, independentReflection: true, probabilityWake: false, scheduledIdleProbability: 1, backgroundCheck: 'defer_proactive; explicit_per_event_isolation_clears_reply_pending_wakes_and_active_timeout; changes_recorded' },
    personaSource: 'merged_config_persona; persona_library_bindings_not_loaded',
    seed: 'empty_bound_session; no_goals_or_memories_seeded',
    eventStatusMeaning: 'engineering_execution_only; inspect_behavior_observations_separately',
    maxCalls: options.maxCalls, maxHttp: options.maxHttp, maxDurationMs: options.maxDurationMs, repetitions: options.repetitions,
    review: 'structural checks and behavior observations do not establish naturalness or production acceptance',
  }
  fs.mkdirSync(options.outputDir, { recursive: true, mode: 0o700 })
  const outputFile = path.join(options.outputDir, 'results.json')
  if (fs.existsSync(outputFile)) throw new Error('Output already exists; select a fresh --output-dir to preserve evidence')
  const results = []
  const document = complete => clean({ complete, metadata, platformMessagesSent: 0, productionStoreWrites: 0, results, summary: summarize(results) })
  const checkpoint = complete => writeReplayCheckpoint(outputFile, document(complete))
  checkpoint(false)
  let logicalCalls = 0, httpCalls = 0, callId = 0, halted = ''
  const backend = config.toolsAiConfig || {}
  if (!options.dryRun && !model && (!backend.toolsAiUrl || !backend.toolsAiModel || !backend.toolsAiApikey || /sk-xxx|your[_ -]?key|请填/i.test(backend.toolsAiApikey))) halted = 'model_configuration_missing'
  const executorParts = !options.dryRun && !model ? await Promise.all([
    load('modules/models/application/modelExecution.js'), load('modules/models/domain/chatCompletionUrl.js'),
    load('modules/conversation/domain/agentIntelligence.js'), load('modules/foundation/domain/textUtils.js'),
  ]) : null
  for (const scenario of scenarios) for (let sampleIndex = 1; sampleIndex <= options.repetitions; sampleIndex++) {
    const kv = new Map(), scope = { botId: BOT, personaId: 'character-replay', groupId: GROUP }
    let epoch = BASE_AT, anchor = Date.now(), activeResult, activeEvent, eventCalls = 0, controller, activeModelStage
    const now = () => epoch + Date.now() - anchor
    const sessionKey = `shiloh:sim:g:${GROUP}`
    const seeded = createDefaultSimSession(now())
    seeded.botId = BOT; seeded.bootstrapSent = true; seeded.wakeConfig.triggers.probability = 0
    seeded.wakeConfig.triggers.question = false; seeded.wakeConfig.triggers.nameMention = false
    seeded.nextProactiveCheckAt = 0
    kv.set(sessionKey, JSON.stringify(seeded))
    const character = () => JSON.parse(kv.get(characterKey(scope)) || JSON.stringify(stateModule.createEmptyCharacterState(scope)))
    const logger = {
      info() {}, warn(...args) { if (activeResult) activeResult.warnings.push(scrub(args.map(String).join(' '))) },
      error(first, error) {
        // modelExecution logs the entire successful response at error level; keep it out.
        if (String(first).startsWith('OpenAI 响应:')) return
        if (activeResult) activeResult.errors.push(scrub([first, error instanceof Error ? error.message : typeof error === 'string' ? error : ''].filter(Boolean).join(' ')))
      },
    }
    const executor = executorParts ? executorParts[0].createModelExecutor({
      ...executorParts[2], ...executorParts[3], ...executorParts[1], logger,
      fetch: async (url, init) => {
        if (Date.now() >= runDeadline) halted ||= 'run_duration_exhausted'
        if (halted) throw new Error(halted)
        if (httpCalls >= options.maxHttp) { halted = 'http_budget_exhausted'; throw new Error(halted) }
        httpCalls++
        const payload = JSON.parse(init.body), start = Date.now()
        const evidence = { stage: activeModelStage, model: payload.model, host: new URL(url).host, generation: generationEvidence(payload), status: null, elapsedMs: 0 }
        activeResult.network.push(evidence)
        try {
          const response = await fetch(url, { ...init, signal: AbortSignal.any([controller.signal, ...(init.signal ? [init.signal] : []), AbortSignal.timeout(30_000)]) })
          evidence.status = response.status
          return response
        } catch (error) {
          evidence.error = scrub(error.message)
          if (error.cause?.code === 'ECONNREFUSED' || ['ENOTFOUND', 'EAI_AGAIN'].includes(error.cause?.code)) halted = 'model_endpoint_unavailable'
          throw error
        } finally { evidence.elapsedMs = Date.now() - start }
      },
    }) : null
    const redis = { get: async key => kv.get(key) ?? null, set: async (key, value) => { kv.set(key, value); return 'OK' }, del: async (...keys) => { for (const key of keys) kv.delete(key) } }
    const search = {
      name: 'searchInformationTool', description: '读取合成评测资料；结果只存在于本回放，不是网络验证。',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
      async execute(args, event) {
        const failed = activeEvent.searchOutcome === 'failed'
        event.simulationReportOutcome(failed ? 'failed' : 'succeeded')
        activeResult.searches.push({ fixture: true, args, actor: event.simulationActor, outcome: failed ? 'failed' : 'succeeded' })
        return failed ? { ok: false, error: '合成搜索源暂不可用，未取得资料' } : { ok: true, fixture: true, text: '合成资料：《纸灯塔》是手工地图的探索解谜游戏，有 3 个可选难度。此资料仅供评测，不是真实作品信息。' }
      },
    }
    const activitySnapshot = async () => {
      const activities = (await runtime.describeGroup(GROUP)).activities
      return Object.fromEntries(ACTIVITY_FIELDS.map(field => [field, structuredClone(activities[field])]))
    }
    const captureToolResults = messages => {
      for (const message of messages || []) {
        if (message.role !== 'tool') continue
        const toolCallId = String(message.tool_call_id || '')
        const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? null)
        const key = hashReplayValue({ toolCallId, content })
        if (activeResult.toolResults.some(result => result.hash === key)) continue
        const call = activeResult.calls.find(call => (call.toolCalls || []).some(tool => tool.id === toolCallId))
        const tool = call?.toolCalls.find(tool => tool.id === toolCallId)
        if (!tool) continue // Old history is not evidence of a tool execution in this event.
        activeResult.toolResults.push({ hash: key, stage: call.stage, toolCallId, name: message.name || tool.function?.name || '', content })
      }
    }
    const invokeModel = async (stage, request, executionConfig, signal = controller.signal) => {
      if (Date.now() >= runDeadline) halted ||= 'run_duration_exhausted'
      if (logicalCalls >= options.maxCalls || halted) { halted ||= 'logical_call_budget_exhausted'; throw new Error(halted) }
      logicalCalls++
      const capture = { id: `model-${logicalCalls}`, stage, requestHash: hashReplayValue(request), tools: request.tools?.map(t => t.function.name) || [], usage: null }
      activeResult.calls.push(capture)
      const reflection = stage === 'reflection' ? { callId: capture.id, requestHash: capture.requestHash, status: 'pending', usage: null } : undefined
      if (reflection) activeResult.reflections.push(reflection)
      captureToolResults(request.messages)
      activeModelStage = stage
      try {
        let response
        if (options.dryRun) {
          const message = { role: 'assistant', content: '' }
          if (stage === 'reflection') message.content = JSON.stringify(replaceVariables(activeEvent.offlineReflection || { summary: '没有需要持久化的新观点', updates: [], goals: [] }, character(), await activitySnapshot()))
          else {
            const scripted = activeEvent.offline?.[eventCalls++] || []
            if (scripted.length) message.tool_calls = replaceVariables(scripted, character(), await activitySnapshot()).map(call => ({ id: `offline-${++callId}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }))
          }
          response = { choices: [{ message }], model: stage === 'reflection' ? 'offline-reflection-script' : 'offline-script' }
        } else response = model ? await model(request, { stage, scenario, event: activeEvent, sampleIndex, signal }) : await executor.YTapi(request, executionConfig, undefined, undefined, {
          signal: AbortSignal.any([controller.signal, signal]), generation: { maxOutputTokens: stage === 'reflection' ? 1200 : 2048 }, ...(stage === 'reflection' ? { taskBackend: 'memory' } : {}),
        })
        capture.usage = response?.usage ?? null
        capture.model = response?.model ?? null
        const message = response?.choices?.[0]?.message
        capture.output = message?.content || ''
        capture.toolCalls = (message?.tool_calls || []).map(call => ({ id: call.id, type: call.type, function: { name: call.function?.name, arguments: call.function?.arguments } }))
        if (response?.error || !message) throw new Error(scrub(typeof response?.error === 'string' ? response.error : 'model_returned_no_message'))
        if (reflection) Object.assign(reflection, { status: 'succeeded', output: capture.output, usage: capture.usage, model: capture.model })
        return response
      } catch (error) {
        capture.error = scrub(error.message)
        if (reflection) {
          Object.assign(reflection, { status: 'failed', error: capture.error })
          activeResult.errors.push(`reflection_model_error: ${capture.error}`)
        }
        throw error
      } finally { activeModelStage = undefined }
    }
    const create = () => createSimulationRuntime({
      redis, now, random: () => 0.99, logger,
      getSelf: () => ({ id: BOT, name: config.persona?.name || '希洛' }),
      getPersona: () => ({ personaId: scope.personaId, persona: config.persona || {}, systemContent: config.systemContent || '' }),
      getSection: () => ({
        enabled: true, allGroups: false, groups: [GROUP], extraTools: [search.name], toolPolicy: { mode: 'legacy' },
        wake: { probability: 0, batchWindowMs: 1000, maxWakePerMinute: 100, maxWakePerHour: 100, proactiveProbability: 1, proactiveIdleMs: 60_000 },
        turn: { maxToolRounds: 6, minSendGapMs: 0, maxSendsPerTurn: 3, maxTurnsPerDay: 40, waitQuietMaxMs: 1000, waitTimeoutMaxMs: 1000 },
        rhythm: { enabled: false }, mood: { enabled: false }, wakeGate: { enabled: false }, userStyle: { enabled: false }, lifeThreads: { enabled: false },
      }),
      getExecutionConfig: () => ({ ...config, useTools: true }), getExtraTools: names => names.includes(search.name) ? [search] : [],
      async fetchCharacterFeed(url, kind) {
        const id = activeEvent.feedItemId || 'fixture-release-1'
        const items = [{ id, title: '纸灯塔合成更新', url: `https://example.com/releases/${id}`, summary: '合成订阅资料：开发者介绍线索可读性改进，未查证真实作品。', receivedAt: now() }]
        activeResult.feeds.push({ fixture: true, url, kind, items: structuredClone(items) })
        return items
      },
      characterWorkerAvailable: () => true,
      async runCharacterWorker(task, workerScope, signal) {
        const status = scenario.workerOutcome || 'succeeded'
        const result = status === 'succeeded' ? { status, summary: '合成研究草稿已返回，尚未经真实资料核实', artifact: { title: '纸灯塔谜题线索研究草稿', content: '合成工作器产物：从群友提供的兴趣线索出发，整理地图路径、谜题提示和线索连贯性三个比较维度。此草稿仅供回放评测，没有访问真实网站或运行外部任务。' } } : { status, summary: status === 'unknown' ? '合成工作器结果未知，禁止把本次任务当成已完成' : '合成工作器执行失败，未取得产物' }
        activeResult.workers.push({ fixture: true, task: structuredClone(task), scope: structuredClone(workerScope), aborted: signal.aborted, result: structuredClone(result) })
        return result
      },
      reflectCharacter: (request, executionConfig, signal) => invokeModel('reflection', request, executionConfig, signal),
      YTapi: (request, executionConfig) => invokeModel('main', request, executionConfig),
      async sendGroupMessage(groupId, segments) {
        activeResult.sent.push({ groupId, segments })
        return { ok: true, messageId: `captured-${activeResult.sent.length}` }
      },
    })
    let runtime = create()
    try {
      for (let eventIndex = 0; eventIndex < scenario.events.length; eventIndex++) {
        activeEvent = scenario.events[eventIndex]; eventCalls = 0
        epoch = now() + (activeEvent.advanceMs || 0); anchor = Date.now()
        controller = new AbortController()
        const before = character()
        const clockAdjustment = activeEvent.advanceToNextGoalCheck ? planGoalCheckAdvance(before, now()) : undefined
        if (clockAdjustment) { epoch = clockAdjustment.toAt; anchor = Date.now() }
        const beforeActivities = await activitySnapshot()
        activeResult = { scenario: scenario.id, sampleIndex, eventIndex, eventHash: hashReplayValue(activeEvent), beforeCharacter: before, beforeActivities, activities: structuredClone(beforeActivities), kind: activeEvent.kind, input: activeEvent.text || '', at: now(), status: 'passed', review: scenario.review, expect: activeEvent.expect || {}, calls: [], network: [], sent: [], searches: [], toolResults: [], feeds: [], workers: [], reflections: [], warnings: [], errors: [], structuralFailures: [] }
        if (clockAdjustment) activeResult.clockAdjustment = clockAdjustment
        if (Date.now() >= runDeadline) halted ||= 'run_duration_exhausted'
        if (halted) {
          activeResult.status = 'skipped'; activeResult.skipReason = halted
          results.push(clean(activeResult)); checkpoint(false); continue
        }
        const start = Date.now()
        try {
          if (activeEvent.restart) { runtime.stop(); runtime = create(); activeResult.restarted = true }
          if (activeEvent.kind === 'goal-check' && !stateModule.dueCharacterGoal(before, now())) {
            activeResult.status = 'skipped'; activeResult.skipReason = 'model_created_no_due_goal'
          } else {
            const budgetBefore = (await runtime.describeGroup(GROUP)).budget.turns
            if (activeEvent.kind === 'message' || activeEvent.kind === 'passive') {
              const at = activeEvent.kind === 'message'
              await runtime.ingest({ group_id: GROUP, self_id: BOT, user_id: String(99000003 + (eventIndex % 2)), message_type: 'group', msg: activeEvent.text, atBot: at,
                message: at ? [{ type: 'at', data: { qq: BOT } }, { type: 'text', data: { text: activeEvent.text } }] : [], sender: { nickname: `评测群友${eventIndex % 2}` } })
            } else {
              if (activeEvent.kind === 'idle-check') {
                const state = JSON.parse(kv.get(sessionKey)); state.nextProactiveCheckAt = now() - 1; kv.set(sessionKey, JSON.stringify(state))
                activeResult.forcedIdleSchedule = true
              } else if (activeEvent.kind === 'background-check') {
                let state = JSON.parse(kv.get(sessionKey))
                if (activeEvent.isolateBackgroundSchedule) {
                  const prepared = prepareBackgroundSchedule(state, now()); state = prepared.state
                  activeResult.backgroundScheduleIsolation = prepared.evidence
                } else state.nextProactiveCheckAt = now() + 7 * 86400000
                kv.set(sessionKey, JSON.stringify(state))
                activeResult.deferredProactiveSchedule = true
              }
              await runtime.sweepOnce()
            }
            if (['passive', 'background-check'].includes(activeEvent.kind)) await sleep(1250)
            for (;;) {
              const detail = await runtime.describeGroup(GROUP)
              if (!detail.running && (['passive', 'background-check'].includes(activeEvent.kind) || activeResult.calls.length || detail.budget.turns > budgetBefore)) break
              if (Date.now() >= runDeadline) throw new Error('run_duration_exhausted')
              if (Date.now() - start > turnTimeoutMs) throw new Error('turn_timeout')
              await sleep(25)
            }
            if (halted) throw new Error(halted)
          }
          activeResult.character = character()
          activeResult.activities = await activitySnapshot()
          activeResult.behavior = assessEvent(activeEvent, activeResult)
          if (activeResult.errors.length) activeResult.structuralFailures.push('runtime_or_model_error')
          if (activeResult.character.scope.groupId !== GROUP || activeResult.sent.some(s => s.groupId !== GROUP)) activeResult.structuralFailures.push('scope_mismatch')
          if (activeEvent.searchOutcome === 'failed') {
            if (activeResult.character.goals.some(g => g.status === 'completed') && !before.goals.some(g => g.status === 'completed')) activeResult.structuralFailures.push('completed_after_failed_search')
            if (activeResult.character.memories.some(m => m.epistemic === 'observed' && !before.memories.some(old => old.id === m.id) &&
              !m.evidenceRefs.some(ref => activeResult.character.receipts.some(r => ref === `receipt:${r.id}` && r.status === 'succeeded')))) activeResult.structuralFailures.push('observation_without_successful_receipt')
          }
          if (activeResult.structuralFailures.length) activeResult.status = 'failed'
        } catch (error) {
          activeResult.status = 'failed'; activeResult.errors.push(scrub(error.message)); activeResult.structuralFailures.push('exception')
          activeResult.character = character(); controller.abort(); runtime.stop()
          try { activeResult.activities = await activitySnapshot() } catch { /* Preserve the last trustworthy snapshot if shutdown prevents observation. */ }
          activeResult.behavior = assessEvent(activeEvent, activeResult)
          // Do not allow an unsettled timed-out runtime to contaminate later events.
          halted ||= 'previous_event_incomplete'
        }
        // The last tool round may have no following model request. Read its
        // persisted replies; never spend another model call just to observe it.
        captureToolResults(JSON.parse(kv.get(sessionKey)).agentHistory)
        const requestedToolCallIds = [...new Set(activeResult.calls.flatMap(call => (call.toolCalls || []).map(tool => tool.id)))]
        const missingToolCallIds = requestedToolCallIds.filter(id => !activeResult.toolResults.some(result => result.toolCallId === id))
        activeResult.toolResultCapture = { complete: !missingToolCallIds.length, requestedToolCallIds, missingToolCallIds }
        if (missingToolCallIds.length && activeResult.status === 'passed') {
          activeResult.structuralFailures.push('tool_result_capture_incomplete')
          activeResult.status = 'failed'
        }
        activeResult.elapsedMs = Date.now() - start
        results.push(clean(activeResult)); checkpoint(false)
        log(JSON.stringify({ scenario: scenario.id, sampleIndex, eventIndex, status: activeResult.status, calls: activeResult.calls.length, sent: activeResult.sent.length, behavior: activeResult.behavior, skipReason: activeResult.skipReason }))
      }
    } finally { controller?.abort(); runtime.stop() }
  }
  checkpoint(true)
  const report = document(true)
  const exitCode = report.summary.failedEvents ? 1 : report.summary.skippedEvents ? 2 : 0
  log(JSON.stringify({ outputFile, mode: metadata.mode, ...report.summary, exitCode }))
  return { ...report, outputFile, exitCode }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = (await main()).exitCode } catch (error) { console.error(error.message); process.exitCode = 1 }
}
