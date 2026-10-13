import {RedisStore as TypedRedisStore} from '../../../dist/backend/modules/memory/infrastructure/engine/redisStore.js'
export class RedisStore extends TypedRedisStore {constructor({redis=globalThis.redis}={}){super({redis})}}
