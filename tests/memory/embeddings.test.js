// tests/memory/embeddings.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Embeddings, cosineSimilarity } from '../../domains/memory/engine/embeddings.js'
import { memStats } from '../../domains/memory/engine/stats.js'

const enabledConfig = {
  semanticRecallEnabled: true,
  embeddingAiConfig: { embeddingApiUrl: 'http://x/v1/embeddings', embeddingApiModel: 'm', embeddingApiKey: 'k' }
}

test('canUse is false when semanticRecallEnabled off', () => {
  const e = new Embeddings({ semanticRecallEnabled: false, embeddingAiConfig: { embeddingApiUrl: 'u', embeddingApiKey: 'k' } })
  assert.equal(e.canUse(), false)
})

test('canUse is false when url or key missing', () => {
  assert.equal(new Embeddings({ semanticRecallEnabled: true, embeddingAiConfig: { embeddingApiUrl: 'u' } }).canUse(), false)
  assert.equal(new Embeddings({ semanticRecallEnabled: true, embeddingAiConfig: { embeddingApiKey: 'k' } }).canUse(), false)
})

test('canUse is true when enabled with url and key', () => {
  assert.equal(new Embeddings(enabledConfig).canUse(), true)
})

test('embed returns null when not enabled (no network)', async () => {
  const e = new Embeddings({ semanticRecallEnabled: false })
  let called = false
  e._callEmbed = async () => { called = true; return [1, 2, 3] }
  const v = await e.embed('hello')
  assert.equal(v, null)
  assert.equal(called, false)
})

test('embed returns null for empty text', async () => {
  const e = new Embeddings(enabledConfig)
  let called = false
  e._callEmbed = async () => { called = true; return [1] }
  assert.equal(await e.embed('   '), null)
  assert.equal(called, false)
})

test('embed returns vector via overridden _callEmbed and second call hits cache', async () => {
  const e = new Embeddings(enabledConfig)
  let calls = 0
  e._callEmbed = async () => { calls += 1; return [0.1, 0.2, 0.3] }

  const first = await e.embed('上海')
  assert.deepEqual(first, [0.1, 0.2, 0.3])
  assert.equal(calls, 1)

  const second = await e.embed('上海')
  assert.deepEqual(second, [0.1, 0.2, 0.3])
  assert.equal(calls, 1, 'cache hit must not re-invoke _callEmbed')
})

test('embed returns null when _callEmbed throws', async () => {
  const e = new Embeddings(enabledConfig)
  e._callEmbed = async () => { throw new Error('boom') }
  assert.equal(await e.embed('x'), null)
})

test('embed returns null on empty/non-array vector', async () => {
  const e = new Embeddings(enabledConfig)
  e._callEmbed = async () => []
  assert.equal(await e.embed('a'), null)
  e._callEmbed = async () => null
  assert.equal(await e.embed('b'), null)
})

test('cache keyed by model+text: different model recomputes', async () => {
  const cfgA = { semanticRecallEnabled: true, embeddingAiConfig: { embeddingApiUrl: 'u', embeddingApiKey: 'k', embeddingApiModel: 'A' } }
  const e = new Embeddings(cfgA)
  let calls = 0
  e._callEmbed = async () => { calls += 1; return [1] }
  await e.embed('same')
  await e.embed('same')
  assert.equal(calls, 1)
  // 切换 model 后同文本应重算（缓存 key 含 model）。
  e.config.embeddingAiConfig.embeddingApiModel = 'B'
  await e.embed('same')
  assert.equal(calls, 2)
})

test('cosineSimilarity is mathematically correct', () => {
  // 正交 → 0
  assert.equal(cosineSimilarity([1, 0, 0], [0, 1, 0]), 0)
  // 同向 → 1
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2, 3]), 1)
  // 反向 → -1
  assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1)
  // 缩放不变 → 1
  assert.ok(Math.abs(cosineSimilarity([1, 1], [2, 2]) - 1) < 1e-12)
  // 已知值：[1,1]·[1,0] / (√2·1) = 1/√2
  assert.ok(Math.abs(cosineSimilarity([1, 1], [1, 0]) - 1 / Math.sqrt(2)) < 1e-12)
})

test('cosineSimilarity guards bad input', () => {
  assert.equal(cosineSimilarity([1, 2], [1, 2, 3]), 0)
  assert.equal(cosineSimilarity([], []), 0)
  assert.equal(cosineSimilarity(null, [1]), 0)
  assert.equal(cosineSimilarity([0, 0], [0, 0]), 0)
})

test('stats: real embed counts embed.miss + embed.ms, cache hit counts embed.hit', async () => {
  memStats.reset()
  const e = new Embeddings(enabledConfig)
  e._callEmbed = async () => [0.1, 0.2]

  await e.embed('北京') // 实调 → miss
  await e.embed('北京') // 缓存 → hit

  const { counters, timings } = memStats.snapshot()
  assert.equal(counters['embed.miss'], 1)
  assert.equal(counters['embed.hit'], 1)
  assert.equal(counters['embed.fail'], undefined)
  assert.equal(timings['embed.ms'].count, 1)
})

test('stats: _callEmbed throw counts embed.fail and logs only status/textLen', async () => {
  memStats.reset()
  const secret = '机密内容不应入日志'
  const warnings = []
  const prevLogger = globalThis.logger
  globalThis.logger = { warn: msg => warnings.push(String(msg)) }
  try {
    const e = new Embeddings(enabledConfig)
    e._callEmbed = async () => { throw new Error('embedding API 请求失败：503') }
    assert.equal(await e.embed(secret), null)
  } finally {
    globalThis.logger = prevLogger
  }

  const { counters } = memStats.snapshot()
  assert.equal(counters['embed.fail'], 1)
  assert.equal(counters['embed.miss'], undefined)
  assert.equal(warnings.length, 1)
  // 隐私：只记 status/textLen，绝不记文本全文。
  assert.ok(warnings[0].includes('503'))
  assert.ok(warnings[0].includes(`textLen=${secret.length}`))
  assert.ok(!warnings[0].includes(secret))
})

test('stats: empty/non-array vector counts neither miss nor hit', async () => {
  memStats.reset()
  const e = new Embeddings(enabledConfig)
  e._callEmbed = async () => []
  assert.equal(await e.embed('a'), null)

  const { counters } = memStats.snapshot()
  assert.equal(counters['embed.miss'], undefined)
  assert.equal(counters['embed.hit'], undefined)
  assert.equal(counters['embed.fail'], undefined)
})
