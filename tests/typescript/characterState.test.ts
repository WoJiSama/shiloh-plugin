import assert from 'node:assert/strict'
import test from 'node:test'
import type { CharacterGoalInput, CharacterMemoryInput, CharacterReceipt, CharacterState } from '../../src/contracts/character.js'
import {
  CHARACTER_DEFAULT_EXPIRY_MS, CHARACTER_MAX_EXPIRY_MS, CHARACTER_MIN_WAKE_MS,
  addCharacterMemory, beginCharacterGoalAction, beginCharacterGoalAttempt, characterKey, classifyCharacterResult,
  createCharacterGoal, createEmptyCharacterState, deleteCharacterMemory, dueCharacterGoal,
  expireCharacterGoals, formatCharacterSection, recordCharacterReceipt, setCharacterDecision,
  setCharacterPaused, settleCharacter, transitionCharacterGoal, validateCharacterState,
} from '../../src/modules/simulation/domain/characterState.js'

const NOW = 1_790_000_000_000
const SCOPE = { botId: '99', personaId: 'shiloh', groupId: '10086' }
const visible = ['message:1', 'message:2']
const empty = () => createEmptyCharacterState(SCOPE)
const goalInput = (id = 'g1', overrides: Partial<CharacterGoalInput> = {}): CharacterGoalInput => ({
  id, title: '了解群友提过的独立游戏', motivation: '我喜欢这类游戏，想了解新作品', nextStep: '搜索公开介绍',
  completionCriteria: '取得可验证的公开介绍', stopConditions: ['群友表示不想继续', '来源不可用'],
  evidenceRefs: ['message:1'], ...overrides,
})
const memoryInput = (id = 'm1', overrides: Partial<CharacterMemoryInput> = {}): CharacterMemoryInput => ({
  id, kind: 'experience', content: '群友说自己喜欢独立游戏', epistemic: 'reported', evidenceRefs: ['message:1'], ...overrides,
})
const withGoal = (overrides: Partial<CharacterGoalInput> = {}) => createCharacterGoal(empty(), goalInput('g1', overrides), visible, NOW)
const startGoal = (state = withGoal(), at = NOW + CHARACTER_MIN_WAKE_MS) => beginCharacterGoalAttempt(state, 'g1', { id: 'r1', toolName: 'search' }, at)
function finishGoal(state: CharacterState, status: CharacterReceipt['status'], at = NOW + CHARACTER_MIN_WAKE_MS + 1): CharacterState {
  return recordCharacterReceipt(state, { ...state.receipts[0]!, status, summary: `工具结构化回执 ${status}`, at }, at)
}

test('角色状态按 bot/persona/group 隔离，缺失/坏数据不会变成默认值', () => {
  const state = empty()
  assert.deepEqual(validateCharacterState(JSON.parse(JSON.stringify(state)), SCOPE), state)
  assert.notEqual(characterKey(SCOPE), characterKey({ ...SCOPE, botId: '100' }))
  assert.notEqual(characterKey(SCOPE), characterKey({ ...SCOPE, personaId: 'other' }))
  assert.notEqual(characterKey(SCOPE), characterKey({ ...SCOPE, groupId: '20000' }))
  assert.notEqual(characterKey({ botId: 'a:b', personaId: 'c', groupId: 'd' }), characterKey({ botId: 'a', personaId: 'b:c', groupId: 'd' }))
  assert.throws(() => validateCharacterState({}), /schemaVersion/)
  assert.throws(() => validateCharacterState({ ...state, schemaVersion: 2 }), /schemaVersion/)
  assert.throws(() => validateCharacterState({ ...state, memories: null }), /memories/)
  assert.throws(() => validateCharacterState({ ...state, unexpected: 'must not be discarded' }), /未知字段/)
  assert.throws(() => validateCharacterState(state, { ...SCOPE, groupId: 'wrong' }), /scope/)
})

