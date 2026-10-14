import {readUserSettings} from '../../utils/configWriter.js'
import {GroupNoticeManager} from '../../dist/backend/modules/groupAdmin/infrastructure/GroupNoticeManager.js'
export const groupNoticeManager=new GroupNoticeManager({readSettings:readUserSettings,getBot:()=>globalThis.Bot,logger:globalThis.logger,at:id=>globalThis.segment?.at?.(id)||{type:'at',qq:id}})
