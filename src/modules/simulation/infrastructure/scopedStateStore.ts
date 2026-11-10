import { randomUUID } from 'node:crypto'
import type { CharacterRedis } from './characterStore.js'

const queues = new WeakMap<object, Map<string, Promise<unknown>>>()
const COMMIT = 'if redis.call("GET", KEYS[1]) ~= ARGV[1] then return 0 end redis.call("SET", KEYS[2], ARGV[2]) redis.call("DEL", KEYS[1]) return 1'
const RELEASE = 'if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) else return 0 end'

/** Scope keys and strict schema validation are supplied by the owning service. */
export function createScopedStateStore<T>({ redis, key, empty, validate }: {
  redis: CharacterRedis; key: string; empty(): T; validate(value: unknown): T
}) {
  async function load(): Promise<T> {
    const raw = await redis.get(key)
    return raw === null ? empty() : validate(JSON.parse(raw))
  }
  async function update(mutate: (state: T) => T): Promise<T> {
    let queue = queues.get(redis)
    if (!queue) { queue = new Map(); queues.set(redis, queue) }
    const previous = queue.get(key) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(async () => {
      const token = randomUUID(), lock = `${key}:lock`
      let acquired = false
      if (redis.eval) {
        const deadline = Date.now() + 2500
        do {
          const result = await redis.set(lock, token, { NX: true, PX: 10_000 })
          acquired = result === 'OK' || result === true
          if (!acquired) await new Promise(resolve => setTimeout(resolve, 25))
        } while (!acquired && Date.now() < deadline)
        if (!acquired) throw new Error('角色扩展状态正忙')
      }
      try {
        const result = validate(mutate(structuredClone(await load())))
        if (redis.eval) {
          if (Number(await redis.eval(COMMIT, { keys: [lock, key], arguments: [token, JSON.stringify(result)] })) !== 1) throw new Error('角色扩展锁失效，未提交')
          acquired = false
        } else await redis.set(key, JSON.stringify(result))
        return result
      } finally { if (acquired) await redis.eval!(RELEASE, { keys: [lock], arguments: [token] }) }
    })
    queue.set(key, operation)
    try { return await operation } finally { if (queue.get(key) === operation) queue.delete(key) }
  }
  return { load, update }
}
