import {readUserSettings} from '../../utils/configWriter.js'
import {adCorpusStore} from './adCorpusStore.js'
import {GroupModerationManager as Runtime} from '../../dist/backend/modules/groupAdmin/infrastructure/GroupModerationManager.js'
export {extractCardSegmentText,getSegmentText,isIgnoredBotUser} from '../../dist/backend/modules/groupAdmin/infrastructure/GroupModerationManager.js'
export class GroupModerationManager extends Runtime {constructor(){super({readSettings:readUserSettings,getBot:()=>globalThis.Bot,logger:globalThis.logger},adCorpusStore)}}
export const groupModerationManager=new GroupModerationManager()
