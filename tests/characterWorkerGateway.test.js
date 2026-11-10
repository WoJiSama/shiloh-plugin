import test from 'node:test'
import assert from 'node:assert/strict'
import { createCharacterWorkerGateway } from '../dist/backend/modules/simulation/infrastructure/characterWorkerGateway.js'

const scope = { botId: 'bot-w', personaId: 'persona-w', groupId: '10086' }
const task = { taskId: 'task-with/slash', kind: 'research', instruction: '研究公开游戏更新，返回草稿', evidenceRefs: ['message:1'] }
const success = { status: 'succeeded', summary: '已取得草稿', artifact: { title: '更新笔记', content: '公开资料摘要' } }

test('gateway submits the exact fixed task scope with idempotency and refuses redirects', async () => {
  const requests = []
  const run = createCharacterWorkerGateway({ endpoint: 'https://worker.example/bridge', token: 'test-gateway-secret', fetch: async (url, init) => {
    requests.push({ url: String(url), init })
    return new Response(JSON.stringify(success), { status: 200 })
  } })
  const controller = new AbortController()
  assert.deepEqual(await run(task, scope, controller.signal), success)
  assert.equal(requests.length, 1)
  const request = requests[0]
  assert.equal(request.url, 'https://worker.example/bridge/tasks')
  assert.equal(request.init.method, 'POST')
  assert.equal(request.init.redirect, 'error')
  assert.equal(request.init.signal, controller.signal)
  assert.equal(request.init.headers['Idempotency-Key'], task.taskId)
  assert.equal(request.init.headers.Authorization, 'Bearer test-gateway-secret')
  assert.deepEqual(JSON.parse(request.init.body), { schemaVersion: 1, scope, task })
  controller.abort()
  assert.equal(requests.length, 1, '完成后应卸载取消监听，不能额外删除已完成任务')
})

test('gateway rejects oversized streamed responses before accepting a result', async () => {
  let cancelled = false
  const oversized = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(100 * 1024)); controller.enqueue(new Uint8Array(30 * 1024)) },
    cancel() { cancelled = true },
  })
  const run = createCharacterWorkerGateway({ endpoint: 'https://worker.example', fetch: async () => new Response(oversized) })
  await assert.rejects(run(task, scope, new AbortController().signal), /响应过大/)
  assert.equal(cancelled, true)
})

test('aborting an in-flight task requests DELETE cancellation for its encoded task id', async () => {
  const requests = [], controller = new AbortController()
  let entered
  const started = new Promise(resolve => { entered = resolve })
  const run = createCharacterWorkerGateway({ endpoint: 'http://127.0.0.1:19001/bridge/', fetch: async (url, init) => {
    requests.push({ url: String(url), init })
    if (init.method === 'DELETE') return new Response('', { status: 200 })
    entered()
    return await new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))
  } })
  const running = run(task, scope, controller.signal)
  await started
  controller.abort()
  await assert.rejects(running, /aborted/)
  assert.equal(requests.length, 2)
  assert.equal(requests[1].url, 'http://127.0.0.1:19001/bridge/tasks/task-with%2Fslash')
  assert.equal(requests[1].init.method, 'DELETE')
  assert.equal(requests[1].init.redirect, 'error')
  assert.notEqual(requests[1].init.signal, controller.signal, '取消请求有独立短超时，不沿用已中断signal')
})

test('HTTP server failures remain unknown while explicit client failures are failed', async () => {
  for (const [status, expected] of [[500, 'unknown'], [503, 'unknown'], [400, 'failed'], [401, 'failed'], [404, 'failed']]) {
    const run = createCharacterWorkerGateway({ endpoint: 'https://worker.example', fetch: async () => new Response('provider error', { status }) })
    const result = await run(task, scope, new AbortController().signal)
    assert.equal(result.status, expected)
    assert.match(result.summary, new RegExp(String(status)))
    assert.equal('artifact' in result, false)
  }
})

test('non-HTTPS remote destinations and URL credentials are rejected before any request', () => {
  let requests = 0
  const fetch = async () => { requests++; throw new Error('must not run') }
  for (const endpoint of ['http://worker.example', 'http://10.0.0.1/bridge', 'ftp://worker.example', 'https://user:password@worker.example', 'http://user:password@127.0.0.1']) {
    assert.throws(() => createCharacterWorkerGateway({ endpoint, fetch }), /HTTPS|凭据/)
  }
  for (const endpoint of ['https://worker.example/bridge', 'http://127.0.0.1:19001', 'http://[::1]:19001', 'http://localhost:19001']) assert.equal(typeof createCharacterWorkerGateway({ endpoint, fetch }), 'function')
  assert.equal(requests, 0)
})

test('an already aborted task never sends POST or cancellation requests', async () => {
  let requests = 0
  const run = createCharacterWorkerGateway({ endpoint: 'https://worker.example', fetch: async () => { requests++; return new Response('{}') } })
  const controller = new AbortController(); controller.abort()
  await assert.rejects(run(task, scope, controller.signal), /abort/)
  assert.equal(requests, 0)
})
