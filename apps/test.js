import {createToolAssembly} from "../dist/backend/modules/tools/infrastructure/toolAssembly.js"
import {applyToolRegistrySnapshot as applyTypedToolRegistrySnapshot,refreshLocalToolSnapshot} from "../dist/backend/modules/tools/infrastructure/LocalToolRegistry.js"
import {createConversationEntryPolicy} from '../dist/backend/modules/conversation/infrastructure/conversationEntryPolicy.js'
import {handleTextResponse,updateEnhancedSystems,getFriendlyFailureMessage,sendFinalReplyAsTextImage} from './lib/finalReply.js'
import {formatMemoryFactLines,formatMemoryFacts,replyMemoryForward,replyLongForward} from './lib/memoryReplies.js'
import {createConversationHistory} from '../dist/backend/modules/conversation/infrastructure/conversationHistory.js'
const conversationHistory=createConversationHistory({loadData,saveData,deleteKey:key=>globalThis.redis.del(key),debug:message=>globalThis.logger?.debug?.(message),error:(message,error)=>globalThis.logger?.error?.(message,error)})
import {createMutedGroupPolicy} from '../dist/backend/modules/conversation/infrastructure/mutedGroupPolicy.js'
import {createConversationPrefilter} from '../dist/backend/modules/conversation/infrastructure/conversationPrefilter.js'
import {createConversationScheduling} from '../dist/backend/modules/conversation/infrastructure/conversationScheduling.js'
import { EmotionManager } from "../domains/memory/EmotionManager.js"
import { lastIncomingMsgAt, activeDedupeToolRuns, LOCAL_EMOJI_TOOL_NAME, smartConversationKey } from "./lib/splitState.js"
import {
  hasExplicitRememberSignal,
  cleanTeachingAlias,
  cleanTeachingTarget,
  findGroupMemberByName,
  buildTeachingFact,
  extractMentionTeachingFacts,
  extractTextTeachingFacts,
  extractExplicitTeachingFacts,
  formatExplicitTeachingMemoryContent,
  formatExplicitTeachingPrompt,
  normalizeIdentityBindings,
  formatIdentityBindingsPrompt
} from "./lib/teachingFacts.js"
import {
  parseForwardJsonPayload,
  getSegmentData,
  normalizeMessageSegments,
  normalizeForwardMessageList,
  extractForwardIdFromSegment,
  extractForwardIdsFromSegments,
  extractReadableTextFromSegments,
  getForwardSenderName,
  normalizeForContainment,
  getReplyTargetUserId
} from "./lib/messageSegments.js"
import {
  extractAvatarLookupTerms,
  resolveAvatarInspectionTargets,
  findUniqueGroupMemberMention,
  resolveAvatarDrawReference,
  formatAvatarDrawReferencePrompt
} from "./lib/avatarReference.js"
import {
  cardAcknowledgement,
  looksLikeEducationalExplanation,
  looksLikeDiagnosticExplanation,
  compactDrawPromptText
, looksLikeCodeOrMarkdown, looksLikeTreeStructure, treeToMarkdown } from "./lib/textPolicy.js"
import { MemoryManager } from "../domains/memory/MemoryManager.js"
import { ExpressionLearner } from "../domains/memory/ExpressionLearner.js"
import KnowledgeSearcher from "../domains/knowledge/KnowledgeSearcher.js"
import KnowledgeExpander from "../domains/knowledge/KnowledgeExpander.js"
import { checkPendingReminders } from "../functions/functions_tools/ReminderTool.js"
import { hasLatexMath } from "../functions/functions_tools/TextImageTool.js"
import { TakeImages } from "../utils/fileUtils.js"
import { loadData, saveData } from "../utils/redisClient.js"
import { YTapi } from "../utils/apiClient.js"
import { MessageManager } from "../utils/MessageManager.js"
import { messageArchiveManager } from "../utils/MessageArchiveManager.js"
import { getSemanticMemoryRuntime, installSemanticMemoryRuntime } from "../domains/semanticMemory/runtime.js"
import { ThinkingProcessor } from "../utils/providers/ThinkingProcessor.js"
import { TotalTokens } from "../functions/tools/CalculateToken.js"
import { mcpManager } from "../utils/MCPClient.js"
import { localToolRegistry } from "../utils/LocalToolRegistry.js"
import { getRedBagType, isExclusiveForUser } from "../utils/redBagUtils.js"
import { pluginBridge } from "../utils/pluginBridge.js"
import { personProfileInjector } from "../domains/memory/PersonProfileInjector.js"
import { memStats } from "../domains/memory/engine/stats.js"
import { factShortId } from "../domains/memory/engine/entityModel.js"
import { stripChatLogSpeakerPrefix, stripChatLogSpeakerPrefixes, polishHumanReplyText, sanitizeFinalReplyText, stripCqMarkup } from "../utils/replySanitizer.js"
import { createTurnSessionStore } from "../utils/turnSession.js"
import { buildChatRequestData, fetchWithTimeout } from "../utils/modelGateway.js"
import { resolveToolRoute } from "../utils/routeDecision.js"
import { resolveNaturalDeltaForceToolCall } from "../utils/deltaForceIntent.js"
import { recordTurnDiagnostics, formatTurnDiagnosticsText } from "../utils/turnDiagnostics.js"
import { requestUnderstandingBrief, composeModelBriefCard } from "../utils/understandingBrief.js"
import {
  ROLE_MAP as roleMap,
  summarizeForLog,
  hasBotTextAnchor,
  getReplySender,
  messageQuotesUser,
  getPreviousRecentMessage,
  looksAddressedToPreviousSpeaker,
  uniqText,
  getMemberNames,
  formatMemberDisplayName,
  extractMemberLookupTerms,
  matchGroupMembersByTerms,
  formatMemberLookupPrompt,
  removeBotAnchors,
  buildQqAvatarUrl,
  joinIntentParts
} from "../utils/messageContext.js"
import { personaFeedbackManager } from "../domains/memory/PersonaFeedbackManager.js"
import { globalStyleLearnerManager } from "../domains/memory/GlobalStyleLearnerManager.js"
import { diceManager } from "../domains/dice/DiceManager.js"
import { analyzeReplyText } from "../utils/SmartReply.js"
import { buildMissingImageAnalysisReply, looksLikeImageAuthenticityRequest, looksLikeImageVerificationRequest, looksLikeVisualInspectionRequest, shouldAskForMissingImageForVisualRequest } from "../utils/imageRequestGuard.js"
import { resolveChatCompletionUrl as normalizeChatCompletionUrl } from "../utils/chatCompletionUrl.js"
import { compileImagePrompt, resolveImageContextMode, selectLatestDrawContextLines, selectMergedImagePromptTexts } from "../utils/promptCompiler.js"
import { buildToolIntentDisclosure, resolveDeterministicToolIntent, resolveToolRequestMergeMs, selectToolIntentCandidates, extractEmbeddedToolCalls } from "../utils/toolIntentManifests.js"
import { extractValidBtihMagnetUri } from "../utils/torrentDownload.js"
import { buildToolSkillCatalog, normalizeToolSkillParams } from "../utils/toolSkills.js"
import { formatGroupWorkflowTeachingPrompt } from "../domains/memory/engine/groupWorkflow.js"
import { formatGroupKnowledgeTeachingPrompt } from "../domains/memory/engine/groupKnowledge.js"
import { buildMentionMembersFailureReply } from "../utils/mentionFailureReply.js"
import { collectMentionTargetIds, getMentionTargetId, messageMentionsUser, replaceCqMentions } from "../utils/mentionTargets.js"
import { isExplicitAdminCollectionMentionRequest, resolveSingularOwnerMention } from "../utils/mentionRoleRouting.js"
import { resolveRecentBotImage, resolveRecentUserImage, findRecentBotImage } from "../utils/recentImageContinuation.js"
import { recordDrawTextFallback, clearDrawFailureNote, takeDrawFailureNote, buildDrawFailureNoteMessage, isImageDeliveryToolName } from "../utils/drawFailureNote.js"
import { shouldSkipNicknameAvatarReference } from "../utils/avatarReferencePolicy.js"
import { installObservabilityLog } from "../utils/obsLog.js"
import { createConfigStore, mergeDeepConfig } from "../core/config/configStore.js"
import { classifyIntentWithModel } from "../core/intent/modelIntentClassifier.js"
import { isAiConversationEnabled } from "../utils/aiConversationGate.js"
import { shouldSkipIntentModel } from "../utils/intentFastPath.js"
import { computeAddresseeSignal, buildAddresseePrompt } from "../utils/addresseeSignals.js"
import { recordTurnContinuity, loadTurnContinuity, buildTurnContinuityPrompt } from "../utils/turnContinuity.js"
import { updateGroupTopic, updateGroupSocial, getGroupTopicPrompt, getGroupSocialPrompt, detectAttentionHook} from "../utils/groupContextState.js"
import { recordEpisode, recallEpisodes, recallUserEpisodes, buildEpisodicPrompt, buildUserCallbackPrompt, hasTemporalDeixis } from "../utils/episodicMemory.js"
import { createTurnTrace, resolveTurnTraceArchiveDir } from "../utils/turnTrace.js"
import { createOutboundArbiter } from "../utils/messagePipeline/outboundArbiter.js"
import { createChatTurnDurability, rebuildChatTurnEvent } from "../utils/chatTurnDurability.js"
import { resolveLongTaskFeedbackPolicy } from "../utils/longTaskFeedbackPolicy.js"
import { resolvePromptLayerProfile } from "../utils/promptLayers.js"
import { buildPersonaStyleOverride, renderPersonaTemplate, resolvePersonaName } from "../utils/personaSource.js"
import { createPersonaLibrary } from "../utils/personaLibrary.js"
import { findForbiddenWord, anchorEventConversation, markConversationInterrupted, chatScopeKey } from "../utils/forbiddenWordGuard.js"
import { applyFlatUpdates } from "../utils/configWriter.js"
import { installMidtermMemoryRuntime, getMidtermMemoryManager } from "../domains/midtermMemory/MidtermSummaryManager.js"
import { rollPersonaMood } from "../utils/personaMoods.js"
import { noteInjectedChunks, detectAndPenalize } from "../utils/memorySelfCorrection.js"
import { getSmartRuntimeState, smartRuntimeGroupIds, smartRuntimeSize, hasSmartRuntimeState, registerGroupRuntimeProviders, registerRuntimeSweep, runRuntimeSweeps } from "../core/runtime/groupRuntime.js"
import {
  mcpStatus,
  testMCPTool,
  isChatManager,
  forbiddenWordList,
  handleForbiddenList,
  handleForbiddenAdd,
  handleForbiddenRemove,
  resolvePersonaTargetGroup,
  formatPersonaDetail,
  handlePersonaList,
  handlePersonaCurrent,
  handlePersonaDetail,
  handlePersonaSwitch,
  handlePersonaReset,
  handlePersonaSave,
  handlePersonaDelete,
  handlePersonaReload,
  handlePersonaBindings
} from "./lib/adminCommands.js"
import {
  resolveConversationPhase,
  applyRateLimitGuard,
  resolveTalkValue,
  idleCompensationMet,
  computeAvgReplyLatency,
  recordReplyLatency,
  computeGroupMsgRate5min,
  getDirectTriggerMergeMs,
  getDirectTriggerMergeMaxMessages
} from "./lib/smartDynamics.js"
import { runTimingGate as runTimingGateFn } from "./lib/timingGate.js"
import { handleRandomReplySmart as handleRandomReplySmartFn } from "./lib/smartConversation.js"
import {
  setTrackingWithTimer,
  joinRepeat,
  detectGroupRepeat,
  isUserTalkingToBot,
  addToBatchJudgment,
  processBatchJudgments,
  batchIsUserTalkingToBot,
  fallbackToSingleJudgment,
  handleRandomReply
} from "./lib/strictConversation.js"
import {
  getTaskStatusCacheKey,
  getTaskStatusRedisKey,
  getActiveToolTaskCacheKey,
  getActiveToolTaskRedisKey,
  getTaskStatusTtlSeconds,
  saveTaskStatus,
  getTaskStatus,
  clearTaskStatus,
  updateUserToolTaskStatus,
  getUserToolTaskStatus,
  clearUserToolTaskStatus,
  getRuntimeToolTaskStatus,
  getCurrentUserToolTaskStatus,
  buildDrawTaskStatusReply,
  buildReplySegment,
  buildTaskStatusReplyMessage,
  handleActiveDrawStatusQuestion,
  formatTaskStatusForPrompt
} from "./lib/taskStatus.js"
import { formatTime, buildMessageContent, formatMessages } from "./lib/messageFormatting.js"
import { handleToolInner as handleToolInnerFn } from "./lib/chatTurn.js"
import { evaluatePrivateChatGate } from "./lib/privateChat.js"
import { delay, getOrCreateGroupLimiter, filterToolsForMessageIntent, toolConfigHasName, parseToolConfigEntry } from "./lib/conversationUtils.js"
import { buildMainSystemPrompt } from "../utils/systemPromptTemplate.js"
import { composeTurnPromptLayers } from "../utils/turnPromptComposer.js"
import { applyOutputPersonaGuards } from "../utils/outputGuardPipeline.js"
import { isCodeOrMarkdownRequest, isEducationalExplanationRequest, resolveCardPresentation } from "../utils/turnPresentation.js"
import { setSharedRuntime } from "../core/runtime/sharedRuntime.js"
import { TERMINAL_TOOL_NAMES, BACKGROUND_TERMINAL_TOOL_NAMES, PSEUDO_TOOL_MARKER_SET, PSEUDO_TOOL_TEXT_KEYS, PREVIOUS_SPEAKER_REPLY_PATTERNS, COMIC_DRAW_PATTERN, SEARCH_TOOL_NAMES, SEMANTIC_TOOL_INTENTS, SEMANTIC_TOOL_INTENT_MIN_CONFIDENCE, SEMANTIC_TOOL_INTENT_TIMEOUT_MS, isPseudoToolMarker, extractChatKeywords, isQuestionMessage, isFeedbackMessage, isLikelyFollowupMessage, isCasualBotGreeting, shouldUseCompactHistory, looksDirectedAtBotByPronoun, looksGroupAddressed, normalizeIntentText, isRealtimeInfoRequest, isExplicitSearchRequest, isExplicitToolIntent, isImageGenerationRequest, isImageAnalysisRequest, isAvatarInspectionRequest, getImageVerificationMode, isImageEditRequest, isImageCompositionEditRequest, hasToolCommitmentText, isDrawTaskStatusInquiry, isDrawContextContinuationRequest, shouldInjectGroupContext } from "../core/intent/messageIntent.js"
import { prepareImageEditAssets, resolveAvatarEditBase } from "../utils/editReferencePipeline.js"
import { hasExplicitImageEditAction, hasExplicitImageGenerationRequest, shouldRenderImageAnalysisAsDocument, shouldRequireImageEditBase, shouldTreatAsAvatarInspection } from "../utils/imageTaskPolicy.js"
import { buildImageFailureReply, classifyImageFailure } from "../utils/imageFailurePolicy.js"
import { formatGroupContextImagePrompt, resolveGroupContextAssets } from "../utils/groupContextResolver.js"
import { buildGenericChatFailureReply, buildVisibleChatFailureDetail } from "../utils/chatFailureReply.js"
import { appendVisibleFailureDetail, buildVisibleFailureDetail } from "../utils/visibleFailure.js"
import { hasSemanticPlannerCandidate, shouldRunSemanticToolPlanner } from "../utils/semanticToolPolicy.js"
import { buildCommittedActionReply, recordActionOutcomes } from "../utils/actionOutcomes.js"
import { markProactiveReply, shouldCancelProactiveReply } from "../utils/proactiveReplyFreshness.js"
import { extractDeliveryMessageId, logDeliveryOutcome } from "../utils/deliveryObservability.js"
import { classifyChatRequestFailure, executeChatRequestWithRecovery } from "../utils/chatRequestRecovery.js"
import { safeTruncateUnicode, splitUnicodeText } from "../utils/unicodeText.js"
import { classifyEmojiToolExposure, filterToolsForEmojiExposure, shouldExposeEmojiToolForMessage, recordEmojiOnlySend, adaptForcedReplyTextRate, looksLikeDirectPersonalQuestion, resolveEmojiTurnSkips } from "../utils/emojiToolPolicy.js"
import { buildExcelToolParams, hasExcelWorkbookContext, shouldBypassMergeForExcel, shouldUseExcelWorkbookTool } from "../utils/excelRequestPolicy.js"
import { hasRecentPixivSearch } from "../utils/pixivSearch.js"
import { containsCodeFence, flattenCodeFences } from "../utils/qqCodeFenceText.js"
import { armSmartLockWatchdog, clearSmartLockWatchdog } from "../utils/smartLockPolicy.js"
import { decideToolContinuation } from "../utils/toolContinuationPolicy.js"
import { buildToolGroundingInstruction, buildUnavailableToolReply, hasUsableToolResult } from "../utils/toolResultGrounding.js"
import { buildStructuredHistoryMessage, resolveHistorySelectionBudget, resolveToolRoundLimit, selectRelevantGroupHistory } from "../utils/agentIntelligence.js"
import { buildAgentProgressContext, buildToolFailureReplyInstruction, selectAgentReplyContext } from "../utils/agentReplyComposer.js"
import { containsInternalStatusLeak, redactInternalStatusLeaks } from "../utils/internalStatusLeak.js"
import { buildPersonaTonePrompt } from "../utils/personaTonePolicy.js"
import { createTurnPlan, deriveTurnPlanRequest, formatTurnPlanLog, recordTurnPlanToolOutcome } from "../utils/turnPlan.js"
import { splitNarrativeReply } from "../utils/narrativeReply.js"
import {
  buildModrinthBilingualReplyInstruction,
  buildModrinthCardItemsFromData,
  buildModrinthTranslationMessages,
  buildModrinthForwardItemsFromData,
  cacheModrinthTranslations,
  collectModrinthTranslations,
  extractModrinthForwardItems,
  parseModrinthRankingData,
  parseModrinthTranslationResponse,
  shouldKeepModrinthReplyAsText,
  stripModrinthForwardMarkers,
  wrapModrinthForwardItems
} from "../utils/modrinth.js"
import { prewarmModrinthCardRenderer, renderModrinthCard } from "../utils/ModrinthCardRenderer.js"
import { planTextReplyMessages } from "../utils/replyRhythm.js"
import fs from "fs"
import YAML from "yaml"
import path from "path"
import {
  shouldUseSemanticToolIntent,
  normalizeToolDecision,
  classifySemanticToolIntent,
  buildToolCallFromDecision,
  buildMissingToolCommitmentCall,
  extractJsonObject
} from "./lib/semanticToolIntent.js"
import {
  getQuotedPromptContextText,
  getRecentPromptContextText,
  getRecentDrawContextText,
  resolveContextualDrawGeneration,
  getUnderstandingEnhancementConfig,
  shouldInjectUnderstandingContext,
  extractForwardContextFromUserContent,
  gatherUnderstandingMaterials,
  resolveUnderstandingPrompt,
  buildUnderstandingContextPrompt,
  buildImageGenerationPrompt,
  getImageGenerationReferenceImages,
  buildImageEditPrompt,
} from "./lib/promptContext.js"
import {
  sendObservedReply,
  sendSegmentedMessage,
  splitMessage,
  splitLongMessageByPunctuation,
  convertAtInString,
  findMember,
  processToolSpecificMessage,
} from "./lib/replyRendering.js"
import {
  normalizeAssistantToolMessage,
  serializeToolResult,
  getToolCallName,
  shouldRunTerminalToolsInBackground,
  buildGroundedImageAnalysisPrompt,
  extractToolResultText,
  buildImageVerificationSearchToolCall,
  startBackgroundTerminalToolCalls,
  runToolCall,
  dedupeToolCalls,
  processToolCalls,
  executeTool,
} from "./lib/toolExecution.js"
import common from "../../../lib/common/common.js"
import chokidar from "chokidar"
import { randomUUID } from "crypto"
import pLimit from "p-limit"
import schedule from 'node-schedule'

