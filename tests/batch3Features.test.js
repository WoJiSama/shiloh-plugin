// 第三批功能单测:注意力漂移(钩子检测+提示+格式化) / 记忆纠错闭环
// apps 模块依赖 Yunzai 全局类,按家规在测试体内垫桩后动态 import
import { test, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { detectAttentionHook, updateGroupTopic, resetGroupContextStateForTests } from "../utils/groupContextState.js"

beforeEach(() => resetGroupContextStateForTests())

// ── 注意力漂移 ──

test("detectAttentionHook:新词+爆发命中,旧词/单次提及不命中", () => {
  updateGroupTopic({ groupId: "g1", text: "聊聊新梗的事" })
  updateGroupTopic({ groupId: "g1", text: "新梗真的假的" })
  const hook = detectAttentionHook({ groupId: "g1" })
  assert.ok(hook && hook.count >= 2, `新词爆发应命中:${JSON.stringify(hook)}`)

  // 首现超出窗口(老话题)不命中:拨 now 到窗口之后
  updateGroupTopic({ groupId: "g2", text: "旧话题聊过很多次" })
  updateGroupTopic({ groupId: "g2", text: "旧话题继续" })
  assert.equal(detectAttentionHook({ groupId: "g2", windowMs: 60_000, now: Date.now() + 120_000 }), null)

  // 只提过一次的不算爆发
  updateGroupTopic({ groupId: "g3", text: "提一次的词" })
  assert.equal(detectAttentionHook({ groupId: "g3", minCount: 2 }), null)
})

test("formatAttentionHint:三档措辞与空钩子", async () => {
  globalThis.plugin ||= class {}
  globalThis.logger ||= { info() {}, warn() {}, error() {}, mark() {} }
  const { formatAttentionHint } = await import("../apps/lib/timingGate.js")
  const hook = { word: "新梗", count: 3 }
  assert.ok(formatAttentionHint(hook, "subtle").includes("可以留意"))
  assert.ok(formatAttentionHint(hook, "normal").includes("更容易被它吸引"))
  assert.ok(formatAttentionHint(hook, "strong").includes("更倾向于插话"))
  assert.ok(formatAttentionHint(hook).includes("「新梗」"))
  assert.ok(formatAttentionHint(hook).includes("3 次"))
  assert.equal(formatAttentionHint(null, "normal"), "")
})

// ── 记忆纠错闭环 ──

test("resolveForgetTarget:无缓存/原始 id/空参三路径", async () => {
  globalThis.plugin ||= class {}
  globalThis.logger ||= { info() {}, warn() {}, error() {}, mark() {} }
  const { resolveForgetTarget } = await import("../apps/SemanticMemory.js")
  const noCache = resolveForgetTarget("第1条", "gx")
  assert.ok(noCache.error && noCache.error.includes("查询"))
  assert.deepEqual(resolveForgetTarget("abc:123", "gx"), { id: "abc:123" })
  assert.ok(resolveForgetTarget("", "gx").error)
})

test("纠错闭环集成:查询带序号与提示 → 忘记 第N条 → 越界报错", async () => {
  globalThis.plugin ||= class {}
  globalThis.logger ||= { info() {}, warn() {}, error() {}, mark() {} }
  const { SemanticMemoryPlugin } = await import("../apps/SemanticMemory.js")
  const replies = []
  const e = {
    group_id: "gy",
    isMaster: true,
    sender: { role: "owner" },
    reply: async text => { replies.push(String(text)) },
    msg: ".语义记忆 查询 星露谷"
  }
  const runtime = {
    config: { rerankEnabled: false },
    retriever: {
      search: async () => ({
        items: [
          { chunk: { id: "gy:1", text: "星露谷种田" }, vectorScore: 0.9, vectorRank: 1, bm25Rank: 1, rerankScore: null },
          { chunk: { id: "gy:2", text: "星露谷联机" }, vectorScore: 0.8, vectorRank: 2, bm25Rank: 2, rerankScore: null }
        ],
        elapsedMs: 5, vectorMs: 2, bm25Ms: 1, rerankMs: 0, reranked: false, candidates: 2
      }),
      renderContext: ({ items }) => items.map(i => i.chunk.text).join("\n")
    },
    store: {
      forgetChunk: async (groupId, id) => id === "gy:1"
    }
  }
  const plugin = new SemanticMemoryPlugin()
  // 直接调方法:handleCommand 的运行时单例门槛在测试环境不可注入,缓存闭环才是测试对象
  await plugin.debugSearch(e, runtime, ".语义记忆 查询 星露谷")
  assert.ok(replies[0].includes("#1"), "查询结果应带序号")
  assert.ok(replies[0].includes("忘记 第N条"), "查询结果应提示纠错闭环用法")

  await plugin.forgetChunk(e, runtime, ".语义记忆 忘记 第1条")
  assert.ok(replies[1].includes("已忘记记忆 gy:1"), `实际回复:${replies[1]}`)

  await plugin.forgetChunk(e, runtime, ".语义记忆 忘记 第5条")
  assert.ok(replies[2].includes("超出范围"), `越界提示:${replies[2]}`)
})
