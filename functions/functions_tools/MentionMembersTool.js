import {createMentionMembersTool} from '../../dist/backend/modules/qqTools/infrastructure/MentionMembersTool.js'
export const MentionMembersTool=createMentionMembersTool({getBot:()=>globalThis.Bot||globalThis.bot})
