import {groupNoticeManager} from "./GroupNoticeManager.js"
import {createGroupNoticeDecrease} from "../../dist/backend/modules/groupAdmin/infrastructure/noticeDecrease.js"
export const GroupNoticeDecrease=createGroupNoticeDecrease(plugin,groupNoticeManager)
