import { RedisJobStore as TypedRedisJobStore } from '../../dist/backend/modules/messaging/infrastructure/redisJobStore.js'
export { getMissingRedisJobCapabilities } from '../../dist/backend/modules/messaging/infrastructure/redisJobStore.js'
export class RedisJobStore extends TypedRedisJobStore { constructor(options = {}) { super({ redis: globalThis.redis, logger: globalThis.logger, ...options }) } }
