import test from 'node:test'
import assert from 'node:assert/strict'
import { createCharacterTurnTool } from '../dist/backend/modules/simulation/infrastructure/characterTurn.js'
import { createCharacterTools } from '../dist/backend/modules/simulation/infrastructure/characterTools.js'
import { createSimTools } from '../dist/backend/modules/simulation/infrastructure/simTools.js'
import { beginCharacterGoalAttempt, createCharacterGoal, createEmptyCharacterState, recordCharacterReceipt, validateCharacterState } from '../dist/backend/modules/simulation/domain/characterState.js'

const BASE = 1794200000000
const SCOPE = { botId: 'robot-a', personaId: 'persona-a', groupId: 'group-a' }
const memory = { kind: 'experience', content: '群友提到线索设计很连贯', epistemic: 'reported', evidenceRefs: ['message:1'] }
const goal = { title: '核对公开玩法', motivation: '想了解线索设计', nextStep: '查官方介绍', completionCriteria: '取得公开介绍并核对', stopConditions: ['来源不可用时停止'], evidenceRefs: ['message:1'], nextCheckInMinutes: 30 }

test('生产聊天工具显式要求普通聊天或仅兴趣声明，其他选择不能绕过收尾', async () => {
  const sent = []
  const tool = createSimTools({ requireExplicitContinuation: true, maxSendItems: () => 5, getState: () => ({ unread: [], recent: [] }),
    sendMessage: async messages => { sent.push(...messages); return { ok: true, sent: messages.length } },
  }).find(tool => tool.name === 'simSendMessage')
  assert.ok(tool.parameters.required.includes('continuation'))
  for (const continuation of [undefined, 'schedule', 'complete', '', 42]) {
    assert.match(await tool.execute({ messages: ['这条不能发'], ...(continuation === undefined ? {} : { continuation }) }, {}), /^error:/)
  }
  assert.deepEqual(sent, [])
  const value = JSON.parse(await tool.execute({ continuation: 'interest_only', messages: ['这个想法有点意思'] }, {}))
  assert.equal(value.ok, true); assert.deepEqual(sent, ['这个想法有点意思'])
})

function harness() {
  let state = createEmptyCharacterState(SCOPE), at = BASE, nextId = 0
  const visible = ['message:1', 'message:2'], updates = [], finishes = []
  const controls = { beforeUpdate: null, saveError: null, inactive: false, review: null, finishResult: { ok: true, finished: true } }
  const ctx = {
    now: () => at, read: async () => structuredClone(state),
    update: async mutate => {
      controls.beforeUpdate?.()
      const next = validateCharacterState(mutate(structuredClone(state)), SCOPE)
      if (controls.saveError) throw controls.saveError
      next.revision = state.revision + 1
      state = next; updates.push(structuredClone(next))
      return structuredClone(next)
    },
    visibleEvidenceRefs: () => [...visible], makeId: prefix => `${prefix}-${++nextId}`,
    sharedSourceIds: () => ['approved-preference'],
    selectGoal: async () => { throw new Error('不能调用真实 focus 回调') },
    onDecision: () => { throw new Error('不能调用真实 decision 回调') },
    ensureActive: async () => { if (controls.inactive) throw new Error('执行授权已撤销') },
    review: async input => { await controls.review?.(input) },
    finish: async result => { finishes.push(structuredClone(result)); return controls.finishResult },
  }
  const tool = createCharacterTurnTool(ctx)
  return { tool, ctx, visible, controls, updates, finishes, state: () => structuredClone(state),
    setState: value => { state = structuredClone(value) }, clock: value => { at = value },
    call: input => tool.execute(input, {}),
  }
}

test('提交前一致性退回不保存草稿、不发送，检查能看到已校验目标和记忆', async () => {
  const h = harness()
  let reviews = 0
  h.controls.review = async input => {
    reviews++
    assert.equal(input.candidate.choice, 'schedule')
    assert.equal(input.state.goals.length, 1)
    assert.equal(input.state.memories.length, 1)
    assert.equal(h.updates.length, 0)
    throw new Error('一致性检查要求修正证据表述')
  }
  assert.match(await h.call({ choice: 'schedule', reason: '后续研究', goal, memories: [memory], messages: ['资料已经全部核实'] }), /一致性检查/)
  assert.equal(reviews, 1); assert.equal(h.updates.length, 0); assert.equal(h.finishes.length, 0)
  assert.equal(h.state().memories.length, 0); assert.equal(h.state().goals.length, 0)
})

