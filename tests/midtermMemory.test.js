// 中期记忆(滚动主线摘要)单测:攒批触发/摘要更新链路/失败回滚/过期不注入/层注册
import { test, beforeEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  MidtermSummaryManager,
  normalizeMidtermConfig,
  __resetMidtermMemoryForTest
} from "../domains/midtermMemory/MidtermSummaryManager.js"
import { CHAT_PROMPT_LAYERS, FULL_PROMPT_LAYERS } from "../utils/promptLayers.js"

const AI = { memoryAiUrl: "http://mock/v1/chat/completions", memoryAiApikey: "k", memoryAiModel: "mock-mini" }
const silentLogger = { info: () => {}, warn: () => {}, error: () => {} }

function makeManager({ config = {}, summarize = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "midterm-"))
  const archiveManager = {
    formatRecord: record => String(record.raw_message || record.msg || "[非文本消息]")
  }
  const manager = new MidtermSummaryManager({
    baseDir: dir,
    archiveManager,
    config,
    memoryAiConfig: AI,
    logger: silentLogger
  })
  // 注入假摘要器:默认回显收到的行数
  manager.callSummarizer = summarize || (async (prev, lines) => `${prev ? prev + "|" : ""}摘要(${lines.length}条)`)
  return manager
}

function record(i, text = `消息${i}`) {
  return {
    group_id: "g1",
    archive_kind: "message",
    user_id: `u${i}`,
    sender: { user_id: `u${i}`, card: `群友${i}`, nickname: `群友${i}` },
    raw_message: text,
    timestamp: Date.now() - (100 - i) * 1000
  }
}

beforeEach(() => __resetMidtermMemoryForTest())

test("normalizeMidtermConfig:非法值钳制", () => {
  const cfg = normalizeMidtermConfig({ minMessages: 1, debounceMs: 10, maxSummaryChars: 10, retentionDays: 0 })
  assert.equal(cfg.minMessages, 4)
  assert.equal(cfg.debounceMs, 5000)
  assert.equal(cfg.maxSummaryChars, 120)
  assert.equal(cfg.retentionDays, 3, "0 视为未设置回退默认;禁用走 enabled 开关")
})

test("攒批:不足 minMessages 不触发,够了走防抖定时器,更新后清缓冲并落盘", async () => {
  const manager = makeManager({ config: { minMessages: 4, debounceMs: 6000 } })
  manager.onArchivedRecord(record(1))
  manager.onArchivedRecord(record(2))
  manager.onArchivedRecord(record(3))
  let fired = false
  manager.updateGroup = async () => { fired = true; return true }
  manager.onArchivedRecord(record(4))
  assert.equal(fired, false, "防抖期内不立即更新")
  const buffer = manager.buffers.get("g1")
  assert.ok(buffer.timer, "应已挂防抖定时器")
  clearTimeout(buffer.timer)
  buffer.timer = null
  // 恢复真更新链路验证落盘
  manager.updateGroup = MidtermSummaryManager.prototype.updateGroup
  const ok = await manager.updateGroup("g1")
  assert.equal(ok, true)
  assert.equal(buffer.lines.length, 0, "更新后缓冲清空")
  const data = manager.loadSummary("g1")
  assert.ok(data.summary.includes("4条"))
  assert.equal(data.updates, 1)
  assert.ok(fs.existsSync(manager.groupFile("g1")))
})

test("通知与非群消息不进缓冲;空文本行被丢弃", () => {
  const manager = makeManager()
  manager.onArchivedRecord({ archive_kind: "notice", group_id: "g1", raw_message: "通知" })
  manager.onArchivedRecord({ group_id: "g1", raw_message: "", sender: {} })
  manager.onArchivedRecord({ user_id: "u1", raw_message: "私聊" }) // 无 group_id
  assert.equal(manager.buffers.size, 0)
  manager.onArchivedRecord(record(1))
  manager.onArchivedRecord({ ...record(2), raw_message: "[非文本消息]" })
  assert.equal(manager.buffers.get("g1").lines.length, 1)
})

