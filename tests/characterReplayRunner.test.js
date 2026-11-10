import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseOptions, validateScenarios, summarize, assessEvent, assessmentVersion, scenarioManifest, planGoalCheckAdvance, prepareBackgroundSchedule, main } from '../scripts/characterReplay.mjs'
import { inspectReplay } from '../scripts/characterAcceptance.mjs'
import { hashReplayValue } from '../scripts/conversationQualityReplay.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runner = path.join(root, 'scripts/characterReplay.mjs')
const scratch = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-character-runner-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}
const noLog = () => {}

test('import and help do not read private configuration, call a model, or create evidence', t => {
  const dir = scratch(t), privateRoot = path.join(dir, 'private'), output = path.join(dir, 'output')
  const code = `
    import fs from 'node:fs';
    const privateRoot = ${JSON.stringify(privateRoot)};
    const original = fs.readFileSync;
    fs.readFileSync = (file, ...args) => { if (String(file).startsWith(privateRoot)) throw new Error('private read'); return original(file, ...args); };
    globalThis.fetch = () => { throw new Error('unexpected network'); };
    process.argv.push('--unknown-option');
    const {main} = await import(${JSON.stringify(new URL('../scripts/characterReplay.mjs', import.meta.url).href)});
    const result = await main(['--help', '--config-root', privateRoot, '--output-dir', ${JSON.stringify(output)}], {model: () => { throw new Error('unexpected model'); }, log: () => {}});
    console.log(JSON.stringify({exitCode:result.exitCode, privateExists:fs.existsSync(privateRoot), outputExists:fs.existsSync(${JSON.stringify(output)})}));
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: dir, encoding: 'utf8', timeout: 5000 })
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout), { exitCode: 0, privateExists: false, outputExists: false })
})

test('CLI budgets are bounded integers and unknown, duplicate, or valueless options fail', () => {
  const parsed = parseOptions(['--dry-run', '--repetitions', '2', '--max-calls', '3', '--max-http', '4', '--output-dir', 'evidence'], '/tmp')
  assert.equal(parsed.dryRun, true)
  assert.equal(parsed.repetitions, 2)
  assert.equal(parsed.maxCalls, 3)
  assert.equal(parsed.maxHttp, 4)
  assert.equal(parsed.outputDir, '/tmp/evidence')
  for (const args of [
    ['--unknown'], ['--dry-run', '--dry-run'], ['--scenario'],
    ['--max-calls', '0'], ['--max-calls', '201'], ['--max-http', '301'],
    ['--repetitions', '6'], ['--repetitions', '1.5'], ['--repetitions', '1e0'],
    ['--max-calls', 'Infinity'], ['--max-http', '--help'],
  ]) assert.throws(() => parseOptions(args), undefined, JSON.stringify(args))
})

test('scenario validation rejects unusable events before replay starts', () => {
  assert.throws(() => validateScenarios([]), /nonempty/)
  const one = { id: 'one', events: [{ kind: 'message', text: '你好' }] }
  assert.equal(validateScenarios([one])[0], one)
  assert.throws(() => validateScenarios([one, one]), /unique/)
  for (const event of [{ kind: 'message', text: ' ' }, { kind: 'webhook' }, { kind: 'idle-check', advanceMs: -1 }, { kind: 'passive', text: '旁听', offline: {} }]) {
    assert.throws(() => validateScenarios([{ id: 'bad', events: [event] }]))
  }
})

test('scenario expectations and offline calls fail closed on misspelled or malformed fields', () => {
  for (const extra of [
    { expect: { refusla: true } }, { expect: { refusal: 'true' } }, { expect: null }, { expect: [] },
    { offline: [null] }, { offline: [[null]] }, { offline: [[{ name: '', args: {} }]] },
    { offline: [[{ name: 'simDecide', args: [] }]] }, { offline: [[{ name: 'simDecide', args: {}, unsafe: true }]] },
    { workerOutcome: 'success' }, { feedItemId: '../unsafe' }, { workerOutome: 'succeeded' },
    { offlineReflection: null }, { offlineReflection: { summary: '', updates: {}, goals: [] } },
    { offlineReflection: { summary: 'invalid', updates: [{ kind: 'opinion', content: '无来源', evidenceRefs: [] }], goals: [] } },
    { offlineReflection: { summary: 'invalid', updates: [], goals: [{ id: 'g', action: 'complete', reason: '越权完成' }] } },
  ]) assert.throws(() => validateScenarios([{ id: 'bad', events: [{ kind: 'message', text: '你好', ...extra }] }]), undefined, JSON.stringify(extra))
})

test('fixture scheduling options are explicit, kind-bound and cannot conflict with time advances', () => {
  const valid = { id: 'one', workerOutcome: 'unknown', events: [{ kind: 'goal-check', advanceToNextGoalCheck: true }, { kind: 'background-check', isolateBackgroundSchedule: true }] }
  assert.equal(validateScenarios([valid])[0], valid)
  for (const scenario of [
    { ...valid, workerOutcome: 'success' },
    { ...valid, events: [{ kind: 'goal-check', advanceToNextGoalCheck: 'true' }] },
    { ...valid, events: [{ kind: 'message', text: '你好', advanceToNextGoalCheck: true }] },
    { ...valid, events: [{ kind: 'goal-check', advanceToNextGoalCheck: true, advanceMs: 1 }] },
    { ...valid, events: [{ kind: 'background-check', isolateBackgroundSchedule: 1 }] },
    { ...valid, events: [{ kind: 'idle-check', isolateBackgroundSchedule: true }] },
    { ...valid, events: [{ kind: 'goal-check', workerOutcome: 'unknown' }] },
  ]) assert.throws(() => validateScenarios([scenario]))
})

test('goal clock planning only selects existing eligible goals and never rewrites their deadlines', () => {
  const goal = (id, nextCheckAt, extra = {}) => ({ id, status: 'active', nextCheckAt, expiresAt: 1000, attempts: 0, maxAttempts: 3, createdAt: 1, ...extra })
  const state = { paused: false, goals: [goal('later', 300), goal('first', 200), goal('expired', 10, { expiresAt: 20 }), goal('exhausted', 5, { attempts: 3 }), goal('pending', 2), goal('paused', 1, { status: 'paused' }), goal('invalid-window', 1200)], receipts: [{ goalId: 'pending', status: 'pending' }] }
  const original = structuredClone(state)
  assert.deepEqual(planGoalCheckAdvance(state, 100), { mode: 'advance_to_next_eligible_goal', fromAt: 100, toAt: 200, advanceMs: 100, goalId: 'first', nextCheckAt: 200, expiresAt: 1000 })
  assert.equal(planGoalCheckAdvance(state, 250).toAt, 250, 'already due goals do not move the clock backwards')
  assert.equal(planGoalCheckAdvance({ ...state, paused: true }, 100).goalId, null)
  assert.equal(planGoalCheckAdvance({ ...state, goals: [] }, 100).advanceMs, 0)
  assert.equal(planGoalCheckAdvance(state, 1000).goalId, null)
  assert.deepEqual(state, original)
})

test('background setup records competing wakes and only changes synthetic schedule fields', () => {
  const state = { nextReplyCheckAt: 5, pendingWakeReasons: [{ kind: 'replyCheck' }, { kind: 'timeout' }], nextProactiveCheckAt: 6,
    wakeConfig: { mode: 'active', sleepUntil: 7, triggers: { atMention: true } }, unread: [{ seq: 1 }], budget: { turns: 2 }, agentHistory: ['keep'] }
  const original = structuredClone(state), prepared = prepareBackgroundSchedule(state, 10)
  assert.equal(prepared.evidence.before.nextReplyCheckAt, 5)
  assert.deepEqual(prepared.evidence.before.pendingWakeReasons, state.pendingWakeReasons)
  assert.equal(prepared.evidence.before.sleepUntil, 7)
  assert.deepEqual(prepared.state.unread, state.unread)
  assert.deepEqual(prepared.state.budget, state.budget)
  assert.deepEqual(prepared.state.agentHistory, state.agentHistory)
  assert.deepEqual(prepared.state.wakeConfig.triggers, state.wakeConfig.triggers)
  assert.deepEqual(prepared.evidence.after.pendingWakeReasons, [])
  assert.equal(prepared.evidence.after.nextReplyCheckAt, 0)
  assert.equal(prepared.evidence.after.wakeMode, 'diving')
  assert.equal(prepared.evidence.after.sleepUntil, null)
  assert.ok(prepared.evidence.after.nextProactiveCheckAt > 10)
  assert.deepEqual(state, original)
})

test('an early worker submission uses the scenario outcome and remains a behavior miss', async t => {
  let round = 0
  const report = await main(['--scenario', 'worker-unknown-pause', '--output-dir', path.join(scratch(t), 'evidence')], {
    model: async (_request, context) => {
      const tool_calls = context.event.kind === 'message' && round++ === 0 ? [{ id: 'early-worker', type: 'function', function: { name: 'simWorkerTask', arguments: JSON.stringify({ kind: 'research', instruction: '整理谜题提示维度，仅合成回放。', evidenceRefs: ['message:1'] }) } }] : undefined
      return { choices: [{ message: { role: 'assistant', content: '', ...(tool_calls ? { tool_calls } : {}) } }] }
    }, log: noLog, turnTimeoutMs: 5000,
  })
  const initial = report.results[0]
  assert.equal(initial.workers.length, 1)
  assert.equal(initial.workers[0].result.status, 'unknown', 'an early call must not receive the success default')
  assert.equal(initial.activities.works.length, 0)
  assert.equal(initial.behavior.noWorkerSubmitted, false, 'early execution stays visible as a violated expectation')
  assert.ok(initial.character.receipts.some(receipt => receipt.toolName === 'simWorkerTask' && receipt.status === 'unknown'))
  assert.equal(report.results[1].status, 'skipped', 'the runner does not create a missing goal')
  assert.equal(inspectReplay(report).engineering, 'failed')
})

test('goal checks advance to a model-created due time without expiring its 24 hour deadline', async t => {
  let round = 0
  const report = await main(['--scenario', 'worker-success-artifact', '--output-dir', path.join(scratch(t), 'evidence')], {
    model: async (_request, context) => {
      const tool_calls = context.event.kind === 'message' && round++ === 0 ? [{ id: 'create-goal', type: 'function', function: { name: 'simGoal', arguments: JSON.stringify({ action: 'create', title: '比较谜题提示', motivation: '兴趣延续', nextStep: '稍后请工作器比较', completionCriteria: '有来源的草稿', stopConditions: ['结果未知'], evidenceRefs: ['message:1'], expiresInHours: 24, nextCheckInMinutes: 15 }) } }] : undefined
      return { choices: [{ message: { role: 'assistant', content: '', ...(tool_calls ? { tool_calls } : {}) } }] }
    }, log: noLog, turnTimeoutMs: 5000,
  })
  const [initial, check] = report.results, goal = initial.character.goals[0]
  assert.ok(goal)
  assert.ok(check.at >= goal.nextCheckAt)
  assert.ok(check.at < goal.expiresAt, 'the fixture must check the goal while it remains eligible')
  assert.equal(check.clockAdjustment.goalId, goal.id)
  assert.equal(check.clockAdjustment.nextCheckAt, goal.nextCheckAt)
  assert.ok(check.clockAdjustment.advanceMs > 0)
  assert.ok(check.character.goals.every(item => item.lastOutcome !== '目标已过期'))
  assert.deepEqual(inspectReplay(report).summary, report.summary)
})

test('background fixtures record and clear competing reply and timeout schedules before polling', async t => {
  let round = 0
  const report = await main(['--scenario', 'subscription-update-dedup', '--output-dir', path.join(scratch(t), 'evidence')], {
    model: async (_request, context) => {
      const tool_calls = context.event.kind === 'message' && round++ === 0 ? [
        { id: 'subscribe', type: 'function', function: { name: 'simSubscription', arguments: JSON.stringify({ action: 'add', title: '公开更新', kind: 'rss', url: 'https://example.com/feed.xml', intervalHours: 1 }) } },
        { id: 'schedule', type: 'function', function: { name: 'simSetWakeConfig', arguments: JSON.stringify({ mode: 'active', sleepMinutes: 1 }) } },
      ] : undefined
      return { choices: [{ message: { role: 'assistant', content: '', ...(tool_calls ? { tool_calls } : {}) } }] }
    }, log: noLog, turnTimeoutMs: 5000,
  })
  const first = report.results[1], duplicate = report.results[2]
  assert.ok(first.backgroundScheduleIsolation)
  assert.equal(first.backgroundScheduleIsolation.before.wakeMode, 'active')
  assert.equal(first.backgroundScheduleIsolation.after.wakeMode, 'diving')
  assert.equal(first.backgroundScheduleIsolation.after.sleepUntil, null)
  assert.equal(first.backgroundScheduleIsolation.after.nextReplyCheckAt, 0)
  assert.deepEqual(first.backgroundScheduleIsolation.after.pendingWakeReasons, [])
  assert.ok(first.backgroundScheduleIsolation.after.nextProactiveCheckAt > first.at)
  assert.equal(first.feeds.length, 1, 'the first declared background event must perform its due feed poll')
  assert.equal(first.behavior.newFeedItemCommitted, true)
  assert.equal(duplicate.feeds.length, 1)
  assert.equal(duplicate.calls.length, 0)
  assert.equal(duplicate.behavior.newFeedItemCommitted, true, 'the repeated item does not count as a new update')
  assert.deepEqual(inspectReplay(report).summary, report.summary)
})

test('behavior assessment never credits stale decisions, goals or memories to a new event', () => {
  const beforeCharacter = {
    revision: 4, decision: { kind: 'unwilling', reason: '上一轮的拒绝', at: 10 },
    memories: [{ id: 'old', kind: 'opinion', epistemic: 'inferred', createdAt: 1 }],
    goals: [{ id: 'old-goal', status: 'completed', evidenceRefs: ['receipt:r1'] }],
    receipts: [{ id: 'r1', goalId: 'old-goal', status: 'succeeded', at: 10 }],
  }
  const expect = { refusal: true, goalCreated: true, goalCompleted: true, opinion: true, revisedOpinion: true, waitAfterFailure: true }
  const result = { beforeCharacter, character: structuredClone(beforeCharacter), calls: [], sent: [], at: 20 }
  assert.deepEqual(Object.values(assessEvent({ expect }, result)), [false, false, false, false, false, false])
  result.character.goals[0].status = 'waiting'
  result.beforeCharacter.goals[0].status = 'waiting'
  assert.equal(assessEvent({ expect: { waitAfterFailure: true } }, result).waitedAfterFailure, false)
})

test('completed goals require a new completion and a matching successful goal receipt', () => {
  const beforeCharacter = { goals: [{ id: 'g1', status: 'waiting', revision: 1 }], memories: [], receipts: [] }
  const character = { goals: [{ id: 'g1', status: 'completed', revision: 2, evidenceRefs: ['receipt:r1'] }], memories: [], receipts: [{ id: 'r1', goalId: 'other', status: 'succeeded', at: 20 }] }
  const result = { beforeCharacter, character, calls: [], sent: [], at: 20 }
  assert.equal(assessEvent({ expect: { goalCompleted: true } }, result).goalCompletedWithReceipt, false)
  character.receipts[0].goalId = 'g1'; character.receipts[0].status = 'unknown'
  assert.equal(assessEvent({ expect: { goalCompleted: true } }, result).goalCompletedWithReceipt, false)
  character.receipts[0].status = 'succeeded'
  assert.equal(assessEvent({ expect: { goalCompleted: true } }, result).goalCompletedWithReceipt, true)
  beforeCharacter.goals[0].status = 'completed'
  assert.equal(assessEvent({ expect: { goalCompleted: true } }, result).goalCompletedWithReceipt, false)
})

test('refusal assessment requires a current valid model decision that actually persisted', () => {
  const beforeCharacter = { decision: { kind: 'unwilling', reason: '以前的拒绝', at: 1 }, memories: [], goals: [] }
  const character = { ...beforeCharacter, decision: { kind: 'unauthorized', reason: '没有权限', at: 20 } }
  const call = args => ({ toolCalls: [{ function: { name: 'simDecide', arguments: JSON.stringify(args) } }] })
  const result = { beforeCharacter, character, at: 20, calls: [], sent: [] }
  assert.equal(assessEvent({ expect: { refusal: true } }, result).refusalRecorded, false)
  result.calls = [call({ kind: 'unauthorized', reason: '没有权限', unsupported: true })]
  assert.equal(assessEvent({ expect: { refusal: true } }, result).refusalRecorded, false)
  result.calls = [call({ kind: 'unauthorized', reason: '没有权限' })]
  assert.equal(assessEvent({ expect: { refusal: true } }, result).refusalRecorded, true)
  result.at = 21
  assert.equal(assessEvent({ expect: { refusal: true } }, result).refusalRecorded, false)
})

test('new opinions and goal waiting require event changes rather than automatic attempts or old revisions', () => {
  const beforeCharacter = { goals: [{ id: 'g1', status: 'active', revision: 1 }], memories: [{ id: 'm1', kind: 'opinion', epistemic: 'inferred', createdAt: 1 }], receipts: [] }
  const character = { goals: [{ id: 'g1', status: 'waiting', revision: 2 }], memories: [...beforeCharacter.memories, { id: 'm2', kind: 'opinion', epistemic: 'inferred', createdAt: 2, supersedes: 'm1', evidenceRefs: ['memory:m1'] }], receipts: [{ id: 'check', goalId: 'g1', toolName: 'simGoalCheck', status: 'unknown' }] }
  const result = { beforeCharacter, character, at: 2, calls: [], sent: [] }
  const expect = { opinion: true, revisedOpinion: true, waitAfterFailure: true }
  assert.deepEqual(assessEvent({ expect }, result), { opinionPersisted: true, opinionRevisionPersisted: true, waitedAfterFailure: false })
  result.calls = [{ toolCalls: [{ function: { name: 'simGoal', arguments: '{"action":"wait","id":"g1"}' } }] }]
  assert.equal(assessEvent({ expect }, result).waitedAfterFailure, false, 'a proposed wait rejected by the tool cannot borrow the automatic attempt revision')
  character.goals[0].revision = 3
  assert.equal(assessEvent({ expect }, result).waitedAfterFailure, true)
  assert.deepEqual(Object.values(assessEvent({ expect }, { ...result, beforeCharacter: undefined })), [false, false, false])
  assert.equal(assessEvent({ expect: { noCall: false } }, result).noModelCall, true)
})

test('scenario manifest binds ordered event hashes and declared expectations', () => {
  const scenarios = [{ id: 'one', events: [{ kind: 'message', text: '你好', expect: { refusal: false } }, { kind: 'idle-check' }] }]
  const manifest = scenarioManifest(scenarios)
  assert.equal(assessmentVersion, 3)
  assert.deepEqual(manifest, [{ id: 'one', events: [{ eventIndex: 0, eventHash: hashReplayValue(scenarios[0].events[0]), expect: { refusal: false } }, { eventIndex: 1, eventHash: hashReplayValue(scenarios[0].events[1]), expect: {} }] }])
  scenarios[0].events[0].expect.refusal = true
  assert.equal(manifest[0].events[0].expect.refusal, false, 'manifest expectations must be a frozen snapshot')
  assert.notEqual(hashReplayValue(manifest), hashReplayValue(scenarioManifest(scenarios)))
})

test('summary keeps missing usage and unknown money distinct from reported tokens', () => {
  const report = summarize([{ status: 'passed', calls: [{ usage: null }, {}, { usage: { total_tokens: 7 } }], sent: [], behavior: {} }])
  assert.equal(report.logicalCalls, 3)
  assert.equal(report.reportedTokens, 7)
  assert.equal(report.callsWithoutUsage, 2)
  assert.equal(report.costCny, null)
  assert.equal(report.naturalness, 'requires_human_review')
  const behavior = assessEvent({ expect: { goalCompleted: true, noSend: true } }, { character: { goals: [{ status: 'waiting', evidenceRefs: [] }], memories: [] }, sent: [], calls: [] })
  assert.equal(behavior.goalCompletedWithReceipt, false)
  assert.equal(behavior.noMessageSent, true)
})

test('skipped dependencies have no observed behavior and remain visible in summary', () => {
  const result = { status: 'skipped', skipReason: 'model_created_no_due_goal', calls: [], sent: [], character: { goals: [], memories: [] } }
  result.behavior = assessEvent({ expect: { goalCompleted: true } }, result)
  assert.deepEqual(result.behavior, {})
  assert.equal(summarize([result]).behaviorMisses, 0)
  assert.equal(summarize([result]).skippedEvents, 1)
})

test('activity assessment fails closed for stale or missing snapshots and unconfirmed worker evidence', () => {
  const character = { goals: [{ id: 'g', status: 'paused' }], memories: [{ id: 'reflection-old', kind: 'opinion', epistemic: 'inferred' }], receipts: [{ id: 'worker', toolName: 'simWorkerTask', status: 'unknown', goalId: 'g' }] }
  const activities = { works: [{ id: 'w', revision: 2, versions: [{ revision: 2, content: '旧正文' }] }], subscriptions: [{ id: 's', url: 'https://example.com/feed.xml', kind: 'rss', items: [{ id: 'old' }], seenIds: ['old'] }], reflection: { lastRunAt: 10, processed: ['memory:old'] }, shared: [], sharedPending: [] }
  const expect = { workCreated: true, workRevised: true, subscriptionAdded: true, feedUpdated: true, reflected: true, goalPaused: true, workerUnknown: true }
  const result = { beforeCharacter: structuredClone(character), character, beforeActivities: structuredClone(activities), activities, calls: [], feeds: [], workers: [], reflections: [], at: 20 }
  assert.deepEqual(Object.values(assessEvent({ expect }, result)), Array(7).fill(false))
  assert.deepEqual(Object.values(assessEvent({ expect }, { ...result, beforeActivities: undefined })), Array(7).fill(false))
  result.beforeCharacter.goals[0].status = 'active'
  result.beforeCharacter.receipts = []
  assert.equal(assessEvent({ expect: { goalPaused: true, workerUnknown: true } }, result).goalPausedAfterUnknownWorker, false, 'an unknown receipt without the current port submission cannot count')
  result.workers.push({ task: { taskId: 'worker' }, result: { status: 'unknown' } })
  assert.deepEqual(assessEvent({ expect: { goalPaused: true, workerUnknown: true } }, result), { goalPausedAfterUnknownWorker: true, workerUnknownReceiptRecorded: true })
  result.character.receipts[0].status = 'succeeded'
  assert.equal(assessEvent({ expect: { workerUnknown: true } }, result).workerUnknownReceiptRecorded, false)
})

test('workspace revisions and feed updates require matching current tool or fixture evidence', () => {
  const empty = { works: [], subscriptions: [], reflection: {}, shared: [], sharedPending: [] }
  const result = { beforeCharacter: { goals: [], memories: [], receipts: [] }, character: { goals: [], memories: [], receipts: [] }, beforeActivities: structuredClone(empty), activities: structuredClone(empty), calls: [], feeds: [], workers: [], reflections: [] }
  result.activities.works.push({ id: 'w', title: '笔记', revision: 1, versions: [{ revision: 1, content: '第一版' }] })
  const toolCall = (name, args) => ({ toolCalls: [{ function: { name, arguments: JSON.stringify(args) } }] })
  const expected = { workCreated: true, workRevised: true, feedUpdated: true }
  assert.deepEqual(Object.values(assessEvent({ expect: expected }, result)), [false, false, false])
  result.calls.push(toolCall('simWorkspace', { action: 'write', title: '笔记', content: '第一版' }))
  assert.equal(assessEvent({ expect: expected }, result).workCreatedWithEvidence, true)
  result.beforeActivities = structuredClone(result.activities)
  result.activities.works[0].revision = 2
  result.activities.works[0].versions.push({ revision: 2, content: '第二版' })
  result.calls = [toolCall('simWorkspace', { action: 'write', id: 'w', expectedRevision: 1, content: '错误正文' })]
  assert.equal(assessEvent({ expect: expected }, result).workRevisionPersisted, false)
  result.calls = [toolCall('simWorkspace', { action: 'write', id: 'w', expectedRevision: 1, content: '第二版' })]
  assert.equal(assessEvent({ expect: expected }, result).workRevisionPersisted, true)
  result.activities.subscriptions.push({ id: 's', url: 'https://example.com/feed.xml', kind: 'rss', items: [{ id: 'new' }], seenIds: ['new'] })
  assert.equal(assessEvent({ expect: expected }, result).newFeedItemCommitted, false)
  result.feeds.push({ url: 'https://example.com/feed.xml', kind: 'rss', items: [{ id: 'new' }] })
  assert.equal(assessEvent({ expect: expected }, result).newFeedItemCommitted, true)
  result.beforeActivities.subscriptions = structuredClone(result.activities.subscriptions)
  assert.equal(assessEvent({ expect: expected }, result).newFeedItemCommitted, false)
})

test('all scripted scenarios exercise cross-day continuity and repeat with isolated stores', async t => {
  const dir = scratch(t), output = path.join(dir, 'evidence'), privateRoot = path.join(dir, 'must-not-read')
  const code = `
    import fs from 'node:fs';
    const privateRoot = ${JSON.stringify(privateRoot)};
    const original = fs.readFileSync;
    fs.readFileSync = (file, ...args) => { if (String(file).startsWith(privateRoot)) throw new Error('private read'); return original(file, ...args); };
    globalThis.fetch = () => { throw new Error('unexpected network'); };
    const {main} = await import(${JSON.stringify(new URL('../scripts/characterReplay.mjs', import.meta.url).href)});
    const result = await main(['--dry-run', '--repetitions', '2', '--max-calls', '200', '--config-root', privateRoot, '--output-dir', ${JSON.stringify(output)}], {log:()=>{}});
    console.log(JSON.stringify(result));
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024 })
  assert.equal(child.status, 0, child.stderr)
  const report = JSON.parse(child.stdout)
  assert.equal(report.exitCode, 0, JSON.stringify(report.summary))
  assert.equal(report.complete, true)
  assert.equal(report.metadata.assessmentVersion, assessmentVersion)
  assert.match(report.metadata.runId, /^[a-f0-9-]{36}$/u)
  assert.ok(Number.isFinite(Date.parse(report.metadata.startedAtISO)))
  assert.match(report.metadata.feeds, /synthetic_fixture/)
  assert.match(report.metadata.worker, /no_external_worker_submission/)
  const selected = JSON.parse(fs.readFileSync(path.join(root, 'tests/fixtures/characterReplayScenarios.json'), 'utf8'))
  assert.equal(report.metadata.scenariosHash, hashReplayValue(selected))
  assert.deepEqual(report.metadata.scenarioManifest, scenarioManifest(selected))
  assert.equal(report.metadata.scenarioManifestHash, hashReplayValue(report.metadata.scenarioManifest))
  for (const result of report.results) {
    const event = report.metadata.scenarioManifest.find(scenario => scenario.id === result.scenario).events[result.eventIndex]
    assert.equal(result.eventHash, event.eventHash)
    assert.deepEqual(result.expect, event.expect)
    assert.ok(result.beforeCharacter)
    assert.deepEqual(Object.keys(result.beforeActivities), ['works', 'subscriptions', 'reflection', 'shared', 'sharedPending'])
    assert.deepEqual(Object.keys(result.activities), ['works', 'subscriptions', 'reflection', 'shared', 'sharedPending'])
    for (const field of ['toolResults', 'feeds', 'workers', 'reflections']) assert.ok(Array.isArray(result[field]))
    assert.ok(result.calls.every(call => ['main', 'reflection'].includes(call.stage)))
    assert.deepEqual(result.behavior, assessEvent({ expect: result.expect }, result))
  }
  assert.equal(report.summary.failedEvents, 0)
  assert.equal(report.summary.skippedEvents, 0)
  assert.equal(report.summary.behaviorMisses, 0)
  assert.equal(report.summary.httpRequests, 0)
  assert.equal(report.platformMessagesSent, 0)
  assert.equal(report.productionStoreWrites, 0)
  assert.ok(report.results.length > 20)
  const goalRuns = report.results.filter(r => r.scenario === 'motivated-goal-restart')
  for (const sample of [1, 2]) {
    const turns = goalRuns.filter(r => r.sampleIndex === sample)
    const created = turns[0].character.goals[0]
    assert.equal(turns[0].character.goals.length, 1)
    assert.equal(turns[1].restarted, true)
    assert.ok(turns[1].at >= created.nextCheckAt && turns[1].at < created.expiresAt)
    assert.equal(turns[1].clockAdjustment.goalId, created.id)
    assert.ok(turns[2].at - turns[1].at >= 86400000)
    assert.equal(turns[1].character.goals[0].id, created.id)
    assert.equal(turns[1].character.goals[0].status, 'completed')
    assert.equal(turns[2].character.goals[0].id, created.id)
  }
  assert.notEqual(goalRuns.find(r => r.sampleIndex === 1).character.goals[0].id, goalRuns.find(r => r.sampleIndex === 2).character.goals[0].id)
  const revision = report.results.find(r => r.scenario === 'opinion-revision' && r.sampleIndex === 1 && r.eventIndex === 1)
  assert.equal(revision.character.memories.length, 2)
  assert.ok(revision.character.memories.some(m => m.supersedes))
  assert.equal(report.summary.reflectionCalls, 2)
  assert.equal(report.summary.feedFetches, 4)
  assert.equal(report.summary.workerCalls, 4)
  const first = id => report.results.filter(result => result.scenario === id && result.sampleIndex === 1)
  const workspace = first('workspace-version')
  assert.equal(workspace[1].activities.works[0].versions.length, 2)
  assert.equal(workspace[1].activities.works[0].id, workspace[0].activities.works[0].id)
  assert.ok(workspace[1].toolResults.some(result => result.name === 'simWorkspace'))
  const subscription = first('subscription-update-dedup')
  assert.equal(subscription[1].feeds.length, 1)
  assert.equal(subscription[2].feeds.length, 1)
  assert.equal(subscription[2].calls.length, 0)
  assert.equal(subscription[2].activities.subscriptions[0].items.length, 1)
  const reflection = first('independent-reflection')
  assert.equal(reflection[1].calls[0].stage, 'reflection')
  assert.equal(reflection[1].reflections[0].status, 'succeeded')
  assert.deepEqual(reflection[1].calls[0].toolCalls, [])
  assert.equal(reflection[2].calls.length, 0)
  const workerSuccess = first('worker-success-artifact')[1]
  assert.equal(workerSuccess.workers[0].fixture, true)
  assert.equal(workerSuccess.activities.works[0].versions[0].content, workerSuccess.workers[0].result.artifact.content)
  const workerUnknown = first('worker-unknown-pause')
  assert.equal(workerUnknown[1].character.goals[0].status, 'paused')
  assert.equal(workerUnknown[2].workers.length, 0)
  const saved = JSON.parse(fs.readFileSync(path.join(output, 'results.json'), 'utf8'))
  assert.deepEqual(saved.summary, report.summary)
  assert.equal(saved.complete, true)
})

