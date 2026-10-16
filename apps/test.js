import {createChatPlugin} from '../dist/backend/modules/host/infrastructure/chatPlugin.js'
import {createHostSharedState} from '../dist/backend/modules/host/infrastructure/hostSharedState.js'
import {handleTextResponse,updateEnhancedSystems,getFriendlyFailureMessage,sendFinalReplyAsTextImage} from './lib/finalReply.js'
import {formatMemoryFactLines,formatMemoryFacts,replyMemoryForward,replyLongForward} from './lib/memoryReplies.js'
import {checkPendingReminders} from '../functions/functions_tools/ReminderTool.js'
import {YTapi} from '../utils/apiClient.js'
import {mcpManager} from '../utils/MCPClient.js'
import {pluginBridge} from '../utils/pluginBridge.js'
import {formatTurnDiagnosticsText} from '../utils/turnDiagnostics.js'
import {analyzeReplyText} from '../utils/SmartReply.js'
import {resolveToolRequestMergeMs} from '../utils/toolIntentManifests.js'
import {installObservabilityLog} from '../utils/obsLog.js'
import {createChatTurnDurability,rebuildChatTurnEvent} from '../utils/chatTurnDurability.js'
import {resolveLongTaskFeedbackPolicy} from '../utils/longTaskFeedbackPolicy.js'
import {findForbiddenWord,anchorEventConversation,markConversationInterrupted,chatScopeKey} from '../utils/forbiddenWordGuard.js'
import {getSmartRuntimeState,smartRuntimeGroupIds,smartRuntimeSize,hasSmartRuntimeState,registerGroupRuntimeProviders,registerRuntimeSweep,runRuntimeSweeps} from '../core/runtime/groupRuntime.js'
import {mcpStatus,testMCPTool,isChatManager,forbiddenWordList,handleForbiddenList,handleForbiddenAdd,handleForbiddenRemove,resolvePersonaTargetGroup,formatPersonaDetail,handlePersonaList,handlePersonaCurrent,handlePersonaDetail,handlePersonaSwitch,handlePersonaReset,handlePersonaSave,handlePersonaDelete,handlePersonaReload,handlePersonaBindings} from './lib/adminCommands.js'
import {resolveConversationPhase,applyRateLimitGuard,resolveTalkValue,idleCompensationMet,computeAvgReplyLatency,recordReplyLatency,computeGroupMsgRate5min,getDirectTriggerMergeMs,getDirectTriggerMergeMaxMessages} from './lib/smartDynamics.js'
import {runTimingGate as runTimingGateFn} from './lib/timingGate.js'
import {handleRandomReplySmart as handleRandomReplySmartFn} from './lib/smartConversation.js'
import {setTrackingWithTimer,joinRepeat,detectGroupRepeat,isUserTalkingToBot,addToBatchJudgment,processBatchJudgments,batchIsUserTalkingToBot,fallbackToSingleJudgment,handleRandomReply} from './lib/strictConversation.js'
import {getTaskStatusCacheKey,getTaskStatusRedisKey,getActiveToolTaskCacheKey,getActiveToolTaskRedisKey,getTaskStatusTtlSeconds,saveTaskStatus,getTaskStatus,getTurnActionFacts,clearTaskStatus,updateUserToolTaskStatus,getUserToolTaskStatus,clearUserToolTaskStatus,getRuntimeToolTaskStatus,getCurrentUserToolTaskStatus,buildDrawTaskStatusReply,buildReplySegment,buildTaskStatusReplyMessage,handleActiveDrawStatusQuestion,formatTaskStatusForPrompt} from './lib/taskStatus.js'
import {formatTime,buildMessageContent,formatMessages} from './lib/messageFormatting.js'
import {handleToolInner as handleToolInnerFn} from './lib/chatTurn.js'
import {parseToolConfigEntry} from './lib/conversationUtils.js'
import {prewarmModrinthCardRenderer,renderModrinthCard} from '../utils/ModrinthCardRenderer.js'
import {shouldUseSemanticToolIntent,normalizeToolDecision,classifySemanticToolIntent,buildToolCallFromDecision,buildMissingToolCommitmentCall,extractJsonObject} from './lib/semanticToolIntent.js'
import {getQuotedPromptContextText,getRecentPromptContextText,getRecentDrawContextText,resolveContextualDrawGeneration,getUnderstandingEnhancementConfig,shouldInjectUnderstandingContext,extractForwardContextFromUserContent,gatherUnderstandingMaterials,resolveUnderstandingPrompt,buildUnderstandingContextPrompt,buildImageGenerationPrompt,getImageGenerationReferenceImages,buildImageEditPrompt} from './lib/promptContext.js'
import {sendObservedReply,sendSegmentedMessage,splitMessage,splitLongMessageByPunctuation,convertAtInString,findMember,processToolSpecificMessage} from './lib/replyRendering.js'
import {normalizeAssistantToolMessage,serializeToolResult,getToolCallName,shouldRunTerminalToolsInBackground,buildGroundedImageAnalysisPrompt,extractToolResultText,buildImageVerificationSearchToolCall,startBackgroundTerminalToolCalls,runToolCall,dedupeToolCalls,processToolCalls,executeTool} from './lib/toolExecution.js'
import chokidar from 'chokidar'
import schedule from 'node-schedule'
import {EmotionManager} from '../domains/memory/EmotionManager.js'
import {MemoryManager} from '../domains/memory/MemoryManager.js'
import {ExpressionLearner} from '../domains/memory/ExpressionLearner.js'
import {MessageManager} from '../utils/MessageManager.js'
import {messageArchiveManager} from '../utils/MessageArchiveManager.js'
import {localToolRegistry} from '../utils/LocalToolRegistry.js'
import {installSemanticMemoryRuntime} from '../domains/semanticMemory/runtime.js'
import {installMidtermMemoryRuntime} from '../domains/midtermMemory/MidtermSummaryManager.js'
import {setSharedRuntime} from '../core/runtime/sharedRuntime.js'
import {loadData,saveData} from '../utils/redisClient.js'
import {toolConfigHasName} from './lib/conversationUtils.js'
import {createConversationHistory} from '../dist/backend/modules/conversation/infrastructure/conversationHistory.js'
const logger=globalThis.logger
const redis=globalThis.redis
const conversationHistory=createConversationHistory({loadData,saveData,deleteKey:key=>redis.del(key),debug:message=>logger.debug?.(message),error:(message,error)=>logger.error?.(message,error)})
const shared=createHostSharedState({
 cwd:process.cwd(),MessageManager,MemoryManager,EmotionManager,ExpressionLearner,localToolRegistry,logger,
 toolConfigHasName,scheduleJob:(expression,work)=>schedule.scheduleJob(expression,work),
 publishState:state=>{pluginBridge.sharedState=state},
 installRuntime:(config,state)=>{
  setSharedRuntime({memoryManager:state.memoryManager,getConfig:()=>config})
  installSemanticMemoryRuntime({pluginSettings:config,archiveManager:messageArchiveManager})
  installMidtermMemoryRuntime({pluginSettings:config,archiveManager:messageArchiveManager})
 }
})

