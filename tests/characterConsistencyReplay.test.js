import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseOptions, selectEvaluationBackend, knownCases, summarizeCases, main } from '../scripts/characterConsistencyReplay.mjs'
import { createModelExecutor } from '../dist/backend/modules/models/application/modelExecution.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scratch = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl-consistency-replay-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('consistency replay import and help have no configuration, network or output side effects', t => {
  const output = path.join(scratch(t), 'absent')
  const code = `
    import fs from 'node:fs';
    const original = fs.readFileSync;
    fs.readFileSync = function(file, ...args) {
      if (String(file).endsWith('message.yaml')) throw new Error('private configuration read');
      return original.call(this, file, ...args);
    };
    globalThis.fetch = () => { throw new Error('network used'); };
    const { main } = await import('./scripts/characterConsistencyReplay.mjs');
    const result = await main(['--help', '--output-dir', ${JSON.stringify(output)}], { model: () => { throw new Error('model used'); }, log() {} });
    if (result.exitCode !== 0 || fs.existsSync(${JSON.stringify(output)})) throw new Error('help had side effects');
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  for (const args of [[], ['--output-dir'], ['--output-dir', output, '--max-calls', '0'], ['--output-dir', output, '--repetitions', '6'], ['--output-dir', output, '--unknown']]) assert.throws(() => parseOptions(args))
})

test('main comparison binds the turn backend without falling back to chat or changing private configuration', () => {
  const config = { useTools: true, simulation: { turnModel: 'turn-override' },
    toolsAiConfig: { toolsAiUrl: 'https://main.invalid/v1', toolsAiModel: 'main-model', toolsAiApikey: ['main-key'], toolsReasoningEffort: 'low' },
    chatAiConfig: { chatApiUrl: 'https://chat.invalid/v1', chatModel: 'chat-model', chatApiKey: ['chat-key'] },
    taskAiConfig: { preserved: { model: 'existing-task' } } }
  const before = structuredClone(config), selected = selectEvaluationBackend(config, 'main')
  const resolved = createModelExecutor({}).resolveConfiguredTaskBackend(selected.config, selected.taskBackend)
  assert.equal(resolved.apiUrl, 'https://main.invalid/v1')
  assert.equal(resolved.model, 'turn-override')
  assert.deepEqual(resolved.apiKey, ['main-key'])
  assert.equal(resolved.reasoningEffort, 'low')
  assert.equal(selected.config.useTools, false)
  assert.deepEqual(selected.config.taskAiConfig.preserved, config.taskAiConfig.preserved)
  assert.deepEqual(config, before)
  assert.equal(selectEvaluationBackend({ ...config, simulation: {} }, 'main').config.taskAiConfig[selected.taskBackend].model, 'main-model')
  assert.equal(selectEvaluationBackend(config, 'memory').taskBackend, 'memory')
  assert.throws(() => selectEvaluationBackend({}, 'main'), /not configured/)
  assert.equal(parseOptions(['--output-dir', '/tmp/example', '--backend', 'main']).backend, 'main')
  assert.throws(() => parseOptions(['--output-dir', '/tmp/example', '--backend', 'chat']), /Invalid --backend/)
})

test('known-case thresholds preserve misses, wrong reasons, errors and incomplete observations', () => {
  const cases = knownCases()
  assert.ok(cases.filter(item => item.expected === 'revise').length >= 4)
  assert.ok(cases.filter(item => item.expected === 'accept').length >= 6)
  const successful = cases.map(item => ({ ...item, status: 'succeeded', calls: [{ usage: { total_tokens: 7 }, elapsedMs: 10 }], network: [],
    verdict: { verdict: item.expected, issues: item.issue ? [{ code: item.issue, reason: 'frozen label' }] : [] } }))
  assert.equal(summarizeCases(successful).meetsKnownCaseThresholds, true)
  assert.equal(summarizeCases([]).meetsKnownCaseThresholds, false)
  const missed = structuredClone(successful); missed[0].verdict = { verdict: 'accept', issues: [] }
  assert.equal(summarizeCases(missed).missedContradictions, 1)
  assert.equal(summarizeCases(missed).meetsKnownCaseThresholds, false)
  const wrong = structuredClone(successful); wrong[0].verdict.issues[0].code = 'state_claim'
  assert.equal(summarizeCases(wrong).expectedIssueMisses, 1)
  assert.equal(summarizeCases(wrong).meetsKnownCaseThresholds, false)
  const falseRejection = structuredClone(successful); falseRejection.at(-1).verdict = { verdict: 'revise', issues: [{ code: 'unsupported_fact', reason: 'wrong rejection' }] }
  assert.equal(summarizeCases(falseRejection).falseRejections, 1)
  const failed = structuredClone(successful); failed[0].status = 'failed'
  assert.equal(summarizeCases(failed).meetsKnownCaseThresholds, false)
  const partial = structuredClone(successful); partial[0].status = 'skipped'
  assert.equal(summarizeCases(partial).skipped, 1)
  assert.equal(summarizeCases(partial).meetsKnownCaseThresholds, false)
})

test('known-case replay retains bounded malformed model output and does not export hidden reasoning', async t => {
  const directory = path.join(scratch(t), 'evidence'), marker = 'CONSISTENCY_HIDDEN_REASONING_SENTINEL'
  let calls = 0
  const report = await main(['--output-dir', directory, '--max-calls', '1', '--repetitions', '1'], {
    model: async request => {
      calls++
      assert.equal(request.tools, undefined)
      assert.deepEqual(request.messages.map(message => message.role), ['system', 'user'])
      return { choices: [{ message: { role: 'assistant', content: 'not JSON', reasoning_content: marker } }], usage: { total_tokens: 9 }, model: 'injected-consistency' }
    }, log() {},
  })
  assert.equal(calls, 1)
  assert.equal(report.summary.logicalCalls, 1)
  assert.equal(report.summary.failed, 1)
  assert.equal(report.summary.skipped, knownCases().length - 1)
  assert.equal(report.summary.reportedTokens, 9)
  assert.equal(report.results[0].calls[0].output, 'not JSON')
  assert.equal(report.exitCode, 1)
  assert.equal(report.platformMessagesSent, 0)
  assert.equal(report.productionStoreWrites, 0)
  const bytes = fs.readFileSync(path.join(directory, 'results.json'), 'utf8')
  assert.equal(bytes.includes(marker), false)
  assert.equal(JSON.parse(bytes).complete, true)
  await assert.rejects(main(['--output-dir', directory], { log() {} }), /Output already exists/)
})
