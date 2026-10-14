import {groupGuardManager} from "./GroupGuardManager.js"
import {createGroupGuardDecrease} from "../../dist/backend/modules/groupAdmin/infrastructure/guardDecrease.js"
export const GroupGuardDecrease=createGroupGuardDecrease(plugin,groupGuardManager)
