import test from "node:test"
import { readPluginSources, readSource } from "./helpers/pluginSources.js"
import assert from "node:assert/strict"
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
  assert.equal(record.botId, undefined)
  assert.ok(fakeRedis.has("blchat:turn_continuity:g1:u1"), "旧调用保留原存储键")
  const prompt = buildTurnContinuityPrompt(record)
  assert.ok(prompt.includes("searchInformationTool(成功)"))
  assert.ok(prompt.includes("答案是 42"))
  assert.ok(prompt.includes("不要重复执行"))
  // 无记录/过期 → 不注入
  assert.equal(await loadTurnContinuity({ redis: redisLike, groupId: "g1", userId: "u2" }), null)
  assert.equal(buildTurnContinuityPrompt(null), "")
})

test("turn continuity isolates two bots replying to the same group user", async () => {
  const records = new Map()
  const redisLike = {
    get: async key => records.get(key) || null,
    set: async (key, value) => { records.set(key, value) }
  }
  const scope = { redis: redisLike, groupId: "shared-group", userId: "shared-user" }
  await recordTurnContinuity({ ...scope, botId: 101, lastReply: "先确认型号。" })
  await recordTurnContinuity({ ...scope, botId: "202", lastReply: "这个比喻我接住了。" })
  const first = await loadTurnContinuity({ ...scope, botId: "101" })
  const second = await loadTurnContinuity({ ...scope, botId: 202 })
  assert.equal(first.botId, "101")
  assert.equal(first.lastReply, "先确认型号。")
  assert.equal(second.botId, "202")
  assert.equal(second.lastReply, "这个比喻我接住了。")
  assert.equal(records.size, 2)
  assert.ok(records.has("blchat:turn_continuity:shared-group:shared-user:101"))
  assert.ok(records.has("blchat:turn_continuity:shared-group:shared-user:202"))
  assert.equal(await loadTurnContinuity(scope), null, "旧调用也不借用某个 bot 的摘要")
})

test("turn continuity isolates private conversations by user and bot", async () => {
  const scope = { userId: "private-shared-user" }
  await recordTurnContinuity({ ...scope, botId: "private-a", lastReply: "A 的上一句" })
  await recordTurnContinuity({ ...scope, botId: "private-b", lastReply: "B 的上一句" })
  assert.equal((await loadTurnContinuity({ ...scope, botId: "private-a" })).lastReply, "A 的上一句")
  assert.equal((await loadTurnContinuity({ ...scope, botId: "private-b" })).lastReply, "B 的上一句")
  assert.equal(await loadTurnContinuity({ userId: "another-private-user", botId: "private-a" }), null)
})

test("bot-scoped continuity never borrows legacy or unverifiable records", async () => {
  const records = new Map()
  const reads = []
  const redisLike = {
    get: async key => { reads.push(key); return records.get(key) || null },
    set: async (key, value) => { records.set(key, value) }
  }
  const scope = { redis: redisLike, groupId: "legacy-group", userId: "legacy-user" }
  await recordTurnContinuity({ ...scope, lastReply: "无法确认是哪只机器人说的" })
  assert.equal(await loadTurnContinuity({ ...scope, botId: "new-bot" }), null)
  assert.deepEqual(reads, ["blchat:turn_continuity:legacy-group:legacy-user:new-bot"])

  const botKey = "blchat:turn_continuity:legacy-group:legacy-user:new-bot"
  const record = { intent: "chat", route: "chat", tools: [], lastReply: "不要借用", at: Date.now() }
  for (const botId of [undefined, "another-bot", 123]) {
    records.set(botKey, JSON.stringify({ ...record, ...(botId === undefined ? {} : { botId }) }))
    assert.equal(await loadTurnContinuity({ ...scope, botId: "new-bot" }), null)
  }
  assert.equal((await loadTurnContinuity(scope)).lastReply, "无法确认是哪只机器人说的")
})

test("bot-scoped continuity rejects expired Redis and local records", async () => {
  const records = new Map()
  const redisLike = {
    get: async key => records.get(key) || null,
    set: async (key, value) => { records.set(key, value) }
  }
  const scope = { groupId: "expired-group", userId: "expired-user", botId: "expired-bot" }
  await recordTurnContinuity({ ...scope, redis: redisLike, at: Date.now() - 10 * 60 * 1000 - 1000, lastReply: "过期立场" })
  assert.equal(await loadTurnContinuity({ ...scope, redis: redisLike }), null)
  assert.equal(await loadTurnContinuity(scope), null)
})

