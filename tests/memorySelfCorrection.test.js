// 记忆自纠错单测:话术检测/关联性判定/TTL/降权数学(不重置衰减锚点)/误伤保护
import { test, beforeEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  isCorrectionText,
  noteInjectedChunks,
  getInjectedChunks,
  detectAndPenalize,
  __resetMemorySelfCorrectionForTest
} from "../utils/memorySelfCorrection.js"
import { SemanticMemoryStore } from "../domains/semanticMemory/SemanticMemoryStore.js"

const silentLogger = { info: () => {}, warn: () => {}, mark: () => {}, error: () => {} }

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "selfcorr-"))
  return new SemanticMemoryStore({ baseDir: dir, dimension: 4, retentionDays: 30, logger: silentLogger })
}

async function seed(store, ids) {
  const vector = [0.5, 0.5, 0.5, 0.5]
  await store.appendChunks("g1", ids.map(id => ({
    id, group_id: "g1", start_ts: Date.now() - 1000, end_ts: Date.now() - 1000,
    message_ids: [id], speakers: ["某人"], text: `内容 ${id}`, vector
  })))
}

beforeEach(() => __resetMemorySelfCorrectionForTest())

test("isCorrectionText:命中典型纠错话术,不误伤普通聊天", () => {
  for (const hit of ["你记错了", "你记岔了吧", "不是这样的", "根本没有这件事", "哪有这个说法", "你搞错了"]) {
    assert.ok(isCorrectionText(hit), `应命中:${hit}`)
  }
  for (const miss of ["今天天气不错", "记住了哦", "不是这个意思啦", "你记性真好", "哪有你这么帅的"]) {
    assert.ok(!isCorrectionText(miss), `不应命中:${miss}`)
  }
})

test("detectAndPenalize:三条件缺一不触发(话术/关联/近期注入)", async () => {
  const store = makeStore()
  await seed(store, ["a", "b"])
  const runtime = { store }
  noteInjectedChunks("g1", [{ chunk: { id: "a" } }, { chunk: { id: "b" } }])

  const base = { groupId: "g1", senderUserId: "u1", lastBotReplyToUserId: "u1", runtime }

  // 无话术
  assert.deepEqual(detectAndPenalize({ ...base, text: "哈哈" }), [])
  // 不关联(既非引用 bot,发送者也不是 bot 上轮回复的人)
  assert.deepEqual(detectAndPenalize({ ...base, text: "你记错了", lastBotReplyToUserId: "别人" }), [])
  // 引用 bot 也算关联
  assert.ok(detectAndPenalize({ ...base, text: "你记错了", quotesBot: true }).length === 2)
})

test("detectAndPenalize:TTL 过期不触发", async () => {
  const store = makeStore()
  await seed(store, ["a"])
  noteInjectedChunks("g1", [{ chunk: { id: "a" } }], Date.now() - 11 * 60 * 1000)
  const hit = detectAndPenalize({
    groupId: "g1", text: "你记错了", senderUserId: "u1", lastBotReplyToUserId: "u1",
    runtime: { store }, ttlMs: 10 * 60 * 1000
  })
  assert.deepEqual(hit, [])
})

test("penalizeChunks:降权不重置衰减锚点,强度钳下限,重复纠错逼近冻结线", async () => {
  const store = makeStore()
  const now = Date.now()
  // 预置一条强化过的记忆:strength 1, lastRecallAt 较新
  const vector = [0.5, 0.5, 0.5, 0.5]
  await store.appendChunks("g1", [{
    id: "a", group_id: "g1", start_ts: now - 3600_000, end_ts: now - 3600_000,
    message_ids: ["a"], speakers: ["某人"], text: "内容 a", vector
  }])
  const state = store.touchGroup("g1")
  const meta = state.chunks.get("a")
  meta.strength = 1
  meta.lastRecallAt = now - 60_000
  state.records.find(r => r.id === "a").strength = 1
  state.records.find(r => r.id === "a").lastRecallAt = now - 60_000

  // 第一次纠错:1 - 0.5 = 0.5,lastRecallAt 不变(锚点不被"纠错"刷新)
  assert.equal(store.penalizeChunks("g1", ["a"], { penalty: 0.5 }), 1)
  const after1 = store.touchGroup("g1").chunks.get("a")
  assert.ok(Math.abs(after1.strength - 0.5) < 1e-9)
  assert.equal(after1.lastRecallAt, now - 60_000, "降权不得重置衰减时钟")

  // 第二次:0.5 - 0.5 → 钳到 0.02 下限,已在冻结线(0.06)以下,清扫会淡忘
  store.penalizeChunks("g1", ["a"], { penalty: 0.5 })
  assert.ok(store.touchGroup("g1").chunks.get("a").strength <= 0.06)

  // 不存在的 id 不计数
  assert.equal(store.penalizeChunks("g1", ["幽灵"]), 0)
})

test("getInjectedChunks:无记录/空 id 过滤/过期清缓存", () => {
  assert.equal(getInjectedChunks("gx"), null)
  noteInjectedChunks("g2", [{ chunk: { id: "" } }, null, { chunk: { id: "ok" } }])
  assert.deepEqual(getInjectedChunks("g2").ids, ["ok"])
  noteInjectedChunks("g3", [{ chunk: { id: "x" } }], Date.now() - 999_999)
  assert.equal(getInjectedChunks("g3"), null, "过期应返回 null")
})
