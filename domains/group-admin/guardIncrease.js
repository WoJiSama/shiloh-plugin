import {groupGuardManager} from "./GroupGuardManager.js"
import {createGroupGuardIncrease} from "../../dist/backend/modules/groupAdmin/infrastructure/guardIncrease.js"
export const GroupGuardIncrease=createGroupGuardIncrease(plugin,groupGuardManager)
