// tests/memory/manager.test.js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFakeRedis } from './helpers/fakeRedis.js'
import { MemoryManager } from '../../domains/memory/MemoryManager.js'
import { factShortId } from '../../domains/memory/engine/entityModel.js'

function mgr(redis) {
  const m = new MemoryManager({ enabled: true }, { redis })
  return m
}

test('applyOps writes alias and entity, retrievable via prompts', async () => {
  const redis = createFakeRedis()
  const m = mgr(redis)
  await m.applyOps('981339693', [
    { stream: 'alias', qq: '3188163302', text: 'maela', authority: 'teaching', confidence: 0.9, by: ['925640859'], at: 1 },
    { stream: 'entityFact', qq: '925640859', authority: 'self', fact: { text: '在上海', tags: [], refs: [], authority: 'self', confidence: 0.8, at: 1, superseded: false } }
  ])
  const alias = await m.getGroupAliasPrompt('981339693', 'maela 是谁')
  assert.ok(alias.includes('maela'))
  assert.ok(alias.includes('3188163302'))
  const userPrompt = await m.getMemoryPromptForUser('981339693', '925640859', '')
  assert.ok(userPrompt.includes('在上海'))
})

test('conflicting alias resolves by authority across applyOps calls', async () => {
  const m = mgr(createFakeRedis())
  await m.applyOps('g', [{ stream: 'alias', qq: '3188163302', text: '希洛', authority: 'mention', confidence: 0.8, by: ['x'], at: 1 }])
  await m.applyOps('g', [{ stream: 'alias', qq: '925640859', text: '希洛', authority: 'self', confidence: 0.9, by: ['925640859'], at: 2 }])
  const doc = await m.store.getAlias('g')
  assert.equal(doc['希洛'].qq, '925640859')
})

test('disabled group blocks writes and prompts', async () => {
  const m = mgr(createFakeRedis())
  await m.adminSetGroupMemoryEnabled({ groupId: 'g', enabled: false })
  await m.applyOps('g', [{ stream: 'groupFact', authority: 'mention', fact: { text: 'x', tags: [], refs: [], authority: 'mention', confidence: 0.8, at: 1, superseded: false } }])
  assert.equal(await m.getGroupMemoryPrompt('g', ''), '')
})

test('adminClearMemories wipes the group', async () => {
  const m = mgr(createFakeRedis())
  await m.applyOps('g', [{ stream: 'groupFact', authority: 'mention', fact: { text: 'x', tags: [], refs: [], authority: 'mention', confidence: 0.8, at: 1, superseded: false } }])
  const r = await m.adminClearMemories({ scope: 'group', groupId: 'g' })
  assert.ok(r.cleared >= 1)
  assert.equal(await m.getGroupMemoryPrompt('g', ''), '')
})

// Regression: extract paths must not deadlock (no nested same-key enqueue).
// { timeout } makes a regression fail fast instead of hanging.
// 用户抽取带防抖+批量缓冲:maxBatch=1 时首条即 flush。
test('extractAndSaveMemories flushes on batch full and persists', { timeout: 5000 }, async () => {
  const m = mgr(createFakeRedis())
  m.config.userExtractMaxBatchMessages = 1
  m.extractor.extract = async () => ([
    { stream: 'alias', qq: '925640859', text: '咖啡大人', authority: 'self', confidence: 0.9, by: ['925640859'], at: 1 }
  ])
  const result = await m.extractAndSaveMemories('981339693', '925640859', '以后叫我咖啡大人')
  assert.equal(result.written, 1)
  const alias = await m.getGroupAliasPrompt('981339693', '咖啡大人是谁')
  assert.ok(alias.includes('咖啡大人'))
})

// 防抖:未达 batch 上限时只缓冲不抽取;攒满后一次性把全部消息交给 extractor。
test('extractAndSaveMemories buffers until batch full, then extracts the whole batch', { timeout: 5000 }, async () => {
  const m = mgr(createFakeRedis())
  m.config.userExtractMaxBatchMessages = 3
  m.config.userExtractDebounceSeconds = 90 // 不靠定时器,靠 batch 满触发
  let seenBatch = 0
  m.extractor.extract = async ({ messages }) => { seenBatch = messages.length; return [] }

  const r1 = m.extractAndSaveMemories('g', '111', '消息一')
  assert.equal(r1.queued, true)
  assert.equal(r1.buffered, 1)
  assert.equal(seenBatch, 0) // 还没抽取
  m.extractAndSaveMemories('g', '111', '消息二')
  const r3 = await m.extractAndSaveMemories('g', '111', '消息三') // 第3条达上限 → flush
  assert.equal(seenBatch, 3) // 三条一起抽取
  assert.ok(r3) // flush 返回 applyOps 结果
})

