import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"

async function loadModules() {
  globalThis.logger ||= { info() {}, warn() {}, error() {}, debug() {} }
  try {
    const store = await import("../domains/semanticMemory/SemanticMemoryStore.js")
    const indexer = await import("../domains/semanticMemory/SemanticMemoryIndexer.js")
    const retriever = await import("../domains/semanticMemory/SemanticMemoryRetriever.js")
    const runtime = await import("../domains/semanticMemory/runtime.js")
    const archive = await import("../utils/MessageArchiveManager.js")
    return { store, indexer, retriever, runtime, archive }
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") return null
    throw error
  }
}

// 伪造 embedding:关键词映射到正交单位向量(dim=6),同关键词文本余弦=1
const KEYWORD_AXES = { 游戏: 0, 天气: 1, 外卖: 2, 考试: 3, 星露谷: 4 }
class FakeGateway {
  constructor() {
    this.model = "fake-embed"
    this.dimension = 6
    this.stats = { batchRequests: 0, cacheHits: 0, failures: 0 }
  }
  vectorFor(text) {
    const vector = new Float32Array(this.dimension)
    for (const [keyword, axis] of Object.entries(KEYWORD_AXES)) {
      if (String(text).includes(keyword)) vector[axis] = 1
    }
    let norm = 0
    for (const value of vector) norm += value * value
    norm = Math.sqrt(norm)
    if (norm > 0) for (let i = 0; i < vector.length; i++) vector[i] /= norm
    return vector
  }
  async embedBatch(texts = []) {
    this.stats.batchRequests++
    return texts.map(text => this.vectorFor(text))
  }
  async embed(text) {
    return this.vectorFor(text)
  }
}

function chunkDraft(id, text, extra = {}) {
  const now = Date.now()
  return { id, group_id: "609235590", start_ts: now - 60000, end_ts: now, message_ids: ["m1", "m2"], speakers: ["甲"], text, model: "fake-embed", vector: null, ...extra }
}

test("BM25:CJK bigram 分词,命中文档排在未命中前", async t => {
  const loaded = await loadModules()
  if (!loaded) return t.skip("module not found")
  const { BM25Index, tokenizeForBM25 } = loaded.store
  assert.deepEqual(tokenizeForBM25("星露谷好玩"), ["星露", "露谷", "谷好", "好玩"])
  assert.deepEqual(tokenizeForBM25("play Star Valley v2"), ["play", "star", "valley", "v2"])
  const index = new BM25Index()
  index.add("a", tokenizeForBM25("我们昨晚在玩星露谷联机"))
  index.add("b", tokenizeForBM25("明天天气不错适合出去玩"))
  const hits = index.search(tokenizeForBM25("星露谷怎么样"), 5)
  assert.equal(hits[0]?.id, "a")
  assert.ok(!hits.some(hit => hit.id === "b"))
})

