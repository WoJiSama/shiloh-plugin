import {createRedisFileRepository} from '../dist/backend/modules/conversation/infrastructure/redisFileRepository.js'
export const {loadData,saveData}=createRedisFileRepository({store:()=>globalThis.redis,log:message=>console.log(message),error:message=>console.error(message)})