// 群抽取最小间隔节流:间隔内的第二次调用被跳过。
test('extractAndSaveGroupMemories persists then throttles within min interval', { timeout: 5000 }, async () => {
  const m = mgr(createFakeRedis())
  m.config.groupExtractMinIntervalMinutes = 10
  m.extractor.extract = async () => ([
    { stream: 'groupFact', authority: 'mention', fact: { text: '群里不要刷屏', tags: ['群规'], refs: [], authority: 'mention', confidence: 0.8, at: 1, superseded: false } }
  ])
  const first = await m.extractAndSaveGroupMemories('981339693', [{ content: '大家注意群里不要刷屏好吗' }])
  assert.equal(first.written, 1)
  assert.ok((await m.getGroupMemoryPrompt('981339693', '')).includes('群里不要刷屏'))

  const second = await m.extractAndSaveGroupMemories('981339693', [{ content: '再说一遍不要刷屏' }])
  assert.equal(second.queued, false)
  assert.equal(second.reason, 'throttled') // 10 分钟内不再重复抽取
})

// ---- getContextualMemoryPrompt 端到端：说话人 + 被提及 + refs + pending ----
test('getContextualMemoryPrompt assembles speaker, mentioned, refs and pending sections', async () => {
  const m = mgr(createFakeRedis())
  const now = 1_000_000_000_000
  await m.applyOps('g', [
    // 说话人事实
    { stream: 'entityFact', qq: '111', authority: 'self', fact: { text: '在上海做后端', authority: 'self', confidence: 0.9, at: now } },
    // 被提及人的别名 + 事实
    { stream: 'alias', qq: '222', text: '希洛', authority: 'teaching', confidence: 0.95, by: ['111'], at: now },
    { stream: 'entityFact', qq: '222', authority: 'teaching', fact: { text: '喜欢猫', authority: 'teaching', confidence: 0.8, at: now } },
    // 第三方实体里 refs 命中说话人的 fact（关联信息）
    { stream: 'entityFact', qq: '333', authority: 'mention', fact: { text: '和 111 是同事', refs: ['111'], authority: 'mention', confidence: 0.7, at: now } },
    // 说话人时间相关事实：未来 2 天内（落在回扣窗口）
    { stream: 'entityFact', qq: '111', authority: 'self', fact: { text: '下周有考试', authority: 'self', confidence: 0.9, at: now, eventAt: now + 2 * 86400000 } }
  ])

  const prompt = await m.getContextualMemoryPrompt('g', '111', '希洛最近怎么样', now)

  assert.ok(prompt.includes('【长期记忆】'))
  assert.ok(prompt.includes('在上海做后端'))
  assert.ok(prompt.includes('【相关的人】'))
  assert.ok(prompt.includes('喜欢猫'))
  assert.ok(prompt.includes('【关联信息】'))
  assert.ok(prompt.includes('和 111 是同事'))
  assert.ok(prompt.includes('【可自然提起】'))
  assert.ok(prompt.includes('下周有考试'))
})

test('getContextualMemoryPrompt returns empty for disabled group', async () => {
  const m = mgr(createFakeRedis())
  await m.applyOps('g', [{ stream: 'entityFact', qq: '111', authority: 'self', fact: { text: '在上海', authority: 'self', confidence: 0.9, at: 1 } }])
  await m.adminSetGroupMemoryEnabled({ groupId: 'g', enabled: false })
  assert.equal(await m.getContextualMemoryPrompt('g', '111', 'hi', 1), '')
})