const _path = process.cwd()

// 自动抢红包配置


// 清空群记忆二次确认（P0-1）：进程内 pending，key: `${groupId}_${userId}`, value: 过期时间戳。



// smart 模式：每群独立的频率状态，进程内 Map，重启清零
// 群连续被新消息打断的累计计数（达到上限后下一轮强制走完不再让步）
const conversationEntryPolicy=createConversationEntryPolicy({logger:globalThis.logger,bot:()=>globalThis.Bot || {},anchorEventConversation,findForbiddenWord,chatScopeKey,markConversationInterrupted,getSemanticMemoryRuntime,resolveNaturalDeltaForceToolCall,shouldUseExcelWorkbookTool,extractValidBtihMagnetUri})
const conversationPrefilter=createConversationPrefilter({bot:()=>globalThis.Bot || {},resolvePersonaName,logger:globalThis.logger})
const conversationScheduling=createConversationScheduling({logger:globalThis.logger,resolveToolRequestMergeMs,shouldBypassMergeForExcel,isDrawTaskStatusInquiry})
const {consecutiveInterrupts} = conversationScheduling
// smart 锁持有令牌：看门狗强制释放后旧轮次的 finally 不得误释放新轮次的锁
// redis 抖动/断连时命令可能既不成功也不失败（挂起）。任务状态只是去重辅助，
// 超时降级为"无状态"，绝不能卡住会话收尾（进而卡死 smart 锁）。