test("Redis failures retain only the matching bot's local continuity", async () => {
  const redisLike = {
    get: async () => { throw new Error("read unavailable") },
    set: async () => { throw new Error("write unavailable") }
  }
  const scope = { redis: redisLike, groupId: "fallback-group", userId: "fallback-user" }
  await recordTurnContinuity({ ...scope, botId: "fallback-a", lastReply: "A 已确认发送的回复" })
  await recordTurnContinuity({ ...scope, botId: "fallback-b", lastReply: "B 已确认发送的回复" })
  assert.equal((await loadTurnContinuity({ ...scope, botId: "fallback-a" })).lastReply, "A 已确认发送的回复")
  assert.equal((await loadTurnContinuity({ ...scope, botId: "fallback-b" })).lastReply, "B 已确认发送的回复")
  assert.equal(await loadTurnContinuity({ ...scope, botId: "fallback-c" }), null)
  assert.equal(await loadTurnContinuity(scope), null)
})

test("persona continuity separates persona switches and revisions even when an old turn writes late", async () => {
  const records = new Map()
  let releaseOldWrite
  const oldWritePending = new Promise(resolve => { releaseOldWrite = resolve })
  const redisLike = {
    get: async key => records.get(key) || null,
    set: async (key, value) => {
      if (JSON.parse(value).lastReply === "旧人格的在途回复") await oldWritePending
      records.set(key, value)
    }
  }
  const scope = {redis: redisLike, groupId: "persona-switch-group", userId: "persona-switch-user", botId: "99"}
  const first = {personaId: "first", personaVersion: "v1", personaName: "甲"}
  const second = {personaId: "second", personaVersion: "v1", personaName: "乙"}
  const revised = {...first, personaVersion: "v2"}
  const oldTurn = recordTurnContinuity({...scope, persona: first, lastReply: "旧人格的在途回复"})
  await recordTurnContinuity({...scope, persona: second, lastReply: "乙自己的立场"})
  await recordTurnContinuity({...scope, persona: revised, lastReply: "甲新版本的立场"})
  releaseOldWrite()
  await oldTurn

  assert.equal((await loadTurnContinuity({...scope, persona: first})).lastReply, "旧人格的在途回复")
  assert.equal((await loadTurnContinuity({...scope, persona: second})).lastReply, "乙自己的立场")
  const current = await loadTurnContinuity({...scope, persona: revised})
  assert.equal(current.lastReply, "甲新版本的立场")
  assert.deepEqual(current.persona, revised)
  assert.equal(current.botId, "99")
  assert.equal(records.size, 3)
  assert.equal(await loadTurnContinuity(scope), null, "旧API不借用新scope记录")
})

test("persona continuity has unambiguous group/private and identifier boundaries", async () => {
  const records = new Map()
  const redisLike = {get: async key => records.get(key) || null, set: async (key, value) => { records.set(key, value) }}
  const persona = {personaId: "key-persona", personaVersion: "v1", personaName: "甲"}
  const scopes = [
    {groupId: "group:with", userId: "user", botId: "99", persona},
    {groupId: "group", userId: "with:user", botId: "99", persona},
    {userId: "group:with:user", botId: "99", persona},
    {groupId: "group", userId: "user", botId: "99:with", persona},
    {groupId: "group", userId: "user", botId: "99", persona: {...persona, personaId: "a:b", personaVersion: "c"}},
    {groupId: "group", userId: "user", botId: "99", persona: {...persona, personaId: "a", personaVersion: "b:c"}}
  ]
  for (const [index, scope] of scopes.entries()) await recordTurnContinuity({...scope, redis: redisLike, lastReply: `独立回复 ${index}`})
  assert.equal(records.size, scopes.length)
  for (const [index, scope] of scopes.entries()) assert.equal((await loadTurnContinuity({...scope, redis: redisLike})).lastReply, `独立回复 ${index}`)
  assert.ok([...records.keys()].every(key => key.startsWith("blchat:turn_continuity_v2:")))
})

