import {randomUUID} from 'node:crypto'
import {createFinalReply} from '../../dist/backend/modules/conversation/application/finalReply.js'
import {extractModrinthForwardItems,stripModrinthForwardMarkers} from '../../utils/modrinth.js'
import {buildGenericChatFailureReply} from '../../utils/chatFailureReply.js'
import {applyOutputPersonaGuards} from '../../utils/outputGuardPipeline.js'
import {findRecentBotImage} from '../../utils/recentImageContinuation.js'
import {recordEpisode} from '../../utils/episodicMemory.js'
import {recordTurnContinuity as recordContinuity} from '../../utils/turnContinuity.js'
import {personaFeedbackManager} from '../../domains/memory/PersonaFeedbackManager.js'
import {globalStyleLearnerManager} from '../../domains/memory/GlobalStyleLearnerManager.js'
import {getActiveConversation,trackingConversationKey} from './strictConversation.js'
const api=createFinalReply({randomUUID,
 logger:{warn:(...args)=>globalThis.logger?.warn?.(...args),info:(...args)=>globalThis.logger?.info?.(...args),error:(...args)=>globalThis.logger?.error?.(...args)},bot:()=>globalThis.Bot||{},
 extractModrinthForwardItems,stripModrinthForwardMarkers,buildGenericChatFailureReply,applyOutputPersonaGuards,findRecentBotImage,recordEpisode,
 recordTurnContinuity:options=>recordContinuity({...options,redis:globalThis.redis}),getActiveConversation,trackingKey:trackingConversationKey,
 rememberPersonaReply:(event,text,source)=>personaFeedbackManager.rememberBotReply(event,text,source),rememberStyleReply:(event,text,config)=>globalStyleLearnerManager.rememberBotReply(event,text,config)
})
export const {handleTextResponse,updateEnhancedSystems,getFriendlyFailureMessage,sendFinalReplyAsTextImage}=api