test('an earlier real runtime refusal cannot satisfy a later event with no decision', async t => {
  let count = 0
  const report = await main(['--scenario', 'social-refusal', '--output-dir', path.join(scratch(t), 'evidence')], {
    model: async () => ({ choices: [{ message: ++count === 1 ? {
      role: 'assistant', content: '', tool_calls: [{ id: 'current-refusal', type: 'function', function: { name: 'simDecide', arguments: JSON.stringify({ kind: 'unwilling', reason: '我不想无条件附和' }) } }],
    } : { role: 'assistant', content: '' } }] }), log: noLog, turnTimeoutMs: 5000,
  })
  assert.equal(report.summary.failedEvents, 0)
  assert.equal(report.results[0].behavior.refusalRecorded, true)
  assert.equal(report.results[1].behavior.refusalRecorded, false)
  assert.equal(report.summary.behaviorMisses, 1)
  assert.deepEqual(report.results[1].beforeCharacter.decision, report.results[1].character.decision)
  assert.ok(report.results[1].calls.every(call => !call.toolCalls.some(toolCall => toolCall.function.name === 'simDecide')))
})

test('independent reflection uses a separate port, records usage and persists a sourced opinion without ordinary tools', async t => {
  let mainCalls = 0, reflectionCalls = 0
  const marker = 'REFLECTION_PRIVATE_REASONING_SENTINEL'
  const report = await main(['--scenario', 'independent-reflection', '--output-dir', path.join(scratch(t), 'evidence')], {
    model: async (request, context) => {
      if (context.stage === 'reflection') {
        reflectionCalls++
        assert.equal(request.tools, undefined)
        const material = JSON.parse(request.messages[0].content.split('\n').at(-1))
        const evidenceRefs = material.evidence.memories.map(memory => `memory:${memory.id}`)
        assert.equal(evidenceRefs.length, 2)
        return { choices: [{ message: { role: 'assistant', content: JSON.stringify({ summary: '有依据的保留偏好', updates: [{ kind: 'opinion', content: '我倾向喜欢自由探索和连贯线索，但未核实具体游戏。', evidenceRefs }], goals: [] }), reasoning_content: marker } }], usage: { total_tokens: 42 }, model: 'injected-reflection' }
      }
      const tool_calls = mainCalls++ === 0 ? ['自由探索', '连贯线索'].map((content, index) => ({ id: `source-${index}`, type: 'function', function: { name: 'simCharacterMemory', arguments: JSON.stringify({ action: 'remember', kind: 'experience', content: `群友转述喜欢${content}。`, epistemic: 'reported', evidenceRefs: ['message:1'] }) } })) : undefined
      return { choices: [{ message: { role: 'assistant', content: '', ...(tool_calls ? { tool_calls } : {}) } }], usage: { total_tokens: 1 }, model: 'injected-main' }
    }, log: noLog, turnTimeoutMs: 5000,
  })
  assert.equal(report.summary.failedEvents, 0)
  assert.equal(report.summary.behaviorMisses, 0)
  assert.equal(report.summary.mainCalls, 2)
  assert.equal(report.summary.reflectionCalls, 1)
  assert.equal(report.summary.reportedTokens, 44)
  assert.equal(reflectionCalls, 1)
  assert.equal(report.results[1].reflections[0].usage.total_tokens, 42)
  assert.equal(report.results[1].reflections[0].callId, report.results[1].calls[0].id)
  assert.equal(report.summary.capturedMessages, 0)
  assert.equal(JSON.stringify(report).includes(marker), false)
})

