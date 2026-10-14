import {createReminderRuntime} from '../../dist/backend/modules/qqTools/infrastructure/ReminderTool.js'
import {mcpManager} from '../../utils/MCPClient.js'
export const {ReminderTool,checkPendingReminders}=createReminderRuntime({redis:globalThis.redis,logger:globalThis.logger,mcpManager,getBot:id=>id ? (String(globalThis.Bot?.uin)===id ? globalThis.Bot : globalThis.Bot?.[id]) : globalThis.Bot})
