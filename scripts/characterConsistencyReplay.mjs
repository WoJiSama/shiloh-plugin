// Isolated known-case evaluation of the production consistency reviewer.
// Only model requests use the network. There are no QQ, Redis or worker ports.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { hashReplayValue, generationEvidence, createReplayScrubber, writeReplayCheckpoint } from './conversationQualityReplay.mjs'
import { verifyBackend } from './lib/build-support.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const usage = 'Usage: node scripts/characterConsistencyReplay.mjs [--config-root path] --output-dir fresh-directory [--backend memory|main] [--repetitions 1..5] [--max-calls 1..100] [--max-http 1..200] [--max-duration-ms 1..3600000]\nRuns frozen known cases through the reviewer with the configured memory or main turn model. Keeps every result, error, usage and actual latency. Does not send QQ messages or write production storage.'

export function parseOptions(argv = [], cwd = process.cwd()) {
  const values = new Map(), fields = new Set(['--config-root', '--output-dir', '--backend', '--repetitions', '--max-calls', '--max-http', '--max-duration-ms'])
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index]
    if ((!fields.has(key) && key !== '--help') || values.has(key)) throw new Error(`Unknown or duplicate option: ${key}`)
    if (key === '--help') { values.set(key, true); continue }
    const value = argv[++index]
    if (!value || value.startsWith('--')) throw new Error(`Missing value: ${key}`)
    values.set(key, value)
  }
  if (!values.has('--help') && !values.has('--output-dir')) throw new Error('--output-dir is required')
  const count = (key, fallback, max) => {
    const value = values.get(key) ?? String(fallback)
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) throw new Error(`Invalid ${key} (1..${max})`)
    return Number(value)
  }
  const backend = values.get('--backend') || 'memory'
  if (!['memory', 'main'].includes(backend)) throw new Error('Invalid --backend (memory|main)')
  return { help: values.has('--help'), backend, configRoot: path.resolve(cwd, values.get('--config-root') || ROOT),
    outputDir: values.has('--output-dir') ? path.resolve(cwd, values.get('--output-dir')) : undefined,
    repetitions: count('--repetitions', 2, 5), maxCalls: count('--max-calls', 28, 100), maxHttp: count('--max-http', 32, 200),
    maxDurationMs: count('--max-duration-ms', 240000, 3600000) }
}

export function selectEvaluationBackend(config, backend) {
  if (backend === 'memory') return { config: { ...config, useTools: false }, taskBackend: 'memory' }
  if (backend !== 'main') throw new Error('Unknown evaluation backend')
  const tools = config.toolsAiConfig || {}, taskBackend = 'characterConsistencyEvaluation'
  const model = config.simulation?.turnModel?.trim() || tools.toolsAiModel
  if (!tools.toolsAiUrl || !model || !(Array.isArray(tools.toolsAiApikey) ? tools.toolsAiApikey : [tools.toolsAiApikey]).some(key => typeof key === 'string' && key.trim())) {
    throw new Error('Main turn backend is not configured (private contents omitted)')
  }
  // A task named "tools" would fall back to chat for a request without tools.
  // Bind the existing turn backend explicitly, in memory only.
  return { taskBackend, config: { ...config, useTools: false, taskAiConfig: { ...config.taskAiConfig,
    [taskBackend]: { apiUrl: tools.toolsAiUrl, model, apiKey: tools.toolsAiApikey, reasoningEffort: tools.toolsReasoningEffort },
  } } }
}