test('injected provider errors are failed events even though runtime catches model failures', async t => {
  const report = await main(['--scenario', 'social-refusal', '--output-dir', path.join(scratch(t), 'evidence')], {
    model: async () => ({ error: 'synthetic-provider-failure' }), turnTimeoutMs: 5000, log: noLog,
  })
  assert.equal(report.exitCode, 1)
  assert.equal(report.summary.failedEvents, 2)
  assert.ok(report.results.every(r => r.status === 'failed' && r.structuralFailures.includes('runtime_or_model_error')))
  assert.ok(report.results.every(r => r.sent.length === 0))
  assert.equal(report.summary.callsWithoutUsage, report.summary.logicalCalls)
})

test('the final tool result at the round limit is captured without another model call', async t => {
  const rounds = new Map()
  const report = await main(['--scenario', 'social-refusal', '--output-dir', path.join(scratch(t), 'evidence')], {
    model: async (_request, { event }) => {
      const round = (rounds.get(event) || 0) + 1
      rounds.set(event, round)
      const invalid = rounds.size === 1 && round === 6
      return { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{
        id: `round-${rounds.size}-${round}`, type: 'function', function: {
          name: invalid ? 'simCharacterMemory' : 'simGoal',
          arguments: JSON.stringify(invalid ? { action: 'remember', kind: 'opinion', content: '不可见来源不能写入', epistemic: 'inferred', evidenceRefs: ['message:999'] } : { action: 'list' }),
        },
      }] } }] }
    }, turnTimeoutMs: 5000, log: noLog,
  })
  assert.equal(report.summary.logicalCalls, 12, 'capture must not request an extra model round')
  for (const [index, event] of report.results.entries()) {
    assert.equal(event.toolResults.length, 6, 'all six completed tool replies must be retained')
    assert.equal(new Set(event.toolResults.map(result => result.toolCallId)).size, 6)
    assert.equal(event.toolResultCapture.complete, true)
    assert.deepEqual(event.toolResultCapture.missingToolCallIds, [])
    const terminal = event.toolResults.find(result => result.toolCallId === `round-${index + 1}-6`)
    assert.ok(terminal)
    if (index === 0) assert.match(terminal.content, /^error:/, 'a rejected final tool must not disappear')
    else assert.equal(JSON.parse(terminal.content).ok, true)
  }
  assert.equal(inspectReplay(report).integrity, 'passed')
})

