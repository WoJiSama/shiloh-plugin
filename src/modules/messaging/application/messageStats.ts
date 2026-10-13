export interface StatsRedis { eval?(script: string, options: {keys: string[]; arguments: string[]}): Promise<unknown>; hgetall?(key: string): Promise<Record<string, unknown>> }
export interface StatsOptions { redis?: StatsRedis | null; logger?: {warn?(message: string): void} | undefined; enabled?: boolean; retentionDays?: unknown }
export interface BotStats {recv: number; send: number; fail: number; failCodes: Record<string,number>; groups: Record<string,{recv:number;send:number}>; channels: Record<string,number>}
// 消息统计埋点:收/发/失败计数按天/小时入 Redis(shiloh:stats:*),
// 为控制台统计页与封号哨兵提供行为基线。全部 fail-open:统计失败绝不影响消息链路。
//
// 键设计(基数有界,按 botId 分列,多号天然隔离):
//   shiloh:stats:d:YYYYMMDD  hash, TTL retentionDays
//     recv:{botId} / recv:{botId}:g:{groupId}
//     send:{botId} / send:{botId}:ch:{channel} / send:{botId}:g:{groupId}
//     fail:{botId} / fail:{botId}:{code}
//   shiloh:stats:h:YYYYMMDDHH hash, TTL 8 天,仅 recv/send 总量(日内趋势)
//
// Redis 兼容性:TRSS-Yunzai 的 globalThis.redis 是受限包装层(仅保证 get/set/del/eval/scan),
// 没有 hincrby/hgetall,因此所有写走 eval+Lua(与 redisJobStore 同款调用约定),
// 读取在有 hgetall 时直用,否则回落 eval。

const HOUR_TTL_SECONDS = 8 * 86400

const BUMP_LUA = [
  'redis.call("HINCRBY", KEYS[1], ARGV[1], 1)',
  'if redis.call("HLEN", KEYS[1]) == 1 then redis.call("EXPIRE", KEYS[1], ARGV[2]) end',
  'return 1'
].join(" ")

const HGETALL_LUA = 'local r = redis.call("HGETALL", KEYS[1]) local out = {} for i = 1, #r, 2 do out[#out + 1] = r[i] .. "=" .. r[i + 1] end return out'

function pad2(value: number) {
  return String(value).padStart(2, "0")
}

export function statsDayKey(date = new Date()) {
  return `shiloh:stats:d:${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}`
}

export function statsHourKey(date = new Date()) {
  return `shiloh:stats:h:${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}${pad2(date.getHours())}`
}

function normalizeBotId(botId: unknown) {
  return String(botId ?? "").trim() || "unknown"
}

function normalizeGroupId(groupId: unknown) {
  return String(groupId ?? "").trim()
}

export class MessageStatsEmitter {
 client: StatsRedis | null; logger: StatsOptions['logger']; enabled: boolean; retentionDays: number
  constructor({ redis: client = null, logger = undefined, enabled = true, retentionDays = 90 }: StatsOptions = {}) {
    this.client = client || null
    this.logger = logger
    this.enabled = enabled !== false && typeof this.client?.eval === "function"
    this.retentionDays = Math.max(7, Math.floor(Number(retentionDays) || 90))
  }

  _evalBump(key: string, field: string, ttlSeconds: number) {
    return this.client?.eval?.(BUMP_LUA, { keys: [key], arguments: [field, String(ttlSeconds)] })
  }

  // 整个方法体包在 try 里:构建与执行阶段的任何异常都不外泄
  async _bump(fields: string[], { hourly = false } = {}) {
    if (!this.enabled || !fields.length) return
    try {
      const ops = []
      for (const field of fields) {
        ops.push(this._evalBump(statsDayKey(), field, this.retentionDays * 86400))
        if (hourly) ops.push(this._evalBump(statsHourKey(), field, HOUR_TTL_SECONDS))
      }
      await Promise.all(ops)
    } catch (error) {
      this.logger?.warn?.(`[MessageStats] 写入失败(忽略): ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 收到消息事件(envelope);非 message 事件与 bot 自身消息不计 */
  async recordReceive(envelope: {postType?: string; botId?: unknown; userId?: unknown; groupId?: unknown} = {}) {
    if (!envelope || envelope.postType !== "message") return
    const botId = normalizeBotId(envelope.botId)
    if (envelope.userId && String(envelope.userId) === String(envelope.botId)) return
    const fields = [`recv:${botId}`]
    const groupId = normalizeGroupId(envelope.groupId)
    if (groupId) fields.push(`recv:${botId}:g:${groupId}`)
    await this._bump(fields, { hourly: true })
  }

  /** 成功发出一条消息;channel 例: chat / media_forward / command / private */
  async recordSend({ botId, groupId, channel = "unknown" }: {botId?: unknown; groupId?: unknown; channel?: string} = {}) {
    const bot = normalizeBotId(botId)
    const ch = String(channel || "unknown").slice(0, 24)
    const fields = [`send:${bot}`, `send:${bot}:ch:${ch}`]
    const group = normalizeGroupId(groupId)
    if (group) fields.push(`send:${bot}:g:${group}`)
    await this._bump(fields, { hourly: true })
  }

  /** 发送失败;code 例: retcode:1006514 / reply_error / missing_bot */
  async recordFailure({ botId, channel = "unknown", code = "error" }: {botId?: unknown; channel?: string; code?: string} = {}) {
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

export function createStatsEmitterFromSettings({ redis: client = null, logger = undefined, settings = {} }: StatsOptions & {settings?: {stats?: {enabled?: boolean; retentionDays?: unknown}}} = {}, Emitter: typeof MessageStatsEmitter = MessageStatsEmitter) {
  const cfg = settings?.stats || {}
  return new Emitter({
    redis: client,
    logger,
    enabled: cfg.enabled !== false,
    retentionDays: cfg.retentionDays
  })
}

/** 读取天桶原始 hash;受限 client 上回落 eval(HGETALL) */
async function readHash(client: StatsRedis, key: string): Promise<Record<string, unknown>> {
  if (typeof client.hgetall === "function") return await client.hgetall(key)
  if (typeof client.eval !== "function") return {}
  const flat = await client.eval(HGETALL_LUA, { keys: [key], arguments: [] })
  const hash: Record<string, unknown> = {}
  for (const entry of Array.isArray(flat) ? flat : []) {
    const index = String(entry).indexOf("=")
    if (index > 0) hash[String(entry).slice(0, index)] = String(entry).slice(index + 1)
  }
  return hash
}

/**
 * 汇总某天的统计(控制台/哨兵读取用)。
 * 返回 { day, bots: { [botId]: { recv, send, fail, failCodes, groups, channels } } }
 */
export async function readDailyStats(client: StatsRedis | null | undefined, { day = "" } = {}) {
  if (!client) return { day: String(day || ""), bots: {} }
  const dayKey = day ? `shiloh:stats:d:${String(day).replace(/[^0-9]/g, "")}` : statsDayKey()
  const raw = await readHash(client, dayKey)
  const result: {day: string; bots: Record<string, BotStats>} = { day: dayKey.split(":").pop() || "", bots: {} }
  const ensureBot = (botId: string) => (result.bots[botId] ||= { recv: 0, send: 0, fail: 0, failCodes: {}, groups: {}, channels: {} })
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
