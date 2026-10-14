export interface LegacyMemoryRedis {
  scanIterator?(options: { MATCH: string; COUNT: number }): AsyncIterable<string | string[]>
  keys?(pattern: string): Promise<string[]>
  del(key: string): Promise<unknown>
}
export interface LegacyMemoryWipeOptions { dryRun?: boolean }
export type LegacyMemoryWipeResult = { wouldDelete: number; sample: string[] } | { deleted: number }

function defaultRedis(): LegacyMemoryRedis {
  const value = (globalThis as unknown as Record<string, unknown>).redis
  if (!value || typeof value !== 'object' || !('del' in value) || typeof value.del !== 'function' ||
      !((('scanIterator' in value) && typeof value.scanIterator === 'function') ||
        (('keys' in value) && typeof value.keys === 'function'))) {
    throw new Error('清理旧记忆需要 Redis 客户端')
  }
  return value as LegacyMemoryRedis
}

export async function wipeLegacyMemory(
  redis: LegacyMemoryRedis = defaultRedis(), { dryRun = true }: LegacyMemoryWipeOptions = {}
): Promise<LegacyMemoryWipeResult> {
  const pattern = 'ytbot:memory:*'
  const keys: string[] = []
  if (typeof redis.scanIterator === 'function') {
    for await (const key of redis.scanIterator({ MATCH: pattern, COUNT: 200 })) {
      keys.push(...(Array.isArray(key) ? key : [key]))
    }
  } else if (redis.keys) {
    keys.push(...await redis.keys(pattern))
  } else {
    throw new Error('Redis 客户端不支持扫描旧记忆键')
  }
  if (dryRun) return { wouldDelete: keys.length, sample: keys.slice(0, 10) }
  for (const key of keys) await redis.del(key)
  return { deleted: keys.length }
}