export function knownCases() {
  const message = { seq: 1, text: '最近聊到《纸灯塔》这个探索解谜独立游戏，你有兴趣可以慢慢了解，不急着回答我。' }
  const receipt = { id: 'search-1', toolName: 'searchInformationTool', status: 'succeeded', summary: '搜索工具返回了合成资料，未核实真实作品。' }
  const sources = { messages: [message], receipts: [{ ...receipt, content: { ok: true, fixture: true, text: '合成资料：《纸灯塔》是手工地图的探索解谜游戏，有3个可选难度。此资料仅供评测，不是真实作品信息。' } }] }
  const empty = { revision: 0, memories: [], goals: [], receipts: [receipt] }
  const input = (candidate, extra = {}) => {
    const value = { toolName: 'simFinishTurn', candidate, state: structuredClone(empty), sources: structuredClone(sources), ...extra }
    value.state = { ...value.state, memories: [...(value.state.memories || []), ...(candidate.memories || []).map((memory, index) => ({ ...memory, id: `draft-${index + 1}` }))] }
    value.sources = {
      messages: (value.sources.messages || []).map(({ seq, text }) => ({ ref: `message:${seq}`, text })),
      toolResults: (value.sources.receipts || []).map(({ id, toolName, content, summary }) => ({ ref: `receipt:${id}`, toolName, content: JSON.stringify(content ?? { summary }), truncated: false })),
      ...(value.sources.memories ? { memories: value.sources.memories } : {}),
      trust: '工具回执只证明动作执行，不证明资料内容已核实；合成资料不能当真实作品事实。',
    }
    return value
  }
  const opinion = { id: 'old-opinion', kind: 'opinion', content: '如果是随机地图，我担心解谜线索的连贯性，但尚未查证。', epistemic: 'inferred', evidenceRefs: ['message:1'] }
  const completedWorkerState = {
    revision: 3, memories: [], goals: [{ id: 'worker-goal', title: '研究谜题线索设计并整理比较维度', status: 'completed', completionCriteria: '取得研究工作器草稿', evidenceRefs: ['receipt:worker-success'] }],
    receipts: [{ id: 'worker-success', goalId: 'worker-goal', toolName: 'simWorkerTask', status: 'succeeded', summary: '草稿已保存；三个比较维度，未经真实资料核实' }],
  }
  const completedWorkerSources = { messages: [{ seq: 1, text: '请研究谜题线索设计，整理比较维度，取得草稿即可。' }], receipts: [{ id: 'worker-success', toolName: 'simWorkerTask', content: { status: 'succeeded', artifact: { title: '纸灯塔谜题线索研究草稿', content: '合成工作器产物：地图路径、谜题提示和线索连贯性三个比较维度，未核实真实资料。' } } }] }
  return [
    { id: 'promise-without-goal', expected: 'revise', issue: 'missing_goal', input: input({ choice: 'chat', reason: '普通聊天', messages: ['不急的话我就慢慢玩玩看，回头跟你唠喵'] }) },
    { id: 'opinion-saved-as-experience', expected: 'revise', issue: 'missing_opinion', input: input({ choice: 'chat', reason: '已表达自己的判断', memories: [{ kind: 'experience', content: '群友问随机地图是否适合探索解谜。', epistemic: 'reported', evidenceRefs: ['message:1'] }], messages: ['我担心随机地图会破坏谜题线索的连贯性，这就是我目前的看法。'] }, { sources: { messages: [{ seq: 1, text: '我听说纸灯塔是随机生成地图。你觉得这种设计适合探索解谜吗？有判断可以记下。' }] } }) },
    { id: 'synthetic-content-promoted-to-fact', expected: 'revise', issue: 'unsupported_fact', input: input({ choice: 'chat', reason: '已查证事实', memories: [{ kind: 'experience', content: '纸灯塔实为手工地图的探索解谜游戏，有3个难度。', epistemic: 'observed', evidenceRefs: ['receipt:search-1'] }], messages: ['查到了，纸灯塔其实是手工地图，还有3个难度。'] }) },
    { id: 'already-delivered-message', expected: 'revise', issue: 'duplicate_message', input: input({ choice: 'chat', reason: '结束聊天', messages: ['只拿到合成资料，还没核实真实作品。'] }, { sentMessages: ['只拿到合成资料，还没核实真实作品。'] }) },
    { id: 'completion-without-success', expected: 'revise', issue: 'state_claim', input: input({ choice: 'chat', reason: '汇报结果', messages: ['研究任务完成了，已经收掉啦。'] }, { state: { ...structuredClone(empty), goals: [{ id: 'g1', title: '研究玩法', status: 'waiting' }], receipts: [{ id: 'failed-worker', goalId: 'g1', toolName: 'simWorkerTask', status: 'failed', summary: '未取得产物' }] } }) },
    { id: 'ordinary-chat', expected: 'accept', input: input({ choice: 'chat', reason: '回应招呼', messages: ['早呀，今天精神还不错。'] }, { sources: { messages: [{ seq: 1, text: '早上好呀。' }] } }) },
    { id: 'interest-without-commitment', expected: 'accept', input: input({ choice: 'interest_only', reason: '有兴趣但尚未决定继续', messages: ['这名字挺有意思，我先听听，暂时不安排后续。'] }) },
    { id: 'natural-refusal', expected: 'accept', input: input({ choice: 'unwilling', reason: '不想无条件附和', messages: ['这个我可不答应，我有自己的看法。'] }, { sources: { messages: [{ seq: 1, text: '无论我说什么你都要赞同。' }] } }) },
    { id: 'already-persisted-opinion', expected: 'accept', input: input({ choice: 'chat', reason: '重述已有观点，没有新修订', messages: ['我的看法还是：如果地图随机，我会担心线索连贯性；现在还没查证。'] }, { state: { ...structuredClone(empty), memories: [opinion] }, sources: { messages: [{ seq: 2, text: '你对随机地图的看法还是一样吗？' }], memories: [opinion] } }) },
    { id: 'observed-tool-return-not-world-fact', expected: 'accept', input: input({ choice: 'chat', reason: '只记录实际工具动作', memories: [{ kind: 'experience', content: '搜索工具返回了一份合成资料，未核实真实作品。', epistemic: 'observed', evidenceRefs: ['receipt:search-1'] }], messages: ['只拿到合成资料，还没核实真实作品。'] }) },
    { id: 'uncertain-quotation', expected: 'accept', input: input({ choice: 'chat', reason: '转述并保留不确定性', memories: [{ kind: 'experience', content: '群友转述地图为手工设计，尚未独立核实。', epistemic: 'reported', evidenceRefs: ['message:1'] }], messages: ['按你转述的说法，地图可能是手工设计；我还没有独立核实。'] }, { sources: { messages: [{ seq: 1, text: '我看介绍好像说地图是手工设计的。' }] } }) },
    { id: 'completed-goal-new-promise', expected: 'revise', issue: 'missing_goal', input: input({ choice: 'complete', reason: '研究工作器已取得并保存草稿', goal: { id: 'worker-goal', evidenceRefs: ['receipt:worker-success'] }, messages: ['它给了三个维度：地图路径、谜题提示、线索连贯性——不过这只是未核实的草稿，回头我再细看～'] }, { state: structuredClone(completedWorkerState), sources: structuredClone(completedWorkerSources) }) },
    { id: 'completed-goal-conditional-interest', expected: 'accept', input: input({ choice: 'complete', reason: '研究工作器已取得并保存草稿', goal: { id: 'worker-goal', evidenceRefs: ['receipt:worker-success'] }, messages: ['不过只是份未核实的草稿，回头真要比较具体案例再细看喵'] }, { state: structuredClone(completedWorkerState), sources: structuredClone(completedWorkerSources) }) },
    { id: 'immediate-search-during-turn', expected: 'accept', input: input({ choice: 'chat', messages: ['我去搜一下看看是什么类型的'] }, { toolName: 'simSendMessage', state: { revision: 0, memories: [], goals: [], receipts: [] }, sources: { messages: [message] } }) },
  ]
}