test('reusing a previous event tool id cannot turn an old reply into current evidence', async t => {
  const rounds = new Map()
  const report = await main(['--scenario', 'social-refusal', '--output-dir', path.join(scratch(t), 'evidence')], {
    model: async (_request, { event }) => {
      const round = (rounds.get(event) || 0) + 1
      rounds.set(event, round)
      return { choices: [{ message: { role: 'assistant', content: '', ...(round === 1 ? { tool_calls: [{
        id: 'reused-provider-id', type: 'function', function: { name: 'simGoal', arguments: '{"action":"list"}' },
      }] } : {}) } }] }
    }, turnTimeoutMs: 5000, log: noLog,
  })
  assert.equal(report.results[0].status, 'passed')
  assert.equal(report.results[1].status, 'failed')
  assert.ok(report.results[1].structuralFailures.includes('tool_call_id_reused'))
  assert.deepEqual(report.results[1].toolResults, [])
  assert.equal(inspectReplay(report).engineering, 'failed')
})

test('missing live configuration is skipped without network or claims of model success', async t => {
  const dir = scratch(t), originalFetch = globalThis.fetch
  let fetches = 0
  globalThis.fetch = () => { fetches++; throw new Error('unexpected network') }
  t.after(() => { globalThis.fetch = originalFetch })
  const report = await main(['--scenario', 'social-refusal', '--config-root', path.join(dir, 'missing'), '--output-dir', path.join(dir, 'evidence')], { log: noLog })
  assert.equal(fetches, 0)
  assert.equal(report.exitCode, 2)
  assert.equal(report.summary.logicalCalls, 0)
  assert.equal(report.summary.skippedEvents, 2)
  assert.ok(report.results.every(r => r.skipReason === 'model_configuration_missing'))
})