test('模型检查期间状态变化或权限撤销，旧草稿不能提交', async () => {
  for (const change of ['revision', 'permission', 'source']) {
    const h = harness()
    h.controls.review = async () => {
      if (change === 'revision') h.setState({ ...h.state(), revision: 1 })
      else if (change === 'source') h.visible.splice(0)
      else h.controls.inactive = true
    }
    assert.match(await h.call({ choice: 'schedule', reason: '后续研究', goal }), /^error:/)
    assert.equal(h.updates.length, 0); assert.equal(h.finishes.length, 0)
  }
})

test('收尾 schema 复用角色工具字段和描述，嵌套操作不暴露 action', () => {
  const h = harness(), originals = createCharacterTools(h.ctx)
  const memoryTool = originals.find(tool => tool.name === 'simCharacterMemory')
  const goalTool = originals.find(tool => tool.name === 'simGoal')
  const memorySchema = h.tool.parameters.properties.memories.items
  const goalSchema = h.tool.parameters.properties.goal
  assert.equal(h.tool.name, 'simFinishTurn')
  assert.equal(memorySchema.properties.action, undefined)
  assert.equal(goalSchema.properties.action, undefined)
  assert.deepEqual(memorySchema.properties.kind, memoryTool.parameters.properties.kind)
  assert.deepEqual(goalSchema.properties.completionCriteria, goalTool.parameters.properties.completionCriteria)
  assert.ok(memorySchema.description.includes(memoryTool.description))
  assert.ok(goalSchema.description.includes(goalTool.description))
})

test('两条记忆和新目标在草稿中验证后一次保存，成功才把真实状态交给收尾回调', async () => {
  const h = harness()
  const result = await h.call({ choice: 'schedule', reason: '我确实想继续研究', goal, memories: [memory, { kind: 'opinion', content: '我暂时更看重线索连贯性', epistemic: 'inferred', evidenceRefs: ['message:2'] }], messages: '我稍后继续看看官方资料', replyToSeq: 1, atUserIds: ['40000'], throughSeq: 1 })
  assert.deepEqual(result, h.controls.finishResult)
  assert.equal(h.updates.length, 1); assert.equal(h.finishes.length, 1)
  assert.equal(h.state().revision, 1)
  assert.equal(h.state().memories.length, 2)
  assert.equal(h.state().goals.length, 1)
  assert.deepEqual(h.state().memories.map(item => item.evidenceRefs), [['message:1'], ['message:2']])
  assert.ok(h.state().memories.every(item => item.sharedSources[0] === 'approved-preference'))
  assert.equal(h.state().goals[0].nextCheckAt, BASE + 30 * 60_000)
  assert.deepEqual(h.finishes[0], { choice: 'schedule', state: h.state(), memories: h.state().memories, goal: h.state().goals[0], messages: ['我稍后继续看看官方资料'], replyToSeq: 1, atUserIds: ['40000'], throughSeq: 1 })
})

test('后一个记忆或目标验证失败时没有部分写入、收尾或自动补来源', async () => {
  for (const input of [
    { choice: 'interest_only', reason: '尚未确定', memories: [memory, { ...memory, evidenceRefs: ['message:999'] }] },
    { choice: 'schedule', reason: '计划仍有缺项', memories: [memory], goal: { ...goal, maxAttempts: 1.5 } },
  ]) {
    const h = harness(), before = h.state()
    assert.match(await h.call(input), /^error:/)
    assert.deepEqual(h.state(), before)
    assert.equal(h.updates.length, 0); assert.equal(h.finishes.length, 0)
    assert.deepEqual(h.visible, ['message:1', 'message:2'])
  }
})

