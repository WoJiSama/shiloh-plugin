import type { RedisJobClient, PipelineLogger } from '../../../contracts/pipeline.js'
import type { TaskStore, TaskWriteOptions } from '../../../contracts/taskStore.js'
import { createRawTaskStore } from '../../../adapters/rawTaskStore.js'
import { randomUUID } from "node:crypto"

const DEFAULT_EVENT_TTL_SECONDS = 6 * 60 * 60
const DEFAULT_DELIVERY_TTL_SECONDS = 24 * 60 * 60

export function getMissingRedisJobCapabilities(redis: RedisJobClient | null | undefined) {
  const missing = []
  for (const method of ["get", "set", "del", "eval"]) {
    if (typeof redis?.[method as keyof RedisJobClient] !== "function") missing.push(method)
  }
  if (!["scanIterator", "scan", "keys"].some(method => typeof redis?.[method as keyof RedisJobClient] === "function")) {
    missing.push("scan")
  }
  return missing
}

function parseJson<T>(value: unknown): T | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(String(value))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as T : null
  } catch {
    return null
  }
}

export class RedisJobStore {
  redis: RedisJobClient | null | undefined
  logger: PipelineLogger | undefined
  prefix: string
  eventTtlSeconds: number
  deliveryTtlSeconds: number
  memory: Map<string,string>
  rawStore: TaskStore
  constructor({
    redis,
    logger,
    prefix = "ytbot:message_pipeline:",
    eventTtlSeconds = DEFAULT_EVENT_TTL_SECONDS,
    deliveryTtlSeconds = DEFAULT_DELIVERY_TTL_SECONDS
  }: {redis?:RedisJobClient|null;logger?:PipelineLogger;prefix?:string;eventTtlSeconds?:number;deliveryTtlSeconds?:number} = {}) {
    this.redis = redis
    this.logger = logger
    this.prefix = prefix
    this.eventTtlSeconds = Math.max(300, Number(eventTtlSeconds) || DEFAULT_EVENT_TTL_SECONDS)
    this.deliveryTtlSeconds = Math.max(3600, Number(deliveryTtlSeconds) || DEFAULT_DELIVERY_TTL_SECONDS)
    this.memory = new Map()
    this.rawStore = createRawTaskStore({ redis: () => this.redis, memory: this.memory })
  }

  key(kind: string, id: string) {
    return `${this.prefix}${kind}:${id}`
  }

  ttlFor(kind: string) {
    return kind === "delivery" ? this.deliveryTtlSeconds : this.eventTtlSeconds
  }

  async getRaw(key: string) {
    return await this.rawStore.getRaw(key)
  }

  async setRaw(key: string, value: string, options: TaskWriteOptions = {}) {
    return await this.rawStore.setRaw(key, value, options)
  }

  async delRaw(key: string) {
    return await this.rawStore.delRaw(key)
  }

  async create(kind: string, id: string, value: object) {
    const key = this.key(kind, id)
    const result = await this.setRaw(key, JSON.stringify(value), { NX: true, EX: this.ttlFor(kind) })
    return result !== null && result !== false
  }

  async get<T extends object = Record<string, unknown>>(kind: string, id: string, validate?: (value: unknown) => value is T) {
    const value = parseJson<T>(await this.getRaw(this.key(kind, id)))
    return value && (!validate || validate(value)) ? value : null
  }

  async save<T extends object>(kind: string, id: string, value: T) {
    await this.setRaw(this.key(kind, id), JSON.stringify(value), { EX: this.ttlFor(kind) })
    return value
  }

  async scanKeys(pattern: string) {
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

  async list<T extends object = Record<string, unknown>>(kind: string, validate?: (value: unknown) => value is T) {
    const prefix = this.key(kind, "")
    const keys = await this.scanKeys(`${prefix}*`)
    const records = []
    for (const key of keys) {
      const record = parseJson<T>(await this.getRaw(key))
      if (record && (!validate || validate(record))) records.push(record)
    }
    return records
  }

  async acquireLock(kind: string, id: string, leaseMs: number) {
    const key = this.key(`lock:${kind}`, id)
    const token = randomUUID()
    const result = await this.setRaw(key, token, { NX: true, PX: Math.max(1000, Number(leaseMs) || 60000) })
    return result !== null && result !== false ? token : ""
  }

  async releaseLock(kind: string, id: string, token: string) {
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

  async extendLock(kind: string, id: string, token: string, leaseMs: number) {
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

  async clearLock(kind: string, id: string) {
    await this.delRaw(this.key(`lock:${kind}`, id))
  }
}
