import { createRawTaskStore } from "../../dist/backend/adapters/rawTaskStore.js"
import { randomUUID } from "node:crypto"

const DEFAULT_EVENT_TTL_SECONDS = 6 * 60 * 60
const DEFAULT_DELIVERY_TTL_SECONDS = 24 * 60 * 60

export function getMissingRedisJobCapabilities(redis) {
  const missing = []
  for (const method of ["get", "set", "del", "eval"]) {
    if (typeof redis?.[method] !== "function") missing.push(method)
  }
  if (!["scanIterator", "scan", "keys"].some(method => typeof redis?.[method] === "function")) {
    missing.push("scan")
  }
  return missing
}

function parseJson(value) {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

export class RedisJobStore {
  constructor({
    redis = globalThis.redis,
    logger = globalThis.logger,
    prefix = "ytbot:message_pipeline:",
    eventTtlSeconds = DEFAULT_EVENT_TTL_SECONDS,
    deliveryTtlSeconds = DEFAULT_DELIVERY_TTL_SECONDS
  } = {}) {
    this.redis = redis
    this.logger = logger
    this.prefix = prefix
    this.eventTtlSeconds = Math.max(300, Number(eventTtlSeconds) || DEFAULT_EVENT_TTL_SECONDS)
    this.deliveryTtlSeconds = Math.max(3600, Number(deliveryTtlSeconds) || DEFAULT_DELIVERY_TTL_SECONDS)
    this.memory = new Map()
    this.rawStore = createRawTaskStore({ redis: () => this.redis, memory: this.memory })
  }

  key(kind, id) {
    return `${this.prefix}${kind}:${id}`
  }

  ttlFor(kind) {
    return kind === "delivery" ? this.deliveryTtlSeconds : this.eventTtlSeconds
  }

  async getRaw(key) {
    return await this.rawStore.getRaw(key)
  }

  async setRaw(key, value, options = {}) {
    return await this.rawStore.setRaw(key, value, options)
  }

  async delRaw(key) {
    return await this.rawStore.delRaw(key)
  }

  async create(kind, id, value) {
    const key = this.key(kind, id)
    const result = await this.setRaw(key, JSON.stringify(value), { NX: true, EX: this.ttlFor(kind) })
    return result !== null && result !== false
  }

  async get(kind, id) {
    return parseJson(await this.getRaw(this.key(kind, id)))
  }

  async save(kind, id, value) {
    await this.setRaw(this.key(kind, id), JSON.stringify(value), { EX: this.ttlFor(kind) })
    return value
  }

  async scanKeys(pattern) {
    if (!this.redis) {
      const prefix = pattern.replace(/\*$/, "")
      return [...this.memory.keys()].filter(key => key.startsWith(prefix))
    }
    if (typeof this.redis.scanIterator === "function") {
      const keys = []
      for await (const key of this.redis.scanIterator({ MATCH: pattern, COUNT: 200 })) {
        if (Array.isArray(key)) keys.push(...key.map(String))
        else keys.push(String(key))
      }
      return keys
    }
    if (typeof this.redis.scan === "function") {
      const keys = []
      let cursor = "0"
      do {
        const [nextCursor, batch = []] = await this.redis.scan(cursor, "MATCH", pattern, "COUNT", 200)
        cursor = String(nextCursor)
        keys.push(...batch.map(String))
      } while (cursor !== "0")
      return keys
    }
    return typeof this.redis.keys === "function" ? await this.redis.keys(pattern) : []
  }

  async list(kind) {
    const prefix = this.key(kind, "")
    const keys = await this.scanKeys(`${prefix}*`)
    const records = []
    for (const key of keys) {
      const record = parseJson(await this.getRaw(key))
      if (record) records.push(record)
    }
    return records
  }

  async acquireLock(kind, id, leaseMs) {
    const key = this.key(`lock:${kind}`, id)
    const token = randomUUID()
    const result = await this.setRaw(key, token, { NX: true, PX: Math.max(1000, Number(leaseMs) || 60000) })
    return result !== null && result !== false ? token : ""
  }

  async releaseLock(kind, id, token) {
    if (!token) return 0
    const key = this.key(`lock:${kind}`, id)
    if (!this.redis) {
      if (String(this.memory.get(key) || "") !== String(token)) return 0
      this.memory.delete(key)
      return 1
    }
    if (typeof this.redis.eval !== "function") {
      throw new Error("Redis 客户端不支持原子锁释放")
    }
    return await this.redis.eval(
      'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end',
      { keys: [key], arguments: [String(token)] }
    )
  }

  async extendLock(kind, id, token, leaseMs) {
    if (!token) return false
    const key = this.key(`lock:${kind}`, id)
    const ttl = Math.max(1000, Number(leaseMs) || 60000)
    if (!this.redis) {
      return String(this.memory.get(key) || "") === String(token)
    }
    if (typeof this.redis.eval !== "function") {
      throw new Error("Redis 客户端不支持原子锁续租")
    }
    const result = await this.redis.eval(
      'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("PEXPIRE", KEYS[1], ARGV[2]) else return 0 end',
      { keys: [key], arguments: [String(token), String(ttl)] }
    )
    return Number(result) === 1
  }

  async clearLock(kind, id) {
    await this.delRaw(this.key(`lock:${kind}`, id))
  }
}
