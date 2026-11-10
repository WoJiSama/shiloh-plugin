import test from 'node:test'
import assert from 'node:assert/strict'
import {
  addCharacterMemory, characterCapacity, compactCharacterState, createEmptyCharacterState,
  createCharacterGoal, formatCharacterSection, recordCharacterReceipt, validateCharacterState,
} from '../dist/backend/modules/simulation/domain/characterState.js'

const AT = 1794200000000
const scope = { botId: 'bot', personaId: 'persona', groupId: 'group' }
const empty = () => createEmptyCharacterState(scope)
const receipt = (id, options = {}) => ({ id, toolName: 'lookup', status: 'succeeded', summary: id, at: AT, ...options })
const goal = (id, index, options = {}) => ({
  id, kind: 'autonomous', title: id, motivation: '有未解决的问题', nextStep: '核对来源',
  completionCriteria: '取得可靠结果', stopConditions: ['资料不足就停止'], evidenceRefs: ['message:1'],
  status: 'abandoned', nextCheckAt: AT + 15 * 60_000, expiresAt: AT + 24 * 3600_000,
  attempts: 0, maxAttempts: 3, revision: 1, createdAt: AT, updatedAt: AT + index,
  ...options,
})
const memory = (id, refs, options = {}) => ({
  id, kind: 'experience', content: `经历 ${id}`, epistemic: 'observed', evidenceRefs: refs,
  createdAt: AT, updatedAt: AT, ...options,
})

test('回执保留最近64条普通审计，旧的256条上限不会永久阻断发送', () => {
  const state = empty()
  state.receipts = Array.from({ length: 256 }, (_, index) => receipt(`receipt-${index}`, { at: AT + index }))
  const before = structuredClone(state)
  const compact = compactCharacterState(state, AT + 1000)
  assert.equal(compact.receipts.length, 64)
  assert.deepEqual(compact.receipts.map(item => item.id), state.receipts.slice(-64).map(item => item.id))
  assert.deepEqual(state, before, '不能修改调用者原对象')
  const pending = recordCharacterReceipt(compact, receipt('new-message', { status: 'pending', toolName: 'simSendMessage', at: AT + 1000 }), AT + 1000)
  const sent = recordCharacterReceipt(pending, receipt('new-message', { toolName: 'simSendMessage', at: AT + 1000 }), AT + 1000)
  assert.equal(sent.receipts.at(-1).status, 'succeeded')
  assert.equal(compactCharacterState(sent, AT + 1000).receipts.length, 64)
})

test('超出近期窗口的成功来源、未知来源与在途回执都受保护', () => {
  const state = empty()
  state.receipts = [
    receipt('old-success'), receipt('old-unknown', { status: 'unknown' }), receipt('still-running', { status: 'pending' }),
    ...Array.from({ length: 100 }, (_, index) => receipt(`audit-${index}`, { at: AT + index + 1 })),
  ]
  state.memories = [memory('observed', ['receipt:old-success']), memory('uncertain', ['receipt:old-unknown'], { epistemic: 'inferred' })]
  const compact = compactCharacterState(state, AT + 1000)
  assert.equal(compact.receipts.length, 67)
  for (const id of ['old-success', 'old-unknown', 'still-running']) assert.ok(compact.receipts.some(item => item.id === id))
  assert.equal(compact.receipts.find(item => item.id === 'old-unknown').status, 'unknown')
  assert.equal(compact.receipts.find(item => item.id === 'still-running').status, 'pending')
  assert.doesNotThrow(() => validateCharacterState(compact))
})

test('旧终态目标及其仅审计回执一起淘汰，不因相互引用永久保留', () => {
  const state = empty()
  state.goals = Array.from({ length: 64 }, (_, index) => goal(`goal-${index}`, index, { evidenceRefs: [`receipt:action-${index}`] }))
  state.receipts = state.goals.map((item, index) => receipt(`action-${index}`, { goalId: item.id, goalRevision: 1, at: AT + index }))
  const compact = compactCharacterState(state, AT + 1000)
  assert.equal(compact.goals.length, 16)
  assert.equal(compact.receipts.length, 16)
  assert.deepEqual(compact.goals.map(item => item.id), state.goals.slice(-16).map(item => item.id))
  const created = createCharacterGoal(compact, {
    id: 'new-goal', title: '继续探索', motivation: '发现新线索', nextStep: '核对资料', completionCriteria: '找到资料',
    stopConditions: ['没有资料就等'], evidenceRefs: ['message:1'],
  }, ['message:1'], AT + 1000)
  assert.equal(created.goals.length, 17)
})

