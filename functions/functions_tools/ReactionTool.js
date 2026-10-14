import {createReactionTool} from '../../dist/backend/modules/qqTools/infrastructure/ReactionTool.js'
export const ReactionTool=createReactionTool({getBot:()=>globalThis.Bot||globalThis.bot})