test("滚动合并:第二次更新带上旧摘要,covered_until_ts 单调", async () => {
  const manager = makeManager({ config: { minMessages: 2 } })
  manager.onArchivedRecord(record(1))
  manager.onArchivedRecord(record(2))
  await manager.updateGroup("g1")
  const first = manager.loadSummary("g1")
  manager.onArchivedRecord(record(3))
  manager.onArchivedRecord(record(4))
  await manager.updateGroup("g1")
  const second = manager.loadSummary("g1")
  assert.ok(second.summary.includes("|"), "新摘要应合并旧摘要")
  assert.ok(second.covered_until_ts >= first.covered_until_ts)
  assert.equal(second.updates, 2)
})

test("LLM 失败:消费的行还回缓冲,不丢消息,可重试", async () => {
  const manager = makeManager({ config: { minMessages: 2 } })
  manager.onArchivedRecord(record(1))
  manager.onArchivedRecord(record(2))
  const original = manager.callSummarizer
  manager.callSummarizer = async () => { throw new Error("模型挂了") }
  await assert.rejects(() => manager.updateGroup("g1"), /模型挂了/)
  assert.equal(manager.buffers.get("g1").lines.length, 2, "失败后行回到缓冲")
  manager.callSummarizer = original
  assert.equal(await manager.updateGroup("g1"), true, "重试成功")
})

test("getSummaryPrompt:有过期保护与格式;未启用/无数据返回空", async () => {
  const manager = makeManager({ config: { minMessages: 1, retentionDays: 1 } })
  assert.equal(manager.getSummaryPrompt("g1"), "")
  manager.onArchivedRecord(record(1))
  await manager.updateGroup("g1")
  const prompt = manager.getSummaryPrompt("g1")
  assert.ok(prompt.startsWith("【本群近期主线】"))
  assert.ok(prompt.includes("摘要(1条)"))
  // 把更新时间拨到 3 天前 → 过期不注入
  const stale = { ...manager.loadSummary("g1"), updated_at: Date.now() - 3 * 24 * 3600 * 1000 }
  manager.saveSummary("g1", stale)
  assert.equal(manager.getSummaryPrompt("g1"), "")
})

test("sweep 清扫过期摘要文件", async () => {
  const manager = makeManager({ config: { minMessages: 1, retentionDays: 1 } })
  manager.onArchivedRecord(record(1))
  await manager.updateGroup("g1")
  const file = manager.groupFile("g1")
  assert.ok(fs.existsSync(file))
  const old = new Date(Date.now() - 3 * 24 * 3600 * 1000)
  fs.utimesSync(file, old, old)
  assert.equal(manager.sweep(), 1)
  assert.ok(!fs.existsSync(file))
})

test("提示词层注册:chat 与 task 层都包含 midtermMemory", () => {
  assert.ok(CHAT_PROMPT_LAYERS.includes("midtermMemory"), "闲聊层应带中期记忆(长聊不断片)")
  assert.ok(FULL_PROMPT_LAYERS.includes("midtermMemory"))
})

test("composer 集成:注入 midtermSummaryManager 后层有值", async () => {
  const { composeTurnPromptLayers } = await import("../utils/turnPromptComposer.js")
  const manager = makeManager({ config: { minMessages: 1 } })
  manager.onArchivedRecord(record(1))
  await manager.updateGroup("g1")
  const result = await composeTurnPromptLayers({
    config: { midtermMemory: { enabled: true } },
    turn: { groupId: "g1", userId: "u1", messageText: "在吗" },
    deps: { midtermSummaryManager: manager }
  })
  assert.ok(result.layerValues.midtermMemory.includes("本群近期主线"))
  assert.ok(result.prompt.includes("本群近期主线"))
})
