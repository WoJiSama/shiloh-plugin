// 私聊功能单测:门禁(开关/白名单语义/节流)、违禁词作用域键(私聊按用户)、主回合防护合同
import { test, beforeEach } from "node:test"
import { readPluginSources, readSource } from "./helpers/pluginSources.js"
import assert from "node:assert/strict"
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
  const chatTurn = readSource("src/modules/tools/infrastructure/chatTurn.ts")
  const testJs = readPluginSources()

  assert.ok(chatTurn.includes("evaluatePrivateChatGate({ config: host.config, e"), "主回合二次门禁(保护 #tool 直入)")
  assert.ok(chatTurn.includes("isPrivateChat ? privateTools : host.tools"), "私聊回合只带私聊工具(默认仅表情包)")
  assert.ok(chatTurn.includes("sendLocalEmojiTool"), "私聊开放表情包工具")
  assert.ok(chatTurn.includes("isPrivateChat ? `private:${userId}` : groupId"), "心情冷却私聊按用户")
  assert.ok(chatTurn.includes("isPrivateChat ? null : (memberMap || await e.bot.pickGroup(groupId).getMemberMap())"), "私聊跳过群成员表")
  assert.ok(readSource("src/modules/conversation/infrastructure/conversationEntryPolicy.ts").includes("markConversationInterrupted(scopeKey)"), "违禁词中断用作用域键")
})

test("compiled strict entry routes private events before touching group state", async () => {
 const {createStrictConversation}=await import('../dist/backend/modules/conversation/infrastructure/strictConversation.js')
 const event={message_type:'private',user_id:7}
 const result=await createStrictConversation({}).handleRandomReply({handlePrivateChat:async incoming=>{assert.equal(incoming,event);return 'private'}},event)
 assert.equal(result,'private')
})

test("私聊体验优化:措辞/历史标题/引用概率/状态隔离", async () => {
  // 1. 消息格式化:私聊不带群身份、不说"在群里说"
  const formatting = readSource("src/modules/conversation/application/messageFormatting.ts")
  assert.ok(formatting.includes('e?.message_type === "private"'), "格式化感知私聊")
  assert.ok(formatting.includes('"在群里"}说:'), "私聊措辞去掉'在群里'")
  // 2. 历史包装私聊标题
  const intelligence = readSource("src/modules/conversation/domain/agentIntelligence.ts")
  assert.ok(intelligence.includes("【私聊上下文】"), "历史标题有私聊变体")
  // 3. 引用概率:finalReply 私聊分支
  const finalReply = readSource("src/modules/conversation/application/finalReply.ts")
  assert.ok(finalReply.includes("resolveReplyQuoteChance"), "回复引用走场景分支")
  const { DEFAULT_PRIVATE_CHAT_CONFIG, normalizePrivateChatConfig } = await import("../dist/backend/modules/conversation/domain/privateChat.js")
  assert.equal(DEFAULT_PRIVATE_CHAT_CONFIG.quoteChance, 0.05, "私聊引用默认 0.05")
  assert.equal(normalizePrivateChatConfig({ quoteChance: 2 }).quoteChance, 1, "quoteChance 钳 0~1")
  assert.equal(DEFAULT_PRIVATE_CHAT_CONFIG.mergeMs, 1200, "合并窗口默认 1.2s")
  assert.equal(DEFAULT_PRIVATE_CHAT_CONFIG.cooldownSeconds, 0, "冷却默认 0(合并窗口替代静默吞)")
  // 4. smartKey 私聊按用户隔离
  const { smartConversationKey } = await import("../dist/backend/modules/conversation/domain/conversationIdentity.js")
  const keyA = smartConversationKey("", { self_id: 10001, message_type: "private", user_id: "111" })
  const keyB = smartConversationKey("", { self_id: 10001, message_type: "private", user_id: "222" })
  assert.notEqual(keyA, keyB, "不同私聊用户的会话键不同")
  assert.ok(String(keyA).includes("private:111"), "键含 private:userId")
  assert.equal(smartConversationKey(123, { self_id: 10001 }), "bot:10001:group:123", "群聊键不变")
  // 5. 情绪作用域私聊隔离
  const finalReplySrc = readSource("src/modules/conversation/application/finalReply.ts")
  assert.ok(finalReplySrc.includes("`private:${userId}` : groupId"), "情绪按 private:userId 隔离")
  // 6. 合并调度:私聊可合并+专属窗口
  const scheduling = readSource("src/modules/conversation/infrastructure/conversationScheduling.ts")
  assert.ok(scheduling.includes('message_type === "private"'), "调度感知私聊")
  const chatPluginSrc = readSource("src/modules/host/infrastructure/chatPlugin.ts")
  assert.ok(chatPluginSrc.includes('e.message_type !== "private"'), "合并调度放行私聊")
  // 7. 指认跳过 + 系统提示词措辞
  const chatTurnSrc = readSource("src/modules/tools/infrastructure/chatTurn.ts")
  assert.ok(chatTurnSrc.includes('isPrivateChat ? "" : buildAddresseePrompt'), "私聊跳过群向指认提示")
})
