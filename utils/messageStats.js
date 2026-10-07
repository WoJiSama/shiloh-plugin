// 消息统计埋点:收/发/失败计数按天/小时入 Redis(shiloh:stats:*),
// 为控制台统计页与封号哨兵提供行为基线。全部 fail-open:统计失败绝不影响消息链路。
//
// 键设计(基数有界,按 botId 分列,多号天然隔离):
//   shiloh:stats:d:YYYYMMDD  hash, TTL retentionDays
//     recv:{botId} / recv:{botId}:g:{groupId}
//     send:{botId} / send:{botId}:ch:{channel} / send:{botId}:g:{groupId}
//     fail:{botId} / fail:{botId}:{code}
//   shiloh:stats:h:YYYYMMDDHH hash, TTL 8 天,仅 recv/send 总量(日内趋势)

const HOUR_TTL_SECONDS = 8 * 86400

function pad2(value) {
  return String(value).padStart(2, "0")
}

export function statsDayKey(date = new Date()) {
  return `shiloh:stats:d:${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`
}

export function statsHourKey(date = new Date()) {
  return `shiloh:stats:h:${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}${pad2(date.getHours())}`
}

function normalizeBotId(botId) {
  return String(botId ?? "").trim() || "unknown"
}

function normalizeGroupId(groupId) {
  return String(groupId ?? "").trim()
}

export class MessageStatsEmitter {
  constructor({ redis = globalThis.redis, logger = globalThis.logger, enabled = true, retentionDays = 90 } = {}) {
    this.redis = redis || null
    this.logger = logger
    this.enabled = enabled !== false && Boolean(this.redis)
    this.retentionDays = Math.max(7, Math.floor(Number(retentionDays) || 90))
    this._expireScheduled = new Set()
  }

  // 批量 HINCRBY;同进程内每个桶只安排一次 EXPIRE
  async _bump(fields, { hourly = false } = {}) {
    if (!this.enabled || !fields.length) return
    const day = statsDayKey()
    const hour = statsHourKey()
    const ops = []
    const dayExpire = !this._expireScheduled.has(day)
    if (dayExpire) this._expireScheduled.add(day)
    const hourExpire = hourly && !this._expireScheduled.has(hour)
    if (hourExpire) this._expireScheduled.add(hour)
    for (const field of fields) {
      ops.push(this.redis.hincrby(day, field, 1))
      if (hourly) ops.push(this.redis.hincrby(hour, field, 1))
    }
    if (dayExpire) ops.push(this.redis.expire(day, this.retentionDays * 86400))
    if (hourExpire) ops.push(this.redis.expire(hour, HOUR_TTL_SECONDS))
    try {
      await Promise.all(ops)
    } catch (error) {
      this.logger?.warn?.(`[MessageStats] 写入失败(忽略): ${error?.message || error}`)
    }
  }

  /** 收到消息事件(envelope);非 message 事件与 bot 自身消息不计 */
  async recordReceive(envelope = {}) {
    if (!envelope || envelope.postType !== "message") return
    const botId = normalizeBotId(envelope.botId)
    if (envelope.userId && String(envelope.userId) === String(envelope.botId)) return
    const fields = [`recv:${botId}`]
    const groupId = normalizeGroupId(envelope.groupId)
    if (groupId) fields.push(`recv:${botId}:g:${groupId}`)
    await this._bump(fields, { hourly: true })
  }

  /** 成功发出一条消息;channel 例: chat / media_forward / command / private */
  async recordSend({ botId, groupId, channel = "unknown" } = {}) {
    const bot = normalizeBotId(botId)
    const ch = String(channel || "unknown").slice(0, 24)
    const fields = [`send:${bot}`, `send:${bot}:ch:${ch}`]
    const group = normalizeGroupId(groupId)
    if (group) fields.push(`send:${bot}:g:${group}`)
    await this._bump(fields, { hourly: true })
  }

  /** 发送失败;code 例: retcode:1006514 / reply_error / missing_bot */
  async recordFailure({ botId, channel = "unknown", code = "error" } = {}) {
    const bot = normalizeBotId(botId)
    const ch = String(channel || "unknown").slice(0, 24)
    const failCode = String(code || "error").slice(0, 40)
    await this._bump([
      `fail:${bot}`,
      `fail:${bot}:${failCode}`,
      `fail:${bot}:ch:${ch}`
    ])
  }

  async close() {
    this.enabled = false
  }
}

export function createStatsEmitterFromSettings({ redis = globalThis.redis, logger = globalThis.logger, settings = {} } = {}) {
  const cfg = settings?.stats || {}
  return new MessageStatsEmitter({
    redis,
    logger,
    enabled: cfg.enabled !== false,
    retentionDays: cfg.retentionDays
  })
}

/**
 * 汇总某天的统计(控制台/哨兵读取用)。
 * 返回 { day, bots: { [botId]: { recv, send, fail, failCodes, groups, channels } } }
 */
export async function readDailyStats(redis, { day = "" } = {}) {
  if (!redis?.hgetall) return { day: String(day || ""), bots: {} }
  const dayKey = day ? `shiloh:stats:d:${String(day).replace(/[^0-9]/g, "")}` : statsDayKey()
  const raw = await redis.hgetall(dayKey)
  const result = { day: dayKey.split(":").pop(), bots: {} }
  const ensureBot = botId => (result.bots[botId] ||= { recv: 0, send: 0, fail: 0, failCodes: {}, groups: {}, channels: {} })
  for (const [field, count] of Object.entries(raw || {})) {
    const value = Number(count) || 0
    const [kind, botId, mod, subject] = String(field).split(":")
    if (!kind || !botId) continue
    const bot = ensureBot(botId)
    if (kind === "recv") {
      if (mod === "g" && subject) {
        bot.groups[subject] ||= { recv: 0, send: 0 }
        bot.groups[subject].recv += value
      } else if (mod === undefined) {
        bot.recv += value
      }
    } else if (kind === "send") {
      if (mod === "ch") {
        bot.channels[subject || "unknown"] = (bot.channels[subject || "unknown"] || 0) + value
      } else if (mod === "g" && subject) {
        bot.groups[subject] ||= { recv: 0, send: 0 }
        bot.groups[subject].send += value
      } else if (mod === undefined) {
        bot.send += value
      }
    } else if (kind === "fail") {
      if (mod === undefined) {
        bot.fail += value
      } else if (mod !== "ch") {
        const failCode = String(field).split(":").slice(2).join(":")
        bot.failCodes[failCode] = (bot.failCodes[failCode] || 0) + value
      }
    }
  }
  return result
}
