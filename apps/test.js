import { EmotionManager } from "../domains/memory/EmotionManager.js"
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
} from "./lib/textPolicy.js"
import { MemoryManager } from "../domains/memory/MemoryManager.js"
import { ExpressionLearner } from "../domains/memory/ExpressionLearner.js"
import KnowledgeSearcher from "../domains/knowledge/KnowledgeSearcher.js"
import KnowledgeExpander from "../domains/knowledge/KnowledgeExpander.js"
import { checkPendingReminders } from "../functions/functions_tools/ReminderTool.js"
import { TakeImages } from "../utils/fileUtils.js"
import { loadData, saveData } from "../utils/redisClient.js"
import { YTapi } from "../utils/apiClient.js"
import { MessageManager } from "../utils/MessageManager.js"
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
import { buildToolIntentDisclosure, resolveToolRequestMergeMs, selectToolIntentCandidates } from "../utils/toolIntentManifests.js"
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
import { createConfigStore, mergeDeepConfig } from "../core/config/configStore.js"
import { classifyIntentWithModel } from "../core/intent/modelIntentClassifier.js"
import { isAiConversationEnabled } from "../utils/aiConversationGate.js"
import { shouldSkipIntentModel } from "../utils/intentFastPath.js"
import { computeAddresseeSignal, buildAddresseePrompt } from "../utils/addresseeSignals.js"
import { recordTurnContinuity, loadTurnContinuity, buildTurnContinuityPrompt } from "../utils/turnContinuity.js"
import { updateGroupTopic, updateGroupSocial, getGroupTopicPrompt, getGroupSocialPrompt } from "../utils/groupContextState.js"
import { recordEpisode, recallEpisodes, recallUserEpisodes, buildEpisodicPrompt, buildUserCallbackPrompt, hasTemporalDeixis } from "../utils/episodicMemory.js"
import { createTurnTrace, resolveTurnTraceArchiveDir } from "../utils/turnTrace.js"
import { createOutboundArbiter } from "../utils/messagePipeline/outboundArbiter.js"
import { resolveLongTaskFeedbackPolicy } from "../utils/longTaskFeedbackPolicy.js"
import { resolvePromptLayerProfile } from "../utils/promptLayers.js"
import { buildPersonaStyleOverride, renderPersonaTemplate, resolvePersonaName } from "../utils/personaSource.js"
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
  buildMissingToolCommitmentCall
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
const RED_BAG_CONFIG = {
  enabled: true, // 是否启用自动抢红包
  minProbability: 0.3, // 最小触发概率
  maxProbability: 0.8, // 最大触发概率
  cooldownTime: 60000 // 冷却时间（毫秒），同一个群60秒内不重复触发
}

const redBagCooldowns = new Map() // 红包冷却记录: key: groupId, value: lastGrabTime

// 清空群记忆二次确认（P0-1）：进程内 pending，key: `${groupId}_${userId}`, value: 过期时间戳。

const activeDedupeToolRuns = new Map()
const taskStatusCache = new Map()
const activeUserToolTaskCache = new Map()
const directTriggerMergeTimers = new Map()
const toolRequestMergeTimers = new Map()
const activeConversations = new Map() // 会话追踪: key: `${groupId}_${userId}`, value: { lastActiveTime, chatHistory: [], timer: null }
const trackingThrottle = new Map() // 节流: key: `${groupId}_${userId}`, value: lastCallTime
const pendingJudgments = [] // 批量判断队列
let batchTimer = null // 批量处理定时器
// smart 模式：每群独立的频率状态，进程内 Map，重启清零
const trackingChatStates = new Map() // groupId -> { pendingCount, lastMsgAt, replyLatencies: [{at, ms}], forceContinue, forceGateCheck, lastGateNoActionAt, inFlight, waitTimers: Map<userKey, timeoutId> }
// 群最后一条新消息到达时间戳，用于"准备回复前 debounce 看有没有新消息"（仅 smart 模式 set/读）
const lastIncomingMsgAt = new Map() // groupId -> ts
// 群连续被新消息打断的累计计数（达到上限后下一轮强制走完不再让步）
const consecutiveInterrupts = new Map() // groupId -> count
// smart 锁持有令牌：看门狗强制释放后旧轮次的 finally 不得误释放新轮次的锁
let smartLockTokenCounter = 0
// redis 抖动/断连时命令可能既不成功也不失败（挂起）。任务状态只是去重辅助，
// 超时降级为"无状态"，绝不能卡住会话收尾（进而卡死 smart 锁）。
const TASK_STATUS_REDIS_TIMEOUT_MS = 2000

async function settleTaskStatusRedis(promise, fallback, label) {
  let timer = null
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(fallback), TASK_STATUS_REDIS_TIMEOUT_MS)
  })
  try {
    return await Promise.race([promise, timeout])
  } catch (error) {
    logger.warn(`[任务状态] ${label}失败：${error.message}`)
    return fallback
  } finally {
    if (timer) clearTimeout(timer)
  }
}
// 禁言状态短期缓存：避免每条群消息都查一次 ws RPC pickMember.getInfo()
const mutedStatusCache = new Map() // groupId -> { isMuted, at }
const MUTED_CACHE_TTL_MS = 30000
const groupContextCache = new Map()
const GROUP_CONTEXT_CACHE_TTL_MS = 5 * 60 * 1000
const FORWARD_CONTEXT_MAX_DEPTH = 4
const FORWARD_CONTEXT_MAX_LINES = 120
const FORWARD_CONTEXT_MAX_TEXT = 9000
let activeChatLruTimer = null // 全局 24h LRU 扫描定时器，进程内单例
let durableToolRecoveryStarted = false


function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getOrCreateGroupLimiter(limitersMap, groupId, concurrency) {
  const entry = limitersMap.get(groupId)
  if (entry && entry.concurrency === concurrency) {
    return entry.limiter
  }
  const limiter = pLimit(concurrency)
  limitersMap.set(groupId, { limiter, concurrency })
  return limiter
}

function parseToolConfigEntry(entry) {
  const raw = String(entry || "").trim()
  const match = raw.match(/^([A-Za-z_][A-Za-z0-9_-]*)(?:\(([^)]*)\))?$/)
  if (!match) return { name: raw, dedupe: false, marker: "" }
  return {
    name: match[1],
    dedupe: match[2] !== undefined,
    marker: match[2] || ""
  }
}

const LOCAL_EMOJI_TOOL_NAME = "sendLocalEmojiTool"

function toolConfigHasName(toolNames, name) {
  return Array.isArray(toolNames) && toolNames.some(item => parseToolConfigEntry(item).name === name)
}

function buildInternalStatusSafeReply(toolName = "", session = {}) {
  const text = [session?.rawArgs, session?.userContent].filter(Boolean).join("\n")
  if (toolName === "bananaTool" || isImageGenerationRequest(text)) {
    return "这次图片没有完成，不代表你的描述有问题。你可以稍后按原话再试。"
  }
  if (toolName === "googleImageAnalysisTool" || isImageAnalysisRequest(text)) {
    return "图片我收到了，但这次识图服务没有返回可用结果。不是你没发图，我先不乱猜。"
  }
  return buildGenericChatFailureReply(text, { failureKind: "upstream" })
}

function hasMediaNeedingTool(message = []) {
  return Array.isArray(message) && message.some(seg =>
    ["image", "video", "record", "voice", "file", "wallet"].includes(seg?.type)
  )
}

function shouldExposeToolsForMessage(e = {}, text = "") {
  const content = normalizeIntentText(text || e?.msg || "")
  if (hasMediaNeedingTool(e?.message)) return true
  if (e?._groupContextAssets?.media?.length) return true
  if (shouldExposeEmojiToolForMessage(content)) return true
  return isRealtimeInfoRequest(content) || isExplicitSearchRequest(content) || isExplicitToolIntent(content)
}

function filterToolsForMessageIntent(tools = [], e = {}, text = "", { allowSearch = false, emojiCooldownMs = 120000 } = {}) {
  if (!Array.isArray(tools) || !tools.length) return []
  const content = normalizeIntentText(text || e?.msg || "")
  if (allowSearch) return tools.filter(tool => tool?.function?.name !== "mentionAdminsTool" || isExplicitAdminCollectionMentionRequest(content))
  if (!shouldExposeToolsForMessage(e, content)) return []

  // The all-admin tool is deliberately unavailable unless the user used
  // collection wording. A singular role request must go through exact member
  // targeting instead of allowing the model to broaden the audience.
  tools = tools.filter(tool =>
    tool?.function?.name !== "mentionAdminsTool" || isExplicitAdminCollectionMentionRequest(content)
  )

  const emojiOnlyTools = filterToolsForEmojiExposure(tools, content, {
    groupId: String(e?.group_id || ""),
    cooldownMs: emojiCooldownMs
  })
  if (emojiOnlyTools) return emojiOnlyTools

  if (allowSearch || isRealtimeInfoRequest(content) || isExplicitSearchRequest(content)) return tools

  return tools.filter(tool => {
    const name = tool?.function?.name
    return name && !SEARCH_TOOL_NAMES.has(name)
  })
}