test('记忆只能引用本轮可见且真实存在的来源，reported 与 inferred 不混成观察事实', () => {
  const original = empty()
  const remembered = addCharacterMemory(original, memoryInput(), visible, NOW)
  assert.equal(original.memories.length, 0, '纯函数不修改调用者状态')
  assert.equal(remembered.memories[0]!.epistemic, 'reported')
  assert.throws(() => addCharacterMemory(original, memoryInput(), ['message:2'], NOW), /本轮可见/)
  assert.throws(() => addCharacterMemory(original, memoryInput('m1', { evidenceRefs: ['receipt:made-up'] }), ['receipt:made-up'], NOW), /不存在/)
  assert.throws(() => addCharacterMemory(original, memoryInput('m1', { evidenceRefs: ['memory:made-up'] }), ['memory:made-up'], NOW), /不存在/)
  assert.throws(() => addCharacterMemory(original, memoryInput('m1', { epistemic: 'observed' }), visible, NOW), /成功回执/)
  assert.throws(() => addCharacterMemory(original, memoryInput('m1', { kind: 'opinion', epistemic: 'reported' }), visible, NOW), /inferred/)
  const opinion = addCharacterMemory(remembered, memoryInput('m2', { kind: 'opinion', epistemic: 'inferred', content: '我觉得这群喜欢聊游戏', evidenceRefs: ['memory:m1'] }), ['memory:m1'], NOW + 1)
  assert.equal(opinion.memories[1]!.epistemic, 'inferred')
  assert.throws(() => addCharacterMemory(opinion, memoryInput('m1'), visible, NOW + 2), /已存在/)
})

test('observed 必须引用成功回执，失败和未知行动不能生成已观察的经历', () => {
  for (const status of ['failed', 'unknown', 'pending'] as const) {
    const state = status === 'pending' ? startGoal() : finishGoal(startGoal(), status)
    assert.throws(() => addCharacterMemory(state, memoryInput('observed', { epistemic: 'observed', evidenceRefs: ['receipt:r1'] }), ['receipt:r1'], NOW + CHARACTER_MIN_WAKE_MS + 2), /成功回执/)
  }
  const state = finishGoal(startGoal(), 'succeeded')
  const observed = addCharacterMemory(state, memoryInput('observed', { epistemic: 'observed', evidenceRefs: ['receipt:r1'], content: '搜索工具成功返回了公开介绍' }), ['receipt:r1'], NOW + CHARACTER_MIN_WAKE_MS + 2)
  assert.equal(observed.memories[0]!.epistemic, 'observed')
})

test('自主目标限制 3 个非终态、15 分钟最小间隔、有效期和 8 次尝试上限', () => {
  let state = withGoal()
  assert.equal(state.goals[0]!.kind, 'autonomous')
  assert.equal(state.goals[0]!.nextCheckAt, NOW + CHARACTER_MIN_WAKE_MS)
  assert.equal(state.goals[0]!.expiresAt, NOW + CHARACTER_DEFAULT_EXPIRY_MS)
  assert.equal(state.goals[0]!.maxAttempts, 3)
  assert.throws(() => createCharacterGoal(empty(), goalInput('g1', { nextCheckAt: NOW + 1 }), visible, NOW), /15 分钟/)
  assert.throws(() => createCharacterGoal(empty(), goalInput('g1', { expiresAt: NOW + CHARACTER_MAX_EXPIRY_MS + 1 }), visible, NOW), /越界/)
  assert.throws(() => createCharacterGoal(empty(), goalInput('g1', { maxAttempts: 9 }), visible, NOW), /maxAttempts/)
  assert.throws(() => createCharacterGoal(empty(), goalInput('g1', { maxAttempts: 0 }), visible, NOW), /maxAttempts/)
  for (const id of ['g2', 'g3']) state = createCharacterGoal(state, goalInput(id), visible, NOW)
  assert.throws(() => createCharacterGoal(state, goalInput('g4'), visible, NOW), /最多 3/)
  state = transitionCharacterGoal(state, 'g1', 'abandoned', { now: NOW, lastOutcome: '我决定不追这个方向' })
  assert.equal(createCharacterGoal(state, goalInput('g4'), visible, NOW).goals.length, 4)
})