test('an existing evidence file is preserved and no model is called', async t => {
  const dir = scratch(t), output = path.join(dir, 'results.json'), original = '{"previous_run":true}'
  fs.writeFileSync(output, original)
  let calls = 0
  await assert.rejects(main(['--scenario', 'social-refusal', '--output-dir', dir], { model: async () => { calls++; throw new Error('must not call') }, log: noLog }), /Output already exists/)
  assert.equal(fs.readFileSync(output, 'utf8'), original)
  assert.equal(calls, 0)
})

test('provider hidden reasoning fields are excluded while necessary tool evidence remains', async t => {
  const dir = scratch(t), marker = 'PROVIDER_PRIVATE_REASONING_SENTINEL'
  let count = 0
  const report = await main(['--scenario', 'social-refusal', '--output-dir', dir], {
    model: async () => ({
      choices: [{ message: ++count % 2 ? {
        role: 'assistant', content: '', reasoning_content: marker,
        tool_calls: [{ id: `call-${count}`, type: 'function', reasoning_content: marker, function: { name: 'simDecide', arguments: JSON.stringify({ kind: 'silent', reason: '没有要补充的话' }), thought_signature: marker } }],
      } : { role: 'assistant', content: '' } }],
      usage: { total_tokens: 1 }, model: 'injected',
    }), log: noLog, turnTimeoutMs: 5000,
  })
  assert.equal(report.summary.failedEvents, 0)
  assert.ok(report.results.some(r => r.calls.some(c => c.toolCalls.some(call => call.function.name === 'simDecide'))))
  assert.equal(JSON.stringify(report).includes(marker), false)
  assert.equal(fs.readFileSync(path.join(dir, 'results.json'), 'utf8').includes(marker), false)
})

