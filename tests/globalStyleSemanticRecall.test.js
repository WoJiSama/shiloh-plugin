import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GlobalStyleLearnerManager } from '../domains/memory/GlobalStyleLearnerManager.js'

const embeddingConfig = {
  embeddingApiUrl: 'https://embedding.invalid/v1/embeddings',
  embeddingApiKey: 'test-key',
  embeddingApiModel: 'test-embedding'
}

function response(vector) {
  return { ok: true, status: 200, json: async () => ({ data: [{ embedding: vector }] }) }
}

async function waitForSemanticIdle(manager) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!manager.semanticQueue.length && manager.semanticQueueRunning === 0) return
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  throw new Error('semantic queue did not become idle')
}

function createManager(fetchFn) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'style-semantic-'))
  const manager = new GlobalStyleLearnerManager({ cwd, fetchFn, logger: { warn() {}, info() {} } })
  const config = {
    baseDir: 'data/style',
    flushIntervalMs: 5000,
    minSamplesForPrompt: 1,
    semanticMinSamples: 2,
    semanticSampleLimit: 2,
    semanticPromptExamples: 1,
    semanticSimilarityThreshold: 0.7,
    semanticMinMargin: 0.08,
    semanticEmbedTimeoutMs: 500
  }
  return { cwd, manager, config }
}