test('记忆或活跃目标引用的旧回执会保留原目标及来源闭包', () => {
  const state = empty()
  state.goals = Array.from({ length: 24 }, (_, index) => goal(`goal-${index}`, index))
  state.goals.push(goal('live', 25, { status: 'waiting', evidenceRefs: ['receipt:action-1'] }))
  state.goals[0].evidenceRefs = ['receipt:action-2']
  state.receipts = [0, 1, 2].map(index => receipt(`action-${index}`, { goalId: `goal-${index}`, goalRevision: 1 }))
  state.memories = [memory('key-experience', ['receipt:action-0'])]
  const compact = compactCharacterState(state, AT + 1000)
  for (const id of ['goal-0', 'goal-1', 'goal-2', 'live']) assert.ok(compact.goals.some(item => item.id === id))
  assert.equal(compact.goals.some(item => item.id === 'goal-3'), false)
  assert.equal(compact.goals.length, 20, '最近16终态，加3个来源保护终态及1个活跃目标')
  assert.doesNotThrow(() => validateCharacterState(compact))
})

test('不能删掉被supersedes或派生记忆引用的旧记忆及真实来源', () => {
  const state = empty()
  state.receipts = [receipt('source'), ...Array.from({ length: 80 }, (_, index) => receipt(`new-${index}`, { at: AT + index + 1 }))]
  state.memories = [
    memory('old', ['receipt:source']),
    memory('revised', ['memory:old'], { epistemic: 'inferred', supersedes: 'old' }),
    memory('derived', ['memory:revised'], { epistemic: 'inferred' }),
  ]
  const compact = compactCharacterState(state, AT + 1000)
  assert.deepEqual(compact.memories, state.memories)
  assert.ok(compact.receipts.some(item => item.id === 'source'))
  assert.doesNotThrow(() => validateCharacterState(compact))
})

test('满128条记忆只拒绝新增记忆，普通发消息仍能登记和完成回执', () => {
  const state = empty()
  state.memories = Array.from({ length: 128 }, (_, index) => memory(`memory-${index}`, ['message:1'], { epistemic: 'inferred' }))
  const compact = compactCharacterState(state, AT)
  assert.throws(() => addCharacterMemory(compact, {
    id: 'too-many', kind: 'opinion', content: '新观点', epistemic: 'inferred', evidenceRefs: ['message:1'],
  }, ['message:1'], AT), /容量已满/)
  const pending = recordCharacterReceipt(compact, receipt('message', { status: 'pending', toolName: 'simSendMessage' }), AT)
  const sent = recordCharacterReceipt(pending, receipt('message', { toolName: 'simSendMessage' }), AT)
  assert.equal(sent.receipts[0].status, 'succeeded')
  const capacity = characterCapacity(compact)
  assert.equal(capacity.memories.limit, 128)
  assert.equal(capacity.retention.auditReceipts, 64)
  assert.equal(capacity.retention.terminalGoals, 16)
  assert.match(capacity.warnings.join(' '), /记忆已满/)
  assert.match(formatCharacterSection(compact), /普通行动仍可继续/)
})

test('超过旧256阈值的证据保护回执不丢失，并继续留有发送空间', () => {
  const state = empty()
  state.receipts = Array.from({ length: 2048 }, (_, index) => receipt(`source-${index}`))
  state.memories = Array.from({ length: 128 }, (_, index) => memory(`memory-${index}`,
    state.receipts.slice(index * 16, index * 16 + 16).map(item => `receipt:${item.id}`)))
  const compact = compactCharacterState(state, AT)
  assert.equal(compact.receipts.length, 2048)
  const pending = recordCharacterReceipt(compact, receipt('message', { status: 'pending', toolName: 'simSendMessage' }), AT)
  assert.equal(pending.receipts.length, 2049)
  assert.equal(characterCapacity(pending).receipts.limit, 4096)
})

test('损坏、悬空来源与越界容量必须拒绝，不能通过compact静默洗掉', () => {
  const bad = empty()
  bad.receipts = [receipt('dangling', { goalId: 'absent' })]
  const before = structuredClone(bad)
  assert.throws(() => compactCharacterState(bad, AT), /不存在的目标/)
  assert.deepEqual(bad, before)
  const over = empty()
  over.receipts = Array.from({ length: 4097 }, (_, index) => receipt(`too-many-${index}`))
  assert.throws(() => compactCharacterState(over, AT), /receipts/)
})
