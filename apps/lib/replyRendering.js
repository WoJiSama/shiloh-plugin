import {createReplyRendering} from '../../dist/backend/modules/conversation/application/replyRendering.js'
import {shouldCancelProactiveReply} from '../../utils/proactiveReplyFreshness.js'
import {lastIncomingMsgAt,smartConversationKey} from './splitState.js'
import {applyOutputPersonaGuards} from '../../utils/outputGuardPipeline.js'
import {TotalTokens} from '../../functions/tools/CalculateToken.js'
import * as guard from '../../utils/forbiddenWordGuard.js'
const api=createReplyRendering({
 logger:{info:message=>globalThis.logger?.info?.(message),warn:message=>globalThis.logger?.warn?.(message),mark:message=>globalThis.logger?.mark?.(message),error:message=>globalThis.logger?.error?.(message)},
 bot:()=>globalThis.Bot||{},at:qq=>globalThis.segment.at(qq),lastIncoming:(groupId,e)=>lastIncomingMsgAt.get(smartConversationKey(groupId,e))||0,
 shouldCancelProactiveReply,applyOutputPersonaGuards,TotalTokens,guard,
 stats:()=>globalThis[Symbol.for('shiloh-plugin.message-pipeline.runtime')]?.stats||null
})
export const {sendObservedReply,sendSegmentedMessage,splitMessage,splitLongMessageByPunctuation,convertAtInString,findMember,processToolSpecificMessage}=api