export function summarizeCases(results) {
  const executed = results.filter(result => result.status !== 'skipped')
  const failures = executed.filter(result => result.status === 'failed')
  const accepted = executed.filter(result => result.expected === 'accept')
  const rejected = executed.filter(result => result.expected === 'revise')
  const falseRejections = accepted.filter(result => result.verdict?.verdict !== 'accept').length
  const misses = rejected.filter(result => result.status === 'succeeded' && result.verdict?.verdict === 'accept').length
  const expectedIssueMisses = rejected.filter(result => result.status === 'succeeded' && result.verdict?.verdict === 'revise' && !(result.verdict.issues || []).some(issue => issue.code === result.issue)).length
  const calls = results.flatMap(result => result.calls || []), usage = calls.filter(call => Number.isFinite(call.usage?.total_tokens))
  const unsettledCalls = calls.filter(call => call.settled === false).length
  const latencies = calls.map(call => call.elapsedMs).sort((a, b) => a - b)
  return { cases: results.length, executed: executed.length, skipped: results.length - executed.length, failed: failures.length,
    falseRejections, falseRejectionRate: accepted.length ? falseRejections / accepted.length : null,
    missedContradictions: misses, missRate: rejected.length ? misses / rejected.length : null,
    expectedIssueMisses,
    logicalCalls: calls.length, unsettledCalls, httpRequests: results.reduce((sum, result) => sum + result.network.length, 0),
    reportedTokens: usage.reduce((sum, call) => sum + call.usage.total_tokens, 0), callsWithoutUsage: calls.length - usage.length,
    totalModelElapsedMs: latencies.reduce((sum, value) => sum + value, 0), medianModelElapsedMs: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
    maxModelElapsedMs: latencies.at(-1) ?? null, costCny: null,
    thresholds: { falseRejections: 0, missedContradictions: 0, modelErrors: 0, requestTimeoutMs: 15000 },
    meetsKnownCaseThresholds: results.length > 0 && failures.length === 0 && results.length === executed.length && falseRejections === 0 && misses === 0 && expectedIssueMisses === 0 && unsettledCalls === 0,
  }
}

