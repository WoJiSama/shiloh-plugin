import {createMentionAdminsTool} from '../../dist/backend/modules/qqTools/infrastructure/MentionAdminsTool.js'
export const MentionAdminsTool=createMentionAdminsTool({getBot:()=>globalThis.Bot||globalThis.bot})