test('行动尝试和 pending 同时登记；未到时间、重复执行和改写回执被拒绝', () => {
  const original = withGoal()
  assert.equal(dueCharacterGoal(original, NOW), undefined)
  assert.equal(dueCharacterGoal(original, NOW + CHARACTER_MIN_WAKE_MS)?.id, 'g1')
  assert.throws(() => startGoal(original, NOW), /未到期/)
  const pending = startGoal(original)
  assert.equal(original.goals[0]!.attempts, 0)
  assert.equal(pending.goals[0]!.attempts, 1)
  assert.equal(pending.goals[0]!.revision, 2)
  assert.equal(pending.receipts[0]!.status, 'pending')
  assert.equal(pending.receipts[0]!.goalRevision, 2)
  assert.equal(dueCharacterGoal(pending, NOW + CHARACTER_MIN_WAKE_MS * 2), undefined, '同一目标不能并行再次执行')
  assert.throws(() => beginCharacterGoalAttempt(pending, 'g1', { id: 'r2', toolName: 'search' }, NOW + CHARACTER_MIN_WAKE_MS * 2), /已在执行/)
  const succeeded = finishGoal(pending, 'succeeded')
  assert.throws(() => recordCharacterReceipt(succeeded, { ...succeeded.receipts[0]!, status: 'failed' }, NOW + CHARACTER_MIN_WAKE_MS + 2), /不可改写/)
  assert.throws(() => recordCharacterReceipt(pending, { ...pending.receipts[0]!, toolName: 'delete' }, NOW + CHARACTER_MIN_WAKE_MS + 2), /身份/)
  assert.throws(() => recordCharacterReceipt(empty(), { id: 'made-up', toolName: 'search', status: 'succeeded', summary: '假装执行过', at: NOW }, NOW), /pending/)
})

test('完成目标必须引用同目标成功回执，计划、未知回执和别的目标均不构成完成证据', () => {
  const started = startGoal()
  for (const status of ['failed', 'unknown'] as const) {
    const state = finishGoal(started, status)
    assert.throws(() => transitionCharacterGoal(state, 'g1', 'completed', { now: NOW + CHARACTER_MIN_WAKE_MS + 2, evidenceRefs: ['receipt:r1'] }), /成功回执/)
  }
  assert.throws(() => transitionCharacterGoal(started, 'g1', 'completed', { now: NOW + CHARACTER_MIN_WAKE_MS + 2 }), /成功回执/)
  let succeeded = finishGoal(started, 'succeeded')
  succeeded = createCharacterGoal(succeeded, goalInput('g2'), visible, NOW + CHARACTER_MIN_WAKE_MS + 2)
  assert.throws(() => transitionCharacterGoal(succeeded, 'g2', 'completed', { now: NOW + CHARACTER_MIN_WAKE_MS + 3, evidenceRefs: ['receipt:r1'] }), /成功回执/)
  const completed = transitionCharacterGoal(succeeded, 'g1', 'completed', { now: NOW + CHARACTER_MIN_WAKE_MS + 3, evidenceRefs: ['receipt:r1'], lastOutcome: '已取得工具回执' })
  assert.equal(completed.goals[0]!.status, 'completed')
  assert.throws(() => transitionCharacterGoal(completed, 'g1', 'active', { now: NOW + CHARACTER_MIN_WAKE_MS + 4 }), /终态/)
})

