// 发送节流:仅作用于 AI 聊天回复(agent_* 通道),按会话维护最小间隔 + 随机抖动,
// 消灭"等间隔秒回/零间隔连发"的机器人节拍指纹。
// 设计约束(用户拍板):
//   1) 只管 AI 聊天回复;命令、骰子等"本来就是机器人"的通道完全不经过本模块;
//   2) 耗时感知:距上次发送的间隔已超过最小间隔时(如生图 20s、长回合)零追加延迟;
//   3) fail-open:节流自身异常绝不阻断发送。
export const DEFAULT_SEND_PACING_CONFIG = Object.freeze({
  enabled: true,
  minIntervalMs: 3000,
  jitterMs: 5000,
  maxWaitMs: 15000,
  byBot: {}
})

export function normalizeSendPacingConfig(value = {}) {
  const number = (v, fallback, min = 0) => {
    const n = Number(v)
    return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback
  }
  const byBot = {}
  for (const [botId, override] of Object.entries(value?.byBot || {})) {
    if (!botId || !override || typeof override !== "object") continue
    byBot[String(botId)] = {
      enabled: override.enabled !== false,
      minIntervalMs: number(override.minIntervalMs, DEFAULT_SEND_PACING_CONFIG.minIntervalMs),
      jitterMs: number(override.jitterMs, DEFAULT_SEND_PACING_CONFIG.jitterMs),
      maxWaitMs: number(override.maxWaitMs, DEFAULT_SEND_PACING_CONFIG.maxWaitMs)
    }
  }
  return {
    enabled: value?.enabled !== false,
    minIntervalMs: number(value?.minIntervalMs, DEFAULT_SEND_PACING_CONFIG.minIntervalMs),
    jitterMs: number(value?.jitterMs, DEFAULT_SEND_PACING_CONFIG.jitterMs),
    maxWaitMs: number(value?.maxWaitMs, DEFAULT_SEND_PACING_CONFIG.maxWaitMs, 1000),
    byBot
  }
}

/** 只有 AI 聊天类通道参与节流;command/repeat 等豁免 */
export function isPacedChannel(channel = "") {
  return String(channel || "").startsWith("agent")
}

/**
 * 纯函数:计算本次发送前应等待的毫秒数。
 * elapsedMs = 距该会话上次聊天发送的实际间隔;Infinity 表示首条/无记录。
 */
export function computePacingDelayMs({ channel = "", elapsedMs = Number.POSITIVE_INFINITY, config = DEFAULT_SEND_PACING_CONFIG, random = Math.random } = {}) {
  if (!config?.enabled) return 0
  if (!isPacedChannel(channel)) return 0
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : Number.POSITIVE_INFINITY
  // 耗时感知:处理耗时已经把间隔拉够(生图/长回合),零追加
  if (elapsed >= config.minIntervalMs) return 0
  const base = config.minIntervalMs - elapsed
  const jitter = config.jitterMs > 0 ? random() * config.jitterMs : 0
  return Math.min(config.maxWaitMs, Math.ceil(base + jitter))
}

/** 按会话记间隔的节流器;now/sleep 可注入便于测试 */
export class SendPacer {
  constructor(config = {}, { now = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    this.setConfig(config)
    this.now = now
    this.sleep = sleep
    this.lastSendAt = new Map()
  }

  setConfig(config = {}) {
    this.config = normalizeSendPacingConfig(config)
  }

  key(e = {}) {
    // 锚点必须带 botId:多号体系下不同号的间隔画像互不覆盖
    const botId = String(e.self_id || e.bot?.uin || "bot")
    return e.group_id ? `b:${botId}:g:${e.group_id}` : `b:${botId}:u:${e.user_id || "unknown"}`
  }

  resolveConfig(e = {}) {
    const botId = String(e.self_id || e.bot?.uin || "")
    return (botId && this.config.byBot[botId]) || this.config
  }

  /** 发送前调用:需要间隔时等待,返回实际等待的毫秒数 */
  async before(e = {}, channel = "") {
    const config = this.resolveConfig(e)
    const key = this.key(e)
    const last = this.lastSendAt.get(key) || 0
    const elapsedMs = last ? this.now() - last : Number.POSITIVE_INFINITY
    const delay = computePacingDelayMs({ channel, elapsedMs, config })
    if (delay > 0) await this.sleep(delay)
    return delay
  }

  /** 发送完成后调用,记录本会话的最后聊天发送时刻 */
  markSent(e = {}, channel = "") {
    if (!isPacedChannel(channel)) return
    this.lastSendAt.set(this.key(e), this.now())
  }
}
