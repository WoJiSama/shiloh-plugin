// 私聊门禁与节流:纯函数 + 每用户冷却表,供 test.js 私聊入口与 chatTurn 双重校验共用。
// 语义:enabled 默认关;allowedUsers 留空 = 仅主人可聊(防陌生人);非空 = 白名单制;
// 同一用户冷却期内只跑一轮,防刷屏。
export const DEFAULT_PRIVATE_CHAT_CONFIG = {
  enabled: false,
  allowedUsers: [],
  cooldownSeconds: 3
}

export function normalizePrivateChatConfig(raw = {}) {
  const config = { ...DEFAULT_PRIVATE_CHAT_CONFIG, ...(raw && typeof raw === "object" ? raw : {}) }
  config.enabled = config.enabled === true
  config.allowedUsers = Array.isArray(config.allowedUsers) ? config.allowedUsers.map(String) : []
  config.cooldownSeconds = Math.max(0, Number(config.cooldownSeconds) || 0)
  return config
}

const lastTurnAtByUser = new Map()

/**
 * 私聊回合门禁。返回 { allowed, reason } ;allowed=true 时节流表已被更新。
 * @param {object} options.config pluginSettings
 * @param {object} options.e 消息事件(取 user_id / message_type)
 * @param {boolean} options.isMaster e.isMaster
 * @param {number} options.now 可注入时钟(测试)
 */
export function evaluatePrivateChatGate({ config = {}, e = {}, isMaster = false, now = Date.now() } = {}) {
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
  if (cfg.cooldownSeconds > 0) {
    const last = lastTurnAtByUser.get(userId) || 0
    if (now - last < cfg.cooldownSeconds * 1000) return { allowed: false, reason: "cooldown" }
    lastTurnAtByUser.set(userId, now)
  }
  return { allowed: true, reason: "" }
}

export function getPrivateChatCooldownState(userId = "") {
  return lastTurnAtByUser.get(String(userId || "")) || 0
}

export function __resetPrivateChatForTest() {
  lastTurnAtByUser.clear()
}