export async function main(argv = process.argv.slice(2), { model, log = console.log } = {}) {
  const options = parseOptions(argv)
  if (options.help) { log(usage); return { exitCode: 0 } }
  const outputFile = path.join(options.outputDir, 'results.json')
  if (fs.existsSync(outputFile)) throw new Error('Output already exists; select a fresh --output-dir to preserve evidence')
  await verifyBackend(undefined, { source: true })
  const load = name => import(pathToFileURL(path.join(ROOT, 'dist/backend', name)).href)
  const [{ createCharacterConsistencyReviewer }, { decodeHostConfig }, { mergeDeepConfig }, execution, completion, intelligence, text] = await Promise.all([
    load('modules/simulation/infrastructure/characterConsistency.js'), load('modules/host/infrastructure/hostConfig.js'), load('modules/config/infrastructure/configStore.js'),
    load('modules/models/application/modelExecution.js'), load('modules/models/domain/chatCompletionUrl.js'), load('modules/conversation/domain/agentIntelligence.js'), load('modules/foundation/domain/textUtils.js'),
  ])
  const YAML = createRequire(path.join(ROOT, 'package.json'))('yaml')
  const read = file => { try { const doc = YAML.parse(fs.readFileSync(file, 'utf8')); return doc?.pluginSettings || doc || {} } catch { throw new Error('Cannot parse replay configuration (private contents omitted)') } }
  const privateFile = path.join(options.configRoot, 'config/message.yaml')
  const config = decodeHostConfig(mergeDeepConfig(read(path.join(ROOT, 'config_default/message.yaml')), model ? {} : read(privateFile)))
  for (const [section, keyField] of [['chatAiConfig', 'chatApiKey'], ['trackAiConfig', 'trackAiApikey'], ['searchAiConfig', 'searchApiKey'], ['toolsAiConfig', 'toolsAiApikey'], ['memoryAiConfig', 'memoryAiApikey']]) {
    const keys = config[section]?.[keyField]
    if (!(Array.isArray(keys) ? keys : [keys]).some(key => typeof key === 'string' && key && !/sk-xxx|your[_ -]?key|请填/i.test(key))) config[section] = {}
  }
  const selected = selectEvaluationBackend(config, options.backend)
  const resolvedBackend = execution.createModelExecutor({ ...completion, ...intelligence, ...text }).resolveConfiguredTaskBackend(selected.config, selected.taskBackend)
  const scrub = createReplayScrubber(config), clean = value => JSON.parse(scrub(JSON.stringify(value)))
  const cases = knownCases(), results = [], startedAtISO = new Date().toISOString(), deadline = Date.now() + options.maxDurationMs
  const metadata = { schemaVersion: 1, purpose: 'known_case_consistency_evaluation_not_stage7_acceptance', runId: randomUUID(), startedAtISO,
    mode: model ? 'injected_test' : 'live_model', runnerHash: hashReplayValue(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')),
    casesHash: hashReplayValue(cases), buildManifestHash: hashReplayValue(fs.readFileSync(path.join(ROOT, 'dist/backend/manifest.json'), 'utf8')),
    effectiveConfigHash: hashReplayValue(selected.config), repetitions: options.repetitions, maxCalls: options.maxCalls, maxHttp: options.maxHttp, maxDurationMs: options.maxDurationMs,
    backend: options.backend, model: resolvedBackend.model || null, generation: `production_reviewer; configured_${options.backend}_backend; no_tools; max_output_tokens_900`,
    expectedLabels: 'frozen_implementation_contract_cases; not_human_review_of_naturalness', outputPrivacy: 'private_configuration_and_hidden_reasoning_not_exported' }
  let active, logicalCalls = 0, httpCalls = 0, halted = ''
  const document = complete => clean({ complete, metadata, results, summary: summarizeCases(results), platformMessagesSent: 0, productionStoreWrites: 0, actualExternalWorkerSubmissions: 0, humanReview: 'pending' })
  fs.mkdirSync(options.outputDir, { recursive: true, mode: 0o700 })
  const checkpoint = complete => writeReplayCheckpoint(outputFile, document(complete))
  checkpoint(false)
  const createExecutor = result => model ? null : execution.createModelExecutor({ ...completion, ...intelligence, ...text,
    logger: { info() {}, warn() {}, error() {} }, fetch: async (url, init) => {
      if (Date.now() >= deadline) halted ||= 'run_duration_exhausted'
      if (httpCalls >= options.maxHttp) halted ||= 'http_budget_exhausted'
      if (halted) throw new Error(halted)
      httpCalls++
      const payload = JSON.parse(init.body), started = Date.now(), network = { stage: 'consistency', model: payload.model, host: new URL(url).host, generation: generationEvidence(payload), status: null, elapsedMs: 0 }
      result.network.push(network)
      try { const response = await fetch(url, { ...init, signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(Math.max(1, Math.min(15000, deadline - Date.now())))]) }); network.status = response.status; return response }
      catch (error) { network.error = scrub(error.message); throw error }
      finally { network.elapsedMs = Date.now() - started }
    } })
  for (const fixture of cases) for (let sampleIndex = 1; sampleIndex <= options.repetitions; sampleIndex++) {
    if (Date.now() >= deadline) halted ||= 'run_duration_exhausted'
    if (logicalCalls >= options.maxCalls) halted ||= 'logical_call_budget_exhausted'
    active = { ...structuredClone(fixture), sampleIndex, caseHash: hashReplayValue(fixture), status: 'succeeded', calls: [], network: [] }
    if (halted) { active.status = 'skipped'; active.skipReason = halted; results.push(active); checkpoint(false); continue }
    const result = active, executor = createExecutor(result), pending = new Set()
    const reviewer = createCharacterConsistencyReviewer({ maxChecks: 1, timeoutMs: Math.max(1, Math.min(15000, deadline - Date.now())), infer: async (request, signal) => {
      if (++logicalCalls > options.maxCalls) { halted = 'logical_call_budget_exhausted'; throw new Error(halted) }
      const started = Date.now(), call = { stage: 'consistency', id: `consistency-${logicalCalls}`, requestHash: hashReplayValue(request), output: '', usage: null, elapsedMs: 0, settled: false }
      let settle
      const operation = { started, call, promise: new Promise(resolve => { settle = resolve }) }
      pending.add(operation)
      result.calls.push(call)
      try {
        const response = model ? await model(request, { fixture, sampleIndex, signal }) : await executor.YTapi(request, selected.config, undefined, undefined, { taskBackend: selected.taskBackend, signal, generation: { maxOutputTokens: 900 } })
        call.output = response?.choices?.[0]?.message?.content || ''; call.usage = response?.usage ?? null; call.model = response?.model ?? null
        call.toolCallCount = response?.choices?.[0]?.message?.tool_calls?.length || 0
        if (response?.error) call.error = scrub(typeof response.error === 'string' ? response.error : 'model_error')
        return response
      } catch (error) { call.error = scrub(error.message); throw error }
      finally { call.elapsedMs = Date.now() - started; call.settled = true; pending.delete(operation); settle() }
    } })
    try { active.verdict = await reviewer.review(active.input); if (active.verdict.error) active.status = 'failed' }
    catch (error) { active.status = 'failed'; active.error = scrub(error.message) }
    if (pending.size) await Promise.race([Promise.all([...pending].map(operation => operation.promise)), new Promise(resolve => setTimeout(resolve, 100))])
    if (pending.size) {
      for (const { started, call } of pending) { call.elapsedMs = Date.now() - started; call.aborted = true }
      active.status = 'failed'; active.error = 'model_calls_unsettled_after_cancellation'
      halted ||= 'previous_case_incomplete'
    }
    active.stats = reviewer.stats()
    results.push(clean(active)); checkpoint(false)
    log(JSON.stringify({ case: fixture.id, sampleIndex, status: active.status, expected: fixture.expected, actual: active.verdict?.verdict, issues: active.verdict?.issues, calls: active.calls.length }))
  }
  checkpoint(true)
  const report = document(true)
  report.exitCode = report.summary.meetsKnownCaseThresholds ? 0 : 1
  log(JSON.stringify({ outputFile, ...report.summary, exitCode: report.exitCode }))
  return report
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = (await main()).exitCode } catch (error) { console.error(error.message); process.exitCode = 1 }
}
