import test from 'node:test'
import assert from 'node:assert/strict'
import { ExpressionLearner, normalizeExpressionData } from '../domains/memory/ExpressionLearner.js'
import { buildExpressionObservation, isLikelyEmojiPackSegment } from '../utils/expressionSequence.js'
import fs from 'node:fs'

function installRuntime(initial = {}) {
  const store = new Map(Object.entries(initial))
  const originalRedis = globalThis.redis
  const originalLogger = globalThis.logger
  globalThis.redis = {
    async get(key) { return store.get(key) ?? null },
    async set(key, value) { store.set(key, value) }
  }
  globalThis.logger = { info() {}, warn() {}, error() {} }
  return {
    store,
    restore() {
      globalThis.redis = originalRedis
      globalThis.logger = originalLogger
    }
  }
}

test('learns text emoji text as one same-speaker rhythm', async () => {
  const runtime = installRuntime()
  try {
    const learner = new ExpressionLearner({ aiLearningEnabled: false })
    await learner.updateGroupExpressions(1, '笑死，这也太巧了', { userId: 2, messageId: 10, at: 1000 })
    await learner.updateGroupExpressions(1, '', {
      userId: 2,
      messageId: 11,
      at: 2000,
      message: [{ type: 'image', sub_type: 1, summary: '[动画表情]' }]
    })
    await learner.updateGroupExpressions(1, '不过他确实挺累的', { userId: 2, messageId: 12, at: 3000 })
    const data = await learner.getGroupExpressions(1)
    assert.equal(data.messageCount, 3)
    assert.equal(data.rhythmPatterns.single, 3)
    assert.equal(data.rhythmPatterns.textEmoji, 1)
    assert.equal(data.rhythmPatterns.textEmojiText, 1)
    assert.ok(data.sequenceSamples.some(item => item.layout === 'textEmojiText' && /\[表情包\]/.test(item.sample)))
  } finally {
    runtime.restore()
  }
})

test('does not join different speakers or across an interruption', async () => {
  const runtime = installRuntime()
  try {
    const learner = new ExpressionLearner({ aiLearningEnabled: false })
    await learner.updateGroupExpressions(1, '甲第一句', { userId: 2, messageId: 1, at: 1000 })
    await learner.updateGroupExpressions(1, '乙插话', { userId: 3, messageId: 2, at: 2000 })
    await learner.updateGroupExpressions(1, '甲第二句', { userId: 2, messageId: 3, at: 3000 })
    await learner.flushGroupObservations('1')
    const data = await learner.getGroupExpressions(1)
    assert.equal(data.rhythmPatterns.twoBeat, 0)
    assert.equal(data.sequenceSamples.length, 0)
  } finally {
    runtime.restore()
  }
})

test('ordinary image is not treated as an emoji pack', () => {
  assert.equal(isLikelyEmojiPackSegment({ type: 'image', sub_type: 0, summary: '照片' }), false)
  assert.equal(isLikelyEmojiPackSegment({ type: 'image', sub_type: 1, summary: '[动画表情]' }), true)
  assert.equal(isLikelyEmojiPackSegment({ type: 'mface' }), true)
  assert.equal(buildExpressionObservation('', { message: [{ type: 'image', sub_type: 0 }] }), null)
})

test('normalizes old redis data without dropping learned expressions', () => {
  const data = normalizeExpressionData({ words: { 绷不住: 4 }, styleExpressions: [{ situation: '无语', expressions: ['绷不住'] }] })
  assert.equal(data.words.绷不住, 4)
  assert.equal(data.styleExpressions[0].expressions[0], '绷不住')
  assert.equal(data.rhythmPatterns.single, 0)
  assert.deepEqual(data.sequenceSamples, [])
})

test('keeps backward compatibility with old AI array output', async () => {
  const runtime = installRuntime()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return { choices: [{ message: { content: '[{"situation":"表示无语","expressions":["绷不住"]}]' } }] }
    }
  })
  try {
    const learner = new ExpressionLearner({ memoryAiConfig: { memoryAiUrl: 'http://example.test', memoryAiApikey: 'key' } })
    await learner.learnStyleWithAI(1, ['绷不住了'])
    const data = await learner.getGroupExpressions(1)
    assert.equal(data.styleExpressions[0].situation, '表示无语')
    assert.deepEqual(data.rhythmStyles, [])
  } finally {
    globalThis.fetch = originalFetch
    runtime.restore()
  }
})

test('persists rhythm rules from the new AI object output', async () => {
  const runtime = installRuntime()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        choices: [{ message: { content: JSON.stringify({
          expressions: [],
          rhythms: [{ situation: '轻松接梗', layout: 'emojiText', rule: '表情先接住情绪，再补一句独立信息' }]
        }) } }]
      }
    }
  })
  try {
    const learner = new ExpressionLearner({ memoryAiConfig: { memoryAiUrl: 'http://example.test', memoryAiApikey: 'key' } })
    await learner.learnStyleWithAI(1, ['[表情包] [下一条] 其实他说得也对'])
    const data = await learner.getGroupExpressions(1)
    assert.equal(data.rhythmStyles[0].layout, 'emojiText')
    assert.match(data.rhythmStyles[0].rule, /表情先接住情绪/)
  } finally {
    globalThis.fetch = originalFetch
    runtime.restore()
  }
})

test('injects learned rhythm while preserving default single-message boundary', () => {
  const learner = new ExpressionLearner({})
  const prompt = learner.formatExpressionPrompt({
    rhythmPatterns: { single: 20, textEmojiText: 3 },
    rhythmStyles: [{ situation: '轻松接梗', layout: 'textEmojiText', rule: '先短反应，表情承担情绪，最后补独立信息', count: 2 }]
  })
  assert.match(prompt, /表情包也是对话形态之一/)
  assert.match(prompt, /默认用一条完整自然的话/)
  assert.match(prompt, /不要因为学到多条样本就每轮拆分或刷屏/)
  assert.match(prompt, /轻松接梗/)
})

test('production observes expression order before the first asynchronous group check', () => {
  const source = fs.readFileSync(new URL('../apps/test.js', import.meta.url), 'utf8')
  const handlerStart = source.indexOf('async handleRandomReply(e)')
  const expressionCall = source.indexOf('this.expressionLearner.updateGroupExpressions', handlerStart)
  const firstAwait = source.indexOf('await this.isMutedInGroup(e)', handlerStart)
  assert.ok(handlerStart >= 0 && expressionCall > handlerStart)
  assert.ok(expressionCall < firstAwait, 'expression observation must preserve arrival order before the first await')
})
