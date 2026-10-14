import {createRedisUtilities} from '../dist/backend/modules/shared/infrastructure/redisUtilities.js'
export const {redisExistKey,redisGetKey,redisSetKey,redisExistAndGetKey,redisExistAndInsertObject,redisExistAndUpdateObject,redisDeleteKey,redisGetAllKeys,redisExpireKey,redisTTLKey}=createRedisUtilities(()=>globalThis.redis)