export const {ExamplePlugin}=createChatPlugin({
 handleTextResponse,updateEnhancedSystems,getFriendlyFailureMessage,sendFinalReplyAsTextImage,formatMemoryFactLines,formatMemoryFacts,replyMemoryForward,replyLongForward,checkPendingReminders,YTapi,mcpManager,pluginBridge,formatTurnDiagnosticsText,analyzeReplyText,resolveToolRequestMergeMs,installObservabilityLog,createChatTurnDurability,rebuildChatTurnEvent,resolveLongTaskFeedbackPolicy,findForbiddenWord,anchorEventConversation,markConversationInterrupted,chatScopeKey,getSmartRuntimeState,smartRuntimeGroupIds,smartRuntimeSize,hasSmartRuntimeState,registerGroupRuntimeProviders,registerRuntimeSweep,runRuntimeSweeps,mcpStatus,testMCPTool,isChatManager,forbiddenWordList,handleForbiddenList,handleForbiddenAdd,handleForbiddenRemove,resolvePersonaTargetGroup,formatPersonaDetail,handlePersonaList,handlePersonaCurrent,handlePersonaDetail,handlePersonaSwitch,handlePersonaReset,handlePersonaSave,handlePersonaDelete,handlePersonaReload,handlePersonaBindings,resolveConversationPhase,applyRateLimitGuard,resolveTalkValue,idleCompensationMet,computeAvgReplyLatency,recordReplyLatency,computeGroupMsgRate5min,getDirectTriggerMergeMs,getDirectTriggerMergeMaxMessages,runTimingGateFn,handleRandomReplySmartFn,setTrackingWithTimer,joinRepeat,detectGroupRepeat,isUserTalkingToBot,addToBatchJudgment,processBatchJudgments,batchIsUserTalkingToBot,fallbackToSingleJudgment,handleRandomReply,getTaskStatusCacheKey,getTaskStatusRedisKey,getActiveToolTaskCacheKey,getActiveToolTaskRedisKey,getTaskStatusTtlSeconds,saveTaskStatus,getTaskStatus,getTurnActionFacts,clearTaskStatus,updateUserToolTaskStatus,getUserToolTaskStatus,clearUserToolTaskStatus,getRuntimeToolTaskStatus,getCurrentUserToolTaskStatus,buildDrawTaskStatusReply,buildReplySegment,buildTaskStatusReplyMessage,handleActiveDrawStatusQuestion,formatTaskStatusForPrompt,formatTime,buildMessageContent,formatMessages,handleToolInnerFn,parseToolConfigEntry,prewarmModrinthCardRenderer,renderModrinthCard,shouldUseSemanticToolIntent,normalizeToolDecision,classifySemanticToolIntent,buildToolCallFromDecision,buildMissingToolCommitmentCall,extractJsonObject,getQuotedPromptContextText,getRecentPromptContextText,getRecentDrawContextText,resolveContextualDrawGeneration,getUnderstandingEnhancementConfig,shouldInjectUnderstandingContext,extractForwardContextFromUserContent,gatherUnderstandingMaterials,resolveUnderstandingPrompt,buildUnderstandingContextPrompt,buildImageGenerationPrompt,getImageGenerationReferenceImages,buildImageEditPrompt,sendObservedReply,sendSegmentedMessage,splitMessage,splitLongMessageByPunctuation,convertAtInString,findMember,processToolSpecificMessage,normalizeAssistantToolMessage,serializeToolResult,getToolCallName,shouldRunTerminalToolsInBackground,buildGroundedImageAnalysisPrompt,extractToolResultText,buildImageVerificationSearchToolCall,startBackgroundTerminalToolCalls,runToolCall,dedupeToolCalls,processToolCalls,executeTool,chokidar,schedule,
 logger,redis,conversationHistory,shared,Plugin:plugin,getBot:()=>globalThis.Bot
})
