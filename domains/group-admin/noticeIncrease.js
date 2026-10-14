import {groupNoticeManager} from "./GroupNoticeManager.js"
import {createGroupNoticeIncrease} from "../../dist/backend/modules/groupAdmin/infrastructure/noticeIncrease.js"
export const GroupNoticeIncrease=createGroupNoticeIncrease(plugin,groupNoticeManager)