test('同一回合先搜索再发送只计一次尝试，暂停/取消/版本变化会使追加行动失效', () => {
  const searched = finishGoal(startGoal(), 'succeeded')
  const revision = searched.goals[0]!.revision
  const sending = beginCharacterGoalAction(searched, 'g1', { id: 'r2', toolName: 'send' }, NOW + CHARACTER_MIN_WAKE_MS + 2, revision)
  assert.equal(sending.goals[0]!.attempts, 1)
  assert.equal(sending.goals[0]!.revision, revision)
  assert.equal(sending.receipts[1]!.goalRevision, revision)
  assert.throws(() => beginCharacterGoalAction(sending, 'g1', { id: 'r3', toolName: 'send' }, NOW + CHARACTER_MIN_WAKE_MS + 3, revision), /已在执行/)
  const paused = setCharacterPaused(searched, true, NOW + CHARACTER_MIN_WAKE_MS + 2)
  assert.throws(() => beginCharacterGoalAction(paused, 'g1', { id: 'r2', toolName: 'send' }, NOW + CHARACTER_MIN_WAKE_MS + 3, revision), /不能执行/)
  const cancelled = transitionCharacterGoal(searched, 'g1', 'abandoned', { now: NOW + CHARACTER_MIN_WAKE_MS + 2 })
  assert.throws(() => beginCharacterGoalAction(cancelled, 'g1', { id: 'r2', toolName: 'send' }, NOW + CHARACTER_MIN_WAKE_MS + 3, revision), /版本/)
  const changed = transitionCharacterGoal(searched, 'g1', 'waiting', { now: NOW + CHARACTER_MIN_WAKE_MS + 2, nextStep: '改看另一个来源' })
  assert.throws(() => beginCharacterGoalAction(changed, 'g1', { id: 'r2', toolName: 'send' }, NOW + CHARACTER_MIN_WAKE_MS + 3, revision), /版本/)
})

test('取消后迟到成功回执只记录事实，不能自动复活目标', () => {
  const pending = startGoal()
  const cancelled = transitionCharacterGoal(pending, 'g1', 'abandoned', { now: NOW + CHARACTER_MIN_WAKE_MS + 1, lastOutcome: '管理员取消' })
  const late = finishGoal(cancelled, 'succeeded', NOW + CHARACTER_MIN_WAKE_MS + 2)
  assert.equal(late.goals[0]!.status, 'abandoned')
  assert.equal(late.receipts[0]!.status, 'succeeded')
  assert.equal(dueCharacterGoal(late, NOW + CHARACTER_MIN_WAKE_MS * 10), undefined)
  assert.throws(() => transitionCharacterGoal(late, 'g1', 'completed', { now: NOW + CHARACTER_MIN_WAKE_MS + 3, evidenceRefs: ['receipt:r1'] }), /终态/)
})

test('管理员暂停挡住目标执行，单目标暂停必须显式恢复并再次遵守间隔', () => {
  const active = withGoal()
  const paused = setCharacterPaused(active, true, NOW)
  assert.equal(dueCharacterGoal(paused, NOW + CHARACTER_MIN_WAKE_MS), undefined)
  assert.throws(() => startGoal(paused), /不能执行/)
  assert.throws(() => createCharacterGoal(paused, goalInput('g2'), visible, NOW), /暂停/)
  assert.equal(dueCharacterGoal(setCharacterPaused(paused, false, NOW + 1), NOW + CHARACTER_MIN_WAKE_MS)?.id, 'g1')
  const individual = transitionCharacterGoal(active, 'g1', 'paused', { now: NOW })
  assert.equal(dueCharacterGoal(individual, NOW + CHARACTER_MIN_WAKE_MS * 5), undefined)
  const resumed = transitionCharacterGoal(individual, 'g1', 'active', { now: NOW + 1, nextStep: '改查开发者官方介绍' })
  assert.equal(resumed.goals[0]!.nextStep, '改查开发者官方介绍')
  assert.equal(dueCharacterGoal(resumed, NOW + 1), undefined)
})

test('普通过期检查保留 pending；重启恢复才标 unknown，尝试耗尽或期限到达停止', () => {
  const pending = startGoal(withGoal({ maxAttempts: 1 }))
  const polled = expireCharacterGoals(pending, NOW + CHARACTER_MIN_WAKE_MS * 2)
  assert.equal(polled.receipts[0]!.status, 'pending')
  assert.equal(polled.goals[0]!.status, 'waiting')
  const recovered = settleCharacter(pending, NOW + CHARACTER_MIN_WAKE_MS * 2)
  assert.equal(recovered.receipts[0]!.status, 'unknown')
  assert.equal(recovered.goals[0]!.status, 'failed')
  assert.equal(pending.receipts[0]!.status, 'pending')
  const expired = expireCharacterGoals(withGoal(), NOW + CHARACTER_DEFAULT_EXPIRY_MS)
  assert.equal(expired.goals[0]!.status, 'failed')
  assert.equal(dueCharacterGoal(expired, NOW + CHARACTER_DEFAULT_EXPIRY_MS), undefined)
})

