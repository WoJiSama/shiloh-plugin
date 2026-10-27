export interface PrivateConfig {enabled?:boolean;allowedUsers?:unknown[];cooldownSeconds?:number;quoteChance?:number;mergeMs?:number;allowEmojiTool?:boolean;allowTools?:unknown[]}
export interface PrivateEvent {message_type?:string;user_id?:string|number;self_id?:string|number;bot?:{uin?:string|number}}
let acceptedEvents = new WeakMap<PrivateEvent,{key:string;at:number}>()
// 私聊门禁与节流:纯函数 + 每用户冷却表,供 test.js 私聊入口与 chatTurn 双重校验共用。
// 语义:enabled 默认关;allowedUsers 留空 = 仅主人可聊(防陌生人);非空 = 白名单制;
// 同一用户冷却期内只跑一轮,防刷屏。
export const DEFAULT_PRIVATE_CHAT_CONFIG = {
  enabled: false,
  allowedUsers: [],
  // 冷却默认 0:连发节流交给主回合合并窗口(mergeMs)+发送节流器;
  // 3s 静默吞消息的旧行为是私聊体验硬伤(用户连发第二句石沉大海)
  cooldownSeconds: 0,
  // 私聊是一对一对话,引用基本无意义(群聊引用是为了让旁人知道在回谁);
  // 仅保留极低概率应对长间隔后的回顾式回复
  quoteChance: 0.05,
  // 连发合并窗口:用户连发几句并成一次回复,替代冷却静默吞掉
  mergeMs: 1200,
  // 私聊默认零工具,可开放表情包让对话不那么干
  allowEmojiTool: true,
  allowTools: [] as unknown[]
}

export function normalizePrivateChatConfig(raw:PrivateConfig = {}) {
  const config = { ...DEFAULT_PRIVATE_CHAT_CONFIG, ...(raw && typeof raw === "object" ? raw : {}) }
  config.enabled = config.enabled === true
  config.allowedUsers = Array.isArray(config.allowedUsers) ? config.allowedUsers.map(String) : []
  config.cooldownSeconds = Math.max(0, Number(config.cooldownSeconds) || 0)
  config.quoteChance = Math.min(1, Math.max(0, Number(config.quoteChance ?? DEFAULT_PRIVATE_CHAT_CONFIG.quoteChance)))
  config.mergeMs = Math.min(5000, Math.max(0, Number(config.mergeMs ?? DEFAULT_PRIVATE_CHAT_CONFIG.mergeMs)))
  config.allowEmojiTool = config.allowEmojiTool !== false
  // 私聊工具白名单：识图默认开放（修"私聊认不得图"——素材已收集但无工具可用）；
  // 表情包由 allowEmojiTool 开关并入同一张白名单（chatTurn 只看 allowTools）
  const userTools = Array.isArray(config.allowTools) ? config.allowTools : []
  const defaults = ['googleImageAnalysisTool']
  const emoji = config.allowEmojiTool !== false ? ['sendLocalEmojiTool'] : []
  config.allowTools = [...new Set([...userTools, ...defaults, ...emoji])] as unknown[]
  return config
}

const lastTurnAtByUser = new Map<string,number>()

/**
 * 私聊回合门禁。返回 { allowed, reason } ;allowed=true 时节流表已被更新。
 * @param {object} options.config pluginSettings
 * @param {object} options.e 消息事件(取 user_id / message_type)
 * @param {boolean} options.isMaster e.isMaster
 * @param {number} options.now 可注入时钟(测试)
 */
export function evaluatePrivateChatGate({ config = {}, e = {}, isMaster = false, now = Date.now() }:{config?:{privateChat?:PrivateConfig};e?:PrivateEvent;isMaster?:boolean;now?:number} = {}) {
  const cfg = normalizePrivateChatConfig(config.privateChat)
  if (e.message_type !== "private") return { allowed: false, reason: "not_private" }
  if (!cfg.enabled) return { allowed: false, reason: "disabled" }
  const userId = String(e.user_id || "")
  if (!userId) return { allowed: false, reason: "no_user" }
  if (cfg.allowedUsers.length) {
    if (!cfg.allowedUsers.includes(userId)) return { allowed: false, reason: "not_allowed" }
  } else if (!isMaster) {
    // 白名单留空 = 仅主人,防陌生人直接开启私聊骚扰
    return { allowed: false, reason: "master_only" }
  }
  const key = `${String(e.self_id ?? e.bot?.uin ?? '')}:${userId}`
  const prior = acceptedEvents.get(e)
  if (prior?.key === key && now - prior.at <= 30000) return { allowed: true, reason: '' }
  if (cfg.cooldownSeconds > 0) {
    const last = lastTurnAtByUser.get(key)
    if (last !== undefined && now - last < cfg.cooldownSeconds * 1000) return { allowed: false, reason: "cooldown" }
    lastTurnAtByUser.set(key, now)
  }
  acceptedEvents.set(e,{key,at:now})
  return { allowed: true, reason: "" }
}

export function getPrivateChatCooldownState(userId = "",botId = "") {
  return lastTurnAtByUser.get(`${botId}:${String(userId || "")}`) || 0
}

export function __resetPrivateChatForTest() {
  lastTurnAtByUser.clear()
  acceptedEvents = new WeakMap()
}