// 禁言状态短期缓存：避免每条群消息都查一次 ws RPC pickMember.getInfo()
const mutedGroupPolicy=createMutedGroupPolicy(()=>globalThis.Bot || {})
const {mutedStatusCache}=mutedGroupPolicy
const MUTED_CACHE_TTL_MS = 30000
const groupContextCache = new Map()
const GROUP_CONTEXT_CACHE_TTL_MS = 5 * 60 * 1000
const FORWARD_CONTEXT_MAX_DEPTH = 4
const FORWARD_CONTEXT_MAX_LINES = 120
const FORWARD_CONTEXT_MAX_TEXT = 9000
let activeChatLruTimer = null // 全局 24h LRU 扫描定时器，进程内单例
let durableToolRecoveryStarted = false
let chatTurnRecoveryStarted = false


let sharedConfigStore = null
let pluginInitialized = false
let sharedState = null
let mcpInitPromise = null











function applyToolRegistrySnapshot(state,snapshot=localToolRegistry.getSnapshot()){return applyTypedToolRegistrySnapshot(state,snapshot)}

function refreshLocalTools(state,options={}){return refreshLocalToolSnapshot(state,localToolRegistry,options)}

function buildMemoryConfig(config) {
  const memorySystem = config.memorySystem || {}
  return {
    ...memorySystem,
    memoryAiConfig: config.memoryAiConfig || null,
    embeddingAiConfig: config.embeddingAiConfig || null
  }
}

function getMessageCacheOptions(config = {}) {
  return {
    cacheExpireMinutes: config.groupChatMemoryMinutes,
    // 兼容未迁移的旧配置；分钟配置存在时由 MessageManager 优先采用。
    cacheExpireDays: config.groupChatMemoryDays
  }
}

