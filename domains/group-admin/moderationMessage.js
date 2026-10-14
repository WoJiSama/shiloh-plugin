import {groupModerationManager} from "./GroupModerationManager.js"
import {adCorpusStore} from "./adCorpusStore.js"
import {createGroupModerationMessage} from "../../dist/backend/modules/groupAdmin/infrastructure/moderationMessage.js"
export const GroupModerationMessage=createGroupModerationMessage(plugin,groupModerationManager,adCorpusStore)
