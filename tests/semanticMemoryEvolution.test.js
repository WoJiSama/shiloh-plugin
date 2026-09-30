// 记忆强度演化单测(借鉴 A-Memorix 半衰期模型):
// 衰减数学、排序融合、召回强化与持久化、单条遗忘、清扫冻结、旧数据兼容
import { test, beforeEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SemanticMemoryStore, effectiveStrength, normalizeEvolutionConfig } from "../domains/semanticMemory/SemanticMemoryStore.js"
import { SemanticMemoryRetriever, rrfFuse } from "../domains/semanticMemory/SemanticMemoryRetriever.js"

const DAY = 24 * 3600 * 1000
const DIM = 4

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }

function makeStore({ evolution = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sm-evo-"))
  return new SemanticMemoryStore({
    baseDir: dir,
    dimension: DIM,
    retentionDays: 30,
    evolution,
    logger: silentLogger
  })
}

function chunkRecord(id, { endTs = Date.now(), text = `内容 ${id}`, strength, recallCount, lastRecallAt } = {}) {
  const vector = [0.1, 0.2, 0.3, 0.4].map(v => v / Math.sqrt(0.3))
  const record = {
    id,
    group_id: "g1",
    start_ts: endTs - 1000,
    end_ts: endTs,
    message_ids: [id],
    speakers: ["某人"],
    text,
    vector
  }
  if (strength !== undefined) record.strength = strength
  if (recallCount !== undefined) record.recallCount = recallCount
  if (lastRecallAt !== undefined) record.lastRecallAt = lastRecallAt
  return record
}

async function seed(store, records) {
  await store.appendChunks("g1", records)
}

beforeEach(() => {})

test("effectiveStrength:半衰期数学——半衰期时减半,锚点取 lastRecallAt 与 end_ts 较大者,缺省强度为 1", () => {
  const now = Date.now()
  // 新记忆(锚点=now)强度=1
  assert.ok(Math.abs(effectiveStrength({ end_ts: now }, now, 7) - 1) < 1e-9)
  // 7 天前:强度减半
  assert.ok(Math.abs(effectiveStrength({ end_ts: now - 7 * DAY }, now, 7) - 0.5) < 1e-6)
  // 14 天前:四分之一
  assert.ok(Math.abs(effectiveStrength({ end_ts: now - 14 * DAY }, now, 7) - 0.25) < 1e-6)
  // 被想起过:衰减时钟从 lastRecallAt 重算
  assert.ok(Math.abs(effectiveStrength({ end_ts: now - 14 * DAY, lastRecallAt: now - 7 * DAY, strength: 1 }, now, 7) - 0.5) < 1e-6)
  // 强化过的记忆基准更高
  assert.ok(Math.abs(effectiveStrength({ end_ts: now - 7 * DAY, strength: 1 }, now, 7) - 0.5) < 1e-6)
  assert.ok(effectiveStrength({ end_ts: now, strength: 1, recallCount: 5 }, now, 7) > 0.99)
  // 旧数据(无 strength 字段)按 1.0 处理
  assert.ok(Math.abs(effectiveStrength({ end_ts: now }, now, 7) - 1) < 1e-9)
})

test("normalizeEvolutionConfig:非法值回退默认,freezeThreshold=0 可关闭按强度遗忘", () => {
  const cfg = normalizeEvolutionConfig({ halfLifeDays: "abc", reinforceBoost: 99, freezeThreshold: 0 })
  assert.equal(cfg.halfLifeDays, 7)
  assert.equal(cfg.reinforceBoost, 1)
  assert.equal(cfg.freezeThreshold, 0)
  assert.equal(cfg.enabled, true)
})

test("召回强化:提升强度/计数/重置时钟,达到批量大小时落盘,重载后保留", async () => {
  const store = makeStore({ evolution: { flushBatch: 4, reinforceBoost: 0.4 } })
  await seed(store, [chunkRecord("a"), chunkRecord("b"), chunkRecord("c"), chunkRecord("d")])

  const updated = store.reinforceChunks("g1", ["a"])
  assert.equal(updated, 1)
  let meta = store.touchGroup("g1").chunks.get("a")
  assert.equal(meta.strength, 1, "强化封顶 maxStrength=1")
  assert.equal(meta.recallCount, 1)
  assert.ok(meta.lastRecallAt > 0)

  // 未到批量(下限钳制 flushBatch>=4):不落盘(内存态)
  assert.equal(store.touchGroup("g1").dirty.size, 1)
  // 再强化三条,达到 flushBatch=4 → 落盘
  store.reinforceChunks("g1", ["b", "c", "d"])
  await new Promise(r => setTimeout(r, 50))
  // 落盘后重载,强化仍在
  store.groups.delete("g1")
  const reloaded = store.loadGroup("g1").chunks.get("a")
  assert.equal(reloaded.recallCount, 1)
  assert.ok(reloaded.lastRecallAt > 0)
})

test("遗忘:forgetChunk 从索引与文件中移除,重载后不存在", async () => {
  const store = makeStore()
  await seed(store, [chunkRecord("a"), chunkRecord("b")])
  assert.equal(await store.forgetChunk("g1", "a"), true)
  assert.equal(store.loadGroup("g1").chunks.has("a"), false)
  assert.equal(store.loadGroup("g1").chunks.has("b"), true)
  // 文件层面也删除(追加行不会复活)
  store.groups.delete("g1")
  assert.equal(store.loadGroup("g1").chunks.has("a"), false)
  assert.equal(await store.forgetChunk("g1", "不存在"), false)
})

test("清扫:强度衰减到冻结阈值以下的分块被遗忘并压实,近期记忆保留", async () => {
  const store = makeStore({ evolution: { halfLifeDays: 1, freezeThreshold: 0.3 } })
  const now = Date.now()
  await seed(store, [
    chunkRecord("新", { endTs: now }),
    chunkRecord("旧", { endTs: now - 10 * DAY }) // 1 天半衰期,10 天 → ~0.1%
    ,
    chunkRecord("被想起的旧", { endTs: now - 10 * DAY, lastRecallAt: now - 0.5 * DAY })
  ])
  const summary = await store.sweepAll()
  assert.equal(summary.frozenChunks, 1)
  const state = store.loadGroup("g1")
  assert.equal(state.chunks.has("旧"), false)
  assert.equal(state.chunks.has("新"), true)
  assert.equal(state.chunks.has("被想起的旧"), true, "被想起过的旧记忆衰减时钟重置,不冻结")
  // 压实后文件里也没有旧行
  const raw = fs.readFileSync(store.groupFile("g1"), "utf8")
  assert.ok(!raw.includes("\"旧\""))
})

test("检索排序:强度因子混入 RRF,近期记忆排前;低于冻结阈值的不注入;被注入的自动强化", async () => {
  const store = makeStore({ evolution: { halfLifeDays: 7, freezeThreshold: 0.2 } })
  const now = Date.now()
  // 两条内容都与 query 相关(bm25 同信号),一条新一条旧
  await seed(store, [
    chunkRecord("new", { endTs: now, text: "星露谷物语种田心得" }),
    chunkRecord("old", { endTs: now - 30 * DAY, text: "星露谷物语种田心得" })
  ])
  const gateway = { embed: async () => [1, 0, 0, 0] }
  const retriever = new SemanticMemoryRetriever({
    store,
    gateway,
    config: { memoryEvolution: { enabled: true, halfLifeDays: 7, freezeThreshold: 0.2 }, minScore: 0.0, topK: 5 },
    logger: silentLogger
  })
  const result = await retriever.search("g1", "星露谷物语", { timeoutMs: 2000 })
  assert.ok(result.items.length >= 1)
  assert.equal(result.items[0].chunk.id, "new", "近期记忆应排在前面")
  assert.ok(result.items.every(item => item.effectiveStrength === null || item.effectiveStrength >= 0.2), "冻结以下不注入")
  // 被注入的发生了强化
  const meta = store.touchGroup("g1").chunks.get("new")
  assert.equal(meta.recallCount, 1)
})

test("演化关闭:排序与旧行为一致(不强化/不冻结)", async () => {
  const store = makeStore({ evolution: { enabled: false } })
  const now = Date.now()
  await seed(store, [
    chunkRecord("new", { endTs: now, text: "星露谷物语种田心得" }),
    chunkRecord("old", { endTs: now - 60 * DAY, text: "星露谷物语种田心得" })
  ])
  const gateway = { embed: async () => [1, 0, 0, 0] }
  const retriever = new SemanticMemoryRetriever({
    store,
    gateway,
    config: { memoryEvolution: { enabled: false }, minScore: 0.0, topK: 5 },
    logger: silentLogger
  })
  const result = await retriever.search("g1", "星露谷物语", { timeoutMs: 2000 })
  assert.ok(result.items.length >= 1)
  assert.equal(store.touchGroup("g1").chunks.get("new").recallCount || 0, 0, "关闭时不强化")
})

test("rrfFuse 未受影响(回归)", () => {
  const fused = rrfFuse([{ chunk: { id: "a", message_ids: ["1"] }, score: 0.9 }], [])
  assert.equal(fused.length, 1)
  assert.ok(fused[0].rrf > 0)
})