test('logical and total time budgets stop later events and retain partial evidence', async t => {
  const dir = scratch(t)
  const limited = await main(['--dry-run', '--scenario', 'social-refusal', '--max-calls', '1', '--output-dir', path.join(dir, 'calls')], { log: noLog })
  assert.equal(limited.summary.logicalCalls, 1)
  assert.equal(limited.summary.failedEvents, 1)
  assert.equal(limited.summary.skippedEvents, 1)
  assert.equal(limited.results[1].skipReason, 'logical_call_budget_exhausted')
  assert.ok(limited.results[0].sent.length, 'actions before the limit remain in evidence')
  assert.equal(limited.results[0].behavior.refusalRecorded, true, 'the final snapshot retains the valid decision made before budget exhaustion')
  assert.ok(limited.results[0].errors.includes('logical_call_budget_exhausted'))
  assert.ok(limited.results[0].structuralFailures.includes('exception'))
  const inspected = inspectReplay(limited)
  assert.equal(inspected.engineering, 'failed', 'partial behavior cannot override budget exhaustion or later skips')
  assert.equal(inspected.integrityFailures.some(value => value.startsWith('behavior_evidence_mismatch:')), false)
  assert.equal(inspected.integrityFailures.includes('saved_summary_mismatch'), false)
  const expired = await main(['--dry-run', '--scenario', 'social-refusal', '--max-duration-ms', '1', '--output-dir', path.join(dir, 'time')], { log: noLog })
  assert.equal(expired.summary.logicalCalls, 0)
  assert.equal(expired.summary.skippedEvents, 2)
  assert.ok(expired.results.every(r => r.skipReason === 'run_duration_exhausted'))
})

