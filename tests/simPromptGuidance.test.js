import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSimulationProtocol, buildWakePrompt } from '../dist/backend/modules/simulation/domain/promptBuilder.js'
import { DEFAULT_SIM_WAKE_CONFIG } from '../dist/backend/modules/simulation/domain/simConfig.js'

const now = 1770000000000
const baseState = {
  seq: 1, unread: [], recent: [], lastReadThroughSeq: 0, modelSeenSeqs: [],
  wakeConfig: DEFAULT_SIM_WAKE_CONFIG, lastIncomingAt: now, lastAiSendAt: 0,
  lastWakeReason: null, lastWakeAt: now, pendingWakeReasons: [], wakeTimes: [], sendTimes: [],
  preSleepWait: null, agentHistory: [], budget: {}, nextProactiveCheckAt: 0, nextReplyCheckAt: 0,
  bootstrapSent: true, conversation: { activeUntil: 0, interlocutorIds: [] }
}
const wake = reason => buildWakePrompt({ state: baseState, reason, snapshotText: '', unreadTotal: 0, now, selfName: '希洛' })

test('仿真协议教模型先判定说话对象，判断不了默认旁听', () => {
  const protocol = buildSimulationProtocol('希洛')
  assert.match(protocol, /分清这条消息是对谁说的/)
  assert.match(protocol, /判断不了也当旁听/)
  assert.match(protocol, /宁可漏接不要抢话/)
  // 「话题相关」本身不再是开口理由
  assert.doesNotMatch(protocol, /和进行中话题或你的记忆自然相关/)
})

test('对话延续指引不再偏向「大概率是对我说的」，要求先判定、猜不中就安静', () => {
  const tail = wake({ kind: 'continuation', seq: 1, detail: '某人' })
  assert.match(tail, /对话延续/)
  assert.match(tail, /判断不了/)
  assert.doesNotMatch(tail, /大概率还是对你说的/)
})

test('关键词/随机/关注群友唤醒给出旁观型指引：话题沾边不等于有人找你', () => {
  for (const reason of [
    { kind: 'keyword', seq: 1, detail: '游戏' },
    { kind: 'probability', seq: 1 },
    { kind: 'speaker', seq: 1, detail: '某人' }
  ]) {
    const tail = wake(reason)
    assert.match(tail, /旁观型唤醒/, reason.kind)
    assert.match(tail, /默认旁听/, reason.kind)
    assert.match(tail, /"话题相关"本身不是插嘴的理由/, reason.kind)
  }
})
