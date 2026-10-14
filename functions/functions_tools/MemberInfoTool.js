import {createMemberInfoTool} from '../../dist/backend/modules/qqTools/infrastructure/MemberInfoTool.js'
export const MemberInfoTool=createMemberInfoTool({getBot:()=>globalThis.Bot||globalThis.bot})