test('删除来源递归删除派生/修正记忆，并撤销依赖它的目标且不留悬空引用', () => {
  let state = addCharacterMemory(empty(), memoryInput(), visible, NOW)
  state = addCharacterMemory(state, memoryInput('m2', { evidenceRefs: ['memory:m1'], kind: 'opinion', epistemic: 'inferred' }), ['memory:m1'], NOW + 1)
  state = addCharacterMemory(state, memoryInput('m3', { supersedes: 'm2', evidenceRefs: ['message:2'] }), visible, NOW + 2)
  state = addCharacterMemory(state, memoryInput('m4', { content: '不相关的来源' }), visible, NOW + 3)
  state = createCharacterGoal(state, goalInput('g1', { evidenceRefs: ['memory:m3'] }), ['memory:m3'], NOW + 3)
  const deleted = deleteCharacterMemory(state, 'm1', NOW + 4)
  assert.deepEqual(deleted.memories.map(memory => memory.id), ['m4'])
  assert.equal(deleted.goals[0]!.status, 'abandoned')
  assert.deepEqual(deleted.goals[0]!.evidenceRefs, [])
  assert.match(deleted.goals[0]!.lastOutcome!, /来源记忆 m1 已删除/)
  assert.doesNotThrow(() => validateCharacterState(deleted))
  assert.equal(state.memories.length, 4)
})

test('已完成目标所依赖的记忆被删除后撤销完成状态，成功工具回执仍保留审计事实', () => {
  let state = addCharacterMemory(empty(), memoryInput(), visible, NOW)
  state = createCharacterGoal(state, goalInput('g1', { evidenceRefs: ['memory:m1'] }), ['memory:m1'], NOW)
  state = finishGoal(startGoal(state), 'succeeded')
  state = transitionCharacterGoal(state, 'g1', 'completed', { now: NOW + CHARACTER_MIN_WAKE_MS + 2, evidenceRefs: ['receipt:r1'] })
  const deleted = deleteCharacterMemory(state, 'm1', NOW + CHARACTER_MIN_WAKE_MS + 3)
  assert.equal(deleted.goals[0]!.status, 'abandoned')
  assert.deepEqual(deleted.goals[0]!.evidenceRefs, ['receipt:r1'])
  assert.equal(deleted.receipts[0]!.status, 'succeeded')
})

test('工具结果只接受明确的结构字段，不从自然语言或状态描述猜成功', () => {
  for (const result of ['操作成功', 'success', '{"status":"succeeded"}', '{"message":"已完成"}', '[]', 'null', '{"ok":"true"}', '```json\n{"ok":true}\n```']) assert.equal(classifyCharacterResult(result), 'unknown', result)
  assert.equal(classifyCharacterResult('{"ok":true}'), 'succeeded')
  assert.equal(classifyCharacterResult('{"success":true}'), 'succeeded')
  assert.equal(classifyCharacterResult('error: missing required argument'), 'failed', 'AbstractTool 明确的错误协议')
  for (const result of ['{"ok":false}', '{"success":false}', '{"error":"timeout"}', '{"failure":{"code":503}}', '{"ok":true,"error":"ambiguous"}']) assert.equal(classifyCharacterResult(result), 'failed', result)
})

test('角色提示显式保留认知状态、拒绝原因及未知回执，不把修正前记忆再喂给模型', () => {
  let state = addCharacterMemory(empty(), memoryInput('old', { content: '旧的兴趣判断' }), visible, NOW)
  state = addCharacterMemory(state, memoryInput('new', { supersedes: 'old', content: '修正后的兴趣判断', kind: 'opinion', epistemic: 'inferred' }), visible, NOW + 1)
  state = setCharacterDecision(state, { kind: 'unwilling', reason: '我不想参与这个话题', at: NOW + 1 })
  const section = formatCharacterSection(state)
  assert.match(section, /inferred/)
  assert.match(section, /unknown 不能当作成功/)
  assert.match(section, /unwilling/)
  assert.match(section, /修正后的兴趣判断/)
  assert.doesNotMatch(section, /旧的兴趣判断/)
})
