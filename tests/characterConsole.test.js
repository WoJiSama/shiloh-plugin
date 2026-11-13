import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createConsoleServer } from '../dist/backend/modules/platform/infrastructure/console/consoleServer.js'
import { createSimulationRuntime } from '../dist/backend/modules/simulation/infrastructure/simulationRuntime.js'
import { createDefaultSimSession } from '../dist/backend/modules/simulation/domain/simConfig.js'

async function fixture(t, withControl = true, simulation = {}) {
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
        } : {}),
        ...simulation,
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
  const get = async endpoint => {
    const response = await fetch(`${base}${endpoint}`, { headers: { 'x-console-token': token } })
    return { status: response.status, data: await response.json() }
  }
  return { request, get, calls, activityCalls }
}

test('真实无机器人控制台读取旧会话返回待绑定且不创建角色范围', async t => {
  const group = '10086', at = Date.parse('2026-11-09T00:00:00Z')
  const state = createDefaultSimSession(at)
  state.budget.turns = 4
  const kv = new Map([
    [`shiloh:sim:g:${group}`, JSON.stringify(state)],
    ['shiloh:sim:known', JSON.stringify([group])],
    ['shiloh:sim:overrides', JSON.stringify({ explicitEnabled: [group], disabled: [], budgetCaps: {}, turnCaps: {} })],
  ])
  const runtime = createSimulationRuntime({
    redis: { async get(key) { return kv.get(key) ?? null }, async set(key, value) { kv.set(key, value) }, async del(key) { kv.delete(key) } },
    now: () => at, logger: { info() {}, warn() {}, error() {} },
    getSelf: () => ({ id: '', name: '' }),
    getPersona: () => { throw new Error('未绑定群不得解析人格') },
    getSection: () => ({ enabled: true, allGroups: false, groups: [group] }),
    getExecutionConfig: () => ({}), getExtraTools: () => [],
    YTapi: async () => { throw new Error('控制台读取不得调用模型') },
    sendGroupMessage: async () => { throw new Error('控制台读取不得发送群消息') },
  })
  t.after(() => runtime.stop())
  const f = await fixture(t, true, runtime)
  const before = [...kv.entries()]
  const detail = await f.get(`/api/simulation/group?group=${group}`)
  assert.equal(detail.status, 200)
  assert.equal(detail.data.character, null)
  assert.equal(detail.data.characterBinding.status, 'pending')
  assert.equal(detail.data.budget.turns, 4)
  assert.deepEqual(detail.data.activities.works, [])
  assert.equal((await f.get('/api/simulation/overview')).data.groups[0].groupId, group)
  assert.deepEqual((await f.get('/api/life/overview')).data.threads, [])
  for (const body of [{ operation: 'pause' }, { action: 'activity', operation: 'reflection-reset' }]) {
    const response = await f.request(body)
    assert.ok(response.status >= 400)
    assert.match(response.data.error, /尚未绑定机器人/)
  }
  assert.deepEqual([...kv.entries()], before)
})

test('角色档案只展示已绑定范围的状态和被引用的消息依据', async t => {
  const group = '10086', at = Date.parse('2026-11-09T04:00:00Z')
  const state = createDefaultSimSession(at)
  state.botId = '10001'
  state.recent = ['初次讨论', '不相干的发言', '试玩后的反馈'].map((text, index) => ({
    seq: [1, 2, 4][index], userId: '10002', name: '群友', text, at, kind: 'text', messageId: null, imageCount: 0, atSelf: false, quoteToSelf: false,
  }))
  const scope = { botId: '10001', personaId: 'friendly', groupId: group }
  const key = `shiloh:character:v1:10001:friendly:${group}`
  const memories = [
    { id: 'old', kind: 'opinion', content: '旧的看法', epistemic: 'inferred', evidenceRefs: ['message:1'], createdAt: at, updatedAt: at },
    { id: 'new', kind: 'opinion', content: '修订后的看法', epistemic: 'inferred', supersedes: 'old', evidenceRefs: ['memory:old', 'message:4'], createdAt: at, updatedAt: at },
  ]
  const kv = new Map([
    [`shiloh:sim:g:${group}`, JSON.stringify(state)],
    [key, JSON.stringify({ schemaVersion: 1, scope, revision: 2, paused: false, memories, goals: [], receipts: [] })],
    [`${key}:legacy:self-memories`, JSON.stringify([{ id: 'habit', kind: 'note', content: '遇到桌游话题会先问机制', updatedAt: at, habitMessageSeqs: [1, 3] }])],
  ])
  const runtime = createSimulationRuntime({
    redis: { async get(key) { return kv.get(key) ?? null }, async set(key, value) { kv.set(key, value) }, async del(key) { kv.delete(key) } },
    now: () => at, logger: { info() {}, warn() {}, error() {} },
    getSelf: () => ({ id: '', name: '' }),
    getPersona: (groupId, botId) => {
      assert.equal(groupId, group)
      assert.equal(botId, scope.botId)
      return { personaId: scope.personaId, persona: { name: '希洛', preferences: ['地图谜题'], hiddenField: '不进档案' }, systemContent: '原始提示不进档案' }
    },
    getSection: () => ({ enabled: true, allGroups: false, groups: [group], mood: { enabled: false } }),
    getExecutionConfig: () => ({}), getExtraTools: () => [],
    YTapi: async () => { throw new Error('控制台读取不得调用模型') },
    sendGroupMessage: async () => { throw new Error('控制台读取不得发送群消息') },
  })
  t.after(() => runtime.stop())
  const f = await fixture(t, true, runtime)
  assert.equal((await f.get(`/api/simulation/group?group=${group}`)).data.profile, undefined)
  const before = [...kv.entries()]
  const detail = await f.get(`/api/simulation/group?group=${group}&view=character`)
  assert.equal(detail.status, 200)
  const { profile } = detail.data
  assert.equal(profile.persona.name, '希洛')
  assert.equal(profile.mood.status, 'disabled')
  assert.deepEqual(profile.opinions.map(item => item.id), ['new'])
  assert.equal(profile.evidence['message:1'].text, '初次讨论')
  assert.equal(profile.evidence['message:2'], undefined)
  assert.equal(profile.evidence['message:3'], undefined)
  assert.equal(profile.evidence['message:4'].text, '试玩后的反馈')
  assert.equal(profile.evidence['memory:old'].text, '旧的看法')
  assert.deepEqual(profile.habits[0].evidenceRefs, ['message:1', 'message:3'])
  assert.doesNotMatch(JSON.stringify(profile), /原始提示|不进档案|不相干的发言/)
  assert.deepEqual([...kv.entries()], before)
})

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