// ---- 反思触发不死锁：阈值越过后 fire-and-forget enqueue，覆写 reflector._callChat ----
test('applyOps triggers entity reflection without deadlocking', { timeout: 5000 }, async () => {
  const m = mgr(createFakeRedis())
  m.config.reflectEntityThreshold = 2
  // 让 reflector 可用并覆写 _callChat 返回固定合并结果。
  m.reflector.config = { ...m.config, memoryAiConfig: { memoryAiUrl: 'u', memoryAiApikey: 'k' } }
  let reflectCalls = 0
  m.reflector._callChat = async () => { reflectCalls += 1; return '[{"text":"巩固后的事实","sources":[1,2,3]}]' }

  await m.applyOps('g', [
    { stream: 'entityFact', qq: '111', authority: 'self', fact: { text: '事实A', authority: 'self', confidence: 0.8, at: 1 } },
    { stream: 'entityFact', qq: '111', authority: 'self', fact: { text: '事实B', authority: 'self', confidence: 0.8, at: 2 } },
    { stream: 'entityFact', qq: '111', authority: 'self', fact: { text: '事实C', authority: 'self', confidence: 0.8, at: 3 } }
  ])

  // 反思是独立 enqueue 的 fire-and-forget；用同 key 的下一个 enqueue 等它跑完（若死锁则 timeout 失败）。
  await m.enqueueGroup('g', async () => {})

  assert.equal(reflectCalls, 1)
  const entities = await m.store.getEntities('g')
  assert.ok(entities['111'].facts.some(f => f.origin === 'reflection' && f.text === '巩固后的事实'))
})

test('applyOps skips reflection when reflector unconfigured', { timeout: 5000 }, async () => {
  const m = mgr(createFakeRedis())
  m.config.reflectEntityThreshold = 1
  let reflectCalls = 0
  m.reflector._callChat = async () => { reflectCalls += 1; return '[]' }

  await m.applyOps('g', [
    { stream: 'entityFact', qq: '111', authority: 'self', fact: { text: 'x', authority: 'self', confidence: 0.8, at: 1 } },
    { stream: 'entityFact', qq: '111', authority: 'self', fact: { text: 'y', authority: 'self', confidence: 0.8, at: 2 } }
  ])
  await m.enqueueGroup('g', async () => {})
  assert.equal(reflectCalls, 0) // reflector.canUse() 为假 → 不触发
})

// ---- 语义去重：注入假 embeddings，cosine≥阈值视为同一事实，按权威 resolveClaim ----
test('semantic dedup merges near-duplicate entity facts via injected embeddings', async () => {
  const m = mgr(createFakeRedis())
  m.config.semanticRecallEnabled = true
  m.config.semanticDupCosine = 0.88
  m.embeddings.config = m.config
  // 强制 canUse()，并按文本映射到固定向量：相近文本 → 近乎平行向量。
  m.embeddings.canUse = () => true
  m.embeddings.embed = async (text) => {
    if (String(text).includes('上海')) return [1, 0]      // 两条"上海"事实向量相同 → cosine=1
    return [0, 1]
  }

  await m.applyOps('g', [
    { stream: 'entityFact', qq: '111', authority: 'mention', fact: { text: '他在上海', authority: 'mention', confidence: 0.6, at: 1 } }
  ])
  await m.applyOps('g', [
    { stream: 'entityFact', qq: '111', authority: 'self', fact: { text: '在上海工作', authority: 'self', confidence: 0.9, at: 2 } }
  ])

  const entities = await m.store.getEntities('g')
  const facts = entities['111'].facts
  // 语义去重：两条"上海"事实合并为一条，self 权威胜出。
  assert.equal(facts.length, 1)
  assert.equal(facts[0].text, '在上海工作')
  assert.equal(facts[0].authority, 'self')
})

test('semantic dedup keeps distinct facts when below cosine threshold', async () => {
  const m = mgr(createFakeRedis())
  m.config.semanticRecallEnabled = true
  m.config.semanticDupCosine = 0.88
  m.embeddings.config = m.config
  m.embeddings.canUse = () => true
  m.embeddings.embed = async (text) => (String(text).includes('上海') ? [1, 0] : [0, 1])

  await m.applyOps('g', [
    { stream: 'entityFact', qq: '111', authority: 'self', fact: { text: '在上海', authority: 'self', confidence: 0.9, at: 1 } }
  ])
  await m.applyOps('g', [
    { stream: 'entityFact', qq: '111', authority: 'self', fact: { text: '喜欢咖啡', authority: 'self', confidence: 0.9, at: 2 } }
  ])

  const entities = await m.store.getEntities('g')
  assert.equal(entities['111'].facts.length, 2) // 正交向量 cosine=0 < 0.88 → 不合并
})

