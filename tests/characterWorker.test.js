import test from 'node:test'
import assert from 'node:assert/strict'
import { createCharacterWorkerTools } from '../dist/backend/modules/simulation/infrastructure/characterWorker.js'

const input = { kind: 'research', instruction: '整理公开玩法资料，保留不确定性', evidenceRefs: ['message:1'] }
const fixture = (run, changes = {}) => createCharacterWorkerTools({ run, ensureActive: async () => {}, visibleEvidenceRefs: () => ['message:1'], ...changes })[0]

test('unconfigured worker supplies no tool and has no external execution path', () => {
  assert.deepEqual(createCharacterWorkerTools({ ensureActive: async () => {}, visibleEvidenceRefs: () => [] }), [])
})

test('configured worker gets fresh task id and only validated source-bound task fields', async () => {
  const received = [], reports = []
  const tool = fixture(async (task, signal) => { received.push({ task, signal }); return { status: 'succeeded', summary: '取得资料草稿', artifact: { title: '玩法研究', content: '尚未验证的公开资料摘要' } } })
  const first = await tool.execute(input, { simulationReportOutcome: status => reports.push(status) })
  const second = await tool.execute(input, {})
  assert.match(first.taskId, /^[0-9a-f-]{36}$/)
  assert.notEqual(first.taskId, second.taskId)
  assert.deepEqual(Object.keys(received[0].task).sort(), ['taskId', 'kind', 'instruction', 'evidenceRefs'].sort())
  assert.deepEqual(received[0].task.evidenceRefs, ['message:1'])
  assert.equal(first.artifact.content, '尚未验证的公开资料摘要')
  assert.equal(first.status, 'succeeded')
  assert.deepEqual(reports, ['succeeded'])
  assert.equal(received[0].signal.aborted, true)
})

test('tool refuses scope, endpoint, credentials and invented source fields before calling gateway', async () => {
  let calls = 0
  const tool = fixture(async () => { calls++; return { status: 'succeeded', summary: '不得调用' } })
  for (const candidate of [
    { ...input, groupId: 'other' }, { ...input, endpoint: 'https://example.com' }, { ...input, credentials: 'secret' },
    { ...input, taskId: 'model-chosen' }, { ...input, path: '/tmp/run.sh' }, { ...input, evidenceRefs: ['message:999'] },
    { ...input, evidenceRefs: [] }, { ...input, evidenceRefs: 'message:1' }, { ...input, instruction: 'x'.repeat(2001) }, { ...input, kind: ['research'] },
  ]) assert.match(await tool.execute(candidate, {}), /^error:/)
  assert.equal(calls, 0)
})

test('failed receipt reports failure, unknown and invalid protocol never imply success', async () => {
  for (const outcome of [
    { status: 'failed', summary: '明确失败' }, { status: 'unknown', summary: '已受理但结果未定' },
    'succeeded', { status: ['succeeded'], summary: '不能强转的状态' }, { status: 'succeeded', summary: '伪造字段', endpoint: 'https://example.com' },
    { status: 'succeeded', summary: 'x'.repeat(1201) }, { status: 'succeeded', summary: '超长作品', artifact: { title: '草稿', content: 'x'.repeat(12001) } },
    { status: 'failed', summary: '失败但夹带作品', artifact: { title: '不得交付', content: '正文' } },
  ]) {
    const reports = []
    const result = await fixture(async () => outcome).execute(input, { simulationReportOutcome: status => reports.push(status) })
    assert.equal(result.status, outcome?.status === 'failed' && !outcome.artifact ? 'failed' : 'unknown')
    assert.equal('artifact' in result, false)
    assert.deepEqual(reports, result.status === 'failed' ? ['failed'] : [])
  }
  const reports = []
  const thrown = await fixture(async () => { throw new Error('network interrupted') }).execute(input, { simulationReportOutcome: status => reports.push(status) })
  assert.equal(thrown.status, 'unknown')
  assert.deepEqual(reports, [])
})

test('timeout aborts gateway signal and retains unknown status without accepting a late success', async () => {
  let signal, release
  const late = new Promise(resolve => { release = resolve }), reports = []
  const tool = fixture(async (_task, incoming) => { signal = incoming; return await late }, { timeoutMs: 5 })
  const result = await tool.execute(input, { simulationReportOutcome: status => reports.push(status) })
  assert.equal(result.status, 'unknown')
  assert.equal(signal.aborted, true)
  release({ status: 'succeeded', summary: '迟到结果', artifact: { title: '迟到作品', content: '不能交付' } })
  await new Promise(resolve => setTimeout(resolve, 1))
  assert.deepEqual(reports, [])
  assert.equal('artifact' in result, false)
})

test('source cancellation aborts a pending task and post-call guard discards late artifacts', async () => {
  let active = true, signal, calls = 0
  const tool = fixture(async (_task, incoming) => {
    calls++; signal = incoming; active = false
    return { status: 'succeeded', summary: '结果已得但来源删除', artifact: { title: '旧来源作品', content: '不能留下' } }
  }, { ensureActive: async () => { if (!active) throw new Error('source deleted') } })
  const reports = [], result = await tool.execute(input, { simulationReportOutcome: status => reports.push(status) })
  assert.equal(result.status, 'unknown')
  assert.equal(signal.aborted, true)
  assert.deepEqual(reports, [])
  assert.equal('artifact' in result, false)
  assert.match(await tool.execute(input, {}), /^error:/)
  assert.equal(calls, 1)
})

test('revoked source aborts an unsettled worker before its timeout and records unknown', async () => {
  let active = true, signal
  const reports = []
  const tool = fixture(async (_task, incoming) => {
    signal = incoming; active = false
    return await new Promise(() => {})
  }, { ensureActive: async () => { if (!active) throw new Error('source removed while pending') } })
  const result = await tool.execute(input, { simulationReportOutcome: status => reports.push(status) })
  assert.equal(result.status, 'unknown')
  assert.match(result.summary, /授权已失效/)
  assert.equal(signal.aborted, true)
  assert.deepEqual(reports, [])
})
