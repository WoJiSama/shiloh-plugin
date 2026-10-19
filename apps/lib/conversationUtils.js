import { normalizeIntentText } from "../../core/intent/messageIntent.js"
import { isExplicitAdminCollectionMentionRequest } from "../../utils/mentionRoleRouting.js"
import { filterToolsForEmojiExposure } from "../../utils/emojiToolPolicy.js"
import { isRealtimeInfoRequest } from "../../core/intent/messageIntent.js"
import { isExplicitSearchRequest } from "../../core/intent/messageIntent.js"
import { SEARCH_TOOL_NAMES } from "../../core/intent/messageIntent.js"
import { shouldExposeEmojiToolForMessage } from "../../utils/emojiToolPolicy.js"
import { isExplicitToolIntent } from "../../core/intent/messageIntent.js"
import { selectToolIntentCandidates } from '../../utils/toolIntentManifests.js'
import {createConversationUtils} from '../../dist/backend/modules/conversation/infrastructure/conversationUtils.js'
const utils=createConversationUtils({normalizeIntentText,isExplicitAdminCollectionMentionRequest,filterToolsForEmojiExposure,isRealtimeInfoRequest,isExplicitSearchRequest,SEARCH_TOOL_NAMES,shouldExposeEmojiToolForMessage,isExplicitToolIntent,selectToolIntentCandidates})
export const delay=utils.delay
export const getOrCreateGroupLimiter=utils.getOrCreateGroupLimiter
export const filterToolsForMessageIntent=utils.filterToolsForMessageIntent
export const toolConfigHasName=utils.toolConfigHasName
export const parseToolConfigEntry=utils.parseToolConfigEntry