// ---- §0.2 per-user opt-out（写入侧 + 读取侧） ----

// 写入侧：opt-out 用户的 extractAndSaveMemories 返回 opted-out 且不缓冲不抽取。
test('extractAndSaveMemories returns opted-out and writes nothing for opted-out user', { timeout: 5000 }, async () => {
  const m = mgr(createFakeRedis())
  m.config.userExtractMaxBatchMessages = 1
  let extractCalls = 0
  m.extractor.extract = async () => { extractCalls += 1; return [] }

  // 把用户加入 optedOut（同步刷新缓存）。
  const set = await m.adminSetUserMemoryEnabled({ groupId: 'g', userId: '111', enabled: false })
  assert.equal(set.enabled, false)

  const r = m.extractAndSaveMemories('g', '111', '我在上海工作')
  assert.equal(r.queued, false)
  assert.equal(r.reason, 'opted-out')
  assert.equal(extractCalls, 0) // 完全不抽取
  assert.equal(m.userBuffers.has('g:111'), false) // 也不缓冲
})

// opt-out 后再 enable 恢复正常抽取。
test('adminSetUserMemoryEnabled toggles opt-out and re-enables extraction', { timeout: 5000 }, async () => {
  const m = mgr(createFakeRedis())
  m.config.userExtractMaxBatchMessages = 1
  m.extractor.extract = async () => ([
    { stream: 'entityFact', qq: '111', authority: 'self', fact: { text: '在上海', authority: 'self', confidence: 0.9, at: 1 } }
  ])

  await m.adminSetUserMemoryEnabled({ groupId: 'g', userId: '111', enabled: false })
  assert.equal(m.extractAndSaveMemories('g', '111', 'x').reason, 'opted-out')

  const on = await m.adminSetUserMemoryEnabled({ groupId: 'g', userId: '111', enabled: true })
  assert.equal(on.enabled, true)
  const meta = await m.store.getMeta('g')
  assert.deepEqual(meta.optedOut, [])

  const r = await m.extractAndSaveMemories('g', '111', '我在上海')
  assert.equal(r.written, 1)
})

// 读取侧：opt-out 用户作为说话人时，不注入其自身实体（speakerEntity 视为 null）；被提及人不受影响。
test('getContextualMemoryPrompt omits opted-out speaker self memory but keeps mentioned others', async () => {
  const m = mgr(createFakeRedis())
  const now = 1_000_000_000_000
  await m.applyOps('g', [
    { stream: 'entityFact', qq: '111', authority: 'self', fact: { text: '我在上海做后端', authority: 'self', confidence: 0.9, at: now } },
    { stream: 'alias', qq: '222', text: '希洛', authority: 'teaching', confidence: 0.95, by: ['111'], at: now },
    { stream: 'entityFact', qq: '222', authority: 'teaching', fact: { text: '喜欢猫', authority: 'teaching', confidence: 0.8, at: now } }
  ])
  await m.adminSetUserMemoryEnabled({ groupId: 'g', userId: '111', enabled: false })

  const prompt = await m.getContextualMemoryPrompt('g', '111', '希洛最近怎么样', now)
  assert.ok(!prompt.includes('我在上海做后端')) // 说话人自身记忆被屏蔽
  assert.ok(prompt.includes('喜欢猫'))          // 被提及人不受影响
})

// ---- §P0-3 adminListMemories query 真过滤 ----
test('adminListMemories filters user facts by query on text or tags', async () => {
  const m = mgr(createFakeRedis())
  await m.applyOps('g', [
    { stream: 'entityFact', qq: '111', authority: 'self', fact: { text: '在上海工作', tags: ['职业'], authority: 'self', confidence: 0.9, at: 1 } },
    { stream: 'entityFact', qq: '111', authority: 'self', fact: { text: '喜欢喝咖啡', tags: ['偏好'], authority: 'self', confidence: 0.9, at: 2 } }
  ])

  const byText = await m.adminListMemories({ scope: 'user', groupId: 'g', userId: '111', query: '上海' })
  assert.equal(byText.facts.length, 1)
  assert.equal(byText.facts[0].text, '在上海工作')

  const byTag = await m.adminListMemories({ scope: 'user', groupId: 'g', userId: '111', query: '偏好' })
  assert.equal(byTag.facts.length, 1)
  assert.equal(byTag.facts[0].text, '喜欢喝咖啡')

  const all = await m.adminListMemories({ scope: 'user', groupId: 'g', userId: '111', query: '' })
  assert.equal(all.facts.length, 2) // 空 query → 不过滤
})