function initializeSharedState(config) {
  if (sharedState) {
    // 热更新：直接覆盖各 Manager 的 config，无需 Manager 侧改动
    sharedState.messageManager.GROUP_MAX_MESSAGES = config.groupMaxMessages || 100
    sharedState.messageManager.setCacheExpire(getMessageCacheOptions(config))
    Object.assign(sharedState.emotionManager.config, {
      decayRate: config.emotionSystem?.decayRate || 0.02,
      eventWeights: {
        ...sharedState.emotionManager.config.eventWeights,
        ...config.emotionSystem?.eventWeights
      }
    })
    sharedState.memoryManager.updateConfig(buildMemoryConfig(config))
    Object.assign(sharedState.expressionLearner.config, {
      ...config.expressionLearning || {},
      memoryAiConfig: config.memoryAiConfig || null
    })
    // 知识库热更新
    if (config.knowledgeSystem?.enabled && !sharedState.knowledgeSearcher) {
      sharedState.knowledgeSearcher = new KnowledgeSearcher({
        apiKey: config.embeddingAiConfig?.embeddingApiKey,
        apiUrl: config.embeddingAiConfig?.embeddingApiUrl,
        dbPath: path.join(_path, 'plugins/shiloh-plugin/database/knowledge-db.ndjson'),
        model: config.embeddingAiConfig?.embeddingApiModel || 'text-embedding-3-small',
        topN: config.knowledgeSystem?.topN || 4,
        threshold: config.knowledgeSystem?.threshold || 0.6
      })
    } else if (config.knowledgeSystem?.enabled && sharedState.knowledgeSearcher) {
      sharedState.knowledgeSearcher.apiKey = config.embeddingAiConfig?.embeddingApiKey
      sharedState.knowledgeSearcher.apiUrl = config.embeddingAiConfig?.embeddingApiUrl
      sharedState.knowledgeSearcher.model = config.embeddingAiConfig?.embeddingApiModel || 'text-embedding-3-small'
      sharedState.knowledgeSearcher.topN = config.knowledgeSystem?.topN || 4
      sharedState.knowledgeSearcher.threshold = config.knowledgeSystem?.threshold || 0.6
    } else if (!config.knowledgeSystem?.enabled) {
      sharedState.knowledgeSearcher = null
    }
    refreshLocalTools(sharedState, { force: true }).catch(error => {
      logger.error('[LocalToolRegistry] 热更新工具失败:', error)
    })
    installSemanticMemoryRuntime({ pluginSettings: config, archiveManager: messageArchiveManager })
    installMidtermMemoryRuntime({ pluginSettings: config, archiveManager: messageArchiveManager })
    setSharedRuntime({ memoryManager: sharedState.memoryManager, getConfig: () => config })
    return applyToolRegistrySnapshot(sharedState)
  }
  sharedState = {
    messageManager: new MessageManager({
      privateMaxMessages: 100,
      groupMaxMessages: config.groupMaxMessages,
      messageMaxLength: 9999,
      ...getMessageCacheOptions(config)
    }),
    // 情感系统
    emotionManager: new EmotionManager(config.emotionSystem || {}),
    // 长期记忆
    memoryManager: new MemoryManager(buildMemoryConfig(config), { redis: globalThis.redis }),
    // 表达学习
    expressionLearner: new ExpressionLearner({
      ...config.expressionLearning || {},
      memoryAiConfig: config.memoryAiConfig || null
    }),
    // 知识库检索
    knowledgeSearcher: config.knowledgeSystem?.enabled
      ? new KnowledgeSearcher({
          apiKey: config.embeddingAiConfig?.embeddingApiKey,
          apiUrl: config.embeddingAiConfig?.embeddingApiUrl,
          dbPath: path.join(_path, 'plugins/shiloh-plugin/database/knowledge-db.ndjson'),
          model: config.embeddingAiConfig?.embeddingApiModel || 'text-embedding-3-small',
          topN: config.knowledgeSystem?.topN || 4,
          threshold: config.knowledgeSystem?.threshold || 0.6
        })
      : null,
    sessionMap: new Map()
  }
  setSharedRuntime({ memoryManager: sharedState.memoryManager, getConfig: () => config })
  installSemanticMemoryRuntime({ pluginSettings: config, archiveManager: messageArchiveManager })
  installMidtermMemoryRuntime({ pluginSettings: config, archiveManager: messageArchiveManager })

  applyToolRegistrySnapshot(sharedState)
  refreshLocalTools(sharedState, { force: true }).catch(error => {
    logger.error('[LocalToolRegistry] 初始化自定义工具失败:', error)
  })

  pluginBridge.sharedState = sharedState

  // 知识库自动导入：首次启动时如果 ndjson 不存在，从 database_default 导入
  if (config.knowledgeSystem?.enabled && sharedState.knowledgeSearcher) {
    const dbPath = path.join(_path, 'plugins/shiloh-plugin/database/knowledge-db.ndjson')
    const defaultTxt = path.join(_path, 'plugins/shiloh-plugin/database_default/knowledge-base.txt')
    if (!fs.existsSync(dbPath) && fs.existsSync(defaultTxt)) {
      const dbDir = path.dirname(dbPath)
      if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true })
      logger.info('[知识库] 首次启动，正在从默认知识库导入...')
      const expander = new KnowledgeExpander({
        apiKey: config.embeddingAiConfig?.embeddingApiKey,
        apiUrl: config.embeddingAiConfig?.embeddingApiUrl,
        dbPath,
        model: config.embeddingAiConfig?.embeddingApiModel || 'text-embedding-3-small'
      })
      const texts = fs.readFileSync(defaultTxt, 'utf8').split('\n').filter(Boolean)
      const batchSize = 50
      ;(async () => {
        let totalAdded = 0
        let totalSkipped = 0
        const totalBatches = Math.ceil(texts.length / batchSize)
        for (let i = 0; i < texts.length; i += batchSize) {
          const batch = texts.slice(i, i + batchSize)
          const batchNum = Math.floor(i / batchSize) + 1
          try {
            const result = await expander.expand(batch)
            totalAdded += result.added
            totalSkipped += batch.length - result.added
            logger.info(`[知识库] [${batchNum}/${totalBatches}] 新增 ${result.added} 条，跳过重复 ${batch.length - result.added} 条`)
          } catch (err) {
            logger.error(`[知识库] [${batchNum}/${totalBatches}] 导入失败: ${err.message}`)
          }
          if (i + batchSize < texts.length) await new Promise(r => setTimeout(r, 1000))
        }
        logger.info(`[知识库] 自动导入完成，共导入 ${totalAdded} 条，跳过重复 ${totalSkipped} 条`)
      })()
    }
  }

  // 如果启用了 searchMusicTool，初始化音乐 cookie 刷新定时任务
  if (toolConfigHasName(config.oneapi_tools, 'searchMusicTool')) {
    initMusicCookieRefresh(sharedState.toolInstances.searchMusicTool, config)
  }

  return sharedState
}

// 初始化音乐 cookie 定时刷新
function initMusicCookieRefresh(searchMusicTool, config) {
  if (!searchMusicTool) return

  const { qqMusicToken } = config || {}
  if (!qqMusicToken) {
    logger.info('[SearchMusicTool] 未配置 qqMusicToken，跳过 cookie 刷新初始化')
    return
  }

  // 设置 cookie
  searchMusicTool.musicCookies.qqmusic = qqMusicToken

  // 立即执行一次刷新检查
  searchMusicTool.updateQQMusicCk().then(() => {
    logger.info('[SearchMusicTool] 初始化时 cookie 刷新检查完成')
  }).catch(err => {
    logger.error('[SearchMusicTool] 初始化时 cookie 刷新失败:', err)
  })

  // 每10分钟定时刷新
  schedule.scheduleJob('*/10 * * * *', async () => {
    try {
      // 重新从配置读取最新的 token
      const configPath = path.join(process.cwd(), 'plugins/shiloh-plugin/config/message.yaml')
      const currentConfig = YAML.parse(fs.readFileSync(configPath, 'utf8')).pluginSettings
      if (currentConfig?.qqMusicToken) {
        searchMusicTool.musicCookies.qqmusic = currentConfig.qqMusicToken
      }
      // 强制触发刷新检查（重置 updateTime 使其立即检查）
      searchMusicTool.updateTime = 0
      await searchMusicTool.updateQQMusicCk()
    } catch (err) {
      logger.error('[SearchMusicTool] 定时刷新 cookie 失败:', err)
    }
  })

  logger.info('[SearchMusicTool] cookie 定时刷新任务已启动（每10分钟）')
}

