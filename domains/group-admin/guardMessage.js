import {groupGuardManager} from "./GroupGuardManager.js"
import {createGroupGuardMessage} from "../../dist/backend/modules/groupAdmin/infrastructure/guardMessage.js"
export const GroupGuardMessage=createGroupGuardMessage(plugin,groupGuardManager)