test('adminListMemories filters group facts by query', async () => {
  const m = mgr(createFakeRedis())
  await m.applyOps('g', [
    { stream: 'groupFact', authority: 'mention', fact: { text: '群里不要刷屏', tags: ['群规'], authority: 'mention', confidence: 0.8, at: 1 } },
    { stream: 'groupFact', authority: 'mention', fact: { text: '周末有线下活动', tags: ['活动'], authority: 'mention', confidence: 0.8, at: 2 } }
  ])
  const r = await m.adminListMemories({ scope: 'group', groupId: 'g', query: '刷屏' })
  assert.equal(r.facts.length, 1)
  assert.equal(r.facts[0].text, '群里不要刷屏')
})

// ---- §P0-3 adminDeleteMemory my:<shortid> 软删自己事实 ----
test('adminDeleteMemory soft-deletes own entity fact via my:<shortid>', async () => {
  const m = mgr(createFakeRedis())
  await m.applyOps('g', [
    { stream: 'entityFact', qq: '111', authority: 'self', fact: { text: '在上海工作', authority: 'self', confidence: 0.9, at: 1 } }
  ])
  const list = await m.adminListMemories({ scope: 'user', groupId: 'g', userId: '111' })
  const shortId = factShortId(list.facts[0].text)

  const del = await m.adminDeleteMemory({ groupId: 'g', userId: '111', id: `my:${shortId}` })
  assert.equal(del.deleted, true)
  assert.equal(del.scope, 'my')

  // 软删：fact 仍在但 superseded，列表不再出现。
  const entities = await m.store.getEntities('g')
  assert.equal(entities['111'].facts.length, 1)
  assert.equal(entities['111'].facts[0].superseded, true)
  const after = await m.adminListMemories({ scope: 'user', groupId: 'g', userId: '111' })
  assert.equal(after.facts.length, 0)
})

test('adminDeleteMemory my:<id> returns not-found for unknown short id', async () => {
  const m = mgr(createFakeRedis())
  await m.applyOps('g', [
    { stream: 'entityFact', qq: '111', authority: 'self', fact: { text: '在上海', authority: 'self', confidence: 0.9, at: 1 } }
  ])
  const del = await m.adminDeleteMemory({ groupId: 'g', userId: '111', id: 'my:deadbeef' })
  assert.equal(del.deleted, false)
  assert.equal(del.reason, 'not-found')
})

// ---- §P0-3 adminStatus 返回真实字段 ----
test('adminStatus returns real user/group/config fields', async () => {
  const m = mgr(createFakeRedis())
  await m.applyOps('g', [
    { stream: 'entityFact', qq: '111', authority: 'self', fact: { text: '在上海', authority: 'self', confidence: 0.9, at: 1 } },
    { stream: 'alias', qq: '111', text: '咖啡', authority: 'self', confidence: 0.9, by: ['111'], at: 1 },
    { stream: 'groupFact', authority: 'mention', fact: { text: '不要刷屏', authority: 'mention', confidence: 0.8, at: 1 } }
  ])
  await m.adminSetUserMemoryEnabled({ groupId: 'g', userId: '111', enabled: false })

  const status = await m.adminStatus({ groupId: 'g', userId: '111' })
  assert.equal(status.user.factCount, 1)
  assert.equal(status.user.aliasCount, 1)
  assert.equal(status.user.optedOut, true)
  assert.equal(status.group.entityCount, 1)
  assert.equal(status.group.factCount, 1)
  assert.equal(status.group.disabled, false)
  assert.equal(typeof status.group.lastExtractAt, 'number')
  assert.equal(typeof status.group.failureCount, 'number')
  assert.equal(status.config.saveStrictness, 'normal')
  assert.equal(status.config.semanticRecallEnabled, false)
  assert.ok('maxEntitiesPerGroup' in status.config)
  // adminStatus 不应再返回旧的不存在字段
  assert.equal(status.config.importanceThreshold, undefined)
})

