import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGroupRuntime } from '../../src/modules/runtime/application/groupRuntime.js'
import type { RuntimePorts } from '../../src/contracts/runtime.js'

function fixture() {
  let now = 1000
  const cancelled: number[] = []
  const warnings: string[] = []
  const runtime = createGroupRuntime<number, string, string>({
    now: () => now, cancelTimer: timer => { cancelled.push(timer) },
    peekTopic: id => `topic:${id}`, peekSocial: id => `social:${id}`,
    logger: { warn: message => { warnings.push(message) } }
  })
  return { runtime, cancelled, warnings, advance: (value: number) => { now = value } }
}

test('identity is normalized within one runtime and isolated between runtime instances', () => {
  const a = fixture().runtime, b = fixture().runtime
  assert.equal(a.getSmartRuntimeState(123), a.getSmartRuntimeState('123'))
  assert.notEqual(a.getSmartRuntimeState(123), a.getSmartRuntimeState(124))
  assert.notEqual(a.getSmartRuntimeState(123), b.getSmartRuntimeState(123))
  assert.notEqual(a.getSmartRuntimeState(0), a.getSmartRuntimeState(undefined))
  assert.equal(a.getGroupRuntime(123).topic, 'topic:123')
  assert.equal(a.getGroupRuntime(123).social, 'social:123')
})

test('repeat registration refreshes providers without resetting active state or duplicating sweeps', () => {
  const { runtime } = fixture()
  const state = runtime.getSmartRuntimeState('g')
  state.pendingCount = 3
  const view = runtime.getGroupRuntime('g')
  runtime.registerGroupRuntimeProviders({ emotion: 'first', sessions: 'session' })
  runtime.registerGroupRuntimeProviders({ emotion: 'second' })
  assert.equal(view.emotion, 'second')
  assert.equal(view.sessions, 'session')
  assert.equal(view.smart.pendingCount, 3)
  runtime.registerRuntimeSweep('repeat', () => 1)
  runtime.registerRuntimeSweep('repeat', () => 2)
  assert.equal(runtime.listRuntimeSweeps().filter(name => name === 'repeat').length, 1)
  assert.equal(runtime.runRuntimeSweeps().results.repeat, 2)
})

test('eviction, deletion and reset dispose every owned timer', () => {
  const { runtime, cancelled, advance } = fixture()
  const oldest = runtime.getSmartRuntimeState('oldest')
  oldest.waitTimers.set('wait', 1); oldest.deferredTimer = 2; oldest.inFlightWatchdog = 3
  advance(2000)
  for (let i = 0; i < 100; i++) runtime.getSmartRuntimeState(i + 1)
  assert.equal(runtime.smartRuntimeSize(), 100)
  assert.equal(runtime.hasSmartRuntimeState('oldest'), false)
  assert.deepEqual(cancelled, [1, 3, 2])
  runtime.getSmartRuntimeState(1).inFlightWatchdog = 4
  assert.equal(runtime.deleteSmartRuntimeState(1), true)
  assert.equal(runtime.deleteSmartRuntimeState(1), false)
  runtime.getSmartRuntimeState(2).inFlightWatchdog = 5
  runtime.resetGroupRuntimeForTests()
  runtime.resetGroupRuntimeForTests()
  assert.deepEqual(cancelled, [1, 3, 2, 4, 5])
  assert.equal(runtime.smartRuntimeSize(), 0)
})

test('TTL sweep removes expired groups and an independent failed sweep does not block others', () => {
  const { runtime, warnings, advance } = fixture()
  runtime.getSmartRuntimeState('expired')
  advance(48 * 3600 * 1000)
  runtime.getSmartRuntimeState('fresh')
  runtime.registerRuntimeSweep('broken', () => { throw new Error('unavailable') })
  runtime.registerRuntimeSweep('healthy', () => 2)
  const result = runtime.runRuntimeSweeps({ ttlHours: 24 })
  assert.equal(result.removed, 3)
  assert.deepEqual(result.results, { smartStates: 1, broken: -1, healthy: 2 })
  assert.deepEqual(runtime.smartRuntimeGroupIds(), ['fresh'])
  assert.match(warnings[0]!, /unavailable/)
})

test('missing required runtime capability fails during composition', () => {
  const invalid = { now: () => 1 } as unknown as RuntimePorts<number, string, string>
  assert.throws(() => createGroupRuntime(invalid), /Missing runtime port: cancelTimer/)
})


test('zero-valued timer handles are cancelled', () => {
  const { runtime, cancelled } = fixture()
  runtime.getSmartRuntimeState('a').inFlightWatchdog = 0
  runtime.getSmartRuntimeState('b').deferredTimer = 0
  runtime.deleteSmartRuntimeState('a')
  runtime.resetGroupRuntimeForTests()
  assert.deepEqual(cancelled, [0, 0])
})
