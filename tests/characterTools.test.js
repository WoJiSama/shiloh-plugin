import test from 'node:test'
import assert from 'node:assert/strict'
import { createCharacterTools } from '../dist/backend/modules/simulation/infrastructure/characterTools.js'
import { beginCharacterGoalAttempt, createEmptyCharacterState, recordCharacterReceipt } from '../dist/backend/modules/simulation/domain/characterState.js'

const BASE_AT = 1794200000000

function harness() {
  let state = createEmptyCharacterState({ botId: 'robot-a', personaId: 'persona-a', groupId: 'group-a' })
  let at = BASE_AT
  let counter = 0
  let saveError = null
  const visible = ['message:1']
  const decisions = []
  const selected = []
  const tools = createCharacterTools({
    now: () => at,
    read: async () => structuredClone(state),
    update: async fn => {
      const next = fn(structuredClone(state))
      if (saveError) throw saveError
      state = next
      return structuredClone(state)
    },
    visibleEvidenceRefs: () => [...visible],
    selectGoal: async id => { selected.push(id) },
    onDecision: kind => { decisions.push(kind) },
    makeId: prefix => `${prefix}-${++counter}`,
  })
  return {
    tools, visible, decisions, selected,
    state: () => state,
    setState: value => { state = value },
    clock: value => { at = value },
    failSave: () => { saveError = new Error('Redis unavailable') },
    call: async (name, input) => {
      const tool = tools.find(tool => tool.name === name)
      assert.ok(tool)
      return await tool.execute(input, {})
    },
  }
}

const memoryInput = {
  action: 'remember', kind: 'opinion', content: '我暂时更看重玩法。',
  epistemic: 'inferred', evidenceRefs: ['message:1'],
}
const goalInput = {
  action: 'create', title: '查清机制', motivation: '上次讨论留下疑问', nextStep: '查找官方说明',
  completionCriteria: '拿到官方说明并核对', stopConditions: ['没有可靠资料则等待'], evidenceRefs: ['message:1'],
}

test('角色工具要求可见来源，并保留观点的推测地位', async () => {
  const h = harness()
  const unavailable = await h.call('simCharacterMemory', { ...memoryInput, evidenceRefs: ['message:999'] })
  assert.match(unavailable, /^error:/)
  assert.equal(h.state().memories.length, 0)
  const result = await h.call('simCharacterMemory', memoryInput)
  assert.equal(result.ok, true)
  assert.equal(result.memory.epistemic, 'inferred')
  assert.deepEqual(result.memory.evidenceRefs, ['message:1'])
  const falselyObserved = await h.call('simCharacterMemory', { ...memoryInput, epistemic: 'observed' })
  assert.match(falselyObserved, /^error:/)
  assert.equal(h.state().memories.length, 1)
})

test('模型不能指定新记录的ID或伪造动作回执', async () => {
  const h = harness()
  for (const input of [
    { ...memoryInput, id: 'chosen-id' },
    { ...memoryInput, receipt: { status: 'succeeded' } },
  ]) assert.match(await h.call('simCharacterMemory', input), /^error:/)
  assert.match(await h.call('simGoal', { ...goalInput, id: 'chosen-goal' }), /^error:/)
  assert.equal(h.state().memories.length, 0)
  assert.equal(h.state().goals.length, 0)
})

test('完成自主目标必须引用本目标的真实成功回执', async () => {
  const h = harness()
  const created = await h.call('simGoal', goalInput)
  assert.equal(created.ok, true)
  const id = created.goal.id
  assert.match(await h.call('simGoal', { action: 'complete', id, evidenceRefs: ['message:1'] }), /^error:/)
  h.clock(BASE_AT + 15 * 60_000)
  h.setState(beginCharacterGoalAttempt(h.state(), id, { id: 'actual-action', toolName: 'lookup' }, BASE_AT + 15 * 60_000))
  const pending = h.state().receipts[0]
  h.setState(recordCharacterReceipt(h.state(), { ...pending, status: 'succeeded', summary: '已取得官方说明' }, BASE_AT + 15 * 60_000))
  assert.match(await h.call('simGoal', { action: 'complete', id, evidenceRefs: ['receipt:actual-action'] }), /^error:/, '存储中存在但本轮没看到的回执也不能引用')
  h.visible.push('receipt:actual-action')
  const completed = await h.call('simGoal', { action: 'complete', id, evidenceRefs: ['receipt:actual-action'] })
  assert.equal(completed.ok, true)
  assert.equal(completed.goal.status, 'completed')
  assert.match(await h.call('simGoal', { action: 'wait', id }), /^error:/, '终态不能重新排期')
})

