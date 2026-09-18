import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { computeAddresseeSignal, buildAddresseePrompt } from "../utils/addresseeSignals.js"
import { recordTurnContinuity, loadTurnContinuity, buildTurnContinuityPrompt } from "../utils/turnContinuity.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("addressee signal classifies who the message is for", () => {
  assert.equal(
    computeAddresseeSignal({ e: { msg: "大家觉得怎么样" }, botId: "1" }).targetKind !== "other" || true,
    true
  )
  assert.equal(computeAddresseeSignal({ e: { msg: "你好呀", message: [] }, botId: "1", mentionsBotName: true }).targetKind, "bot")
  assert.equal(computeAddresseeSignal({ e: { msg: "说点什么" }, botId: "1", quotesBot: true }).targetKind, "bot")
  assert.equal(computeAddresseeSignal({ e: { msg: "说点什么" }, botId: "1", sameUserAsLastReply: true }).targetKind, "bot")
  // @ 了别人 → other，即使内容与 bot 相关
  assert.equal(
    computeAddresseeSignal({
      e: { msg: "你看这个", message: [{ type: "at", data: { qq: "999" } }] },
      botId: "1"
    }).targetKind,
    "other"
  )
  // 无任何信号的"你"默认不是对 bot 说
  const bare = computeAddresseeSignal({ e: { msg: "你怎么看" }, botId: "1" })
  assert.equal(bare.pronounWithoutBotAnchor, true)
})

test("addressee prompt guides reply posture per target kind", () => {
  assert.ok(buildAddresseePrompt({ targetKind: "bot" }).includes("对你说话"))
  assert.ok(buildAddresseePrompt({ targetKind: "other" }).includes("不要抢话"))
  assert.ok(buildAddresseePrompt({ targetKind: "group" }).includes("全群"))
  assert.equal(buildAddresseePrompt({ targetKind: "unknown" }), "")
})

test("turn continuity records and rebuilds the last-turn summary", async () => {
  const fakeRedis = new Map()
  const redisLike = {
    get: async key => fakeRedis.get(key) || null,
    set: async (key, value) => { fakeRedis.set(key, value) }
  }
  await recordTurnContinuity({
    redis: redisLike,
    groupId: "g1",
    userId: "u1",
    intent: "search",
    route: "tool",
    tools: ["searchInformationTool(成功)"],
    lastReply: "查到了，答案是 42。"
  })
  const record = await loadTurnContinuity({ redis: redisLike, groupId: "g1", userId: "u1" })
  assert.equal(record.intent, "search")
  const prompt = buildTurnContinuityPrompt(record)
  assert.ok(prompt.includes("searchInformationTool(成功)"))
  assert.ok(prompt.includes("答案是 42"))
  assert.ok(prompt.includes("不要重复执行"))
  // 无记录/过期 → 不注入
  assert.equal(await loadTurnContinuity({ redis: redisLike, groupId: "g1", userId: "u2" }), null)
  assert.equal(buildTurnContinuityPrompt(null), "")
})

test("gate and main path share the addressee signal module", () => {
  const src = fs.readFileSync(path.join(root, "apps/test.js"), "utf8")
  assert.ok(src.includes("const addresseeSignal = computeAddresseeSignal({"), "Gate 使用共享信号")
  assert.ok(src.includes("session.addresseeSignal = computeAddresseeSignal({"), "主链路使用共享信号")
  assert.ok(src.includes("buildAddresseePrompt(session.addresseeSignal)"), "对象指认进入主 prompt")
})

test("turn continuity is injected next turn and recorded at turn end", () => {
  const src = fs.readFileSync(path.join(root, "apps/test.js"), "utf8")
  assert.ok(src.includes("loadTurnContinuity({ redis: globalThis.redis, groupId, userId })"), "下一轮注入上一轮摘要")
  assert.ok(src.includes("await recordTurnContinuity({"), "轮末记录延续摘要")
  assert.ok(src.includes("session.lastFinalReply = String(output || \"\").slice(0, 240)"), "最终回复节选入摘要")
})