test("向量存储:追加→重载→最近邻检索,同 id 覆盖,维度自适应", async t => {
  const loaded = await loadModules()
  if (!loaded) return t.skip("module not found")
  const { SemanticMemoryStore } = loaded.store
  const gateway = new FakeGateway()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-store-"))
  try {
    const dir = path.join(cwd, "semantic_memory")
    const store = new SemanticMemoryStore({ baseDir: dir, dimension: 6 })
    await store.appendChunks("609235590", [
      { ...chunkDraft("g:m1", "甲: 星露谷联机真好玩"), vector: gateway.vectorFor("星露谷联机真好玩") },
      { ...chunkDraft("g:m2", "乙: 今天天气好像要下雨"), vector: gateway.vectorFor("今天天气好像要下雨") }
    ])
    // 新实例从磁盘加载(模拟重启)
    const reloaded = new SemanticMemoryStore({ baseDir: dir, dimension: 6, retentionDays: 3650 })
    const hits = reloaded.searchVector("609235590", gateway.vectorFor("星露谷好玩吗"), 5)
    assert.equal(hits.length, 1, "正交向量(dot=0)不返回")
    assert.equal(hits[0].chunk.id, "g:m1")
    assert.ok(hits[0].score > 0.99)

    const bm25Hits = reloaded.searchBM25("609235590", "星露谷联机", 5)
    assert.equal(bm25Hits[0]?.chunk?.id, "g:m1")

    // 同 id 追加覆盖(last wins)
    await reloaded.appendChunks("609235590", [
      { ...chunkDraft("g:m1", "甲: 星露谷改成玩别的了"), vector: gateway.vectorFor("星露谷改成玩别的了"), message_ids: ["m1x"] }
    ])
    const again = new SemanticMemoryStore({ baseDir: dir, dimension: 6 })
    assert.equal(again.loadGroup("609235590").chunks.size, 2)

    // 维度自适应清空内存态
    again.setDimension(8)
    assert.equal(again.groups.size, 0)
    assert.equal(again.dimension, 8)
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test("RRF 融合:双侧命中者居首,重叠窗口去重", async t => {
  const loaded = await loadModules()
  if (!loaded) return t.skip("module not found")
  const { rrfFuse } = loaded.retriever
  const chunk = id => ({ id, message_ids: [id], text: `t${id}` })
  const vectorHits = [
    { chunk: chunk("both"), score: 0.8 },
    { chunk: chunk("vecOnly"), score: 0.7 }
  ]
  const bm25Hits = [
    { chunk: chunk("both"), score: 3.2 },
    { chunk: chunk("bmOnly"), score: 2.1 }
  ]
  const fused = rrfFuse(vectorHits, bm25Hits)
  assert.equal(fused[0].chunk.id, "both", "双路命中 RRF 最高")
  assert.ok(fused[0].rrf > fused[1].rrf)
})

test("检索器:阈值门控 + 重叠分块去重 + 上下文渲染", async t => {
  const loaded = await loadModules()
  if (!loaded) return t.skip("module not found")
  const { SemanticMemoryStore } = loaded.store
  const { SemanticMemoryRetriever } = loaded.retriever
  const gateway = new FakeGateway()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-retriever-"))
  try {
    const store = new SemanticMemoryStore({ baseDir: path.join(cwd, "sm"), dimension: 6 })
    await store.appendChunks("609235590", [
      { ...chunkDraft("g:a", "甲: 昨天我们开黑星露谷到三点", { message_ids: ["m1", "m2", "m3", "m4"] }), vector: gateway.vectorFor("星露谷开黑") },
      { ...chunkDraft("g:b", "乙: 星露谷之后玩什么", { message_ids: ["m3", "m4", "m5", "m6"] }), vector: gateway.vectorFor("星露谷之后玩什么") },
      { ...chunkDraft("g:c", "丙: 明天要考试了好烦", { message_ids: ["m7", "m8", "m9", "m10"] }), vector: gateway.vectorFor("考试好烦") }
    ])
    const retriever = new SemanticMemoryRetriever({
      store,
      gateway,
      config: { topK: 5, minScore: 0.35, retrieveTimeoutMs: 2000, contextMaxChars: 900 }
    })
    const result = await retriever.search("609235590", "我们之前玩的星露谷呢")
    // g:a 与 g:b 重叠 2/4=0.5,不大于 0.5 应保留?断言至少包含 g:a 且不含低于阈值的 g:c
    assert.ok(result.items.some(item => item.chunk.id === "g:a"))
    assert.ok(!result.items.some(item => item.chunk.id === "g:c"), "无关主题低于阈值被过滤")
    const context = retriever.renderContext(result)
    assert.match(context, /星露谷/)
    assert.match(context, /\[\d{2}-\d{2} \d{2}:\d{2}~/)

    // 严格重叠(>50%)去重
    await store.appendChunks("609235590", [
      { ...chunkDraft("g:d", "丁: 星露谷第二天又开了一局", { message_ids: ["m1", "m2", "m3", "m11"] }), vector: gateway.vectorFor("星露谷又开了一局") }
    ])
    const deduped = await retriever.search("609235590", "星露谷")
    const ids = deduped.items.map(item => item.chunk.id)
    assert.ok(ids.includes("g:a") !== ids.includes("g:d") || ids.indexOf("g:a") < ids.indexOf("g:d"), "重叠分块不会同时占据前排")
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test("分块器:滑窗+步长+尾窗覆盖+幂等 id", async t => {
  const loaded = await loadModules()
  if (!loaded) return t.skip("module not found")
  const { SemanticMemoryIndexer } = loaded.indexer
  const gateway = new FakeGateway()
  const indexer = new SemanticMemoryIndexer({
    store: { loadGroup: () => ({ chunks: new Map() }), appendChunks: async () => 0 },
    gateway,
    archiveManager: { formatRecord: record => String(record.raw_message || "") },
    config: { windowSize: 4, stride: 2 }
  })
  const lines = Array.from({ length: 9 }, (_, i) => ({
    userId: `u${i}`, name: `成员${i}`, text: `消息${i}星露谷`, timestamp: 1000 + i, messageId: `m${i}`
  }))
  const chunks = indexer.buildChunks("609235590", lines)
  assert.ok(chunks.length >= 4 && chunks.length <= 5)
  assert.equal(chunks[0].id, "609235590:m3")
  assert.equal(chunks[chunks.length - 1].id, "609235590:m8", "尾窗覆盖最后一条")
  assert.deepEqual(chunks[0].message_ids, ["m0", "m1", "m2", "m3"])
  assert.match(chunks[0].text, /成员0: 消息0星露谷/)

  const fewer = indexer.buildChunks("609235590", lines.slice(0, 3))
  assert.equal(fewer.length, 1, "不足一个窗口合成单块")
  assert.equal(fewer[0].id, "609235590:m2")
})

test("端到端:归档写入→回填索引→检索命中", async t => {
  const loaded = await loadModules()
  if (!loaded) return t.skip("module not found")
  const { SemanticMemoryStore } = loaded.store
  const { SemanticMemoryIndexer } = loaded.indexer
  const { SemanticMemoryRetriever } = loaded.retriever
  const { MessageArchiveManager } = loaded.archive
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-e2e-"))
  const configDir = path.join(cwd, "plugins/shiloh-plugin/config_default")
  fs.mkdirSync(configDir, { recursive: true })
  fs.writeFileSync(path.join(configDir, "message.yaml"), [
    "pluginSettings:",
    "  messageArchive:",
    "    enabled: true",
    "    baseDir: data/message_archive",
    "    retentionDays: 3650",
    "  semanticMemory:",
    "    enabled: true",
    "    windowSize: 4",
    "    stride: 2"
  ].join("\n"))
  try {
    const archiveManager = new MessageArchiveManager({ cwd, logger: globalThis.logger })
    const base = 1784517000
    for (let i = 0; i < 10; i++) {
      const topic = i % 2 === 0 ? "星露谷联机种田" : "明天天气降温"
      await archiveManager.recordMessage({
        event_id: `event-${i}`, message_type: "group", group_id: 609235590,
        user_id: 100 + i, message_id: 900 + i, time: base + i,
        raw_message: `成员${i}: ${topic} 第${i}条`,
        message: [{ type: "text", text: `${topic} 第${i}条` }],
        sender: { user_id: 100 + i, nickname: `成员${i}`, card: `成员${i}` }
      }, { preEnrichedMessage: [{ type: "text", text: topic }], throwOnError: true })
    }

    const store = new SemanticMemoryStore({
      baseDir: path.join(cwd, "plugins/shiloh-plugin/data/semantic_memory"),
      dimension: 6,
      retentionDays: 3650
    })
    const gateway = new FakeGateway()
    const indexer = new SemanticMemoryIndexer({ store, gateway, archiveManager, config: { windowSize: 4, stride: 2 } })
    const report = await indexer.backfillGroup(609235590)
    assert.equal(report.error, undefined)
    assert.ok(report.chunks >= 4)
    assert.ok(report.indexed >= 4)

    // 幂等:重跑回填不再新增
    const again = await indexer.backfillGroup(609235590)
    assert.equal(again.indexed, 0)

    const retriever = new SemanticMemoryRetriever({ store, gateway, config: { topK: 3, minScore: 0.3, retrieveTimeoutMs: 2000 } })
    const result = await retriever.search(609235590, "我们玩的星露谷呢")
    assert.ok(result.items.length >= 1)
    assert.ok(result.items.every(item => /星露谷/.test(item.chunk.text) || item.bm25Rank <= 3))
    assert.match(retriever.renderContext(result), /星露谷/)

    // 增量:新消息后手动 flush,新尾窗可检索
    await archiveManager.recordMessage({
      event_id: "event-new", message_type: "group", group_id: 609235590,
      user_id: 199, message_id: 999, time: base + 100,
      raw_message: "成员9: 星露谷更新了新版本",
      message: [{ type: "text", text: "星露谷更新了新版本" }],
      sender: { user_id: 199, nickname: "成员9", card: "成员9" }
    }, { preEnrichedMessage: [{ type: "text", text: "星露谷更新了新版本" }], throwOnError: true })
    indexer.onArchivedRecord({ group_id: 609235590, archive_kind: undefined, message_id: 999 })
    await indexer.flushDirtyGroups()
    const after = await retriever.search(609235590, "星露谷新版本")
    assert.ok(after.items.some(item => item.chunk.id.endsWith(":999")), "尾窗增量被索引")
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test("配置归一化:范围钳制与群过滤", async t => {
  const loaded = await loadModules()
  if (!loaded) return t.skip("module not found")
  const { normalizeSemanticMemoryConfig } = loaded.runtime
  const config = normalizeSemanticMemoryConfig({ windowSize: 1, stride: 0, topK: 99, minScore: 5, includeGroups: [123, "456"] })
  assert.equal(config.windowSize, 2)
  assert.equal(config.stride, 4, "stride=0 视为未配置,回落默认 4")
  assert.equal(config.topK, 99)
  assert.equal(config.minScore, 0.95)
  assert.equal(config.retentionDays, 30, "保留期默认 30 天,独立于归档")
  assert.deepEqual(config.includeGroups, ["123", "456"])
})

test("保留期独立于归档 + 每日清扫强制压实", async t => {
  const loaded = await loadModules()
  if (!loaded) return t.skip("module not found")
  const { SemanticMemoryStore } = loaded.store
  const gateway = new FakeGateway()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-sweep-"))
  try {
    const dir = path.join(cwd, "semantic_memory")
    const store = new SemanticMemoryStore({ baseDir: dir, dimension: 6, retentionDays: 30 })
    const now = Date.now()
    const day = 24 * 3600 * 1000
    // 8 天前的分块:旧 7 天保留会丢,独立 30 天保留应留下
    await store.appendChunks("609235590", [
      { ...chunkDraft("g:old8d", "甲: 八天前聊的星露谷", { end_ts: now - 8 * day, start_ts: now - 8 * day - 60000 }), vector: gateway.vectorFor("星露谷") },
      { ...chunkDraft("g:old40d", "乙: 四十天前的旧话", { end_ts: now - 40 * day, start_ts: now - 40 * day - 60000 }), vector: gateway.vectorFor("旧话") },
      { ...chunkDraft("g:fresh", "丙: 今天的新话题", { end_ts: now, start_ts: now - 60000 }), vector: gateway.vectorFor("新话题") }
    ])
    const state = store.loadGroup("609235590")
    assert.ok(state.chunks.has("g:old8d"), "8 天前分块在 30 天保留下存活")
    assert.ok(!state.chunks.has("g:old40d"), "40 天前分块被清理")
    assert.ok(state.chunks.has("g:fresh"))

    // 清扫:过期行(40天)仍留在磁盘文件里,sweepAll 强制压实
    const file = path.join(dir, "group", "609235590.ndjson")
    const beforeLines = fs.readFileSync(file, "utf8").trim().split("\n").length
    const summary = await store.sweepAll()
    assert.equal(beforeLines, 3)
    assert.equal(summary.compactedGroups, 1)
    assert.ok(summary.droppedChunks >= 1)
    const afterLines = fs.readFileSync(file, "utf8").trim().split("\n").length
    assert.equal(afterLines, 2)
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})