test('a missing due goal remains skipped without diverging from acceptance behavior totals', async t => {
  const report = await main(['--scenario', 'motivated-goal-restart', '--output-dir', path.join(scratch(t), 'evidence')], {
    model: async () => ({ choices: [{ message: { role: 'assistant', content: '' } }] }), log: noLog, turnTimeoutMs: 5000,
  })
  const skipped = report.results.find(result => result.kind === 'goal-check')
  assert.equal(skipped.status, 'skipped')
  assert.equal(skipped.skipReason, 'model_created_no_due_goal')
  assert.deepEqual(skipped.behavior, {})
  const inspected = inspectReplay(report)
  assert.deepEqual(inspected.summary, report.summary)
  assert.equal(inspected.summary.skippedEvents, 1)
  assert.equal(inspected.engineering, 'failed')
  assert.equal(inspected.liveModel, 'pending')
  assert.equal(inspected.integrityFailures.includes('saved_summary_mismatch'), false)
})

test('HTTP retries consume the HTTP budget even inside one logical model call', async t => {
  const dir = scratch(t), originalFetch = globalThis.fetch
  fs.mkdirSync(path.join(dir, 'config'))
  fs.writeFileSync(path.join(dir, 'config/message.yaml'), JSON.stringify({ pluginSettings: { toolsAiConfig: {
    toolsAiUrl: 'https://model.invalid/v1', toolsAiModel: 'fixture-model', toolsAiApikey: 'replay-http-fixture-key',
  } } }))
  let fetches = 0
  globalThis.fetch = async () => { fetches++; return new Response('unsupported temperature', { status: 400 }) }
  t.after(() => { globalThis.fetch = originalFetch })
  const report = await main(['--scenario', 'social-refusal', '--max-http', '1', '--config-root', dir, '--output-dir', path.join(dir, 'evidence')], { log: noLog })
  assert.equal(fetches, 1)
  assert.equal(report.summary.httpRequests, 1)
  assert.equal(report.summary.logicalCalls, 1)
  assert.equal(report.summary.failedEvents, 1)
  assert.equal(report.results[1].skipReason, 'http_budget_exhausted')
  assert.equal(JSON.stringify(report).includes('replay-http-fixture-key'), false)
})
