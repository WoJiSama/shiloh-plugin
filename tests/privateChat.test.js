// 私聊功能单测:门禁(开关/白名单语义/节流)、违禁词作用域键(私聊按用户)、主回合防护合同
import { test, beforeEach } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  evaluatePrivateChatGate,
  normalizePrivateChatConfig,
  getPrivateChatCooldownState,
  __resetPrivateChatForTest
} from "../apps/lib/privateChat.js"
import {
  chatScopeKey,
  markConversationInterrupted,
  getConversationInterruptedAt,
  anchorEventConversation,
  isConversationInterrupted
} from "../utils/forbiddenWordGuard.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const PRIVATE_EVENT = { message_type: "private", user_id: 12345 }

beforeEach(() => __resetPrivateChatForTest())

test("门禁:默认关闭;开启后留空白名单=仅主人;白名单制;节流", () => {
  // 节流表按用户号隔离,各子场景用不同用户避免互相消费冷却
  const pv = uid => ({ message_type: "private", user_id: uid })
  assert.equal(evaluatePrivateChatGate({ config: {}, e: pv(1) }).reason, "disabled")
  assert.equal(evaluatePrivateChatGate({ config: { privateChat: { enabled: true } }, e: pv(2) }).reason, "master_only")
  assert.ok(evaluatePrivateChatGate({ config: { privateChat: { enabled: true } }, e: pv(3), isMaster: true }).allowed)
  assert.ok(evaluatePrivateChatGate({ config: { privateChat: { enabled: true, allowedUsers: ["4"] } }, e: pv(4) }).allowed)
  assert.equal(evaluatePrivateChatGate({ config: { privateChat: { enabled: true, allowedUsers: ["999"] } }, e: pv(5) }).reason, "not_allowed")
  // 非私聊事件一律拒绝
  assert.equal(evaluatePrivateChatGate({ config: { privateChat: { enabled: true } }, e: { message_type: "group", group_id: 1 } }).reason, "not_private")
  // 节流:冷却期内第二次拒绝
  const cfg = { privateChat: { enabled: true, allowedUsers: ["6"], cooldownSeconds: 3 } }
  let now = 1000000
  assert.ok(evaluatePrivateChatGate({ config: cfg, e: pv(6), now: now }).allowed)
  assert.equal(evaluatePrivateChatGate({ config: cfg, e: pv(6), now: now + 1000 }).reason, "cooldown")
  assert.ok(evaluatePrivateChatGate({ config: cfg, e: pv(6), now: now + 4000 }).allowed, "冷却过期恢复")
  // 冷却 0 = 不节流(同一用户连续两次都放行)
  const cfg0 = { privateChat: { enabled: true, allowedUsers: ["7"], cooldownSeconds: 0 } }
  assert.ok(evaluatePrivateChatGate({ config: cfg0, e: pv(7), now: now }).allowed)
  assert.ok(evaluatePrivateChatGate({ config: cfg0, e: pv(7), now: now }).allowed)
})

test("normalizePrivateChatConfig:非法值回默认", () => {
  const cfg = normalizePrivateChatConfig({ enabled: "yes", allowedUsers: "不是数组", cooldownSeconds: -5 })
  assert.equal(cfg.enabled, false)
  assert.deepEqual(cfg.allowedUsers, [])
  assert.equal(cfg.cooldownSeconds, 0)
})

test("违禁词作用域键:群=群号,私聊=用户号,锚点/中断在私聊语义下工作", () => {
  assert.equal(chatScopeKey({ group_id: 111, message_type: "group" }), "111")
  assert.equal(chatScopeKey(PRIVATE_EVENT), "private:12345")
  assert.equal(chatScopeKey({}), "")

  // 私聊回合:打锚点 → 用户发违禁词(由入口标记中断) → 回合作废
  const e = anchorEventConversation({ ...PRIVATE_EVENT })
  assert.equal(isConversationInterrupted(e), false)
  markConversationInterrupted(chatScopeKey(PRIVATE_EVENT))
  assert.ok(isConversationInterrupted(e), "私聊回合被同用户的中断掐掉")
  // 群聊事件不受私聊中断影响
  assert.equal(isConversationInterrupted(anchorEventConversation({ group_id: 999, message_type: "group" })), false)
})

test("主回合防护合同:私聊门禁双验/无工具/心情键/成员图防护/合并旁路(源码合同)", () => {
  const chatTurn = fs.readFileSync(path.join(root, "apps/lib/chatTurn.js"), "utf8")
  const testJs = fs.readFileSync(path.join(root, "apps/test.js"), "utf8")

  assert.ok(chatTurn.includes("evaluatePrivateChatGate({ config: host.config, e"), "主回合二次门禁(保护 #tool 直入)")
  assert.ok(chatTurn.includes("isPrivateChat ? [] : host.tools"), "私聊回合不带群工具")
  assert.ok(chatTurn.includes("isPrivateChat ? `private:${userId}` : groupId"), "心情冷却私聊按用户")
  assert.ok(chatTurn.includes("isPrivateChat ? null : (memberMap || await e.bot.pickGroup(groupId).getMemberMap())"), "私聊跳过群成员表")
  assert.ok(testJs.includes("if (e.message_type === \"private\") return await this.handlePrivateChat(e)"), "私聊入口分流")
  assert.ok(testJs.includes("markConversationInterrupted(scopeKey)"), "违禁词中断用作用域键")
})
