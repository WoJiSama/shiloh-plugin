import {createChatHistoryTool} from '../../dist/backend/modules/qqTools/infrastructure/ChatHistoryTool.js'
export const ChatHistoryTool=createChatHistoryTool({getBot:()=>globalThis.Bot||globalThis.bot})
