import {createRecallTool} from '../../dist/backend/modules/qqTools/infrastructure/RecallTool.js'
export const RecallTool=createRecallTool({getBot:()=>globalThis.Bot||globalThis.bot})