function looksLikeCodeOrMarkdown(text = "") {
  const content = String(text || "")
  if (/```[\s\S]*```/.test(content)) return true
  if (/^\s{0,3}#{1,4}\s+\S/m.test(content) && content.split(/\r?\n/).length >= 3) return true
  if (/^\s*\|.+\|\s*$/m.test(content) && /^\s*\|[-:\s|]+\|\s*$/m.test(content)) return true

  const lines = content.split(/\r?\n/)
  const nonEmptyLines = lines.filter(line => line.trim())
  if (nonEmptyLines.length < 3) return false

  const codeLineCount = nonEmptyLines.filter(line =>
    /^\s*(def|class|for|if|elif|else|while|return|import|from|print|break|continue|const|let|var|function|class|export|switch|try|catch|public|private|static|package|func|fn)\b/.test(line) ||
    /^\s{2,}\S/.test(line) ||
    /[A-Za-z_$][\w$.\[\]]*\s*(?:=|==|===|>|<|\+|-|\*|\/)/.test(line) ||
    /[{}]/.test(line)
  ).length

  return codeLineCount >= 2
}

function applyToolRegistrySnapshot(state, snapshot = localToolRegistry.getSnapshot()) {
  state.toolInstances = snapshot.toolInstances
  state.functions = snapshot.functions
  state.functionMap = snapshot.functionMap
  state.customToolCount = snapshot.customToolCount || 0
  state.builtInToolCount = snapshot.builtInToolCount || 0
  return state
}

async function refreshLocalTools(state, options = {}) {
  const snapshot = await localToolRegistry.reload(options)
  return applyToolRegistrySnapshot(state, snapshot)
}

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
    sharedState.messageManager.groupMaxMessages = config.groupMaxMessages || 100
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
        { reg: "[\\s\\S]*", fnc: "handleRandomReply", log: false }
      ]
    })

    this.initConfig()
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
    this.startDurableToolRecovery()
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
   * 启动 trackingChatStates 的 TTL 扫描器（进程内单例）：每 1 小时扫一次，
   * 把 lastMsgAt 超过 activeChatTtlHours 的群从内存状态淘汰，连同 waitTimers 一并清掉。
   */
  startActiveChatLruScanner() {
    if (activeChatLruTimer) return
    const intervalMs = 60 * 60 * 1000
    activeChatLruTimer = setInterval(() => {
      try {
        const ttlHours = Number(this.config?.smartTrigger?.activeChatTtlHours) || 24
        const cutoff = Date.now() - ttlHours * 3600 * 1000
        let removed = 0
        for (const [gid, st] of trackingChatStates) {
          if ((st.lastMsgAt || 0) < cutoff) {
            if (st.waitTimers) for (const t of st.waitTimers.values()) clearTimeout(t)
            if (st.deferredTimer) clearTimeout(st.deferredTimer)
            trackingChatStates.delete(gid)
            lastIncomingMsgAt.delete(gid)
            consecutiveInterrupts.delete(gid)
            mutedStatusCache.delete(gid)
            removed += 1
          }
        }
        // 兜底：清掉孤儿条目（不应该出现，但防御性编程）
        for (const [gid, ts] of lastIncomingMsgAt) {
          if (!trackingChatStates.has(gid) && ts < cutoff) {
            lastIncomingMsgAt.delete(gid)
            consecutiveInterrupts.delete(gid)
          }
        }
        // 禁言缓存独立 TTL（30 秒就过期了，但万一某个群冷下来缓存条目永远留着也不好）
        const mutedCutoff = Date.now() - MUTED_CACHE_TTL_MS * 10
        for (const [gid, item] of mutedStatusCache) {
          if (item.at < mutedCutoff) mutedStatusCache.delete(gid)
        }
        if (removed > 0) logger.info(`[ActiveChatLRU] 淘汰 ${removed} 个 ${ttlHours}h 未活跃群，当前活跃 ${trackingChatStates.size}`)
        // 顺带清扫回合会话:异常回合未 clearSession 的条目按 TTL/容量淘汰,防随机 UUID 键无限累积
        const sweptSessions = this.sessionStore?.sweep() || 0
        if (sweptSessions > 0) logger.info(`[回合会话] 清扫 ${sweptSessions} 个过期/超量会话，当前 ${this.sessionStore.stats().sessions}`)
      } catch (err) {
        logger.error('[ActiveChatLRU] 扫描失败:', err)
      }
    }, intervalMs)
    activeChatLruTimer.unref?.()
  }

  async refreshLocalToolRegistry(options = {}) {
    const state = await refreshLocalTools(sharedState, options)
    this.toolInstances = state.toolInstances
    this.functions = state.functions
    this.functionMap = state.functionMap
    this.localToolsReady = true
    this.updateToolsList({ silent: options.silent === true })
    return state
  }

  initTools() {
    applyToolRegistrySnapshot(sharedState)
    this.toolInstances = sharedState.toolInstances
    this.functions = sharedState.functions
    this.functionMap = sharedState.functionMap

    const provider = this.config.providers.toLowerCase()
    const toolConfig = {
      oneapi: this.config.oneapi_tools
    }

    this.syncDedupeToolConfig(this.config.oneapi_tools || [])
    // 白名单缺省 = 全部已注册工具:新增工具不再要求同步改配置,漏改白名单的
    // 事故类型(工具静默不可见)从根上消除。配置了白名单时对排除项打告警提示。
    const configuredList = toolConfig[provider] || this.config.openai_tools
    const allRegisteredNames = Object.keys(this.toolInstances || {})
    const effectiveList = Array.isArray(configuredList) && configuredList.length ? configuredList : allRegisteredNames
    if (Array.isArray(configuredList) && configuredList.length) {
      const configuredNames = new Set(configuredList.map(entry => String(entry).replace(/\s*\(dedupe\)\s*$/i, "").trim()).filter(Boolean))
      const excluded = allRegisteredNames.filter(name => !configuredNames.has(name))
      if (excluded.length) {
        logger.warn(`[工具清单] oneapi_tools 白名单未包含以下已注册工具(如需启用请补进配置): ${excluded.join(", ")}`)
      }
    }
    const localTools = this.getToolsByName(effectiveList, {
      warnMissing: this.localToolsReady !== false
    })
    const mcpTools = mcpManager.getAllTools() || []
    this.tools = [...localTools, ...mcpTools]
  }

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
    })) return false
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
    const longReply = analyzeReplyText(output)
    if (longReply.shouldRender) {
      return longReply.template
    }
    return false
  }

  async sendFinalReplyAsTextImage(e, output, template = "chat") {
    const tool = this.toolInstances?.textImageTool
    try {
      const result = await tool.execute({ text: output, template }, e)
      if (typeof result === "string" && result.trim().startsWith("error:")) {
        throw new Error(result)
      }
      logger.info(`[textImageTool] 最终回复已转为图片发送 template=${template}`)
      return null
    } catch (error) {
      logger.warn(`[textImageTool] 最终回复转图失败，回退为普通文本: ${error.message}`)
      return await this.sendSegmentedMessage(e, output)
    }
  }

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
    const timeout = (this.config.conversationTrackingTimeout || 2) * 60000
    const activeConv = activeConversations.get(conversationKey)

    // 清除旧定时器
    if (activeConv?.timer) {
      clearTimeout(activeConv.timer)
    }

    // 创建新定时器
    const timer = setTimeout(() => {
      const conv = activeConversations.get(conversationKey)
      // 确保清除的是同一个定时器（防止竞态）
      if (conv?.timer === timer) {
        activeConversations.delete(conversationKey)
        trackingThrottle.delete(conversationKey)
        logger.info(`[会话追踪] ${conversationKey} 超时，已清除`)
      }
    }, timeout)

    // 原子操作：创建定时器后立即存储
    activeConversations.set(conversationKey, {
      lastActiveTime: Date.now(),
      chatHistory: activeConv?.chatHistory || [],
      ...newData,
      timer
    })
  }

  /**
   * 解析对话焦点状态（FOCUS / FADING / COLD），含自动衰减。每次入口都该调一次。
   * 长时间无消息时一次性衰减到位（focus 经过 fading 直到 cold），避免误判为"刚进入 fading"。
   */
  resolveConversationPhase(state) {
    const now = Date.now()
    const smartCfg = this.config.smartTrigger || {}
    const fadingDurationMs = Number(smartCfg.fadingDurationMs) || 90000

    // 自动衰减：一次入口可能跨越多个 phase，循环到稳定状态
    while (state.phaseUntil && now > state.phaseUntil) {
      if (state.conversationPhase === 'focus') {
        state.conversationPhase = 'fading'
        // 从 focus 结束的那一刻起算 fading 持续时间
        const fadingStart = state.phaseUntil
        state.phaseUntil = fadingStart + fadingDurationMs
        state.consecutiveNoAction = 0
        if (now > state.phaseUntil) continue   // fading 也已过期，继续衰减到 cold
        break
      }
      if (state.conversationPhase === 'fading') {
        state.conversationPhase = 'cold'
        state.phaseUntil = 0
        state.focusReplyCount = 0
        state.consecutiveNoAction = 0
        break
      }
      // 已经是 cold，phaseUntil 不应该为 0 以外的值；保险起见清掉
      state.phaseUntil = 0
      break
    }
    return state.conversationPhase || 'cold'
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
  prefilterMessage(e, state) {
    const smartCfg = this.config.smartTrigger || {}
    try {
      // bot 自己发的消息（防自激励）
      const botId = e?.bot?.uin || (typeof Bot !== 'undefined' && Bot.uin)
      if (botId && String(e?.user_id) === String(botId)) {
        return { kind: 'bot_self_echo', reason: 'sender_is_self' }
      }
      const atSelf = messageMentionsUser(e, botId)
      const quotesSelf = messageQuotesUser(e, botId)
      const text = String(e?.msg || '')
      const hasBotName = hasBotTextAnchor(text, Bot.nickname, this.config.triggerPrefixes)
      const explicitlyAddressesBot = atSelf || quotesSelf || hasBotName

      // @ 别人（且没有明确点名 bot）→ 跳过。
      // QQ 引用别人时常会自动带 @原作者；如果正文已经写了"希洛/触发前缀"，应视为找 bot。
      if (smartCfg.skipWhenAddressedOther !== false && Array.isArray(e?.message)) {
        const mentionedOthers = collectMentionTargetIds(e, botId)
        if (mentionedOthers.length > 0) {
          if (!explicitlyAddressesBot) {
            return { kind: 'addressed_other', reason: 'at_other_user' }
          }
        }
      }
      // 空文本（纯表情/图片/转账）→ 跳过。合并转发虽然本体没有 text segment，
      // 但可展开为后续问答和历史可用的上下文，不能在这里提前丢弃。
      if (smartCfg.skipWhenEmptyText !== false) {
        const rawText = (typeof e?.msg === 'string' ? e.msg : '').trim()
        if (!rawText && !atSelf && !quotesSelf) {
          if (extractForwardIdsFromSegments(e?.message || []).length) {
            return { kind: 'regular', reason: 'forward_context' }
          }
          return { kind: 'empty_content', reason: 'no_text' }
        }
      }

      // 以下为 continuation_strong 识别（必须距 bot 上次发言不远）
      const sinceLastBotReply = state.lastBotReplyAt ? Date.now() - state.lastBotReplyAt : Infinity
      const quickResponseMs = Math.max(0, Number(smartCfg.quickResponseMs) || 0)
      const lookbackMs = Number(smartCfg.continuationLookbackMs) || 180000
      const sameUserAsLastReply = state.lastBotReplyToUserId && String(e?.user_id || '') === String(state.lastBotReplyToUserId)
      let quotesBot = quotesSelf
      let quotesOther = false
      if (Array.isArray(e?.message)) {
        if (!quotesBot) quotesBot = e.message.some(seg => {
          if (seg?.type !== 'reply') return false
          const repliedUid = getReplySender(seg)
          return repliedUid && String(repliedUid) === String(botId)
        })
        quotesOther = e.message.some(seg => {
          if (seg?.type !== 'reply') return false
          const repliedUid = getReplySender(seg)
          return repliedUid && String(repliedUid) !== String(botId)
        })
      }
      const groupAddressed = looksGroupAddressed(text)
      const previousMessage = getPreviousRecentMessage(state, e)

      if (!atSelf && !hasBotName && !quotesBot && quotesOther) {
        return { kind: 'addressed_other', reason: 'reply_other_user' }
      }

      if (!atSelf && !hasBotName && !quotesBot && !sameUserAsLastReply && !groupAddressed && looksDirectedAtBotByPronoun(text)) {
        return { kind: 'likely_addressed_other', reason: 'pronoun_without_bot_anchor' }
      }

      if (!atSelf && !hasBotName && !quotesBot && !sameUserAsLastReply && looksAddressedToPreviousSpeaker(text, previousMessage, e?.user_id, botId)) {
        return { kind: 'likely_addressed_other', reason: 'reply_previous_speaker' }
      }

      // R1：秒回反应。仅限同一用户接话、引用 bot、或直接点名 bot；避免群友之间一句"你"被误判。
      if (atSelf) {
        return { kind: 'continuation_strong', reason: 'at_bot' }
      }
      if (quotesBot) {
        return { kind: 'continuation_strong', reason: 'reply_bot' }
      }
      if (sinceLastBotReply <= lookbackMs && sameUserAsLastReply && smartCfg.continuationFollowupMatch !== false && isLikelyFollowupMessage(text)) {
        return { kind: 'continuation_strong', reason: 'R0_same_user_followup' }
      }
      if (quickResponseMs > 0 && sinceLastBotReply <= quickResponseMs && (sameUserAsLastReply || quotesBot || hasBotName)) {
        return { kind: 'continuation_strong', reason: 'R1_quick_response' }
      }
      // R2/R3/R4 共同前提：在 lookback 窗口内
      if (sinceLastBotReply <= lookbackMs && (sameUserAsLastReply || quotesBot || hasBotName)) {
        // R2 关键词匹配
        if (smartCfg.continuationKeywordMatch !== false && Array.isArray(state.lastBotReplyKeywords)) {
          for (const kw of state.lastBotReplyKeywords) {
            if (kw && text.includes(kw)) {
              return { kind: 'continuation_strong', reason: `R2_keyword:${kw}` }
            }
          }
        }
        // R3 问句
        if (smartCfg.continuationQuestionMatch !== false && isQuestionMessage(text)) {
          return { kind: 'continuation_strong', reason: 'R3_question' }
        }
        // R4 反馈词
        if (smartCfg.continuationFeedbackMatch !== false && isFeedbackMessage(text)) {
          return { kind: 'continuation_strong', reason: 'R4_feedback' }
        }
      }
      return { kind: 'regular', reason: '' }
    } catch (err) {
      logger.warn(`[Prefilter] 异常，按 regular 处理：${err.message}`)
      return { kind: 'regular', reason: 'exception' }
    }
  }

  /**
   * 计算群最近 5 分钟消息数（含 bot 自己的回复，用于 Gate prompt 活跃度信号）。
   * 仅做粗略统计：state.recentIncomingTimestamps 滑动窗口。
   */
  computeGroupMsgRate5min(state) {
    if (!Array.isArray(state?.recentIncomingTimestamps)) return 0
    const cutoff = Date.now() - 300000
    state.recentIncomingTimestamps = state.recentIncomingTimestamps.filter(t => t > cutoff)
    return state.recentIncomingTimestamps.length
  }

  /**
   * Bot 速率硬上限检查（防刷屏最终防线）。
   * 返回 true=可以继续回复，false=已超上限不该回复（force 路径请勿调用本函数）
   */
  applyRateLimitGuard(state, groupId) {
    const smartCfg = this.config.smartTrigger || {}
    const cutoff = Date.now() - 600000
    state.recentReplyTimestamps = (state.recentReplyTimestamps || []).filter(t => t > cutoff)
    const maxPer10Min = Number(smartCfg.maxRepliesPer10Min) || 8
    if (state.recentReplyTimestamps.length >= maxPer10Min) {
      logger.info(`[RateLimit] group=${groupId} 10min 已回复 ${state.recentReplyTimestamps.length}/${maxPer10Min} 次，强制 no_action`)
      state.conversationPhase = 'fading'
      state.phaseUntil = Date.now() + (Number(smartCfg.rateLimitCooldownMs) || 300000)
      return false
    }
    state.recentReplyTimestamps.push(Date.now())
    return true
  }

  /**
   * 冷群空窗 deferred timer：仅 phase=cold 时排，按 (threshold-currentEquiv)*avgMs 估算延迟，
   * 到点合成 _smartWaitRerun 事件再跑一轮 Gate。
   * 注意：本函数通常在 inFlight=true 时（主流程 try 块内）被调用，因此**不要**用 inFlight 守卫；
   * 真正的并发保护放在 setTimeout 回调里（callback 触发时再检查 inFlight）。
   */
  scheduleDeferredGateCheck(e, state) {
    const smartCfg = this.config.smartTrigger || {}
    if (smartCfg.deferredGateEnabled === false) return
    if (!e?.group_id) return
    if (state.conversationPhase !== 'cold') return

    if (state.deferredTimer) clearTimeout(state.deferredTimer)

    const talkValue = this.resolveTalkValue(e.group_id)
    const threshold = Math.max(1, Math.ceil(1 / Math.max(0.01, talkValue)))
    const avgMs = this.computeAvgReplyLatency(state) || Number(smartCfg.avgLatencyDefaultMs) || 60000
    const idleMs = Math.max(0, Date.now() - (state.lastMsgAt || Date.now()))
    const currentEquiv = (state.pendingCount || 0) + idleMs / avgMs
    const remaining = Math.max(0, threshold - currentEquiv)

    const minMs = Number(smartCfg.minDeferredMs) || 120000
    const maxMs = Number(smartCfg.maxDeferredMs) || 900000
    const delayMs = Math.max(minMs, Math.min(maxMs, Math.ceil(remaining * avgMs)))

    const groupId = e.group_id
    state.deferredTimer = setTimeout(async () => {
      state.deferredTimer = null
      try {
        const mode = String(this.config?.chatTriggerMode || 'strict').toLowerCase()
        if (mode !== 'smart') return
        if (!isAiConversationEnabled(this.config)) return
        if (!this.checkGroupPermission(e)) return
        if (this.isUserBlacklisted(e)) return
        if (await this.isMutedInGroup(e)) return
        if (state.inFlight) return
        state.forceGateCheck = true
        const wrapped = Object.create(e)
        wrapped._smartWaitRerun = true
        wrapped._deferredReason = 'cold_idle'
        logger.info(`[DeferredGate] group=${groupId} fired delay=${delayMs}ms`)
        await this.handleRandomReplySmart(wrapped)
      } catch (err) {
        logger.error('[DeferredGate] 失败:', err)
      }
    }, delayMs)
    state.deferredTimer.unref?.()
  }

  /**
   * 执行参与复读：直接 e.reply(原文) 跳过 Gate / handleTool（规避 LLM 改写），
   * 仍占用速率配额，但不升 FOCUS（复读不算正常对话参与）。
   * rate limit 已满时返回 false 不复读。
   */
  async joinRepeat(e, state, text) {
    if (!isAiConversationEnabled(this.config)) return false
    const smartCfg = this.config.smartTrigger || {}
    const groupId = e.group_id
    // 复用速率检查（避免和正常回复一起把 bot 刷成复读机）
    const cutoff = Date.now() - 600000
    state.recentReplyTimestamps = (state.recentReplyTimestamps || []).filter(t => t > cutoff)
    const maxPer10Min = Number(smartCfg.maxRepliesPer10Min) || 8
    if (state.recentReplyTimestamps.length >= maxPer10Min) {
      logger.info(`[Repeat] group=${groupId} rate limit 已满 (${state.recentReplyTimestamps.length}/${maxPer10Min}) 放弃复读`)
      return false
    }
    logger.info(`[Repeat] group=${groupId} 参与复读 text="${text.slice(0, 30)}"`)
    // 先发再写 state：避免 e.reply 抛错时 cooldown / rate limit / lastBotReplyAt 等被脏写
    try {
      await this.sendObservedReply(e, text, false, "repeat")
    } catch (err) {
      logger.error('[Repeat] 发送失败:', err)
      return false
    }
    // 发送成功才提交状态变更
    state.recentReplyTimestamps.push(Date.now())
    state.lastRepeatJoinAt = Date.now()
    state.lastBotReplyAt = Date.now()
    state.lastBotReplyKeywords = extractChatKeywords(text, Number(smartCfg.continuationKeywordMaxCount) || 5)
    state.pendingCount = 0
    // 清瞬态标志：复读路径跳过了 continue/wait/no_action 分支，需要显式清掉以免污染下一条消息
    state.forceContinue = false
    state.forceGateCheck = false
    state.lastGateNoActionAt = 0
    return true
  }

  /**
   * 复读检测：看最近 N 条群消息，若至少 minCount 个不同用户发了和当前 e.msg 完全相同的内容，
   * 按 repeatJoinProbability 概率决定 bot 是否参与复读。返回要复读的文本，否则 null。
   * 命中时不走 Gate / handleTool，直接 e.reply 原文，规避 LLM 改写。
   */
  detectGroupRepeat(e, state) {
    const smartCfg = this.config.smartTrigger || {}
    if (smartCfg.repeatJoinEnabled === false) return null

    const text = String(e?.msg || '').trim()
    if (!text) return null
    const maxLen = Number(smartCfg.repeatMaxTextLength) || 30
    if (text.length > maxLen) return null

    const botId = e?.bot?.uin || (typeof Bot !== 'undefined' && Bot.uin)
    const currentUserId = String(e?.user_id || '')
    const window = Math.max(2, Number(smartCfg.repeatDetectionWindow) || 5)
    const recent = (state.recentMessages || []).slice(-window)
    // 统计窗口内（不含当前消息）发过相同文本的不同用户数
    const distinctUsers = new Set()
    for (const m of recent) {
      if (m.text === text && String(m.userId) !== currentUserId) {
        distinctUsers.add(String(m.userId))
      }
    }
    // 当前用户也算一个独立"复读源"
    if (currentUserId) distinctUsers.add(currentUserId)
    // 排除 bot 自己（理论上不该在 recentMessages 里）
    if (botId) distinctUsers.delete(String(botId))

    const minCount = Math.max(2, Number(smartCfg.repeatMinCount) || 3)
    if (distinctUsers.size < minCount) return null

    // 已确认是复读潮（≥minCount 个不同用户在重复），下面任何失败都打日志方便排查
    const groupId = e?.group_id
    const textPreview = text.length > 20 ? text.slice(0, 20) + '...' : text

    // 冷却：避免同一波内反复跟
    const cooldownMs = Number(smartCfg.repeatJoinCooldownMs) || 180000
    const sinceLast = Date.now() - (state.lastRepeatJoinAt || 0)
    if (sinceLast < cooldownMs) {
      const remainSec = Math.ceil((cooldownMs - sinceLast) / 1000)
      logger.info(`[Repeat] group=${groupId} 检测到复读 text="${textPreview}" users=${distinctUsers.size} 但冷却中(剩余${remainSec}s)`)
      return null
    }

    // 通过概率筛选
    const prob = Number(smartCfg.repeatJoinProbability)
    const finalProb = Number.isFinite(prob) ? Math.max(0, Math.min(1, prob)) : 0.6
    if (Math.random() > finalProb) {
      logger.info(`[Repeat] group=${groupId} 检测到复读 text="${textPreview}" users=${distinctUsers.size} 但概率未命中(prob=${finalProb})`)
      return null
    }

    logger.info(`[Repeat] group=${groupId} 检测到复读 text="${textPreview}" users=${distinctUsers.size} 准备参与`)
    return text
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
  async isMutedInGroup(e) {
    if (!e?.group_id) return false
    const cached = mutedStatusCache.get(e.group_id)
    if (cached && Date.now() - cached.at < MUTED_CACHE_TTL_MS) return cached.isMuted

    const nowSec = Math.floor(Date.now() / 1000)
    let isMuted = false
    try {
      const grp = e.group
      if (grp) {
        // ICQQ 风格：剩余秒数 / GroupInfo 字段
        if (Number(grp.mute_left) > 0) isMuted = true
        else {
          const gi = grp.info || grp
          if (Number(gi?.shutup_time_whole) > 0) isMuted = true
          else if (Number(gi?.shutup_time_me) > 0) isMuted = true
          // OneBot v11 / Napcat 风格全员禁言字段（不同实现可能用不同名）
          else if (Number(gi?.group_all_shut) > 0) isMuted = true
          else if (Number(gi?.shut_up_timestamp_whole) > nowSec) isMuted = true
        }
      }
      // 个人禁言：拉自己的 member 信息（昂贵的 RPC，仅在群信息没显示已禁言时调）
      if (!isMuted) {
        const selfId = e.self_id || e.bot?.uin || Bot.uin
        const me = await e.group?.pickMember?.(selfId)?.getInfo?.()
        if (me) {
          if (Number(me.shutup_time) > 0) isMuted = true
          else if (Number(me.shut_up_timestamp) > nowSec) isMuted = true
        }
      }
    } catch {}

    mutedStatusCache.set(e.group_id, { isMuted, at: Date.now() })
    return isMuted
  }

  getSmartState(groupId) {
    let state = trackingChatStates.get(groupId)
    if (!state) {
      // 上限保护：超过 100 个群时按 lastMsgAt 淘汰最旧的群（防长期累积内存膨胀）
      if (trackingChatStates.size >= 100) {
        let oldestId = null
        let oldestAt = Infinity
        for (const [gid, st] of trackingChatStates) {
          if (st.lastMsgAt < oldestAt) { oldestAt = st.lastMsgAt; oldestId = gid }
        }
        if (oldestId != null) {
          const old = trackingChatStates.get(oldestId)
          if (old?.waitTimers) for (const t of old.waitTimers.values()) clearTimeout(t)
          if (old?.deferredTimer) clearTimeout(old.deferredTimer)
          trackingChatStates.delete(oldestId)
        }
      }
      state = {
        pendingCount: 0,
        lastMsgAt: Date.now(),
        replyLatencies: [],
        forceContinue: false,
        forceGateCheck: false,
        lastGateNoActionAt: 0,
        inFlight: false,
        inFlightToken: 0,
        inFlightSince: 0,
        inFlightWatchdog: null,
        needsRerun: false,
        rerunEvent: null,
        queuedWhileInFlight: 0,
        queuedForceGateCheck: false,
        waitTimers: new Map(),
        // 拟人化重构新增字段
        conversationPhase: 'cold',        // 'cold' | 'focus' | 'fading'
        phaseUntil: 0,                    // 当前 phase 自动衰减时间戳
        focusReplyCount: 0,               // 本轮 FOCUS 期 bot 主动回复次数
        consecutiveNoAction: 0,           // FOCUS 期 Gate 连续 no_action 次数
        lastBotReplyAt: 0,                // bot 在该群最近一次发言时间
        lastBotReplyToUserId: null,       // bot 最近一次回复对应的用户，用于判断后续是否同一人接话
        lastBotReplyKeywords: [],         // bot 上次发言提取的关键词（给 continuation R2 用）
        recentReplyTimestamps: [],        // bot 在该群的最近回复时间戳列表（速率限制用）
        recentIncomingTimestamps: [],     // 该群最近群消息时间戳（活跃度统计用）
        recentMessages: [],               // 最近群消息 deque {userId, text, at}，复读检测用
        lastRepeatJoinAt: 0,              // bot 最近一次参与复读的时间（防短期反复跟读）
        deferredTimer: null               // 冷群唤醒定时器
      }
      trackingChatStates.set(groupId, state)
    }
    return state
  }

  getDirectTriggerMergeMs() {
    const smartCfg = this.config.smartTrigger || {}
    const configured = Number(smartCfg.directTriggerMergeMs)
    if (Number.isFinite(configured)) return Math.max(0, Math.min(5000, configured))
    const fallback = Number(smartCfg.replyDebounceMs)
    return Math.max(0, Math.min(5000, Number.isFinite(fallback) ? fallback : 1500))
  }

  getDirectTriggerMergeMaxMessages() {
    const configured = Number(this.config.smartTrigger?.directTriggerMergeMaxMessages)
    if (Number.isFinite(configured)) return Math.max(2, Math.min(20, Math.floor(configured)))
    return 8
  }

  getMergeMsForEvent(e = {}) {
    const availableToolNames = (this.tools || []).map(tool => tool?.function?.name).filter(Boolean)
    return resolveToolRequestMergeMs(e.msg || "", availableToolNames, {
      defaultMs: this.getDirectTriggerMergeMs(),
      fastMs: this.config.smartTrigger?.toolRequestMergeMs
    })
  }

  isMergeableDirectTrigger(e = {}) {
    if (!e?.group_id || !e?.user_id || e?._directTriggerMerged || e?._smartWaitRerun || e?._smartQueuedRerun || e?._proactiveReply) return false
    if (e.forceGrabRedBag || this.isCommand(e)) return false
    if (shouldBypassMergeForExcel(e.msg || "")) return false
    const message = Array.isArray(e.message) ? e.message : []
    return !message.some(seg => ["image", "video", "record", "file"].includes(seg?.type))
  }

  buildMergedDirectTriggerEvent(baseEvent, messages = []) {
    const latest = messages.at(-1)?.event || baseEvent
    const merged = Object.create(latest)
    const textLines = messages
      .map(item => String(item.text || item.event?.msg || "").trim())
      .filter(Boolean)
    const droppedCount = Number(messages.droppedCount) || 0
    const totalCount = textLines.length + droppedCount
    const mergedText = textLines.length > 1
      ? `同一个人连续发了 ${totalCount} 条消息${droppedCount > 0 ? `（这里只保留最后 ${textLines.length} 条）` : ""}：\n${textLines.map((text, index) => `${index + 1}. ${text}`).join("\n")}`
      : textLines.join("\n")
    merged.msg = mergedText
    merged.raw_message = mergedText
    merged.message = [{ type: "text", text: mergedText }]
    merged._directTriggerMerged = true
    merged._mergedMessageCount = totalCount
    merged._mergedRetainedMessageCount = textLines.length
    merged._mergedDroppedMessageCount = droppedCount
    merged._mergedOriginalTexts = textLines
    return merged
  }

  buildMergedDirectTriggerPrompt(e = {}) {
    if (!e?._directTriggerMerged || !e?._mergedMessageCount) return ""
    const count = Number(e._mergedMessageCount) || 0
    const dropped = Number(e._mergedDroppedMessageCount) || 0
    const droppedText = dropped > 0 ? `其中前面 ${dropped} 条较早消息已为防刷屏省略，只保留最后几条。` : ""
    return [
      "【连续点名合并】",
      `同一位群友刚刚连续叫你/触发你 ${count} 次。${droppedText}`,
      "请把这些内容当作同一轮连续发言来理解，只自然回复一次。",
      "不要逐条编号回答，不要提到“合并”“系统”“触发窗口”或内部处理。"
    ].join("\n")
  }

  scheduleMergedDirectTrigger(e, handler, reason = "direct") {
    const mergeMs = this.getMergeMsForEvent(e)
    if (mergeMs <= 0 || !this.isMergeableDirectTrigger(e)) return null

    const key = `${e.group_id}:${e.user_id}`
    const previous = directTriggerMergeTimers.get(key)
    if (previous?.timer) clearTimeout(previous.timer)

    const messages = previous?.messages || []
    messages.push({
      event: e,
      text: stripCqMarkup(e.msg || ""),
      at: Date.now()
    })
    const maxMessages = this.getDirectTriggerMergeMaxMessages()
    let droppedCount = previous?.droppedCount || 0
    while (messages.length > maxMessages) {
      messages.shift()
      droppedCount++
    }
    messages.droppedCount = droppedCount

    const timer = setTimeout(async () => {
      const entry = directTriggerMergeTimers.get(key)
      if (!entry || entry.timer !== timer) return
      directTriggerMergeTimers.delete(key)
      const mergedEvent = this.buildMergedDirectTriggerEvent(e, entry.messages)
      logger.info(`[触发合并] group=${e.group_id} user=${e.user_id} total=${entry.messages.length + (entry.droppedCount || 0)} retained=${entry.messages.length} dropped=${entry.droppedCount || 0} reason=${reason} latest="${summarizeForLog(entry.messages.at(-1)?.text || "")}"`)
      try {
        await handler(mergedEvent)
      } catch (error) {
        logger.error(`[触发合并] 执行失败:`, error)
      }
    }, mergeMs)

    directTriggerMergeTimers.set(key, { timer, messages, droppedCount, reason })
    logger.info(`[触发合并] group=${e.group_id} user=${e.user_id} wait=${mergeMs}ms count=${messages.length} dropped=${droppedCount} reason=${reason} msg="${summarizeForLog(e.msg || "")}"`)
    return false
  }

  isMergeableToolRequest(e = {}) {
    if (!e?.group_id || !e?.user_id || e?._toolRequestMerged || e?._directTriggerMerged || e?._smartWaitRerun || e?._smartQueuedRerun || e?._proactiveReply) return false
    if (e.forceGrabRedBag || this.isCommand(e)) return false
    const text = String(e.msg || "").trim()
    if (!text || isDrawTaskStatusInquiry(text)) return false
    // 每个磁链都是独立下载任务。不要把连续磁链合并后只处理其中一个。
    if (this.isAutomaticTorrentDownloadEvent(e)) return false
    if (shouldBypassMergeForExcel(text)) return false
    const message = Array.isArray(e.message) ? e.message : []
    if (message.some(seg => ["image", "video", "record", "file"].includes(seg?.type))) return false
    return this.isLikelyToolRequestText(text)
  }

  isLikelyToolRequestText(text = "") {
    const content = normalizeIntentText(text)
    if (!content) return false
    return Boolean(
      isImageGenerationRequest(content) ||
      isImageCompositionEditRequest(content) ||
      isImageAnalysisRequest(content) ||
      isRealtimeInfoRequest(content) ||
      isExplicitSearchRequest(content) ||
      isExplicitToolIntent(content) ||
      resolveNaturalDeltaForceToolCall(content) ||
      shouldUseExcelWorkbookTool(content)
    )
  }

  isAutomaticTorrentDownloadEvent(e = {}) {
    if (!e?.group_id || String(e?.user_id || "") === String(e?.self_id || e?.bot?.uin || Bot.uin || "")) return false
    if (this.config?.torrentDownload?.autoDetect === false) return false
    return Boolean(extractValidBtihMagnetUri(e?.msg || ""))
  }

  buildMergedToolRequestEvent(baseEvent, messages = []) {
    const merged = this.buildMergedDirectTriggerEvent(baseEvent, messages)
    merged._toolRequestMerged = true
    return merged
  }

  scheduleMergedToolRequest(e, handler) {
    const mergeMs = this.getMergeMsForEvent(e)
    if (mergeMs <= 0 || !this.isMergeableToolRequest(e)) return null

    const key = `${e.group_id}:${e.user_id}:tool_request`
    const previous = toolRequestMergeTimers.get(key)
    if (previous?.timer) clearTimeout(previous.timer)

    const messages = previous?.messages || []
    messages.push({
      event: e,
      text: stripCqMarkup(e.msg || ""),
      at: Date.now()
    })
    const maxMessages = this.getDirectTriggerMergeMaxMessages()
    let droppedCount = previous?.droppedCount || 0
    while (messages.length > maxMessages) {
      messages.shift()
      droppedCount++
    }
    messages.droppedCount = droppedCount

    const timer = setTimeout(async () => {
      const entry = toolRequestMergeTimers.get(key)
      if (!entry || entry.timer !== timer) return
      toolRequestMergeTimers.delete(key)
      const mergedEvent = this.buildMergedToolRequestEvent(e, entry.messages)
      logger.info(`[工具请求合并] group=${e.group_id} user=${e.user_id} total=${entry.messages.length + (entry.droppedCount || 0)} retained=${entry.messages.length} dropped=${entry.droppedCount || 0} latest="${summarizeForLog(entry.messages.at(-1)?.text || "")}"`)
      try {
        await handler(mergedEvent)
      } catch (error) {
        logger.error(`[工具请求合并] 执行失败:`, error)
      }
    }, mergeMs)

    toolRequestMergeTimers.set(key, { timer, messages, droppedCount })
    logger.info(`[工具请求合并] group=${e.group_id} user=${e.user_id} wait=${mergeMs}ms count=${messages.length} dropped=${droppedCount} msg="${summarizeForLog(e.msg || "")}"`)
    return false
  }

  /**
   * smart 模式触发入口：每条群消息进入此函数，按 talkValue 阈值/空窗补偿/强制覆盖三种条件决定是否调 Timing Gate
   */
  async handleRandomReplySmart(e) {
    if (!isAiConversationEnabled(this.config)) return false
    const groupId = e.group_id
    if (this.isUserBlacklisted(e)) {
      logger.info(`[用户黑名单] smart group=${groupId} user=${e.user_id} msg="${summarizeForLog(e.msg || "")}"`)
      return false
    }
    const state = this.getSmartState(groupId)
    // 记录该群最新消息时间戳给 applyReplyDebounce 用（仅 smart 模式需要，避免 strict 模式持续累积内存）
    const shouldRecordIncoming = !e?._smartWaitRerun && !e?._smartQueuedRerun && !e?._proactiveReply
    const shouldPrefilter = !e?._smartWaitRerun && !e?._proactiveReply
    if (shouldRecordIncoming) {
      const incomingAt = Date.now()
      e._incomingMessageAt = incomingAt
      lastIncomingMsgAt.set(groupId, incomingAt)
      // 活跃度采样移到入口锁外，避免抢锁失败时漏统计（影响 Gate 看到的 5min 消息数）
      state.recentIncomingTimestamps = (state.recentIncomingTimestamps || []).filter(t => t > Date.now() - 300000)
      state.recentIncomingTimestamps.push(Date.now())
      // 复读检测用的最近消息 deque（保留最近 10 条文本）
      const repeatText = (typeof e?.msg === 'string' ? e.msg : '').trim()
      if (repeatText) {
        state.recentMessages = (state.recentMessages || []).slice(-9)
        state.recentMessages.push({ userId: e.user_id, text: repeatText, at: Date.now() })
      }
      // 轻量上下文状态：话题关键词 + 人际互动边（Gate 与主链路共用，零模型调用）
      if (this.config?.groupContextState?.topicEnabled !== false && repeatText) {
        updateGroupTopic({ groupId, text: repeatText })
      }
      if (this.config?.groupContextState?.socialEnabled !== false) {
        updateGroupSocial({
          groupId,
          fromUserId: e.user_id,
          atTargetIds: collectMentionTargetIds(e, e?.bot?.uin || Bot.uin),
          replyToUserId: (() => { try { return getReplySender(e?.source || e?.reply) || "" } catch { return "" } })()
        })
      }
    }
    // 入口锁：该群已经有一个 handleRandomReplySmart 正在跑（Gate / debounce / handleTool 任一阶段）→ 让步本条
    // 必须在任何 await 之前同步检查并 set，防止 await checkTriggers 期间多个调用并发通过
    if (state.inFlight) {
      state.queuedWhileInFlight = (state.queuedWhileInFlight || 0) + 1
      state.lastMsgAt = Date.now()
      state.needsRerun = true
      if (e?._smartWaitRerun) state.queuedForceGateCheck = true
      const smartCfg = this.config.smartTrigger || {}
      const allowDirectTrigger = !e?._smartWaitRerun
      const hasQueuedTrigger = allowDirectTrigger && this.checkTriggers(e)
      const botName = Bot.nickname
      const hasQueuedNameMention = allowDirectTrigger && smartCfg.mentionedNameReply && e.msg &&
        botName && String(e.msg).toLowerCase().includes(String(botName).toLowerCase())
      if ((hasQueuedTrigger && smartCfg.inevitableAtReply !== false) || hasQueuedNameMention || e?._proactiveReply) {
        state.forceContinue = true
        state.rerunEvent = e
      } else if (!state.forceContinue) {
        state.rerunEvent = e
      }
      logger.info(`[SmartQueue] group=${groupId} inFlight=true queued=${state.queuedWhileInFlight} user=${e?.user_id || ''} msg="${String(e?.msg || '').slice(0, 30)}"`)
      return false
    }
    state.inFlight = true
    const smartLockToken = ++smartLockTokenCounter
    state.inFlightToken = smartLockToken
    state.inFlightSince = Date.now()
    this.scheduleSmartLockWatchdog(state)
    try {
      // 先记录上一条消息时间用于空窗补偿（要在 lastMsgAt 被本次更新覆盖之前取出）
      const prevLastMsgAt = state.lastMsgAt || Date.now()
      const queuedCount = Math.max(0, Number(state.queuedWhileInFlight) || 0)
      state.queuedWhileInFlight = 0
      const pendingDelta = e?._smartQueuedRerun ? Math.max(1, queuedCount) : 1 + queuedCount
      state.pendingCount += pendingDelta
      state.lastMsgAt = Date.now()

      const smartCfg = this.config.smartTrigger || {}
      const allowDirectTrigger = !e?._smartWaitRerun

      if (e?._smartWaitRerun) {
        state.forceContinue = false
        state.forceGateCheck = true
      } else if (e?._smartQueuedGateCheck) {
        state.forceGateCheck = true
      }

      if (allowDirectTrigger && e?._proactiveReply) {
        state.forceContinue = true
      }

      // ─── 本地预筛（仅对真实新消息生效）─────────────────────────
      let prefilter = { kind: 'regular', reason: '' }
      if (shouldPrefilter) {
        prefilter = this.prefilterMessage(e, state)
        if (prefilter.kind === 'addressed_other' || prefilter.kind === 'empty_content' || prefilter.kind === 'bot_self_echo' || prefilter.kind === 'likely_addressed_other') {
          // 回滚刚才计入的 pendingCount（这些消息不应推动触发阈值）
          state.pendingCount = Math.max(0, state.pendingCount - pendingDelta)
          logger.info(`[Prefilter] group=${groupId} skip kind=${prefilter.kind} reason=${prefilter.reason}`)
          // 顺手排个 cold 兜底（如果当前是 cold 状态）
          this.scheduleDeferredGateCheck(e, state)
          return false
        }
        if (prefilter.kind === 'continuation_strong') {
          if (prefilter.reason === 'R0_same_user_followup' || prefilter.reason === 'at_bot' || prefilter.reason === 'reply_bot') {
            state.forceContinue = true
          } else {
            state.forceGateCheck = true
          }
          logger.info(`[Prefilter] group=${groupId} continuation_strong reason=${prefilter.reason}`)
        }
        // 复读检测：命中且通过概率 → 跳过 Gate 直接复读原文。
        // 但 force 路径（_proactiveReply / @bot / 触发前缀 / 名字提及）必须走正常 LLM 流程，
        // 因为用户明确指名 bot 时只复读一个 "+1" 体验很差。
        const hasForceSignal = state.forceContinue
          || this.checkTriggers(e)
          || (smartCfg.mentionedNameReply && e.msg && Bot.nickname &&
              String(e.msg).toLowerCase().includes(String(Bot.nickname).toLowerCase()))
        if (!hasForceSignal) {
          const repeatText = this.detectGroupRepeat(e, state)
          if (repeatText) {
            return await this.joinRepeat(e, state, repeatText)
          }
        }
      }

      // 强制覆盖：@/触发前缀
      const hasTrigger = await this.checkTriggers(e)
      if (allowDirectTrigger && hasTrigger && smartCfg.inevitableAtReply !== false) {
        state.forceContinue = true
      }
      // 名字提及（非 @）
      if (allowDirectTrigger && !state.forceContinue && smartCfg.mentionedNameReply && e.msg) {
        const botName = Bot.nickname
        if (botName && String(e.msg).toLowerCase().includes(String(botName).toLowerCase())) {
          state.forceContinue = true
        }
      }

      // ─── 对话焦点状态机：决定本条是否强制走 Gate / 阈值是否减半 ──
      const phase = this.resolveConversationPhase(state)
      if (phase === 'focus' && prefilter.kind === 'continuation_strong') {
        state.forceGateCheck = true
      } else if (phase === 'fading' && smartCfg.fadingForceGate === true && prefilter.kind === 'continuation_strong') {
        // 用户选择激进策略：FADING 期也强制走 Gate
        state.forceGateCheck = true
      }

      // 冷却检查：no_action 后短时间内不再请求 Gate（强制覆盖可绕过）
      const rawCooldownValue = smartCfg.timingGateCooldownSeconds
      const rawCooldownSeconds = rawCooldownValue === undefined || rawCooldownValue === null || rawCooldownValue === ''
        ? NaN
        : Number(rawCooldownValue)
      const cooldownSeconds = Number.isFinite(rawCooldownSeconds) ? rawCooldownSeconds : 8
      const cooldownMs = Math.max(0, cooldownSeconds) * 1000
      if (!state.forceContinue && !state.forceGateCheck && cooldownMs > 0 && Date.now() - state.lastGateNoActionAt < cooldownMs) {
        logger.info(`[SmartSkip] group=${groupId} reason=gate_cooldown pending=${state.pendingCount} cooldownMs=${cooldownMs} msg="${summarizeForLog(e?.msg || "")}"`)
        return false
      }

      // 阈值判定（fading 期半阈值，仅作用于"非 force"路径）
      const talkValue = this.resolveTalkValue(groupId)
      const rawThreshold = Math.max(1, Math.ceil(1 / Math.max(0.01, talkValue)))
      const threshold = phase === 'fading'
        ? Math.max(1, Math.floor(rawThreshold / 2))
        : rawThreshold
      const reachThreshold = state.pendingCount >= threshold
      const idleHit = this.idleCompensationMet(state, threshold, prevLastMsgAt)
      if (!state.forceContinue && !state.forceGateCheck && !reachThreshold && !idleHit) {
        logger.info(`[SmartSkip] group=${groupId} reason=below_threshold phase=${phase} pending=${state.pendingCount}/${threshold} talkValue=${talkValue} idleHit=${idleHit} msg="${summarizeForLog(e?.msg || "")}"`)
        // 冷群兜底：phase=cold 且未达阈值时排 deferred timer，让 bot 在合适时机自己跑一轮 Gate
        this.scheduleDeferredGateCheck(e, state)
        return false
      }

      let gateResult
      try {
        // 强制继续路径直接放行，跳过 Gate；强制 Gate 路径仍交给 Gate 判断是否补一句
        if (state.forceContinue) {
          gateResult = { decision: 'continue', reason: 'force', __forceContinue: true }
        } else {
          gateResult = await this.runTimingGate(e, state, { phase, prefilter, threshold })
        }
      } catch (err) {
        logger.error(`[TimingGate] 调用失败:`, err)
        gateResult = { decision: 'no_action', reason: 'error' }
      }

      const decision = gateResult?.decision || 'no_action'
      logger.info(`[TimingGate] group=${groupId} decision=${decision} phase=${phase} pending=${state.pendingCount}/${threshold} forceContinue=${state.forceContinue} forceGate=${state.forceGateCheck} reason=${gateResult?.reason || ''}`)

      if (decision === 'continue') {
        const wasForced = gateResult?.__forceContinue === true
        if (wasForced && !e?._directTriggerMerged) {
          const scheduled = this.scheduleMergedDirectTrigger(e, async mergedEvent => {
            await this.handleRandomReplySmart(mergedEvent)
          }, 'smart_force')
          if (scheduled === false) return false
        }
        // 速率硬上限（force 路径不受限但仍记录时间戳，保证 rate limit 统计准确）
        if (!wasForced) {
          if (!this.applyRateLimitGuard(state, groupId)) {
            logger.info(`[SmartSkip] group=${groupId} reason=rate_limit pending=${state.pendingCount} msg="${summarizeForLog(e?.msg || "")}"`)
            state.pendingCount = 0
            state.forceContinue = false
            state.forceGateCheck = false
            return false
          }
        } else {
          // force 路径直接 push 时间戳，跳过上限检查
          state.recentReplyTimestamps = (state.recentReplyTimestamps || []).filter(t => t > Date.now() - 600000)
          state.recentReplyTimestamps.push(Date.now())
        }
        state.pendingCount = 0
        state.forceContinue = false
        state.forceGateCheck = false
        state.lastGateNoActionAt = 0
        state.consecutiveNoAction = 0
        // 进入 / 续命 FOCUS（非 force 路径计入 focusReplyCount）
        const focusDurationMs = Number(smartCfg.focusDurationMs) || 180000
        const prevPhase = state.conversationPhase
        state.conversationPhase = 'focus'
        state.phaseUntil = Date.now() + focusDurationMs
        // force 路径升回 focus 时视为"新一轮"，重置 focusReplyCount（避免立即又被上限拦截）
        if (wasForced && prevPhase !== 'focus') {
          state.focusReplyCount = 0
        }
        if (!wasForced) {
          state.focusReplyCount = (state.focusReplyCount || 0) + 1
          const maxFocusReplies = Number(smartCfg.focusMaxReplies) || 4
          if (state.focusReplyCount >= maxFocusReplies) {
            // 达上限：本次允许回，但之后立刻降级 FADING 防连刷
            state.conversationPhase = 'fading'
            state.phaseUntil = Date.now() + (Number(smartCfg.fadingDurationMs) || 90000)
            logger.info(`[Phase] group=${groupId} focusMaxReplies(${maxFocusReplies}) 达上限，本次回复后降级 fading`)
          }
        }
        // 标记本条为"主动搭话"（非 @/前缀触发），让 sendSegmentedMessage 决定要不要去掉引用
        if (!wasForced) markProactiveReply(e, e?._incomingMessageAt || lastIncomingMsgAt.get(groupId) || Date.now())
        state.lastBotReplyToUserId = e?.user_id ? String(e.user_id) : null
        // force 路径（@/名字提及/proactive 等"必回"场景）跳过 debounce 立即回复；其余先 debounce 看有没有新消息
        if (!wasForced && !(await this.applyReplyDebounce(e))) {
          logger.info(`[SmartSkip] group=${groupId} reason=debounce_interrupted phase=${phase} msg="${summarizeForLog(e?.msg || "")}"`)
          // 让步后回滚 focusReplyCount（这次实际没回复）
          if (!wasForced) state.focusReplyCount = Math.max(0, (state.focusReplyCount || 0) - 1)
          // 同时回滚 rate limit 计数
          state.recentReplyTimestamps = (state.recentReplyTimestamps || []).slice(0, -1)
          return false
        }
        const longTaskPolicy = resolveLongTaskFeedbackPolicy(String(e?.msg || ""))
        if (longTaskPolicy?.releaseSmartLock === true) {
          e._longRunningToolTask = true
          logger.info(`[SmartLock] group=${groupId} 长耗时任务(${longTaskPolicy.kind})释放 smart 锁，后续消息可继续判断`)
          this.releaseSmartInFlight(state, e, smartLockToken)
        }
        e._triggerContext = { mode: "smart_gate", gateDecision: "continue", gateReason: gateResult?.reason || "", phase }
        return await this.handleTool(e)
      }
      if (decision === 'wait') {
        const sec = Math.max(1, Math.min(60, Number(gateResult.wait_seconds) || 5))
        state.pendingCount = 0
        state.forceContinue = false
        state.forceGateCheck = false
        state.consecutiveNoAction = 0   // wait 不是冷漠，清零计数避免跨 wait 累积误降级
        this.scheduleWaitReply(e, sec, 'gate_wait')
        return false
      }
      // no_action
      logger.info(`[SmartSkip] group=${groupId} reason=gate_no_action phase=${phase} pending=${state.pendingCount} gateReason=${gateResult?.reason || ""} msg="${summarizeForLog(e?.msg || "")}"`)
      state.lastGateNoActionAt = Date.now()
      state.pendingCount = 0
      state.forceContinue = false
      state.forceGateCheck = false
      // FOCUS 内累计 no_action，超过 focusMaxNoAction 就降级 FADING
      if (state.conversationPhase === 'focus') {
        state.consecutiveNoAction = (state.consecutiveNoAction || 0) + 1
        const maxNoAction = Number(smartCfg.focusMaxNoAction) || 2
        if (state.consecutiveNoAction >= maxNoAction) {
          state.conversationPhase = 'fading'
          state.phaseUntil = Date.now() + (Number(smartCfg.fadingDurationMs) || 90000)
          state.consecutiveNoAction = 0
          logger.info(`[Phase] group=${groupId} Gate 连续 ${maxNoAction} 次 no_action，降级 fading`)
        }
      }
      return false
    } finally {
      this.releaseSmartInFlight(state, e, smartLockToken)
    }
  }

  shouldReleaseSmartLockForLongTask(e = {}) {
    return resolveLongTaskFeedbackPolicy(String(e?.msg || ""))?.releaseSmartLock === true
  }

  releaseSmartInFlight(state, e, expectedToken) {
    if (!state) return
    // 看门狗强制释放（或长任务提前释放）后锁可能已交给新轮次；旧轮次的 finally 不得误释放
    if (expectedToken !== undefined && state.inFlightToken !== expectedToken) return
    clearSmartLockWatchdog(state)
    state.inFlight = false
    if (!state.needsRerun) return

    const rerunEvent = state.rerunEvent || e
    const queuedForceGateCheck = !!state.queuedForceGateCheck
    state.needsRerun = false
    state.rerunEvent = null
    state.queuedForceGateCheck = false
    const wrappedRerun = Object.create(rerunEvent)
    wrappedRerun._smartQueuedRerun = true
    if (queuedForceGateCheck) wrappedRerun._smartQueuedGateCheck = true
    this.handleRandomReplySmart(wrappedRerun).catch(err => logger.error('[TimingGate] 重跑失败:', err))
  }

  getSmartLockTimeoutMs() {
    const raw = this.config?.smartTrigger?.smartLockTimeoutMs
    const value = raw === undefined || raw === null || raw === '' ? NaN : Number(raw)
    return Number.isFinite(value) ? Math.max(0, value) : 180000
  }

  scheduleSmartLockWatchdog(state) {
    armSmartLockWatchdog(state, {
      timeoutMs: this.getSmartLockTimeoutMs(),
      logger,
      onForceRelease: () => this.releaseSmartInFlight(state, null, state.inFlightToken)
    })
  }

  /**
   * 调用 Timing Gate 子代理，返回 { decision: 'continue'|'no_action'|'wait', wait_seconds?, reason? }
   * @param ctx 额外上下文：{ phase, prefilter, threshold }
   */
  async runTimingGate(e, state, ctx = {}) {
    const smartCfg = this.config.smartTrigger || {}
    const ctxSize = Math.max(5, Math.min(100, Number(smartCfg.gateContextSize) || 20))
    const botName = Bot.nickname || '机器人'

    let history = ''
    try {
      history = await this.messageManager.formatMessageHistory('group', e.group_id, ctxSize)
    } catch { history = '(无)' }

    // Gate 子代理复用 trackAiConfig（同样是"轻量 LLM 决策回不回话"用途，不再单独配置一份模型）
    const trackCfg = this.config.trackAiConfig
    const useCfg = {
      url: trackCfg?.trackAiUrl,
      model: trackCfg?.trackAiModel || 'gpt-4o-mini',
      apikey: trackCfg?.trackAiApikey
    }
    if (!useCfg.url || !useCfg.apikey || String(useCfg.apikey).startsWith('sk-xxxxx')) {
      return { decision: 'no_action', reason: 'no_api_config' }
    }

    // ─── 多维信号采集 ─────────────────────────────────────
    const phase = ctx.phase || state.conversationPhase || 'cold'
    const prefilterKind = ctx.prefilter?.kind || 'regular'
    const prefilterReason = ctx.prefilter?.reason || ''
    const recentReplyCount = (state.recentReplyTimestamps || []).filter(t => t > Date.now() - 600000).length
    const groupMsgRate5min = this.computeGroupMsgRate5min(state)
    const sinceLastBotReplySec = state.lastBotReplyAt
      ? Math.max(0, Math.floor((Date.now() - state.lastBotReplyAt) / 1000))
      : -1
    const sinceLastMsgSec = state.lastMsgAt
      ? Math.max(0, Math.floor((Date.now() - state.lastMsgAt) / 1000))
      : 0
    const now = new Date()
    const hh = now.getHours()
    const hhmm = `${String(hh).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    const isLateNight = hh >= 23 || hh < 6
    // 是否 @ 别人 / 引用 bot
      let addressedToOther = false
      let currentMsgQuotesBot = false
      let atBot = false
      try {
        const botId = e?.bot?.uin || Bot.uin
        currentMsgQuotesBot = messageQuotesUser(e, botId)
        if (Array.isArray(e?.message)) {
          for (const seg of e.message) {
            if (seg?.type === 'at' && String(getMentionTargetId(seg)) === String(botId)) atBot = true
            if (seg?.type === 'at' && String(getMentionTargetId(seg)) !== String(botId)) addressedToOther = true
            if (seg?.type === 'reply') {
              // 部分协议端会附带被回复消息的 sender 信息
              const repliedUid = getReplySender(seg)
              if (repliedUid && String(repliedUid) === String(botId)) currentMsgQuotesBot = true
            }
          }
        }
      if (!atBot) atBot = messageMentionsUser(e, botId)
    } catch {}
    const currentText = String(e?.msg || '')
    const mentionsBotName = hasBotTextAnchor(currentText, botName, this.config.triggerPrefixes)
    const sameUserAsLastReply = state.lastBotReplyToUserId && String(e?.user_id || '') === String(state.lastBotReplyToUserId)
    // 触发决策与主链路共享同一份人设与对象信号：Gate 判断"要不要回"，主链路判断"回给谁"，口径必须一致
    const addresseeSignal = computeAddresseeSignal({
      e,
      botId: e?.bot?.uin || Bot.uin,
      mentionsBotName,
      quotesBot: currentMsgQuotesBot,
      sameUserAsLastReply,
      prefilterKind
    })
    const { groupAddressed, targetKind, pronounWithoutBotAnchor } = addresseeSignal
    const triggerReason = e?._deferredReason
      ? 'deferred'
      : (prefilterKind === 'continuation_strong' ? `continuation_strong(${prefilterReason})` : 'regular')

    const promptHintBusyGroupRate = Number(smartCfg.promptHintBusyGroupRate) || 30
    const promptHintRateLimitWarn = Number(smartCfg.promptHintRateLimitWarn) || 5

    const gatePersonaTone = buildPersonaTonePrompt({
      userText: currentText,
      persona: this.config.persona
    })
    const systemPrompt = `你是 QQ 群聊节奏判断助手。机器人名字叫"${botName}"。
当前北京时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}
你需要判断 ${botName} 是否应该现在插话、保持沉默、或稍后再说。

**总原则：默认旁听，只有高置信度确认当前消息在对 ${botName} 说、引用 ${botName}、延续 ${botName} 刚说的话，或强相关到不接会显得突兀时，才 continue。**
克制优先。普通群友之间互相聊天时，即使内容有趣、出现"你"、正在玩梗，也默认 no_action。不要为了显得活跃而找理由插话。

判断指引：
- continue：目标对象=bot；被 @/点名；当前消息明确叫了 ${botName}；引用了 ${botName} 的消息；同一个用户正在追问 ${botName} 刚说过的内容；有人直接问 ${botName} 的身份/状态/意见；明确请求 ${botName} 做事。
- no_action：目标对象=other；没有叫 ${botName}；只是群友之间聊天；"你"明显可能指别人；只是普通玩梗/复读/吐槽；${botName} 只是看得懂但不是被问到；同一话题 ${botName} 刚回过应该让别人说。
- wait：用户句子像是没说完，或者 ${botName} 刚被叫到但对方可能还在补充。

时段倾向：任何时段都默认克制；深夜（23:00-06:00）更倾向 no_action。

【信号判断指引】
- 看到"⚠ @ 了别人"信号：除非该消息内容显然是普遍话题（如"大家觉得..."），否则倾向 no_action
- 看到"目标对象=group"：这是全群问题或公共话题，可以谨慎判断是否插话；只有 ${botName} 能自然帮上或补充时才 continue
- 看到"目标对象=unknown"：默认 no_action，除非近期上下文强烈表明在说 ${botName}
- 看到"目标对象=other"：必须 no_action
- 看到"焦点=focus"不等于一定接话；只有当前消息明确回应 ${botName} 或引用/点名 ${botName}，才倾向 continue
- 看到"最近 10 分钟已回复 ≥${promptHintRateLimitWarn} 次"：除非被点名，倾向 no_action（避免刷屏）
- 看到"群最近 5 分钟消息数 ≥ ${promptHintBusyGroupRate}"：群友正在热聊，默认 no_action，除非明确叫 ${botName}
- 看到"触发原因=deferred"：这是定时自检，群里没新消息或 ${botName} 刚开了话头还没人接；只在非常合适时主动补一句，否则 no_action
- 看到"触发原因=continuation_strong"且消息明显在向 ${botName} 提问/反馈：可以 continue；如果只是相关词命中但没有对 ${botName} 说，仍然 no_action
- 没有明确"应该插"的理由时，必须 no_action

${gatePersonaTone ? `\n${gatePersonaTone}\n` : ""}
只返回严格的 JSON，格式：{"decision":"continue|no_action|wait","wait_seconds":3,"reason":"简短理由"}
wait 时 wait_seconds 取 3-15 之间。不要任何其他文字、不要 markdown、不要代码块包装。`

    const specialSignals = []
    if (addressedToOther) specialSignals.push('⚠ 当前消息 @ 了别人，谨慎插话')
    if (currentMsgQuotesBot) specialSignals.push(`✓ 当前消息引用了 ${botName} 的某条消息`)
    const specialSignalsBlock = specialSignals.length ? `\n【特殊信号】\n${specialSignals.join('\n')}\n` : ''

    const userPrompt = `【近期群聊记录】
${history}

【当前消息】
${e.sender?.card || e.sender?.nickname || '用户'}: ${e.msg || ''}

【时间与活跃度】
- 距上一条群消息：${sinceLastMsgSec}s
- 距 ${botName} 上一次发言：${sinceLastBotReplySec >= 0 ? sinceLastBotReplySec + 's' : '长时间未发言'}
- ${botName} 最近 10 分钟在本群已回复：${recentReplyCount} 次
- 群最近 5 分钟消息数：${groupMsgRate5min}
- 当前时段：${hhmm}（${isLateNight ? '深夜' : '日间'}）

${getGroupTopicPrompt(e?.group_id) ? "\n【群话题】" + getGroupTopicPrompt(e?.group_id).replace("【群话题】", "") : ""}
${getGroupSocialPrompt(e?.group_id)}
【对话状态】
- 当前焦点：${phase}（focus=刚参与话题中；fading=余热；cold=未参与）
- 触发原因：${triggerReason}
- 明确 @ ${botName}：${atBot ? '是' : '否'}
- 文本点名 ${botName}：${mentionsBotName ? '是' : '否'}
- 引用了 ${botName} 的消息：${currentMsgQuotesBot ? '是' : '否'}
- 是否同一用户接续 ${botName} 上次回复：${sameUserAsLastReply ? '是' : '否'}
- 当前消息目标对象：${targetKind}
- 文本含"你"但没有任何 ${botName} 指向锚点：${pronounWithoutBotAnchor ? '是，默认认为在对别人说' : '否'}
${specialSignalsBlock}
请输出 JSON 决策。`

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 15000)
    try {
      const response = await fetch(useCfg.url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${useCfg.apikey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: useCfg.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.3
        }),
        signal: controller.signal
      })
      if (!response.ok) {
        const errorText = await response.text().catch(() => '')
        logger.warn(`[TimingGate] 请求失败 group=${e?.group_id || ''} status=${response.status} body=${errorText.slice(0, 240)}`)
        return { decision: 'no_action', reason: `http_${response.status}` }
      }
      const data = await response.json()
      const raw = data?.choices?.[0]?.message?.content?.trim() || ''
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        logger.warn(`[TimingGate] 返回非JSON group=${e?.group_id || ''} raw=${raw.slice(0, 240)}`)
        return { decision: 'no_action', reason: 'no_json' }
      }
      const parsed = JSON.parse(jsonMatch[0])
      const dec = String(parsed.decision || '').toLowerCase()
      if (!['continue', 'no_action', 'wait'].includes(dec)) {
        logger.warn(`[TimingGate] 非法decision group=${e?.group_id || ''} decision=${parsed.decision}`)
        return { decision: 'no_action', reason: 'invalid_decision' }
      }
      return {
        decision: dec,
        wait_seconds: Number(parsed.wait_seconds) || 5,
        reason: String(parsed.reason || '').slice(0, 80)
      }
    } catch (err) {
      logger.warn(`[TimingGate] 异常 group=${e?.group_id || ''}: ${err.message}`)
      return { decision: 'no_action', reason: `exception:${err.message}` }
    } finally {
      clearTimeout(timeoutId)
    }
  }

  /**
   * 回复 debounce：等待 replyDebounceMs 看群里是否有新消息进来；
   * 有新消息且未到 maxConsecutiveInterrupts 上限 → 让步本轮（return false）；
   * 否则放行（return true）。force 路径应在调用方跳过本检查。
   */
  async applyReplyDebounce(e) {
    const debounceMs = Math.max(0, Number(this.config.smartTrigger?.replyDebounceMs) || 0)
    if (debounceMs <= 0 || !e?.group_id) return true
    const debounceStartAt = Date.now()
    await new Promise(r => setTimeout(r, debounceMs))
    const newestAt = lastIncomingMsgAt.get(e.group_id) || 0
    if (newestAt > debounceStartAt) {
      const max = Math.max(0, Number(this.config.smartTrigger?.maxConsecutiveInterrupts) || 0)
      const cur = (consecutiveInterrupts.get(e.group_id) || 0) + 1
      if (max === 0 || cur <= max) {
        consecutiveInterrupts.set(e.group_id, cur)
        logger.info(`[Debounce] group=${e.group_id} 检测到新消息打断，让步本轮 (${cur}/${max || '∞'})`)
        return false
      }
      logger.info(`[Debounce] group=${e.group_id} 连续打断达上限 ${max} 次，强制走完不让步`)
      consecutiveInterrupts.set(e.group_id, 0)
      return true
    }
    consecutiveInterrupts.set(e.group_id, 0)
    return true
  }

  /**
   * 解析 talkValue：优先用时段化规则，否则用全局 talkValue
   */
  resolveTalkValue(groupId) {
    const s = this.config.smartTrigger || {}
    const fallback = Number(s.talkValue) || 1.0
    if (!s.enableTalkValueRules || !Array.isArray(s.talkValueRules) || s.talkValueRules.length === 0) {
      return fallback
    }
    const now = new Date()
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    for (const rule of s.talkValueRules) {
      const range = String(rule?.range || '').trim()
      const [start, end] = range.split('-').map(x => x?.trim())
      if (!start || !end) continue
      const inRange = (start <= end && hhmm >= start && hhmm <= end) ||
                      (start > end && (hhmm >= start || hhmm <= end))
      if (inRange) {
        const v = Number(rule.value)
        if (Number.isFinite(v) && v > 0) return v
      }
    }
    return fallback
  }

  /**
   * 空窗补偿：冷群按 idle/avg_latency 折算"等效消息数"，凑够阈值就触发
   * @param state - 该群的 SmartState
   * @param threshold - 当前阈值（ceil(1/talkValue)）
   * @param prevLastMsgAt - 上一条消息的时间戳（本次入口前的值，必须由调用方传入，否则 idle=0 永远不命中）
   */
  idleCompensationMet(state, threshold, prevLastMsgAt) {
    const s = this.config.smartTrigger || {}
    if (!s.idleCompensationEnabled) return false
    const avgMs = this.computeAvgReplyLatency(state) || Number(s.avgLatencyDefaultMs) || 60000
    if (avgMs <= 0) return false
    const idleMs = Math.max(0, Date.now() - (prevLastMsgAt || Date.now()))
    return state.pendingCount + idleMs / avgMs >= threshold
  }

  /**
   * 计算最近 10 分钟平均回复延迟（毫秒）
   */
  computeAvgReplyLatency(state) {
    if (!state?.replyLatencies?.length) return 0
    const cutoff = Date.now() - 600000
    state.replyLatencies = state.replyLatencies.filter(item => item.at >= cutoff)
    if (!state.replyLatencies.length) return 0
    const sum = state.replyLatencies.reduce((acc, item) => acc + item.ms, 0)
    return sum / state.replyLatencies.length
  }

  /**
   * 记录一次"用户消息→bot 回复"的延迟，给空窗补偿用。两种模式都调用。
   */
  recordReplyLatency(groupId, latencyMs) {
    if (!groupId || !Number.isFinite(latencyMs) || latencyMs <= 0) return
    const state = this.getSmartState(groupId)
    state.replyLatencies.push({ at: Date.now(), ms: latencyMs })
    if (state.replyLatencies.length > 50) state.replyLatencies = state.replyLatencies.slice(-50)
  }

  /**
   * 安排 N 秒后强制再触发一轮 Gate，让 LLM 决定要不要补一句（wait 工具/Gate wait 决策共用）
   */
  scheduleWaitReply(e, seconds, reason) {
    const groupId = e.group_id
    if (!groupId) {
      logger.warn(`[WaitTool] 私聊场景暂不支持自动续话: user=${e.user_id}`)
      return
    }
    const state = this.getSmartState(groupId)
    const userKey = `${groupId}_${e.user_id}`
    const old = state.waitTimers.get(userKey)
    if (old) clearTimeout(old)

    const timer = setTimeout(async () => {
      state.waitTimers.delete(userKey)
      // 触发时再次校验：模式可能已切回 strict、bot 可能已被禁言、群可能已退出白名单
      const mode = String(this.config?.chatTriggerMode || 'strict').toLowerCase()
      if (mode !== 'smart') {
        logger.info(`[WaitTool] group=${groupId} 已切出 smart 模式，取消续话`)
        return
      }
      if (!this.checkGroupPermission(e)) {
        logger.info(`[WaitTool] group=${groupId} 不在白名单，取消续话`)
        return
      }
      if (this.isUserBlacklisted(e)) {
        logger.info(`[WaitTool] group=${groupId} user=${e.user_id} 命中用户黑名单，取消续话`)
        return
      }
      if (await this.isMutedInGroup(e)) {
        logger.info(`[WaitTool] group=${groupId} 被禁言，取消续话`)
        return
      }
      state.forceContinue = false
      state.forceGateCheck = true
      logger.info(`[WaitTool] group=${groupId} user=${e.user_id} fired after ${seconds}s reason=${reason || ''}`)
      try {
        const wrapped = Object.create(e)
        wrapped._smartWaitRerun = true
        await this.handleRandomReplySmart(wrapped)
      } catch (err) {
        logger.error(`[WaitTool] 续话失败:`, err)
      }
    }, seconds * 1000)
    state.waitTimers.set(userKey, timer)
  }

  /**
   * 外部插件主动触发：注入 intent 到群历史 + 强制下一轮 Gate continue
   * @param {string|number} groupId
   * @param {string} intent 主动想说的话题/意图
   * @param {object} opts { source: '插件名', anchorE: 可选锚点 e }
   */
  async enqueueProactiveTask(groupId, intent, opts = {}) {
    if (!isAiConversationEnabled(this.config)) {
      logger.info('[Proactive] 插件总开关已关闭，取消续话')
      return { ok: false, error: 'plugin_disabled' }
    }
    if (!groupId || !intent) return { ok: false, error: 'missing_params' }
    const anchor = opts.anchorE
    if (!anchor) {
      logger.warn(`[Proactive] group=${groupId} 缺少锚点 e，无法触发；intent="${String(intent).slice(0, 40)}"`)
      return { ok: false, error: 'missing_anchor' }
    }
    if (String(anchor.group_id) !== String(groupId)) {
      logger.warn(`[Proactive] anchor.group_id(${anchor.group_id}) 与传入 groupId(${groupId}) 不匹配，拒绝触发`)
      return { ok: false, error: 'anchor_group_mismatch' }
    }
    if (!this.checkGroupPermission(anchor)) {
      return { ok: false, error: 'not_whitelisted' }
    }
    if (this.isUserBlacklisted(anchor)) {
      return { ok: false, error: 'user_blacklisted' }
    }
    if (await this.isMutedInGroup(anchor)) {
      return { ok: false, error: 'muted' }
    }

    logger.info(`[Proactive] group=${groupId} source=${opts.source || 'unknown'} intent="${String(intent).slice(0, 40)}"`)
    try {
      const wrapped = Object.create(anchor)
      wrapped.msg = `[系统主动触发 来自 ${opts.source || '插件'}] ${intent}`
      const mode = String(this.config?.chatTriggerMode || 'strict').toLowerCase()
      if (mode === 'smart') {
        const state = this.getSmartState(groupId)
        state.forceContinue = true
        markProactiveReply(wrapped, lastIncomingMsgAt.get(groupId) || Date.now())
        setImmediate(() => this.handleRandomReplySmart(wrapped).catch(err => logger.error('[Proactive] 处理失败:', err)))
      } else {
        // strict 模式没有 Gate，直接走 handleTool（绕过 @/前缀破冰）
        setImmediate(() => this.handleTool(wrapped).catch(err => logger.error('[Proactive] 处理失败:', err)))
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }

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
    return `${groupId}:${messageId}`
  }

  getTaskStatusRedisKey(groupId, messageId) {
    return `${this.TASK_STATUS_PREFIX}${groupId}:${messageId}`
  }

  getActiveToolTaskCacheKey(groupId, userId, toolName) {
    return `${groupId}:${userId}:${toolName}`
  }

  getActiveToolTaskRedisKey(groupId, userId, toolName) {
    return `${this.ACTIVE_TOOL_TASK_PREFIX}${groupId}:${userId}:${toolName}`
  }

  getTaskStatusTtlSeconds() {
    return Math.max(60, Math.floor((this.config.groupChatMemoryDays || 1) * 24 * 60 * 60))
  }

  async saveTaskStatus({ groupId, userId, messageId, status, toolName = "", error = "" }) {
    if (!groupId || !messageId || !status) return

    const record = {
      groupId: String(groupId),
      userId: userId ? String(userId) : "",
      messageId: String(messageId),
      status,
      toolName,
      error: error ? String(error).slice(0, 120) : "",
      updatedAt: Date.now()
    }
    const cacheKey = this.getTaskStatusCacheKey(groupId, messageId)
    taskStatusCache.set(cacheKey, record)

    await settleTaskStatusRedis(
      redis.set(this.getTaskStatusRedisKey(groupId, messageId), JSON.stringify(record), {
        EX: this.getTaskStatusTtlSeconds()
      }),
      undefined,
      "写入"
    )
  }

  async getTaskStatus(groupId, messageId) {
    if (!groupId || !messageId) return null

    const cacheKey = this.getTaskStatusCacheKey(groupId, messageId)
    if (taskStatusCache.has(cacheKey)) return taskStatusCache.get(cacheKey)

    const raw = await settleTaskStatusRedis(
      redis.get(this.getTaskStatusRedisKey(groupId, messageId)),
      null,
      "读取"
    )
    if (!raw) return null
    try {
      const record = JSON.parse(raw)
      taskStatusCache.set(cacheKey, record)
      return record
    } catch (error) {
      logger.warn(`[任务状态] 解析失败：${error.message}`)
      return null
    }
  }

  async clearTaskStatus(groupId, messageId) {
    if (!groupId || !messageId) return
    taskStatusCache.delete(this.getTaskStatusCacheKey(groupId, messageId))
    await settleTaskStatusRedis(
      redis.del(this.getTaskStatusRedisKey(groupId, messageId)),
      undefined,
      "清理"
    )
  }

  async updateUserToolTaskStatus({ groupId, userId, messageId = "", toolName, status, requesterName = "", detail = "", scopeKey = "" }) {
    if (!groupId || !userId || !toolName || !status) return

    const key = this.getActiveToolTaskCacheKey(groupId, userId, toolName)
    const previous = activeUserToolTaskCache.get(key) || {}
    const record = {
      ...previous,
      groupId: String(groupId),
      userId: String(userId),
      messageId: messageId ? String(messageId) : String(previous.messageId || ""),
      toolName,
      status,
      requesterName: requesterName || previous.requesterName || "",
      detail: detail ? String(detail).slice(0, 160) : "",
      scopeKey: scopeKey || previous.scopeKey || "",
      startedAt: previous.startedAt || Date.now(),
      updatedAt: Date.now()
    }
    activeUserToolTaskCache.set(key, record)

    try {
      await redis.set(this.getActiveToolTaskRedisKey(groupId, userId, toolName), JSON.stringify(record), {
        EX: this.getTaskStatusTtlSeconds()
      })
    } catch (error) {
      logger.warn(`[活跃任务] 写入失败：${error.message}`)
    }
  }

  async getUserToolTaskStatus(groupId, userId, toolName) {
    if (!groupId || !userId || !toolName) return null

    const key = this.getActiveToolTaskCacheKey(groupId, userId, toolName)
    if (activeUserToolTaskCache.has(key)) return activeUserToolTaskCache.get(key)

    try {
      const raw = await redis.get(this.getActiveToolTaskRedisKey(groupId, userId, toolName))
      if (!raw) return null
      const record = JSON.parse(raw)
      activeUserToolTaskCache.set(key, record)
      return record
    } catch (error) {
      logger.warn(`[活跃任务] 读取失败：${error.message}`)
      return null
    }
  }

  async clearUserToolTaskStatus({ groupId, userId, toolName }) {
    if (!groupId || !userId || !toolName) return
    const key = this.getActiveToolTaskCacheKey(groupId, userId, toolName)
    activeUserToolTaskCache.delete(key)

    try {
      await redis.del(this.getActiveToolTaskRedisKey(groupId, userId, toolName))
    } catch (error) {
      logger.warn(`[活跃任务] 清理失败：${error.message}`)
    }
  }

  getRuntimeToolTaskStatus(groupId, userId, toolName) {
    const runtime = activeDedupeToolRuns.get(this.getToolRunKey(groupId, userId, toolName))
    if (!runtime) return null
    return {
      ...runtime,
      groupId: String(groupId),
      userId: String(userId),
      toolName,
      status: "running",
      updatedAt: Date.now()
    }
  }

  async getCurrentUserToolTaskStatus(groupId, userId, toolName) {
    const runtime = this.getRuntimeToolTaskStatus(groupId, userId, toolName)
    if (runtime) return runtime
    const stored = await this.getUserToolTaskStatus(groupId, userId, toolName)
    if (!stored || !["queued", "running"].includes(stored.status)) return null
    return stored
  }

  buildDrawTaskStatusReply(status) {
    const queued = status?.status === "queued"
    const isEdit = status?.toolName === "googleImageEditTool"
    if (isEdit) {
      return "那张图还在改，结果还没回来。出来了我就直接发。"
    }
    return queued
      ? "这张已经在队列里，前面还有任务。轮到它就会继续画，成图会直接发。"
      : "这张还在生成，结果还没回来。成图会直接发。"
  }

  buildReplySegment(messageId) {
    if (!messageId) return null
    if (globalThis.segment?.reply) return globalThis.segment.reply(messageId)
    if (typeof segment !== "undefined" && segment?.reply) return segment.reply(messageId)
    return { type: "reply", id: String(messageId), data: { id: String(messageId) } }
  }

  buildTaskStatusReplyMessage(status, text) {
    const replySegment = this.buildReplySegment(status?.messageId)
    return replySegment ? [replySegment, text] : text
  }

  async handleActiveDrawStatusQuestion(e, text = "") {
    if (!isDrawTaskStatusInquiry(text)) return false
    const statuses = await Promise.all([
      this.getCurrentUserToolTaskStatus(e.group_id, e.user_id, "bananaTool"),
      this.getCurrentUserToolTaskStatus(e.group_id, e.user_id, "googleImageEditTool")
    ])
    const status = statuses.find(Boolean)
    if (!status) return false

    logger.info(`[活跃任务] 命中图片任务进度追问 group=${e.group_id} user=${e.user_id} tool=${status.toolName} status=${status.status}`)
    await this.sendObservedReply(e, this.buildTaskStatusReplyMessage(status, this.buildDrawTaskStatusReply(status)))
    return true
  }

  formatTaskStatusForPrompt(status) {
    if (!status?.status) return ""
    if (status.status === "processing") {
      return "[历史处理标记: 这条历史消息已进入处理流程，禁止把它当作当前新任务重复处理]"
    }
    if (status.status === "tool_running") {
      return "[历史处理标记: 这条历史消息仍在后台处理，禁止重复处理；不要在回复中提到后台状态]"
    }
    if (status.status === "tool_success") {
      return "[历史处理标记: 这条历史消息已经处理完，禁止重复处理]"
    }
    if (status.status === "tool_failed") {
      return "[历史处理标记: 这条历史消息此前没有产生可用输出。除非当前用户明确要求重试，否则只把它当普通历史；不要提到后台、工具、模型、接口、报错或失败等内部状态]"
    }
    return ""
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

  syncDedupeToolConfig(toolNames = this.config.oneapi_tools || []) {
    this.dedupeToolNames = new Set(
      (Array.isArray(toolNames) ? toolNames : [])
        .map(item => parseToolConfigEntry(item))
        .filter(item => item.name && item.dedupe)
        .map(item => item.name)
    )
  }

  getToolsByName(toolNames, options = {}) {
    if (!toolNames || !Array.isArray(toolNames)) return []
    const warnMissing = options.warnMissing !== false

    return toolNames
      .map(item => {
        const { name } = parseToolConfigEntry(item)
        if (name === 'sendLocalEmojiTool' && !this.config?.emojiSystem?.enabled) {
          return null
        }
        if (name === 'waitTool') {
          const mode = String(this.config?.chatTriggerMode || 'strict').toLowerCase()
          if (mode !== 'smart' || !this.config?.smartTrigger?.waitToolEnabled) return null
        }
        const func = this.functionMap.get(name)
        if (!func) {
          if (warnMissing) console.warn(`未找到工具 "${name}"`)
          return null
        }
        return {
          type: "function",
          function: {
            name: func.name,
            description: func.description,
            parameters: {
              type: "object",
              properties: func.parameters.properties,
              required: func.parameters.required || []
            }
          }
        }
      })
      .filter(Boolean)
  }

  getToolsDescriptionString() {
    if (!this.tools?.length) return "当前没有可用的工具。"

    const localDesc = this.tools
      ?.filter(t => !mcpManager.isMCPTool(t.function?.name))
      .map(t => `${t.function.name}: ${t.function.description}`)
      .join("\n") || ""

    const mcpDesc = mcpManager.getToolsDescription ? mcpManager.getToolsDescription() : ""

    const parts = []
    if (localDesc) parts.push("【本地工具】\n" + localDesc)
    if (mcpDesc) parts.push("【MCP工具】\n" + mcpDesc)

    return parts.length ? parts.join("\n\n") : "当前没有可用的工具。"
  }

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

  mergeMCPConfig(defaults, user) {
    const merged = this.mergeConfigPreserveUser(defaults || {}, user || {})

    if (merged.settings && typeof merged.settings === "object") {
      delete merged.settings.legacyAliasEnabled
    }

    if (user?.servers && typeof user.servers === "object" && !Array.isArray(user.servers)) {
      merged.servers = { ...user.servers }
      for (const [serverName, serverConfig] of Object.entries(user.servers)) {
        if (defaults?.servers?.[serverName]) {
          merged.servers[serverName] = this.mergeConfigPreserveUser(
            defaults.servers[serverName],
            serverConfig
          )
        }
      }
    }

    return merged
  }

  checkGroupPermission(e) {
    if (!this.config.enableGroupWhitelist) return true
    return this.config.allowedGroups.some(id => String(id) === String(e.group_id))
  }

  isUserBlacklisted(e) {
    const blacklist = this.config?.userBlacklist
    if (!blacklist?.enabled) return false
    const userId = e?.user_id
    if (userId === undefined || userId === null) return false
    const users = Array.isArray(blacklist.users) ? blacklist.users : []
    return users.some(id => String(id).trim() === String(userId))
  }

  async getGroupUserMessages(groupId, userId) {
    const redisKey = `${this.messageHistoriesRedisKey}:${groupId}:${userId}`
    const filePath = path.join(this.messageHistoriesDir, `${groupId}_${userId}.json`)

    try {
      const redisData = await loadData(redisKey, null)
      if (redisData) return redisData

      const fileData = await fs.promises.readFile(filePath, "utf-8").catch(() => null)
      if (fileData) {
        const parsed = JSON.parse(fileData)
        await saveData(redisKey, filePath, parsed)
        return parsed
      }
      return []
    } catch (error) {
      console.error(`获取消息历史失败:`, error)
      return []
    }
  }

  async saveGroupUserMessages(groupId, userId, messages) {
    const redisKey = `${this.messageHistoriesRedisKey}:${groupId}:${userId}`
    const filePath = path.join(this.messageHistoriesDir, `${groupId}_${userId}.json`)
    await Promise.all([
      saveData(redisKey, filePath, messages),
      fs.promises.writeFile(filePath, JSON.stringify(messages, null, 2), "utf-8")
    ]).catch(err => console.error(`保存消息历史失败:`, err))
  }

  async clearGroupUserMessages(groupId, userId) {
    const redisKey = `${this.messageHistoriesRedisKey}:${groupId}:${userId}`
    const filePath = path.join(this.messageHistoriesDir, `${groupId}_${userId}.json`)
    await Promise.all([
      redis.del(redisKey),
      fs.promises.unlink(filePath).catch(() => { })
    ])
  }

  async resetGroupUserMessages(groupId, userId) {
    await this.clearGroupUserMessages(groupId, userId)
    await this.saveGroupUserMessages(groupId, userId, [])
  }

  formatTime() {
    const now = new Date()
    const pad = n => String(n).padStart(2, "0")
    return `[${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}]`
  }

  async collectForwardPromptLines(group, forwardId, state = {}) {
    const id = String(forwardId || "").trim()
    if (!group?.getForwardMsg || !id) return state.lines || []

    const lines = state.lines || []
    const visited = state.visited || new Set()
    const depth = Number(state.depth) || 0
    const maxDepth = Number(state.maxDepth) || FORWARD_CONTEXT_MAX_DEPTH
    const maxLines = Number(state.maxLines) || FORWARD_CONTEXT_MAX_LINES
    if (depth >= maxDepth || lines.length >= maxLines) return lines
    if (visited.has(id)) {
      lines.push(`${"  ".repeat(depth)}[嵌套转发记录重复，已跳过]`)
      return lines
    }

    visited.add(id)
    let forwardMsgs = []
    try {
      forwardMsgs = normalizeForwardMessageList(await group.getForwardMsg(id))
    } catch (err) {
      logger.debug(`[获取转发记录失败] id=${id} ${err}`)
      return lines
    }

    const indent = "  ".repeat(depth)
    for (const fMsg of forwardMsgs) {
      if (lines.length >= maxLines) break
      const segments = normalizeMessageSegments(fMsg)
      const text = extractReadableTextFromSegments(segments, fMsg.raw_message || fMsg.message_text || fMsg.content_text || "")
      const name = getForwardSenderName(fMsg)
      if (text) lines.push(`${indent}${name}: ${text}`)

      const nestedForwardIds = extractForwardIdsFromSegments(segments)
      for (const nestedId of nestedForwardIds) {
        if (lines.length >= maxLines) break
        lines.push(`${indent}${name}: [嵌套转发记录]`)
        await this.collectForwardPromptLines(group, nestedId, {
          lines,
          visited,
          depth: depth + 1,
          maxDepth,
          maxLines
        })
      }
    }

    return lines
  }

  async resolveForwardPromptFromSegments(segments = [], group) {
    const forwardIds = extractForwardIdsFromSegments(segments)
    if (!forwardIds.length || !group?.getForwardMsg) return ""

    const lines = []
    const visited = new Set()
    for (const forwardId of forwardIds) {
      if (lines.length >= FORWARD_CONTEXT_MAX_LINES) break
      await this.collectForwardPromptLines(group, forwardId, {
        lines,
        visited,
        depth: 0,
        maxDepth: FORWARD_CONTEXT_MAX_DEPTH,
        maxLines: FORWARD_CONTEXT_MAX_LINES
      })
    }

    return compactDrawPromptText(lines.join("\n"), FORWARD_CONTEXT_MAX_TEXT)
  }

  async buildMessageContent(sender, msg, images, atQq = [], group, e = null) {
    const senderRole = roleMap[sender.role] || "member"
    const messageId = e?.message_id ? `[消息ID:${e.message_id}]` : ''
    let senderMember = sender
    if (group && sender?.user_id) {
      try {
        const memberMap = await group.getMemberMap()
        senderMember = memberMap.get(Number(sender.user_id)) || sender
      } catch {}
    }
    const senderInfo = `${formatMemberDisplayName(senderMember, sender.card || sender.nickname)}(qq号: ${sender.user_id})[群身份: ${senderRole}]${messageId}`

    let atContent = ""
    if (atQq.length > 0 && group) {
      const memberMap = await group.getMemberMap()
      const atUsers = atQq.map(qq => {
        const info = memberMap.get(Number(qq))
        if (!info) return `@未知用户(${qq})`
        return `@${formatMemberDisplayName(info)}`
      })
      atContent = `${atUsers.join(" ")} `
    }

    let quoteContent = ""
    if (e?.getReply) {
      try {
        const reply = e?._groupContextAssets?.reply || await e.getReply()
        if (reply) {
          const quotedSender = reply.sender
          let quotedMsg = ""
          let forwardPromptText = ""
          if (reply.message && Array.isArray(reply.message)) {
            quotedMsg = reply.message
              .filter(m => m.type === "text")
              .map(m => m.text)
              .join("")
              .trim()
          } else if (typeof reply.raw_message === "string") {
            quotedMsg = reply.raw_message
          }

          // 提取被引用消息中的转发记录内容，递归展开嵌套合并转发。
          let forwardContent = ""
          forwardPromptText = e?._groupContextAssets?.quotedForwardText ||
            await this.resolveForwardPromptFromSegments(reply.message || [], e?.group || group)
          if (forwardPromptText) {
            forwardContent = `[转发记录内容:\n${forwardPromptText}\n]`
          }

          const quotedImages = reply.message?.filter(m => m.type === "image") || []
          const hasQuotedImage = quotedImages.length > 0

          // 视频 / 语音 / 文件 segment（之前没处理，导致引用视频时 LLM 看到的描述只是"一条消息"，
          // 看不到视频链接也就没法调 videoAnalysisTool 分析）
          const quotedVideos = reply.message?.filter(m => m.type === "video") || []
          const videoUrls = quotedVideos
            .map(v => v?.url || v?.file_url || v?.data?.url || v?.data?.file_url || v?.file || v?.data?.file)
            .filter(Boolean)
          const hasQuotedVideo = quotedVideos.length > 0

          const quotedRecords = reply.message?.filter(m => m.type === "record") || []
          const recordUrls = quotedRecords
            .map(r => r?.url || r?.file_url || r?.data?.url || r?.data?.file_url || r?.file || r?.data?.file)
            .filter(Boolean)
          const hasQuotedRecord = quotedRecords.length > 0

          const quotedFiles = reply.message?.filter(m => m.type === "file") || []
          const fileNames = quotedFiles
            .map(f => f?.name || f?.data?.name || f?.file || f?.data?.file)
            .filter(Boolean)
          const hasQuotedFile = quotedFiles.length > 0

          if (quotedSender) {
            let quotedNickname = quotedSender.nickname || quotedSender.card || "未知用户"

            if (group) {
              try {
                const memberMap = await group.getMemberMap()
                const quotedMemberInfo = memberMap.get(Number(quotedSender.user_id))
                if (quotedMemberInfo) {
                  quotedNickname = formatMemberDisplayName(quotedMemberInfo, quotedNickname)
                }
              } catch (err) {
              }
            }

            const quotedMessageId = reply.message_id ? `(消息ID:${reply.message_id})` : ''

            const parts = []
            if (quotedMsg) parts.push(`"${quotedMsg}"`)
            if (forwardContent) parts.push(forwardContent)
            if (hasQuotedImage) parts.push(`${quotedImages.length}张图片`)
            if (hasQuotedVideo) {
              const urlText = videoUrls.length ? `(链接: ${videoUrls.join(", ")})` : ""
              parts.push(`一段视频${urlText}`)
            }
            if (hasQuotedRecord) {
              const urlText = recordUrls.length ? `(链接: ${recordUrls.join(", ")})` : ""
              parts.push(`一段语音${urlText}`)
            }
            if (hasQuotedFile) {
              const fileText = fileNames.length ? `(文件名: ${fileNames.join(", ")})` : ""
              parts.push(`一个文件${fileText}`)
            }
            const quotedDescription = parts.length > 0 ? parts.join("，以及") : "一条消息"

            quoteContent = `[回复 ${quotedNickname}${quotedMessageId}的消息: ${quotedDescription}] `
            if (e) {
              const promptParts = []
              if (quotedMsg) promptParts.push(quotedMsg)
              if (forwardPromptText) promptParts.push(forwardPromptText)
              e._quotedPromptContext = {
                senderName: quotedNickname,
                messageId: reply.message_id ? String(reply.message_id) : "",
                text: compactDrawPromptText(promptParts.join("\n"), 2600),
                mediaSummary: [
                  hasQuotedImage ? `${quotedImages.length}张图片` : "",
                  hasQuotedVideo ? "一段视频" : "",
                  hasQuotedRecord ? "一段语音" : "",
                  hasQuotedFile ? `文件${fileNames.length ? `: ${fileNames.join(", ")}` : ""}` : ""
                ].filter(Boolean).join("，")
              }
            }
          }
        }
      } catch (error) {
        console.error("获取引用消息失败:", error)
      }
    }

    const content = []
    if (msg) {
      let fullMsg = msg
      if (e?.message && group && atQq.length > 0) {
        try {
          const memberMap = await group.getMemberMap()
          fullMsg = e.message.map(m => {
            if (m.type === 'text') return m.text
            const mentionedUserId = m.type === 'at' ? getMentionTargetId(m) : null
            if (mentionedUserId && String(mentionedUserId) !== String(Bot.uin)) {
              const info = memberMap.get(Number(mentionedUserId))
              return `@${info ? formatMemberDisplayName(info) : mentionedUserId}`
            }
            return ''
          }).join('').replace(/^#tool\s*/, '').trim()
        } catch {}
      }
      content.push(`在群里说: ${fullMsg}`)
    }
    const currentForwardPromptText = e?._groupContextAssets?.currentForwardText ||
      await this.resolveForwardPromptFromSegments(e?.message || [], group)
    if (currentForwardPromptText) {
      content.push(`转发了合并聊天记录:\n${currentForwardPromptText}`)
    }
    if (images?.length) {
      content.push(`发送了${images.length === 1 ? "一张" : images.length + " 张"}图片${images.map(img => `\n![图片](${img})`).join("")}`)
    }
    if (e?._groupContextImagePrompt) {
      content.push(e._groupContextImagePrompt)
    }

    return `${this.formatTime()} ${senderInfo}: ${quoteContent}${atContent}${content.join("，")}`
  }

  checkTriggers(e) {
    try {
      const hasMessage = e.msg && typeof e.msg === "string" &&
        this.config.triggerPrefixes.some(p => p && e.msg.toLowerCase().includes(p.toLowerCase()))

      const botId = e?.bot?.uin || Bot.uin
      const hasAt = messageMentionsUser(e, botId)
      const hasReplyToBot = messageQuotesUser(e, botId)

      return hasMessage || hasAt || hasReplyToBot
    } catch {
      return false
    }
  }

  isCommand(e) {
    return e.msg?.startsWith("#")
  }

  filterChatByQQ(chatArray, qqNumber) {
    const pattern = /\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/
    const lastIndex = chatArray.reduce((last, curr, i) =>
      curr.content?.includes(`(qq号: ${qqNumber})`) && pattern.test(curr.content) ? i : last, -1)
    return lastIndex === -1 ? chatArray : chatArray.slice(0, lastIndex + 1)
  }

  getOrCreateSession(sessionId, tools) {
    return this.sessionStore.getOrCreate(sessionId, tools)
  }

  clearSession(sessionId) {
    this.sessionStore.clear(sessionId)
  }

  trimMessageHistory(messages) {
    const nonSystem = messages.filter(m => m.role !== "system")
    if (nonSystem.length <= this.MAX_HISTORY) return messages

    const system = messages.filter(m => m.role === "system")
    return [...system, ...nonSystem.slice(-this.MAX_HISTORY)]
  }

  /**
   * AI判断用户是否在继续跟机器人对话
   * @param {string} userMessage - 用户新消息
   * @param {Array} chatHistory - 对话历史数组 [{role: 'bot'|'user', content: '...'}]
   */
  async isUserTalkingToBot(userMessage, chatHistory = []) {
    try {
      const botName = Bot.nickname || '机器人'

      // 构建对话历史文本
      const historyText = chatHistory.length > 0
        ? chatHistory.map(h => `[${h.role === 'bot' ? '机器人' : '用户'}] ${h.content}`).join('\n')
        : '(无历史记录)'

      const response = await fetch(this.config.trackAiConfig.trackAiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.trackAiConfig.trackAiApikey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.config.trackAiConfig.trackAiModel,
          messages: [
            {
              role: "system",
              content: `你是QQ群聊对话判断助手。机器人名字叫"${botName}"，QQ号${Bot.uin}。

根据对话历史，判断用户新消息是否在继续跟机器人对话。

【判断为 true】
- 内容是对机器人上一条回复的回应或追问
- 话题自然延续（机器人说"中午好"→用户问"吃什么"）
- 针对机器人之前说的内容提问

【判断为 false】
- @了其他群成员
- 明确叫其他人名字
- 话题与之前对话完全无关
- 明显是群里的日常闲聊/水群

你只回复 true 或 false，不要输出其他内容。
`
            },
            {
              role: "user",
              content: `【近期对话记录】\n${historyText}\n\n【用户新消息】\n${userMessage}\n\n这条新消息是在跟机器人说话吗？`
            }
          ]
        })
      })

      if (!response.ok) return false // 请求失败时默认不触发

      const data = await response.json()
      const answer = data?.choices?.[0]?.message?.content?.toLowerCase()?.trim()
      // logger.error(answer, historyText, userMessage, 8888)
      return answer === 'true' || answer?.includes('true')
    } catch (error) {
      logger.error('[会话追踪] AI判断失败:', error)
      return false // 出错时默认不触发
    }
  }

  /**
   * 加入批量判断队列
   */
  addToBatchJudgment(conversationKey, userMessage, chatHistory, e) {
    return new Promise(resolve => {
      pendingJudgments.push({ conversationKey, userMessage, chatHistory, e, resolve })

      if (!batchTimer) {
        const batchDelay = (this.config.batchJudgmentDelay || 3) * 1000
        batchTimer = setTimeout(() => this.processBatchJudgments(), batchDelay)
      }
    })
  }

  /**
   * 处理批量判断队列
   */
  async processBatchJudgments() {
    batchTimer = null
    if (pendingJudgments.length === 0) return

    const batch = pendingJudgments.splice(0)

    if (batch.length === 1) {
      const result = await this.isUserTalkingToBot(batch[0].userMessage, batch[0].chatHistory)
      batch[0].resolve(result)
      return
    }

    try {
      const results = await this.batchIsUserTalkingToBot(batch)
      batch.forEach((item, i) => item.resolve(results[i] || false))
    } catch (error) {
      logger.error('[批量判断] 失败:', error)
      batch.forEach(item => item.resolve(false))
    }
  }

  /**
   * 批量判断多条消息是否在跟机器人对话
   */
  async batchIsUserTalkingToBot(batch) {
    try {
      const botName = Bot.nickname || '机器人'

      // 为每条消息生成唯一标识
      const batchWithIds = batch.map((item, i) => ({
        ...item,
        id: `MSG_${i + 1}_${item.e?.user_id || 'unknown'}`
      }))

      const messagesText = batchWithIds.map(item => {
        const recentHistory = (item.chatHistory || []).slice(-3).map(h => `[${h.role === 'bot' ? '机器人' : '用户'}] ${h.content}`).join('\n')
        const userName = item.e?.sender?.card || item.e?.sender?.nickname || '未知用户'
        return `【${item.id}】用户: ${userName}(QQ:${item.e?.user_id})
对话历史:
${recentHistory || '(无)'}
新消息: ${item.userMessage}
---`
      }).join('\n\n')

      const response = await fetch(this.config.trackAiConfig.trackAiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.config.trackAiConfig.trackAiApikey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.config.trackAiConfig.trackAiModel,
          messages: [
            {
              role: "system",
              content: `你是QQ群聊对话判断助手。机器人名字叫"${botName}"。

每条消息来自不同用户，有独立的对话历史，请分别独立判断。

【判断为 true】
- 内容是对机器人上一条回复的回应或追问
- 话题自然延续
- 针对机器人之前说的内容提问

【判断为 false】
- @了其他群成员
- 明确叫其他人名字
- 话题与之前对话完全无关
- 明显是群里的日常闲聊/水群
- 无对话历史且消息内容与机器人无关

返回JSON对象，key为消息ID，value为判断结果。
示例: {"MSG_1_12345": true, "MSG_2_67890": false}
只返回JSON对象，不要其他内容。`
            },
            {
              role: "user",
              content: `分别判断以下${batchWithIds.length}条来自不同用户的消息:\n\n${messagesText}\n\n返回JSON对象:`
            }
          ]
        })
      })

      if (!response.ok) {
        logger.error('[批量判断] API请求失败')
        return this.fallbackToSingleJudgment(batch)
      }

      const data = await response.json()
      let content = data?.choices?.[0]?.message?.content?.trim() || '{}'

      // 提取JSON对象
      const jsonMatch = content.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        content = jsonMatch[0]
      }

      const resultsMap = JSON.parse(content)
      logger.info(`[批量判断] ${batch.length}条消息，结果: ${JSON.stringify(resultsMap)}`)

      // 按ID映射回结果数组
      const results = batchWithIds.map(item => {
        const result = resultsMap[item.id]
        if (result === undefined) {
          logger.warn(`[批量判断] 缺少ID ${item.id} 的结果，回退单独判断`)
          return null // 标记需要单独判断
        }
        return result === true || result === 'true'
      })

      // 检查是否有需要单独判断的
      const needsFallback = results.some(r => r === null)
      if (needsFallback) {
        return this.fallbackToSingleJudgment(batch, results)
      }

      return results
    } catch (error) {
      logger.error('[批量判断] 解析失败:', error)
      return this.fallbackToSingleJudgment(batch)
    }
  }

  /**
   * 回退到单独判断
   */
  async fallbackToSingleJudgment(batch, partialResults = null) {
    logger.info(`[批量判断] 回退到单独判断，共${batch.length}条`)
    const results = []
    for (let i = 0; i < batch.length; i++) {
      if (partialResults && partialResults[i] !== null) {
        results.push(partialResults[i])
      } else {
        const result = await this.isUserTalkingToBot(batch[i].userMessage, batch[i].chatHistory)
        results.push(result)
      }
    }
    return results
  }

  async handleRandomReply(e) {
    if (!this.config.enabled || !this.checkGroupPermission(e) || this.isCommand(e) || !e.group_id) {
      return false
    }

    if (this.isUserBlacklisted(e)) {
      logger.info(`[用户黑名单] group=${e.group_id} user=${e.user_id} msg="${summarizeForLog(e.msg || "")}"`)
      return false
    }

    if (diceManager.isLogActive(e.group_id, this.config.diceSystem)) {
      logger.info(`[骰娘log] group=${e.group_id} log开启中，跳过AI对话`)
      return false
    }

    const messageTypes = e.message?.map(m => m.type) || []
    if (this.config.excludeMessageTypes.some(t => messageTypes.includes(t))) return false

    if (this.config.globalStyleLearning?.enabled !== false) {
      try {
        globalStyleLearnerManager.observeMessage(e, this.config.globalStyleLearning, this.config.embeddingAiConfig)
        globalStyleLearnerManager.maybeAutoSummarize(
          this.config.globalStyleLearning,
          this.config.memoryAiConfig
        ).catch(error => {
          logger.warn(`[全局表达学习] 自动总结调度失败: ${error.message}`)
        })
      } catch (error) {
        logger.warn(`[全局表达学习] 记录失败: ${error.message}`)
      }
    }

    // 必须和全局风格观察一样放在本处理函数的第一个 await 之前。
    // 否则高并发群消息会因异步检查返回顺序不同而重排，把 A-B-A 误学成 A 的连续两句。
    if (this.config.expressionLearning?.enabled &&
      String(e.user_id || '') !== String(e.bot?.uin || Bot.uin || '') &&
      (e.msg || e.raw_message || Array.isArray(e.message))) {
      this.expressionLearner.updateGroupExpressions(e.group_id, e.msg || e.raw_message || '', {
        userId: e.user_id,
        messageId: e.message_id,
        at: Number(e.time) > 0 ? Number(e.time) * 1000 : Date.now(),
        message: e.message
      }).catch(() => {})
    }

    // 禁言检测：bot 在该群被禁言（个人/全员）时不触发任何回复，避免发送失败 + 表情/red 包等也无意义
    if (await this.isMutedInGroup(e)) return false

    // 磁链与视频卡片一样是独立媒体交付事件：不必点名，也不能交给闲聊 TimingGate 决定。
    if (this.isAutomaticTorrentDownloadEvent(e)) {
      logger.info(`[自动磁链下载] group=${e.group_id} user=${e.user_id} 已识别有效 BTIH 磁链`)
      e._triggerContext = { mode: "auto_media" }
      return await this.handleTool(e)
    }

    // 检测红包消息并随机触发抢红包（两种模式都生效）
    const walletSeg = e.message?.find(m => m.type == 'wallet')
    if (walletSeg && RED_BAG_CONFIG.enabled && toolConfigHasName(this.config.oneapi_tools, 'grabRedBagTool')) {
      const wallet = walletSeg.data || walletSeg
      const redBagType = getRedBagType(wallet)
      const botId = e.bot?.uin || Bot.uin

      // 专属红包：判断是否给机器人
      if (redBagType.type === 'exclusive') {
        if (!isExclusiveForUser(wallet, botId)) {
          logger.info(`[自动抢红包] 专属红包不是给机器人的，跳过`)
          return false
        }
        // 专属红包给机器人，直接触发
        logger.info(`[自动抢红包] 检测到给机器人的专属红包，直接触发抢红包`)
        e.forceGrabRedBag = true
        e._triggerContext = { mode: "red_bag" }
        return await this.handleTool(e)
      }

      const now = Date.now()
      const lastGrabTime = redBagCooldowns.get(e.group_id) || 0

      // 检查冷却时间
      if (now - lastGrabTime >= RED_BAG_CONFIG.cooldownTime) {
        // 随机概率
        const probability = RED_BAG_CONFIG.minProbability +
          Math.random() * (RED_BAG_CONFIG.maxProbability - RED_BAG_CONFIG.minProbability)

        if (Math.random() < probability) {
          redBagCooldowns.set(e.group_id, now)
          logger.info(`[自动抢红包] 检测到${redBagType.name}，触发概率 ${(probability * 100).toFixed(1)}%，执行抢红包`)
          e.forceGrabRedBag = true // 标记强制抢红包
          e._triggerContext = { mode: "red_bag" }
          return await this.handleTool(e)
        } else {
          logger.info(`[自动抢红包] 检测到${redBagType.name}，未命中概率 ${(probability * 100).toFixed(1)}%，跳过`)
        }
      }
    }

    // smart 模式分发
    const triggerMode = String(this.config.chatTriggerMode || 'strict').toLowerCase()
    if (triggerMode === 'smart') {
      return await this.handleRandomReplySmart(e)
    }

    const hasTrigger = await this.checkTriggers(e)

    // 会话追踪逻辑
    const conversationKey = `${e.group_id}_${e.user_id}`
    const activeConv = activeConversations.get(conversationKey)

    // 如果明确触发（@或前缀），直接触发并更新追踪
    if (hasTrigger) {
      e._triggerContext = { mode: "strict_trigger" }
      if (this.config.conversationTrackingEnabled) {
        this.setTrackingWithTimer(conversationKey)
      }
      const scheduled = this.scheduleMergedDirectTrigger(e, async mergedEvent => {
        await this.handleTool(mergedEvent)
      }, 'strict_trigger')
      if (scheduled === false) return false
      return await this.handleTool(e)
    }

    // 在追踪期内，判断是否在继续对话
    if (this.config.conversationTrackingEnabled && activeConv) {
      // 节流检查
      const throttleKey = conversationKey
      const lastCallTime = trackingThrottle.get(throttleKey) || 0
      const throttleInterval = (this.config.conversationTrackingThrottle || 3) * 1000

      if (Date.now() - lastCallTime < throttleInterval) {
        // 节流期内，直接返回不触发
        return false
      }

      // 更新节流时间
      trackingThrottle.set(throttleKey, Date.now())

      // 构建完整格式的用户消息
      const senderRole = roleMap[e.sender?.role] || "member"
      const senderName = e.sender?.card || e.sender?.nickname || "未知用户"
      const userMessageFormatted = `${this.formatTime()} ${senderName}(qq号: ${e.user_id})[群身份: ${senderRole}]: 在群里说: ${e.msg || ''}`

      // 使用批量判断队列
      const isTalking = await this.addToBatchJudgment(conversationKey, userMessageFormatted, activeConv.chatHistory || [], e)

      if (isTalking) {
        // 重置定时器
        this.setTrackingWithTimer(conversationKey)
        e._triggerContext = { mode: "conversation_tracking" }
        return await this.handleTool(e)
      }
      // 判断不是在跟机器人对话，直接返回不触发
      return false
    }

    // 未在追踪期内，不触发
    return false
  }

  async handleTool(e) {
    if (!isAiConversationEnabled(this.config)) return false
    if (!this.config.enabled || !e.group_id) {
      if (!e.group_id) await this.sendObservedReply(e, "该命令只能在群聊中使用。")
      return false
    }

    if (this.isUserBlacklisted(e)) {
      logger.info(`[用户黑名单] tool group=${e.group_id} user=${e.user_id} msg="${summarizeForLog(e.msg || "")}"`)
      return false
    }

    const scheduledToolRequest = this.scheduleMergedToolRequest(e, async mergedEvent => {
      await this.handleTool(mergedEvent)
    })
    if (scheduledToolRequest === false) return false

    if (this.localToolsReadyPromise) await this.localToolsReadyPromise
    await this.refreshLocalToolRegistry({ silent: true })
    await this.waitForMCPReady()

    const taskContext = await this.beginConversationTask(e)
    const handleToolStartAt = Date.now()

    const { group_id: groupId, user_id: userId, msg } = e
    const sessionId = randomUUID()
    e.sessionId = sessionId
    const session = this.getOrCreateSession(sessionId, this.tools)
    session.taskContext = taskContext
    // 一个回合一条 trace + 一个出站仲裁：回合内所有出站消息过同一个有序队列
    const turnTrace = createTurnTrace({ groupId, userId, sessionId, logger, archive: { enabled: this.config?.turnTrace?.archiveEnabled !== false, dir: String(this.config?.turnTrace?.archiveDir || "") || resolveTurnTraceArchiveDir(), retentionDays: Number(this.config?.turnTrace?.retentionDays) || 7 } })
    e._turnId = turnTrace.id
    if (e?._triggerContext) turnTrace.setTrigger(e._triggerContext.mode, e._triggerContext)
    const outboundArbiter = createOutboundArbiter({ logger, trace: turnTrace })
    // 工具路由结果在 try 内赋值;提升到函数作用域供 finally 的回合诊断留存读取
    let route = null
    session.outboundArbiter = outboundArbiter
    session.turnTrace = turnTrace
    e = outboundArbiter.wrapEvent(e)
    // Tool stages share one optional progress message for the whole turn.
    e._progressReplyState = { sent: false, reserved: false }
    const groupLimiter = getOrCreateGroupLimiter(this._groupLimiters, groupId, this.config.concurrentLimit || 5)

    let groupUserMessages = session.groupUserMessages

    return await groupLimiter(async () => {
      try {
        const args = msg?.replace(/^#tool\s*/, "").trim() || ""
        const atQq = collectMentionTargetIds(e, Bot.uin)
        let repliedMessage = null
        if (e.getReply) {
          try {
            repliedMessage = await e.getReply()
          } catch {}
        }
        const groupContextAssets = await resolveGroupContextAssets({
          e,
          group: e.group,
          reply: repliedMessage,
          maxImages: 12
        })
        session.groupContextAssets = groupContextAssets
        session.groupContextImagePrompt = formatGroupContextImagePrompt(groupContextAssets.images)
        e._groupContextAssets = groupContextAssets
        e._groupContextImagePrompt = session.groupContextImagePrompt

        const legacyImages = await TakeImages(e)
        const contextImages = groupContextAssets.images.map(asset => asset.source)
        let images = groupContextAssets.currentImages.length
          ? uniqText([...contextImages, ...legacyImages])
          : groupContextAssets.quotedImages.length
            ? uniqText([...legacyImages, ...contextImages])
            : contextImages.length
              ? uniqText(contextImages)
              : legacyImages
        if (groupContextAssets.forwardImages.length) {
          logger.info(`[群内素材] group=${groupId} 读取合并转发图片 ${groupContextAssets.forwardImages.length} 张`)
        }
        if (groupContextAssets.quotedImages.length > 1) {
          logger.info(`[群内素材] group=${groupId} 读取引用消息图片 ${groupContextAssets.quotedImages.length} 张`)
        }
        const recentUserImage = !images.length && shouldRequireImageEditBase(args || msg || "")
          ? await resolveRecentUserImage(e, { userId: e?.user_id }).catch(() => null)
          : null
        if (recentUserImage?.image) {
          images = [recentUserImage.image]
          session.recentUserImage = recentUserImage
          logger.info(`[图片来源] group=${groupId} user=${userId} 使用同一用户近期上传图片作为编辑原图`)
        }
        const recentImageContinuation = !images.length
          ? await resolveRecentBotImage(e, { text: args || msg || "", botId: Bot.uin }).catch(() => null)
          : null
        if (recentImageContinuation?.image) {
          images = [recentImageContinuation.image]
          session.recentImageContinuation = recentImageContinuation
          logger.info(`[图片续改] group=${groupId} 使用机器人最近成图作为编辑输入`)
        }
        session.images = images
        session.rawArgs = args

        if (await this.handleActiveDrawStatusQuestion(e, args || msg || "")) {
          this.clearSession(sessionId)
          return true
        }

        let videos = groupContextAssets.videos || []

        let memberMap = null
        try {
          memberMap = e.group ? await e.group.getMemberMap() : null
        } catch {}
        const avatarEditBase = !images.length
          ? resolveAvatarEditBase({
              text: args || msg || "",
              atQq,
              memberMap,
              currentUserId: e?.user_id,
              botId: Bot.uin,
              replyTargetUserId: groupContextAssets.replyTargetUserId,
              replyTargetLabel: groupContextAssets.replyTargetLabel
            })
          : null
        if (avatarEditBase?.images?.length) {
          session.avatarEditBase = avatarEditBase
          images = avatarEditBase.images
          session.images = images
          logger.info(`[图片编辑] group=${groupId} 使用群友头像作为编辑底图 targets=${avatarEditBase.targets.map(item => item.userId).join(",")} imageCount=${images.length}`)
        }
        const avatarInspection = resolveAvatarInspectionTargets({
          e,
          text: args || msg || "",
          atQq,
          memberMap,
          reply: repliedMessage,
          botName: Bot.nickname,
          prefixes: this.config.triggerPrefixes
        })
        if (avatarInspection?.images?.length) {
          session.avatarInspection = avatarInspection
        }

        const editAssets = images.length && !session.avatarEditBase
          ? prepareImageEditAssets({
              baseImages: images,
              text: args || msg || "",
              atQq,
              memberMap,
              currentUserId: e?.user_id,
              botId: Bot.uin,
              replyTargetUserId: groupContextAssets.replyTargetUserId,
              replyTargetLabel: groupContextAssets.replyTargetLabel
            })
          : null
        if (editAssets?.references?.length) {
          session.editAssets = editAssets
          images = editAssets.images
          session.images = images
          logger.info(`[图片编辑] group=${groupId} 已构建编辑素材清单 references=${editAssets.references.map(item => item.id).join(",")} imageCount=${images.length}`)
        }

        const avatarDrawReference = !images.length
          ? resolveAvatarDrawReference({
              e,
              text: args || msg || "",
              atQq,
              memberMap,
              reply: repliedMessage,
              botName: Bot.nickname,
              prefixes: this.config.triggerPrefixes
            })
          : null
        if (avatarDrawReference?.images?.length) {
          session.avatarDrawReference = avatarDrawReference
        }

        if (!images.length && !avatarInspection?.images?.length && shouldAskForMissingImageForVisualRequest(args || msg || "")) {
          await this.sendSegmentedMessage(e, buildMissingImageAnalysisReply(), 0)
          this.clearSession(sessionId)
          return true
        }

        if (!images.length && shouldRequireImageEditBase(args || msg || "")) {
          await this.sendSegmentedMessage(e, "我知道你想改图，但这条消息附近没有找到可以编辑的原图。你回复那张图，或者把图和要求一起发给我。", 0)
          this.clearSession(sessionId)
          return true
        }

        const memberInfo = await (async () => {
          try {
            return await e.bot.pickGroup(groupId).pickMember(e.sender.user_id).info
          } catch { return {} }
        })()
        const senderRole = roleMap[e.sender?.role] || roleMap[memberInfo?.role] || "member"

        // ── 意图判定前置（P4 主判定 + 闲聊快路）：必须在分层画像与 prompt 拼接之前 ──
        const currentIntentText = joinIntentParts(args, msg)
        session.turnDrawRequested = isImageGenerationRequest(currentIntentText)
        const intentToolCandidates = selectToolIntentCandidates(currentIntentText, (session.tools || []).map(tool => tool?.function?.name).filter(Boolean))
        const skipIntentModel = shouldSkipIntentModel({
          text: currentIntentText,
          hasImages: Boolean(images?.length),
          hasVideos: Boolean(videos?.length),
          toolCandidates: intentToolCandidates
        })
        let modelIntentDecision = null
        if (skipIntentModel) {
          turnTrace.setIntent("chat", null, "fast_path_skip")
          logger.info(`[意图快路] group=${groupId} 无工具信号的短闲聊，跳过意图模型`)
        } else {
          const intentModelStartedAt = Date.now()
          modelIntentDecision = await this.resolvePrimaryModelIntent(currentIntentText, { hasImages: Boolean(images?.length) })
          turnTrace.addModelCall("intent", Date.now() - intentModelStartedAt)
          if (modelIntentDecision) turnTrace.setIntent(modelIntentDecision.intent, modelIntentDecision.confidence, "model")
        }
        session.modelIntentDecision = modelIntentDecision

        // 对象指认：与 TimingGate 共享同一套「这句话在回谁」信号，主链路据此决定接话姿态
        const smartStateForSignal = this.getSmartState(groupId)
        const mainQuotesBot = messageQuotesUser(e, Bot.uin)
        session.addresseeSignal = computeAddresseeSignal({
          e,
          botId: Bot.uin,
          mentionsBotName: hasBotTextAnchor(String(e?.msg || ""), Bot.nickname || "机器人", this.config.triggerPrefixes),
          quotesBot: mainQuotesBot,
          sameUserAsLastReply: Boolean(smartStateForSignal?.lastBotReplyToUserId && String(userId) === String(smartStateForSignal.lastBotReplyToUserId)),
          prefilterKind: e?._prefilterKind || "regular"
        })
        const addresseePrompt = buildAddresseePrompt(session.addresseeSignal)

        // 分层画像：闲聊只喂保底层，任务/知识/带素材回合注入全部层（依据前置的意图判定）
        session.promptLayerProfile = resolvePromptLayerProfile({
          responseKind: isEducationalExplanationRequest(currentIntentText) ? "knowledge" : "chat",
          modelIntent: modelIntentDecision?.intent || "",
          requiredToolNames: intentToolCandidates,
          hasImages: Boolean(images?.length),
          hasVideos: Boolean(videos?.length)
        })

        // 上一轮任务摘要：同一用户 10 分钟内的工具/回复延续，防止反复认图、反复确认
        const lastTurnContinuity = await loadTurnContinuity({ redis: globalThis.redis, groupId, userId }).catch(() => null)
        const turnContinuityPrompt = buildTurnContinuityPrompt(lastTurnContinuity)
        if (lastTurnContinuity) logger.info(`[任务延续] group=${groupId} user=${userId} 注入上一轮摘要 intent=${lastTurnContinuity.intent} tools=${(lastTurnContinuity.tools || []).length}`)

        const userContent = await this.buildMessageContent(e.sender, args, images, atQq, e.group, e)
        const knowledgeContext = {
          text: e.msg || args,
          messageSegments: e.message || [],
          memberMap,
          fileAssets: groupContextAssets.files || [],
          creatorQQ: userId,
          creatorDisplay: memberMap?.get?.(Number(userId))?.card || memberMap?.get?.(Number(userId))?.nickname || e.sender?.card || e.sender?.nickname || '',
          botId: Bot.uin,
          sourceMessageId: e.message_id,
          isGroupManager: Boolean(e.isMaster || ['owner', 'admin'].includes(e.sender?.role) || ['owner', 'admin'].includes(memberInfo?.role))
        }
        const groupMemoryCommitPromise = groupId && this.config.memorySystem?.enabled
          ? this.memoryManager.interpretGroupKnowledgeInstruction(knowledgeContext)
            .then(decision => {
              if (decision?.status !== 'accepted') return decision
              return this.memoryManager.commitGroupMemoryDecision(groupId, decision, {
                ...knowledgeContext,
                requesterQQ: userId,
                isGroupManager: knowledgeContext.isGroupManager
              })
            })
            .catch(error => {
              logger.warn(`[群知识] 语义提交失败 group=${groupId}: ${error.message}`)
              return { status: 'unavailable', knowledgeEntries: [], workflowRules: [], aliasMappings: [] }
            })
          : Promise.resolve({ status: 'ignored', knowledgeEntries: [], workflowRules: [], aliasMappings: [] })
        // Shared-memory adjudication is deliberately off the critical reply path. A
        // very short window preserves natural confirmation for fast decisions; after
        // that the main reply continues and must not claim the write succeeded.
        const inlineWaitMs = Math.max(0, Math.min(1000, Number(this.config.memorySystem?.knowledgeDecisionInlineWaitMs) || 180))
        const inlineGroupMemoryCommit = await Promise.race([
          groupMemoryCommitPromise,
          delay(inlineWaitMs).then(() => null)
        ])
        groupMemoryCommitPromise.then(result => {
          if (result?.status !== 'accepted') return
          const savedKnowledge = result.knowledgeEntries || []
          const savedWorkflows = result.workflowRules || []
          if (savedKnowledge.length) logger.info(`[群知识] group=${groupId} committed=${savedKnowledge.length}`)
          if (savedWorkflows.length) logger.info(`[群工作流] group=${groupId} committed=${savedWorkflows.length}`)
        }).catch(() => {})
        const savedKnowledgeEntries = inlineGroupMemoryCommit?.status === 'accepted'
          ? (inlineGroupMemoryCommit.knowledgeEntries || []) : []
        const savedWorkflowRules = inlineGroupMemoryCommit?.status === 'accepted'
          ? (inlineGroupMemoryCommit.workflowRules || []) : []
        if (savedKnowledgeEntries.length) recordActionOutcomes(session, "group_knowledge", savedKnowledgeEntries)
        if (savedWorkflowRules.length) recordActionOutcomes(session, "group_workflow", savedWorkflowRules)
        const workflowTeachingPrompt = formatGroupWorkflowTeachingPrompt(savedWorkflowRules)
        const knowledgeTeachingPrompt = formatGroupKnowledgeTeachingPrompt(savedKnowledgeEntries)
        const memberLookupPrompt = formatMemberLookupPrompt(
          matchGroupMembersByTerms(memberMap, extractMemberLookupTerms(e.msg || args), userId)
        )
        const identityBindingsPrompt = formatIdentityBindingsPrompt(this.config.identityBindings, userId)

        if (groupId && this.config.memorySystem?.enabled && this.config.identityBindings?.length) {
          this._seededGroups ??= new Set()
          if (!this._seededGroups.has(groupId)) {
            this._seededGroups.add(groupId)
            this.memoryManager.seedFromConfig(groupId, this.config.identityBindings)
              .catch(err => logger.error('[MemoryManager] config seed 失败:', err))
          }
        }

        const getHighLevelMembers = async group => {
          if (!group) return ""
          const members = memberMap || await group.getMemberMap()
          return Array.from(members.values())
            .filter(m => ["admin", "owner"].includes(m.role))
            .map(m => `${formatMemberDisplayName(m)}(QQ号: ${m.user_id})[群身份: ${roleMap[m.role]}]`)
            .join("\n")
        }

        const mcpPrompts = mcpManager.getMCPSystemPrompts({
          messageType: e.message_type,
          groupId: e.group_id,
          message: e.msg
        })
        // 提示词分层组装：19 层取数/裁剪/拼装统一交给 turnPromptComposer
        //（层并发读取、单层失败降级为空、产出每层字符数 report）。
        // 依赖回合早期状态的层（身份绑定/教学/成员查询/合并触发）经 precomputed 传入。
        // 构建增强系统提示。群公告/管理员信息体量很大，只在问群规则/成员时注入。
        const includeGroupContext = shouldInjectGroupContext(e.msg || args) || Boolean(memberLookupPrompt)
        const groupContext = includeGroupContext
          ? await this.getCurrentGroupContext(e)
          : this.getBasicGroupContext(e)
        const cardRequestText = [args, msg, userContent].filter(Boolean).join("\n")
        const promptLayers = await composeTurnPromptLayers({
          config: this.config,
          profile: session.promptLayerProfile,
          turn: {
            groupId,
            userId,
            event: e,
            messageText: e.msg || args,
            memoryText: e.msg || "",
            rawMessageText: e.msg || "",
            toneText: [args, msg, userContent, e?._quotedPromptContext?.text].filter(Boolean).join("\n"),
            cardText: cardRequestText,
            cardResponseKind: isEducationalExplanationRequest(cardRequestText) ? "knowledge" : "chat"
          },
          precomputed: {
            identityBindings: identityBindingsPrompt,
            workflowTeaching: workflowTeachingPrompt,
            knowledgeTeaching: knowledgeTeachingPrompt,
            memberLookup: memberLookupPrompt,
            mergedTrigger: this.buildMergedDirectTriggerPrompt(e)
          },
          deps: {
            emotionManager: this.emotionManager,
            memoryManager: this.memoryManager,
            expressionLearner: this.expressionLearner,
            knowledgeSearcher: this.knowledgeSearcher,
            personaFeedbackManager,
            globalStyleLearnerManager,
            personProfileInjector
          }
        })
        // 语义工具规划器复用群工作流层文本
        const workflowPrompt = promptLayers.layerValues.workflow || ''
        session.promptLayerReport = promptLayers.report
        const groupTopicPrompt = getGroupTopicPrompt(groupId)
        const groupSocialPrompt = getGroupSocialPrompt(groupId)
        // 时间指代（上次/昨天/那天…）触发情节回放，接住跨天指代
        const episodicPrompt = this.config?.episodicMemory?.enabled !== false && hasTemporalDeixis(currentIntentText)
          ? buildEpisodicPrompt(recallEpisodes({
              groupId,
              terms: extractChatKeywords(currentIntentText, 6),
              days: Number(this.config?.episodicMemory?.recallDays) || 7,
              limit: 5
            }))
          : ""
        if (episodicPrompt) logger.info(`[情节回忆] group=${groupId} 命中时间指代，注入近期情节`)
        // 记忆回勾：闲聊档注入这位群友自己的旧情节（跨天），让她能自然想起旧账
        const callbackPrompt = this.config?.episodicMemory?.enabled !== false &&
          this.config?.episodicMemory?.proactiveEnabled !== false &&
          session.promptLayerProfile?.profile === "chat" && e?.user_id
          ? buildUserCallbackPrompt(recallUserEpisodes({
              groupId,
              userId: e.user_id,
              days: Number(this.config?.episodicMemory?.recallDays) || 7,
              limit: 2,
              minAgeMs: 30 * 60 * 1000
            }), { userName: e?.sender?.card || e?.sender?.nickname || "" })
          : ""
        if (callbackPrompt) logger.info(`[记忆回勾] group=${groupId} user=${e?.user_id} 注入旧话题 ${callbackPrompt.length}c`)
        const enhancedPrompts = [promptLayers.prompt, addresseePrompt, turnContinuityPrompt, groupTopicPrompt, groupSocialPrompt, episodicPrompt, callbackPrompt].filter(Boolean).join('\n')
        const runtimeGroupInfo = {
          group_id: groupContext.groupId,
          group_name: groupContext.groupName
        }
        if (includeGroupContext) {
          runtimeGroupInfo.group_notice = groupContext.groupNotice
          runtimeGroupInfo.administrators = await getHighLevelMembers(e.group)
        }
        const runtimeData = {
          group_info: runtimeGroupInfo,
          environmental_factors: { local_time: "北京时间: " + new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) }
        }

        const systemContent = buildMainSystemPrompt({
          baseIdentity: renderPersonaTemplate(this.config.systemContent, this.config.persona),
          personaOverride: buildPersonaStyleOverride(this.config.persona),
          runtimeData,
          enhancedPrompts,
          mcpPrompts,
          personaName: resolvePersonaName(this.config.persona)
        })
        // 获取历史记录
        if (this.config.groupHistory) {
          const chatHistory = await this.messageManager.getMessages(e.message_type, e.message_type === "group" ? e.group_id : e.user_id)

          if (chatHistory?.length) {
            const historyMemberMap = memberMap || await e.bot.pickGroup(groupId).getMemberMap()

            // 使用 message_id 过滤当前消息
            const currentMessageId = e.message_id

            groupUserMessages = await Promise.all(chatHistory
              .reverse()
              .filter(msg => {
                // 直接用 message_id 判断，过滤掉当前消息
                if (msg.message_id === currentMessageId) {
                  logger.debug(`[历史去重] 过滤当前消息: message_id=${msg.message_id}`)
                  return false
                }
                if (msg.source === "tool" || String(msg.content || "").includes("此处为调用工具的结果")) {
                  logger.debug(`[历史过滤] 跳过工具结果记录: message_id=${msg.message_id || ""}`)
                  return false
                }
                if (String(msg.sender?.user_id) === String(Bot.uin) && containsInternalStatusLeak(msg.content)) {
                  logger.debug(`[历史过滤] 跳过内部状态泄漏回复: message_id=${msg.message_id || ""}`)
                  return false
                }
                return true
              })
              .map(msg => ({
                role: msg.sender.user_id === Bot.uin ? "assistant" : "user",
                messageId: msg.message_id,
                userId: msg.sender.user_id,
                content: `[${msg.time}] ${formatMemberDisplayName(historyMemberMap.get(Number(msg.sender.user_id)), msg.sender.nickname)}(QQ号:${msg.sender.user_id})[群身份: ${roleMap[msg.sender.role] || "member"}]${msg.message_id ? `[消息ID:${msg.message_id}]` : ''}: ${msg.content}`
              }))
            )
            groupUserMessages = await Promise.all(groupUserMessages.map(async msg => {
              const taskStatus = msg.messageId ? await this.getTaskStatus(groupId, msg.messageId) : null
              const statusText = this.formatTaskStatusForPrompt(taskStatus)
              return statusText ? { ...msg, content: `${msg.content}\n${statusText}` } : msg
            }))
            const intelligence = this.config.agentIntelligence || {}
            const historyBudget = resolveHistorySelectionBudget(intelligence, {
              compact: shouldUseCompactHistory({
                text: joinIntentParts(args, msg),
                images,
                videos,
                quotedText: e?._quotedPromptContext?.text || repliedMessage?.message || ""
              })
            })
            const originalHistoryCount = groupUserMessages.length
            if (intelligence.enabled !== false) {
              groupUserMessages = selectRelevantGroupHistory(groupUserMessages, {
                query: [args, msg, userContent, e?._quotedPromptContext?.text].filter(Boolean).join("\n"),
                replyMessageId: e?._quotedPromptContext?.messageId,
                currentUserId: userId,
                botId: Bot.uin,
                recentCount: historyBudget.recentCount,
                relevantCount: historyBudget.relevantCount,
                maxMessages: historyBudget.maxMessages
              })
            }
            session.historySelectionMode = historyBudget.mode
            session.selectedGroupHistoryCount = groupUserMessages.length
            if (groupUserMessages.length < originalHistoryCount) {
              logger.info(`[上下文选择] group=${groupId} mode=${historyBudget.mode} selected=${groupUserMessages.length}/${originalHistoryCount} recent=${groupUserMessages.filter(item => item.contextSection === "recent").length} relevant=${groupUserMessages.filter(item => item.contextSection === "relevant").length}`)
            }
          }
        }

        const understandingPrompt = session.promptLayerProfile?.profile === "chat"
          ? ""
          : await this.resolveUnderstandingPrompt({
          e,
          args,
          msg,
          userContent,
          images,
          videos,
          session,
          currentIntentText: joinIntentParts(args, msg),
          groupUserMessages
        })

        groupUserMessages = groupUserMessages.filter(m => m.role !== "system")
        groupUserMessages.unshift({ role: "system", content: systemContent })
        if (understandingPrompt) {
          groupUserMessages.splice(1, 0, { role: "system", content: understandingPrompt })
        const drawFailureNoteMessage = buildDrawFailureNoteMessage(takeDrawFailureNote(e.group_id))
        if (drawFailureNoteMessage) {
          groupUserMessages.splice(2, 0, { role: "system", content: drawFailureNoteMessage })
          logger.info(`[画图失败标记] group=${e?.group_id || ""} 已注入上一轮画图失败提示`)
        }
        }
        groupUserMessages.push({ role: "user", content: userContent })
        session.userContent = userContent
        groupUserMessages = this.trimMessageHistory(groupUserMessages)
        groupUserMessages = this.filterChatByQQ(groupUserMessages, e.user_id)
        session.groupUserMessages = this.formatMessages(groupUserMessages, e, userContent)

        // ── 工具路由:16 条规则由 routeDecision 规则表顺序裁决 ──
        // (原 16 个顺序 if 块的逐字等价转写;复制粘贴产生的"识图强制路由"死代码块已删除;
        //  守卫次序、锁语义、session 写入次序均保留,第二刀的顺序调整另行讨论)
        const hasExcelContext = hasExcelWorkbookContext({
          text: userContent,
          media: groupContextAssets?.media
        })
        const hasPixivSearchSession = hasRecentPixivSearch({ group_id: groupId, user_id: userId })
        const excelToolIntent = shouldUseExcelWorkbookTool(currentIntentText, { hasExcelContext })
        const excelToolParams = buildExcelToolParams(currentIntentText, { hasExcelContext })
        const emojiCooldownMs = Number(this.config?.emojiSystem?.emojiCooldownMs ?? 120000)
        route = await resolveToolRoute({
          intentText: currentIntentText,
          rawMsg: msg,
          args,
          modelIntent: modelIntentDecision?.intent,
          images, videos, groupId, userId,
          botName: Bot?.nickname || "",
          config: this.config,
          memberMap,
          hasExcelContext, excelToolIntent, excelToolParams, hasPixivSearchSession,
          groupWorkflowPrompt: workflowPrompt,
          emojiCooldownMs,
          session,
          promptContext: () => ({ e, args, msg, currentIntentText, userContent, groupUserMessages: session.groupUserMessages }),
          imageGenerationReferenceImages: () => this.getImageGenerationReferenceImages(images, session),
          applyTools: names => { session.tools = this.getToolsByName(names); return session.tools },
          log: text => logger.info(text),
          helpers: {
            resolveSingularOwnerMention,
            resolveForcedReplyTextRate: gid => this.resolveForcedReplyTextRate(gid),
            buildForcedToolCall: (name, params) => this.buildForcedToolCall(name, params),
            buildToolCallFromDecision: (decision, context) => this.buildToolCallFromDecision(decision, context),
            buildImageEditPrompt: context => this.buildImageEditPrompt(context),
            buildImageGenerationPrompt: context => this.buildImageGenerationPrompt(context),
            resolveContextualDrawGeneration: context => this.resolveContextualDrawGeneration(context),
            classifySemanticToolIntent: context => this.classifySemanticToolIntent(context),
            semanticSessionTools: () => images?.length
              ? session.tools
              : (session.tools || []).filter(tool => !["googleImageEditTool", "googleImageAnalysisTool"].includes(tool?.function?.name))
          }
        })
        if (route.warn) logger.warn(route.warn)
        if (route.aborted === "no-banana-channel") {
          await this.sendSegmentedMessage(e, buildImageFailureReply("图片生成失败: 当前没有可用的图片生成渠道"), 0)
          recordDrawTextFallback(groupId, currentIntentText)
          this.clearSession(sessionId)
          return true
        }
        let toolChoice = route.toolChoice
        let forcedToolCall = route.forcedToolCall
        let toolScopeLocked = route.toolScopeLocked

        // 强制抢红包模式
        if (e.forceGrabRedBag) {
          session.tools = this.getToolsByName(["grabRedBagTool"])
          if (session.tools?.length) toolChoice = { type: "function", function: { name: "grabRedBagTool" } }
        }

        if (!toolScopeLocked && toolChoice === "auto") {
          const beforeToolCount = session.tools?.length || 0
          session.tools = filterToolsForMessageIntent(session.tools, e, args, { allowSearch: modelIntentDecision?.intent === "search", emojiCooldownMs: Number(this.config?.emojiSystem?.emojiCooldownMs ?? 120000) })
          if (!session.tools.length) {
            toolChoice = "none"
          } else if (session.tools.length === 1 && session.tools[0]?.function?.name === "sendLocalEmojiTool") {
            logger.info(`[工具选择] group=${groupId} 轻松闲聊仅启用 sendLocalEmojiTool`)
          } else if (session.tools.length !== beforeToolCount) {
            logger.info(`[工具选择] group=${groupId} 按需启用 ${session.tools.length}/${beforeToolCount} 个工具`)
          }
        }

        const availableToolNames = (session.tools || []).map(tool => tool?.function?.name).filter(Boolean)
        const requestedActionCapabilities = selectToolIntentCandidates(currentIntentText, availableToolNames)
        const turnPlan = createTurnPlan({
          responseKind: isEducationalExplanationRequest(currentIntentText) ? "knowledge" : "chat",
          intentText: currentIntentText,
          availableCapabilities: availableToolNames,
          requiredCapabilities: requestedActionCapabilities,
          toolChoice,
          toolScopeLocked,
          forcedToolCall,
          explicitEmojiRequest: classifyEmojiToolExposure(currentIntentText) === "explicit",
          historyMode: session.historySelectionMode,
          selectedHistoryCount: session.selectedGroupHistoryCount
        })
        session.turnPlan = turnPlan
        session.cardPresentation = resolveCardPresentation(currentIntentText, turnPlan.presentation.kind)
        session.initialExecutionRoute = {
          mode: turnPlan.execution.mode,
          reason: turnPlan.observability.routeReason
        }
        const turnPlanRequest = deriveTurnPlanRequest(turnPlan, this.config)
        if (turnPlan.execution.mode === "tool") {
          const initialToolNames = turnPlan.capabilities.required.length
            ? turnPlan.capabilities.required
            : turnPlan.capabilities.optional
          session.tools = this.getToolsByName(initialToolNames)
          logger.info(`[执行计划] group=${groupId} ${formatTurnPlanLog(turnPlan)} tools=${initialToolNames.join(",")}`)
        } else if (session.tools?.length) {
          logger.info(`[执行计划] group=${groupId} ${formatTurnPlanLog(turnPlan)} optional=${turnPlan.capabilities.optional.join(",")}`)
          session.tools = []
        }
        toolChoice = turnPlanRequest.toolChoice

        const botMemberMap = await e.bot.pickGroup(groupId).getMemberMap()
        const botRole = roleMap[botMemberMap.get(Bot.uin)?.role] || "member"
        session.toolContent = await this.buildMessageContent({ nickname: Bot.nickname, user_id: Bot.uin, role: botRole }, "", [], [], e.group)

        if (forcedToolCall) {
          await this.processToolCalls({ role: "assistant", tool_calls: [forcedToolCall] }, e, session, session.groupUserMessages, atQq, senderRole, { syntheticToolCall: true })
          this.clearSession(sessionId)
          return true
        }

        const acknowledgement = cardAcknowledgement(session.cardPresentation)
        if (acknowledgement) {
          outboundArbiter.beginToolOutcomes()
          outboundArbiter.enqueue("commitment", () => this.sendSegmentedMessage(e, acknowledgement, 0))
          session.cardAcknowledged = true
          logger.info(`[卡面呈现] 承诺类确认已入队（工具结果决出后放行） kind=${session.cardPresentation}`)
        }

	        // 语义规划器没强制调用时,主模型是唯一决策者——但它平时看不到任何工具
	        // 抽取规则,不同群的上下文会让它摇摆(反问澄清/换错工具)。把候选工具的
	        // 披露说明注入本轮请求,让主模型和规划器看到同一套规则。
	        const toolNamesForRequest = (session.tools || []).map(tool => tool?.function?.name).filter(Boolean)
	        const disclosureForMainModel = buildToolIntentDisclosure(toolNamesForRequest)
	        const requestMessages = disclosureForMainModel
	          ? [...session.groupUserMessages, { role: "system", content: disclosureForMainModel }]
	          : session.groupUserMessages
	        const requestData = buildChatRequestData(this.config, requestMessages, session.tools, toolChoice)
            const initialModelStartedAt = Date.now()
	        let response = await this.retryRequest(requestData, session.toolContent, 1, undefined, turnPlanRequest.requestOptions)
	        session?.turnTrace?.addModelCall("main", Date.now() - initialModelStartedAt)
	        logger.info(`[模型耗时] group=${groupId} stage=initial ${formatTurnPlanLog(session.turnPlan)} toolChoice=${typeof toolChoice === "string" ? toolChoice : toolChoice?.function?.name || "auto"} history=${session.selectedGroupHistoryCount || 0} mode=${session.historySelectionMode || "full"} elapsed=${Date.now() - initialModelStartedAt}ms`)

	        if (!response?.choices?.[0]) {
		          if (response?.error) {
			            const errorText = typeof response.error === "string"
			              ? response.error
			              : response.error?.message || JSON.stringify(response.error)
			            logger.warn(`[回复失败] group=${groupId} user=${userId} stage=initial_api toolChoice=${typeof toolChoice === "string" ? toolChoice : toolChoice?.function?.name || "auto"} merged=${e?._mergedMessageCount || 0} error=${errorText}`)
			            const failedToolName = session.toolName || session.tools?.[0]?.function?.name || ""
			            await this.sendSegmentedMessage(e, this.getFriendlyFailureMessage(failedToolName, {
			              e,
			              session,
			              stage: "initial_api",
			              error: errorText,
			              toolChoice
			            }), 0)
			          }
		          else {
		            logger.warn(`[回复失败] group=${groupId} user=${userId} stage=initial_api_empty toolChoice=${typeof toolChoice === "string" ? toolChoice : toolChoice?.function?.name || "auto"} merged=${e?._mergedMessageCount || 0} reason=no_choices`)
		            await this.sendSegmentedMessage(e, this.getFriendlyFailureMessage("", {
		              e,
		              session,
		              stage: "initial_api_empty",
		              error: "回答服务没有返回有效内容",
		              toolChoice
		            }), 0)
		          }
	          this.clearSession(sessionId)
	          return true
	        }

        const message = response.choices[0].message || {}
        // 分发模型回答(tool_calls / 文本);空消息时若走了紧凑快后端,先换主模型重试一次
        // ——思考型模型的 thinking 计入 max_tokens,快后端小额度可能被思考耗光导致正文为空
        const dispatchAssistantMessage = async target => {
          if (target.tool_calls?.length) {
            await this.processToolCalls(target, e, session, session.groupUserMessages, atQq, senderRole)
          } else if (target.content) {
            const missingToolCall = this.buildMissingToolCommitmentCall(target.content, {
              e,
              args,
              msg,
              images,
              currentIntentText,
              userContent,
              groupUserMessages: session.groupUserMessages
            })
            if (missingToolCall) {
              session.tools = missingToolCall.tools
              logger.warn(`[工具漏调守卫] 模型承诺执行但未调用工具，强制使用 ${missingToolCall.toolName} reason=${missingToolCall.reason}`)
              await this.processToolCalls({ role: "assistant", tool_calls: [missingToolCall.toolCall] }, e, session, session.groupUserMessages, atQq, senderRole, { syntheticToolCall: true })
            } else {
              await this.handleTextResponse(target.content, e, session, session.groupUserMessages)
            }
            return true
          }
          return false
        }

        if (message.tool_calls?.length || message.content) {
          await dispatchAssistantMessage(message)
        } else if (turnPlanRequest.requestOptions?.taskBackend) {
          logger.warn(`[回复失败] group=${groupId} user=${userId} stage=initial_message_empty backend=${turnPlanRequest.requestOptions.taskBackend} reason=no_content_or_tool_calls 换主模型重试`)
          const retryStartedAt = Date.now()
          const retryResponse = await this.retryRequest(requestData, session.toolContent, 1, undefined, {
            forceChatBackend: true,
            routeLabel: "空消息重试主模型"
          })
          session?.turnTrace?.addModelCall("main_retry", Date.now() - retryStartedAt)
          const retryMessage = retryResponse?.choices?.[0]?.message || {}
          if (retryMessage.tool_calls?.length || retryMessage.content) {
            await dispatchAssistantMessage(retryMessage)
          } else {
            logger.warn(`[回复失败] group=${groupId} user=${userId} stage=initial_message_empty_retry reason=no_content_or_tool_calls`)
            await this.sendSegmentedMessage(e, this.getFriendlyFailureMessage("", {
              e,
              session,
              stage: "initial_message_empty",
              error: "回答服务返回了空消息",
              toolChoice
            }), 0)
          }
        } else {
          logger.warn(`[回复失败] group=${groupId} user=${userId} stage=initial_message_empty reason=no_content_or_tool_calls`)
          await this.sendSegmentedMessage(e, this.getFriendlyFailureMessage("", {
            e,
            session,
            stage: "initial_message_empty",
            error: "回答服务返回了空消息",
            toolChoice
          }), 0)
        }

        this.clearSession(sessionId)
        return true

      } catch (error) {
        console.error(`[工具插件] 会话 ${sessionId} 执行异常：`, error)
        const committedReply = buildCommittedActionReply(session)
        if (committedReply && !session.responseAttempted) {
          await this.sendSegmentedMessage(e, committedReply, 0).catch(() => {})
        }
        this.clearSession(sessionId)
        return true
	      } finally {
	        outboundArbiter.settle(session.turnPlan?.outcomes || [])
	        const traceRecord = turnTrace.finish()
	        await this.finishConversationTask(taskContext, session)
	        const totalElapsed = Date.now() - handleToolStartAt
	        logger.info(`[对话耗时] group=${e?.group_id || ""} user=${e?.user_id || ""} ${formatTurnPlanLog(session.turnPlan)} total=${totalElapsed}ms merged=${e?._mergedMessageCount || 0}`, { turnId: e?._turnId })
	        if (e.group_id && !e._longRunningToolTask) this.recordReplyLatency(e.group_id, totalElapsed)
	        // 回合诊断留存:供 #希洛调试 命令回显(纯观测,不影响主链路)
	        recordTurnDiagnostics({
	          groupId: e?.group_id,
	          userId: e?.user_id,
	          turnId: e?._turnId,
	          promptLayerReport: session.promptLayerReport,
	          routeApplied: route?.applied || [],
	          routeToolChoice: route?.toolChoice,
	          turnPlan: formatTurnPlanLog(session.turnPlan),
	          modelCalls: traceRecord?.modelCalls || [],
	          tools: traceRecord?.tools || []
	        })
	      }
    })
  }

  formatMessages(messages, e, currentUserContent = null) {
    if (!messages?.length) return messages

    const systemMsgs = messages.filter(m => m.role === "system")
    const lastUser = messages[messages.length - 1]?.role === "user" ? [messages[messages.length - 1]] : []
    const middle = messages
      .slice(systemMsgs.length, messages.length - lastUser.length)
      .filter(message => !String(message?.content || "").startsWith("【系统提示】"))
    const historyContext = buildStructuredHistoryMessage(middle)

    return [
      ...systemMsgs,
      historyContext,
      ...lastUser
    ].filter(Boolean)
  }

  /**
   * 格式化工具返回结果（截断过长内容）
   */

	  async retryRequest(requestData, toolContent, retries = 1, toolName, options = {}) {
	    return executeChatRequestWithRecovery(
	      currentRequest => YTapi(currentRequest, this.config, toolContent, toolName, options),
	      requestData,
	      {
	        retries,
	        onRetry: ({ failure, requestData: retryData, retriesLeft }) => {
	          const choice = typeof retryData?.tool_choice === "string"
	            ? retryData.tool_choice
	            : retryData?.tool_choice?.function?.name || "auto"
	          logger.warn(`[API重试] kind=${failure.kind} status=${failure.status || ""} toolChoice=${choice} retriesLeft=${retriesLeft}`)
	        }
	      }
	    )
	  }

  getFriendlyFailureMessage(toolName = "", context = {}) {
    const committedReply = buildCommittedActionReply(context?.session)
    if (committedReply) return committedReply
    if (toolName === "mentionMembersTool") {
      return buildMentionMembersFailureReply(context?.error || context?.failedResult || "")
    }
    if (toolName === "bananaTool") {
      const errorText = String(context?.error || context?.failedResult || "")
      return buildImageFailureReply(errorText)
    }
    if (toolName === "googleImageAnalysisTool") {
      return appendVisibleFailureDetail(
        "图片我收到了，但这次识图服务没有返回可用结果。不是你没发图，我先不乱猜。",
        context?.error || context?.failedResult || ""
      )
    }
    if (toolName === "googleImageEditTool") {
      const errorText = String(context?.error || context?.failedResult || "")
      return buildImageFailureReply(errorText, { operation: "edit" })
    }
    if (toolName === "searchInformationTool" || toolName === "webParserTool" || toolName === "githubRepoTool") {
      return appendVisibleFailureDetail(
        "你的问题我收到了，但检索服务这次没有完成。我不拿不完整的结果凑答案，也不会说成是你没发清楚。",
        context?.error || context?.failedResult || ""
      )
    }
    if (toolName === "deltaForceTool") {
      const text = String(context?.error || context?.failedResult || "").replace(/^error:\s*/i, "").replace(/^工具\s+deltaForceTool\s+执行失败:\s*/i, "").trim()
      return text ? `三角洲查询失败：${buildVisibleFailureDetail(text)}` : "三角洲接口这次没查成，但你的查询条件已经收到了。"
    }
    if (toolName === "modrinthTool") {
      return appendVisibleFailureDetail(
        "Modrinth 排名数据已经查到，但简介翻译服务这次没有返回完整结果。我先不把缺字段或错位译文发出来。",
        context?.error || context?.failedResult || ""
      )
    }
    if (toolName === "torrentDownloadTool") {
      const rawFailure = String(context?.error || context?.failedResult || "")
        .replace(/^error[:：]\s*/i, "")
        .replace(/^工具\s+torrentDownloadTool\s+执行失败[:：]\s*/i, "")
      const detail = rawFailure.trim()
        ? buildVisibleFailureDetail(rawFailure, { fallback: "没有拿到可下载的文件" })
        : ""
      return detail ? `这个磁链没有开始或完成下载：${detail}` : "这个磁链没有完成下载，我不会把未完成的文件说成已经发出。"
    }

    const userText = [
      context?.session?.rawArgs,
      context?.session?.userContent,
      context?.e?.msg
    ].filter(Boolean).join("\n")
    const failure = classifyChatRequestFailure({ error: context?.error || context?.failedResult || "" })
    return buildGenericChatFailureReply(userText, {
      isGreeting: isCasualBotGreeting(userText),
      failureKind: failure?.kind || "unknown",
      failureDetail: buildVisibleChatFailureDetail(context?.error || context?.failedResult || "")
    })
  }

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
  resolveChatCompletionUrl(...args) { return resolveChatCompletionUrl(this, ...args) }
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

  async handleTextResponse(content, e, session, messages, toolName) {
    let output = await this.processToolSpecificMessage(content, toolName)
    if (!output) {
      logger.warn("[最终回复清理] 模型回复只包含伪工具格式，已跳过发送")
      return
    }
    const cleaned = redactInternalStatusLeaks(output)
    if (cleaned.redactedChars > 0) {
      if (cleaned.heavy) {
        logger.warn(`[最终回复清理] 内部信息占比过高(${cleaned.kinds.join(",")} ${(cleaned.ratio * 100).toFixed(0)}%)，整段回退: ${output.slice(0, 120)}`)
        output = buildInternalStatusSafeReply(toolName, session)
      } else {
        logger.warn(`[最终回复清理] 已脱敏内部片段(${cleaned.kinds.join(",")} ${cleaned.redactedChars}字)，保留其余回复`)
        output = cleaned.text
      }
    }
    const modrinthItems = toolName === "modrinthTool" ? extractModrinthForwardItems(output) : []
    const modrinthCardItems = modrinthItems.length && Array.isArray(session?.modrinthCardItems)
      ? session.modrinthCardItems
      : []
    if (session?.modrinthCardItems) session.modrinthCardItems = null
    if (toolName === "modrinthTool") output = stripModrinthForwardMarkers(output)
    if (!modrinthItems.length) {
      output = applyOutputPersonaGuards(output, {
        userText: session?.userContent || e?.msg || "",
        toolName,
        botNames: [Bot?.nickname, this.config?.persona?.name],
        personaGuard: this.config.personaGuard,
        polish: true
      })
    } else {
      output = modrinthItems.join("\n\n")
    }
    if (!output) {
      logger.warn("[最终回复清理] 风格拦截后回复为空，已跳过发送")
      return
    }
    const narrativeReply = !modrinthItems.length
      ? splitNarrativeReply(output, session?.userContent || e?.msg || "")
      : null
    if (narrativeReply?.lead) {
      output = narrativeReply.story
      logger.info(`[叙事呈现] 已剥离模型开场 lead=${narrativeReply.lead.length} story=${output.length}`)
    }
    const textImageTemplate = !modrinthItems.length && this.getTextImageTemplateForFinalReply({
      content,
      output,
      session,
      toolName,
      e
    })
    session.responseAttempted = true
    const botMessageId = modrinthItems.length
      ? modrinthCardItems.length === modrinthItems.length
        ? await this.sendModrinthForwardCards(e, modrinthCardItems)
        : await this.sendModrinthForwardItems(e, modrinthItems)
      : narrativeReply?.lead
        ? await this.sendFinalReplyAsTextImage(e, output, "document")
        : textImageTemplate
        ? await this.sendFinalReplyAsTextImage(e, output, textImageTemplate)
        : await this.sendSegmentedMessage(e, output, 0.5, { alreadyGuarded: true })

    // 画图请求最终走了纯文字回复且本回合没有出图：给下一轮留失败标记，让模型能接住用户的不满
    if (session?.turnDrawRequested && e.group_id) {
      try {
        const delivered = await findRecentBotImage(e, { botId: Bot.uin, maxAgeMs: 90000, limit: 12 })
        if (delivered) {
          clearDrawFailureNote(e.group_id)
        } else {
          recordDrawTextFallback(e.group_id, session.rawArgs || session.userContent || e?.msg || "")
          logger.info(`[画图失败标记] group=${e.group_id} 画图请求只得到文字回复，已记录失败标记`)
        }
      } catch (noteError) {
        logger.warn(`[画图失败标记] group=${e.group_id} 记录失败: ${noteError?.message || noteError}`)
      }
    }

    // 轮末延续摘要：同用户 10 分钟内再来说话时注入上一轮做了什么、回了什么
    session.lastFinalReply = String(output || "").slice(0, 240)
    if (this.config?.episodicMemory?.enabled !== false && e?.group_id) {
      recordEpisode({
        groupId: e.group_id,
        userId: e?.user_id,
        userName: e?.sender?.card || e?.sender?.nickname || "",
        summary: String(session?.userContent || e?.msg || "").slice(0, 120),
        reply: session.lastFinalReply,
        maxPerGroup: Number(this.config?.episodicMemory?.maxPerGroup) || 200
      })
    }
    await recordTurnContinuity({
      redis: globalThis.redis,
      groupId: e?.group_id,
      userId: e?.user_id,
      intent: session?.modelIntentDecision?.intent || "",
      route: session?.initialExecutionRoute?.mode || "",
      tools: (session?.turnPlan?.outcomes || []).map(outcome => `${outcome.toolName}${outcome.success === false ? "(失败)" : "(成功)"}`).slice(0, 6),
      lastReply: session.lastFinalReply
    }).catch(() => {})

    // 更新会话追踪中的对话历史
    if (this.config.conversationTrackingEnabled && e.group_id && e.user_id) {
      const conversationKey = `${e.group_id}_${e.user_id}`
      const activeConv = activeConversations.get(conversationKey)
      if (activeConv) {
        // 获取当前对话历史
        let chatHistory = activeConv.chatHistory || []

        // 添加用户消息
        const senderRole = roleMap[e.sender?.role] || "member"
        const senderName = e.sender?.card || e.sender?.nickname || "未知用户"
        const userMsg = `${this.formatTime()} ${senderName}(qq号: ${e.user_id})[群身份: ${senderRole}]: 在群里说: ${safeTruncateUnicode(session.userContent || e.msg || '', 200)}`
        chatHistory.push({ role: 'user', content: userMsg })

        // 添加机器人回复
        const botMsg = `${this.formatTime()} ${Bot.nickname}(qq号:${Bot.uin})[群身份: member]: 在群里说: ${safeTruncateUnicode(output, 200)}`
        chatHistory.push({ role: 'bot', content: botMsg })

        // 只保留最近10条
        if (chatHistory.length > 10) {
          chatHistory = chatHistory.slice(-10)
        }

        // 重置定时器并更新数据
        this.setTrackingWithTimer(conversationKey, { chatHistory })
      }
    }

    const now = Math.floor(Date.now() / 1000)

    try {
      // 工具结果只保留在本轮上下文和日志中，不写入群聊历史，避免后续普通回复泄露内部状态。
      await this.messageManager.recordMessage({
        message_type: e.message_type,
        group_id: e.group_id,
        message_id: botMessageId,
        time: now + 1,
        message: [{ type: "text", text: output }],
        source: "send",
        self_id: Bot.uin,
        sender: { user_id: Bot.uin, nickname: Bot.nickname, card: Bot.nickname, role: "member" }
      })
    } catch (error) {
      logger.error("[MessageRecord] 记录消息失败：", error)
    }

    try {
      personaFeedbackManager.rememberBotReply({ ...e, message_id: botMessageId }, output)
      globalStyleLearnerManager.rememberBotReply(e, output, this.config.globalStyleLearning)
    } catch (error) {
      logger.warn(`[希洛反馈] 记录最近回复或自主风格轮次失败: ${error.message}`)
    }

    // 保存到 messages 数组
    if (session.toolResults?.length) {
      const existingToolResultIds = new Set(
        messages
          .filter(msg => msg.role === "tool" && msg.tool_call_id)
          .map(msg => msg.tool_call_id)
      )
      for (const { toolCall, toolName: tName, result } of session.toolResults) {
        if (result && result.trim() !== '') {
          const toolCallId = toolCall?.id || randomUUID()
          if (existingToolResultIds.has(toolCallId)) continue
          existingToolResultIds.add(toolCallId)
          messages.push({
            role: "tool",
            tool_call_id: toolCallId,
            name: tName,
            content: result
          })
        }
      }
    }

    messages.push({ role: "assistant", content: output })
    session.groupUserMessages = this.trimMessageHistory(messages)
    await this.saveGroupUserMessages(e.group_id, e.user_id, messages)

    // 更新情感、记忆、表达学习（异步，不阻塞）
    // 使用 e.msg 纯消息内容，而不是格式化的 userContent
    this.updateEnhancedSystems(e, e.msg || '', output).catch(err => {
      logger.error('[增强系统] 更新失败:', err)
    })
  }

  /**
   * 异步更新情感系统、长期记忆
   */
  async updateEnhancedSystems(e, userMessage, botReply) {
    const { group_id: groupId, user_id: userId } = e
    let emotionState = null

    // 1. 更新情感系统
    if (this.config.emotionSystem?.enabled) {
      const isAtBot = messageMentionsUser(e, Bot.uin)
      emotionState = await this.emotionManager.updateEmotionFromMessage(groupId, userMessage, isAtBot)
    }

    // 2. 提取并保存长期记忆（后台异步）
    if (this.config.memorySystem?.enabled) {
      // 不 await，让它在后台执行
      this.memoryManager.extractAndSaveMemories(groupId, userId, userMessage, botReply, {
        source: "user",
        messageId: e.message_id,
        senderName: e.sender?.card || e.sender?.nickname
      })
      // 提取群全局记忆（传入聊天记录）
      if (groupId) {
        const history = await this.messageManager.getMessages('group', groupId)
        const chatHistory = (history || []).slice(0, 40).map(msg => ({
          role: msg.sender?.user_id === Bot.uin ? 'assistant' : 'user',
          source: msg.source || (msg.sender?.user_id === Bot.uin ? "send" : "user"),
          content: `${msg.sender?.nickname || '未知'}(QQ:${msg.sender?.user_id}): ${msg.content}`
        }))
        this.memoryManager.extractAndSaveGroupMemories(groupId, chatHistory)
      }
    }

    // 表达学习已移至 handleRandomReply 静默收集，不在此处调用
  }

  async sendObservedReply(...args) { return await sendObservedReply(this, ...args) }
  async sendSegmentedMessage(...args) { return await sendSegmentedMessage(this, ...args) }
  splitMessage(...args) { return splitMessage(this, ...args) }
  splitLongMessageByPunctuation(...args) { return splitLongMessageByPunctuation(this, ...args) }
  async convertAtInString(...args) { return await convertAtInString(this, ...args) }
  findMember(...args) { return findMember(this, ...args) }
  processToolSpecificMessage(...args) { return processToolSpecificMessage(this, ...args) }

  async initMCP() {
    try {
      const configDir = path.join(process.cwd(), "plugins/shiloh-plugin/config")
      const configDefaultDir = path.join(process.cwd(), "plugins/shiloh-plugin/config_default")
      const configPath = path.join(configDir, "mcp-servers.yaml")
      const defaultConfigPath = path.join(configDefaultDir, "mcp-servers.yaml")

      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true })
      }

      if (!fs.existsSync(configPath)) {
        if (fs.existsSync(defaultConfigPath)) {
          fs.copyFileSync(defaultConfigPath, configPath)
          logger.info(`[MCP] 已从 config_default 复制配置文件: mcp-servers.yaml`)
          logger.info(`[MCP] 请根据需要修改配置并启用相应的MCP服务器`)
        } else {
          logger.warn(`[MCP] 默认配置文件不存在: ${defaultConfigPath}`)
          logger.warn(`[MCP] 请在 config_default 目录下创建 mcp-servers.yaml 文件`)
          return
        }
      }

      if (!fs.existsSync(configPath)) {
        logger.info("[MCP] MCP配置文件不存在，跳过初始化")
        return
      }

      let mcpConfig = YAML.parse(fs.readFileSync(configPath, "utf8"))
      if (fs.existsSync(defaultConfigPath)) {
        const defaultMcpConfig = YAML.parse(fs.readFileSync(defaultConfigPath, "utf8"))
        const mergedMcpConfig = this.mergeMCPConfig(defaultMcpConfig, mcpConfig || {})
        if (JSON.stringify(mcpConfig || {}) !== JSON.stringify(mergedMcpConfig)) {
          fs.writeFileSync(configPath, YAML.stringify(mergedMcpConfig))
          logger.info("[MCP] 已自动补齐 mcp-servers.yaml 新增默认配置项")
        }
        mcpConfig = mergedMcpConfig
      }
      mcpManager.configure(mcpConfig?.settings || {})

      if (!mcpConfig?.servers) {
        logger.info("[MCP] MCP配置为空或无服务器配置")
        this.updateToolsList()
        return
      }

      for (const [serverName, config] of Object.entries(mcpConfig.servers)) {
        mcpManager.rememberServerConfig(serverName, config)
      }

      const enabledServers = Object.entries(mcpConfig.servers).filter(([_, config]) => config.enabled)

      if (enabledServers.length === 0) {
        logger.info("[MCP] 没有启用的MCP服务器")
        this.updateToolsList()
        return
      }

      for (const [serverName, config] of enabledServers) {
        await mcpManager.connectServer(serverName, config)
      }

      this.updateToolsList()

      logger.info(`[MCP] 初始化完成，共加载 ${mcpManager.aliases?.size || mcpManager.tools.size} 个MCP工具`)
    } catch (error) {
      logger.error("[MCP] 初始化失败:", error)
    }
  }

  /**
   * 更新工具列表（合并本地工具和MCP工具）
   */
  updateToolsList(options = {}) {
    this.syncDedupeToolConfig(this.config.oneapi_tools || [])
    const localTools = this.getToolsByName(this.config.oneapi_tools || [], {
      warnMissing: this.localToolsReady !== false
    })
    const mcpTools = mcpManager.getAllTools() || []

    this.tools = [...localTools, ...mcpTools]

    this.sessionStore.refreshTools(this.tools)

  }

  async waitForMCPReady(timeoutMs = 5000) {
    if (!mcpInitPromise) return
    try {
      await Promise.race([
        mcpInitPromise,
        delay(timeoutMs).then(() => "timeout")
      ])
      this.updateToolsList()
    } catch (error) {
      logger.warn(`[MCP] 等待初始化完成失败: ${error.message}`)
    }
  }

  /**
   * 清除当前群的所有记忆（群记忆 + 用户记忆）
   */

  /**
   * 重载MCP配置（管理员命令）
   */

  // authority → 中文来源（新模型权威分级 config>self>teaching>mention）

  // 对齐新 fact 模型（entityModel.makeFact）：factShortId(text) 作 id、tags[0] 作分类、
  // text、confidence、authority 中文来源；eventAt 存在附"(待回扣)"。
  formatMemoryFactLines(facts = []) {
    return (Array.isArray(facts) ? facts : []).map(fact => {
      const shortId = factShortId(fact.text)
      const category = (Array.isArray(fact.tags) && fact.tags[0]) || "未分类"
      const confidence = Number(fact.confidence ?? 0).toFixed(2)
      const source = this.memoryAuthoritySource(fact.authority)
      const pending = fact.eventAt ? " (待回扣)" : ""
      return `ID:${shortId} [${category}] ${fact.text}（来源:${source}，置信度:${confidence}）${pending}`
    })
  }

  formatMemoryFacts(title, facts = []) {
    if (!facts.length) return `${title}\n暂无记忆`
    const lines = this.formatMemoryFactLines(facts)
    return `${title}\n${lines.join("\n")}\n\n删除单条记忆可发送：#删除记忆 my:<id>（删自己事实）或 #删除记忆 alias:<别名> / #删除记忆 fact:<群事实前缀>`.slice(0, 4500)
  }

  async replyMemoryForward(e, title, sections = []) {
    const msgs = []
    for (const section of sections) {
      const facts = section.facts || []
      if (!facts.length) {
        msgs.push(`${section.title}\n暂无记忆`)
        continue
      }

      const lines = this.formatMemoryFactLines(facts)
      for (let i = 0; i < lines.length; i += 12) {
        const page = Math.floor(i / 12) + 1
        const total = Math.ceil(lines.length / 12)
        const header = total > 1 ? `${section.title} (${page}/${total})` : section.title
        msgs.push(`${header}\n${lines.slice(i, i + 12).join("\n")}`)
      }
    }

    msgs.push("删除单条记忆可发送：#删除记忆 my:<id>（删自己事实）或 #删除记忆 alias:<别名> / #删除记忆 fact:<群事实前缀>")

    try {
      const forwardMsg = await common.makeForwardMsg(e, msgs, title)
      await this.sendObservedReply(e, forwardMsg)
    } catch (error) {
      logger.warn("[记忆管理] 转发消息发送失败，回退为普通文本:", error)
      await this.sendObservedReply(e, safeTruncateUnicode(msgs.join("\n\n"), 4500))
    }
  }

  async replyLongForward(e, title, text, pageSize = 3000) {
    const content = String(text || "")
    const msgs = splitUnicodeText(content, pageSize)
    if (!msgs.length) msgs.push("暂无内容")

    try {
      const forwardMsg = await common.makeForwardMsg(e, msgs, title)
      await this.sendObservedReply(e, forwardMsg)
    } catch (error) {
      logger.warn("[消息发送] 转发消息发送失败，回退为普通文本:", error)
      await this.sendObservedReply(e, safeTruncateUnicode(content, 4500) || "暂无内容")
    }
  }

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
    await this.replyLongForward(e, "MCP状态", mcpManager.getStatusSummary())
    return true
  }

  async testMCPTool(e) {
    if (!e.isMaster) {
      await this.sendObservedReply(e, "只有主人才能执行此操作")
      return true
    }

    const input = String(e.msg || "").replace(/^#mcp\s+测试\s+/, "").trim()
    const spaceIndex = input.indexOf(" ")
    const alias = spaceIndex === -1 ? input : input.slice(0, spaceIndex)
    const rawParams = spaceIndex === -1 ? "{}" : input.slice(spaceIndex + 1).trim()

    if (!alias) {
      await this.sendObservedReply(e, "请输入要测试的 MCP 工具名，例如：#mcp 测试 mcp_server_search {\"query\":\"你好\"}")
      return true
    }

    let params = {}
    try {
      params = rawParams ? JSON.parse(rawParams) : {}
    } catch (error) {
      await this.sendObservedReply(e, `JSON 参数解析失败：${error.message}`)
      return true
    }

    try {
      const result = await mcpManager.executeToolByAlias(alias, params)
      await this.replyLongForward(e, `MCP测试 ${alias}`, result)
    } catch (error) {
      logger.error(`[MCP] 测试工具 ${alias} 失败:`, error)
      await this.sendObservedReply(e, `MCP工具测试失败：${error.message}`)
    }
    return true
  }
}