test('等待可以更新下一步，但不能用无效时间绕过最小检查间隔', async () => {
  const h = harness()
  const created = await h.call('simGoal', goalInput)
  const id = created.goal.id
  assert.match(await h.call('simGoal', { action: 'wait', id, nextCheckInMinutes: 0 }), /^error:/)
  const waiting = await h.call('simGoal', { action: 'wait', id, nextStep: '等待官方补充说明', nextCheckInMinutes: 30, outcome: '现有资料不足' })
  assert.equal(waiting.ok, true)
  assert.equal(waiting.goal.nextStep, '等待官方补充说明')
  assert.equal(waiting.goal.nextCheckAt, BASE_AT + 30 * 60_000)
  assert.equal(waiting.goal.lastOutcome, '现有资料不足')
})

test('目标focus由运行时绑定执行主体，工具不接受用户身份参数', async () => {
  const h = harness()
  const created = await h.call('simGoal', goalInput)
  const id = created.goal.id
  assert.match(await h.call('simGoal', { action: 'focus', id, user_id: 'admin' }), /^error:/)
  assert.deepEqual(h.selected, [])
  const focused = await h.call('simGoal', { action: 'focus', id })
  assert.equal(focused.actor, 'autonomous')
  assert.deepEqual(h.selected, [id])
})

test('参与决定只有持久化成功后才影响本轮，存储失败不能假装成功', async () => {
  const h = harness()
  h.failSave()
  assert.match(await h.call('simDecide', { kind: 'silent', reason: '这轮先旁听' }), /^error:/)
  assert.equal(h.state().decision, undefined)
  assert.deepEqual(h.decisions, [])
  const good = harness()
  const result = await good.call('simDecide', { kind: 'deferred', reason: '等更多资料' })
  assert.equal(result.ok, true)
  assert.equal(good.state().decision.kind, 'deferred')
  assert.deepEqual(good.decisions, ['deferred'])
})

test('工具参数拒绝混合操作与超出范围的预算', async () => {
  const h = harness()
  assert.match(await h.call('simGoal', { ...goalInput, maxAttempts: 99 }), /^error:/)
  assert.match(await h.call('simGoal', { ...goalInput, maxAttempts: 1.5 }), /^error:/)
  assert.match(await h.call('simGoal', { action: 'list', title: '偷偷创建' }), /^error:/)
  assert.match(await h.call('simDecide', { kind: 'unwilling', reason: '不想', paused: true }), /^error:/)
  assert.equal(h.state().goals.length, 0)
})

test('记忆和目标整条分页保持JSON预算，只暴露当前页，非法游标拒绝', async () => {
  const h = harness()
  const state = h.state()
  state.memories = Array.from({ length: 12 }, (_, index) => ({
    id: `memory-${index}`, kind: 'opinion', content: `判断${index}：${'资料'.repeat(500)}`,
    epistemic: 'inferred', evidenceRefs: ['message:1'], createdAt: BASE_AT, updatedAt: BASE_AT + index,
  }))
  state.goals = Array.from({ length: 10 }, (_, index) => ({
    id: `goal-${index}`, kind: 'autonomous', title: `目标${index}`, motivation: '动机'.repeat(200), nextStep: '查资料',
    completionCriteria: '取得资料', stopConditions: ['资料不足就停止'], evidenceRefs: ['message:1'], status: 'abandoned',
    nextCheckAt: BASE_AT + 900_000, expiresAt: BASE_AT + 86400_000, attempts: 0, maxAttempts: 3,
    revision: 1, createdAt: BASE_AT, updatedAt: BASE_AT + index,
  }))
  h.setState(state)
  for (const [name, field] of [['simCharacterMemory', 'memories'], ['simGoal', 'goals']]) {
    const ids = []
    let beforeId
    let pages = 0
    do {
      const result = await h.call(name, { action: 'list', ...(beforeId ? { beforeId } : {}) })
      assert.equal(result.ok, true)
      assert.ok(JSON.stringify(result).length <= 3500)
      assert.ok(result[field].length > 0)
      for (const item of result[field]) assert.deepEqual(item, state[field].find(record => record.id === item.id))
      ids.push(...result[field].map(item => item.id))
      assert.equal(result.hasMore, Boolean(result.nextBeforeId))
      beforeId = result.nextBeforeId
      pages += 1
      assert.ok(pages <= state[field].length)
    } while (beforeId)
    assert.ok(pages > 1)
    assert.deepEqual(ids, [...state[field]].reverse().map(item => item.id))
    assert.match(await h.call(name, { action: 'list', beforeId: 'missing-id' }), /^error:/)
    assert.match(await h.call(name, { action: 'list', beforeId: '' }), /^error:/)
  }
  assert.match(await h.call('simCharacterMemory', { ...memoryInput, beforeId: 'memory-1' }), /^error:/)
  assert.match(await h.call('simGoal', { ...goalInput, beforeId: 'goal-1' }), /^error:/)
  state.goals[0].motivation = '过大'.repeat(2000)
  h.setState(state)
  assert.match(await h.call('simGoal', { action: 'list', beforeId: 'goal-1' }), /超过 3500/)
})