// ---- §0.4 _rankEntityFacts：cosine / confidence-recency / 身份锚点置顶 ----
test('_rankEntityFacts ranks by cosine when queryEmb and embeddings present', () => {
  const m = mgr(createFakeRedis())
  m.config.promptMaxEntityFacts = 6
  const facts = [
    { text: '无关', authority: 'mention', confidence: 0.9, at: 2, embedding: [0, 1], superseded: false },
    { text: '相关', authority: 'mention', confidence: 0.5, at: 1, embedding: [1, 0], superseded: false }
  ]
  const ranked = m._rankEntityFacts(facts, '问题', [1, 0])
  assert.equal(ranked[0].text, '相关') // cosine 高者在前，尽管 confidence 低
})

test('_rankEntityFacts falls back to confidence then recency without queryEmb', () => {
  const m = mgr(createFakeRedis())
  const facts = [
    { text: '低置信', authority: 'mention', confidence: 0.4, at: 5, superseded: false },
    { text: '高置信', authority: 'mention', confidence: 0.9, at: 1, superseded: false }
  ]
  const ranked = m._rankEntityFacts(facts, '问题', null)
  assert.equal(ranked[0].text, '高置信')
})

test('_rankEntityFacts pins highest-authority fact first (identity anchor)', () => {
  const m = mgr(createFakeRedis())
  // 语义排序会把高 cosine 的 mention 事实排前，但 config 身份事实必须被锚定到最前。
  const facts = [
    { text: '语义最相关', authority: 'mention', confidence: 0.9, at: 2, embedding: [1, 0], superseded: false },
    { text: '我叫咖啡大人', authority: 'config', confidence: 1, at: 1, embedding: [0, 1], superseded: false }
  ]
  const ranked = m._rankEntityFacts(facts, 'q', [1, 0])
  assert.equal(ranked[0].text, '我叫咖啡大人') // 最高 authority 置顶
})

test('_rankEntityFacts caps at promptMaxEntityFacts and skips superseded', () => {
  const m = mgr(createFakeRedis())
  m.config.promptMaxEntityFacts = 2
  const facts = [
    { text: 'A', authority: 'self', confidence: 0.9, at: 3, superseded: false },
    { text: 'B', authority: 'self', confidence: 0.8, at: 2, superseded: false },
    { text: 'C', authority: 'self', confidence: 0.7, at: 1, superseded: false },
    { text: 'D', authority: 'self', confidence: 0.95, at: 0, superseded: true }
  ]
  const ranked = m._rankEntityFacts(facts, '', null)
  assert.equal(ranked.length, 2)
  assert.ok(!ranked.some(f => f.text === 'D')) // superseded 跳过
})

// ---- §P0-3 meta.lastExtractAt/failureCount 在抽取成功后更新 ----
test('_flushUserBuffer updates meta.lastExtractAt and clears failureCount on success', { timeout: 5000 }, async () => {
  const m = mgr(createFakeRedis())
  m.config.userExtractMaxBatchMessages = 1
  m.extractor.extract = async () => ([
    { stream: 'entityFact', qq: '111', authority: 'self', fact: { text: '在上海', authority: 'self', confidence: 0.9, at: 1 } }
  ])
  await m.extractAndSaveMemories('g', '111', '我在上海')
  // 抽取成功后异步经 enqueue 写 meta，用同 key 的下一个 enqueue 等它跑完。
  await m.enqueueGroup('g', async () => {})
  const meta = await m.store.getMeta('g')
  assert.ok(meta.lastExtractAt > 0)
  assert.equal(meta.failureCount, 0)
})

test('_flushUserBuffer increments failureCount when extractor throws', { timeout: 5000 }, async () => {
  const m = mgr(createFakeRedis())
  m.config.userExtractMaxBatchMessages = 1
  m.extractor.extract = async () => { throw new Error('boom') }
  const r = await m.extractAndSaveMemories('g', '111', '我在上海')
  assert.equal(r.error, true)
  await m.enqueueGroup('g', async () => {})
  const meta = await m.store.getMeta('g')
  assert.equal(meta.failureCount, 1)
})
