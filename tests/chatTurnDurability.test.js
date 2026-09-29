import test from "node:test"
import assert from "node:assert/strict"
import {
  buildChatTurnKey,
  serializeChatTurnEnvelope,
  rebuildChatTurnEvent,
  createChatTurnDurability
} from "../utils/chatTurnDurability.js"

function createFakeRedis() {
  const data = new Map()
  const expiresAt = new Map()
  const purge = key => {
    const at = expiresAt.get(key)
    if (at && at <= Date.now()) { data.delete(key); expiresAt.delete(key) }
  }
  return {
    data,
    expiresAt,
    async get(key) { purge(key); return data.get(String(key)) ?? null },
    async set(key, value, options = {}) {
      purge(key)
      if (options.NX && data.has(key)) return null
      data.set(String(key), String(value))
      if (options.PX) expiresAt.set(String(key), Date.now() + Number(options.PX))
      else if (options.EX) expiresAt.set(String(key), Date.now() + Number(options.EX) * 1000)
      return "OK"
    },
    async del(key) { return data.delete(String(key)) ? 1 : 0 },
    async *scanIterator({ MATCH = "*" } = {}) {
      const prefix = MATCH.replace(/\*$/, "")
      for (const key of [...data.keys()]) {
        purge(key)
        if (data.has(key) && key.startsWith(prefix)) yield key
      }
    }
  }
}

function event(overrides = {}) {
  return {
    group_id: 123,
    user_id: 456,
    message_id: 789,
    msg: "你好，帮我看看这个",
    raw_message: "你好，帮我看看这个",
    message: [{ type: "text", data: { text: "你好，帮我看看这个" } }],
    sender: { user_id: 456, card: "测试", nickname: "测试", role: "member" },
    time: 1700000000,
    ...overrides
  }
}

function makeDurability(redis, config = {}) {
  return createChatTurnDurability({ redis, logger: { info() {}, warn() {}, error() {} }, getConfig: () => config })
}

test("beginTurn persists an envelope keyed by group+message; completeTurn removes it", async () => {
  const redis = createFakeRedis()
  const durability = makeDurability(redis)
  const e = event()
  assert.equal(await durability.beginTurn(e), true)
  const raw = await redis.get("ytbot:chat_turn:123:789")
  assert.ok(raw, "turn record should exist")
  const envelope = JSON.parse(raw)
  assert.equal(envelope.group_id, 123)
  assert.equal(envelope.msg, "你好，帮我看看这个")
  assert.equal(envelope.sender.card, "测试")
  assert.equal(await durability.pendingTurnCount(), 1)
  await durability.completeTurn(e)
  assert.equal(await durability.pendingTurnCount(), 0)
})

test("beginTurn skips auto_media events and disabled config; no group returns false", async () => {
  const redis = createFakeRedis()
  const durability = makeDurability(redis)
  assert.equal(await durability.beginTurn(event({ _triggerContext: { mode: "auto_media" } })), false)
  assert.equal(await durability.beginTurn(event({ group_id: undefined })), false)
  const disabled = makeDurability(redis, { enabled: false })
  assert.equal(await disabled.beginTurn(event()), false)
  assert.equal(await durability.pendingTurnCount(), 0)
})

test("claimReply is once-only per turn and per-process marker bypasses redis", async () => {
  const redis = createFakeRedis()
  const durability = makeDurability(redis)
  const e = event()
  const first = await durability.claimReply(e)
  assert.equal(first.claimed, true)
  assert.equal(e._replyClaimed, true)
  // 第二个执行者（补跑进程/并发）拿同一 turnKey：认领失败
  const second = await durability.claimReply(event())
  assert.equal(second.claimed, false)
  // 同一事件对象（分段发送第二段）：进程内标记直接放行
  const again = await durability.claimReply(e)
  assert.equal(again.claimed, true)
})

test("claimReply fails open when redis errors", async () => {
  const broken = { set: () => { throw new Error("redis down") }, get: () => { throw new Error("redis down") }, del: () => { throw new Error("redis down") } }
  const durability = makeDurability(broken)
  const claim = await durability.claimReply(event())
  assert.equal(claim.claimed, true)
  assert.equal(await durability.beginTurn(event()), false)
  await durability.completeTurn(event()) // 不抛
})

test("recoverPending: young unanswered turn is redispatched, replied/stale/invalid cleaned", async () => {
  const redis = createFakeRedis()
  const durability = makeDurability(redis)
  // 1) 新鲜未回复 → 补跑
  await redis.set("ytbot:chat_turn:100:1", JSON.stringify({ ...serializeChatTurnEnvelope(event({ group_id: 100, message_id: 1 })), turnStartedAt: Date.now() - 5000 }), { EX: 600 })
  // 2) 已回复 → 清理不补跑
  await redis.set("ytbot:chat_turn:100:2", JSON.stringify({ ...serializeChatTurnEnvelope(event({ group_id: 100, message_id: 2 })), turnStartedAt: Date.now() - 5000 }), { EX: 600 })
  await redis.set("ytbot:chat_turn_replied:100:2", "1", { EX: 600 })
  // 3) 过期 → 丢弃
  await redis.set("ytbot:chat_turn:100:3", JSON.stringify({ ...serializeChatTurnEnvelope(event({ group_id: 100, message_id: 3 })), turnStartedAt: Date.now() - 999999 }), { EX: 600 })
  // 4) 损坏 → 清理
  await redis.set("ytbot:chat_turn:100:4", "not-json", { EX: 600 })

  const dispatched = []
  const counts = await durability.recoverPending({ redispatch: async envelope => dispatched.push(envelope) })
  assert.equal(counts.redispatched, 1)
  assert.equal(counts.replied, 1)
  assert.equal(counts.stale, 1)
  assert.equal(counts.invalid, 1)
  assert.equal(dispatched[0].group_id, 100)
  assert.equal(dispatched[0].msg, "你好，帮我看看这个")
  assert.equal(await durability.pendingTurnCount(), 0)
})

test("rebuildChatTurnEvent binds reply to Bot.pickGroup and keeps recovery marker", async () => {
  const sent = []
  globalThis.Bot = { pickGroup: gid => ({ sendMsg: async (payload, quote) => { sent.push({ gid, payload, quote }); return { message_id: 1 } } }) }
  try {
    const envelope = serializeChatTurnEnvelope(event())
    const e = rebuildChatTurnEvent(envelope)
    assert.equal(e._turnRecovery, true)
    assert.equal(e.group_id, 123)
    assert.deepEqual(e.message[0], { type: "text", data: { text: "你好，帮我看看这个" } })
    await e.reply("hi", true)
    assert.deepEqual(sent, [{ gid: 123, payload: "hi", quote: true }])
    assert.equal(rebuildChatTurnEvent({ group_id: 0 }), null)
  } finally {
    delete globalThis.Bot
  }
})

test("buildChatTurnKey prefers message id and falls back to content hash", () => {
  assert.equal(buildChatTurnKey(event()), "123:789")
  const noId = event({ message_id: "" })
  const key = buildChatTurnKey(noId)
  assert.match(key, /^123:h[0-9a-z]+$/)
  // 同内容同时刻稳定，不同内容不同 key
  assert.equal(key, buildChatTurnKey(event({ message_id: "" })))
  assert.notEqual(key, buildChatTurnKey(event({ message_id: "", msg: "另一句话" })))
  assert.equal(buildChatTurnKey({ group_id: "" }), "")
})
