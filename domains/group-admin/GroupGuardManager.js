import {readUserSettings} from '../../utils/configWriter.js'
import {GroupGuardManager} from '../../dist/backend/modules/groupAdmin/infrastructure/GroupGuardManager.js'
export const groupGuardManager=new GroupGuardManager({readSettings:readUserSettings,getBot:()=>globalThis.Bot,logger:globalThis.logger,at:id=>globalThis.segment?.at?.(id)||{type:'at',qq:id}})
