import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createConsoleServer } from '../dist/backend/modules/platform/infrastructure/console/consoleServer.js'

async function fixture(t, withControl = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'character-console-'))
  const constructorTimers = []
  let server
  t.after(async () => {
    // createConsoleServer owns a recursive 45s exit-IP prefetch timer, independent
    // of the HTTP server. Dispose only timers created by this fixture constructor.
    for (const timer of constructorTimers) clearTimeout(timer)
    if (server?.listening) {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
    fs.rmSync(root, { recursive: true, force: true })
  })
  fs.mkdirSync(path.join(root, 'config'), { recursive: true })
  const token = 'character-console-isolated-test'
  fs.writeFileSync(path.join(root, 'config', 'console.json'), JSON.stringify({ token }))
  fs.writeFileSync(path.join(root, 'config', 'message.yaml'), 'pluginSettings: {}\n')
  const calls = []
  const activityCalls = []
  const previousRoot = process.env.CONSOLE_PLUGIN_ROOT
  process.env.CONSOLE_PLUGIN_ROOT = root
  const setTimeout = globalThis.setTimeout
  const timeoutMock = t.mock.method(globalThis, 'setTimeout', (...args) => {
    const timer = setTimeout(...args)
    constructorTimers.push(timer)
    return timer
  })
  try {
    ;({ server } = createConsoleServer({
      pluginRoot: root, buildTurnTraceReport: () => ({}),
      simulation: {
        overview: async () => ({}), describeGroup: async groupId => ({ groupId }),
        setGroup: async () => { throw new Error('character actions must not fall through to group reset') },
        setInitialPrompt: async () => '',
        ...(withControl ? {
          controlCharacter: async (...args) => { calls.push(args); return '已更新' },
          controlActivity: async (...args) => { activityCalls.push(args); return '活动已更新' }
        } : {})
      }
    }))
  } finally {
    timeoutMock.mock.restore()
    if (previousRoot === undefined) delete process.env.CONSOLE_PLUGIN_ROOT
    else process.env.CONSOLE_PLUGIN_ROOT = previousRoot
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const base = `http://127.0.0.1:${server.address().port}`
  const request = async (body, authenticated = true) => {
    const response = await fetch(`${base}/api/simulation/group`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(authenticated ? { 'x-console-token': token } : {}) },
      body: JSON.stringify({ group: '10086', action: 'character', ...body })
    })
    return { status: response.status, data: await response.json() }
  }
  return { request, calls, activityCalls }
}

test('character console actions require authentication and validate their target before dispatch', async t => {
  const f = await fixture(t)
  assert.equal((await f.request({ operation: 'pause' }, false)).status, 401)
  for (const body of [
    {}, { operation: 'reset' }, { operation: ['pause'] }, { operation: 'pause', id: 'unexpected' },
    { operation: 'resume', id: null }, { operation: 'cancel-goal' }, { operation: 'pause-goal', id: 42 },
    { operation: 'resume-goal', id: '' }, { operation: 'delete-memory', id: ' padded ' },
    { operation: 'delete-memory', id: 'x'.repeat(201) }, { group: 'another-group', operation: 'pause' }
  ]) assert.equal((await f.request(body)).status, 400, JSON.stringify(body))
  assert.deepEqual(f.calls, [])
  for (const operation of ['pause', 'resume']) {
    assert.deepEqual(await f.request({ operation }), { status: 200, data: { ok: true, message: '已更新' } })
  }
  for (const operation of ['cancel-goal', 'pause-goal', 'resume-goal', 'delete-memory']) {
    assert.equal((await f.request({ operation, id: 'record-1' })).status, 200)
  }
  assert.deepEqual(f.calls, [
    ['10086', 'pause', undefined], ['10086', 'resume', undefined],
    ['10086', 'cancel-goal', 'record-1'], ['10086', 'pause-goal', 'record-1'],
    ['10086', 'resume-goal', 'record-1'], ['10086', 'delete-memory', 'record-1']
  ])
})

test('older simulation runtimes fail character controls explicitly without resetting a group', async t => {
  const f = await fixture(t, false)
  assert.equal((await f.request({ operation: 'pause' })).status, 503)
  assert.deepEqual(f.calls, [])
})

test('activity controls authenticate and strictly validate operation, id and restore payload', async t => {
  const f = await fixture(t)
  const request = (body, authenticated = true) => f.request({ action: 'activity', ...body }, authenticated)
  assert.equal((await request({ operation: 'reflection-reset' }, false)).status, 401)
  for (const body of [
    {}, { operation: 'work-write', id: 'w1' }, { operation: ['work-delete'], id: 'w1' },
    { operation: 'work-archive' }, { operation: 'work-delete', id: 1 },
    { operation: 'subscription-remove', id: ' padded ' }, { operation: 'shared-approve', id: 'x'.repeat(201) },
    { operation: 'work-delete', id: 'record\u0000id' },
    { operation: 'reflection-reset', id: 'unexpected' }, { operation: 'reflection-reset', payload: {} },
    { operation: 'work-restore', id: 'w1' }, { operation: 'work-restore', id: 'w1', payload: null },
    { operation: 'work-restore', id: 'w1', payload: { revision: '1' } },
    { operation: 'work-restore', id: 'w1', payload: { revision: 0 } },
    { operation: 'work-restore', id: 'w1', payload: { revision: 1.5 } },
    { operation: 'work-restore', id: 'w1', payload: { revision: 1, content: 'injected' } },
    { operation: 'work-delete', id: 'w1', payload: {} },
    { operation: 'shared-approve', id: 's1', groupOverride: '10087' }
  ]) assert.equal((await request(body)).status, 400, JSON.stringify(body))
  assert.deepEqual(f.activityCalls, [])
  assert.equal((await request({ operation: 'reflection-reset' })).status, 200)
  assert.equal((await request({ operation: 'work-restore', id: 'w1', payload: { revision: 2 } })).status, 200)
  for (const operation of ['work-archive', 'work-delete', 'subscription-pause', 'subscription-resume', 'subscription-remove', 'shared-approve', 'shared-delete']) {
    assert.equal((await request({ operation, id: 'record-1' })).status, 200)
  }
  assert.deepEqual(f.activityCalls.slice(0, 2), [
    ['10086', 'reflection-reset', undefined, undefined],
    ['10086', 'work-restore', 'w1', { revision: 2 }]
  ])
  assert.deepEqual(f.calls, [], 'activity operations never reset or route through character controls')
})

test('older runtimes reject activity controls without group reset fallback', async t => {
  const f = await fixture(t, false)
  assert.equal((await f.request({ action: 'activity', operation: 'reflection-reset' })).status, 503)
  assert.deepEqual(f.activityCalls, [])
})
