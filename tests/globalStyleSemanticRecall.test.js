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
const personaA = { botId: 'bot-a', personaId: 'shiloh', personaVersion: 'v1', personaName: '希洛' }
const personaB = { botId: 'bot-b', personaId: 'saria', personaVersion: 'v1', personaName: '萨莉亚' }

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

test('identical feedback keeps distinct persona ownership through disk reload', async () => {
  const { cwd, manager, config } = createManager(async () => response([1, 0]))
  try {
    manager.observePersonaFeedback({ tags: ['too_customer'], botReply: '知道啦', source: personaA }, config, embeddingConfig)
    manager.observePersonaFeedback({ tags: ['too_customer'], botReply: '知道啦', source: personaB }, config, embeddingConfig)
    await waitForSemanticIdle(manager)
    const samples = manager.readMemory(config).semanticSamples
    assert.equal(samples.length, 2, '相同反馈不能因全局 hash 而丢掉另一人格来源')
    assert.equal(new Set(samples.map(item => item.hash)).size, 2)
    assert.deepEqual(samples.map(item => item.personaSource).sort((a, b) => a.botId.localeCompare(b.botId)), [personaA, personaB])
    manager.writeMemory(config)
    const loaded = new GlobalStyleLearnerManager({ cwd }).readMemory(config).semanticSamples
    assert.deepEqual(loaded.map(item => item.personaSource).sort((a, b) => a.botId.localeCompare(b.botId)), [personaA, personaB])
  } finally {
    manager.flushTimer && clearTimeout(manager.flushTimer)
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

function scopedVector(input) {
  if (input.includes('主人明确风格反馈')) return [1, 0]
  if (input.includes('排障求助')) return [0, 1]
  if (input.includes('轻松接梗')) return [-1, 0]
  return [1, 0]
}

async function seedScopedFeedback(manager, config) {
  manager.observeMessage({ group_id: 1, user_id: 2, message_id: 1, msg: '这个接口报错了怎么办？' }, config, embeddingConfig)
  manager.observeMessage({ group_id: 1, user_id: 3, message_id: 2, msg: '笑死，这下真绷不住了' }, config, embeddingConfig)
  manager.observePersonaFeedback({ tags: ['too_verbose'], botReply: '知道啦', source: personaA }, config, embeddingConfig)
  manager.observePersonaFeedback({ tags: ['good_tone'], botReply: '知道啦', source: personaB }, config, embeddingConfig)
  manager.observePersonaFeedback({ tags: ['too_hard'], botReply: '知道啦' }, config, embeddingConfig)
  await waitForSemanticIdle(manager)
}

test('feedback recall and its cache follow bot, persona and version while observations stay shared', async () => {
  let calls = 0
  const { cwd, manager, config } = createManager(async (_url, options) => {
    calls += 1
    return response(scopedVector(JSON.parse(options.body).input))
  })
  try {
    await seedScopedFeedback(manager, config)
    calls = 0
    const query = '今天聊点日常'
    const promptA = await manager.buildRelevantPrompt(config, { query, embeddingConfig, source: personaA })
    const promptB = await manager.buildRelevantPrompt(config, { query, embeddingConfig, source: personaB })
    assert.match(promptA, /短而完整/)
    assert.doesNotMatch(promptA, /自然、松弛/)
    assert.match(promptB, /自然、松弛/)
    assert.doesNotMatch(promptB, /短而完整/)
    assert.equal(calls, 2, '同场景不同人格各自检索，不命中对方缓存')
    assert.equal(await manager.buildRelevantPrompt(config, { query, embeddingConfig, source: personaA }), promptA)
    assert.equal(calls, 2, '同一人格可复用自己的结果')

    for (const source of [
      undefined,
      { ...personaA, botId: 'another-bot' },
      { ...personaA, personaId: 'another-persona' },
      { ...personaA, personaVersion: 'v2' }
    ]) assert.equal(await manager.buildRelevantPrompt(config, { query, embeddingConfig, source }), '', '不借用其他来源或 legacy 反馈')

    for (const source of [personaA, personaB, undefined]) {
      const shared = await manager.buildRelevantPrompt(config, { query: '这个报错怎么办', embeddingConfig, source })
      assert.match(shared, /排查问题时先说已确认的现象/, '公开观察策略可跨人格召回')
    }
  } finally {
    manager.flushTimer && clearTimeout(manager.flushTimer)
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('concurrent semantic requests coalesce only within the same persona source', async () => {
  let holdQueries = false
  const pending = []
  const { cwd, manager, config } = createManager(async (_url, options) => {
    const input = JSON.parse(options.body).input
    if (holdQueries) await new Promise(resolve => pending.push(resolve))
    return response(scopedVector(input))
  })
  try {
    await seedScopedFeedback(manager, config)
    holdQueries = true
    const query = '今天聊点日常'
    const firstA = manager.buildRelevantPrompt(config, { query, embeddingConfig, source: personaA })
    const secondA = manager.buildRelevantPrompt(config, { query, embeddingConfig, source: personaA })
    const firstB = manager.buildRelevantPrompt(config, { query, embeddingConfig, source: personaB })
    assert.equal(pending.length, 2, 'A 合并为一次，B 必须有独立在途请求')
    for (const resolve of pending.splice(0)) resolve()
    const [replyA, repeatedA, replyB] = await Promise.all([firstA, secondA, firstB])
    assert.equal(replyA, repeatedA)
    assert.match(replyA, /短而完整/)
    assert.match(replyB, /自然、松弛/)
    assert.doesNotMatch(replyB, /短而完整/)
  } finally {
    for (const resolve of pending.splice(0)) resolve()
    manager.flushTimer && clearTimeout(manager.flushTimer)
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('persona feedback cannot become an unscoped global prompt or summary rule', async () => {
  const { cwd, manager, config } = createManager(async () => response([1, 0]))
  try {
    for (let index = 0; index < 10; index += 1) {
      manager.observeMessage({ group_id: 1, user_id: index + 20, message_id: index + 1, msg: '哈哈，确实挺有意思' }, config, embeddingConfig)
    }
    await waitForSemanticIdle(manager)
    const beforePrompt = manager.buildPrompt(config)
    const beforeSummary = manager.buildSummaryMessages(manager.readMemory(config), manager.normalizeInputConfig(config))
    assert.ok(beforePrompt, '真实公共观察已达到全局提示样本量')
    manager.observePersonaFeedback({ tags: ['too_customer'], botReply: '这个特定人格的私有反馈样本', source: personaA }, config, embeddingConfig)
    await waitForSemanticIdle(manager)
    assert.equal(manager.buildPrompt(config), beforePrompt)
    assert.deepEqual(manager.buildSummaryMessages(manager.readMemory(config), manager.normalizeInputConfig(config)), beforeSummary)
    assert.doesNotMatch(JSON.stringify(beforeSummary), /特定人格的私有反馈样本/)
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
      manager.rememberBotReply({ group_id: 1, user_id: userId, msg: request, _personaSnapshot:personaA }, reply, config)
      manager.observeMessage({ group_id: 1, user_id: userId, message_id: userId, msg: '懂了', _personaSnapshot:personaA }, config, embeddingConfig)
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
      manager.rememberBotReply({ group_id: 1, user_id: userId, msg: request, _personaSnapshot:personaA }, reply, config)
      manager.observeMessage({ group_id: 1, user_id: userId, message_id: userId + 100, msg: '还是不行', _personaSnapshot:personaA }, config, embeddingConfig)
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

test('automatic feedback keeps persona ownership across switching, version changes and reload', async () => {
  const {cwd,manager,config}=createManager(async () => response([1,0]))
  const request='这个接口报错了怎么办？'
  const reply='先说结论：这个问题能排查，下一步看报错内容。'
  const event={group_id:1,user_id:11,msg:request,_personaSnapshot:personaA}
  try {
    assert.equal(manager.rememberBotReply({...event,_personaSnapshot:undefined},reply,config),false)
    assert.equal(manager.rememberBotReply(event,reply,config),true)
    manager.writeMemory(config)
    const reloaded=new GlobalStyleLearnerManager({cwd,fetchFn:async()=>response([1,0]),logger:{warn(){},info(){}}})
    try {
      for(const source of [personaB,{...personaA,personaVersion:'v2'},undefined]) {
        reloaded.observeMessage({...event,_personaSnapshot:source,msg:'懂了'},config,embeddingConfig)
        assert.equal(reloaded.readMemory(config).autoEvolution.candidates.length,0)
      }
      assert.equal(reloaded.readMemory(config).autoEvolution.recentReplies.length,1)
      reloaded.observeMessage({...event,msg:'懂了'},config,embeddingConfig)
      const candidate=reloaded.readMemory(config).autoEvolution.candidates[0]
      assert.deepEqual(candidate.personaSource,personaA)
      assert.equal(candidate.positive,1)
      await waitForSemanticIdle(reloaded)
      reloaded.readMemory(config).semanticSamples=[{
        hash:'owned-auto',embedding:[1,0],patterns:['只属于A的自动策略'],sceneKey:'排障求助',scene:'排障求助',
        source:'auto_evolution',personaSource:personaA,weight:2,feedbackTags:[],sequence:false,at:new Date().toISOString()
      },{
        hash:'owned-auto-second',embedding:[1,0],patterns:['只属于A的第二条策略'],sceneKey:'排障求助',scene:'排障求助',
        source:'auto_evolution',personaSource:personaA,weight:1,feedbackTags:[],sequence:false,at:new Date().toISOString()
      },{
        hash:'legacy-auto',embedding:[1,0],patterns:['无归属的旧策略'],sceneKey:'排障求助',scene:'排障求助',
        source:'auto_evolution',weight:2,feedbackTags:[],sequence:false,at:new Date().toISOString()
      }]
      const recallConfig={...config,semanticMinSamples:1,semanticMinMargin:0,semanticSampleLimit:10}
      assert.match(await reloaded.buildRelevantPrompt(recallConfig,{query:request,embeddingConfig,source:personaA}),/只属于A/)
      assert.doesNotMatch(await reloaded.buildRelevantPrompt(recallConfig,{query:request,embeddingConfig,source:personaB}),/只属于A|无归属的旧策略/)
      assert.doesNotMatch(await reloaded.buildRelevantPrompt(recallConfig,{query:request,embeddingConfig,source:{...personaA,personaVersion:'v2'}}),/只属于A|无归属的旧策略/)
    } finally {reloaded.flushTimer && clearTimeout(reloaded.flushTimer)}
  } finally {
    manager.flushTimer && clearTimeout(manager.flushTimer)
    fs.rmSync(cwd,{recursive:true,force:true})
  }
})