test('semantic recall injects only anonymous relevant style patterns', async () => {
  const { cwd, manager, config } = createManager(async (_url, options) => {
    const input = JSON.parse(options.body).input
    assert.match(input, /^对话场景：/)
    assert.doesNotMatch(input, /笑死|接口报错|离谱/)
    return response(input.includes('轻松接梗') ? [1, 0] : [0, 1])
  })
  try {
    manager.observeMessage({ group_id: 1, user_id: 2, message_id: 1, msg: '笑死，这下真绷不住了' }, config, embeddingConfig)
    manager.observeMessage({ group_id: 1, user_id: 3, message_id: 2, msg: '这个接口报错了怎么办？' }, config, embeddingConfig)
    await waitForSemanticIdle(manager)

    const memory = manager.readMemory(config)
    assert.equal(memory.semanticSamples.length, 2)
    assert.ok(memory.semanticSamples.every(item => !('text' in item)))
    assert.ok(memory.semanticSamples.every(item => item.sceneKey && item.scene && !/笑死|接口报错/.test(item.scene)))

    const prompt = await manager.buildRelevantPrompt(config, { query: '这也太离谱了', embeddingConfig })
    assert.match(prompt, /先用一句自然短反应接住情绪/)
    assert.doesNotMatch(prompt, /笑死，这下真绷不住了/)
    assert.doesNotMatch(prompt, /接口报错/)
  } finally {
    manager.flushTimer && clearTimeout(manager.flushTimer)
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('semantic recall filters low similarity and coalesces duplicate background embeddings', async () => {
  let calls = 0
  const { cwd, manager, config } = createManager(async (_url, options) => {
    calls += 1
    const input = JSON.parse(options.body).input
    return response(input.includes('排障求助') ? [0, 1] : [1, 0])
  })
  try {
    const sample = {
      hash: manager.hashText('scene:轻松接梗'),
      text: '笑死，这下真绷不住了',
      patterns: ['先用一句自然短反应接住情绪，再进入实际回应；保持友好，不阴阳怪气。'],
      sequence: false
    }
    manager.enqueueSemanticSample(sample, config, embeddingConfig)
    manager.enqueueSemanticSample(sample, config, embeddingConfig)
    manager.observeMessage({ group_id: 1, user_id: 3, message_id: 3, msg: '这个技术问题为什么报错？' }, config, embeddingConfig)
    await waitForSemanticIdle(manager)
    assert.equal(manager.readMemory(config).semanticSamples.length, 2)
    assert.equal(calls, 2)

    const prompt = await manager.buildRelevantPrompt(config, { query: '技术问题又报错了', embeddingConfig })
    assert.match(prompt, /排查问题时先说已确认的现象/)
    assert.doesNotMatch(prompt, /先用一句自然短反应接住情绪/)
  } finally {
    manager.flushTimer && clearTimeout(manager.flushTimer)
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('semantic query failure returns no extra prompt and preserves existing global prompt', async () => {
  let calls = 0
  const { cwd, manager, config } = createManager(async (_url, _options) => {
    calls += 1
    if (calls >= 3) throw new Error('upstream unavailable')
    return response(calls === 1 ? [1, 0] : [0, 1])
  })
  try {
    manager.observeMessage({ group_id: 1, user_id: 2, message_id: 1, msg: '笑死，这下真绷不住了' }, config, embeddingConfig)
    manager.observeMessage({ group_id: 1, user_id: 3, message_id: 2, msg: '这个技术问题为什么报错？' }, config, embeddingConfig)
    await waitForSemanticIdle(manager)

    const memory = manager.readMemory(config)
    memory.totalSamples = 10
    memory.essence.short_first = 1
    const basePrompt = manager.buildPrompt(config)
    const semanticPrompt = await manager.buildRelevantPrompt(config, { query: '查询失败怎么办', embeddingConfig })
    assert.match(basePrompt, /希洛全局表达学习/)
    assert.equal(semanticPrompt, '')
  } finally {
    manager.flushTimer && clearTimeout(manager.flushTimer)
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('first observed message backfills existing sanitized style samples in the background', async () => {
  const { cwd, manager, config } = createManager(async (_url, options) => {
    const input = JSON.parse(options.body).input
    return response(input.includes('排障求助') ? [0, 1] : [1, 0])
  })
  try {
    const memory = manager.readMemory(config)
    memory.samplePool = [
      { text: '笑死，这下真绷不住了', sequence: false },
      { text: '这个接口报错了怎么办？', sequence: false }
    ]
    manager.observeMessage({ group_id: 1, user_id: 2, message_id: 1, msg: '很抱歉，我不能帮你' }, config, embeddingConfig)
    await waitForSemanticIdle(manager)
    const stored = manager.readMemory(config).semanticSamples
    assert.equal(stored.length, 2)
    assert.ok(stored.some(item => item.patterns.some(pattern => pattern.includes('接住情绪'))))
    assert.ok(stored.some(item => item.patterns.some(pattern => pattern.includes('排查问题'))))
    assert.ok(manager.semanticBackfillScheduled)
  } finally {
    manager.flushTimer && clearTimeout(manager.flushTimer)
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('ambiguous scene retrieval stays silent and records safe metrics', async () => {
  const { cwd, manager, config } = createManager(async () => response([1, 0]))
  try {
    manager.observeMessage({ group_id: 1, user_id: 2, message_id: 1, msg: '笑死，这下真绷不住了' }, config, embeddingConfig)
    manager.observeMessage({ group_id: 1, user_id: 3, message_id: 2, msg: '这个接口报错了怎么办？' }, config, embeddingConfig)
    await waitForSemanticIdle(manager)

    const prompt = await manager.buildRelevantPrompt(config, { query: '这也太离谱了', embeddingConfig })
    const stats = manager.readMemory(config).semanticStats
    assert.equal(prompt, '')
    assert.equal(stats.last.outcome, 'ambiguous')
    assert.equal(stats.last.scene, '轻松接梗')
    assert.doesNotMatch(JSON.stringify(stats), /笑死|接口报错|离谱/)
  } finally {
    manager.flushTimer && clearTimeout(manager.flushTimer)
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('explicit master feedback creates a weighted anonymous scene strategy', async () => {
  const { cwd, manager, config } = createManager(async (_url, options) => {
    const input = JSON.parse(options.body).input
    return response(input.includes('主人反馈') ? [1, 0] : [0, 1])
  })
  try {
    manager.observeMessage({ group_id: 1, user_id: 2, message_id: 1, msg: '这个接口报错了怎么办？' }, config, embeddingConfig)
    manager.observeMessage({ group_id: 1, user_id: 3, message_id: 2, msg: '笑死，这下真绷不住了' }, config, embeddingConfig)
    manager.observePersonaFeedback({ tags: ['too_customer'], botReply: '很抱歉，我不能帮你。' }, config, embeddingConfig)
    await waitForSemanticIdle(manager)

    const feedbackSample = manager.readMemory(config).semanticSamples.find(item => item.source === 'master_feedback')
    assert.equal(feedbackSample?.weight, 4)
    assert.deepEqual(feedbackSample?.feedbackTags, ['too_customer'])
    assert.match(feedbackSample?.patterns?.[0] || '', /客服腔/)
    assert.doesNotMatch(JSON.stringify(feedbackSample), /很抱歉|不能帮你/)
  } finally {
    manager.flushTimer && clearTimeout(manager.flushTimer)
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('failed legacy backfill records retry state without blocking message handling', async () => {
  const { cwd, manager, config } = createManager(async () => {
    throw new Error('temporary embedding outage')
  })
  try {
    const memory = manager.readMemory(config)
    memory.samplePool = [{ text: '这个接口报错了怎么办？', sequence: false }]
    manager.observeMessage({ group_id: 1, user_id: 2, message_id: 1, msg: '很抱歉，我不能帮你' }, config, embeddingConfig)
    await waitForSemanticIdle(manager)
    assert.equal(manager.readMemory(config).semanticBackfill.retries, 1)
    assert.equal(manager.readMemory(config).semanticBackfill.cursor, 0)
    assert.equal(manager.readMemory(config).semanticBackfill.completed, false)
    assert.ok(manager.semanticBackfillTimer)
  } finally {
    manager.flushTimer && clearTimeout(manager.flushTimer)
    manager.semanticBackfillTimer && clearTimeout(manager.semanticBackfillTimer)
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('anonymous multi-user outcomes promote and later demote an autonomous style strategy', async () => {
  const { cwd, manager, config } = createManager(async () => response([1, 0]))
  Object.assign(config, {
    autoEvolutionMinEvidence: 3,
    autoEvolutionMinUniqueUsers: 2,
    autoEvolutionMinPositiveRatio: 0.75,
    autoEvolutionDemoteRatio: 0.5,
    autoEvolutionShadowEvidence: 1
  })
  const request = '这个接口报错了怎么办？'
  const reply = '先说结论：这个问题能排查，下一步看报错内容。'
  try {
    for (const userId of [11, 12, 11, 12]) {
      manager.rememberBotReply({ group_id: 1, user_id: userId, msg: request }, reply, config)
      manager.observeMessage({ group_id: 1, user_id: userId, message_id: userId, msg: '懂了' }, config, embeddingConfig)
    }
    await waitForSemanticIdle(manager)
    let state = manager.readMemory(config).autoEvolution
    const candidate = state.candidates.find(item => item.sceneKey === '排障求助')
    assert.equal(candidate?.status, 'active')
    assert.equal(candidate?.positive, 4)
    assert.equal(candidate?.speakers.length, 2)
    assert.equal(state.promoted, 1)
    assert.ok(manager.readMemory(config).semanticSamples.some(item => item.source === 'auto_evolution'))
    assert.doesNotMatch(JSON.stringify(state), /这个接口报错了怎么办|懂了/)

    for (const userId of [11, 12, 11, 12, 11]) {
      manager.rememberBotReply({ group_id: 1, user_id: userId, msg: request }, reply, config)
      manager.observeMessage({ group_id: 1, user_id: userId, message_id: userId + 100, msg: '还是不行' }, config, embeddingConfig)
    }
    state = manager.readMemory(config).autoEvolution
    assert.equal(candidate?.status, 'demoted')
    assert.equal(state.demoted, 1)
    assert.ok(!manager.readMemory(config).semanticSamples.some(item => item.source === 'auto_evolution'))
  } finally {
    manager.flushTimer && clearTimeout(manager.flushTimer)
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})
