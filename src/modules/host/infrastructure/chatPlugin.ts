import {decodeHostModelResponse} from './hostModelResponse.js'
import {normalizeHostChatEvent,decodeReplyEvent} from './hostEvent.js'
import {decodeHostConfig} from './hostConfig.js'
import type {ActionFactsEvent,ActionFactsQuery,TurnActionFacts} from '../../../contracts/turnActionFacts.js'
import {validateTurnActionFacts} from '../../conversation/domain/turnActionFacts.js'
import type {ChatTurnEvent} from '../../../contracts/chatTurn.js'
import {normalizeFailureMessages,normalizeFailureSession,normalizeFailureEvent,type ToolFailureContext} from './toolFailureContext.js'
function modrinthRecord(value:unknown):Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}}
function presentationKind(value:unknown){return modrinthRecord(modrinthRecord(value).presentation).kind}
function modrinthGroup(value:unknown):{makeForwardMsg(nodes:unknown[]):Promise<unknown>}|null {const raw=modrinthRecord(value),method=raw.makeForwardMsg;if(typeof method!=='function')return null;return {makeForwardMsg:async nodes=>Reflect.apply(method,value,[nodes]) as unknown}}
import {createHostRedisMaintenance} from './hostRedisMaintenance.js'
import {createHostGroupContext} from './hostGroupContext.js'
type Tail<T extends unknown[]>=T extends [unknown,...infer R]?R:never;
import {createToolAssembly} from '../../tools/infrastructure/toolAssembly.js'
import {createConversationEntryPolicy} from '../../conversation/infrastructure/conversationEntryPolicy.js'
import {createMutedGroupPolicy} from '../../conversation/infrastructure/mutedGroupPolicy.js'
import {createConversationPrefilter} from '../../conversation/infrastructure/conversationPrefilter.js'
import {createConversationScheduling} from '../../conversation/infrastructure/conversationScheduling.js'
import {lastIncomingMsgAt} from '../../conversation/domain/splitState.js'
import {LOCAL_EMOJI_TOOL_NAME} from '../../conversation/domain/splitState.js'
import {smartConversationKey} from '../../conversation/domain/splitState.js'
import {looksLikeEducationalExplanation} from '../../conversation/domain/textPolicy.js'
import {looksLikeDiagnosticExplanation} from '../../conversation/domain/textPolicy.js'
import {looksLikeCodeOrMarkdown} from '../../conversation/domain/textPolicy.js'
import {hasLatexMath} from '../../rendering/infrastructure/TextImageTool.js'
import {getSemanticMemoryRuntime} from '../../memory/infrastructure/semanticRuntime.js'
import {factShortId} from '../../memory/infrastructure/engine/entityModel.js'
import {createTypedTurnSessionStore} from '../../runtime/domain/turnSession.js'
import {buildChatRequestData} from '../../models/domain/modelGateway.js'
import {resolveNaturalDeltaForceToolCall} from '../../games/domain/deltaForceIntent.js'
import {resolveChatCompletionUrl as normalizeChatCompletionUrl} from '../../models/domain/chatCompletionUrl.js'
import {extractValidBtihMagnetUri} from '../../media/infrastructure/torrentDownload.js'
import {recordDrawTextFallback} from '../../conversation/domain/drawFailureNote.js'
import {isImageDeliveryToolName} from '../../conversation/domain/drawFailureNote.js'
import {createConfigStore} from '../../config/infrastructure/configStore.js'
import {mergeDeepConfig} from '../../config/infrastructure/configStore.js'
import {classifyIntentWithModel} from '../../conversation/application/modelIntentClassifier.js'
import {resolvePersonaName} from '../../conversation/domain/personaSource.js'
import {createPersonaSnapshot} from '../../conversation/infrastructure/personaSnapshot.js'
import type {PersonaSnapshot} from '../../../contracts/persona.js'
import {createPersonaLibrary} from '../../conversation/infrastructure/personaLibrary.js'
import {isCodeOrMarkdownRequest} from '../../conversation/domain/turnPresentation.js'
import {isEducationalExplanationRequest} from '../../conversation/domain/turnPresentation.js'
import {isDrawTaskStatusInquiry} from '../../conversation/domain/messageIntent.js'
import {shouldRenderImageAnalysisAsDocument} from '../../image/domain/imageTaskPolicy.js'
import {classifyImageFailure} from '../../image/domain/imageFailurePolicy.js'
import {safeTruncateUnicode} from '../../models/domain/unicodeText.js'
import {adaptForcedReplyTextRate} from '../../conversation/domain/emojiToolPolicy.js'
import {shouldBypassMergeForExcel} from '../../content/infrastructure/excelRequestPolicy.js'
import {shouldUseExcelWorkbookTool} from '../../content/infrastructure/excelRequestPolicy.js'
import {containsCodeFence} from '../../conversation/domain/qqCodeFenceText.js'
import {buildToolFailureReplyInstruction} from '../../conversation/domain/agentReplyComposer.js'
import {selectAgentReplyContext} from '../../conversation/domain/agentReplyComposer.js'
import {containsInternalStatusLeak} from '../../conversation/domain/internalStatusLeak.js'
import {shouldKeepModrinthReplyAsText} from '../../media/infrastructure/modrinth.js'
import fs from 'fs'
import path from 'path'
import {randomUUID} from 'crypto'
import {createConversationHistory} from '../../conversation/infrastructure/conversationHistory.js'
export interface ChatPluginPorts {
handleTextResponse: ReturnType<typeof import('../../conversation/application/finalReply.js').createFinalReply>['handleTextResponse'];
updateEnhancedSystems: ReturnType<typeof import('../../conversation/application/finalReply.js').createFinalReply>['updateEnhancedSystems'];
getFriendlyFailureMessage: ReturnType<typeof import('../../conversation/application/finalReply.js').createFinalReply>['getFriendlyFailureMessage'];
sendFinalReplyAsTextImage: ReturnType<typeof import('../../conversation/application/finalReply.js').createFinalReply>['sendFinalReplyAsTextImage'];
formatMemoryFactLines: ReturnType<typeof import('../../conversation/application/memoryReplies.js').createMemoryReplies>['formatMemoryFactLines'];
formatMemoryFacts: ReturnType<typeof import('../../conversation/application/memoryReplies.js').createMemoryReplies>['formatMemoryFacts'];
replyMemoryForward: ReturnType<typeof import('../../conversation/application/memoryReplies.js').createMemoryReplies>['replyMemoryForward'];
replyLongForward: ReturnType<typeof import('../../conversation/application/memoryReplies.js').createMemoryReplies>['replyLongForward'];
checkPendingReminders: ReturnType<typeof import('../../qqTools/infrastructure/ReminderTool.js').createReminderRuntime>['checkPendingReminders'];
YTapi: ReturnType<typeof import('../../models/application/modelExecution.js').createModelExecutor>['YTapi'];
mcpManager: import('../../../contracts/toolAssembly.js').ToolAssemblyPorts['mcpManager'] & {setToolsChangedCallback(callback:()=>void):void;disconnectAll():Promise<void>;getToolsListText():string};
pluginBridge: {instance:unknown;sharedState:unknown};
formatTurnDiagnosticsText: ReturnType<typeof import('../../conversation/domain/turnDiagnostics.js').createTurnDiagnostics>['formatTurnDiagnosticsText'];
analyzeReplyText: ReturnType<typeof import('../../conversation/application/smartReply.js').createSmartReply>['analyzeReplyText'];
resolveToolRequestMergeMs: ReturnType<typeof import('../../tools/domain/toolIntentManifests.js').createToolIntentManifests>['resolveToolRequestMergeMs'];
installObservabilityLog: (options:{enabled:boolean;retentionDays?:number|undefined})=>unknown;
createChatTurnDurability: ReturnType<typeof import('../../conversation/application/chatTurnDurability.js').createChatTurnDurabilityModule>['createChatTurnDurability'];
rebuildChatTurnEvent: ReturnType<typeof import('../../conversation/application/chatTurnDurability.js').createChatTurnDurabilityModule>['rebuildChatTurnEvent'];
resolveLongTaskFeedbackPolicy: ReturnType<typeof import('../../conversation/application/longTaskFeedbackPolicy.js').createLongTaskFeedback>['resolveLongTaskFeedbackPolicy'];
findForbiddenWord: ReturnType<typeof import('../../conversation/domain/forbiddenWordGuard.js').createForbiddenWordGuard>['findForbiddenWord'];
anchorEventConversation: ReturnType<typeof import('../../conversation/domain/forbiddenWordGuard.js').createForbiddenWordGuard>['anchorEventConversation'];
markConversationInterrupted: ReturnType<typeof import('../../conversation/domain/forbiddenWordGuard.js').createForbiddenWordGuard>['markConversationInterrupted'];
chatScopeKey: ReturnType<typeof import('../../conversation/domain/forbiddenWordGuard.js').createForbiddenWordGuard>['chatScopeKey'];
getSmartRuntimeState: ReturnType<typeof import('../../../adapters/legacyRuntime.js').createLegacyGroupRuntime>['getSmartRuntimeState'];
smartRuntimeGroupIds: ReturnType<typeof import('../../../adapters/legacyRuntime.js').createLegacyGroupRuntime>['smartRuntimeGroupIds'];
smartRuntimeSize: ReturnType<typeof import('../../../adapters/legacyRuntime.js').createLegacyGroupRuntime>['smartRuntimeSize'];
hasSmartRuntimeState: ReturnType<typeof import('../../../adapters/legacyRuntime.js').createLegacyGroupRuntime>['hasSmartRuntimeState'];
registerGroupRuntimeProviders: ReturnType<typeof import('../../../adapters/legacyRuntime.js').createLegacyGroupRuntime>['registerGroupRuntimeProviders'];
registerRuntimeSweep: ReturnType<typeof import('../../../adapters/legacyRuntime.js').createLegacyGroupRuntime>['registerRuntimeSweep'];
runRuntimeSweeps: ReturnType<typeof import('../../../adapters/legacyRuntime.js').createLegacyGroupRuntime>['runRuntimeSweeps'];
mcpStatus: ReturnType<typeof import('../../platform/infrastructure/admin/adminCommands.js').createAdminCommands>['mcpStatus'];
testMCPTool: ReturnType<typeof import('../../platform/infrastructure/admin/adminCommands.js').createAdminCommands>['testMCPTool'];
isChatManager: ReturnType<typeof import('../../platform/infrastructure/admin/adminCommands.js').createAdminCommands>['isChatManager'];
forbiddenWordList: ReturnType<typeof import('../../platform/infrastructure/admin/adminCommands.js').createAdminCommands>['forbiddenWordList'];
handleForbiddenList: ReturnType<typeof import('../../platform/infrastructure/admin/adminCommands.js').createAdminCommands>['handleForbiddenList'];
handleForbiddenAdd: ReturnType<typeof import('../../platform/infrastructure/admin/adminCommands.js').createAdminCommands>['handleForbiddenAdd'];
handleForbiddenRemove: ReturnType<typeof import('../../platform/infrastructure/admin/adminCommands.js').createAdminCommands>['handleForbiddenRemove'];
resolvePersonaTargetGroup: ReturnType<typeof import('../../platform/infrastructure/admin/adminCommands.js').createAdminCommands>['resolvePersonaTargetGroup'];
formatPersonaDetail: ReturnType<typeof import('../../platform/infrastructure/admin/adminCommands.js').createAdminCommands>['formatPersonaDetail'];
handlePersonaList: ReturnType<typeof import('../../platform/infrastructure/admin/adminCommands.js').createAdminCommands>['handlePersonaList'];
handlePersonaCurrent: ReturnType<typeof import('../../platform/infrastructure/admin/adminCommands.js').createAdminCommands>['handlePersonaCurrent'];
handlePersonaDetail: ReturnType<typeof import('../../platform/infrastructure/admin/adminCommands.js').createAdminCommands>['handlePersonaDetail'];
handlePersonaSwitch: ReturnType<typeof import('../../platform/infrastructure/admin/adminCommands.js').createAdminCommands>['handlePersonaSwitch'];
handlePersonaReset: ReturnType<typeof import('../../platform/infrastructure/admin/adminCommands.js').createAdminCommands>['handlePersonaReset'];
handlePersonaSave: ReturnType<typeof import('../../platform/infrastructure/admin/adminCommands.js').createAdminCommands>['handlePersonaSave'];
handlePersonaDelete: ReturnType<typeof import('../../platform/infrastructure/admin/adminCommands.js').createAdminCommands>['handlePersonaDelete'];
handlePersonaReload: ReturnType<typeof import('../../platform/infrastructure/admin/adminCommands.js').createAdminCommands>['handlePersonaReload'];
handlePersonaBindings: ReturnType<typeof import('../../platform/infrastructure/admin/adminCommands.js').createAdminCommands>['handlePersonaBindings'];
resolveConversationPhase: ReturnType<typeof import('../../conversation/domain/smartDynamics.js').createSmartDynamics>['resolveConversationPhase'];
applyRateLimitGuard: ReturnType<typeof import('../../conversation/domain/smartDynamics.js').createSmartDynamics>['applyRateLimitGuard'];
resolveTalkValue: ReturnType<typeof import('../../conversation/domain/smartDynamics.js').createSmartDynamics>['resolveTalkValue'];
idleCompensationMet: ReturnType<typeof import('../../conversation/domain/smartDynamics.js').createSmartDynamics>['idleCompensationMet'];
computeAvgReplyLatency: ReturnType<typeof import('../../conversation/domain/smartDynamics.js').createSmartDynamics>['computeAvgReplyLatency'];
recordReplyLatency: ReturnType<typeof import('../../conversation/domain/smartDynamics.js').createSmartDynamics>['recordReplyLatency'];
computeGroupMsgRate5min: ReturnType<typeof import('../../conversation/domain/smartDynamics.js').createSmartDynamics>['computeGroupMsgRate5min'];
getDirectTriggerMergeMs: ReturnType<typeof import('../../conversation/domain/smartDynamics.js').createSmartDynamics>['getDirectTriggerMergeMs'];
getDirectTriggerMergeMaxMessages: ReturnType<typeof import('../../conversation/domain/smartDynamics.js').createSmartDynamics>['getDirectTriggerMergeMaxMessages'];
runTimingGateFn: ReturnType<typeof import('../../conversation/infrastructure/timingGate.js').createTimingGate>['runTimingGate'];
handleRandomReplySmartFn: ReturnType<typeof import('../../conversation/application/smartConversation.js').createSmartConversation>['handleRandomReplySmart'];
setTrackingWithTimer: ReturnType<typeof import('../../conversation/infrastructure/strictConversation.js').createStrictConversation>['setTrackingWithTimer'];
joinRepeat: ReturnType<typeof import('../../conversation/infrastructure/strictConversation.js').createStrictConversation>['joinRepeat'];
detectGroupRepeat: ReturnType<typeof import('../../conversation/infrastructure/strictConversation.js').createStrictConversation>['detectGroupRepeat'];
isUserTalkingToBot: ReturnType<typeof import('../../conversation/infrastructure/strictConversation.js').createStrictConversation>['isUserTalkingToBot'];
addToBatchJudgment: ReturnType<typeof import('../../conversation/infrastructure/strictConversation.js').createStrictConversation>['addToBatchJudgment'];
processBatchJudgments: ReturnType<typeof import('../../conversation/infrastructure/strictConversation.js').createStrictConversation>['processBatchJudgments'];
batchIsUserTalkingToBot: ReturnType<typeof import('../../conversation/infrastructure/strictConversation.js').createStrictConversation>['batchIsUserTalkingToBot'];
fallbackToSingleJudgment: ReturnType<typeof import('../../conversation/infrastructure/strictConversation.js').createStrictConversation>['fallbackToSingleJudgment'];
handleRandomReply: ReturnType<typeof import('../../conversation/infrastructure/strictConversation.js').createStrictConversation>['handleRandomReply'];
getTaskStatusCacheKey: ReturnType<typeof import('../../conversation/infrastructure/taskStatus.js').createTaskStatus>['getTaskStatusCacheKey'];
getTaskStatusRedisKey: ReturnType<typeof import('../../conversation/infrastructure/taskStatus.js').createTaskStatus>['getTaskStatusRedisKey'];
getActiveToolTaskCacheKey: ReturnType<typeof import('../../conversation/infrastructure/taskStatus.js').createTaskStatus>['getActiveToolTaskCacheKey'];
getActiveToolTaskRedisKey: ReturnType<typeof import('../../conversation/infrastructure/taskStatus.js').createTaskStatus>['getActiveToolTaskRedisKey'];
getTaskStatusTtlSeconds: ReturnType<typeof import('../../conversation/infrastructure/taskStatus.js').createTaskStatus>['getTaskStatusTtlSeconds'];
saveTaskStatus: ReturnType<typeof import('../../conversation/infrastructure/taskStatus.js').createTaskStatus>['saveTaskStatus'];
getTaskStatus: ReturnType<typeof import('../../conversation/infrastructure/taskStatus.js').createTaskStatus>['getTaskStatus'];
getTurnActionFacts: ReturnType<typeof import('../../conversation/infrastructure/taskStatus.js').createTaskStatus>['getTurnActionFacts'];
clearTaskStatus: ReturnType<typeof import('../../conversation/infrastructure/taskStatus.js').createTaskStatus>['clearTaskStatus'];
updateUserToolTaskStatus: ReturnType<typeof import('../../conversation/infrastructure/taskStatus.js').createTaskStatus>['updateUserToolTaskStatus'];
getUserToolTaskStatus: ReturnType<typeof import('../../conversation/infrastructure/taskStatus.js').createTaskStatus>['getUserToolTaskStatus'];
clearUserToolTaskStatus: ReturnType<typeof import('../../conversation/infrastructure/taskStatus.js').createTaskStatus>['clearUserToolTaskStatus'];
getRuntimeToolTaskStatus: ReturnType<typeof import('../../conversation/infrastructure/taskStatus.js').createTaskStatus>['getRuntimeToolTaskStatus'];
getCurrentUserToolTaskStatus: ReturnType<typeof import('../../conversation/infrastructure/taskStatus.js').createTaskStatus>['getCurrentUserToolTaskStatus'];
buildDrawTaskStatusReply: ReturnType<typeof import('../../conversation/infrastructure/taskStatus.js').createTaskStatus>['buildDrawTaskStatusReply'];
buildReplySegment: ReturnType<typeof import('../../conversation/infrastructure/taskStatus.js').createTaskStatus>['buildReplySegment'];
buildTaskStatusReplyMessage: ReturnType<typeof import('../../conversation/infrastructure/taskStatus.js').createTaskStatus>['buildTaskStatusReplyMessage'];
handleActiveDrawStatusQuestion: ReturnType<typeof import('../../conversation/infrastructure/taskStatus.js').createTaskStatus>['handleActiveDrawStatusQuestion'];
formatTaskStatusForPrompt: ReturnType<typeof import('../../conversation/infrastructure/taskStatus.js').createTaskStatus>['formatTaskStatusForPrompt'];
formatTime: ReturnType<typeof import('../../conversation/application/messageFormatting.js').createMessageFormatting>['formatTime'];
buildMessageContent: ReturnType<typeof import('../../conversation/application/messageFormatting.js').createMessageFormatting>['buildMessageContent'];
formatMessages: ReturnType<typeof import('../../conversation/application/messageFormatting.js').createMessageFormatting>['formatMessages'];
handleToolInnerFn: ReturnType<typeof import('../../tools/infrastructure/chatTurn.js').createChatTurn>['handleToolInner'];
parseToolConfigEntry: ReturnType<typeof import('../../conversation/infrastructure/conversationUtils.js').createConversationUtils>['parseToolConfigEntry'];
prewarmModrinthCardRenderer: ReturnType<typeof import('../../media/infrastructure/ModrinthCardRenderer.js').createModrinthCardRenderer>['prewarmModrinthCardRenderer'];
renderModrinthCard: ReturnType<typeof import('../../media/infrastructure/ModrinthCardRenderer.js').createModrinthCardRenderer>['renderModrinthCard'];
shouldUseSemanticToolIntent: ReturnType<typeof import('../../tools/infrastructure/semanticToolIntent.js').createSemanticToolIntent>['shouldUseSemanticToolIntent'];
normalizeToolDecision: ReturnType<typeof import('../../tools/infrastructure/semanticToolIntent.js').createSemanticToolIntent>['normalizeToolDecision'];
classifySemanticToolIntent: ReturnType<typeof import('../../tools/infrastructure/semanticToolIntent.js').createSemanticToolIntent>['classifySemanticToolIntent'];
buildToolCallFromDecision: ReturnType<typeof import('../../tools/infrastructure/semanticToolIntent.js').createSemanticToolIntent>['buildToolCallFromDecision'];
buildMissingToolCommitmentCall: ReturnType<typeof import('../../tools/infrastructure/semanticToolIntent.js').createSemanticToolIntent>['buildMissingToolCommitmentCall'];
extractJsonObject: ReturnType<typeof import('../../tools/infrastructure/semanticToolIntent.js').createSemanticToolIntent>['extractJsonObject'];
getQuotedPromptContextText: ReturnType<typeof import('../../conversation/infrastructure/promptContext.js').createPromptContext>['getQuotedPromptContextText'];
getRecentPromptContextText: ReturnType<typeof import('../../conversation/infrastructure/promptContext.js').createPromptContext>['getRecentPromptContextText'];
getRecentDrawContextText: ReturnType<typeof import('../../conversation/infrastructure/promptContext.js').createPromptContext>['getRecentDrawContextText'];
resolveContextualDrawGeneration: ReturnType<typeof import('../../conversation/infrastructure/promptContext.js').createPromptContext>['resolveContextualDrawGeneration'];
getUnderstandingEnhancementConfig: ReturnType<typeof import('../../conversation/infrastructure/promptContext.js').createPromptContext>['getUnderstandingEnhancementConfig'];
shouldInjectUnderstandingContext: ReturnType<typeof import('../../conversation/infrastructure/promptContext.js').createPromptContext>['shouldInjectUnderstandingContext'];
extractForwardContextFromUserContent: ReturnType<typeof import('../../conversation/infrastructure/promptContext.js').createPromptContext>['extractForwardContextFromUserContent'];
gatherUnderstandingMaterials: ReturnType<typeof import('../../conversation/infrastructure/promptContext.js').createPromptContext>['gatherUnderstandingMaterials'];
resolveUnderstandingPrompt: ReturnType<typeof import('../../conversation/infrastructure/promptContext.js').createPromptContext>['resolveUnderstandingPrompt'];
buildUnderstandingContextPrompt: ReturnType<typeof import('../../conversation/infrastructure/promptContext.js').createPromptContext>['buildUnderstandingContextPrompt'];
buildImageGenerationPrompt: ReturnType<typeof import('../../conversation/infrastructure/promptContext.js').createPromptContext>['buildImageGenerationPrompt'];
getImageGenerationReferenceImages: ReturnType<typeof import('../../conversation/infrastructure/promptContext.js').createPromptContext>['getImageGenerationReferenceImages'];
buildImageEditPrompt: ReturnType<typeof import('../../conversation/infrastructure/promptContext.js').createPromptContext>['buildImageEditPrompt'];
sendObservedReply: ReturnType<typeof import('../../conversation/application/replyRendering.js').createReplyRendering>['sendObservedReply'];
sendSegmentedMessage: ReturnType<typeof import('../../conversation/application/replyRendering.js').createReplyRendering>['sendSegmentedMessage'];
splitMessage: ReturnType<typeof import('../../conversation/application/replyRendering.js').createReplyRendering>['splitMessage'];
splitLongMessageByPunctuation: ReturnType<typeof import('../../conversation/application/replyRendering.js').createReplyRendering>['splitLongMessageByPunctuation'];
convertAtInString: ReturnType<typeof import('../../conversation/application/replyRendering.js').createReplyRendering>['convertAtInString'];
findMember: ReturnType<typeof import('../../conversation/application/replyRendering.js').createReplyRendering>['findMember'];
processToolSpecificMessage: ReturnType<typeof import('../../conversation/application/replyRendering.js').createReplyRendering>['processToolSpecificMessage'];
normalizeAssistantToolMessage: ReturnType<typeof import('../../tools/infrastructure/toolExecution.js').createToolExecution>['normalizeAssistantToolMessage'];
serializeToolResult: ReturnType<typeof import('../../tools/infrastructure/toolExecution.js').createToolExecution>['serializeToolResult'];
getToolCallName: ReturnType<typeof import('../../tools/infrastructure/toolExecution.js').createToolExecution>['getToolCallName'];
shouldRunTerminalToolsInBackground: ReturnType<typeof import('../../tools/infrastructure/toolExecution.js').createToolExecution>['shouldRunTerminalToolsInBackground'];
buildGroundedImageAnalysisPrompt: ReturnType<typeof import('../../tools/infrastructure/toolExecution.js').createToolExecution>['buildGroundedImageAnalysisPrompt'];
extractToolResultText: ReturnType<typeof import('../../tools/infrastructure/toolExecution.js').createToolExecution>['extractToolResultText'];
buildImageVerificationSearchToolCall: ReturnType<typeof import('../../tools/infrastructure/toolExecution.js').createToolExecution>['buildImageVerificationSearchToolCall'];
startBackgroundTerminalToolCalls: ReturnType<typeof import('../../tools/infrastructure/toolExecution.js').createToolExecution>['startBackgroundTerminalToolCalls'];
runToolCall: ReturnType<typeof import('../../tools/infrastructure/toolExecution.js').createToolExecution>['runToolCall'];
dedupeToolCalls: ReturnType<typeof import('../../tools/infrastructure/toolExecution.js').createToolExecution>['dedupeToolCalls'];
processToolCalls: ReturnType<typeof import('../../tools/infrastructure/toolExecution.js').createToolExecution>['processToolCalls'];
executeTool: ReturnType<typeof import('../../tools/infrastructure/toolExecution.js').createToolExecution>['executeTool'];
chokidar: {watch(file:string):{on(event:string,callback:()=>void):{close():unknown}}};
schedule: {scheduleJob(rule:string,callback:()=>Promise<void>):unknown};
Plugin:new(options:{name:string;dsc:string;event:string;priority:number;rule:{reg:string;fnc:string;log?:boolean}[]})=>object;
logger:{info(message:string):void;warn(message:string):void;error(message:string,error?:unknown):void;debug(message:string):void;mark(message:string):void};
getBot():{uin?:string|number;nickname?:string;sendApi?(action:string,params:Record<string,unknown>):Promise<unknown>}|undefined;
shared:ReturnType<typeof import('./hostSharedState.js').createHostSharedState>;
conversationHistory:ReturnType<typeof createConversationHistory>;
redis:{get(key:string):Promise<string|null>;set(key:string,value:string,options:{EX:number}):Promise<unknown>;del(...keys:string[]):Promise<unknown>;keys(pattern:string):Promise<string[]>;scan(cursor:string,...args:unknown[]):Promise<unknown>;scanIterator?(options:{MATCH:string;COUNT:number}):AsyncIterable<string|string[]>};
}
export function createChatPlugin(ports:ChatPluginPorts) {
const {handleTextResponse,updateEnhancedSystems,getFriendlyFailureMessage,sendFinalReplyAsTextImage,formatMemoryFactLines,formatMemoryFacts,replyMemoryForward,replyLongForward,checkPendingReminders,YTapi,mcpManager,pluginBridge,formatTurnDiagnosticsText,analyzeReplyText,resolveToolRequestMergeMs,installObservabilityLog,createChatTurnDurability,rebuildChatTurnEvent,resolveLongTaskFeedbackPolicy,findForbiddenWord,anchorEventConversation,markConversationInterrupted,chatScopeKey,getSmartRuntimeState,smartRuntimeGroupIds,smartRuntimeSize,hasSmartRuntimeState,registerGroupRuntimeProviders,registerRuntimeSweep,runRuntimeSweeps,mcpStatus,testMCPTool,isChatManager,forbiddenWordList,handleForbiddenList,handleForbiddenAdd,handleForbiddenRemove,resolvePersonaTargetGroup,formatPersonaDetail,handlePersonaList,handlePersonaCurrent,handlePersonaDetail,handlePersonaSwitch,handlePersonaReset,handlePersonaSave,handlePersonaDelete,handlePersonaReload,handlePersonaBindings,resolveConversationPhase,applyRateLimitGuard,resolveTalkValue,idleCompensationMet,computeAvgReplyLatency,recordReplyLatency,computeGroupMsgRate5min,getDirectTriggerMergeMs,getDirectTriggerMergeMaxMessages,runTimingGateFn,handleRandomReplySmartFn,setTrackingWithTimer,joinRepeat,detectGroupRepeat,isUserTalkingToBot,addToBatchJudgment,processBatchJudgments,batchIsUserTalkingToBot,fallbackToSingleJudgment,handleRandomReply,getTaskStatusCacheKey,getTaskStatusRedisKey,getActiveToolTaskCacheKey,getActiveToolTaskRedisKey,getTaskStatusTtlSeconds,saveTaskStatus,getTaskStatus,getTurnActionFacts,clearTaskStatus,updateUserToolTaskStatus,getUserToolTaskStatus,clearUserToolTaskStatus,getRuntimeToolTaskStatus,getCurrentUserToolTaskStatus,buildDrawTaskStatusReply,buildReplySegment,buildTaskStatusReplyMessage,handleActiveDrawStatusQuestion,formatTaskStatusForPrompt,formatTime,buildMessageContent,formatMessages,handleToolInnerFn,parseToolConfigEntry,prewarmModrinthCardRenderer,renderModrinthCard,shouldUseSemanticToolIntent,normalizeToolDecision,classifySemanticToolIntent,buildToolCallFromDecision,buildMissingToolCommitmentCall,extractJsonObject,getQuotedPromptContextText,getRecentPromptContextText,getRecentDrawContextText,resolveContextualDrawGeneration,getUnderstandingEnhancementConfig,shouldInjectUnderstandingContext,extractForwardContextFromUserContent,gatherUnderstandingMaterials,resolveUnderstandingPrompt,buildUnderstandingContextPrompt,buildImageGenerationPrompt,getImageGenerationReferenceImages,buildImageEditPrompt,sendObservedReply,sendSegmentedMessage,splitMessage,splitLongMessageByPunctuation,convertAtInString,findMember,processToolSpecificMessage,normalizeAssistantToolMessage,serializeToolResult,getToolCallName,shouldRunTerminalToolsInBackground,buildGroundedImageAnalysisPrompt,extractToolResultText,buildImageVerificationSearchToolCall,startBackgroundTerminalToolCalls,runToolCall,dedupeToolCalls,processToolCalls,executeTool,chokidar,schedule,logger,redis,conversationHistory}=ports


const groupContext=createHostGroupContext({getBot:ports.getBot,debug:logger.debug})
const _path = process.cwd()

// 自动抢红包配置


// 清空群记忆二次确认（P0-1）：进程内 pending，key: `${groupId}_${userId}`, value: 过期时间戳。



// smart 模式：每群独立的频率状态，进程内 Map，重启清零
// 群连续被新消息打断的累计计数（达到上限后下一轮强制走完不再让步）
const conversationEntryPolicy=createConversationEntryPolicy({logger:logger,bot:()=>ports.getBot() || {},anchorEventConversation,findForbiddenWord,chatScopeKey,markConversationInterrupted,getSemanticMemoryRuntime,resolveNaturalDeltaForceToolCall,shouldUseExcelWorkbookTool,extractValidBtihMagnetUri})
const conversationPrefilter=createConversationPrefilter({bot:()=>ports.getBot() || {},resolvePersonaName,logger:logger})
const conversationScheduling=createConversationScheduling({logger:logger,resolveToolRequestMergeMs:(text,names,options)=>resolveToolRequestMergeMs(text,names,{defaultMs:options.defaultMs,...(options.fastMs===undefined?{}:{fastMs:options.fastMs})}),shouldBypassMergeForExcel,isDrawTaskStatusInquiry})
const {consecutiveInterrupts} = conversationScheduling
// smart 锁持有令牌：看门狗强制释放后旧轮次的 finally 不得误释放新轮次的锁
// redis 抖动/断连时命令可能既不成功也不失败（挂起）。任务状态只是去重辅助，
// 超时降级为"无状态"，绝不能卡住会话收尾（进而卡死 smart 锁）。

// 禁言状态短期缓存：避免每条群消息都查一次 ws RPC pickMember.getInfo()
const mutedGroupPolicy=createMutedGroupPolicy(()=>ports.getBot() || {})
const {mutedStatusCache}=mutedGroupPolicy
const MUTED_CACHE_TTL_MS = 30000
const groupContextCache = new Map()
const GROUP_CONTEXT_CACHE_TTL_MS = 5 * 60 * 1000
const FORWARD_CONTEXT_MAX_DEPTH = 4
const FORWARD_CONTEXT_MAX_LINES = 120
const FORWARD_CONTEXT_MAX_TEXT = 9000
let activeChatLruTimer: ReturnType<typeof setInterval> | null = null // 全局 24h LRU 扫描定时器，进程内单例
let durableToolRecoveryStarted = false
let chatTurnRecoveryStarted = false


let sharedConfigStore: ReturnType<typeof createConfigStore> | null = null
let pluginInitialized = false
const { initializeSharedState, getState, applyToolRegistrySnapshot, refreshLocalTools } = ports.shared
let mcpInitPromise: Promise<unknown> | null = null











class ExamplePlugin extends ports.Plugin {
 config!: import('./hostConfig.js').HostConfig;
 personaLibrary: ReturnType<typeof createPersonaLibrary>;
 messageManager: import('./hostSharedState.js').HostSharedState['messageManager'];
 toolInstances: import('./hostSharedState.js').HostSharedState['toolInstances'];
 functions: import('./hostSharedState.js').HostSharedState['functions'];
 functionMap: import('./hostSharedState.js').HostSharedState['functionMap'];
 sessionMap: import('./hostSharedState.js').HostSharedState['sessionMap'];
 emotionManager: import('./hostSharedState.js').HostSharedState['emotionManager'];
 memoryManager: import('./hostSharedState.js').HostSharedState['memoryManager'];
 expressionLearner: import('./hostSharedState.js').HostSharedState['expressionLearner'];
 knowledgeSearcher: import('./hostSharedState.js').HostSharedState['knowledgeSearcher'];
 sessionStore:import('../../runtime/domain/turnSession.js').TypedTurnSessionStore<import('../../../contracts/chatTurn.js').ChatTurnSession,import('../../../contracts/toolExecution.js').ToolDefinition>;
 chatTurnDurability:ReturnType<ChatPluginPorts['createChatTurnDurability']>;
 REDIS_KEY_PREFIX:string;TASK_STATUS_PREFIX:string;ACTIVE_TOOL_TASK_PREFIX:string;
 dedupeToolNames:Set<string>;_groupLimiters:Map<unknown,unknown>;localToolsReady:boolean;
 tools:import('../../../contracts/toolExecution.js').ToolDefinition[];
 localToolsReadyPromise:Promise<unknown>;
 messageHistoriesRedisKey='';messageHistoriesDir='';MAX_HISTORY=100;

  constructor() {
    super({
      name: "全局方案-test",
      dsc: "全局方案测试版",
      event: "message",
      priority: 9999,
      rule: [
        { reg: "^#希洛调试", fnc: "handleDebugDiagnostics", log: false },
        { reg: "^#tool\\s*(.*)", fnc: "handleTool" },
        { reg: "^#mcp\\s+重载", fnc: "reloadMCP" },
        { reg: "^#mcp\\s+列表", fnc: "listMCPTools" },
        { reg: "^#mcp\\s+状态", fnc: "mcpStatus" },
        { reg: "^#mcp\\s+测试\\s+\\S+", fnc: "testMCPTool" },
        { reg: "^#人设列表$", fnc: "handlePersonaList" },
        { reg: "^#当前人设$", fnc: "handlePersonaCurrent" },
        { reg: "^#人设详情\\s+\\S+$", fnc: "handlePersonaDetail" },
        { reg: "^#切换人设\\s+\\S+(\\s+\\d+)?$", fnc: "handlePersonaSwitch" },
        { reg: "^#人设重置(\\s+\\d+)?$", fnc: "handlePersonaReset" },
        { reg: "^#保存人设\\s+\\S+$", fnc: "handlePersonaSave" },
        { reg: "^#删除人设\\s+\\S+$", fnc: "handlePersonaDelete" },
        { reg: "^#人设重载$", fnc: "handlePersonaReload" },
        { reg: "^#人设绑定列表$", fnc: "handlePersonaBindings" },
        { reg: "^#违禁词列表$", fnc: "handleForbiddenList" },
        { reg: "^#加违禁词\\s+\\S+$", fnc: "handleForbiddenAdd" },
        { reg: "^#删违禁词\\s+\\S+$", fnc: "handleForbiddenRemove" },
        { reg: "[\\s\\S]*", fnc: "handleRandomReply", log: false }
      ]
    })

    this.initConfig()
    // 多人设库:多套人设 + 按群绑定,config/persona-library.yaml,手动编辑热生效
    this.personaLibrary = createPersonaLibrary({
      libraryPath: path.join(_path, "plugins/shiloh-plugin/config/persona-library.yaml"),
      getBasePersona: () => ({...this.config?.persona})
    })
    // 观测日志:关键 info(工具调用/路由决策/模型耗时)tee 到 logs/shiloh-obs/
    installObservabilityLog({
      enabled: this.config?.observabilityLog?.enabled !== false,
      retentionDays: this.config?.observabilityLog?.retentionDays
    })
    const state = initializeSharedState(this.config)

    this.messageManager = state.messageManager
    this.toolInstances = state.toolInstances
    this.functions = state.functions
    this.functionMap = state.functionMap
    this.sessionMap = state.sessionMap
    // 回合会话存储:包装同一张 Map,提供 TTL/容量淘汰与全量工具刷新
    this.sessionStore = createTypedTurnSessionStore<import('../../../contracts/chatTurn.js').ChatTurnSession,import('../../../contracts/toolExecution.js').ToolDefinition>({map:this.sessionMap,createSession:tools=>({...tools===undefined?{}:{tools},groupUserMessages:[],actionOutcomes:[]})})
    this.emotionManager = state.emotionManager
    this.memoryManager = state.memoryManager
    this.expressionLearner = state.expressionLearner
    this.knowledgeSearcher = state.knowledgeSearcher
    this.REDIS_KEY_PREFIX = 'ytbot:messages:'
    this.TASK_STATUS_PREFIX = 'ytbot:tool_task_status:'
    this.ACTIVE_TOOL_TASK_PREFIX = 'ytbot:active_tool_task:'
    this.dedupeToolNames = new Set()
    this._groupLimiters = new Map()

    this.localToolsReady = false
    this.tools = []
    this.initMessageHistory()
    mcpManager.setToolsChangedCallback(() => this.updateToolsList())
    this.localToolsReadyPromise = this.refreshLocalToolRegistry({ force: true }).catch(error => {
      logger.error("[LocalToolRegistry] 启动加载本地工具失败:", error)
      this.localToolsReady = true
      this.initTools()
      return null
    })

    if (!pluginInitialized) {
      pluginInitialized = true
      mcpInitPromise = this.initMCP()
      this.initScheduledTasks()
      this.startActiveChatLruScanner()
    }

    pluginBridge.instance = this
    // 群运行时统一门面:把跨子系统实例注册进去,后续功能经 getGroupRuntime 一站取用
    registerGroupRuntimeProviders({ emotion: this.emotionManager, sessions: this.sessionStore })
    this.chatTurnDurability = createChatTurnDurability({
      logger,
      getConfig: () => this.config?.chatTurnDurability || {}
    })
    this.startDurableToolRecovery()
    this.startChatTurnRecovery()
  }

  // 回合持久化外壳：进行中的 AI 回合落 Redis，崩溃/重启后启动恢复可补跑。
  // 媒体自动交付事件(auto_media)有独立 outbox 幂等，beginTurn 内部会跳过。
  async handleTool(input: unknown):Promise<unknown> {
    const e=normalizeHostChatEvent(input,ports.getBot())
    // 违禁词:工具/指令路径同样受黑名单约束;命中即中断当前对话,不开新回合
    if (this.handleForbiddenWordHit(e)) return false
    this.handleMemorySelfCorrection(e)
    anchorEventConversation(e)
    const durability = this.chatTurnDurability
    if (!durability) return await this.handleToolInner(e)
    const turnEvent = e
    await durability.beginTurn(turnEvent)
    try {
      return await this.handleToolInner(e)
    } finally {
      await durability.completeTurn(turnEvent)
    }
  }

  /** 出站幂等入口：sendSegmentedMessage 每次发送前认领，防补跑重复回复 */
  async claimTurnReply(e: Parameters<ReturnType<ChatPluginPorts['createChatTurnDurability']>['claimReply']>[0]) {
    return await this.chatTurnDurability?.claimReply(e) || { claimed: true }
  }

  /** 启动恢复：等 OneBot 连接稳定后补跑未完成的聊天回合 */
  startChatTurnRecovery() {
    if (chatTurnRecoveryStarted) return
    chatTurnRecoveryStarted = true
    const delayMs = this.chatTurnDurability.options().recoverDelayMs
    const timer = setTimeout(() => {
      this.chatTurnDurability.recoverPending({
        redispatch: async envelope => {
          const e = rebuildChatTurnEvent(envelope)
          if (!e) {
            logger.warn(`[回合持久化] 无法重建事件（Bot 未连接或缺群对象），丢弃 group=${envelope.group_id}`)
            return
          }
          logger.info(`[回合持久化] 补跑未完成回合 group=${envelope.group_id} user=${envelope.user_id} msg="${String(envelope.msg || "").slice(0, 30)}"`)
          await this.handleToolInner(e)
        }
      }).catch(error => logger.error("[回合持久化] 恢复调度失败:", error))
    }, delayMs)
    timer.unref?.()
  }

  startDurableToolRecovery() {
    if (durableToolRecoveryStarted) return
    durableToolRecoveryStarted = true

    const recover = async () => {
      await this.markStaleToolTasksFailed()
      const recoverableTools = Object.values(this.toolInstances || {})
        .filter(tool => typeof tool?.recoverDurableJobs === "function")
      for (const tool of recoverableTools) {
        try {
          await tool.recoverDurableJobs?.()
        } catch (error) {
          logger.error(`[持久任务] 恢复 ${tool.name || "unknown"} 失败:`, error)
        }
      }
    }

    const timer = setTimeout(() => {
      recover().catch(error => logger.error("[持久任务] 启动恢复失败:", error))
    }, 3000)
    timer.unref?.()

    this.localToolsReadyPromise?.then(() => recover()).catch(() => {})
  }

  /**
   * 启动 smart 群状态的 TTL 扫描器（进程内单例）：每 1 小时扫一次，
   * 把 lastMsgAt 超过 activeChatTtlHours 的群从内存状态淘汰，连同 waitTimers 一并清掉。
   */
  // 清扫调度器:每群各状态经 groupRuntime 注册自己的清扫回调,这里只做调度与日志
  registerAuxRuntimeSweeps() {
    // lastIncoming/连续打断孤儿清理(挂在 smart 清扫之后的兜底)
    registerRuntimeSweep("auxCaches", ({ ttlHours } = {}) => {
      const cutoff = Date.now() - Math.max(1, Number(ttlHours) || 24) * 3600 * 1000
      let removed = 0
      for (const [gid, ts] of lastIncomingMsgAt) {
        if (!hasSmartRuntimeState(gid) && ts < cutoff) {
          lastIncomingMsgAt.delete(gid)
          consecutiveInterrupts.delete(gid)
          removed += 1
        }
      }
      return removed
    })
    // 禁言缓存独立 TTL(30 秒就过期,但冷群条目也别永留)
    registerRuntimeSweep("mutedCache", () => {
      const mutedCutoff = Date.now() - MUTED_CACHE_TTL_MS * 10
      let removed = 0
      for (const [gid, item] of mutedStatusCache) {
        if (item.at < mutedCutoff) { mutedStatusCache.delete(gid); removed += 1 }
      }
      return removed
    })
    // smart 清扫时连带清 lastIncoming/打断/禁言(同群同命运)
    registerRuntimeSweep("lastIncomingWithSmart", ({ ttlHours } = {}) => {
      const cutoff = Date.now() - Math.max(1, Number(ttlHours) || 24) * 3600 * 1000
      let removed = 0
      for (const gid of smartRuntimeGroupIds()) {
        const st = getSmartRuntimeState(gid)
        if ((st.lastMsgAt || 0) < cutoff) {
          lastIncomingMsgAt.delete(gid)
          consecutiveInterrupts.delete(gid)
          mutedStatusCache.delete(gid)
          removed += 1
        }
      }
      return removed
    })
  }

  startActiveChatLruScanner() {
    if (activeChatLruTimer) return
    this.registerAuxRuntimeSweeps()
    const intervalMs = 60 * 60 * 1000
    activeChatLruTimer = setInterval(() => {
      try {
        const ttlHours = Number(this.config?.smartTrigger?.activeChatTtlHours) || 24
        const { removed, results } = runRuntimeSweeps({ ttlHours, logger })
        if (removed > 0) {
          logger.info(`[ActiveChatLRU] 清扫 ${removed} 条(明细 ${JSON.stringify(results)}),当前活跃 ${smartRuntimeSize()}`)
        }
        // 回合会话:异常回合未 clearSession 的条目按 TTL/容量淘汰
        const sweptSessions = this.sessionStore?.sweep() || 0
        if (sweptSessions > 0) logger.info(`[回合会话] 清扫 ${sweptSessions} 个过期/超量会话，当前 ${this.sessionStore.stats().sessions}`)
      } catch (err) {
        logger.error('[ActiveChatLRU] 扫描失败:', err)
      }
    }, intervalMs)
    activeChatLruTimer.unref?.()
  }

  refreshLocalToolRegistry(...args: Tail<Parameters<typeof toolAssembly.refreshLocalToolRegistry>>) { return toolAssembly.refreshLocalToolRegistry(this,...args) }

  initTools(...args: Tail<Parameters<typeof toolAssembly.initTools>>) { return toolAssembly.initTools(this,...args) }

  initMessageHistory() {
    this.messageHistoriesRedisKey = "group_user_message_history"
    this.messageHistoriesDir = path.join(process.cwd(), "data/AItools/user_history")
    this.MAX_HISTORY = this.config.groupMaxMessages || 100

    if (!fs.existsSync(this.messageHistoriesDir)) {
      fs.mkdirSync(this.messageHistoriesDir, { recursive: true })
    }
  }

  async markStaleToolTasksFailed(){return await createHostRedisMaintenance(redis,logger).markStaleToolTasksFailed({taskPrefix:this.TASK_STATUS_PREFIX,activePrefix:this.ACTIVE_TOOL_TASK_PREFIX,staleMinutes:Number(this.config.longRunningToolStaleMinutes)||8,ttlSeconds:this.getTaskStatusTtlSeconds()})}

  initScheduledTasks() {
    // 每天0点清理消息历史记录
    schedule.scheduleJob('0 0 * * *', async () => {
      try {
        logger.info('开始执行消息历史记录清理定时任务')
        await this.clearAllMessages()
        logger.info('消息历史记录清理完成')
      } catch (error) {
        logger.error(`定时清理消息历史记录失败: ${error}`)
      }
    })

    // 每秒检查待触发的提醒
    schedule.scheduleJob('* * * * * *', async () => {
      try {
        await checkPendingReminders(this.toolInstances)
      } catch (error) {
        logger.error(`[定时提醒] 检查失败: ${error}`)
      }
    })

    logger.info('[定时任务] 提醒检查任务已启动（每秒）')
  }

  callOneBotApi(...args: Parameters<typeof groupContext.callOneBotApi>) { return groupContext.callOneBotApi(...args) }
  normalizeGroupContextText(...args: Parameters<typeof groupContext.normalizeGroupContextText>) { return groupContext.normalizeGroupContextText(...args) }
  pickNoticeText(...args: Parameters<typeof groupContext.pickNoticeText>) { return groupContext.pickNoticeText(...args) }
  extractGroupNoticeText(...args: Parameters<typeof groupContext.extractGroupNoticeText>) { return groupContext.extractGroupNoticeText(...args) }
  getBasicGroupContext(...args: Parameters<typeof groupContext.getBasicGroupContext>) { return groupContext.getBasicGroupContext(...args) }
  getCurrentGroupContext(...args: Parameters<typeof groupContext.getCurrentGroupContext>) { return groupContext.getCurrentGroupContext(...args) }
  getTextImageTemplateForFinalReply({ content, output, session, toolName, e }:Parameters<import('../../conversation/application/finalReply.js').FinalReplyHost['getTextImageTemplateForFinalReply']>[0]) {
    if (toolName === "textImageTool") return false
    if (!this.toolInstances?.textImageTool?.execute) {
      if (containsCodeFence(output) || containsCodeFence(content)) {
        logger.warn("[textImageTool] 工具未就绪，含代码块的回复将压平为纯文本发送而非转图")
      }
      return false
    }

    const userText = `${session?.userContent || ""}\n${e?.msg || ""}`
    if (shouldKeepModrinthReplyAsText(toolName, userText)) return false
    if (toolName === "googleImageAnalysisTool" && !shouldRenderImageAnalysisAsDocument({
      userText,
      output,
      looksDiagnostic: looksLikeDiagnosticExplanation(output) || looksLikeDiagnosticExplanation(content)
    }) && !looksLikeCodeOrMarkdown(content) && !looksLikeCodeOrMarkdown(output)) return false
    const userAskedForCodeOrMarkdown = isCodeOrMarkdownRequest(userText)
    const replyLooksLikeCodeOrMarkdown = looksLikeCodeOrMarkdown(content) || looksLikeCodeOrMarkdown(output)
    const userAskedForEducation = isEducationalExplanationRequest(userText)
    const userAskedForDiagnosticImageAnalysis = toolName === "googleImageAnalysisTool" &&
      shouldRenderImageAnalysisAsDocument({ userText, output })
    const isAnalysisDiagnosticReply = toolName === "googleImageAnalysisTool" &&
      (userAskedForDiagnosticImageAnalysis || looksLikeDiagnosticExplanation(output) || looksLikeDiagnosticExplanation(content))

    // Presentation is decided before model execution. A card remains a card
    // regardless of whether this turn used a tool-capable backend.
    if ((presentationKind(session?.turnPlan) === "knowledge" || userAskedForEducation) &&
        (looksLikeEducationalExplanation(output) || String(output || "").trim().length >= 260)) return "knowledge"
    if (isAnalysisDiagnosticReply) {
      return "document"
    }
    if (replyLooksLikeCodeOrMarkdown || (userAskedForCodeOrMarkdown && String(output || "").trim().length > 30)) {
      return "document"
    }
    // 带 LaTeX 公式的回复直接铺在 QQ 纯文本里是满屏 \frac 源码,统一进知识卡做数学排版
    if (hasLatexMath(output) || hasLatexMath(content)) return "knowledge"
    const longReply = analyzeReplyText(output)
    if (longReply.shouldRender) {
      return longReply.template
    }
    return false
  }

  async sendFinalReplyAsTextImage(...args: Tail<Parameters<typeof sendFinalReplyAsTextImage>>) { return await sendFinalReplyAsTextImage(this,...args) }

  async sendModrinthForwardItems(e:import('../../conversation/application/finalReply.js').FinalEvent, items:string[] = []) {
    const group=modrinthGroup(e.group)
    const nodes = (Array.isArray(items) ? items : []).filter(Boolean).map(text => ({
      user_id: ports.getBot()?.uin || e?.self_id || 0,
      nickname: ports.getBot()?.nickname || "希洛",
      message: String(text)
    }))
    if (!nodes.length) return null
    if (typeof group?.makeForwardMsg !== "function") {
      logger.warn("[Modrinth] 当前群适配器不支持合并转发，回退为普通文字")
      return await this.sendSegmentedMessage(e, nodes.map(node => node.message).join("\n\n"), 0)
    }
    const forward = await group.makeForwardMsg(nodes)
    const result = await this.sendObservedReply(e, forward, false, "agent_forward")
    logger.info(`[Modrinth] 已发送合并转发，共 ${nodes.length} 个模组节点`)
    return modrinthRecord(result).message_id
  }

  async sendModrinthForwardCards(e:import('../../conversation/application/finalReply.js').FinalEvent, cards:unknown[] = []) {
    const group=modrinthGroup(e.group)
    const source = (Array.isArray(cards) ? cards : []).map(modrinthRecord).filter(card => card.pageUrl && card.fallbackText)
    if (!source.length) return null
    if (typeof group?.makeForwardMsg !== "function") {
      logger.warn("[Modrinth] 当前群适配器不支持合并转发，回退为普通文字")
      return await this.sendSegmentedMessage(e, source.map(card => `${card.fallbackText}\n项目页: ${card.pageUrl}`).join("\n\n"), 0)
    }

    const renderStartedAt = Date.now()
    try {
      // The shared renderer rejects parallel calls while Chromium is starting.
      // Warm it once, then independent, uniquely named card pages can render in parallel.
      await prewarmModrinthCardRenderer()
    } catch (error) {
      logger.warn(`[Modrinth] 卡面渲染器预热失败，将逐项尝试渲染: ${error instanceof Error?error.message:String(error)}`)
    }

    let imageCount = 0
    const messages = await Promise.all(source.map(async card => {
      try {
        const image = await renderModrinthCard(e, card)
        if (!image) throw new Error("HTML 卡面没有返回图片")
        imageCount += 1
        return [image, `\n项目页: ${card.pageUrl}`]
      } catch (error) {
        logger.warn(`[Modrinth] 卡面渲染失败，回退完整文本 project=${card.projectId || ""}: ${error instanceof Error?error.message:String(error)}`)
        return [`${card.fallbackText}\n项目页: ${card.pageUrl}`]
      }
    }))
    logger.info(`[Modrinth] 卡面渲染完成 image=${imageCount}/${source.length} fallback=${source.length - imageCount} elapsed=${Date.now() - renderStartedAt}ms`)
    const nodes = messages.map(message => ({
      user_id: ports.getBot()?.uin || e?.self_id || 0,
      nickname: ports.getBot()?.nickname || "希洛",
      message
    }))
    const forward = await group.makeForwardMsg(nodes)
    const result = await this.sendObservedReply(e, forward, false, "agent_forward")
    logger.info(`[Modrinth] 已发送 HTML 卡面合并转发，共 ${nodes.length} 个模组节点`)
    return modrinthRecord(result).message_id
  }

  /**
   * 启动/重置用户独立的会话追踪定时器
   * @param {string} conversationKey - 会话key
   * @param {object} newData - 要更新的数据 { chatHistory, lastActiveTime }
   */
  setTrackingWithTimer(...args: Tail<Parameters<typeof setTrackingWithTimer>>) { return setTrackingWithTimer(this,...args) }

  /**
   * 解析对话焦点状态（FOCUS / FADING / COLD），含自动衰减。每次入口都该调一次。
   * 长时间无消息时一次性衰减到位（focus 经过 fading 直到 cold），避免误判为"刚进入 fading"。
   */
  resolveConversationPhase(...args: Tail<Parameters<typeof resolveConversationPhase>>) { return resolveConversationPhase(this,...args) }

  /**
   * 本地预筛：免 LLM 决定明显该回 / 不该回 / 高优先级走 Gate。
   * 返回 { kind, reason }，kind 取值：
   *   'force_continue' - @bot / 触发关键词命中（外层已有 inevitableAtReply 处理，这里主要识别"引用 bot 消息"）
   *   'addressed_other' - 消息 @ 了非 bot
   *   'empty_content' - 纯表情/图片/转账，无文本
   *   'bot_self_echo' - bot 自己发的消息
   *   'continuation_strong' - 命中 R1/R2/R3/R4 任一，应走 Gate
   *   'regular' - 默认
   */
  prefilterMessage(...args: Tail<Parameters<typeof conversationPrefilter.prefilterMessage>>) { return conversationPrefilter.prefilterMessage(this,...args) }

  /**
   * 计算群最近 5 分钟消息数（含 bot 自己的回复，用于 Gate prompt 活跃度信号）。
   * 仅做粗略统计：state.recentIncomingTimestamps 滑动窗口。
   */
  computeGroupMsgRate5min(...args: Tail<Parameters<typeof computeGroupMsgRate5min>>) { return computeGroupMsgRate5min(this,...args) }

  /**
   * Bot 速率硬上限检查（防刷屏最终防线）。
   * 返回 true=可以继续回复，false=已超上限不该回复（force 路径请勿调用本函数）
   */
  applyRateLimitGuard(...args: Tail<Parameters<typeof applyRateLimitGuard>>) { return applyRateLimitGuard(this,...args) }

  /**
   * 冷群空窗 deferred timer：仅 phase=cold 时排，按 (threshold-currentEquiv)*avgMs 估算延迟，
   * 到点合成 _smartWaitRerun 事件再跑一轮 Gate。
   * 注意：本函数通常在 inFlight=true 时（主流程 try 块内）被调用，因此**不要**用 inFlight 守卫；
   * 真正的并发保护放在 setTimeout 回调里（callback 触发时再检查 inFlight）。
   */
  scheduleDeferredGateCheck(...args: Tail<Parameters<typeof conversationScheduling.scheduleDeferredGateCheck>>) { return conversationScheduling.scheduleDeferredGateCheck(this,...args) }

  /**
   * 执行参与复读：直接 e.reply(原文) 跳过 Gate / handleTool（规避 LLM 改写），
   * 仍占用速率配额，但不升 FOCUS（复读不算正常对话参与）。
   * rate limit 已满时返回 false 不复读。
   */
  async joinRepeat(...args: Tail<Parameters<typeof joinRepeat>>) { return await joinRepeat(this,...args) }

  /**
   * 复读检测：看最近 N 条群消息，若至少 minCount 个不同用户发了和当前 e.msg 完全相同的内容，
   * 按 repeatJoinProbability 概率决定 bot 是否参与复读。返回要复读的文本，否则 null。
   * 命中时不走 Gate / handleTool，直接 e.reply 原文，规避 LLM 改写。
   */
  detectGroupRepeat(...args: Tail<Parameters<typeof detectGroupRepeat>>) { return detectGroupRepeat(this,...args) }

  // ==================== smart 模式：Timing Gate 触发 ====================

  /**
   * 判断 bot 是否在该群被禁言（个人禁言或全员禁言）。
   * 兼容两套协议端字段：
   *  - ICQQ：member.shutup_time / group.mute_left / group.info.shutup_time_me / .shutup_time_whole
   *    语义：值 = 剩余禁言秒数（unix 时间戳 - 现在），> 0 即被禁言
   *  - OneBot v11 / Napcat：member.shut_up_timestamp / group.info.group_all_shut 等
   *    语义：shut_up_timestamp 是禁言到期 unix 秒时间戳，需对比当前时间
   * 短期 LRU 缓存（30s）避免每条群消息都发一次 ws RPC；
   * 任何异常都视为"未禁言"，避免误阻塞。
   */
  async isMutedInGroup(e: Parameters<typeof mutedGroupPolicy.isMutedInGroup>[0]) {return await mutedGroupPolicy.isMutedInGroup(e)}

  getSmartState(groupId: string|number|undefined, e?: {self_id?:string|number;bot?:{uin?:string|number}}) {
    // 群运行时状态统一门面:smart 状态存储已迁 core/runtime/groupRuntime.js(行为不变)
    return getSmartRuntimeState(smartConversationKey(groupId ?? "", e))
  }

  getDirectTriggerMergeMs(...args: Tail<Parameters<typeof getDirectTriggerMergeMs>>) { return getDirectTriggerMergeMs(this,...args) }

  getDirectTriggerMergeMaxMessages(...args: Tail<Parameters<typeof getDirectTriggerMergeMaxMessages>>) { return getDirectTriggerMergeMaxMessages(this,...args) }

  getMergeMsForEvent(...args: Tail<Parameters<typeof conversationScheduling.getMergeMsForEvent>>) { return conversationScheduling.getMergeMsForEvent(this,...args) }

  isMergeableDirectTrigger(...args: Tail<Parameters<typeof conversationScheduling.isMergeableDirectTrigger>>) { return conversationScheduling.isMergeableDirectTrigger(this,...args) }

  buildMergedDirectTriggerEvent(...args: Tail<Parameters<typeof conversationScheduling.buildMergedDirectTriggerEvent>>) { return conversationScheduling.buildMergedDirectTriggerEvent(this,...args) }

  buildMergedDirectTriggerPrompt(...args: Tail<Parameters<typeof conversationScheduling.buildMergedDirectTriggerPrompt>>) { return conversationScheduling.buildMergedDirectTriggerPrompt(this,...args) }

  scheduleMergedDirectTrigger(...args: Tail<Parameters<typeof conversationScheduling.scheduleMergedDirectTrigger>>) { return conversationScheduling.scheduleMergedDirectTrigger(this,...args) }

  isMergeableToolRequest(...args: Tail<Parameters<typeof conversationScheduling.isMergeableToolRequest>>) { return conversationScheduling.isMergeableToolRequest(this,...args) }

  isLikelyToolRequestText(...args: Tail<Parameters<typeof conversationEntryPolicy.isLikelyToolRequestText>>) { return conversationEntryPolicy.isLikelyToolRequestText(this,...args) }

  isAutomaticTorrentDownloadEvent(...args: Tail<Parameters<typeof conversationEntryPolicy.isAutomaticTorrentDownloadEvent>>) { return conversationEntryPolicy.isAutomaticTorrentDownloadEvent(this,...args) }

  buildMergedToolRequestEvent(...args: Tail<Parameters<typeof conversationScheduling.buildMergedToolRequestEvent>>) { return conversationScheduling.buildMergedToolRequestEvent(this,...args) }

  scheduleMergedToolRequest(e:ChatTurnEvent, handler:(event:ChatTurnEvent)=>Promise<void>) {
    if (e.group_id === undefined) return null
    const event=Object.assign(normalizeHostChatEvent(e,ports.getBot()),{group_id:e.group_id})
    const {_triggerContext,reply,...scope}=event
    const scheduled={...scope,...(typeof reply==='function'?{reply:(...args:unknown[])=>reply(args[0],typeof args[1]==='boolean'?args[1]:undefined)}:{}),...(_triggerContext?.mode?{_triggerContext:{mode:_triggerContext.mode}}:{})}
    return conversationScheduling.scheduleMergedToolRequest(this,scheduled,async merged=>handler(normalizeHostChatEvent(merged,ports.getBot())))
  }

  /**
   * smart 模式触发入口：每条群消息进入此函数，按 talkValue 阈值/空窗补偿/强制覆盖三种条件决定是否调 Timing Gate
   */
  async handleRandomReplySmart(...args: Tail<Parameters<typeof handleRandomReplySmartFn>>) { return await handleRandomReplySmartFn(this,...args) }

  shouldReleaseSmartLockForLongTask(e: {msg?:string} = {}) {
    return resolveLongTaskFeedbackPolicy(String(e?.msg || ""))?.releaseSmartLock === true
  }

  releaseSmartInFlight(...args: Tail<Parameters<typeof conversationScheduling.releaseSmartInFlight>>) { return conversationScheduling.releaseSmartInFlight(this,...args) }

  getSmartLockTimeoutMs(...args: Tail<Parameters<typeof conversationScheduling.getSmartLockTimeoutMs>>) { return conversationScheduling.getSmartLockTimeoutMs(this,...args) }

  scheduleSmartLockWatchdog(...args: Tail<Parameters<typeof conversationScheduling.scheduleSmartLockWatchdog>>) { return conversationScheduling.scheduleSmartLockWatchdog(this,...args) }

  /**
   * 调用 Timing Gate 子代理，返回 { decision: 'continue'|'no_action'|'wait', wait_seconds?, reason? }
   * @param ctx 额外上下文：{ phase, prefilter, threshold }
   */
  async runTimingGate(...args: Tail<Parameters<typeof runTimingGateFn>>) { return await runTimingGateFn(this,...args) }

  /**
   * 回复 debounce：等待 replyDebounceMs 看群里是否有新消息进来；
   * 有新消息且未到 maxConsecutiveInterrupts 上限 → 让步本轮（return false）；
   * 否则放行（return true）。force 路径应在调用方跳过本检查。
   */
  async applyReplyDebounce(...args: Tail<Parameters<typeof conversationScheduling.applyReplyDebounce>>) { return await conversationScheduling.applyReplyDebounce(this,...args) }

  /**
   * 解析 talkValue：优先用时段化规则，否则用全局 talkValue
   */
  resolveTalkValue(...args: Tail<Parameters<typeof resolveTalkValue>>) { return resolveTalkValue(this,...args) }

  /**
   * 空窗补偿：冷群按 idle/avg_latency 折算"等效消息数"，凑够阈值就触发
   * @param state - 该群的 SmartState
   * @param threshold - 当前阈值（ceil(1/talkValue)）
   * @param prevLastMsgAt - 上一条消息的时间戳（本次入口前的值，必须由调用方传入，否则 idle=0 永远不命中）
   */
  idleCompensationMet(...args: Tail<Parameters<typeof idleCompensationMet>>) { return idleCompensationMet(this,...args) }

  /**
   * 计算最近 10 分钟平均回复延迟（毫秒）
   */
  computeAvgReplyLatency(...args: Tail<Parameters<typeof computeAvgReplyLatency>>) { return computeAvgReplyLatency(this,...args) }

  /**
   * 记录一次"用户消息→bot 回复"的延迟，给空窗补偿用。两种模式都调用。
   */
  recordReplyLatency(...args: Tail<Parameters<typeof recordReplyLatency>>) { return recordReplyLatency(this,...args) }

  /**
   * 安排 N 秒后强制再触发一轮 Gate，让 LLM 决定要不要补一句（wait 工具/Gate wait 决策共用）
   */
  scheduleWaitReply(...args: Tail<Parameters<typeof conversationScheduling.scheduleWaitReply>>) { return conversationScheduling.scheduleWaitReply(this,...args) }

  /**
   * 外部插件主动触发：注入 intent 到群历史 + 强制下一轮 Gate continue
   * @param {string|number} groupId
   * @param {string} intent 主动想说的话题/意图
   * @param {object} opts { source: '插件名', anchorE: 可选锚点 e }
   */
  async enqueueProactiveTask(...args: Tail<Parameters<typeof conversationScheduling.enqueueProactiveTask>>) { return await conversationScheduling.enqueueProactiveTask(this,...args) }

  async scanRedisKeys(pattern:string){return await createHostRedisMaintenance(redis,logger).scanRedisKeys(pattern)}
  async deleteRedisKeys(keys:string[]=[]){return await createHostRedisMaintenance(redis,logger).deleteRedisKeys(keys)}
  async clearAllMessages(){return await createHostRedisMaintenance(redis,logger).clearAllMessages(this.REDIS_KEY_PREFIX)}

  getTaskStatusCacheKey(...args: Tail<Parameters<typeof getTaskStatusCacheKey>>) { return getTaskStatusCacheKey(this,...args) }

  getTaskStatusRedisKey(...args: Tail<Parameters<typeof getTaskStatusRedisKey>>) { return getTaskStatusRedisKey(this,...args) }

  getActiveToolTaskCacheKey(...args: Tail<Parameters<typeof getActiveToolTaskCacheKey>>) { return getActiveToolTaskCacheKey(this,...args) }

  getActiveToolTaskRedisKey(...args: Tail<Parameters<typeof getActiveToolTaskRedisKey>>) { return getActiveToolTaskRedisKey(this,...args) }

  getTaskStatusTtlSeconds(...args: Tail<Parameters<typeof getTaskStatusTtlSeconds>>) { return getTaskStatusTtlSeconds(this,...args) }

  async saveTaskStatus(input:Omit<Tail<Parameters<typeof saveTaskStatus>>[0],'messageId'> & {messageId?:unknown}) {
    const {messageId,...rest}=input
    return await saveTaskStatus(this,{...rest,...(typeof messageId==='string'||typeof messageId==='number'?{messageId}:{})})
  }

  async getTaskStatus(...args: Tail<Parameters<typeof getTaskStatus>>) { return await getTaskStatus(this,...args) }

  async clearTaskStatus(...args: Tail<Parameters<typeof clearTaskStatus>>) { return await clearTaskStatus(this,...args) }

  async getTurnActionFacts(e:ActionFactsEvent,query:ActionFactsQuery={}) {
    const tasks=await getTurnActionFacts(this,e,query)
    const reminder=this.toolInstances?.reminderTool
    if(!reminder||typeof reminder!=='object'||!('getActionFacts' in reminder)||typeof reminder.getActionFacts!=='function')return tasks
    try {
      const scheduled=validateTurnActionFacts(await Reflect.apply(reminder.getActionFacts,reminder,[e,query]) as TurnActionFacts,e,Date.now(),query)
      return {...tasks,lookup:tasks.lookup==='ok'&&scheduled.lookup==='ok'?'ok' as const:'unavailable' as const,tasks:[...tasks.tasks,...scheduled.tasks]}
    } catch {return {...tasks,lookup:'unavailable' as const}}
  }

  async updateUserToolTaskStatus(...args: Tail<Parameters<typeof updateUserToolTaskStatus>>) { return await updateUserToolTaskStatus(this,...args) }

  async getUserToolTaskStatus(...args: Tail<Parameters<typeof getUserToolTaskStatus>>) { return await getUserToolTaskStatus(this,...args) }

  async clearUserToolTaskStatus(...args: Tail<Parameters<typeof clearUserToolTaskStatus>>) { return await clearUserToolTaskStatus(this,...args) }

  getRuntimeToolTaskStatus(...args: Tail<Parameters<typeof getRuntimeToolTaskStatus>>) { return getRuntimeToolTaskStatus(this,...args) }

  async getCurrentUserToolTaskStatus(...args: Tail<Parameters<typeof getCurrentUserToolTaskStatus>>) { return await getCurrentUserToolTaskStatus(this,...args) }

  buildDrawTaskStatusReply(...args: Tail<Parameters<typeof buildDrawTaskStatusReply>>) { return buildDrawTaskStatusReply(this,...args) }

  buildReplySegment(...args: Tail<Parameters<typeof buildReplySegment>>) { return buildReplySegment(this,...args) }

  buildTaskStatusReplyMessage(...args: Tail<Parameters<typeof buildTaskStatusReplyMessage>>) { return buildTaskStatusReplyMessage(this,...args) }

  async handleActiveDrawStatusQuestion(...args: Tail<Parameters<typeof handleActiveDrawStatusQuestion>>) { return await handleActiveDrawStatusQuestion(this,...args) }

  formatTaskStatusForPrompt(...args: Tail<Parameters<typeof formatTaskStatusForPrompt>>) { return formatTaskStatusForPrompt(this,...args) }

  getToolRunKey(groupId:unknown, userId:unknown, toolName:unknown, event?:ActionFactsEvent) {
    const botId=event?.self_id||event?.bot?.uin
    return `${botId?`bot:${botId}:`:""}${groupId}:${userId}:${toolName}`
  }

  async beginConversationTask(e:Pick<ChatTurnEvent,"group_id"|"user_id"|"message_id">) {
    const groupId = e.group_id
    const userId = e.user_id
    const messageId=typeof e.message_id==='string'||typeof e.message_id==='number'?e.message_id:null
    if (!groupId || !userId) return { groupId, userId, messageId }

    const task = {
      groupId,
      userId,
      messageId,
      startedAt: Date.now()
    }

    if (task.messageId) {
      await this.saveTaskStatus({
        groupId,
        userId,
        messageId: task.messageId,
        status: "processing"
      })
    }

    return task
  }

  async finishConversationTask(task:Awaited<ReturnType<ExamplePlugin["beginConversationTask"]>>|null|undefined, session:{taskDedupeToolTouched?:boolean}|null|undefined) {
    if (!task?.groupId || !task?.userId) return

    if (!task.messageId || session?.taskDedupeToolTouched) return

    const status = await this.getTaskStatus(task.groupId, task.messageId)
    if (!status || status.status === "processing") {
      await this.clearTaskStatus(task.groupId, task.messageId)
    }
  }

  isDedupeTool(toolName:string) {
    return this.dedupeToolNames?.has(toolName)
  }

  isToolResultError(result:unknown) {
    const text = typeof result === "string" ? result : JSON.stringify(result || "")
    return /^error[:：]/i.test(text.trim()) || /"error"\s*:/.test(text) || /失败|错误|失敗|錯誤/.test(text)
  }

  isRawToolFailure(result:unknown) {
    const text = typeof result === "string" ? result.trim() : JSON.stringify(result || "").trim()
    return /^error[:：]/i.test(text) ||
      /^\{\s*"error"\s*:/i.test(text) ||
      /^(?:[^\n]{0,48})(?:请求|查询|分析|下载|解析|发送|处理|执行|生成|编辑).{0,20}(?:失败|错误|异常|超时)/i.test(text)
  }

  syncDedupeToolConfig(...args: Tail<Parameters<typeof toolAssembly.syncDedupeToolConfig>>) { return toolAssembly.syncDedupeToolConfig(this,...args) }

  getToolsByName(...args: Tail<Parameters<typeof toolAssembly.getToolsByName>>) { return toolAssembly.getToolsByName(this,...args) }

  getToolsDescriptionString(...args: Tail<Parameters<typeof toolAssembly.getToolsDescriptionString>>) { return toolAssembly.getToolsDescriptionString(this,...args) }

  ensureConfigFiles() {
    return this.initConfigStore().ensureFiles()
  }

  initConfigStore() {
    if (sharedConfigStore) return sharedConfigStore
    sharedConfigStore = createConfigStore({
      pluginRoot: path.join(process.cwd(), "plugins/shiloh-plugin"),
      configFiles: ["message.yaml", "mcp-servers.yaml"],
      watchImpl: (file, cb) => chokidar.watch(file).on("change", ()=>cb(file)),
      onChange: async settings => {
        this.config = decodeHostConfig(settings)
        // 刷新各模块配置
        const state = initializeSharedState(this.config)
        this.knowledgeSearcher = state.knowledgeSearcher
        this.MAX_HISTORY = this.config.groupMaxMessages || 100
        await this.refreshLocalToolRegistry({ force: true }).catch(error => {
          logger.error(`[shiloh-plugin][热更新] 重新加载本地工具失败: ${error}`)
          this.initTools()
        })
      }
    })
    return sharedConfigStore
  }

  initConfig() {
    const store = this.initConfigStore()
    const { settings } = store.load()
    this.config = decodeHostConfig(settings)
    store.startWatch()
  }

  // 当前会话生效人设:群按 persona-library 的群绑定,私聊按 privateBinding,
  // 其次按 bot 账号默认(accountBindings),否则 message.yaml 默认
  getPersonaFor(e:unknown) {
    const event=modrinthRecord(e)
    const snapshot = event._personaSnapshot as PersonaSnapshot | undefined
    if (snapshot?.persona && snapshot.botId === String(event.self_id || modrinthRecord(event.bot).uin || '')) return snapshot.persona
    try {
      return this.personaLibrary?.resolve({
        messageType: String(event.message_type || ""),
        groupId: String(event.group_id || ""),
        selfId: String(event.self_id || modrinthRecord(event.bot).uin || "")
      })?.persona || this.config?.persona || {}
    } catch {
      return this.config?.persona || {}
    }
  }

  // 按会话人设生成的配置视图:未绑定群直接复用全局配置对象(零开销),绑定群浅拷贝替换 persona
  getChatConfig(e:unknown): import('./hostConfig.js').HostConfig {
    const snapshot = modrinthRecord(e)._personaSnapshot as PersonaSnapshot | undefined
    if (snapshot) {
      const {personaGuard: _liveGuard, ...config} = this.config
      return {...config, persona: snapshot.persona, systemContent: snapshot.systemContent, ...(snapshot.personaGuard ? {personaGuard: snapshot.personaGuard} : {})}
    }
    const persona = this.getPersonaFor(e)
    if (!persona || persona === this.config?.persona) return this.config
    return { ...this.config, persona }
  }

  getPersonaSnapshotFor(e:unknown): PersonaSnapshot {
    const event = modrinthRecord(e)
    const botId = String(event.self_id || modrinthRecord(event.bot).uin || '')
    const resolved = this.personaLibrary?.resolve({messageType: String(event.message_type || ''), groupId: String(event.group_id || ''), selfId: botId})
    return createPersonaSnapshot({
      botId,
      personaId: resolved?.id || 'default',
      persona: resolved?.persona || this.config.persona || {},
      systemContent: this.config.systemContent || '',
      ...(this.config.personaGuard ? {personaGuard: this.config.personaGuard} : {})
    })
  }

  mergeConfig(defaults:Record<string,unknown>, user:unknown) {
    return mergeDeepConfig(defaults, user)
  }

  mergeConfigPreserveUser(defaults:Record<string,unknown>, user:Record<string,unknown>):Record<string,unknown>;
  mergeConfigPreserveUser(defaults:unknown, user:unknown):unknown;
  mergeConfigPreserveUser(defaults:unknown, user:unknown):unknown {
    if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
      return user === undefined ? defaults : user
    }
    if (!user || typeof user !== "object" || Array.isArray(user)) {
      return defaults
    }

    const merged:Record<string,unknown> = {}
    const base=modrinthRecord(defaults), overrides=modrinthRecord(user)
    for (const key of Object.keys(defaults)) {
      merged[key] =
        key in user ? this.mergeConfigPreserveUser(base[key], overrides[key]) : base[key]
    }
    for (const key of Object.keys(user)) {
      if (!(key in defaults)) {
        merged[key] = overrides[key]
      }
    }
    return merged
  }

  mergeMCPConfig(...args: Tail<Parameters<typeof toolAssembly.mergeMCPConfig>>) { return toolAssembly.mergeMCPConfig(this,...args) }

  checkGroupPermission(e:Pick<ChatTurnEvent,"group_id">) {
    if (!this.config.enableGroupWhitelist) return true
    return this.config.allowedGroups.some(id => String(id) === String(e.group_id))
  }

  // 私聊回合入口:门禁(开关/白名单/节流) → 违禁词 → 锚点 → 主回合
  async handlePrivateChat(...args: Tail<Parameters<typeof conversationEntryPolicy.handlePrivateChat>>) { return await conversationEntryPolicy.handlePrivateChat(this,...args) }

  isUserBlacklisted(...args: Tail<Parameters<typeof conversationEntryPolicy.isUserBlacklisted>>) { return conversationEntryPolicy.isUserBlacklisted(this,...args) }

  // 违禁词命中处理:标记会话中断(掐掉该群所有早于此的进行中回合) + 取消排队续话。
  // 返回 true 表示本条消息已被黑名单吞掉,调用方直接 return。
  handleForbiddenWordHit(...args: Tail<Parameters<typeof conversationEntryPolicy.handleForbiddenWordHit>>) { return conversationEntryPolicy.handleForbiddenWordHit(this,...args) }

  // 记忆自纠错:群友指出"你记错了"时,自动降权她上一轮引用的记忆(降权非删除,重复纠错自然淡忘)
  handleMemorySelfCorrection(...args: Tail<Parameters<typeof conversationEntryPolicy.handleMemorySelfCorrection>>) { return conversationEntryPolicy.handleMemorySelfCorrection(this,...args) }

  // 中断后的排队清理:延迟触发/续话定时器/待重跑事件全部作废,新消息可开新对话
  cancelPendingConversation(...args: Tail<Parameters<typeof conversationScheduling.cancelPendingConversation>>) { return conversationScheduling.cancelPendingConversation(this,...args) }

  getGroupUserMessages(...args: Tail<Parameters<typeof conversationHistory.getGroupUserMessages>>) { return conversationHistory.getGroupUserMessages(this,...args) }

  saveGroupUserMessages(...args: Tail<Parameters<typeof conversationHistory.saveGroupUserMessages>>) { return conversationHistory.saveGroupUserMessages(this,...args) }

  clearGroupUserMessages(...args: Tail<Parameters<typeof conversationHistory.clearGroupUserMessages>>) { return conversationHistory.clearGroupUserMessages(this,...args) }

  resetGroupUserMessages(...args: Tail<Parameters<typeof conversationHistory.resetGroupUserMessages>>) { return conversationHistory.resetGroupUserMessages(this,...args) }

  formatTime(...args: Tail<Parameters<typeof formatTime>>) { return formatTime(this,...args) }

  collectForwardPromptLines(...args: Tail<Parameters<typeof conversationHistory.collectForwardPromptLines>>) { return conversationHistory.collectForwardPromptLines(this,...args) }

  resolveForwardPromptFromSegments(segments:unknown[]=[],group?:unknown) {const raw=modrinthRecord(group);const get=raw.getForwardMsg;return conversationHistory.resolveForwardPromptFromSegments(this,segments,typeof get==='function'?{getForwardMsg:async id=>Reflect.apply(get,group,[id]) as unknown}:undefined)}

  async buildMessageContent(...args: Tail<Parameters<typeof buildMessageContent>>) { return await buildMessageContent(this,...args) }

  checkTriggers(...args: Tail<Parameters<typeof conversationEntryPolicy.checkTriggers>>) { return conversationEntryPolicy.checkTriggers(this,...args) }

  isCommand(...args: Tail<Parameters<typeof conversationEntryPolicy.isCommand>>) { return conversationEntryPolicy.isCommand(this,...args) }

  filterChatByQQ<T extends {role?:string;content?:unknown}>(messages:T[],id:unknown):T[] {return conversationHistory.filterChatByQQ(this,messages,id)}

  getOrCreateSession(sessionId: string, tools: import('../../../contracts/toolExecution.js').ToolDefinition[]) {
    return this.sessionStore.getOrCreate(sessionId, tools)
  }

  clearSession(sessionId: string) {
    this.sessionStore.clear(sessionId)
  }

  trimMessageHistory<T extends {role?:string;content?:unknown}>(messages:T[]):T[] {return conversationHistory.trimMessageHistory(this,messages)}

  /**
   * AI判断用户是否在继续跟机器人对话
   * @param {string} userMessage - 用户新消息
   * @param {Array} chatHistory - 对话历史数组 [{role: 'bot'|'user', content: '...'}]
   */
  async isUserTalkingToBot(...args: Tail<Parameters<typeof isUserTalkingToBot>>) { return await isUserTalkingToBot(this,...args) }

  /**
   * 加入批量判断队列
   */
  addToBatchJudgment(...args: Tail<Parameters<typeof addToBatchJudgment>>) { return addToBatchJudgment(this,...args) }

  /**
   * 处理批量判断队列
   */
  async processBatchJudgments(...args: Tail<Parameters<typeof processBatchJudgments>>) { return await processBatchJudgments(this,...args) }

  /**
   * 批量判断多条消息是否在跟机器人对话
   */
  async batchIsUserTalkingToBot(...args: Tail<Parameters<typeof batchIsUserTalkingToBot>>) { return await batchIsUserTalkingToBot(this,...args) }

  /**
   * 回退到单独判断
   */
  async fallbackToSingleJudgment(...args: Tail<Parameters<typeof fallbackToSingleJudgment>>) { return await fallbackToSingleJudgment(this,...args) }

  async handleRandomReply(...args: Tail<Parameters<typeof handleRandomReply>>) { return await handleRandomReply(this,...args) }

  async handleToolInner(event:unknown):Promise<unknown> {return await handleToolInnerFn(this,normalizeHostChatEvent(event,ports.getBot()))}

  formatMessages(...args: Tail<Parameters<typeof formatMessages>>) {
    return (formatMessages(this,...args)||[]).map(message=>({...message,content:typeof message.content==='string'?message.content:''}))
  }

  /**
   * 格式化工具返回结果（截断过长内容）
   */

	  async retryRequest(...args: Tail<Parameters<typeof toolAssembly.retryRequest>>) { return decodeHostModelResponse(await toolAssembly.retryRequest(this,...args)) }

  getFriendlyFailureMessage(name = '', context: Partial<import('../../../contracts/toolExecution.js').ExecutionFailureContext> = {}) {return getFriendlyFailureMessage(name,{error:context.error,...(context.e?{e:context.e}:{}),...(context.session?{session:normalizeFailureSession(context.session)}:{})})}

  async composeToolFailureReply(toolName = "", context:ToolFailureContext = {}) {
    const fallback = context.factualReply || this.getFriendlyFailureMessage(toolName,context)
    const messages = selectAgentReplyContext(context.messages).filter((item):item is NonNullable<typeof item>=>Boolean(item)).map(item=>({role:item.role || "user",content:String(item.content || "")}))
    if (!messages.length) return fallback

    try {
      const response = await this.retryRequest(
        buildChatRequestData(this.config, [
          ...messages,
          { role: "system", content: buildToolFailureReplyInstruction({ factualReply: fallback, toolName }) }
        ], [], "none"),
        context.session?.toolContent || "",
        0,
        toolName,
        {
          routeLabel: "工具失败自然回复",
          generation: { temperature: 0.55, maxOutputTokens: 240 }
        }
      )
      const content = String(response?.choices?.[0]?.message?.content || "").trim()
      if (content && !containsInternalStatusLeak(content)) return content
    } catch (error) {
      logger.debug?.(`[工具失败回复] Agent 组织失败，使用事实兜底: ${error instanceof Error?error.message:String(error)}`)
    }
    return fallback
  }

  // P4 主判定：模型意图优先（6s 超时，confidence<0.7 或失败返回 null 走正则兜底）
  async resolvePrimaryModelIntent(text:string, { hasImages = false } = {}) {
    const ai = this.config?.intentAiConfig || this.config?.toolsAiConfig || {}
    if (!this.config.intentAiConfig?.intentAiUrl && !this.config.toolsAiConfig?.toolsAiUrl) return null
    try {
      const result = await classifyIntentWithModel({ text, hasImages, config: this.config, timeoutMs: 6000 })
      if (result.intent === "unavailable" || result.confidence < 0.7) return null
      logger.info(`[意图主判定] model=${result.intent} conf=${result.confidence} text=${String(text).slice(0, 30)}`)
      return result
    } catch {
      return null
    }
  }

  /** 强制反应表情的配文概率：配置值 + 该群裸表情占比自适应（样本不足用默认） */
  async resolveForcedReplyTextRate(groupId = "") {
    if (this.config?.emojiSystem?.forcedReplyTextEnabled === false) return 0
    const configured = Math.max(0, Math.min(0.8, Number(this.config?.emojiSystem?.forcedReplyTextRate ?? 0.4)))
    try {
      const stats = await this.expressionLearner?.getGroupEmojiLayoutStats?.(groupId)
      return adaptForcedReplyTextRate(stats, configured)
    } catch {
      return configured
    }
  }

  async handleToolFailureResponse(toolName = "", context:ToolFailureContext = {}) {
    // 出站仲裁：工具已失败，扣住的承诺类文案直接丢弃，只发事实性失败说明
    const arbiter=modrinthRecord(context.session?.outboundArbiter);if(typeof arbiter.markFailure==='function')Reflect.apply(arbiter.markFailure,context.session?.outboundArbiter,[])
    // 表情包是锦上添花的反应形态：限流/文件缺失/发送失败时不再起一次润色模型道歉——
    // 道歉文本本身就是观感问题，静默跳过即可（无匹配/库空已由工具返回文字引导，不走这里）
    if (toolName === LOCAL_EMOJI_TOOL_NAME) {
      logger.info(`[表情包] 发送未完成，本轮静默跳过: ${String(context?.factualReply || context?.error || "").slice(0, 120)}`)
      return
    }
    if (!context.e || !context.session) return
    if (isImageDeliveryToolName(toolName) && context?.e?.group_id) {
      recordDrawTextFallback(context.e.group_id, context?.session?.rawArgs || context?.e?.msg || "")
    }
    // 画图类失败不交给模型润色：实测模型会无视"已失败"的事实指令，
    // 对着原始请求回出"当然可以～我会画成…"这类承诺话术
    if (isImageDeliveryToolName(toolName)) {
      const factualReply = context.factualReply || this.getFriendlyFailureMessage(toolName,context)
      return await this.handleTextResponse(factualReply, normalizeFailureEvent(context.e), normalizeFailureSession(context.session), normalizeFailureMessages(context.messages), toolName)
    }
    const output = await this.composeToolFailureReply(toolName, context)
    return await this.handleTextResponse(output, normalizeFailureEvent(context.e), normalizeFailureSession(context.session), normalizeFailureMessages(context.messages), toolName)
  }

  getToolFailureKind(error:unknown = "") {
    const text = typeof error === "string" ? error : JSON.stringify(error || "") || ""
    if (!text.trim()) return "unknown"
    if (/图片|image|multipart|safety|content.?filter|审核|发送|download|链接/i.test(text)) return classifyImageFailure(text)
    if (/超时|timeout|timed?\s*out|AbortError|超过\s*\d+\s*秒|没有返回/i.test(text)) return "timeout"
    if (/未接收到有效图片|未接收到有效图像|no\s*(valid\s*)?image|empty|invalid image response|没有拿到.*图/i.test(text)) return "empty_image"
    if (/safety|sensitive|policy|content.?filter|risk|blocked|敏感|审核|安全|违规|不合规|拦截/i.test(text)) return "safety"
    if (/429|rate.?limit|quota|too many requests|insufficient|余额|限流|频率/i.test(text)) return "rate_limit"
    if (/401|403|unauthorized|forbidden|permission|invalid.?key|api.?key|token|鉴权|权限|密钥/i.test(text)) return "auth"
    if (/发送|send|reply|segment|download|链接已过期|无效的图片|无效的图片下载链接|图片下载/i.test(text)) return "send"
    if (/\b5\d\d\b|bad gateway|gateway|service unavailable|temporar(?:y|ily)|上游|接口/i.test(text)) return "upstream"
    return "unknown"
  }

  getQuotedPromptContextText(...args: Tail<Parameters<typeof getQuotedPromptContextText>>) { return getQuotedPromptContextText(this,...args) }
  getRecentPromptContextText(...args: Tail<Parameters<typeof getRecentPromptContextText>>) { return getRecentPromptContextText(this,...args) }
  getRecentDrawContextText(...args: Tail<Parameters<typeof getRecentDrawContextText>>) { return getRecentDrawContextText(this,...args) }
  resolveContextualDrawGeneration(...args: Tail<Parameters<typeof resolveContextualDrawGeneration>>) { return resolveContextualDrawGeneration(this,...args) }
  getUnderstandingEnhancementConfig(...args: Tail<Parameters<typeof getUnderstandingEnhancementConfig>>) { return getUnderstandingEnhancementConfig(this,...args) }
  shouldInjectUnderstandingContext(...args: Tail<Parameters<typeof shouldInjectUnderstandingContext>>) { return shouldInjectUnderstandingContext(this,...args) }
  extractForwardContextFromUserContent(...args: Tail<Parameters<typeof extractForwardContextFromUserContent>>) { return extractForwardContextFromUserContent(this,...args) }
  gatherUnderstandingMaterials(...args: Tail<Parameters<typeof gatherUnderstandingMaterials>>) { return gatherUnderstandingMaterials(this,...args) }
  resolveUnderstandingPrompt(...args: Tail<Parameters<typeof resolveUnderstandingPrompt>>) { return resolveUnderstandingPrompt(this,...args) }
  buildUnderstandingContextPrompt(...args: Tail<Parameters<typeof buildUnderstandingContextPrompt>>) { return buildUnderstandingContextPrompt(this,...args) }
  buildImageGenerationPrompt(...args: Tail<Parameters<typeof buildImageGenerationPrompt>>) { return buildImageGenerationPrompt(this,...args) }
  getImageGenerationReferenceImages(...args: Tail<Parameters<typeof getImageGenerationReferenceImages>>) { return getImageGenerationReferenceImages(this,...args) }
  buildImageEditPrompt(...args: Tail<Parameters<typeof buildImageEditPrompt>>) { return buildImageEditPrompt(this,...args) }

	  buildForcedToolCall(toolName: string, params: unknown = {}) {
	    return {
	      id: `call_${randomUUID().replace(/-/g, "")}`,
	      type: "function",
      function: {
        name: toolName,
        arguments: JSON.stringify(params)
      }
    }
  }

  shouldUseSemanticToolIntent(...args: Tail<Parameters<typeof shouldUseSemanticToolIntent>>) { return shouldUseSemanticToolIntent(this,...args) }
  normalizeToolDecision(...args: Tail<Parameters<typeof normalizeToolDecision>>) { return normalizeToolDecision(this,...args) }
  resolveChatCompletionUrl(url = "", apiConfig: {autoResolve?:boolean}|null = null) {
    // 按渠道 autoResolve: false → 直接使用配置的 URL 原文
    const cfg = apiConfig || {}
    if (cfg.autoResolve === false) return String(url || "").trim()
    return normalizeChatCompletionUrl(url)
  }
  extractJsonObject(...args: Tail<Parameters<typeof extractJsonObject>>) { return extractJsonObject(this,...args) }
  async classifySemanticToolIntent(...args: Tail<Parameters<typeof classifySemanticToolIntent>>) { return await classifySemanticToolIntent(this,...args) }
  buildToolCallFromDecision(...args: Tail<Parameters<typeof buildToolCallFromDecision>>) { return buildToolCallFromDecision(this,...args) }
  buildMissingToolCommitmentCall(...args: Tail<Parameters<typeof buildMissingToolCommitmentCall>>) { return buildMissingToolCommitmentCall(this,...args) }

  normalizeAssistantToolMessage(...args: Tail<Parameters<typeof normalizeAssistantToolMessage>>) { return normalizeAssistantToolMessage(this,...args) }
  serializeToolResult(...args: Tail<Parameters<typeof serializeToolResult>>) { return serializeToolResult(this,...args) }
  getToolCallName(...args: Tail<Parameters<typeof getToolCallName>>) { return getToolCallName(this,...args) }
  shouldRunTerminalToolsInBackground(...args: Tail<Parameters<typeof shouldRunTerminalToolsInBackground>>) { return shouldRunTerminalToolsInBackground(this,...args) }
  buildGroundedImageAnalysisPrompt(...args: Tail<Parameters<typeof buildGroundedImageAnalysisPrompt>>) { return buildGroundedImageAnalysisPrompt(this,...args) }
  extractToolResultText(...args: Tail<Parameters<typeof extractToolResultText>>) { return extractToolResultText(this,...args) }
  buildImageVerificationSearchToolCall(...args: Tail<Parameters<typeof buildImageVerificationSearchToolCall>>) { return buildImageVerificationSearchToolCall(this,...args) }
  async startBackgroundTerminalToolCalls(...args: Tail<Parameters<typeof startBackgroundTerminalToolCalls>>) { return await startBackgroundTerminalToolCalls(this,...args) }
  async runToolCall(...args: Tail<Parameters<typeof runToolCall>>) { return await runToolCall(this,...args) }
  dedupeToolCalls(...args: Tail<Parameters<typeof dedupeToolCalls>>) { return dedupeToolCalls(this,...args) }
  async processToolCalls(...args: Tail<Parameters<typeof processToolCalls>>) { return await processToolCalls(this,...args) }
  async executeTool(...args: Tail<Parameters<typeof executeTool>>) { return await executeTool(this,...args) }

  async handleTextResponse(content:string,event:import('../../../contracts/toolExecution.js').ExecutionEvent,session:import('../../../contracts/toolExecution.js').ExecutionSession | Parameters<typeof handleTextResponse>[3],messages:import('../../../contracts/toolExecution.js').ExecutionMessage[],toolName?:string) {
    const normalizedMessages=normalizeFailureMessages(messages)
    const normalizedSession=Object.assign(session,{groupUserMessages:normalizeFailureMessages(session.groupUserMessages)})
    return await handleTextResponse(this,content,normalizeFailureEvent(event),normalizedSession,normalizedMessages,toolName)
  }

  /**
   * 异步更新情感系统、长期记忆
   */
  async updateEnhancedSystems(...args: Tail<Parameters<typeof updateEnhancedSystems>>) { return await updateEnhancedSystems(this,...args) }

  async sendObservedReply(event:unknown,payload:unknown,quote=false,channel="agent"):Promise<unknown> {return await sendObservedReply(this,decodeReplyEvent(event),payload,quote,channel)}
  async sendSegmentedMessage(event:unknown,text:string,chance?:number,options?:{alreadyGuarded?:boolean}) { return await sendSegmentedMessage(this,decodeReplyEvent(event),text,chance,options) }
  splitMessage(...args: Tail<Parameters<typeof splitMessage>>) { return splitMessage(this,...args) }
  splitLongMessageByPunctuation(...args: Tail<Parameters<typeof splitLongMessageByPunctuation>>) { return splitLongMessageByPunctuation(this,...args) }
  async convertAtInString(...args: Tail<Parameters<typeof convertAtInString>>) { return await convertAtInString(this,...args) }
  findMember(...args: Tail<Parameters<typeof findMember>>) { return findMember(this,...args) }
  processToolSpecificMessage(...args: Tail<Parameters<typeof processToolSpecificMessage>>) { return processToolSpecificMessage(this,...args) }

  initMCP(...args: Tail<Parameters<typeof toolAssembly.initMCP>>) { return toolAssembly.initMCP(this,...args) }

  /**
   * 更新工具列表（合并本地工具和MCP工具）
   */
  updateToolsList(...args: Tail<Parameters<typeof toolAssembly.updateToolsList>>) { return toolAssembly.updateToolsList(this,...args) }

  waitForMCPReady(...args: Tail<Parameters<typeof toolAssembly.waitForMCPReady>>) { return toolAssembly.waitForMCPReady(this,...args) }

  /**
   * 清除当前群的所有记忆（群记忆 + 用户记忆）
   */

  /**
   * 重载MCP配置（管理员命令）
   */

  // authority → 中文来源（新模型权威分级 config>self>teaching>mention）

  // 对齐新 fact 模型（entityModel.makeFact）：factShortId(text) 作 id、tags[0] 作分类、
  // text、confidence、authority 中文来源；eventAt 存在附"(待回扣)"。
  memoryAuthoritySource(authority='') {return ({config:'配置',self:'本人',teaching:'教学',mention:'提及'} as Record<string,string>)[authority] || authority || '未知'}
  formatMemoryFactLines(...args: Tail<Parameters<typeof formatMemoryFactLines>>) { return formatMemoryFactLines(this,...args) }

  formatMemoryFacts(...args: Tail<Parameters<typeof formatMemoryFacts>>) { return formatMemoryFacts(this,...args) }

  async replyMemoryForward(...args: Tail<Parameters<typeof replyMemoryForward>>) { return await replyMemoryForward(this,...args) }

  async replyLongForward(...args: Tail<Parameters<typeof replyLongForward>>):Promise<unknown> { return await replyLongForward(this,...args) }

  // P1-4：进程内调用计数/耗时统计（主人或群管理员可见）。重启归零。

  async reloadMCP(e: import('../../conversation/application/replyRendering.js').ReplyEvent & {isMaster?:boolean}) {
    if (!e.isMaster) {
      await this.sendObservedReply(e, "只有主人才能执行此操作")
      return true
    }

    await this.sendObservedReply(e, "正在重载MCP配置...")

    try {
      await mcpManager.disconnectAll()
      mcpInitPromise = this.initMCP()
      await mcpInitPromise

      const toolCount = mcpManager.aliases?.size || mcpManager.tools?.size || 0
      await this.sendObservedReply(e, `MCP重载完成，当前加载 ${toolCount} 个MCP工具`)
    } catch (error) {
      logger.error("[MCP] 重载失败:", error)
      await this.sendObservedReply(e, `MCP重载失败: ${error instanceof Error?error.message:String(error)}`)
    }

    return true
  }

  /**
   * 列出所有MCP工具
   */
  async listMCPTools(e: unknown) {
    const text = mcpManager.getToolsListText()
    await this.replyLongForward(e, "MCP工具列表", text)
    return true
  }

  // 主人调试命令:回显最近回合的提示词分层报告、路由命中轨迹与输出守卫统计。
  // 可选参数:群号(#希洛调试 123456 只看该群;不带则看全部群的最近回合)。
  async handleDebugDiagnostics(e: import('../../conversation/application/replyRendering.js').ReplyEvent & {isMaster?:boolean}) {
    if (!e.isMaster) {
      await this.sendObservedReply(e, "只有主人才能查看调试信息")
      return true
    }
    const arg = String(e.msg || "").replace(/^#希洛调试\s*/, "").trim()
    const groupId = /^\d{5,12}$/.test(arg) ? arg : ""
    const limitMatch = arg.match(/(\d+)/)
    const limit = Math.min(10, Math.max(1, Number(limitMatch?.[1]) || 3))
    const text = formatTurnDiagnosticsText({ groupId, limit })
    if (text.length > 600) {
      await this.replyLongForward(e, "希洛调试", text)
    } else {
      await this.sendObservedReply(e, text)
    }
    return true
  }

  async mcpStatus(...args: Tail<Parameters<typeof mcpStatus>>) { return await mcpStatus(this,...args) }

  async testMCPTool(...args: Tail<Parameters<typeof testMCPTool>>) { return await testMCPTool(this,...args) }

  isChatManager(...args: Tail<Parameters<typeof isChatManager>>) { return isChatManager(this,...args) }

  forbiddenWordList(...args: Tail<Parameters<typeof forbiddenWordList>>) { return forbiddenWordList(this,...args) }

  async handleForbiddenList(...args: Tail<Parameters<typeof handleForbiddenList>>) { return await handleForbiddenList(this,...args) }

  async handleForbiddenAdd(...args: Tail<Parameters<typeof handleForbiddenAdd>>) { return await handleForbiddenAdd(this,...args) }

  async handleForbiddenRemove(...args: Tail<Parameters<typeof handleForbiddenRemove>>) { return await handleForbiddenRemove(this,...args) }

  // "#切换人设 名字 123456" 里可带目标群号(仅主人,跨群切换);群内使用默认切本群
  resolvePersonaTargetGroup(...args: Tail<Parameters<typeof resolvePersonaTargetGroup>>) { return resolvePersonaTargetGroup(this,...args) }

  formatPersonaDetail(...args: Tail<Parameters<typeof formatPersonaDetail>>) { return formatPersonaDetail(this,...args) }

  async handlePersonaList(...args: Tail<Parameters<typeof handlePersonaList>>) { return await handlePersonaList(this,...args) }

  async handlePersonaCurrent(...args: Tail<Parameters<typeof handlePersonaCurrent>>) { return await handlePersonaCurrent(this,...args) }

  async handlePersonaDetail(...args: Tail<Parameters<typeof handlePersonaDetail>>) { return await handlePersonaDetail(this,...args) }

  async handlePersonaSwitch(...args: Tail<Parameters<typeof handlePersonaSwitch>>) { return await handlePersonaSwitch(this,...args) }

  async handlePersonaReset(...args: Tail<Parameters<typeof handlePersonaReset>>) { return await handlePersonaReset(this,...args) }

  // 把当前会话生效的人设快照存成人设库新条目(主人);重名覆盖
  async handlePersonaSave(...args: Tail<Parameters<typeof handlePersonaSave>>) { return await handlePersonaSave(this,...args) }

  async handlePersonaDelete(...args: Tail<Parameters<typeof handlePersonaDelete>>) { return await handlePersonaDelete(this,...args) }

  async handlePersonaReload(...args: Tail<Parameters<typeof handlePersonaReload>>) { return await handlePersonaReload(this,...args) }

  async handlePersonaBindings(...args: Tail<Parameters<typeof handlePersonaBindings>>) { return await handlePersonaBindings(this,...args) }
}

const toolAssembly=createToolAssembly({logger:{info:message=>logger?.info?.(message),warn:message=>logger?.warn?.(message),error:(message,error)=>logger?.error?.(message,error)},refreshLocalTools:options=>refreshLocalTools(getState() ?? undefined,options),applyToolRegistrySnapshot:()=>applyToolRegistrySnapshot(getState() ?? undefined),mcpManager,getMcpInitPromise:()=>mcpInitPromise,parseToolConfigEntry,YTapi})

return {ExamplePlugin}
}
