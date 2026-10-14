import {createChatTurnDurabilityModule} from '../dist/backend/modules/conversation/application/chatTurnDurability.js'
export const {buildChatTurnKey,serializeChatTurnEnvelope,rebuildChatTurnEvent,createChatTurnDurability}=createChatTurnDurabilityModule({getBot:selfId=>globalThis.Bot?.[selfId] || globalThis.Bot,getRedis:()=>globalThis.redis,logger:globalThis.logger})
