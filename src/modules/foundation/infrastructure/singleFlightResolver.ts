import { KeyedSerialQueue } from "../../messaging/infrastructure/keyedSerialQueue.js"

/**
 * 按 key 去重 + 全局串行执行的单飞解析器。
 * - 同 key 的进行中调用(含还在排队的)共享同一个 Promise
 * - 真值结果按 ttlMs 缓存;null/异常结果不缓存,下次调用立即重试
 * 适用场景:同一目标站点并发开多个页面会触发反爬(抖音浏览器解析)。
 */
export function createSingleFlightResolver<A extends unknown[], T>(task: (...args: A) => T | Promise<T>, { ttlMs = 60_000, now = Date.now }: { ttlMs?: number; now?: () => number } = {}) {
  const queue = new KeyedSerialQueue()
  const results = new Map<string, { promise: Promise<T>; expiresAt?: number }>()

  const resolve = (key: unknown, ...args: A) => {
    prune()
    const cacheKey = String(key || "default")
    const existing = results.get(cacheKey)
    if (existing) return existing.promise

    const promise = queue.run("single-flight", () => task(...args))
    const record: { promise: Promise<T>; expiresAt?: number } = { promise }
    results.set(cacheKey, record)
    void promise.then(
      result => {
        if (results.get(cacheKey) !== record) return
        if (result) record.expiresAt = now() + ttlMs
        else results.delete(cacheKey)
      },
      () => {
        if (results.get(cacheKey) === record) results.delete(cacheKey)
      }
    )
    prune()
    return promise
  }

  function prune(at = now()) {
    for (const [key, record] of results) {
      if (record.expiresAt !== undefined && record.expiresAt <= at) results.delete(key)
    }
  }

  resolve.clear = () => {
    results.clear()
  }
  return resolve
}