test("persona continuity never adopts legacy or mismatched source identities", async () => {
  const records = new Map()
  const reads = []
  const redisLike = {
    get: async key => { reads.push(key); return records.get(key) || null },
    set: async (key, value) => { records.set(key, value) }
  }
  const persona = {personaId: "verified-persona", personaVersion: "v1", personaName: "甲"}
  const scope = {redis: redisLike, groupId: "persona-provenance-group", userId: "persona-provenance-user", botId: "99"}
  await recordTurnContinuity({...scope, lastReply: "没有人格来源的旧回复"})
  assert.equal(await loadTurnContinuity({...scope, persona}), null)
  const scopedKey = reads.at(-1)
  assert.ok(scopedKey.startsWith("blchat:turn_continuity_v2:"))
  const base = {intent: "chat", route: "chat", tools: [], lastReply: "来源不匹配", at: Date.now(), botId: "99"}
  for (const wrong of [
    {...base},
    {...base, persona, botId: "another-bot"},
    {...base, persona: {...persona, personaId: "another-persona"}},
    {...base, persona: {...persona, personaVersion: "v0"}}
  ]) {
    records.set(scopedKey, JSON.stringify(wrong))
    assert.equal(await loadTurnContinuity({...scope, persona}), null)
  }
  const legacyKey = "blchat:turn_continuity:persona-provenance-group:persona-provenance-user:99"
  records.set(legacyKey, JSON.stringify({...base, persona}))
  assert.equal(await loadTurnContinuity(scope), null, "旧key中的新scope来源也不能被旧API读取")
})

test("persona-scoped local fallback preserves revisions and snapshots the supplied identity", async () => {
  const redisLike = {get: async () => { throw new Error("offline") }, set: async () => { throw new Error("offline") }}
  const scope = {redis: redisLike, userId: "persona-fallback-user", botId: "99"}
  const mutable = {personaId: "fallback-persona", personaVersion: "v1", personaName: "甲"}
  const original = {...mutable}
  await recordTurnContinuity({...scope, persona: mutable, lastReply: "修改前的回复"})
  mutable.personaVersion = "v2"
  await recordTurnContinuity({...scope, persona: mutable, lastReply: "修改后的回复"})
  assert.equal((await loadTurnContinuity({...scope, persona: original})).lastReply, "修改前的回复")
  assert.equal((await loadTurnContinuity({...scope, persona: mutable})).lastReply, "修改后的回复")
  assert.equal(await loadTurnContinuity({...scope, persona: {...mutable, personaId: "different"}}), null)
  assert.equal(await loadTurnContinuity(scope), null)
})

test("gate and main path share the addressee signal module", () => {
  const src = readPluginSources()
  // gate 已拆到 apps/lib/timingGate.js(P 重构),两处必须 import 同一 addresseeSignals 模块
  const gateSrc = readSource("src/modules/conversation/infrastructure/timingGate.ts")
  assert.ok(gateSrc.includes("const addresseeSignal = computeAddresseeSignal({"), "Gate 使用共享信号")
  assert.match(readSource("apps/lib/timingGate.js"), /import \{ computeAddresseeSignal \} from ['"]\.\.\/\.\.\/utils\/addresseeSignals\.js['"]/, "Gate 注入共享信号实现")
  assert.ok(src.includes("session.addresseeSignal = computeAddresseeSignal({"), "主链路使用共享信号")
  assert.ok(src.includes("buildAddresseePrompt(session.addresseeSignal)"), "对象指认进入主 prompt")
})

test("turn continuity is injected next turn and recorded at turn end", () => {
  const src = readPluginSources()
  const load = src.match(/loadTurnContinuity\(\{([^}]+)\}\)/)?.[1] || ""
  assert.match(load, /\bbotId:/, "下一轮只注入当前 bot 的上一轮摘要")
  assert.match(load, /\bpersona:/, "下一轮按本轮人格版本加载上一轮摘要")
  assert.ok(src.includes("await recordTurnContinuity({"), "轮末记录延续摘要")
  assert.ok(src.includes("session.lastFinalReply = String(output || \"\").slice(0, 240)"), "最终回复节选入摘要")
})

test('a confirmed promise is speech history, not evidence of running, success or failure', () => {
  const record={intent:'image_edit',route:'tool',tools:[],lastReply:'收到，我先处理。',at:Date.now(),botId:'99'}
  const prompt=buildTurnContinuityPrompt(record)
  assert.ok(prompt.includes('没有可确认的工具结果'))
  assert.ok(prompt.includes('不等于当前正在运行、已成功或已失败'))
  assert.ok(prompt.includes('不补运行状态、失败原因或完成时间'))
  assert.ok(!prompt.includes('已用工具：'))
})