test('CAS 冲突保留并发状态，存储失败也不调用 finish', async () => {
  for (const failure of ['cas', 'storage']) {
    const h = harness()
    if (failure === 'cas') h.controls.beforeUpdate = () => h.setState({ ...h.state(), revision: 1, decision: { kind: 'silent', reason: '管理员已调整状态', at: BASE } })
    else h.controls.saveError = new Error('Redis 写入失败')
    assert.match(await h.call({ choice: 'schedule', reason: '准备安排', goal, memories: [memory] }), /^error:/)
    assert.equal(h.updates.length, 0); assert.equal(h.finishes.length, 0)
    assert.equal(h.state().memories.length, 0); assert.equal(h.state().goals.length, 0)
    if (failure === 'cas') assert.equal(h.state().decision.reason, '管理员已调整状态')
  }
})

function completionFixture(status, differentGoal = false) {
  const h = harness(), at = BASE + 15 * 60_000
  const { nextCheckInMinutes: _minutes, ...goalInput } = goal
  let state = createCharacterGoal(h.state(), { ...goalInput, id: 'goal-a', nextCheckAt: at }, h.visible, BASE)
  if (differentGoal) state = createCharacterGoal(state, { ...goalInput, id: 'goal-b', nextCheckAt: at }, h.visible, BASE)
  const goalId = differentGoal ? 'goal-b' : 'goal-a'
  if (status) {
    state = beginCharacterGoalAttempt(state, goalId, { id: 'actual-result', toolName: 'searchInformationTool' }, at)
    if (status !== 'pending') state = recordCharacterReceipt(state, { ...state.receipts[0], status, summary: '工作器的实际回执', at }, at)
    h.visible.push('receipt:actual-result')
  }
  h.setState(state); h.clock(at)
  return h
}

test('complete 只能引用本目标真实成功回执，不能把收尾本身或别的目标当成果', async () => {
  for (const [status, differentGoal] of [[null, false], ['pending', false], ['unknown', false], ['failed', false], ['succeeded', true]]) {
    const h = completionFixture(status, differentGoal)
    assert.match(await h.call({ choice: 'complete', reason: '尝试完成', goal: { id: 'goal-a', evidenceRefs: status ? ['receipt:actual-result'] : ['message:1'] } }), /^error:/)
    assert.equal(h.updates.length, 0); assert.equal(h.finishes.length, 0)
    assert.notEqual(h.state().goals[0].status, 'completed')
  }
  const h = completionFixture('succeeded')
  assert.deepEqual(await h.call({ choice: 'complete', reason: '已经取得所需资料', goal: { id: 'goal-a', evidenceRefs: ['receipt:actual-result'], outcome: '取得公开介绍' }, messages: ['官方介绍已找到'] }), h.controls.finishResult)
  assert.equal(h.state().goals[0].status, 'completed')
  assert.equal(h.state().receipts.length, 1, '收尾不能伪造额外成功行动回执')
  assert.equal(h.updates.length, 1); assert.equal(h.finishes.length, 1)
})

test('wait 和 abandon 只更新显式已有目标，不支持 focus 或重建目标', async () => {
  for (const choice of ['wait', 'abandon']) {
    const h = completionFixture(null)
    const input = { id: 'goal-a', outcome: '暂时没有更多资料', ...(choice === 'wait' ? { nextCheckInMinutes: 30, nextStep: '等待官方更新' } : {}) }
    assert.deepEqual(await h.call({ choice, reason: '我选择停下本轮', goal: input }), h.controls.finishResult)
    assert.equal(h.state().goals.length, 1)
    assert.equal(h.state().goals[0].status, choice === 'wait' ? 'waiting' : 'abandoned')
    assert.equal(h.updates.length, 1); assert.equal(h.finishes.length, 1)
  }
})

test('普通聊天与纯兴趣可以不写状态；拒绝和沉默不自动生成目标', async () => {
  for (const choice of ['chat', 'interest_only', 'silent', 'cannot', 'unauthorized', 'unwilling', 'deferred']) {
    const h = harness()
    assert.deepEqual(await h.call({ choice, reason: '这是我本轮的明确选择' }), h.controls.finishResult)
    assert.equal(h.state().goals.length, 0); assert.equal(h.state().memories.length, 0)
    assert.equal(h.finishes.length, 1)
    if (choice === 'chat' || choice === 'interest_only') { assert.equal(h.updates.length, 0); assert.equal(h.state().decision, undefined) }
    else { assert.equal(h.updates.length, 1); assert.equal(h.state().decision.kind, choice) }
  }
})