export class ExamplePlugin extends plugin {
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
      getBasePersona: () => this.config?.persona || {}
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
    this.sessionStore = createTurnSessionStore({ map: this.sessionMap })
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
  async handleTool(e) {
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
  async claimTurnReply(e) {
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
          await tool.recoverDurableJobs()
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

  refreshLocalToolRegistry(...args) {return toolAssembly.refreshLocalToolRegistry(this,...args)}

  initTools(...args) {return toolAssembly.initTools(this,...args)}

  initMessageHistory() {
    this.messageHistoriesRedisKey = "group_user_message_history"
    this.messageHistoriesDir = path.join(process.cwd(), "data/AItools/user_history")
    this.MAX_HISTORY = this.config.groupMaxMessages || 100

    if (!fs.existsSync(this.messageHistoriesDir)) {
      fs.mkdirSync(this.messageHistoriesDir, { recursive: true })
    }
  }

  async markStaleToolTasksFailed() {
    const ttlMs = Math.max(60_000, Number(this.config?.longRunningToolStaleMinutes || 8) * 60_000)
    const now = Date.now()
    const patterns = [
      `${this.TASK_STATUS_PREFIX}*`,
      `${this.ACTIVE_TOOL_TASK_PREFIX}*`
    ]
    let checked = 0
    let marked = 0

    for (const pattern of patterns) {
      let cursor = "0"
      do {
        const reply = await redis.scan(cursor, { MATCH: pattern, COUNT: 200 })
        cursor = String(reply?.cursor ?? reply?.[0] ?? "0")
        const keys = reply?.keys ?? reply?.[1] ?? []
        for (const key of keys) {
          checked++
          try {
            const raw = await redis.get(key)
            if (!raw) continue
            const record = JSON.parse(raw)
            if (!["processing", "tool_running", "running", "queued"].includes(record?.status)) continue
            const updatedAt = Number(record.updatedAt || record.startedAt || 0)
            if (updatedAt && now - updatedAt < ttlMs) continue

            const next = {
              ...record,
              status: "tool_failed",
              error: "服务重启或进程退出导致任务中断，请重新发起",
              updatedAt: now
            }
            await redis.set(key, JSON.stringify(next), { EX: this.getTaskStatusTtlSeconds() })
            marked++
            if (record?.groupId && record?.messageId) {
              taskStatusCache.set(this.getTaskStatusCacheKey(record.groupId, record.messageId), next)
            }
          } catch (error) {
            logger.warn(`[持久任务] 清理残留状态失败 key=${key}: ${error.message}`)
          }
        }
      } while (cursor !== "0")
    }

    if (marked) logger.warn(`[持久任务] 已将 ${marked}/${checked} 个残留运行中任务标记为失败`)
  }

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

  async callOneBotApi(e, action, params = {}) {
    const bot = e?.bot
      || (typeof Bot !== "undefined" ? Bot : null)
      || (typeof globalThis.bot !== "undefined" ? globalThis.bot : null)
      || (typeof globalThis.Bot !== "undefined" ? globalThis.Bot : null)

    if (!bot?.sendApi) throw new Error("找不到 OneBot API 调用接口")
    return await bot.sendApi(action, params)
  }

  normalizeGroupContextText(value, maxLength = 800) {
    return safeTruncateUnicode(String(value || "")
      .replace(/\r\n/g, "\n")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim(), maxLength)
  }

  pickNoticeText(value) {
    if (!value) return ""
    if (typeof value === "string") return value
    if (Array.isArray(value)) return value.map(item => this.pickNoticeText(item)).filter(Boolean).join("")
    if (typeof value !== "object") return ""

    for (const key of ["content", "text", "msg", "message", "notice", "title", "data"]) {
      const text = this.pickNoticeText(value[key])
      if (text) return text
    }
    return ""
  }

  extractGroupNoticeText(response) {
    const payload = response?.data ?? response
    const notices = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.notices)
        ? payload.notices
        : Array.isArray(payload?.notice)
          ? payload.notice
          : [payload].filter(Boolean)

    const sorted = notices.slice().sort((a, b) => {
      const getTime = item => Number(item?.publish_time || item?.time || item?.create_time || item?.updated_at || 0)
      return getTime(b) - getTime(a)
    })

    for (const notice of sorted) {
      const text = this.normalizeGroupContextText(this.pickNoticeText(notice), 800)
      if (text) return text
    }
    return ""
  }

  getBasicGroupContext(e) {
    const groupId = String(e?.group_id || "")
    return {
      groupId,
      groupName: this.normalizeGroupContextText(
        e?.group_name || e?.group?.name || e?.group?.info?.group_name || e?.group?.info?.name,
        120
      ),
      groupNotice: ""
    }
  }

  async getCurrentGroupContext(e) {
    const basic = this.getBasicGroupContext(e)
    const groupId = basic.groupId
    if (!groupId) return { groupId: "", groupName: "", groupNotice: "" }

    const cached = groupContextCache.get(groupId)
    if (cached && Date.now() - cached.at < GROUP_CONTEXT_CACHE_TTL_MS) {
      return { ...cached.data, groupName: basic.groupName }
    }

    let groupNotice = ""
    for (const action of ["get_group_notice", "_get_group_notice"]) {
      try {
        const noticeRes = await this.callOneBotApi(e, action, { group_id: Number(groupId) })
        groupNotice = this.extractGroupNoticeText(noticeRes)
        if (groupNotice) break
      } catch (error) {
        logger.debug?.(`[群上下文] ${action} 获取群公告失败 group=${groupId}: ${error.message}`)
      }
    }

    const data = { ...basic, groupNotice }
    groupContextCache.set(groupId, { at: Date.now(), data })
    return data
  }

  getTextImageTemplateForFinalReply({ content, output, session, toolName, e }) {
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
    if ((session?.turnPlan?.presentation?.kind === "knowledge" || userAskedForEducation) &&
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

  async sendFinalReplyAsTextImage(...args) { return await sendFinalReplyAsTextImage(this, ...args) }

  async sendModrinthForwardItems(e, items = []) {
    const nodes = (Array.isArray(items) ? items : []).filter(Boolean).map(text => ({
      user_id: Bot?.uin || e?.self_id || 0,
      nickname: Bot?.nickname || "希洛",
      message: String(text)
    }))
    if (!nodes.length) return null
    if (typeof e?.group?.makeForwardMsg !== "function") {
      logger.warn("[Modrinth] 当前群适配器不支持合并转发，回退为普通文字")
      return await this.sendSegmentedMessage(e, nodes.map(node => node.message).join("\n\n"), 0)
    }
    const forward = await e.group.makeForwardMsg(nodes)
    const result = await this.sendObservedReply(e, forward, false, "agent_forward")
    logger.info(`[Modrinth] 已发送合并转发，共 ${nodes.length} 个模组节点`)
    return result?.message_id
  }

  async sendModrinthForwardCards(e, cards = []) {
    const source = (Array.isArray(cards) ? cards : []).filter(card => card?.pageUrl && card?.fallbackText)
    if (!source.length) return null
    if (typeof e?.group?.makeForwardMsg !== "function") {
      logger.warn("[Modrinth] 当前群适配器不支持合并转发，回退为普通文字")
      return await this.sendSegmentedMessage(e, source.map(card => `${card.fallbackText}\n项目页: ${card.pageUrl}`).join("\n\n"), 0)
    }

    const renderStartedAt = Date.now()
    try {
      // The shared renderer rejects parallel calls while Chromium is starting.
      // Warm it once, then independent, uniquely named card pages can render in parallel.
      await prewarmModrinthCardRenderer()
    } catch (error) {
      logger.warn(`[Modrinth] 卡面渲染器预热失败，将逐项尝试渲染: ${error.message}`)
    }

    let imageCount = 0
    const messages = await Promise.all(source.map(async card => {
      try {
        const image = await renderModrinthCard(e, card)
        if (!image) throw new Error("HTML 卡面没有返回图片")
        imageCount += 1
        return [image, `\n项目页: ${card.pageUrl}`]
      } catch (error) {
        logger.warn(`[Modrinth] 卡面渲染失败，回退完整文本 project=${card.projectId || ""}: ${error.message}`)
        return [`${card.fallbackText}\n项目页: ${card.pageUrl}`]
      }
    }))
    logger.info(`[Modrinth] 卡面渲染完成 image=${imageCount}/${source.length} fallback=${source.length - imageCount} elapsed=${Date.now() - renderStartedAt}ms`)
    const nodes = messages.map(message => ({
      user_id: Bot?.uin || e?.self_id || 0,
      nickname: Bot?.nickname || "希洛",
      message
    }))
    const forward = await e.group.makeForwardMsg(nodes)
    const result = await this.sendObservedReply(e, forward, false, "agent_forward")
    logger.info(`[Modrinth] 已发送 HTML 卡面合并转发，共 ${nodes.length} 个模组节点`)
    return result?.message_id
  }

  /**
   * 启动/重置用户独立的会话追踪定时器
   * @param {string} conversationKey - 会话key
   * @param {object} newData - 要更新的数据 { chatHistory, lastActiveTime }
   */
  setTrackingWithTimer(conversationKey, newData = {}) {
    return setTrackingWithTimer(this, conversationKey, newData)
  }

  /**
   * 解析对话焦点状态（FOCUS / FADING / COLD），含自动衰减。每次入口都该调一次。
   * 长时间无消息时一次性衰减到位（focus 经过 fading 直到 cold），避免误判为"刚进入 fading"。
   */
  resolveConversationPhase(state) {
    return resolveConversationPhase(this, state)
  }

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
  prefilterMessage(e,state) {return conversationPrefilter.prefilterMessage(this,e,state)}

  /**
   * 计算群最近 5 分钟消息数（含 bot 自己的回复，用于 Gate prompt 活跃度信号）。
   * 仅做粗略统计：state.recentIncomingTimestamps 滑动窗口。
   */
  computeGroupMsgRate5min(state) {
    return computeGroupMsgRate5min(this, state)
  }

  /**
   * Bot 速率硬上限检查（防刷屏最终防线）。
   * 返回 true=可以继续回复，false=已超上限不该回复（force 路径请勿调用本函数）
   */
  applyRateLimitGuard(state, groupId) {
    return applyRateLimitGuard(this, state, groupId)
  }

  /**
   * 冷群空窗 deferred timer：仅 phase=cold 时排，按 (threshold-currentEquiv)*avgMs 估算延迟，
   * 到点合成 _smartWaitRerun 事件再跑一轮 Gate。
   * 注意：本函数通常在 inFlight=true 时（主流程 try 块内）被调用，因此**不要**用 inFlight 守卫；
   * 真正的并发保护放在 setTimeout 回调里（callback 触发时再检查 inFlight）。
   */
  scheduleDeferredGateCheck(e,state) { return conversationScheduling.scheduleDeferredGateCheck(this,e,state) }

  /**
   * 执行参与复读：直接 e.reply(原文) 跳过 Gate / handleTool（规避 LLM 改写），
   * 仍占用速率配额，但不升 FOCUS（复读不算正常对话参与）。
   * rate limit 已满时返回 false 不复读。
   */
  async joinRepeat(e, state, text) {
    return await joinRepeat(this, e, state, text)
  }

  /**
   * 复读检测：看最近 N 条群消息，若至少 minCount 个不同用户发了和当前 e.msg 完全相同的内容，
   * 按 repeatJoinProbability 概率决定 bot 是否参与复读。返回要复读的文本，否则 null。
   * 命中时不走 Gate / handleTool，直接 e.reply 原文，规避 LLM 改写。
   */
  detectGroupRepeat(e, state) {
    return detectGroupRepeat(this, e, state)
  }

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
  async isMutedInGroup(e) {return await mutedGroupPolicy.isMutedInGroup(e)}

  getSmartState(groupId, e) {
    // 群运行时状态统一门面:smart 状态存储已迁 core/runtime/groupRuntime.js(行为不变)
    return getSmartRuntimeState(smartConversationKey(groupId, e))
  }

  getDirectTriggerMergeMs() {
    return getDirectTriggerMergeMs(this)
  }

  getDirectTriggerMergeMaxMessages() {
    return getDirectTriggerMergeMaxMessages(this)
  }

  getMergeMsForEvent(e = {}) { return conversationScheduling.getMergeMsForEvent(this,e) }

  isMergeableDirectTrigger(e = {}) { return conversationScheduling.isMergeableDirectTrigger(this,e) }

  buildMergedDirectTriggerEvent(baseEvent,messages = []) { return conversationScheduling.buildMergedDirectTriggerEvent(this,baseEvent,messages) }

  buildMergedDirectTriggerPrompt(e = {}) { return conversationScheduling.buildMergedDirectTriggerPrompt(this,e) }

  scheduleMergedDirectTrigger(e,handler,reason = "direct") { return conversationScheduling.scheduleMergedDirectTrigger(this,e,handler,reason) }

  isMergeableToolRequest(e = {}) { return conversationScheduling.isMergeableToolRequest(this,e) }

  isLikelyToolRequestText(text = "") {return conversationEntryPolicy.isLikelyToolRequestText(this,text)}

  isAutomaticTorrentDownloadEvent(e = {}) {return conversationEntryPolicy.isAutomaticTorrentDownloadEvent(this,e)}

  buildMergedToolRequestEvent(baseEvent,messages = []) { return conversationScheduling.buildMergedToolRequestEvent(this,baseEvent,messages) }

  scheduleMergedToolRequest(e,handler) { return conversationScheduling.scheduleMergedToolRequest(this,e,handler) }

  /**
   * smart 模式触发入口：每条群消息进入此函数，按 talkValue 阈值/空窗补偿/强制覆盖三种条件决定是否调 Timing Gate
   */
  async handleRandomReplySmart(e) {
    return await handleRandomReplySmartFn(this, e)
  }

  shouldReleaseSmartLockForLongTask(e = {}) {
    return resolveLongTaskFeedbackPolicy(String(e?.msg || ""))?.releaseSmartLock === true
  }

  releaseSmartInFlight(state,e,expectedToken) { return conversationScheduling.releaseSmartInFlight(this,state,e,expectedToken) }

  getSmartLockTimeoutMs() { return conversationScheduling.getSmartLockTimeoutMs(this) }

  scheduleSmartLockWatchdog(state) { return conversationScheduling.scheduleSmartLockWatchdog(this,state) }

  /**
   * 调用 Timing Gate 子代理，返回 { decision: 'continue'|'no_action'|'wait', wait_seconds?, reason? }
   * @param ctx 额外上下文：{ phase, prefilter, threshold }
   */
  async runTimingGate(e, state, ctx = {}) {
    return await runTimingGateFn(this, e, state, ctx)
  }

  /**
   * 回复 debounce：等待 replyDebounceMs 看群里是否有新消息进来；
   * 有新消息且未到 maxConsecutiveInterrupts 上限 → 让步本轮（return false）；
   * 否则放行（return true）。force 路径应在调用方跳过本检查。
   */
  async applyReplyDebounce(e) { return await conversationScheduling.applyReplyDebounce(this,e) }

  /**
   * 解析 talkValue：优先用时段化规则，否则用全局 talkValue
   */
  resolveTalkValue(groupId) {
    return resolveTalkValue(this, groupId)
  }

  /**
   * 空窗补偿：冷群按 idle/avg_latency 折算"等效消息数"，凑够阈值就触发
   * @param state - 该群的 SmartState
   * @param threshold - 当前阈值（ceil(1/talkValue)）
   * @param prevLastMsgAt - 上一条消息的时间戳（本次入口前的值，必须由调用方传入，否则 idle=0 永远不命中）
   */
  idleCompensationMet(state, threshold, prevLastMsgAt) {
    return idleCompensationMet(this, state, threshold, prevLastMsgAt)
  }

  /**
   * 计算最近 10 分钟平均回复延迟（毫秒）
   */
  computeAvgReplyLatency(state) {
    return computeAvgReplyLatency(this, state)
  }

  /**
   * 记录一次"用户消息→bot 回复"的延迟，给空窗补偿用。两种模式都调用。
   */
  recordReplyLatency(groupId, latencyMs, e) {
    return recordReplyLatency(this, groupId, latencyMs, e)
  }

  /**
   * 安排 N 秒后强制再触发一轮 Gate，让 LLM 决定要不要补一句（wait 工具/Gate wait 决策共用）
   */
  scheduleWaitReply(e,seconds,reason) { return conversationScheduling.scheduleWaitReply(this,e,seconds,reason) }

  /**
   * 外部插件主动触发：注入 intent 到群历史 + 强制下一轮 Gate continue
   * @param {string|number} groupId
   * @param {string} intent 主动想说的话题/意图
   * @param {object} opts { source: '插件名', anchorE: 可选锚点 e }
   */
  async enqueueProactiveTask(groupId,intent,opts = {}) { return await conversationScheduling.enqueueProactiveTask(this,groupId,intent,opts) }

  async scanRedisKeys(pattern) {
    try {
      if (typeof redis.scanIterator === "function") {
        const keys = []
        for await (const key of redis.scanIterator({ MATCH: pattern, COUNT: 200 })) {
          if (Array.isArray(key)) keys.push(...key)
          else keys.push(key)
        }
        return keys
      }

      if (typeof redis.scan === "function") {
        const keys = []
        let cursor = "0"
        do {
          const [nextCursor, batch = []] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 200)
          cursor = String(nextCursor)
          keys.push(...batch)
        } while (cursor !== "0")
        return keys
      }
    } catch (error) {
      logger.warn(`[Redis] SCAN 扫描失败，回退使用 KEYS：${pattern}，原因：${error.message}`)
    }

    return await redis.keys(pattern)
  }

  async deleteRedisKeys(keys = []) {
    for (let i = 0; i < keys.length; i += 200) {
      const chunk = keys.slice(i, i + 200).filter(Boolean)
      if (chunk.length) {
        await redis.del(...chunk)
      }
    }
  }

  async clearAllMessages() {
    const keys = await this.scanRedisKeys(`${this.REDIS_KEY_PREFIX}*`)
    if (keys?.length) {
      await this.deleteRedisKeys(keys)
      logger.info(`已清除${keys.length}条消息历史记录`)
    }
  }

  getTaskStatusCacheKey(groupId, messageId) {
    return getTaskStatusCacheKey(this, groupId, messageId)
  }

  getTaskStatusRedisKey(groupId, messageId) {
    return getTaskStatusRedisKey(this, groupId, messageId)
  }

  getActiveToolTaskCacheKey(groupId, userId, toolName) {
    return getActiveToolTaskCacheKey(this, groupId, userId, toolName)
  }

  getActiveToolTaskRedisKey(groupId, userId, toolName) {
    return getActiveToolTaskRedisKey(this, groupId, userId, toolName)
  }

  getTaskStatusTtlSeconds() {
    return getTaskStatusTtlSeconds(this)
  }

  async saveTaskStatus(payload) {
    return await saveTaskStatus(this, payload)
  }

  async getTaskStatus(groupId, messageId) {
    return await getTaskStatus(this, groupId, messageId)
  }

  async clearTaskStatus(groupId, messageId) {
    return await clearTaskStatus(this, groupId, messageId)
  }

  async updateUserToolTaskStatus(payload) {
    return await updateUserToolTaskStatus(this, payload)
  }

  async getUserToolTaskStatus(groupId, userId, toolName) {
    return await getUserToolTaskStatus(this, groupId, userId, toolName)
  }

  async clearUserToolTaskStatus(payload) {
    return await clearUserToolTaskStatus(this, payload)
  }

  getRuntimeToolTaskStatus(groupId, userId, toolName) {
    return getRuntimeToolTaskStatus(this, groupId, userId, toolName)
  }

  async getCurrentUserToolTaskStatus(groupId, userId, toolName) {
    return await getCurrentUserToolTaskStatus(this, groupId, userId, toolName)
  }

  buildDrawTaskStatusReply(status) {
    return buildDrawTaskStatusReply(this, status)
  }

  buildReplySegment(messageId) {
    return buildReplySegment(this, messageId)
  }

  buildTaskStatusReplyMessage(status, text) {
    return buildTaskStatusReplyMessage(this, status, text)
  }

  async handleActiveDrawStatusQuestion(e, text = "") {
    return await handleActiveDrawStatusQuestion(this, e, text)
  }

  formatTaskStatusForPrompt(status) {
    return formatTaskStatusForPrompt(this, status)
  }

  getToolRunKey(groupId, userId, toolName) {
    return `${groupId}:${userId}:${toolName}`
  }

  async beginConversationTask(e) {
    const groupId = e.group_id
    const userId = e.user_id
    if (!groupId || !userId) return { groupId, userId, messageId: e.message_id || null }

    const task = {
      groupId,
      userId,
      messageId: e.message_id || null,
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

  async finishConversationTask(task, session) {
    if (!task?.groupId || !task?.userId) return

    if (!task.messageId || session?.taskDedupeToolTouched) return

    const status = await this.getTaskStatus(task.groupId, task.messageId)
    if (!status || status.status === "processing") {
      await this.clearTaskStatus(task.groupId, task.messageId)
    }
  }

  isDedupeTool(toolName) {
    return this.dedupeToolNames?.has(toolName)
  }

  isToolResultError(result) {
    const text = typeof result === "string" ? result : JSON.stringify(result || "")
    return /^error[:：]/i.test(text.trim()) || /"error"\s*:/.test(text) || /失败|错误|失敗|錯誤/.test(text)
  }

  isRawToolFailure(result) {
    const text = typeof result === "string" ? result.trim() : JSON.stringify(result || "").trim()
    return /^error[:：]/i.test(text) ||
      /^\{\s*"error"\s*:/i.test(text) ||
      /^(?:[^\n]{0,48})(?:请求|查询|分析|下载|解析|发送|处理|执行|生成|编辑).{0,20}(?:失败|错误|异常|超时)/i.test(text)
  }

  syncDedupeToolConfig(...args) {return toolAssembly.syncDedupeToolConfig(this,...args)}

  getToolsByName(...args) {return toolAssembly.getToolsByName(this,...args)}

  getToolsDescriptionString(...args) {return toolAssembly.getToolsDescriptionString(this,...args)}

  ensureConfigFiles() {
    if (!sharedConfigStore) this.initConfigStore()
    return sharedConfigStore.ensureFiles()
  }

  initConfigStore() {
    if (sharedConfigStore) return sharedConfigStore
    sharedConfigStore = createConfigStore({
      pluginRoot: path.join(process.cwd(), "plugins/shiloh-plugin"),
      configFiles: ["message.yaml", "mcp-servers.yaml"],
      watchImpl: (file, cb) => chokidar.watch(file).on("change", cb),
      onChange: async settings => {
        this.config = settings
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
    this.config = settings
    store.startWatch()
  }

  // 当前会话生效人设:群按 persona-library 的群绑定,私聊按 privateBinding,
  // 其次按 bot 账号默认(accountBindings),否则 message.yaml 默认
  getPersonaFor(e) {
    try {
      return this.personaLibrary?.resolve({
        messageType: e?.message_type,
        groupId: e?.group_id,
        selfId: e?.self_id || e?.bot?.uin || globalThis.Bot?.uin || ""
      })?.persona || this.config?.persona || {}
    } catch {
      return this.config?.persona || {}
    }
  }

  // 按会话人设生成的配置视图:未绑定群直接复用全局配置对象(零开销),绑定群浅拷贝替换 persona
  getChatConfig(e) {
    const persona = this.getPersonaFor(e)
    if (!persona || persona === this.config?.persona) return this.config
    return { ...this.config, persona }
  }

  mergeConfig(defaults, user) {
    return mergeDeepConfig(defaults, user)
  }

  mergeConfigPreserveUser(defaults, user) {
    if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
      return user === undefined ? defaults : user
    }
    if (!user || typeof user !== "object" || Array.isArray(user)) {
      return defaults
    }

    const merged = {}
    for (const key of Object.keys(defaults)) {
      merged[key] =
        key in user ? this.mergeConfigPreserveUser(defaults[key], user[key]) : defaults[key]
    }
    for (const key of Object.keys(user)) {
      if (!(key in defaults)) {
        merged[key] = user[key]
      }
    }
    return merged
  }

  mergeMCPConfig(...args) {return toolAssembly.mergeMCPConfig(this,...args)}

  checkGroupPermission(e) {
    if (!this.config.enableGroupWhitelist) return true
    return this.config.allowedGroups.some(id => String(id) === String(e.group_id))
  }

  // 私聊回合入口:门禁(开关/白名单/节流) → 违禁词 → 锚点 → 主回合
  async handlePrivateChat(e) {return await conversationEntryPolicy.handlePrivateChat(this,e)}

  isUserBlacklisted(e) {return conversationEntryPolicy.isUserBlacklisted(this,e)}

  // 违禁词命中处理:标记会话中断(掐掉该群所有早于此的进行中回合) + 取消排队续话。
  // 返回 true 表示本条消息已被黑名单吞掉,调用方直接 return。
  handleForbiddenWordHit(e) {return conversationEntryPolicy.handleForbiddenWordHit(this,e)}

  // 记忆自纠错:群友指出"你记错了"时,自动降权她上一轮引用的记忆(降权非删除,重复纠错自然淡忘)
  handleMemorySelfCorrection(e) {return conversationEntryPolicy.handleMemorySelfCorrection(this,e)}

  // 中断后的排队清理:延迟触发/续话定时器/待重跑事件全部作废,新消息可开新对话
  cancelPendingConversation(groupId,e) { return conversationScheduling.cancelPendingConversation(this,groupId,e) }

  getGroupUserMessages(...args) { return conversationHistory.getGroupUserMessages(this,...args) }

  saveGroupUserMessages(...args) { return conversationHistory.saveGroupUserMessages(this,...args) }

  clearGroupUserMessages(...args) { return conversationHistory.clearGroupUserMessages(this,...args) }

  resetGroupUserMessages(...args) { return conversationHistory.resetGroupUserMessages(this,...args) }

  formatTime() {
    return formatTime(this)
  }

  collectForwardPromptLines(...args) { return conversationHistory.collectForwardPromptLines(this,...args) }

  resolveForwardPromptFromSegments(...args) { return conversationHistory.resolveForwardPromptFromSegments(this,...args) }

  async buildMessageContent(sender, msg, images, atQq = [], group, e = null) {
    return await buildMessageContent(this, sender, msg, images, atQq, group, e)
  }

  checkTriggers(e) {return conversationEntryPolicy.checkTriggers(this,e)}

  isCommand(e) {return conversationEntryPolicy.isCommand(this,e)}

  filterChatByQQ(...args) { return conversationHistory.filterChatByQQ(this,...args) }

  getOrCreateSession(sessionId, tools) {
    return this.sessionStore.getOrCreate(sessionId, tools)
  }

  clearSession(sessionId) {
    this.sessionStore.clear(sessionId)
  }

  trimMessageHistory(...args) { return conversationHistory.trimMessageHistory(this,...args) }

  /**
   * AI判断用户是否在继续跟机器人对话
   * @param {string} userMessage - 用户新消息
   * @param {Array} chatHistory - 对话历史数组 [{role: 'bot'|'user', content: '...'}]
   */
  async isUserTalkingToBot(userMessage, chatHistory = [], e) {
    return await isUserTalkingToBot(this, userMessage, chatHistory, e)
  }

  /**
   * 加入批量判断队列
   */
  addToBatchJudgment(conversationKey, userMessage, chatHistory, e) {
    return addToBatchJudgment(this, conversationKey, userMessage, chatHistory, e)
  }

  /**
   * 处理批量判断队列
   */
  async processBatchJudgments() {
    return await processBatchJudgments(this)
  }

  /**
   * 批量判断多条消息是否在跟机器人对话
   */
  async batchIsUserTalkingToBot(batch) {
    return await batchIsUserTalkingToBot(this, batch)
  }

  /**
   * 回退到单独判断
   */
  async fallbackToSingleJudgment(batch, partialResults = null) {
    return await fallbackToSingleJudgment(this, batch, partialResults)
  }

  async handleRandomReply(e) {
    return await handleRandomReply(this, e)
  }

  async handleToolInner(e) {
    return await handleToolInnerFn(this, e)
  }

  formatMessages(messages, e, currentUserContent = null) {
    return formatMessages(this, messages, e, currentUserContent)
  }

  /**
   * 格式化工具返回结果（截断过长内容）
   */

	  retryRequest(...args) {return toolAssembly.retryRequest(this,...args)}

  getFriendlyFailureMessage(...args) { return getFriendlyFailureMessage(...args) }

  async composeToolFailureReply(toolName = "", context = {}) {
    const fallback = context.factualReply || this.getFriendlyFailureMessage(toolName, context)
    const messages = selectAgentReplyContext(context.messages)
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
      logger.debug?.(`[工具失败回复] Agent 组织失败，使用事实兜底: ${error.message}`)
    }
    return fallback
  }

  // P4 主判定：模型意图优先（6s 超时，confidence<0.7 或失败返回 null 走正则兜底）
  async resolvePrimaryModelIntent(text, { hasImages = false } = {}) {
    const ai = this.config?.intentAiConfig || this.config?.toolsAiConfig || {}
    if (!ai.intentAiUrl && !ai.toolsAiUrl) return null
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

  async handleToolFailureResponse(toolName = "", context = {}) {
    // 出站仲裁：工具已失败，扣住的承诺类文案直接丢弃，只发事实性失败说明
    context?.session?.outboundArbiter?.markFailure()
    // 表情包是锦上添花的反应形态：限流/文件缺失/发送失败时不再起一次润色模型道歉——
    // 道歉文本本身就是观感问题，静默跳过即可（无匹配/库空已由工具返回文字引导，不走这里）
    if (toolName === LOCAL_EMOJI_TOOL_NAME) {
      logger.info(`[表情包] 发送未完成，本轮静默跳过: ${String(context?.factualReply || context?.error || "").slice(0, 120)}`)
      return
    }
    if (isImageDeliveryToolName(toolName) && context?.e?.group_id) {
      recordDrawTextFallback(context.e.group_id, context?.session?.rawArgs || context?.e?.msg || "")
    }
    // 画图类失败不交给模型润色：实测模型会无视"已失败"的事实指令，
    // 对着原始请求回出"当然可以～我会画成…"这类承诺话术
    if (isImageDeliveryToolName(toolName)) {
      const factualReply = context.factualReply || this.getFriendlyFailureMessage(toolName, context)
      return await this.handleTextResponse(factualReply, context.e, context.session, context.messages || [], toolName)
    }
    const output = await this.composeToolFailureReply(toolName, context)
    return await this.handleTextResponse(output, context.e, context.session, context.messages || [], toolName)
  }

  getToolFailureKind(error = "") {
    const text = typeof error === "string" ? error : JSON.stringify(error || "")
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

  getQuotedPromptContextText(...args) { return getQuotedPromptContextText(this, ...args) }
  getRecentPromptContextText(...args) { return getRecentPromptContextText(this, ...args) }
  getRecentDrawContextText(...args) { return getRecentDrawContextText(this, ...args) }
  resolveContextualDrawGeneration(...args) { return resolveContextualDrawGeneration(this, ...args) }
  getUnderstandingEnhancementConfig(...args) { return getUnderstandingEnhancementConfig(this, ...args) }
  shouldInjectUnderstandingContext(...args) { return shouldInjectUnderstandingContext(this, ...args) }
  extractForwardContextFromUserContent(...args) { return extractForwardContextFromUserContent(this, ...args) }
  gatherUnderstandingMaterials(...args) { return gatherUnderstandingMaterials(this, ...args) }
  resolveUnderstandingPrompt(...args) { return resolveUnderstandingPrompt(this, ...args) }
  buildUnderstandingContextPrompt(...args) { return buildUnderstandingContextPrompt(this, ...args) }
  buildImageGenerationPrompt(...args) { return buildImageGenerationPrompt(this, ...args) }
  getImageGenerationReferenceImages(...args) { return getImageGenerationReferenceImages(this, ...args) }
  buildImageEditPrompt(...args) { return buildImageEditPrompt(this, ...args) }

	  buildForcedToolCall(toolName, params = {}) {
	    return {
	      id: `call_${randomUUID().replace(/-/g, "")}`,
	      type: "function",
      function: {
        name: toolName,
        arguments: JSON.stringify(params)
      }
    }
  }

  shouldUseSemanticToolIntent(...args) { return shouldUseSemanticToolIntent(this, ...args) }
  normalizeToolDecision(...args) { return normalizeToolDecision(this, ...args) }
  resolveChatCompletionUrl(url = "", apiConfig = null) {
    // 按渠道 autoResolve: false → 直接使用配置的 URL 原文
    const cfg = apiConfig || {}
    if (cfg.autoResolve === false) return String(url || "").trim()
    return normalizeChatCompletionUrl(url)
  }
  extractJsonObject(...args) { return extractJsonObject(this, ...args) }
  async classifySemanticToolIntent(...args) { return await classifySemanticToolIntent(this, ...args) }
  buildToolCallFromDecision(...args) { return buildToolCallFromDecision(this, ...args) }
  buildMissingToolCommitmentCall(...args) { return buildMissingToolCommitmentCall(this, ...args) }

  normalizeAssistantToolMessage(...args) { return normalizeAssistantToolMessage(this, ...args) }
  serializeToolResult(...args) { return serializeToolResult(this, ...args) }
  getToolCallName(...args) { return getToolCallName(this, ...args) }
  shouldRunTerminalToolsInBackground(...args) { return shouldRunTerminalToolsInBackground(this, ...args) }
  buildGroundedImageAnalysisPrompt(...args) { return buildGroundedImageAnalysisPrompt(this, ...args) }
  extractToolResultText(...args) { return extractToolResultText(this, ...args) }
  buildImageVerificationSearchToolCall(...args) { return buildImageVerificationSearchToolCall(this, ...args) }
  async startBackgroundTerminalToolCalls(...args) { return await startBackgroundTerminalToolCalls(this, ...args) }
  async runToolCall(...args) { return await runToolCall(this, ...args) }
  dedupeToolCalls(...args) { return dedupeToolCalls(this, ...args) }
  async processToolCalls(...args) { return await processToolCalls(this, ...args) }
  async executeTool(...args) { return await executeTool(this, ...args) }

  async handleTextResponse(...args) { return await handleTextResponse(this, ...args) }

  /**
   * 异步更新情感系统、长期记忆
   */
  async updateEnhancedSystems(...args) { return await updateEnhancedSystems(this, ...args) }

  async sendObservedReply(...args) { return await sendObservedReply(this, ...args) }
  async sendSegmentedMessage(...args) { return await sendSegmentedMessage(this, ...args) }
  splitMessage(...args) { return splitMessage(this, ...args) }
  splitLongMessageByPunctuation(...args) { return splitLongMessageByPunctuation(this, ...args) }
  async convertAtInString(...args) { return await convertAtInString(this, ...args) }
  findMember(...args) { return findMember(this, ...args) }
  processToolSpecificMessage(...args) { return processToolSpecificMessage(this, ...args) }

  initMCP(...args) {return toolAssembly.initMCP(this,...args)}

  /**
   * 更新工具列表（合并本地工具和MCP工具）
   */
  updateToolsList(...args) {return toolAssembly.updateToolsList(this,...args)}

  waitForMCPReady(...args) {return toolAssembly.waitForMCPReady(this,...args)}

  /**
   * 清除当前群的所有记忆（群记忆 + 用户记忆）
   */

  /**
   * 重载MCP配置（管理员命令）
   */

  // authority → 中文来源（新模型权威分级 config>self>teaching>mention）

  // 对齐新 fact 模型（entityModel.makeFact）：factShortId(text) 作 id、tags[0] 作分类、
  // text、confidence、authority 中文来源；eventAt 存在附"(待回扣)"。
  formatMemoryFactLines(...args) { return formatMemoryFactLines(this, ...args) }

  formatMemoryFacts(...args) { return formatMemoryFacts(this, ...args) }

  async replyMemoryForward(...args) { return await replyMemoryForward(this, ...args) }

  async replyLongForward(...args) { return await replyLongForward(this, ...args) }

  // P1-4：进程内调用计数/耗时统计（主人或群管理员可见）。重启归零。

  async reloadMCP(e) {
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
      await this.sendObservedReply(e, `MCP重载失败: ${error.message}`)
    }

    return true
  }

  /**
   * 列出所有MCP工具
   */
  async listMCPTools(e) {
    const text = mcpManager.getToolsListText()
    await this.replyLongForward(e, "MCP工具列表", text)
    return true
  }

  // 主人调试命令:回显最近回合的提示词分层报告、路由命中轨迹与输出守卫统计。
  // 可选参数:群号(#希洛调试 123456 只看该群;不带则看全部群的最近回合)。
  async handleDebugDiagnostics(e) {
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

  async mcpStatus(e) {
    return await mcpStatus(this, e)
  }

  async testMCPTool(e) {
    return await testMCPTool(this, e)
  }

  isChatManager(e) {
    return isChatManager(this, e)
  }

  forbiddenWordList() {
    return forbiddenWordList(this)
  }

  async handleForbiddenList(e) {
    return await handleForbiddenList(this, e)
  }

  async handleForbiddenAdd(e) {
    return await handleForbiddenAdd(this, e)
  }

  async handleForbiddenRemove(e) {
    return await handleForbiddenRemove(this, e)
  }

  // "#切换人设 名字 123456" 里可带目标群号(仅主人,跨群切换);群内使用默认切本群
  resolvePersonaTargetGroup(e, explicit) {
    return resolvePersonaTargetGroup(this, e, explicit)
  }

  formatPersonaDetail(detail) {
    return formatPersonaDetail(this, detail)
  }

  async handlePersonaList(e) {
    return await handlePersonaList(this, e)
  }

  async handlePersonaCurrent(e) {
    return await handlePersonaCurrent(this, e)
  }

  async handlePersonaDetail(e) {
    return await handlePersonaDetail(this, e)
  }

  async handlePersonaSwitch(e) {
    return await handlePersonaSwitch(this, e)
  }

  async handlePersonaReset(e) {
    return await handlePersonaReset(this, e)
  }

  // 把当前会话生效的人设快照存成人设库新条目(主人);重名覆盖
  async handlePersonaSave(e) {
    return await handlePersonaSave(this, e)
  }

  async handlePersonaDelete(e) {
    return await handlePersonaDelete(this, e)
  }

  async handlePersonaReload(e) {
    return await handlePersonaReload(this, e)
  }

  async handlePersonaBindings(e) {
    return await handlePersonaBindings(this, e)
  }
}

const toolAssembly=createToolAssembly({logger:{info:message=>globalThis.logger?.info?.(message),warn:message=>globalThis.logger?.warn?.(message),error:(message,error)=>globalThis.logger?.error?.(message,error)},refreshLocalTools:options=>refreshLocalTools(sharedState,options),applyToolRegistrySnapshot:()=>applyToolRegistrySnapshot(sharedState),mcpManager,getMcpInitPromise:()=>mcpInitPromise,parseToolConfigEntry,YTapi})
