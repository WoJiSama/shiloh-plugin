export interface MessageCacheOptions { cacheExpireSeconds?: unknown; cacheExpireMinutes?: unknown; cacheExpireDays?: unknown }
export const DEFAULT_MESSAGE_CACHE_TTL_SECONDS = 60 * 60
const MIN_MESSAGE_CACHE_TTL_SECONDS = 60

function positiveNumber(value: unknown) {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null
}

/**
 * 解析近期消息 Redis 的 TTL。秒 > 分钟 > 旧版天数，未配置时默认一小时。
 */
export function resolveMessageCacheTtlSeconds(options: MessageCacheOptions = {}) {
  const seconds = positiveNumber(options.cacheExpireSeconds)
  if (seconds) return Math.max(MIN_MESSAGE_CACHE_TTL_SECONDS, Math.floor(seconds))

  const minutes = positiveNumber(options.cacheExpireMinutes)
  if (minutes) return Math.max(MIN_MESSAGE_CACHE_TTL_SECONDS, Math.floor(minutes * 60))

  const days = positiveNumber(options.cacheExpireDays)
  if (days) return Math.max(MIN_MESSAGE_CACHE_TTL_SECONDS, Math.floor(days * 24 * 60 * 60))

  return DEFAULT_MESSAGE_CACHE_TTL_SECONDS
}