test('顶层、嵌套字段和收尾发送参数严格验证，不忽略 action、枚举或调用者指定新 ID', async () => {
  const chat = { choice: 'chat', reason: '普通聊天' }
  const invalid = [
    null, [], {}, { ...chat, choice: 'focus' }, { ...chat, choice: ['chat'] }, { ...chat, reason: '' }, { ...chat, reason: 'x'.repeat(601) },
    { ...chat, scope: SCOPE }, { ...chat, groupId: 'other' }, { ...chat, action: 'complete' }, { ...chat, goal },
    { choice: 'schedule', reason: '计划', goal: { ...goal, id: 'caller-id' } },
    { choice: 'schedule', reason: '计划', goal: { ...goal, action: 'create' } },
    { choice: 'schedule', reason: '计划', goal: { ...goal, endpoint: 'https://example.com' } },
    { choice: 'wait', reason: '等待', goal: { id: 'goal-a', action: 'focus' } },
    { ...chat, memories: [memory, memory, memory] }, { ...chat, memories: null },
    { ...chat, memories: [{ ...memory, action: 'remember' }] }, { ...chat, memories: [{ ...memory, id: 'caller-id' }] },
    { ...chat, memories: [{ ...memory, kind: 'not-a-kind' }] }, { ...chat, memories: [{ ...memory, epistemic: 'fact' }] },
    { ...chat, memories: [{ ...memory, kind: 'opinion', epistemic: 'reported' }] },
    { ...chat, messages: [] }, { ...chat, messages: ['x', 1] }, { ...chat, messages: [' '] }, { ...chat, messages: ['x'.repeat(501)] }, { ...chat, messages: Array(6).fill('x') },
    { ...chat, replyToSeq: 0 }, { ...chat, replyToSeq: 1.5 }, { ...chat, replyToSeq: '1' },
    { ...chat, throughSeq: -1 }, { ...chat, throughSeq: 0.5 }, { ...chat, throughSeq: '1' },
    { ...chat, atUserIds: ['not-a-qq'] }, { ...chat, atUserIds: [40000] }, { ...chat, atUserIds: ['1', '2', '3', '4'] },
    { choice: 'silent', reason: '旁听', messages: ['不应发送'] }, { choice: 'deferred', reason: '暂缓', messages: '不应发送' },
  ]
  for (const input of invalid) {
    const h = harness()
    assert.match(await h.call(input), /^error:/, JSON.stringify(input))
    assert.equal(h.updates.length, 0, JSON.stringify(input)); assert.equal(h.finishes.length, 0, JSON.stringify(input))
  }
})

test('修订沿用已有来源约束，不自动补旧来源；已撤销授权不进入草稿或收尾', async () => {
  const h = harness()
  await h.call({ choice: 'interest_only', reason: '记录一次反馈', memories: [memory] })
  const oldId = h.state().memories[0].id
  h.visible.push(`memory:${oldId}`)
  assert.match(await h.call({ choice: 'interest_only', reason: '修订', memories: [{ ...memory, supersedes: oldId }] }), /^error:/)
  assert.equal(h.state().memories.length, 1); assert.equal(h.updates.length, 1); assert.equal(h.finishes.length, 1)
  h.controls.inactive = true
  assert.match(await h.call({ choice: 'schedule', reason: '授权已撤销', goal }), /^error:/)
  assert.equal(h.updates.length, 1); assert.equal(h.finishes.length, 1)
})

test('finish 的发送失败结果原样返回，不重试或回滚已保存状态', async () => {
  const h = harness()
  h.controls.finishResult = { ok: false, saved: true, error: '网关结果未知' }
  assert.deepEqual(await h.call({ choice: 'schedule', reason: '真实计划', goal, messages: ['稍后继续'] }), h.controls.finishResult)
  assert.equal(h.state().goals.length, 1)
  assert.equal(h.updates.length, 1); assert.equal(h.finishes.length, 1)
})
