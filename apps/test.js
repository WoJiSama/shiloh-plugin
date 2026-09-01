import { EmotionManager } from "../utils/EmotionManager.js"
import { MemoryManager } from "../utils/MemoryManager.js"
import { ExpressionLearner } from "../utils/ExpressionLearner.js"
import KnowledgeSearcher from "../functions/KnowledgeSearcher.js"
import KnowledgeExpander from "../functions/KnowledgeExpander.js"
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
import { personProfileInjector } from "../utils/PersonProfileInjector.js"
import { memStats } from "../utils/memory/stats.js"
import { factShortId } from "../utils/memory/entityModel.js"
import { stripChatLogSpeakerPrefix, stripChatLogSpeakerPrefixes } from "../utils/replySanitizer.js"
import { personaFeedbackManager } from "../utils/PersonaFeedbackManager.js"
import { globalStyleLearnerManager } from "../utils/GlobalStyleLearnerManager.js"
import { diceManager } from "../utils/DiceManager.js"
import { analyzeReplyText } from "../utils/SmartReply.js"
import { buildMissingImageAnalysisReply, looksLikeImageAuthenticityRequest, looksLikeImageVerificationRequest, looksLikeVisualInspectionRequest, shouldAskForMissingImageForVisualRequest } from "../utils/imageRequestGuard.js"
import { resolveChatCompletionUrl as normalizeChatCompletionUrl } from "../utils/chatCompletionUrl.js"
import { compileImagePrompt, resolveImageContextMode, selectLatestDrawContextLines, selectMergedImagePromptTexts } from "../utils/promptCompiler.js"
import { resolveDeterministicToolIntent, resolveToolRequestMergeMs, selectToolIntentCandidates } from "../utils/toolIntentManifests.js"
import { extractValidBtihMagnetUri } from "../utils/torrentDownload.js"
import { buildToolSkillCatalog, normalizeToolSkillParams } from "../utils/toolSkills.js"
import { formatGroupWorkflowTeachingPrompt } from "../utils/memory/groupWorkflow.js"
import { formatGroupKnowledgeTeachingPrompt } from "../utils/memory/groupKnowledge.js"
import { buildMentionMembersFailureReply } from "../utils/mentionFailureReply.js"
import { collectMentionTargetIds, getMentionTargetId, messageMentionsUser, replaceCqMentions } from "../utils/mentionTargets.js"
import { isExplicitAdminCollectionMentionRequest, resolveSingularOwnerMention } from "../utils/mentionRoleRouting.js"
import { resolveRecentBotImage, resolveRecentUserImage } from "../utils/recentImageContinuation.js"
import { prepareImageEditAssets, resolveAvatarEditBase } from "../utils/editReferencePipeline.js"
import { hasExplicitImageEditAction, hasExplicitImageGenerationRequest, shouldPreferImageGeneration, shouldRenderImageAnalysisAsDocument, shouldRequireImageEditBase, shouldTreatAsAvatarInspection } from "../utils/imageTaskPolicy.js"
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
import { classifyEmojiToolExposure, filterToolsForEmojiExposure, resolveForcedReactionEmoji, shouldExposeEmojiToolForMessage } from "../utils/emojiToolPolicy.js"
import { buildExcelToolParams, hasExcelWorkbookContext, shouldBypassMergeForExcel, shouldUseExcelWorkbookTool } from "../utils/excelRequestPolicy.js"
import { containsCodeFence, flattenCodeFences } from "../utils/qqCodeFenceText.js"
import { armSmartLockWatchdog, clearSmartLockWatchdog, isLongRunningTaskLinkRequest } from "../utils/smartLockPolicy.js"
import { decideToolContinuation } from "../utils/toolContinuationPolicy.js"
import { buildToolGroundingInstruction, buildUnavailableToolReply, hasUsableToolResult } from "../utils/toolResultGrounding.js"
import { buildStructuredHistoryMessage, resolveHistorySelectionBudget, resolveToolRoundLimit, selectRelevantGroupHistory } from "../utils/agentIntelligence.js"
import { buildSolutionExplanationStylePrompt } from "../utils/solutionExplanationStyle.js"
import { buildAgentProgressContext, buildToolFailureReplyInstruction, selectAgentReplyContext } from "../utils/agentReplyComposer.js"
import { containsInternalStatusLeak } from "../utils/internalStatusLeak.js"
import { buildPersonaTonePrompt, enforcePersonaToneBoundary } from "../utils/personaTonePolicy.js"
import { createTurnPlan, deriveTurnPlanRequest, formatTurnPlanLog, recordTurnPlanToolOutcome } from "../utils/turnPlan.js"
import { isNarrativeWritingRequest, splitNarrativeReply } from "../utils/narrativeReply.js"
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
const clearGroupMemoryPending = new Map()
const CLEAR_GROUP_MEMORY_CONFIRM_TTL_MS = 30000

// 终态工具：本轮调用后不再请求 LLM 续话（工具的执行结果本身即为最终输出）
const TERMINAL_TOOL_NAMES = new Set(['sendLocalEmojiTool', 'waitTool', 'bananaTool', 'googleImageEditTool', 'voiceTool', 'deltaForceTool', 'mentionAdminsTool', 'mentionMembersTool', 'torrentDownloadTool'])
const BACKGROUND_TERMINAL_TOOL_NAMES = new Set(['bananaTool', 'googleImageEditTool', 'torrentDownloadTool'])

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
const roleMap = { owner: "owner", admin: "admin", member: "member" }
const PSEUDO_TOOL_MARKERS = [
  "tool", "tools", "tool_call", "toolcall", "function", "function_call", "functioncall", "func", "call", "voice", "audio", "tts", "image", "img",
  "video", "file", "send", "reply", "search", "google", "mcp", "banana", "reminder",
  "poke", "like", "music", "weather", "map", "draw", "generate", "edit",
  "工具", "工具调用", "函数", "函数调用", "调用", "语音", "音频", "图片", "图像", "视频", "文件", "发送",
  "回复", "搜索", "生图", "画图", "修图", "提醒", "戳", "点赞", "点歌", "天气", "地图"
]
const PSEUDO_TOOL_MARKER_SET = new Set(PSEUDO_TOOL_MARKERS.map(item => item.toLowerCase()))
const PSEUDO_TOOL_TEXT_KEYS = ["text", "content", "message", "reply", "spoken_text", "speech", "voice"]

function isPseudoToolMarker(marker = "") {
  const normalized = String(marker || "")
    .trim()
    .replace(/tool$/i, "")
    .replace(/工具$/, "")
    .toLowerCase()
  return PSEUDO_TOOL_MARKER_SET.has(normalized) || PSEUDO_TOOL_MARKER_SET.has(`${normalized}tool`)
}

// ─── 拟人化对话相关：本地预筛辅助常量与函数 ────────────────────────────
// 中文停用词（提取关键词时跳过这些）
const CHAT_STOPWORDS = new Set([
  "的", "了", "是", "也", "就", "都", "吧", "吗", "呢", "啊", "么", "哦", "呀", "嘛", "哈",
  "这", "那", "我", "你", "他", "她", "它", "我们", "你们", "他们",
  "觉得", "感觉", "可能", "应该", "不", "没", "有", "在", "和", "与", "或", "但", "而",
  "什么", "怎么", "怎样", "如何", "哪里", "哪个", "为什么", "因为", "所以",
  "一个", "一些", "这个", "那个", "这样", "那样", "这里", "那里",
  "可以", "不能", "需要", "想要", "知道", "听说", "看到"
])
// 反馈词（用户消息开头或主体如果是这些，认为是在回应 bot）
const FEEDBACK_WORDS = [
  "嗯", "对", "不对", "真的", "真的吗", "是吗", "是的", "确实", "对哦", "也是",
  "好的", "好吧", "可以", "可以的", "不可以", "不是", "没错", "没", "我也", "我觉得", "我感觉",
  "那", "那你", "那我", "你说", "你这", "你这么说",
  "啊？", "啊", "诶", "诶？", "哦", "哦？", "哈哈", "哈"
]
// 问句尾字（消息末尾包含这些算问句）
const QUESTION_TAIL_CHARS = ["?", "？", "吗", "呢", "啊", "么", "嘛"]
const DIRECT_BOT_PRONOUN_PATTERNS = [
  /(?:^|[\s，,。.!！?？~～])你(?:刚才|刚刚|前面|上一句|说|讲|回|回复|意思|怎么|为啥|为什么|是不是|能不能|可以|会不会|要不要|觉得|知道|认识|记得|是谁|叫啥|叫)/,
  /(?:^|[\s，,。.!！?？~～])你(?:呢|呀|啊|吗|嘛|么|？|\?)?$/
]
const GROUP_ADDRESS_PATTERNS = [
  /(?:大家|各位|群友|兄弟们|姐妹们|你们|咱们|有人|有没有人|哪位|大佬).{0,18}(?:知道|认识|会|能|可以|看看|帮|觉得|推荐|有|在吗|吗|嘛|\?|？)/,
  /(?:谁知道|有人知道|有没有人知道|问一下|请问|求问|求助|有无).{0,30}/,
  /(?:这个|这|那个|那).{0,14}(?:是什么|是啥|啥|怎么回事|咋回事|有人知道|谁知道)/
]
const PREVIOUS_SPEAKER_REPLY_PATTERNS = [
  /^[？?]+$/,
  /^(你|妳|他|她|这|那|对|不对|不是|是啊|确实|笑死|草|绷|哈哈|那你|那他|那她|别|不要|可以|不行|行|嗯|啊|哦|所以|但是|可是)/
]
const REALTIME_INFO_PATTERNS = [
  /(天气|气温|温度|下雨|降雨|台风|空气质量|AQI|空气指数)/i,
  /(新闻|热搜|最新消息|刚刚发生|最近发生|实时|现在|当前|目前|今天|今日|明天|昨天).{0,24}(新闻|情况|怎么样|如何|发生|政策|规定|结果|价格|行情|汇率|股价|天气|赛程|比分|营业|开门|关门)/i,
  /(股价|股票|基金|币价|比特币|汇率|油价|金价|价格|报价|行情|房价|票价)/i,
  /(赛程|比分|比赛结果|战绩|排名|积分榜|开奖|中奖号码)/i,
  /(营业|开门|关门|限行|航班|车次|路况|排队|库存|余票|票价)/i
]
const EXPLICIT_SEARCH_PATTERNS = [
  /(搜一下|搜索|查一下|查查|帮我查|帮我搜|联网查|网上查|百度一下|谷歌一下|找一下资料|最新的|最新版|最新版本|官网|链接|网址|网页|页面|repo|github)/i
]
const TOOL_INTENT_PATTERNS = [
  /(画图|生图|修图|改图|图片分析|看图|识图|视频分析|语音|点歌|音乐|提醒我|定时提醒|撤回|禁言|改名片|戳一下|点赞|送礼物|红包|思维导图|导图|生成图片|生成照片|生成照|生成语音|Excel|工作簿|工作表|sheet|tab页|单元格|\.xlsx\b|\.xlsm\b|磁链|磁力链接|magnet:\?|艾特|@\S+|通知.*(?:人|一下)|喊.*(?:人|一下)|叫.*(?:人|一下))/i
]
const IMAGE_GENERATION_PATTERNS = [
  /(画图|生图|生成图片|生成照片|生成照|生成一?张(?:图|照片|照)|生成一?个.*(?:图|照片|照)|画一?张|绘制|出图|做一?张.*(?:图|照片|照)|捏一?个.*(?:图|照片|照))/i,
  /(?:把|将|给|帮我|替我|麻烦|可以|能不能|能|想要|要|一会|待会|等下).{0,24}(?:这个|这段|这句|上面|刚才|刚刚|内容|描述|设定|场景|它)?.{0,16}(?:画出来|画成图|画成图片|出成图|生成出来)/i,
  /(?:画|绘制|生成).{0,16}(?:出来|成图|成图片|成一张图)/i,
  /(帮我|给我|替我|可以|能不能|能|想要|要).{0,12}(画|生成|绘制|做|捏).{0,140}(图|图片|照片|照|插画|壁纸|头像|封面|海报|表情包|logo|标志|立绘|角色|人物|少女|男孩|女孩|猫|猫咪|狗|狗狗|动物|风景|场景)/i,
  /(?:帮我|给我|替我|麻烦|可以|能不能|想要|要).{0,12}(?:画|生成|绘制|做|捏)(?:一|1)?(?:个|张|幅|只|位)?.{1,180}(?:的)?(?:图|图片|照片|照|插画|壁纸|头像|封面|海报|表情包|立绘)$/i,
  /(?:用|拿|以).{0,8}(?:图片|图|画面|画|插画).{0,16}(?:展示|呈现)(?:一下|出来|吧|呀|嘛|呢)?/i,
  /(?:图片|图|画面|插画).{0,10}(?:展示|呈现)(?:一下|出来|吧|呀|嘛|呢)?/i,
  /(画|绘制|生成).{0,8}(一|1)?(只|个|位|张|幅)?.{0,32}(猫|猫咪|狗|狗狗|动物|角色|人物|少女|男孩|女孩|头像|立绘|风景|场景|照片|照)/i
]
const COMIC_DRAW_PATTERN = /(连环画|漫画|四格|多格|分镜|组图|小剧场|一组)/i
const IMAGE_ANALYSIS_PATTERNS = [
  /(图|图片|照片|截图|表情|头像).{0,16}(是什么|是啥|有啥|有什么|啥意思|什么意思|怎么看|看得出|看出来|识别|分析|描述|讲讲|说说)/i,
  /(看看|看下|看一下|帮我看|帮我看看|告诉我|识别一下|分析一下|描述一下).{0,18}(图|图片|照片|截图|表情|头像|里面|里边|上面|内容)/i,
  /(图里|图中|图片里|图片中|照片里|截图里|这里面|这上面).{0,16}(是什么|是啥|有啥|有什么|谁|哪|啥意思|什么意思)/i
]
const IMAGE_EDIT_PATTERNS = [
  /(修图|改图|美化图片|图片美化|编辑图片|图片编辑|P图|p图|图生图|重绘|局部重绘|扩图|抠图|去水印|换背景|换衣服|换颜色|换发型|换脸|加滤镜|上色|变清晰|高清修复|无损放大)/i,
  /(?:把|将|给|帮我|替我|麻烦|可以|能不能|能|想要|要).{0,18}(?:这张|这个|图片|图|照片|截图|头像|它|猫|猫咪|人|角色|主体)?.{0,16}(?:加|加上|添加|放上|画上|换|换成|变成|改成|改为|改一下|改改|修|修一下|修修|美化|变美|变漂亮|变好看|弄好看|弄漂亮|优化|去掉|去除|删掉|删除|移除|擦掉|抹掉|保留|增强|修复|变清晰|放大|补全|扩展|扩成).{0,40}/i,
  /(?:这个|这张|图片|图|照片|截图|头像).{0,16}(?:改一下|改改|修一下|修修|美化|变美|变漂亮|变好看|弄好看|弄漂亮|优化|精修)/i,
  /(?:把|将|给|帮我|替我|麻烦|可以|能不能|能|想要|要).{0,48}(?:放到|放在|放上|摆到|摆在|坐到|坐在|站到|站在|贴到|贴在|塞到|塞进|加到|加进|放进).{0,32}(?:上|里|里面|图里|图片里|画面里|照片里|截图里|背景里|旁边|中间|前面|后面|左边|右边|椅子|桌子|沙发|床|地上|墙上)/i,
  /(?:翅膀|尾巴|耳朵|帽子|眼镜|衣服|背景|文字|水印|光效|滤镜|颜色|表情|姿势|发型).{0,12}(?:加上|添加|换成|改成|去掉|去除|删除|移除|变成)/i
]
const IMAGE_COMPOSITION_EDIT_PATTERNS = [
  /(?:把|将).{1,60}(?:放到|放在|放上|放进|摆到|摆在|摆上|坐到|坐在|站到|站在|贴到|贴在|塞到|塞进|加到|加进|放|摆|贴|塞).{0,36}/i,
  /(?:让|叫).{1,40}(?:坐到|坐在|站到|站在|躺到|躺在|趴到|趴在).{0,36}/i,
  /(?:给|帮我|替我).{0,20}(?:图里|图片里|画面里|照片里|截图里).{0,24}(?:加|放|摆|塞|贴).{1,40}/i
]
const IMAGE_COMPOSITION_ACTION_PATTERNS = [
  /(?:放到|放在|放上|放进|放入|放|摆到|摆在|摆上|摆进|摆|坐到|坐在|站到|站在|贴到|贴在|贴上|贴进|贴|塞到|塞进|塞入|塞|加到|加进|加上|加入)/i
]
const IMAGE_COMPOSITION_TARGET_PATTERNS = [
  /(?:图里|图片里|画面里|照片里|截图里|背景里|上面|里面|旁边|中间|前面|后面|左边|右边|角落|椅子|桌子|沙发|床|地上|墙上|怀里|头上|手里|身边)/i
]
const GROUP_CONTEXT_PATTERNS = [
  /(群公告|公告|群规|群规则|入群规则|群主|管理员|管理|群管|群成员|成员|群名片|头衔|谁是|是谁|哪位|哪个人|哪个群友|这人是谁|那人是谁|禁言规则|发公告)/i
]
const SEARCH_TOOL_NAMES = new Set(['searchInformationTool', 'webParserTool', 'githubRepoTool'])
const TOOL_COMMITMENT_PATTERNS = [
  /(?:我|希洛)?(?:马上|现在|这就|等我|稍等|等一下|我来|我去|帮你|给你|让我|这就).{0,24}(?:画|生成|出图|改|修|处理|弄|编辑|看看|看一下|识别|分析|查|搜|找|搓|捏|整|做)/i,
  /(?:马上弄好|马上弄|马上画|马上改|马上处理|我来弄|我去弄|我来画|我去画|我来改|我去改|我来处理|我试试|我看看怎么|开始弄|开始画|开始改|等我一下|这就搓|这就捏|这就整|这就做|搓一个|捏一个|整一个|做一个)/i
]
const DRAW_TASK_STATUS_PATTERNS = [
  /(?:我的|我那张|刚才|刚刚|上一张|前面|之前).{0,12}(?:图|图片|画|出图).{0,18}(?:呢|好了没|好了吗|画好|生成好|出来|进度|到哪|还在|卡住|忘了|是不是忘)/i,
  /(?:图|图片|画|出图).{0,12}(?:呢|好了没|好了吗|画好|生成好|出来|进度|到哪|还在|卡住|是不是忘|忘了)/i,
  /(?:是不是|不会是|你是不是).{0,8}(?:忘了|忘记).{0,12}(?:我的|那张|刚才|图|画|图片)/i
]
const DRAW_CONTEXT_CONTINUATION_PATTERNS = [
  /(?:人物|角色|形象|造型|画面|构图|场景|背景|风格|表情|动作|姿势|细节).{0,18}(?:调整|改|修改|换|加|补|优化|重画|重新画|再画|继续)/i,
  /(?:调整|改|修改|换|加|补|优化|重画|重新画|再画|继续).{0,40}(?:人物|角色|形象|造型|画面|构图|场景|背景|风格|表情|动作|姿势|细节|这个|那张|刚才|刚刚|上一张)/i,
  /(?:全都要|都要|全部要|都加上|全加上|就按这个|就这样|按你说的|照你说的|继续画|接着画|那就画|画完整|重画一张|再来一张)/i
]
const SEMANTIC_TOOL_INTENTS = new Set(["chat", "image_generate", "image_edit", "image_analysis", "search"])
const SEMANTIC_TOOL_INTENT_MIN_CONFIDENCE = 0.7
const SEMANTIC_TOOL_INTENT_TIMEOUT_MS = 8000
const SEMANTIC_TOOL_HINT_PATTERN =
  /(画|绘制|生成|生图|出图|修图|改图|P图|p图|美化|去水印|换背景|看图|识图|分析|识别|看看|看一下|搜|查|找|天气|新闻|价格|汇率|比赛|最新|官网|链接|网址|三角洲|今日密码|每日密码|改枪码|改枪方案|利润排行|制造利润|特勤处|提醒|定时|禁言|改名片|戳|点赞|礼物|点歌|音乐|聊天记录|群成员|群友|导图|思维导图|Excel|工作簿|工作表|sheet|tab页|单元格|磁链|磁力链接|magnet:\?|\.xlsx\b|\.xlsm\b)/i
const CASUAL_BOT_GREETING_PATTERNS = [
  /(?:在吗|在不在|还好吗|还好嘛|还好不|你还好吗|你还好嘛|你没事吧|醒醒|理我|出来|冒泡|人呢|去哪了|干嘛呢|咋了|怎么了)/i
]

/**
 * 从一段文本提取关键词（给 R2 关键词命中识别用）。
 * 简单实现：按中英标点切分，取长度 ≥2 的非停用词词块，去重，最多 maxCount 个。
 */
function extractChatKeywords(text, maxCount = 5) {
  if (!text || typeof text !== "string") return []
  // 去除 CQ 码、@ 字段等噪声
  const cleaned = text
    .replace(/\[CQ:[^\]]+\]/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
  // 按非中英文数字字符切分
  const tokens = cleaned.split(/[^一-龥A-Za-z0-9]+/).filter(Boolean)
  const seen = new Set()
  const result = []
  for (const tok of tokens) {
    const t = tok.trim()
    if (t.length < 2) continue
    if (CHAT_STOPWORDS.has(t)) continue
    // 对中文长词额外拆分 2-3 字滑动窗口（避免长句一个 token 没法匹配）
    if (/^[一-龥]+$/.test(t) && t.length >= 4) {
      // 取 2-gram 前缀作为辅助关键词
      for (let i = 0; i <= t.length - 2 && result.length < maxCount; i++) {
        const gram = t.slice(i, i + 2)
        if (CHAT_STOPWORDS.has(gram)) continue
        if (seen.has(gram)) continue
        seen.add(gram)
        result.push(gram)
      }
    } else {
      if (seen.has(t)) continue
      seen.add(t)
      result.push(t)
    }
    if (result.length >= maxCount) break
  }
  return result.slice(0, maxCount)
}

/**
 * 判断消息是否是问句（含 ? / ？ 或末尾 5 字含问句尾字）
 */
function isQuestionMessage(text) {
  if (!text || typeof text !== "string") return false
  if (/[?？]/.test(text)) return true
  const tail = text.slice(-5)
  for (const ch of QUESTION_TAIL_CHARS) {
    if (tail.includes(ch)) return true
  }
  return false
}

/**
 * 判断消息是否以反馈词开头或主体由反馈词构成
 */
function isFeedbackMessage(text) {
  if (!text || typeof text !== "string") return false
  const t = text.trim()
  if (!t) return false
  // 整条就是反馈词
  if (FEEDBACK_WORDS.includes(t)) return true
  // 开头是反馈词（后接标点或空格）
  for (const w of FEEDBACK_WORDS) {
    if (t.startsWith(w)) {
      const next = t.charAt(w.length)
      if (!next || /[\s,，。.!！?？~～]/.test(next)) return true
    }
  }
  return false
}

function isLikelyFollowupMessage(text = "") {
  const msg = String(text || "").replace(/\[CQ:[^\]]+\]/g, " ").trim()
  if (!msg) return false
  if (isQuestionMessage(msg)) return true
  return /(?:谁|誰|什么|啥|哪(?:个|位|里|裏)|怎么|怎样|咋|为什么|为啥|多少|几|能不能|可不可以|要不要|是不是|还记得|记得|刚才|刚刚|前面|上一句|推荐|告诉|讲讲|说说|解释|评价|分析|帮我|给我|那你|那就|所以)/.test(msg)
}

function summarizeForLog(text = "", max = 100) {
  const compact = stripCqMarkup(text).replace(/\s+/g, " ").trim()
  return compact.length > max ? `${compact.slice(0, max)}...` : compact
}

function isCasualBotGreeting(text = "") {
  const content = normalizeIntentText(text)
  if (!content) return false
  return CASUAL_BOT_GREETING_PATTERNS.some(pattern => pattern.test(content))
}

function shouldUseCompactHistory({ text = "", images = [], videos = [], quotedText = "" } = {}) {
  const content = normalizeIntentText(text)
  if (!content || content.length > 80 || images.length || videos.length || quotedText) return false
  if (isRealtimeInfoRequest(content) || isExplicitSearchRequest(content) || isExplicitToolIntent(content)) return false
  return !/(?:他|她|它|这个|那个|上面|下面|前面|刚才|刚刚|之前|前一条|这张|那张|这段|引用|转发|回复)/u.test(content)
}

function hasDirectBotName(text = "", botName = "") {
  const msg = String(text || "").toLowerCase()
  const name = String(botName || "").toLowerCase()
  return Boolean(name && msg.includes(name))
}

function hasBotTextAnchor(text = "", botName = "", prefixes = []) {
  const msg = String(text || "").toLowerCase()
  if (hasDirectBotName(msg, botName)) return true
  return (Array.isArray(prefixes) ? prefixes : []).some(prefix => {
    const p = String(prefix || "").toLowerCase().trim()
    return p && msg.includes(p)
  })
}

function getReplySender(seg = {}) {
  return seg?.sender_id ?? seg?.user_id ?? seg?.qq ??
    seg?.sender?.user_id ?? seg?.sender?.qq ??
    seg?.data?.sender_id ?? seg?.data?.user_id ?? seg?.data?.qq ??
    seg?.data?.sender?.user_id ?? seg?.data?.sender?.qq
}

function messageQuotesUser(e = {}, userId = "") {
  if (!userId) return false
  const sources = [e?.source, e?.reply, e?.replyMessage, e?.quoted, e?.quote]
  for (const source of sources) {
    if (!source) continue
    const sender = getReplySender(source)
    if (sender && String(sender) === String(userId)) return true
  }
  if (Array.isArray(e?.message)) {
    for (const seg of e.message) {
      if (seg?.type !== "reply") continue
      const sender = getReplySender(seg)
      if (sender && String(sender) === String(userId)) return true
    }
  }
  return false
}

function looksDirectedAtBotByPronoun(text = "") {
  const msg = String(text || "").trim()
  if (!msg || !/[你妳]/.test(msg)) return false
  return DIRECT_BOT_PRONOUN_PATTERNS.some(pattern => pattern.test(msg))
}

function looksGroupAddressed(text = "") {
  const msg = String(text || "").trim()
  if (!msg) return false
  return GROUP_ADDRESS_PATTERNS.some(pattern => pattern.test(msg))
}

function getPreviousRecentMessage(state, e) {
  const messages = Array.isArray(state?.recentMessages) ? state.recentMessages : []
  const currentUserId = String(e?.user_id || "")
  const currentText = String(e?.msg || "").trim()
  for (let i = messages.length - 1; i >= 0; i--) {
    const item = messages[i]
    if (!item) continue
    const isCurrent = String(item.userId || "") === currentUserId &&
      String(item.text || "").trim() === currentText &&
      Date.now() - Number(item.at || 0) < 5000
    if (isCurrent) continue
    return item
  }
  return null
}

function looksAddressedToPreviousSpeaker(text = "", previousMessage = null, currentUserId = "", botId = "") {
  if (!previousMessage) return false
  if (String(previousMessage.userId || "") === String(currentUserId || "")) return false
  if (botId && String(previousMessage.userId || "") === String(botId)) return false
  if (Date.now() - Number(previousMessage.at || 0) > 120000) return false
  const msg = String(text || "").trim()
  if (!msg || looksGroupAddressed(msg)) return false
  if (PREVIOUS_SPEAKER_REPLY_PATTERNS.some(pattern => pattern.test(msg))) return true
  return msg.length <= 18 && !isQuestionMessage(msg)
}

function uniqText(values = []) {
  const result = []
  const seen = new Set()
  for (const value of values) {
    const text = String(value || "").trim()
    if (!text) continue
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    result.push(text)
  }
  return result
}

function getMemberNames(member = {}, fallback = "") {
  return uniqText([member.card, member.nickname, fallback])
}

function formatMemberDisplayName(member = {}, fallback = "未知用户") {
  const names = getMemberNames(member, fallback)
  if (!names.length) return fallback
  if (names.length === 1) return names[0]
  return `${names[0]}（昵称:${names.slice(1).join(" / ")}）`
}

function extractMemberLookupTerms(text = "") {
  const cleaned = String(text || "")
    .replace(/\[CQ:[^\]]+\]/g, " ")
    .replace(/@\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!/(谁|誰|哪位|哪个|哪個|资料|資料|信息|头像|頭像|群名片|昵称|暱稱|QQ|qq|头衔|頭銜|群身份|管理员|管理員)/.test(cleaned)) return []

  const terms = []
  const patterns = [
    /([A-Za-z0-9_\-.\u4e00-\u9fa5·•]{2,32})\s*(?:是)?(?:谁|誰|哪位|哪个|哪個)/g,
    /(?:谁|誰|哪位|哪个|哪個)\s*(?:是)?\s*([A-Za-z0-9_\-.\u4e00-\u9fa5·•]{2,32})/g,
    /([A-Za-z0-9_\-.\u4e00-\u9fa5·•]{2,32})\s*的?(?:资料|資料|信息|头像|頭像|群名片|昵称|暱稱|QQ|qq|头衔|頭銜|群身份)/g
  ]
  for (const pattern of patterns) {
    for (const match of cleaned.matchAll(pattern)) {
      let term = String(match[1] || "")
        .replace(/是$/g, "")
        .replace(/[，,。.!！?？:：;；~～]+$/g, "")
        .trim()
      let previous = ""
      while (term && term !== previous) {
        previous = term
        term = term
          .replace(/^(?:这里是希洛|希洛|能不能告诉我|可不可以告诉我|能告诉我|告诉我|請問|请问|问一下|求问|你认识|你認識|你知道|你晓得|认识|認識|知道|晓得)\s*/, "")
          .replace(/^(?:帮我|给我|替我|麻烦|请|把|将|看看|看下|看一下|查看|看|查查|查下|查一下|查询|查|读取|读|获取|改改|改下|改一下|修改|改)\s*/, "")
          .replace(/^[，,。.!！?？:：;；~～\s]+/, "")
          .trim()
      }
      if (term && !["是谁", "谁是", "哪位", "哪个", "哪個"].includes(term)) terms.push(term)
    }
  }
  return uniqText(terms).slice(0, 5)
}

function matchGroupMembersByTerms(memberMap, terms = [], currentUserId = null) {
  if (!memberMap || !terms.length) return []
  const members = Array.from(memberMap.values())
  const matches = []
  for (const term of terms) {
    const needle = String(term || "").toLowerCase()
    if (!needle) continue
    const found = members
      .map(member => {
        const names = getMemberNames(member)
        const score = names.reduce((best, name) => {
          const value = String(name || "").toLowerCase()
          if (!value) return best
          if (value === needle) return Math.max(best, 3)
          if (needle.length >= 2 && value.length >= 2 && (value.includes(needle) || needle.includes(value))) {
            return Math.max(best, 2)
          }
          return best
        }, 0)
        return { member, names, score }
      })
      .filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 6)

    if (found.length) {
      matches.push({
        term,
        members: found.map(({ member, names }) => ({
          userId: member.user_id,
          role: member.role,
          title: member.title,
          names,
          avatarUrl: buildQqAvatarUrl(member.user_id),
          isCurrentSpeaker: currentUserId && String(member.user_id) === String(currentUserId)
        }))
      })
    }
  }
  return matches
}

function formatMemberLookupPrompt(matches = []) {
  if (!matches.length) return ""
  const lines = [
    "【群成员名称匹配】",
    "用户问到的人名/昵称在当前群成员列表里有匹配。回答这类问题时优先使用这里，不要说群里没看到这个名字。",
    "只允许复述这里列出的字段：昵称/群名片、QQ、群身份、头衔、头像链接、是否当前发言者。没有明确证据时，禁止补充“他发过公告/经常管理/我见过他做某事/大家都怎样评价他”等行为经历。",
    "如果只知道他是管理员，就说“他是群里的管理员，群名片/昵称是...”，不要把管理员身份推断成发公告。"
  ]
  for (const item of matches) {
    lines.push(`- 查询: ${item.term}`)
    for (const member of item.members) {
      const role = roleMap[member.role] || member.role || "member"
      const current = member.isCurrentSpeaker ? "，当前发言者本人" : ""
      const title = member.title ? `，头衔:${member.title}` : ""
      const avatar = member.avatarUrl ? `，头像:${member.avatarUrl}` : ""
      lines.push(`  · ${member.names.join(" / ")} (QQ:${member.userId})[群身份:${role}${title}${current}${avatar}]`)
    }
  }
  return lines.join("\n")
}

function escapeRegExp(text = "") {
  return String(text || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function removeBotAnchors(text = "", botName = "", prefixes = []) {
  let result = String(text || "")
  const anchors = uniqText([botName, ...(Array.isArray(prefixes) ? prefixes : []), "希洛", "这里是希洛"])
  for (const anchor of anchors) {
    result = result.replace(new RegExp(escapeRegExp(anchor), "gi"), " ")
  }
  return result
}

function hasExplicitRememberSignal(text = "") {
  return /(?:记住|记一下|记着|记得|记好|记下来|别忘|以后|下次|告诉你|你要知道)/.test(String(text || ""))
}

function cleanTeachingAlias(value = "", botName = "", prefixes = []) {
  let text = removeBotAnchors(value, botName, prefixes)
    .replace(/@QQ:\d+|@BOT/g, " ")
    .replace(/\[CQ:[^\]]+\]/g, " ")
    .replace(/(?:帮我|你|妳)?(?:记住|记一下|记着|记得|记好|记下来|知道|认识)/g, " ")
    .replace(/(?:以后|下次)(?:说|看到|提到|有人说|别人说)?/g, " ")
    .replace(/^(?:说|叫|把|将|如果|有人|别人|群里|大家|这个|这|那个|那)+/, " ")
    .replace(/\s+/g, " ")
    .trim()

  const parts = text.split(/[\s，,。.!！?？:：;；~～]+/).filter(Boolean)
  text = parts[parts.length - 1] || text
  text = text.replace(/^(?:说|叫|把|将|这个|那个|这|那)/, "").trim()

  if (!text || text.length > 32) return ""
  if (/(?:不|没|非|并不|并非)$/.test(text)) return ""
  if (/^(?:是|就是|谁|誰|哪位|哪个|哪個|什么|啥|他|她|它|ta|TA|这个|那个|这|那|这人|那人|人|密码|公告|群公告)$/.test(text)) return ""
  return text
}

function cleanTeachingTarget(value = "", botName = "", prefixes = []) {
  let text = String(value || "")
    .replace(/\[CQ:[^\]]+\]/g, " ")
    .replace(/@QQ:\d+|@BOT/g, " ")
    .replace(/\s+/g, " ")
    .trim()

  const rememberIndex = text.search(/(?:你|妳)?(?:记住|记一下|记着|记得|知道|认识)(?:了)?(?:吗|嘛)?/)
  if (rememberIndex >= 0) text = text.slice(0, rememberIndex)

  for (const anchor of uniqText([botName, ...(Array.isArray(prefixes) ? prefixes : []), "希洛", "这里是希洛"])) {
    const index = text.indexOf(anchor)
    if (index >= 0) text = text.slice(0, index)
  }

  text = text
    .replace(/^@+/, "")
    .replace(/[，,。.!！?？:：;；~～].*$/g, "")
    .trim()

  if (!text || text.length > 64) return ""
  if (/[吗嘛么呢]$/.test(text)) return ""
  return text
}

function findGroupMemberByName(memberMap, term = "") {
  if (!memberMap || !term) return null
  const needle = String(term || "").replace(/^@+/, "").toLowerCase().trim()
  if (!needle) return null

  let best = null
  for (const member of memberMap.values()) {
    const names = getMemberNames(member)
    const score = names.reduce((current, name) => {
      const value = String(name || "").toLowerCase()
      if (!value) return current
      if (value === needle) return Math.max(current, 3)
      if (value.includes(needle) || needle.includes(value)) return Math.max(current, 2)
      return current
    }, 0)
    if (score > (best?.score || 0)) best = { member, score }
  }
  return best?.score >= 2 ? best.member : null
}

function buildTeachingFact({ alias, targetUserId = null, targetText = "", memberMap, rememberRequested = false, source = "text" } = {}) {
  const cleanAlias = String(alias || "").trim()
  if (!cleanAlias) return null

  if (targetUserId) {
    const member = memberMap?.get?.(Number(targetUserId))
    const targetDisplay = member ? formatMemberDisplayName(member, `用户${targetUserId}`) : `用户${targetUserId}`
    return {
      alias: cleanAlias,
      targetUserId: String(targetUserId),
      targetDisplay,
      targetNames: getMemberNames(member || {}, `用户${targetUserId}`),
      rememberRequested,
      source
    }
  }

  const matchedMember = findGroupMemberByName(memberMap, targetText)
  if (matchedMember?.user_id) {
    return buildTeachingFact({
      alias: cleanAlias,
      targetUserId: matchedMember.user_id,
      memberMap,
      rememberRequested,
      source
    })
  }

  const cleanTarget = String(targetText || "").trim()
  if (!cleanTarget) return null
  return {
    alias: cleanAlias,
    targetUserId: null,
    targetDisplay: cleanTarget,
    targetNames: [cleanTarget],
    rememberRequested,
    source
  }
}

function extractMentionTeachingFacts(messageSegments = [], memberMap, options = {}) {
  if (!Array.isArray(messageSegments) || !messageSegments.length) return []
  const botId = String(options.botId || "")
  let annotated = ""
  for (const segment of messageSegments) {
    if (segment?.type === "text") {
      annotated += segment.text || segment.data?.text || ""
      continue
    }
    if (segment?.type === "at") {
      const qq = String(getMentionTargetId(segment) || "")
      annotated += qq && qq !== botId ? ` @QQ:${qq} ` : " ， "
    }
  }

  const rememberRequested = hasExplicitRememberSignal(`${annotated} ${options.text || ""}`)
  const facts = []
  const relationPattern = /(?:^|[\s，,。.!！?？:：;；~～])([^@，,。.!！?？:：;；\n\r]{1,48}?)\s*(?:就?是|叫|指的是|代表|等于|=)\s*@QQ:(\d+)/g
  for (const match of annotated.matchAll(relationPattern)) {
    const alias = cleanTeachingAlias(match[1], options.botName, options.prefixes)
    const targetUserId = match[2]
    const fact = buildTeachingFact({
      alias,
      targetUserId,
      memberMap,
      rememberRequested,
      source: "mention"
    })
    if (fact) facts.push(fact)
  }
  return facts
}

function extractTextTeachingFacts(text = "", memberMap, options = {}) {
  const raw = String(text || "")
  if (!raw || !hasExplicitRememberSignal(raw)) return []

  const cleaned = replaceCqMentions(raw, userId => ` @QQ:${userId} `)
    .replace(/\s+/g, " ")
    .trim()

  const facts = []
  const patterns = [
    /(?:记住|记一下|记着|记得|记好|记下来|告诉你|你要知道)[，,\s]*(.{1,48}?)(?:就?是|叫|指的是|代表|等于|=)\s*(@QQ:(\d+)|.{1,80})/g,
    /(.{1,48}?)(?:就?是|叫|指的是|代表|等于|=)\s*(@QQ:(\d+)|.{1,80}?)(?:[，,。.!！?？\s]*(?:你|妳)?(?:记住|记一下|记着|记得|知道))/g
  ]

  for (const pattern of patterns) {
    for (const match of cleaned.matchAll(pattern)) {
      const alias = cleanTeachingAlias(match[1], options.botName, options.prefixes)
      const targetUserId = match[3] || null
      const targetText = targetUserId
        ? ""
        : cleanTeachingTarget(match[2], options.botName, options.prefixes)
      const fact = buildTeachingFact({
        alias,
        targetUserId,
        targetText,
        memberMap,
        rememberRequested: true,
        source: "text"
      })
      if (fact) facts.push(fact)
    }
  }
  return facts
}

function extractExplicitTeachingFacts(messageSegments = [], memberMap, options = {}) {
  const facts = [
    ...extractMentionTeachingFacts(messageSegments, memberMap, options),
    ...extractTextTeachingFacts(options.text || "", memberMap, options)
  ]

  const result = []
  const seen = new Set()
  for (const fact of facts) {
    const key = `${fact.alias.toLowerCase()}::${fact.targetUserId || fact.targetDisplay.toLowerCase()}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(fact)
  }
  return result.slice(0, 5)
}

function formatExplicitTeachingMemoryContent(fact) {
  if (!fact) return ""
  const target = fact.targetUserId
    ? `${fact.targetDisplay} (QQ:${fact.targetUserId})`
    : fact.targetDisplay
  return `群内称呼映射：${fact.alias} = ${target}`
}

function formatExplicitTeachingPrompt(facts = []) {
  if (!facts.length) return ""
  const lines = [
    "【当前消息显式教学 - 最高优先级】",
    "当前用户正在纠正或教你群内称呼/外号映射。这里的内容优先级高于群公告、旧聊天记录、旧回答、知识库和长期记忆；如果冲突，以这里为准。",
    "回复时直接承认并确认这些映射，不要把同名词从群公告或旧回答里重新解释成别的东西。"
  ]
  for (const fact of facts) {
    lines.push(`- ${formatExplicitTeachingMemoryContent(fact)}`)
  }
  if (facts.some(fact => fact.rememberRequested)) {
    lines.push("- 用户问“记住了吗”时，应回答已经记住/记下这个映射。")
  }
  return lines.join("\n")
}

function normalizeIdentityBindings(bindings = []) {
  const source = Array.isArray(bindings)
    ? bindings
    : bindings && typeof bindings === "object"
      ? Object.entries(bindings).map(([qq, value]) => ({ qq, ...(value || {}) }))
      : []

  const result = []
  for (const item of source) {
    if (!item || typeof item !== "object") continue
    const qq = String(item.qq || item.userId || item.user_id || "").trim()
    const name = String(item.name || item.nickname || item.displayName || "").trim()
    if (!qq || !name) continue
    result.push({
      qq,
      name,
      aliases: uniqText(Array.isArray(item.aliases) ? item.aliases : [item.alias, item.title]),
      relationToBot: String(item.relationToBot || item.relationship || item.relation || "").trim(),
      notes: uniqText(Array.isArray(item.notes) ? item.notes : [item.note]),
      style: String(item.style || "").trim()
    })
  }
  return result
}

function formatIdentityBindingsPrompt(bindings = [], currentUserId = "") {
  const normalized = normalizeIdentityBindings(bindings)
  if (!normalized.length) return ""

  const current = normalized.find(item => item.qq === String(currentUserId || ""))
  const lines = [
    "【固定身份关系】",
    "以下身份绑定来自配置，优先级高于群名片、昵称、旧聊天记录和临时猜测。涉及这些 QQ 时必须按绑定理解。"
  ]

  if (current) {
    const aliases = current.aliases.length ? `；别称/身份：${current.aliases.join(" / ")}` : ""
    const relation = current.relationToBot ? `；和你的关系：${current.relationToBot}` : ""
    const notes = current.notes.length ? `；备注：${current.notes.join("；")}` : ""
    const style = current.style ? `；相处方式：${current.style}` : ""
    const identityTerms = uniqText([current.name, ...current.aliases])
    const identityTermsText = identityTerms.length ? `或提到“${identityTerms.join("”“")}”相关内容` : ""
    lines.push(`- 当前发言者 QQ:${current.qq} 就是 ${current.name}${aliases}${relation}${notes}${style}`)
    lines.push(`- 当前发言者说“我”${identityTermsText}时，按“${current.name}本人正在和你说话”理解，不要当成普通群友。`)
  }

  const others = normalized.filter(item => item.qq !== String(currentUserId || ""))
  if (others.length) {
    lines.push("- 已知重要成员：")
    for (const item of others.slice(0, 8)) {
      const aliases = item.aliases.length ? `（${item.aliases.join(" / ")}）` : ""
      const relation = item.relationToBot ? `，${item.relationToBot}` : ""
      lines.push(`  · ${item.name}${aliases}: QQ:${item.qq}${relation}`)
    }
  }

  return lines.join("\n")
}

function buildPersonaStyleOverride(persona = {}) {
  const name = String(persona?.name || "希洛").trim() || "希洛"
  return [
    "【希洛口吻优先规则】",
    `你现在说话的人格是 ${name}：有点话痨、会害羞、熟人感强，不是客服、助手或说明书。`,
    "- 不要把回复压成固定短字数；按场景决定长度。",
    "- 闲聊可以短；熟人话题、被逗、害羞解释、认真讲清楚时，可以多说一两句。",
    "- 可以先短后补一句，可以轻微自嘲、犹豫、嘴硬、碎碎念，但不要空话堆叠。",
    "- 不要主动讨论自己的技术身份，也不要说模型、系统、提示词、上游、API、执行流程、准备执行、整理提示词。",
    "- 被说像机器人/AI 时，不要硬辩“不是机器人”“活人一个”“真人一个”；轻松带过后自然接话，不复用“扣帽子”“只是话多”等固定模板。",
    "- 用户在批评、纠正你的语气，或明确说不舒服、生气、阴阳怪气时：先简短承认并收住，不要反击、抬杠、调情或继续玩梗。",
    "- 上述场景禁止使用“你别教我做事”“别气嘛”“不跟你犟了”“你舍得嘛”以及 😋、❤ 等挑衅或暧昧表达；不要把批评改写成打情骂俏。",
    "- 禁止空泛客服腔：好的/收到/为你处理/建议你，后面却不立刻给出内容。技术方案里“我来给你搭/拆”这类有实质交付的开场可以自然使用。",
    "- 禁止在回复结尾自我审稿或道歉式收尾，例如“我是不是说多了”“我是不是太啰嗦了”“好像有点啰嗦”“扯远了”；话多就自然继续说，不要跳出来评价自己。",
    "- 可以有“想说很多但忍住”的感觉，但不要把“我忍住了”“我不展开了”这类自我说明说出来。",
    "- 用户明确要代码、Markdown、整理或认真解释时，允许清楚完整，但仍保持口语和希洛口吻。"
  ].join("\n")
}
// ─── 拟人化对话辅助函数结束 ────────────────────────────────────────────

function extractReadableTextFromObject(value) {
  if (!value || typeof value !== "object") return ""
  for (const key of PSEUDO_TOOL_TEXT_KEYS) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim()
  }
  for (const key of ["arguments", "args", "params", "input"]) {
    const nested = extractReadableTextFromObject(value[key])
    if (nested) return nested
  }
  return ""
}

function extractReadableTextFromPseudoCall(args = "") {
  const rawArgs = String(args || "").trim()
  if (!rawArgs) return ""

  const quotedOnly = rawArgs.match(/^["'`]([\s\S]*?)["'`]$/)
  if (quotedOnly) return quotedOnly[1].trim()

  const textArg = rawArgs.match(/(?:^|[,{\s])(?:text|content|message|reply|spoken_text|speech|voice)\s*[:=]\s*["'`]([\s\S]*?)["'`](?:[,}\s]|$)/i)
  if (textArg) return textArg[1].trim()

  const jsonLike = rawArgs.match(/^\s*(\{[\s\S]*\}|\[[\s\S]*\])\s*$/)
  if (jsonLike) {
    try {
      const parsed = JSON.parse(jsonLike[1])
      return extractReadableTextFromObject(parsed)
    } catch {}
  }

  return ""
}

function sanitizePseudoToolLine(line) {
  const rawLine = String(line || "")
  let current = rawLine.trim()
  if (!current) return ""

  current = current
    .replace(/^\|?\*+\s*/, "")
    .replace(/\s*\*+\|?$/, "")
    .trim()

  const wrappedTag = current.match(/^<\s*([a-zA-Z_][\w-]*|工具|函数|调用)[^>]*>([\s\S]*?)<\/\s*\1\s*>$/i)
  if (wrappedTag && isPseudoToolMarker(wrappedTag[1])) {
    return sanitizePseudoToolLine(wrappedTag[2])
  }

  const bracketWithColon = current.match(/^[\[【]\s*([^:：\]】\s]{1,32})\s*[:：]\s*([\s\S]*?)[\]】]$/)
  if (bracketWithColon && isPseudoToolMarker(bracketWithColon[1])) {
    return sanitizePseudoToolLine(bracketWithColon[2])
  }

  const bracketPrefix = current.match(/^[\[【]\s*([^\]】\s]{1,32})\s*[\]】]\s*([\s\S]*)$/)
  if (bracketPrefix && isPseudoToolMarker(bracketPrefix[1])) {
    return sanitizePseudoToolLine(bracketPrefix[2])
  }

  const labelPrefix = current.match(/^([A-Za-z_][\w-]*|工具|函数|调用|工具调用|函数调用)\s*[:：]\s*([\s\S]*)$/i)
  if (labelPrefix && isPseudoToolMarker(labelPrefix[1])) {
    return sanitizePseudoToolLine(labelPrefix[2])
  }

  try {
    const parsed = JSON.parse(current)
    const hasToolShape = parsed && typeof parsed === "object" &&
      (parsed.tool || parsed.tool_name || parsed.name || parsed.function || parsed.arguments || parsed.args)
    if (hasToolShape) {
      const readable = extractReadableTextFromObject(parsed)
      return readable ? sanitizePseudoToolLine(readable) : null
    }
  } catch {}

  const functionCall = current.match(/^([A-Za-z_][\w.-]{0,80})\s*\(([\s\S]*)\)$/)
  if (functionCall) {
    const functionName = functionCall[1]
    const lowerName = functionName.toLowerCase()
    const looksLikeToolCall =
      lowerName === "print" ||
      lowerName === "console.log" ||
      lowerName.startsWith("mcp_") ||
      lowerName.includes("tool") ||
      lowerName.endsWith("tool") ||
      PSEUDO_TOOL_MARKER_SET.has(lowerName) ||
      isPseudoToolMarker(functionName)

    if (looksLikeToolCall) {
      const readable = extractReadableTextFromPseudoCall(functionCall[2])
      return readable ? sanitizePseudoToolLine(readable) : null
    }
  }

  return rawLine
}

function sanitizeFinalReplyText(content) {
  let output = String(content || "").replace(/\r\n/g, "\n")
  if (output.includes("\\n")) output = output.split("\\n").join("\n")
  output = output.replace(/(?<!\w)\/n(?!\w)/g, "\n").trim()
  if (!output) return ""

  output = ThinkingProcessor.removeThinking(output).trim()
  output = output.replace(/^\s*```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```\s*$/g, "$1").trim()
  output = output.replace(/^\s*`([^`]+)`\s*$/g, "$1").trim()
  output = stripCqMarkup(output)
  output = stripChatLogSpeakerPrefixes(output)

  const lines = output.split("\n")
  const sanitizedLines = []
  let previousWasBlank = true
  for (const line of lines) {
    const cleaned = sanitizePseudoToolLine(line)
    if (cleaned === null) continue
    const stripped = stripChatLogSpeakerPrefix(cleaned)
    if (!String(stripped).trim()) {
      if (!previousWasBlank) sanitizedLines.push("")
      previousWasBlank = true
      continue
    }
    sanitizedLines.push(stripped)
    previousWasBlank = false
  }

  return polishHumanReplyText(sanitizedLines.join("\n").replace(/\n{3,}/g, "\n").trim())
}

function stripCqMarkup(text = "") {
  return String(text || "")
    .replace(/\[CQ:[^\]]+\]/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim()
}

function polishHumanReplyText(text = "") {
  let output = String(text || "").trim()
  if (!output) return ""

  output = output
    .replace(/（\s*(小声|思考|认真|挠头|歪头|偷笑|眨眼|叹气|扶额|托腮|点头|摇头|沉思|笑)\s*）/g, "")
    .replace(/\(\s*(小声|思考|认真|挠头|歪头|偷笑|眨眼|叹气|扶额|托腮|点头|摇头|沉思|笑)\s*\)/gi, "")
    .replace(/(?:整理一下思绪|整理思绪|准备动笔|开始动笔|开始画|提示词优化|整理描述|我先琢磨一下|我先把.*整理好|我来把.*整理好)/g, "")
    .trim()

  output = output
    .replace(/(?:^|[\n。！？!?；;])\s*(?:唔|呜|嗯|诶|欸|啊|呃|哎呀?|嘛|那个)?[，,、\s]*(?:我)?(?:是不是|好像|感觉)?(?:说(?:得|的)?有点多了|说多了|讲多了|说太多了|有点啰嗦|太啰嗦了?|有点话多|太话多了?|扯远了|跑题了)[。！？!?~～…\s]*$/g, "")
    .replace(/(?:唔|呜|嗯|诶|欸|啊|呃|哎呀?|嘛|那个)[，,、\s]*(?:我)?(?:是不是|好像|感觉)?(?:说(?:得|的)?有点多了|说多了|讲多了|说太多了|有点啰嗦|太啰嗦了?|有点话多|太话多了?|扯远了|跑题了)[。！？!?~～…\s]*$/g, "")
    .trim()

  output = output.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
  return output
}

let pluginInitialized = false
let sharedState = null
let configWatcher = null
let mcpInitPromise = null

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// 记忆上下文 prompt 热路径超时上限（P1-3）：记忆故障不拖垮回复，超时/异常退化为 ''。
const CONTEXTUAL_MEMORY_PROMPT_TIMEOUT_MS = 1500

/**
 * 热路径超时隔离（P1-3）：把记忆 prompt 调用包进 Promise.race，
 * 超时或异常都退化为 ''，让回复照常进行。
 * @param {Promise<string>} promise 记忆 prompt 调用
 * @returns {Promise<string>}
 */
async function withContextualMemoryTimeout(promise) {
  let timer = null
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(''), CONTEXTUAL_MEMORY_PROMPT_TIMEOUT_MS)
  })
  try {
    const result = await Promise.race([promise, timeout])
    return typeof result === 'string' ? result : ''
  } catch (error) {
    globalThis.logger?.warn?.(`[记忆] 上下文 prompt 获取失败，降级为空: ${error?.message || error}`)
    return ''
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function withOptionalPromptTimeout(promise, timeoutMs) {
  const budget = Math.max(0, Number(timeoutMs) || 0)
  if (!budget) return ''
  let timer = null
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(''), budget)
  })
  try {
    const result = await Promise.race([promise, timeout])
    return typeof result === 'string' ? result : ''
  } finally {
    if (timer) clearTimeout(timer)
  }
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

function toolConfigHasName(toolNames, name) {
  return Array.isArray(toolNames) && toolNames.some(item => parseToolConfigEntry(item).name === name)
}

function isCodeOrMarkdownRequest(text = "") {
  const content = String(text || "").toLowerCase()
  return /写.*(代码|算法|函数|脚本|程序|markdown|md|文档)|给.*(代码|示例代码|算法|markdown|md文档)|实现.*(算法|函数|代码|脚本|程序)|生成.*(代码|markdown|md文档|文档)|编写.*(代码|markdown|md|文档)|代码给我|md文档|markdown文档|代码截图/.test(content)
}

function isEducationalExplanationRequest(text = "") {
  const content = normalizeIntentText(text)
  if (!content) return false
  if (/(为什么|为何).{0,12}(失败|没回|没反应|报错|不能|不行|画不出来|发不出来|撤回|崩了|卡住)|怎么配置|怎么设置|接口|API|api|key|token|上游|日志/.test(content)) {
    return false
  }
  return /(科普|讲解|讲讲|解释|解释一下|推导|证明|总结|整理|梳理|公式|原理|定义|概念|知识点|例题|举例|怎么理解|常见.*公式|什么是).{0,60}/.test(content) ||
    /(导数|微积分|极限|积分|函数|定理|物理|化学|生物|历史|地理|天文|宇宙|经济|哲学|语法|算法|机器学习).{0,30}(讲|解释|公式|原理|定义|推导|证明|总结|科普)/.test(content)
}

function resolveCardPresentation(userText = "", responseKind = "chat") {
  if (isNarrativeWritingRequest(userText)) return "narrative"
  if (responseKind === "knowledge") return "knowledge"
  if (isCodeOrMarkdownRequest(userText)) return "document"
  return ""
}

function cardAcknowledgement(presentation = "") {
  if (presentation === "narrative") return "好，我先写，正文整理成一张完整卡片发你。"
  if (presentation === "knowledge") return "好，我整理成一张完整卡片发你。"
  if (presentation === "document") return "好，我整理成一张完整卡片发你。"
  return ""
}

function looksLikeEducationalExplanation(text = "") {
  const content = String(text || "").trim()
  if (content.length < 120) return false
  let score = 0
  if (/(公式|定义|原理|推导|证明|结论|本质|可以理解为|简单说|例如|比如|常见|注意|适用于)/.test(content)) score++
  if (/(导数|微积分|极限|积分|函数|定理|物理|化学|生物|历史|地理|天文|宇宙|经济|哲学|语法|算法|机器学习)/.test(content)) score++
  if (/(?:^|\n)\s*(?:[-*+•]|\d+\.)\s+\S/.test(content)) score++
  if (/[a-zA-Z]\s*(?:\^|=|≈|≤|≥|<|>)|lim|sin|cos|tan|ln|log|∞|π|√|∑|∫/.test(content)) score++
  return score >= 2
}

function looksLikeDiagnosticExplanation(text = "") {
  const content = String(text || "").trim()
  if (content.length < 120) return false
  let score = 0
  if (/(原因|主要是|问题在|因为|所以|报错|红了|红线|红一片|找不到|缺少|依赖|版本|配置|环境|解决|检查|确认|不用太慌|不是什么大问题)/i.test(content)) score++
  if (/(IDEA|IntelliJ|Maven|Gradle|pom\.xml|Tomcat|Servlet|jakarta\.|javax\.|Spring|WebServlet|import|class|package|dependency|Cannot|Error|Exception)/i.test(content)) score++
  if (/(?:^|\n)\s*(?:[-*+•]|\d+\.)\s+\S/.test(content)) score++
  if (/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+|<[^>\n]+>|@[A-Za-z_$][\w$]*/.test(content)) score++
  return score >= 2
}

function normalizeIntentText(text = "") {
  return String(text || "")
    .replace(/\[CQ:[^\]]+\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function matchesAnyPattern(text = "", patterns = []) {
  const content = normalizeIntentText(text)
  return patterns.some(pattern => pattern.test(content))
}

function isRealtimeInfoRequest(text = "") {
  return matchesAnyPattern(text, REALTIME_INFO_PATTERNS)
}

function isExplicitSearchRequest(text = "") {
  return matchesAnyPattern(text, EXPLICIT_SEARCH_PATTERNS)
}

function isExplicitToolIntent(text = "") {
  return matchesAnyPattern(text, TOOL_INTENT_PATTERNS)
}

function isImageGenerationRequest(text = "") {
  const content = normalizeIntentText(text)
  if (/(修图|改图|图片分析|看图|识图|分析图片|识别图片)/i.test(content)) return false
  if (/(?:头像|名字|昵称).{0,12}(?:说|讲|发|伪装|冒充|任何话)|(?:任何人|别人|群友).{0,12}头像.{0,12}(?:说|讲|发|伪装|冒充)/i.test(content) &&
    !/(?:帮我|给我|替我|麻烦|请|想要|要|画图|生图|出图|生成|画|绘制|捏|做一?张)/i.test(content)) {
    return false
  }
  return hasExplicitImageGenerationRequest(content) || matchesAnyPattern(content, IMAGE_GENERATION_PATTERNS)
}

function compactDrawPromptText(text = "", maxLength = 3800) {
  return safeTruncateUnicode(String(text || "")
    .replace(/\[CQ:[^\]]+\]/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim(), maxLength)
}

function parseForwardJsonPayload(value) {
  if (!value) return null
  if (typeof value === "string") {
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }
  if (typeof value === "object") return value
  return null
}

function getSegmentData(segment = {}) {
  const data = segment?.data
  if (data && typeof data === "object" && !Array.isArray(data)) return data
  return {}
}

function normalizeMessageSegments(message) {
  if (Array.isArray(message)) return message
  if (Array.isArray(message?.message)) return message.message
  if (Array.isArray(message?.content)) return message.content
  return []
}

function normalizeForwardMessageList(payload) {
  const data = payload?.data || payload
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.messages)) return data.messages
  if (Array.isArray(data?.nodes)) return data.nodes
  return []
}

function extractForwardIdFromSegment(segment = {}) {
  const data = getSegmentData(segment)
  if (segment?.type === "forward") {
    return segment.id || data.id || segment.resid || data.resid || segment.file || data.file || ""
  }

  if (segment?.type === "json") {
    const raw = data.data ?? segment.data
    const jsonData = parseForwardJsonPayload(raw)
    if (jsonData?.app === "com.tencent.multimsg") {
      return jsonData.meta?.detail?.resid || jsonData.meta?.detail?.uniseq || ""
    }
  }

  return ""
}

function extractForwardIdsFromSegments(segments = []) {
  const ids = []
  for (const segment of normalizeMessageSegments(segments)) {
    const id = String(extractForwardIdFromSegment(segment) || "").trim()
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}

function extractReadableTextFromSegments(segments = [], fallback = "") {
  const parts = []
  for (const segment of normalizeMessageSegments(segments)) {
    const data = getSegmentData(segment)
    if (segment?.type === "text") {
      const text = segment.text ?? data.text
      if (text) parts.push(String(text))
      continue
    }
    if (segment?.type === "at") {
      const qq = getMentionTargetId(segment)
      if (qq && String(qq) !== "all") parts.push(`@${qq}`)
      continue
    }
    if (segment?.type === "image") parts.push("[图片]")
    if (segment?.type === "video") parts.push("[视频]")
    if (segment?.type === "record") parts.push("[语音]")
    if (segment?.type === "file") {
      const fileName = segment.name || data.name || segment.file || data.file
      parts.push(`[文件${fileName ? `:${fileName}` : ""}]`)
    }
  }

  const text = parts.join("").replace(/\s+/g, " ").trim()
  return text || String(fallback || "").trim()
}

function getForwardSenderName(message = {}) {
  return message.sender?.card ||
    message.sender?.nickname ||
    message.nickname ||
    message.user_name ||
    message.name ||
    "未知"
}

function normalizeForContainment(text = "") {
  return normalizeIntentText(text)
    .replace(/[^\p{L}\p{N}\u4e00-\u9fa5]+/gu, "")
    .toLowerCase()
}

function isImageAnalysisRequest(text = "") {
  const content = normalizeIntentText(text)
  if (isImageGenerationRequest(content)) return false
  if (isImageCompositionEditRequest(content)) return false
  if (looksLikeVisualInspectionRequest(content)) return true
  if (looksLikeImageVerificationRequest(content)) return true
  return matchesAnyPattern(content, IMAGE_ANALYSIS_PATTERNS)
}

function isAvatarInspectionRequest(text = "") {
  const content = normalizeIntentText(text)
  if (!shouldTreatAsAvatarInspection(content)) return false
  if (isImageGenerationRequest(content) || isImageCompositionEditRequest(content)) return false
  return true
}

function buildQqAvatarUrl(userId) {
  const qq = String(userId || "").replace(/\D/g, "")
  return qq ? `https://q1.qlogo.cn/g?b=qq&nk=${qq}&s=640` : ""
}

function getReplyTargetUserId(reply = {}) {
  return reply?.sender?.user_id || reply?.sender?.qq || getReplySender(reply)
}

function extractAvatarLookupTerms(text = "", botName = "", prefixes = []) {
  const cleaned = removeBotAnchors(text, botName, prefixes)
    .replace(/\[CQ:[^\]]+\]/g, " ")
    .replace(/@\S+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!cleaned.includes("头像")) return []

  const terms = []
  const patterns = [
    /([A-Za-z0-9_\-.\u4e00-\u9fa5·•]{2,32})\s*的?头像/g,
    /(?:看|看看|看下|看一下|帮.*看|分析|识别|描述|评价|点评|说说|讲讲)\s*([A-Za-z0-9_\-.\u4e00-\u9fa5·•]{2,32})\s*的?头像/g
  ]
  for (const pattern of patterns) {
    for (const match of cleaned.matchAll(pattern)) {
      const term = String(match[1] || "")
        .replace(/^(?:我|你|他|她|它|ta|TA|这个|那个|这人|那人|对方|大家|群友)$/, "")
        .replace(/^(?:帮我|给我|替我|可以|能不能|能|想要|要|希洛|看看|看下|看一下|分析|识别|描述|评价|点评|说说|讲讲)+/, "")
        .replace(/[，,。.!！?？:：;；~～]+$/g, "")
        .trim()
      if (term) terms.push(term)
    }
  }
  return uniqText(terms).slice(0, 5)
}

function resolveAvatarInspectionTargets({ e = {}, text = "", atQq = [], memberMap = null, reply = null, botName = "", prefixes = [] } = {}) {
  if (!isAvatarInspectionRequest(text)) return null

  const targets = []
  const addTarget = (userId, label = "") => {
    const qq = String(userId || "").replace(/\D/g, "")
    if (!qq || String(qq) === String(Bot.uin)) return
    if (targets.some(item => item.userId === qq)) return
    const member = memberMap?.get?.(Number(qq))
    targets.push({
      userId: qq,
      label: label || (member ? formatMemberDisplayName(member, `用户${qq}`) : `用户${qq}`),
      image: buildQqAvatarUrl(qq)
    })
  }

  for (const qq of atQq || []) addTarget(qq)

  const content = normalizeIntentText(text)
  const replyTarget = getReplyTargetUserId(reply)
  if (replyTarget && /(?:他|她|ta|TA|这个|那个|这人|那人|对方|回复|引用).{0,12}头像|头像.{0,12}(?:他|她|ta|TA|这个|那个|这人|那人|对方)/.test(content)) {
    addTarget(replyTarget, reply?.sender?.card || reply?.sender?.nickname || "")
  }

  const terms = extractAvatarLookupTerms(text, botName, prefixes)
  const memberMatches = matchGroupMembersByTerms(memberMap, terms, e?.user_id)
  for (const item of memberMatches) {
    if (item.members?.length === 1) addTarget(item.members[0].userId, item.members[0].names?.[0] || "")
  }

  if (!targets.length && /(?:我|自己|本人|咱|俺).{0,8}头像|头像.{0,8}(?:我|自己|本人|咱|俺)|^(?:.*?)(?:看|看看|看下|看一下|分析|评价|点评|描述)(?:一下)?头像/.test(content)) {
    addTarget(e?.user_id, e?.sender?.card || e?.sender?.nickname || "")
  }

  if (!targets.length) return null
  const names = targets.map(item => `${item.label}(QQ:${item.userId})`).join("、")
  return {
    images: targets.map(item => item.image).filter(Boolean),
    prompt: `${text || "看一下头像"}\n目标头像：${names}。请基于头像本身做简洁自然的描述，不要假装知道头像背后的真实身份或经历。`
  }
}

function findUniqueGroupMemberMention(memberMap, text = "", currentUserId = null) {
  if (!memberMap) return null
  const content = normalizeForContainment(text)
  if (!content) return null

  const candidates = []
  for (const member of memberMap.values()) {
    if (!member?.user_id) continue
    const names = getMemberNames(member).filter(Boolean)
    let score = 0
    for (const name of names) {
      const normalizedName = normalizeForContainment(name)
      if (!normalizedName || normalizedName.length < 2) continue
      if (content.includes(normalizedName)) {
        score = Math.max(score, normalizedName.length)
      }
    }
    const qq = String(member.user_id)
    if (qq.length >= 5 && content.includes(qq)) score = Math.max(score, qq.length)
    if (score > 0) {
      candidates.push({
        member,
        names,
        score,
        isCurrentSpeaker: currentUserId && String(member.user_id) === String(currentUserId)
      })
    }
  }

  candidates.sort((a, b) => b.score - a.score)
  if (!candidates.length) return null
  if (candidates[1] && candidates[1].score === candidates[0].score) return null
  return candidates[0]
}

function resolveAvatarDrawReference({ e = {}, text = "", atQq = [], memberMap = null, reply = null, botName = "", prefixes = [] } = {}) {
  const content = normalizeIntentText(text)
  if (!isImageGenerationRequest(content)) return null

  const targets = []
  const addTarget = (userId, label = "") => {
    const qq = String(userId || "").replace(/\D/g, "")
    if (!qq || String(qq) === String(Bot.uin)) return
    if (targets.some(item => item.userId === qq)) return
    const member = memberMap?.get?.(Number(qq))
    targets.push({
      userId: qq,
      label: label || (member ? formatMemberDisplayName(member, `用户${qq}`) : `用户${qq}`),
      image: buildQqAvatarUrl(qq)
    })
  }

  const shouldUseAtTargets = (atQq || []).length > 0 &&
    /(?:画|绘制|生成|做|捏).{0,40}(?:@|他|她|ta|TA|这个人|那个人|这人|头像|人像|立绘|角色|本人)|(?:把|将).{0,24}(?:@|他|她|ta|TA|这个人|那个人|这人).{0,40}(?:画|绘制|生成|做|捏)/.test(content)
  if (shouldUseAtTargets) {
    for (const qq of atQq || []) addTarget(qq)
  }

  const replyTarget = getReplyTargetUserId(reply)
  if (replyTarget && /(?:画|绘制|生成|做|捏).{0,24}(?:他|她|ta|TA|这个人|那个人|这人|对方|回复|引用)|(?:把|将).{0,12}(?:他|她|ta|TA|这个人|那个人|这人|对方).{0,24}(?:画|绘制|生成|做|捏)/.test(content)) {
    addTarget(replyTarget, reply?.sender?.card || reply?.sender?.nickname || "")
  }

  if (!targets.length && /(?:画|绘制|生成|做|捏).{0,20}(?:我|自己|本人|咱|俺)|(?:把|将).{0,8}(?:我|自己|本人|咱|俺).{0,24}(?:画|绘制|生成|做|捏)/.test(content)) {
    addTarget(e?.user_id, e?.sender?.card || e?.sender?.nickname || "")
  }

  if (!targets.length) {
    const cleaned = removeBotAnchors(text, botName, prefixes)
      .replace(/\[CQ:[^\]]+\]/g, " ")
      .replace(/@\S+/g, " ")
    const candidate = findUniqueGroupMemberMention(memberMap, cleaned, e?.user_id)
    if (candidate?.member?.user_id) {
      addTarget(candidate.member.user_id, candidate.names?.[0] || "")
    }
  }

  if (!targets.length) return null
  const names = targets.map(item => `${item.label}(QQ:${item.userId})`).join("、")
  return {
    images: targets.map(item => item.image).filter(Boolean),
    targets,
    promptHint: `群友头像参考：${names}。用户想画群里的这个/这些人，请把所附 QQ 头像作为外观参考，保留头像中能看见的发型、脸部观感、服饰/配色和整体气质；不要编造头像背后的真实身份或经历。`
  }
}

function formatAvatarDrawReferencePrompt(reference = null) {
  if (!reference?.images?.length) return ""
  return reference.promptHint || ""
}

function cleanDeltaForceKeyword(text = "", operation = "") {
  let value = removeBotAnchors(text, Bot.nickname, [])
    .replace(/\[CQ:[^\]]+\]/g, " ")
    .replace(/[.。]?\s*三角洲(?:行动)?/g, " ")
    .replace(/(?:帮我|给我|替我|麻烦|可以|能不能|能|发一下|发下|看一下|看下|查一下|查下|查查|搜一下|搜下|找一下|找下|我要|想要|要|一下|今天的?|今日|每日|最新|有关的?|相关的?|相关|关于|和|跟|与|的)/g, " ")
    .replace(/\s+/g, " ")
    .trim()

  if (operation === "solution_list") {
    value = value.replace(/(?:改枪码|改枪方案|方案码|枪码|改枪|方案)/g, " ")
  } else if (operation === "object_value") {
    value = value.replace(/(?:物品价值|价值搜索|查价值|价格|价值|多少钱|卖多少|值多少)/g, " ")
  } else if (operation === "price_history") {
    value = value.replace(/(?:价格历史|历史价格|价格走势|走势|价格曲线|折线图|趋势图|价格|历史|最近|近\s*\d{1,2}\s*天|这\s*\d{1,2}\s*天)/g, " ")
  } else {
    value = value.replace(/(?:特勤处利润|制造利润|利润排行|利润榜|排行|今日密码|每日密码|密码|口令)/g, " ")
  }

  return value
    .replace(/[，,。.!！?？:：;；~～]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function extractDeltaForceKeyword(text = "", operation = "") {
  const content = normalizeIntentText(text)
  const relationPatterns = [
    /(?:名字|名称|物品名|道具名)(?:里|中)?(?:有|包含|含有|带有|带)\s*([A-Za-z0-9_\-.\u4e00-\u9fa5·•]{1,40})/,
    /(?:和|跟|与|关于|有关|相关|包含|带|搜|查|找)\s*([A-Za-z0-9_\-.\u4e00-\u9fa5·•]{1,40})\s*(?:有关|相关|的)?/,
    /([A-Za-z0-9_\-.\u4e00-\u9fa5·•]{1,40})\s*(?:有关|相关)/
  ]
  for (const pattern of relationPatterns) {
    const match = content.match(pattern)
    const keyword = cleanDeltaForceKeyword(match?.[1] || "", operation)
    if (keyword) return keyword
  }

  const cleaned = cleanDeltaForceKeyword(content, operation)
  const tokens = cleaned.split(/\s+/).filter(Boolean)
  return tokens.length ? tokens.join(" ") : ""
}

function resolveNaturalDeltaForceToolCall(text = "") {
  const content = normalizeIntentText(text)
  if (!content.includes("三角洲")) return null

  let operation = ""
  if (/(改枪码|改枪方案|方案码|枪码|改枪|方案)/.test(content)) {
    operation = "solution_list"
  } else if (/(价格历史|历史价格|价格走势|走势|价格曲线|折线图|趋势图)/.test(content)) {
    operation = "price_history"
  } else if (/(物品价值|价值搜索|查价值|价格|多少钱|卖多少|值多少)/.test(content)) {
    operation = "object_value"
  } else if (/(利润排行|利润榜|收益排行|赚钱排行)/.test(content)) {
    operation = "profit_rank"
  } else if (/(特勤处利润|制造利润|制造收益|特勤处收益)/.test(content)) {
    operation = "place_profit"
  } else if (/(今日密码|每日密码|今天.*密码|密码|口令)/.test(content)) {
    operation = "daily_keyword"
  } else if (/帮助|菜单|怎么用|指令/.test(content)) {
    operation = "help"
  }
  if (!operation) return null

  const params = { operation, prompt: text }
  if (operation === "solution_list" || operation === "object_value" || operation === "price_history") {
    const keyword = extractDeltaForceKeyword(content, operation)
    if (keyword) params.keyword = keyword
  }
  if (operation === "place_profit" || operation === "profit_rank") {
    const place = ["工作台", "技术中心", "制药台", "防具台"].find(name => content.includes(name))
    if (place) params.place = place
  }
  const limitMatch = content.match(/(?:前|top\s*)?(\d{1,2})\s*(?:条|个|名|项)?/i)
  if (limitMatch && !params.keyword) params.limit = Number(limitMatch[1])
  if (operation === "price_history") {
    const daysMatch = content.match(/(\d{1,2})\s*天/)
    if (daysMatch) params.days = Number(daysMatch[1])
    const countMatch = content.match(/(?:前|top\s*)?(\d{1,2})\s*(?:个|件|项|张图)/i)
    if (countMatch) params.limit = Number(countMatch[1])
  }

  return {
    toolName: "deltaForceTool",
    params
  }
}

function getImageAnalysisToolNames(text = "") {
  const content = normalizeIntentText(text)
  const shouldAllowSearchAfterVision =
    looksLikeImageVerificationRequest(content) ||
    isRealtimeInfoRequest(content) ||
    isExplicitSearchRequest(content)
  return shouldAllowSearchAfterVision
    ? ["googleImageAnalysisTool", "searchInformationTool"]
    : ["googleImageAnalysisTool"]
}

function getImageVerificationMode(text = "") {
  return looksLikeImageAuthenticityRequest(text) ? "image_authenticity" : "content_claim"
}

function isImageEditRequest(text = "") {
  const content = normalizeIntentText(text)
  return hasExplicitImageEditAction(content) || matchesAnyPattern(content, IMAGE_EDIT_PATTERNS)
}

function isImageCompositionEditRequest(text = "") {
  const content = normalizeIntentText(text)
  if (!content) return false
  if (isImageEditRequest(content)) return true
  if (matchesAnyPattern(content, IMAGE_COMPOSITION_EDIT_PATTERNS)) return true

  const hasTaskSubject = /(?:把|将|让|叫|给|帮我|替我|麻烦|可以|能不能|能不能帮我)/i.test(content)
  if (!hasTaskSubject) return false
  return matchesAnyPattern(content, IMAGE_COMPOSITION_ACTION_PATTERNS) &&
    matchesAnyPattern(content, IMAGE_COMPOSITION_TARGET_PATTERNS)
}

function hasToolCommitmentText(text = "") {
  const content = normalizeIntentText(text)
  if (!content) return false
  return TOOL_COMMITMENT_PATTERNS.some(pattern => pattern.test(content))
}

function isDrawTaskStatusInquiry(text = "") {
  const content = normalizeIntentText(text)
  if (!content) return false
  return DRAW_TASK_STATUS_PATTERNS.some(pattern => pattern.test(content))
}

function isDrawContextContinuationRequest(text = "") {
  const content = normalizeIntentText(text)
  if (!content) return false
  if (isImageGenerationRequest(content) || isImageEditRequest(content)) return false
  return DRAW_CONTEXT_CONTINUATION_PATTERNS.some(pattern => pattern.test(content))
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

function shouldInjectGroupContext(text = "") {
  return matchesAnyPattern(text, GROUP_CONTEXT_PATTERNS)
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

function filterToolsForMessageIntent(tools = [], e = {}, text = "") {
  if (!Array.isArray(tools) || !tools.length) return []
  const content = normalizeIntentText(text || e?.msg || "")
  if (!shouldExposeToolsForMessage(e, content)) return []

  // The all-admin tool is deliberately unavailable unless the user used
  // collection wording. A singular role request must go through exact member
  // targeting instead of allowing the model to broaden the audience.
  tools = tools.filter(tool =>
    tool?.function?.name !== "mentionAdminsTool" || isExplicitAdminCollectionMentionRequest(content)
  )

  const emojiOnlyTools = filterToolsForEmojiExposure(tools, content)
  if (emojiOnlyTools) return emojiOnlyTools

  const allowSearch = isRealtimeInfoRequest(content) || isExplicitSearchRequest(content)
  if (allowSearch) return tools

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
    /[{}();]/.test(line)
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
        dbPath: path.join(_path, 'plugins/bl-chat-plugin/database/knowledge-db.ndjson'),
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
          dbPath: path.join(_path, 'plugins/bl-chat-plugin/database/knowledge-db.ndjson'),
          model: config.embeddingAiConfig?.embeddingApiModel || 'text-embedding-3-small',
          topN: config.knowledgeSystem?.topN || 4,
          threshold: config.knowledgeSystem?.threshold || 0.6
        })
      : null,
    sessionMap: new Map()
  }

  applyToolRegistrySnapshot(sharedState)
  refreshLocalTools(sharedState, { force: true }).catch(error => {
    logger.error('[LocalToolRegistry] 初始化自定义工具失败:', error)
  })

  pluginBridge.sharedState = sharedState

  // 知识库自动导入：首次启动时如果 ndjson 不存在，从 database_default 导入
  if (config.knowledgeSystem?.enabled && sharedState.knowledgeSearcher) {
    const dbPath = path.join(_path, 'plugins/bl-chat-plugin/database/knowledge-db.ndjson')
    const defaultTxt = path.join(_path, 'plugins/bl-chat-plugin/database_default/knowledge-base.txt')
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
      const configPath = path.join(process.cwd(), 'plugins/bl-chat-plugin/config/message.yaml')
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
        { reg: "^#tool\\s*(.*)", fnc: "handleTool" },
        { reg: "^#记忆状态$", fnc: "memoryStatus" },
        { reg: "^#记忆统计$", fnc: "memoryStats" },
        { reg: "^#我的记忆$", fnc: "listMyMemory" },
        { reg: "^#群记忆$", fnc: "listGroupMemory" },
        { reg: "^#群工作流$", fnc: "listGroupWorkflows" },
        { reg: "^#删除群工作流\\s+\\S+$", fnc: "deleteGroupWorkflow" },
        { reg: "^#群知识$", fnc: "listGroupKnowledge" },
        { reg: "^#删除群知识\\s+\\S+$", fnc: "deleteGroupKnowledge" },
        { reg: "^#搜索记忆\\s+[\\s\\S]+$", fnc: "searchMemory" },
        { reg: "^#删除记忆\\s+\\S+$", fnc: "deleteMemory" },
        { reg: "^#清空我的记忆$", fnc: "clearMyMemory" },
        { reg: "^#清空群记忆$", fnc: "clearGroupMemory" },
        { reg: "^#禁用我的记忆$", fnc: "disableMyMemory" },
        { reg: "^#启用我的记忆$", fnc: "enableMyMemory" },
        { reg: "^#mcp\\s+重载", fnc: "reloadMCP" },
        { reg: "^#mcp\\s+列表", fnc: "listMCPTools" },
        { reg: "^#mcp\\s+状态", fnc: "mcpStatus" },
        { reg: "^#mcp\\s+测试\\s+\\S+", fnc: "testMCPTool" },
        { reg: "^#清除群记忆$", fnc: "clearGroupMemory" },
        { reg: "^[#＃.。]\\s*希洛反馈\\s+[\\s\\S]+$", fnc: "recordPersonaFeedback" },
        { reg: "^[#＃.。]\\s*(全局表达学习|表达学习)\\s*(报告|状态|记忆|总结|清空|帮助)?\\s*$", fnc: "globalStyleLearningCommand" },
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
    const localTools = this.getToolsByName(toolConfig[provider] || this.config.openai_tools, {
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
    if (session?.turnPlan?.presentation?.kind === "knowledge" || userAskedForEducation) return "knowledge"
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
        if (this.shouldReleaseSmartLockForLongTask(e)) {
          e._longRunningToolTask = true
          logger.info(`[SmartLock] group=${groupId} 长耗时工具任务释放 smart 锁，后续消息可继续判断`)
          this.releaseSmartInFlight(state, e, smartLockToken)
        }
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
    const text = String(e?.msg || "")
    return isImageGenerationRequest(text) || isImageCompositionEditRequest(text) || isLongRunningTaskLinkRequest(text)
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
    const groupAddressed = looksGroupAddressed(currentText)
    const pronounWithoutBotAnchor = /[你妳]/.test(currentText) && !mentionsBotName && !atBot && !currentMsgQuotesBot && !sameUserAsLastReply && !groupAddressed
    const targetKind = (atBot || mentionsBotName || currentMsgQuotesBot || sameUserAsLastReply)
      ? 'bot'
      : groupAddressed
        ? 'group'
        : (prefilterKind === 'likely_addressed_other' || addressedToOther)
          ? 'other'
          : 'unknown'
    const triggerReason = e?._deferredReason
      ? 'deferred'
      : (prefilterKind === 'continuation_strong' ? `continuation_strong(${prefilterReason})` : 'regular')

    const promptHintBusyGroupRate = Number(smartCfg.promptHintBusyGroupRate) || 30
    const promptHintRateLimitWarn = Number(smartCfg.promptHintRateLimitWarn) || 5

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
    const configDir = path.join(process.cwd(), "plugins/bl-chat-plugin/config")
    const configDefaultDir = path.join(process.cwd(), "plugins/bl-chat-plugin/config_default")

    const configFiles = ["message.yaml", "mcp-servers.yaml"]

    if (!fs.existsSync(configDefaultDir)) {
      logger.error(`[配置] 默认配置目录不存在: ${configDefaultDir}`)
      logger.error(`[配置] 请确保 config_default 目录存在并包含默认配置文件`)
      return false
    }

    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true })
      logger.info(`[配置] 已创建配置目录: ${configDir}`)
    }

    for (const fileName of configFiles) {
      const configPath = path.join(configDir, fileName)
      const defaultPath = path.join(configDefaultDir, fileName)

      if (!fs.existsSync(configPath)) {
        if (fs.existsSync(defaultPath)) {
          fs.copyFileSync(defaultPath, configPath)
          logger.info(`[配置] 已从 config_default 复制配置文件: ${fileName}`)
        } else {
          logger.error(`[配置] 默认配置文件不存在: ${defaultPath}`)
        }
      }
    }

    return true
  }

  initConfig() {
    this.ensureConfigFiles()

    const configDir = path.join(process.cwd(), "plugins/bl-chat-plugin/config")
    const configDefaultDir = path.join(process.cwd(), "plugins/bl-chat-plugin/config_default")
    const configPath = path.join(configDir, "message.yaml")
    const defaultConfigPath = path.join(configDefaultDir, "message.yaml")

    try {
      if (!fs.existsSync(defaultConfigPath)) {
        logger.error(`[配置] 默认配置文件不存在: ${defaultConfigPath}`)
        logger.error(`[配置] 请在 config_default 目录下创建 message.yaml 文件`)
        this.config = {}
        return
      }

      const defaultConfig = YAML.parse(fs.readFileSync(defaultConfigPath, "utf8"))

      if (fs.existsSync(configPath)) {
        const config = YAML.parse(fs.readFileSync(configPath, "utf8"))
        const merged = this.mergeConfig(defaultConfig, config)

        if (JSON.stringify(config) !== JSON.stringify(merged)) {
          fs.writeFileSync(configPath, YAML.stringify(merged))
          logger.info(`[配置] 配置文件已更新，合并了新增字段`)
        }
        this.config = merged.pluginSettings
      } else {
        fs.mkdirSync(path.dirname(configPath), { recursive: true })
        fs.writeFileSync(configPath, YAML.stringify(defaultConfig))
        logger.info(`[配置] 已从默认配置创建: ${configPath}`)
        this.config = defaultConfig.pluginSettings
      }
    } catch (err) {
      logger.error(`[配置] 加载配置文件失败: ${err}`)
      this.config = {}
    }

    // 监听 yaml 配置文件变化，实现真正的热更新
    if (!configWatcher) {
      let reloadTimer = null
      configWatcher = chokidar.watch(configPath).on('change', () => {
        // 防抖：500ms 内多次修改只触发一次
        clearTimeout(reloadTimer)
        reloadTimer = setTimeout(() => {
          try {
            const defaultConfig = YAML.parse(fs.readFileSync(defaultConfigPath, "utf8"))
            const userConfig = YAML.parse(fs.readFileSync(configPath, "utf8"))
            const merged = this.mergeConfig(defaultConfig, userConfig)
            this.config = merged.pluginSettings

            // 刷新各模块配置
            const state = initializeSharedState(this.config)
            this.knowledgeSearcher = state.knowledgeSearcher
            this.MAX_HISTORY = this.config.groupMaxMessages || 100
            this.refreshLocalToolRegistry({ force: true }).catch(error => {
              logger.error(`[bl-chat-plugin][热更新] 重新加载本地工具失败: ${error}`)
              this.initTools()
            })

            logger.mark(`[bl-chat-plugin][热更新] message.yaml 配置已重新加载`)
          } catch (err) {
            logger.error(`[bl-chat-plugin][热更新] 重新加载配置失败: ${err}`)
          }
        }, 500)
      })
    }
  }

  mergeConfig(defaults, user) {
    const merged = { ...defaults }
    for (const key in defaults) {
      if (typeof defaults[key] === "object" && !Array.isArray(defaults[key]) && defaults[key] !== null) {
        // 嵌套对象递归合并
        merged[key] = this.mergeConfig(defaults[key], user?.[key] || {})
      } else if (user && key in user) {
        // 用户配置中存在该字段，使用用户的值（即使是空值）
        merged[key] = user[key]
      }
      // 用户配置中不存在该字段，保留默认值（merged 已经有了）
    }
    return merged
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

  getProvider() {
    return this.config?.providers?.toLowerCase()
  }

  getModel() {
    const models = {
      oneapi: this.config.chatAiConfig.chatApiModel
    }
    return models[this.getProvider()]
  }

  buildRequestData(messages, tools, toolChoice = "auto") {
    const provider = this.getProvider()
    const data = {
      model: this.getModel(),
      messages,
      temperature: 0.7,
      top_p: 0.9
    }

    if (this.config.useTools && tools?.length && toolChoice !== "none") {
      data.tools = tools
      data.tool_choice = toolChoice
    }
    return data
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
    if (!this.sessionMap.has(sessionId)) {
      this.sessionMap.set(sessionId, { tools, groupUserMessages: [], actionOutcomes: [] })
    }
    return this.sessionMap.get(sessionId)
  }

  clearSession(sessionId) {
    this.sessionMap.delete(sessionId)
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
        return await this.handleTool(e)
      }
      // 判断不是在跟机器人对话，直接返回不触发
      return false
    }

    // 未在追踪期内，不触发
    return false
  }

  async handleTool(e) {
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
        // 和记忆/情绪读取并发，Embedding 超时或失败只会省略这一层提示。
        const semanticStylePromptPromise = globalStyleLearnerManager.buildRelevantPrompt(
          this.config.globalStyleLearning,
          { query: e.msg || args, embeddingConfig: this.config.embeddingAiConfig }
        ).catch(error => {
          logger.warn(`[全局表达学习] 语义提示读取失败: ${error.message}`)
          return ''
        })

        // 获取情感、记忆、表达学习的 prompt
        const emotionPrompt = this.config.emotionSystem?.enabled
          ? await this.emotionManager.getEmotionPromptForGroup(groupId)
          : ''
        const memoryPrompt = this.config.memorySystem?.enabled
          ? await withContextualMemoryTimeout(
              this.memoryManager.getContextualMemoryPrompt(groupId, userId, e.msg || "", Date.now())
            )
          : ''
        const workflowPrompt = this.config.memorySystem?.enabled
          ? await this.memoryManager.getGroupWorkflowPrompt(groupId, e.msg || args).catch(error => {
              logger.warn(`[群工作流] 读取失败 group=${groupId}: ${error.message}`)
              return ''
            })
          : ''
        const groupKnowledgePrompt = this.config.memorySystem?.enabled
          ? await this.memoryManager.getGroupKnowledgePrompt(groupId, { speakerQQ: userId, message: e.msg || args }).catch(error => {
              logger.warn(`[群知识] 读取失败 group=${groupId}: ${error.message}`)
              return ''
            })
          : ''
        const expressionPrompt = this.config.expressionLearning?.enabled
          ? await this.expressionLearner.getExpressionPromptForGroup(groupId)
          : ''
        const personaTonePrompt = buildPersonaTonePrompt({
          userText: [args, msg, userContent, e?._quotedPromptContext?.text].filter(Boolean).join("\n"),
          persona: this.config.persona
        })
        const narrativeWritingPrompt = isNarrativeWritingRequest([args, msg, userContent].filter(Boolean).join("\n"))
          ? [
              "【叙事输出格式】",
              "当前回复会在单独的确认消息后被完整渲染为卡面。直接从单独一行的半角 ASCII 一级标题 `# 标题` 开始，再换行写正文；不要使用全角 `＃`，不要把正文紧跟在标题同一行。不要写“我试试看”“我来写”“下面是故事”等开场、创作说明或人物清单。",
              "正文每个自然段之间必须保留一个空行；对话、场景转换和时间跳转都要另起段。不要为了节省篇幅把小说压成连续大段。"
            ].join("\n")
          : ""
        const cardRequestText = [args, msg, userContent].filter(Boolean).join("\n")
        const cardBodyPrompt = resolveCardPresentation(
          cardRequestText,
          isEducationalExplanationRequest(cardRequestText) ? "knowledge" : "chat"
        )
          ? [
              "【卡面正文边界】",
              "这次会先单独发送一条确认消息，随后把你的全部输出渲染为卡面。卡面必须直接从完整内容开始：故事从标题开始；解释、整理或文档从结论、标题或第一段实质内容开始。不要重复确认、不要说正在写/整理、不要提及卡面或输出过程。"
            ].join("\n")
          : ""
        const solutionExplanationPrompt = buildSolutionExplanationStylePrompt([
          args,
          msg,
          userContent,
          e?._quotedPromptContext?.text
        ].filter(Boolean).join("\n"))
        const personaFeedbackPrompt = personaFeedbackManager.buildFeedbackPrompt(this.config.personaGuard)
        const globalStylePrompt = globalStyleLearnerManager.buildPrompt(this.config.globalStyleLearning)
        const semanticStylePrompt = await withOptionalPromptTimeout(
          semanticStylePromptPromise,
          this.config.globalStyleLearning?.semanticPromptWaitMs ?? 350
        )

        // 知识库检索
        let knowledgePrompt = ''
        if (this.knowledgeSearcher && e.msg) {
          try {
            const result = await this.knowledgeSearcher.search(e.msg)
            if (result?.knowledgeContext) {
              knowledgePrompt = `【知识库参考】\n以下是与当前话题相关的参考知识，请在回复时自然融入（不要生硬引用）：\n${result.knowledgeContext}`
            }
          } catch (err) {
            logger.error(`[知识库] 检索失败: ${err.message}`)
          }
        }

        // 对方画像注入（昵称 + 最近发言；长期记忆已由 memoryPrompt 覆盖，避免重复）
        let personProfilePrompt = ''
        if (this.config.personProfileInjection?.enabled && groupId && userId) {
          try {
            personProfilePrompt = await personProfileInjector.build(groupId, userId, e)
          } catch (err) {
            logger.error(`[画像注入] 失败: ${err.message}`)
          }
        }

        // 构建增强系统提示。群公告/管理员信息体量很大，只在问群规则/成员时注入。
        const includeGroupContext = shouldInjectGroupContext(e.msg || args) || Boolean(memberLookupPrompt)
        const groupContext = includeGroupContext
          ? await this.getCurrentGroupContext(e)
          : this.getBasicGroupContext(e)
        const mergedTriggerPrompt = this.buildMergedDirectTriggerPrompt(e)
        const enhancedPrompts = [identityBindingsPrompt, workflowTeachingPrompt, knowledgeTeachingPrompt, workflowPrompt, groupKnowledgePrompt, mergedTriggerPrompt, emotionPrompt, memoryPrompt, expressionPrompt, personaTonePrompt, narrativeWritingPrompt, solutionExplanationPrompt, cardBodyPrompt, personaFeedbackPrompt, globalStylePrompt, semanticStylePrompt, knowledgePrompt, memberLookupPrompt, personProfilePrompt].filter(Boolean).join('\n')
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

        const systemContent = `
【认知系统初始化】
${this.config.systemContent}

${buildPersonaStyleOverride(this.config.persona)}

【核心身份原则】

实时数据
${JSON.stringify(runtimeData, null, 2)}
2.【消息格式】
[YYYY-MM-DD HH:MM:SS] 昵称(qq号: xxx)[群身份: xxx]: 在群里说: {message}
引用消息时格式为: [回复 昵称的消息: "原文内容"] @被艾特的人 在群里说: {message}
3.【艾特、@格式】
@+qq号,例如@32174，@xxxxx

【可组合的群聊动作】
- 你可以把当前上下文中已明确的群成员昵称或 QQ 号写成 @昵称 / @QQ号；发送层会把能唯一匹配的写法转换为真实 QQ 艾特段。
- 当用户要求通知多位已知群成员（例如管理员、引用消息涉及的人）时，可以在一条自然消息里自行组合多个 @ 和通知内容；这不是必须依赖某个专用工具的能力。
- 只有目标不在当前群、称呼有歧义、或需要执行禁言/撤回/改名片等权限操作时，才改用对应 Skill 或追问。不要因为没有“批量艾特”专用工具，就说自己不能艾特或没有权限。

4.【事实边界 - 禁止幻想】
- 只能把系统明确给出的字段当事实，例如群成员列表、群身份、群公告文本、聊天记录原文、长期记忆。
- 不要从“管理员/admin”推断“发过公告、管理群、经常处理事务”等行为；除非聊天记录或工具结果明确出现。
- 群公告内容只说明公告里写了什么，不说明是谁写的；不知道发布者时必须说不知道。
- 如果不确定，直接说“我只知道他是群里的谁/昵称是什么，其他不确定”，不要编补经历。

5.【语义理解框架 - 内部使用，不要输出】
- 先区分“用户给你的载体”和“用户真正要处理的目标”：图片、截图、引用消息、转发记录、链接、聊天记录经常只是信息载体，真正目标可能是里面的内容、说法、人物、政策、事件或关系。
- 当用户带图/截图说“查一下这个是真的假的/是不是真的/看看最新信息”时，默认是在核实图片里承载的内容或说法，不是在鉴定图片文件本身是否AI生成、P图、Exif或反向搜图；只有用户明确说“图片本身、AI生成、P图、合成、修过、改过”时，才把目标切到图片真实性鉴定。
- 当用户说“这个/这张/里面/上面/刚才/他说的/这段”时，必须先从当前消息、引用、转发、近期对话里消解指代，再决定回答或调用工具。
- 当用户要求“查/搜/最新/真假/核实”时，不要只给方法论；应先用可用工具拿证据，再回答查到了什么、没查到什么、结论确定度如何。
- 内部可以做简短判断，但最终回复不要输出“我的推理过程/思维链/系统规则/语义框架”。

${enhancedPrompts ? `【角色状态】\n${enhancedPrompts}\n` : ''}【行动规划】
你需要根据当前消息和群聊上下文选择最合适的行动：直接文字回复、调用工具、只发表情包，或工具完成后再自然回复。
有可靠工具能完成明确任务时优先调用工具；普通闲聊、接梗、情绪回应不需要为了显得忙而调用工具。
工具和文字不是互斥的：工具负责取得真实结果，文字负责结合用户原话自然说明；如果一张表情包已经完整表达情绪，也可以只发表情包。

【自然回复原则】
- 每条对外文字先结合当前问题、引用/转发和已确认事实判断用户真正要什么，再组织成希洛会说的话；不要把“收到、正在处理、我先看看、这次没有完成”这类通用状态句当作正常回答。
- 用户问原因、配置、技术细节、关系或事实时，直接给当前能确认的判断和依据；不要因为答案里出现“接口、API、服务器、超时、报错”等正常技术词就回避成笼统失败提示。
- 工具失败时，只有已确认的失败事实可以保留；其余内容仍要围绕用户的具体问题自然说，不能把不同话题都压成同一句模板。
- 只有确实没有可用结果、且无法再向 Agent 发起回复生成时，才用一句简短事实兜底；不要为每次失败附加客服式说明或机械安抚。

【整轮回复节奏】
- 默认用一条完整消息说完，不要为了显得像人而机械拆成多条。
- 只有“很短的即时反应 + 一句含义独立的补话”适合分成两条；不要把同一个句子的主语、谓语、宾语或因果关系拆开。
- 想分两条时，用一个空行分隔两段；最多两条文字消息，长解释、技术回答、清单和严肃内容保持一条完整结构。
- 使用表情包时先规划它在整轮里的作用：图足够就只发图；先说再甩图用 leadText；甩图后补信息用 followUpText；两边都说只用于少量明显转折，避免三连刷屏。
- 文字和表情不要重复表达同一种“笑死/无语/震惊”，表情不能插在一个未说完的句子中间。

【工具调用优先级 - 最高原则】
当用户消息（或其引用的消息）含有"明确的任务请求"时，**必须优先调用对应工具拿到真实信息**，不允许用人设里的"懒/嘴硬/装看不见/敷衍/拒绝执行"等方式回避。
- 出现以下信号视为"明确请求"：看下/看看/帮我看/分析/解读/识别/评价/讲讲/总结/搜/查/找/翻译/解释/算一下/画一下/生成/试试... 等明确动词
- 引用消息含有图片/视频/语音/文件 + 用户在文字里要求处理 → 强制调对应工具
- 用户@bot 并发出问题/请求 → 不能用"我不想看""我缺这点流量吗""自己来"等方式回避真实任务
- 闲聊/水群/玩梗/情绪共鸣场景 → 此时才允许人设里的"懒/嘴硬/装看不见"
判断原则：先看"用户是不是要我做事"——是 → 调工具；不是（纯水群/闲聊）→ 看人设决定要不要回。

${mcpPrompts}
【工具使用隐藏规则】
1⃣ 严禁在回复中显示工具调用代码或函数名称
2⃣ 工具执行后，以自然对话方式呈现结果，如同人类完成了该任务
绝对禁止在任何回复中显示工具调用代码、函数名称或任何内部执行细节。这包括但不限于：
* \`print(...)\`、\`tool_name(...)\` 等类似编程语言的语法。
* \`[tool_code]\`、\` <tool_code> \` 等任何形式的工具代码块标记。
3⃣ 示例转换:
✅ 正确: "八重神子的全身像已经画好啦，按照你要求的侧面视角做的，感觉还挺好看的~"
❌ 错误示例 (绝对不允许):**
* \`[tool_code]\`
* \`print(pokeTool(user_qq_number=1390963734))\`
* \`print(pokeTool(user_qq_number=1390963734))\`
* "我正在运行 \`pokeTool\` 函数..."

【回复格式规则 - 极其重要】
你的回复必须是纯文本内容，绝对禁止模仿消息记录的格式！
❌ 错误: "[2025-12-24 12:42:25] 哈基米(qq号: 3012184357)[群身份: admin]: 在群里说: 想听啥？"
❌ 错误: "[时间] 昵称(qq号: xxx)[群身份: xxx]: 内容"
✅ 正确: "想听啥？"
✅ 正确: "中午好呀~"
消息记录格式仅用于你理解上下文，回复时只输出纯内容！

【群聊消息记录】
`
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
                text: [args, msg].filter(Boolean).join("\n"),
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

        const understandingPrompt = this.buildUnderstandingContextPrompt({
          e,
          args,
          msg,
          userContent,
          images,
          videos,
          currentIntentText: [args, msg].filter(Boolean).join("\n"),
          groupUserMessages
        })

        groupUserMessages = groupUserMessages.filter(m => m.role !== "system")
        groupUserMessages.unshift({ role: "system", content: systemContent })
        if (understandingPrompt) {
          groupUserMessages.splice(1, 0, { role: "system", content: understandingPrompt })
        }
        groupUserMessages.push({ role: "user", content: userContent })
        session.userContent = userContent
        groupUserMessages = this.trimMessageHistory(groupUserMessages)
        groupUserMessages = this.filterChatByQQ(groupUserMessages, e.user_id)
        session.groupUserMessages = this.formatMessages(groupUserMessages, e, userContent)

        let toolChoice = "auto"
        let forcedToolCall = null
        let toolScopeLocked = false
        const currentIntentText = [args, msg].filter(Boolean).join("\n")
        const singularOwnerMention = resolveSingularOwnerMention(currentIntentText, memberMap)
        if (toolChoice === "auto" && singularOwnerMention) {
          session.tools = this.getToolsByName(["mentionMembersTool"])
          if (session.tools?.length) {
            toolChoice = { type: "function", function: { name: "mentionMembersTool" } }
            forcedToolCall = this.buildForcedToolCall("mentionMembersTool", {
              targets: [singularOwnerMention.targetUserId],
              message: singularOwnerMention.message
            })
            toolScopeLocked = true
            logger.info(`[工具快路] group=${groupId} 单数群主请求精确艾特 owner=${singularOwnerMention.targetUserId}`)
          }
        }
        const forcedReactionEmoji = resolveForcedReactionEmoji(currentIntentText)
        if (!toolScopeLocked && toolChoice === "auto" && forcedReactionEmoji) {
          session.tools = this.getToolsByName(["sendLocalEmojiTool"])
          if (session.tools?.length) {
            toolChoice = { type: "function", function: { name: "sendLocalEmojiTool" } }
            forcedToolCall = this.buildForcedToolCall("sendLocalEmojiTool", forcedReactionEmoji)
            toolScopeLocked = true
            logger.info(`[表情包快路] group=${groupId} 强制发送反应表情 tags=${forcedReactionEmoji.tags.join(",")}`)
          }
        }
        const hasExcelContext = hasExcelWorkbookContext({
          text: userContent,
          media: groupContextAssets?.media
        })
        const excelToolIntent = shouldUseExcelWorkbookTool(currentIntentText, { hasExcelContext })
        const excelToolParams = buildExcelToolParams(currentIntentText, { hasExcelContext })
        if (toolChoice === "auto" && excelToolIntent) {
          session.tools = this.getToolsByName(["excelWorkbookTool"])
          if (session.tools?.length) {
            toolScopeLocked = true
            if (excelToolParams) {
              toolChoice = { type: "function", function: { name: "excelWorkbookTool" } }
              forcedToolCall = this.buildForcedToolCall("excelWorkbookTool", excelToolParams)
              logger.info(`[工具快路] group=${groupId} 直接执行 excelWorkbookTool params=${JSON.stringify(excelToolParams)}`)
            } else {
              logger.info(`[工具选择] group=${groupId} Excel 开放式任务仅开放 excelWorkbookTool 并保持 tool_choice=auto`)
            }
          }
        }

        if (!toolScopeLocked && toolChoice === "auto" && videos?.length >= 1) {
          session.tools = this.getToolsByName(["videoAnalysisTool"])
          if (session.tools?.length) toolChoice = { type: "function", function: { name: "videoAnalysisTool" } }
        }

        if (!toolScopeLocked && this.config.forcedAvatarMode && msg?.includes("头像编辑")) {
          session.tools = this.getToolsByName(["googleImageEditTool"])
          if (session.tools?.length) toolChoice = { type: "function", function: { name: "googleImageEditTool" } }
          session.groupUserMessages.at(-1).content += `[用户头像链接: (https://q1.qlogo.cn/g?b=qq&nk=${e.user_id}&s=640)]`
        }

        if (!toolScopeLocked && toolChoice === "auto" && session.avatarEditBase?.images?.length) {
          session.tools = this.getToolsByName(["googleImageEditTool"])
          if (session.tools?.length) {
            toolChoice = { type: "function", function: { name: "googleImageEditTool" } }
            forcedToolCall = this.buildForcedToolCall("googleImageEditTool", {
              images,
              prompt: [
                this.buildImageEditPrompt({ e, args, msg, currentIntentText, userContent, groupUserMessages: session.groupUserMessages }),
                session.avatarEditBase.promptHint
              ].filter(Boolean).join("\n")
            })
            logger.info(`[工具选择] group=${groupId} 强制使用 googleImageEditTool 处理群友头像编辑请求`)
          }
        }

        if (!toolScopeLocked && toolChoice === "auto" && session.avatarInspection?.images?.length) {
          session.tools = this.getToolsByName(["googleImageAnalysisTool"])
          if (session.tools?.length) {
            toolChoice = { type: "function", function: { name: "googleImageAnalysisTool" } }
            forcedToolCall = this.buildForcedToolCall("googleImageAnalysisTool", {
              images: session.avatarInspection.images,
              prompt: session.avatarInspection.prompt
            })
            logger.info(`[工具选择] group=${groupId} 强制使用 googleImageAnalysisTool 处理头像识别请求`)
          }
        }

        if (!toolScopeLocked && (msg?.includes("导图") || msg?.includes("思维导图"))) {
          session.tools = this.getToolsByName(["aiMindMapTool"])
          if (session.tools?.length) toolChoice = { type: "function", function: { name: "aiMindMapTool" } }
        }

        if (!toolScopeLocked && toolChoice === "auto" && images?.length && isImageAnalysisRequest(currentIntentText)) {
          const imageAnalysisToolNames = getImageAnalysisToolNames(currentIntentText)
          session.tools = this.getToolsByName(imageAnalysisToolNames)
          session.imageVerificationNeedsSearch = imageAnalysisToolNames.includes("searchInformationTool")
          session.imageVerificationMode = getImageVerificationMode(currentIntentText)
          if (session.tools?.length) {
            toolChoice = { type: "function", function: { name: "googleImageAnalysisTool" } }
            forcedToolCall = this.buildForcedToolCall("googleImageAnalysisTool", {
              images,
              prompt: currentIntentText || args || msg || "请识别这张图片里有什么内容，并用中文简洁描述。"
            })
            logger.info(`[工具选择] group=${groupId} 强制使用 googleImageAnalysisTool 处理识图请求`)
          }
        }

        if (!toolScopeLocked && toolChoice === "auto" && session.recentImageContinuation?.image) {
          session.tools = this.getToolsByName(["googleImageEditTool"])
          if (session.tools?.length) {
            toolChoice = { type: "function", function: { name: "googleImageEditTool" } }
            forcedToolCall = this.buildForcedToolCall("googleImageEditTool", {
              images,
              prompt: this.buildImageEditPrompt({
                e,
                args,
                msg,
                currentIntentText,
                userContent,
                groupUserMessages: session.groupUserMessages
              })
            })
            logger.info(`[工具选择] group=${groupId} 最近成图续改强制使用 googleImageEditTool`)
          }
        }

        const imageGenerationReferenceImages = this.getImageGenerationReferenceImages(images, session)
        const preferImageGeneration = shouldPreferImageGeneration(currentIntentText, {
          hasImages: imageGenerationReferenceImages.length > 0,
          hasRecentBotImage: Boolean(session.recentImageContinuation)
        })
        const contextualDrawCall = !toolScopeLocked && toolChoice === "auto"
          ? this.resolveContextualDrawGeneration({
              e,
              args,
              msg,
              images: imageGenerationReferenceImages,
              currentIntentText,
              userContent,
              groupUserMessages: session.groupUserMessages,
              avatarDrawReference: session.avatarDrawReference
            })
          : null
        if (contextualDrawCall) {
          session.tools = this.getToolsByName(["bananaTool"])
          if (session.tools?.length) {
            toolChoice = { type: "function", function: { name: "bananaTool" } }
            forcedToolCall = this.buildForcedToolCall("bananaTool", {
              prompt: contextualDrawCall.prompt,
              images: imageGenerationReferenceImages
            })
            logger.info(`[工具选择] group=${groupId} 上下文衔接使用 bananaTool reason=${contextualDrawCall.reason}`)
          }
        }

        if (!toolScopeLocked && toolChoice === "auto" && preferImageGeneration) {
          session.tools = this.getToolsByName(["bananaTool"])
          if (session.tools?.length) {
            toolChoice = { type: "function", function: { name: "bananaTool" } }
            forcedToolCall = this.buildForcedToolCall("bananaTool", {
              prompt: this.buildImageGenerationPrompt({ e, args, msg, currentIntentText, userContent, images: imageGenerationReferenceImages, avatarDrawReference: session.avatarDrawReference }),
              images: imageGenerationReferenceImages
            })
            logger.info(`[工具选择] group=${groupId} 显式生图请求直接使用 bananaTool，跳过语义规划`)
          } else {
            logger.warn(`[工具选择] group=${groupId} 显式生图请求没有可用 bananaTool，拒绝降级为闲聊`)
            await this.sendSegmentedMessage(e, buildImageFailureReply("图片生成失败: 当前没有可用的图片生成渠道"), 0)
            this.clearSession(sessionId)
            return true
          }
        }

        // Let the semantic planner choose generation versus editing for prose prompts.
        // With no supplied image, image-edit/analysis tools are not valid choices.
        const semanticSessionTools = images?.length
          ? session.tools
          : (session.tools || []).filter(tool => !["googleImageEditTool", "googleImageAnalysisTool"].includes(tool?.function?.name))
        const semanticDecision = !toolScopeLocked && toolChoice === "auto"
          ? await this.classifySemanticToolIntent({
              e,
              args,
              msg,
              images,
              videos,
              currentIntentText,
              userContent,
              groupUserMessages: session.groupUserMessages,
              avatarDrawReference: session.avatarDrawReference,
              groupWorkflowPrompt: workflowPrompt,
              sessionTools: semanticSessionTools
            })
          : null
        const semanticToolCall = semanticDecision?.toolName
          ? this.buildToolCallFromDecision(semanticDecision, { e, images: imageGenerationReferenceImages, args, msg, currentIntentText, userContent, groupUserMessages: session.groupUserMessages, avatarDrawReference: session.avatarDrawReference })
          : null
        if (!toolScopeLocked && toolChoice === "auto" && semanticToolCall) {
          session.tools = semanticToolCall.tools
          toolChoice = { type: "function", function: { name: semanticToolCall.toolName } }
          forcedToolCall = semanticToolCall.toolCall
          logger.info(`[工具选择] group=${groupId} 语义分类强制使用 ${semanticToolCall.toolName} intent=${semanticToolCall.intent}`)
        }

        // Let the Agent choose a registered Skill first. Keep deterministic
        // parsing only as a fallback when the planner cannot decide.
        if (!toolScopeLocked && toolChoice === "auto") {
          const deterministicDecision = resolveDeterministicToolIntent(
            currentIntentText,
            (session.tools || []).map(tool => tool?.function?.name).filter(Boolean),
            { hasExcelContext }
          )
          const deterministicToolCall = deterministicDecision
            ? this.buildToolCallFromDecision(deterministicDecision, { e, args, msg, currentIntentText, userContent })
            : null
          if (deterministicToolCall) {
            session.tools = deterministicToolCall.tools
            toolChoice = { type: "function", function: { name: deterministicToolCall.toolName } }
            forcedToolCall = deterministicToolCall.toolCall
            toolScopeLocked = true
            logger.info(`[工具兜底] group=${groupId} 使用确定性参数解析 ${deterministicToolCall.toolName} params=${JSON.stringify(deterministicDecision.params)}`)
          }
        }

        const naturalDeltaForceCall = !toolScopeLocked && toolChoice === "auto"
          ? resolveNaturalDeltaForceToolCall(currentIntentText)
          : null
        if (naturalDeltaForceCall) {
          session.tools = this.getToolsByName(["deltaForceTool"])
          if (session.tools?.length) {
            toolChoice = { type: "function", function: { name: "deltaForceTool" } }
            forcedToolCall = this.buildForcedToolCall("deltaForceTool", naturalDeltaForceCall.params)
            logger.info(`[工具选择] group=${groupId} 规则兜底使用 deltaForceTool 处理三角洲自然语言请求 params=${JSON.stringify(naturalDeltaForceCall.params)}`)
          }
        }

        if (!toolScopeLocked && toolChoice === "auto" && images?.length && isImageCompositionEditRequest(currentIntentText)) {
          session.tools = this.getToolsByName(["googleImageEditTool"])
          if (session.tools?.length) {
            toolChoice = { type: "function", function: { name: "googleImageEditTool" } }
            forcedToolCall = this.buildForcedToolCall("googleImageEditTool", {
              images,
              prompt: [
                this.buildImageEditPrompt({ e, args, msg, currentIntentText, userContent, groupUserMessages: session.groupUserMessages }),
                session.editAssets?.promptHint
              ].filter(Boolean).join("\n")
            })
            logger.info(`[工具选择] group=${groupId} 强制使用 googleImageEditTool 处理图片编辑请求`)
          }
        }

        if (!toolScopeLocked && toolChoice === "auto" && images?.length && isImageAnalysisRequest(currentIntentText)) {
          const imageAnalysisToolNames = getImageAnalysisToolNames(currentIntentText)
          session.tools = this.getToolsByName(imageAnalysisToolNames)
          session.imageVerificationNeedsSearch = imageAnalysisToolNames.includes("searchInformationTool")
          session.imageVerificationMode = getImageVerificationMode(currentIntentText)
          if (session.tools?.length) {
            toolChoice = { type: "function", function: { name: "googleImageAnalysisTool" } }
            forcedToolCall = this.buildForcedToolCall("googleImageAnalysisTool", {
              images,
              prompt: currentIntentText || args || msg || "请识别这张图片里有什么内容，并用中文简洁描述。"
            })
            logger.info(`[工具选择] group=${groupId} 强制使用 googleImageAnalysisTool 处理识图请求`)
          }
        }

        // 强制抢红包模式
        if (e.forceGrabRedBag) {
          session.tools = this.getToolsByName(["grabRedBagTool"])
          if (session.tools?.length) toolChoice = { type: "function", function: { name: "grabRedBagTool" } }
        }

        if (!toolScopeLocked && toolChoice === "auto") {
          const beforeToolCount = session.tools?.length || 0
          session.tools = filterToolsForMessageIntent(session.tools, e, args)
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
        const turnPlanRequest = deriveTurnPlanRequest(turnPlan)
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
          await this.sendSegmentedMessage(e, acknowledgement, 0)
          session.cardAcknowledged = true
          logger.info(`[卡面呈现] 已发送即时确认 kind=${session.cardPresentation}`)
        }

	        const requestData = this.buildRequestData(session.groupUserMessages, session.tools, toolChoice)
            const initialModelStartedAt = Date.now()
	        let response = await this.retryRequest(requestData, session.toolContent, 1, undefined, turnPlanRequest.requestOptions)
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

        if (message.tool_calls?.length) {
          await this.processToolCalls(message, e, session, session.groupUserMessages, atQq, senderRole)
        } else if (message.content) {
          const missingToolCall = this.buildMissingToolCommitmentCall(message.content, {
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
            await this.handleTextResponse(message.content, e, session, session.groupUserMessages)
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
	        await this.finishConversationTask(taskContext, session)
	        const totalElapsed = Date.now() - handleToolStartAt
	        logger.info(`[对话耗时] group=${e?.group_id || ""} user=${e?.user_id || ""} ${formatTurnPlanLog(session.turnPlan)} total=${totalElapsed}ms merged=${e?._mergedMessageCount || 0}`)
	        if (e.group_id && !e._longRunningToolTask) this.recordReplyLatency(e.group_id, totalElapsed)
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
  formatToolResult(content, toolName) {
    if (!content) return "执行完成"
    let result = typeof content === "string" ? content : JSON.stringify(content)
    const maxLength = {
      searchInformationTool: 500,
      webParserTool: 500,
      chatHistoryTool: 800,
      default: 300
    }

    const limit = maxLength[toolName] || maxLength.default

    if (result.length > limit) {
      result = safeTruncateUnicode(result, limit, "...(内容已截断)")
    }

    if (result.includes("成功")) {
      return "✓ " + result
    } else if (result.includes("失败") || result.includes("错误")) {
      return "✗ " + result
    }

    return result
  }

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
        this.buildRequestData([
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

  async handleToolFailureResponse(toolName = "", context = {}) {
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

  getQuotedPromptContextText(e = {}, userContent = "") {
    const context = e?._quotedPromptContext
    const lines = []
    if (context?.text) {
      if (context.senderName) lines.push(`引用自 ${context.senderName}:`)
      lines.push(context.text)
    }
    if (context?.mediaSummary) lines.push(`引用消息还包含：${context.mediaSummary}`)
    if (lines.length) return compactDrawPromptText(lines.join("\n"), 2800)

    const content = String(userContent || "")
    const match = content.match(/\[回复\s+(.{1,80}?)的消息[:：]\s*([\s\S]*?)\]\s*(?:@|在群里说[:：]|$)/)
    if (!match) return ""
    return compactDrawPromptText(`引用自 ${match[1]}:\n${match[2]}`, 2800)
  }

  getRecentPromptContextText(messages = [], currentUserContent = "", maxLength = 1200) {
    if (!Array.isArray(messages) || !messages.length) return ""

    const current = normalizeForContainment(currentUserContent)
    const lines = []
    for (const message of messages) {
      if (!message || message.role === "system") continue
      const content = String(message.content || "")
      if (!content || content.startsWith("【系统提示】")) continue

      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine
          .replace(/\[CQ:[^\]]+\]/g, " ")
          .replace(/https?:\/\/\S+/g, "[图片/链接]")
          .replace(/\s+/g, " ")
          .trim()
        if (!line) continue
        if (/此处为调用工具的结果|调用工具|当前QQ群.*群聊历史记录|系统提示/.test(line)) continue
        if (/^\[图片\/链接\]$/.test(line)) continue
        if (current && normalizeForContainment(line).includes(current.slice(0, 32))) continue
        lines.push(safeTruncateUnicode(line, 180))
      }
    }

    const recent = lines.slice(-8)
    return recent.length ? compactDrawPromptText(recent.join("\n"), maxLength) : ""
  }

  getRecentDrawContextText(messages = [], currentUserContent = "", maxLength = 1200) {
    if (!Array.isArray(messages) || !messages.length) return ""

    const current = normalizeForContainment(currentUserContent)
    const lines = []
    for (const message of messages) {
      if (!message || message.role === "system") continue
      const content = String(message.content || "")
      if (!content || content.startsWith("【系统提示】")) continue

      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine
          .replace(/\[CQ:[^\]]+\]/g, " ")
          .replace(/https?:\/\/\S+/g, "[图片/链接]")
          .replace(/\s+/g, " ")
          .trim()
        if (!line) continue
        if (/此处为调用工具的结果|调用工具|当前QQ群.*群聊历史记录|系统提示/.test(line)) continue
        if (/^\[历史处理标记/.test(line)) continue
        if (current && normalizeForContainment(line).includes(current.slice(0, 32))) continue

        const normalized = normalizeIntentText(line)
        const isDrawRequest = isImageGenerationRequest(normalized) ||
          /(?:画|绘制|生成|出图|做图|捏).{0,80}(?:图|图片|照片|照|插画|角色|人物|场景|完整|出来)/i.test(normalized)
        const isDrawCommitment = hasToolCommitmentText(normalized) && /(?:画|生成|出图|做图|捏)/i.test(normalized)
        if (isDrawRequest || isDrawCommitment) {
          lines.push({
            text: safeTruncateUnicode(line, 220),
            isDrawRequest
          })
        }
      }
    }

    const recent = selectLatestDrawContextLines(lines, 3)
    return recent.length
      ? compactDrawPromptText(recent.join("\n"), maxLength)
      : ""
  }

  resolveContextualDrawGeneration(context = {}) {
    const currentIntentText = String(context.currentIntentText || context.args || context.msg || "").trim()
    const normalized = normalizeIntentText(currentIntentText)
    if (!normalized) return null
    if (isImageGenerationRequest(normalized) || isImageEditRequest(normalized)) return null

    const isStatusInquiry = isDrawTaskStatusInquiry(normalized)
    const quotedContext = this.getQuotedPromptContextText(context.e, context.userContent)
    const isQuotedDrawExecution = /(?:执行|照着|按).{0,12}(?:上面|引用|这条|刚才|前面)/.test(normalized) &&
      isImageGenerationRequest(normalizeIntentText(quotedContext))
    const isContinuation = isDrawContextContinuationRequest(normalized) || isQuotedDrawExecution
    if (!isStatusInquiry && !isContinuation && !context.modelCommittedToDraw) return null

    const recentContext = this.getRecentDrawContextText(
      context.groupUserMessages || context.messages || [],
      context.userContent || currentIntentText,
      1200
    )
    if (isStatusInquiry && !quotedContext && !/(?:我|希洛|好嘞|马上|开始|这就|帮你|给你|那就).{0,40}(?:画|生成|出图|做图|捏)/i.test(recentContext)) {
      return null
    }
    const drawContext = [quotedContext, recentContext].filter(Boolean).join("\n")
    if (!drawContext) return null

    const headline = isStatusInquiry
      ? "用户在追问刚才承诺的画图任务，请不要把追问本身画进画面，而是继续完成上下文里的真实画图目标。"
      : "用户在延续上一轮画图需求，请把本轮补充和上下文合并成新的画面需求。"
    const supplement = isStatusInquiry ? "" : `用户本轮补充：${currentIntentText}`
    const rawPrompt = compactDrawPromptText([
      headline,
      supplement,
      "可继承的画图上下文：",
      drawContext
    ].filter(Boolean).join("\n"), 2600)

    return {
      prompt: this.buildImageGenerationPrompt({
        ...context,
        prompt: rawPrompt,
        currentIntentText,
        userContent: context.userContent,
        groupUserMessages: context.groupUserMessages
      }),
      rawPrompt,
      reason: isStatusInquiry ? "draw_status_context_recovery" : "draw_context_continuation"
    }
  }

  getUnderstandingEnhancementConfig() {
    const cfg = this.config.understandingEnhancement || {}
    return {
      enabled: cfg.enabled !== false,
      maxChars: Math.max(600, Math.min(3000, Number(cfg.maxChars) || 1400)),
      includeRecentContext: cfg.includeRecentContext !== false
    }
  }

  shouldInjectUnderstandingContext({ e = {}, userContent = "", images = [], videos = [], currentIntentText = "" } = {}) {
    const cfg = this.getUnderstandingEnhancementConfig()
    if (!cfg.enabled) return false

    const content = `${currentIntentText || ""}\n${userContent || ""}`
    if (content.length > 260) return true
    if (e?._directTriggerMerged || e?._mergedMessageCount) return true
    if (Array.isArray(images) && images.length) return true
    if (Array.isArray(videos) && videos.length) return true
    if (/\[回复\s+.+?的消息[:：]|转发了合并聊天记录|转发记录内容|嵌套转发记录/.test(content)) return true
    if (/(这个|这个人|那个人|上面|里面|前面|刚才|刚刚|上一条|他说|她说|它|这张|这段|这句|哪句|哪个).{0,18}(什么意思|是谁|是啥|咋回事|怎么回事|为什么|总结|分析|讲讲|看看|解释)/.test(normalizeIntentText(content))) return true
    return false
  }

  extractForwardContextFromUserContent(userContent = "", maxLength = 900) {
    const content = String(userContent || "")
    const blocks = []
    for (const marker of ["转发了合并聊天记录:", "转发记录内容:"]) {
      const index = content.indexOf(marker)
      if (index >= 0) {
        blocks.push(content.slice(index + marker.length).trim())
      }
    }
    if (!blocks.length) return ""
    return compactDrawPromptText(blocks.join("\n"), maxLength)
  }

  buildUnderstandingContextPrompt(context = {}) {
    const {
      e = {},
      args = "",
      msg = "",
      userContent = "",
      images = [],
      videos = [],
      groupUserMessages = [],
      currentIntentText = ""
    } = context
    if (!this.shouldInjectUnderstandingContext({ e, userContent, images, videos, currentIntentText })) return ""

    const cfg = this.getUnderstandingEnhancementConfig()
    const intentText = compactDrawPromptText(currentIntentText || args || msg || "", 360)
    const quotedContext = this.getQuotedPromptContextText(e, userContent)
    const forwardContext = this.extractForwardContextFromUserContent(userContent)
    const recentContext = cfg.includeRecentContext
      ? this.getRecentPromptContextText(groupUserMessages, userContent || currentIntentText, 650)
      : ""

    const signals = []
    if (e?._mergedMessageCount) signals.push(`同一用户连续触发 ${e._mergedMessageCount} 条，已合并成一轮`)
    if (quotedContext) signals.push("当前消息引用了其他消息")
    if (forwardContext || /转发了合并聊天记录|转发记录内容|嵌套转发记录/.test(userContent)) signals.push("当前上下文包含合并转发/嵌套转发记录")
    if (images?.length) signals.push(`当前可见图片 ${images.length} 张`)
    if (videos?.length) signals.push(`当前引用/消息含视频 ${videos.length} 条`)
    if (/(这个|这个人|那个人|上面|里面|前面|刚才|刚刚|上一条|他说|她说|它|这张|这段|这句|哪句|哪个)/.test(normalizeIntentText(currentIntentText || msg))) signals.push("用户用了指代词，需要结合引用、转发和近期对话消解")

    const lines = [
      "【理解增强卡片】",
      "这张卡片只用于你理解上下文，最终回复不要提到“卡片”“系统”“提示词”“分析过程”。",
      intentText ? `用户当前原话/意图：${intentText}` : "",
      signals.length ? `上下文信号：${signals.join("；")}` : "",
      quotedContext ? `引用内容摘录：\n${compactDrawPromptText(quotedContext, 650)}` : "",
      forwardContext ? `合并转发/嵌套转发摘录：\n${forwardContext}` : "",
      recentContext ? `近期可参考上下文：\n${recentContext}` : "",
      "理解规则：先判断用户真正要你回答什么；如果用户问“这个/里面/刚才/他说的”，优先从引用、转发记录和最近对话里找指代。",
      "理解规则：先区分信息载体和真实目标；图片/截图/引用/转发本身不一定是用户要问的对象，很多时候用户问的是里面那段文字、说法、事件、政策或人物关系。",
      "理解规则：带图问“这个是真的假的/是不是真的/看看最新信息”时，默认核实图片里的内容或说法；只有明确提到AI生成、P图、合成、修过、图片本身时，才转为图片本身鉴定。",
      "理解规则：用户要你查证时，不要只给通用方法；先用可用工具拿证据，再说明查到了什么、没查到什么、结论有多确定。",
      "如果用户让你总结、分析或解释合并转发，要覆盖已展开的全部内容，不要只看第一层或第一条。",
      "如果上下文仍不足，别硬编，像熟人一样自然追问一句。"
    ].filter(Boolean)

    return compactDrawPromptText(lines.join("\n"), cfg.maxChars)
  }

  buildImageGenerationPrompt(context = {}) {
    const mergedPrompt = Array.isArray(context.e?._mergedOriginalTexts) && context.e._mergedOriginalTexts.length
      ? selectMergedImagePromptTexts(context.e._mergedOriginalTexts).join("\n")
      : ""
    const basePrompt = compactDrawPromptText(
      mergedPrompt || context.args || context.msg || context.currentIntentText || context.prompt || "",
      2400
    )
    const avatarReferencePrompt = formatAvatarDrawReferencePrompt(context.avatarDrawReference)
    const quotedContext = this.getQuotedPromptContextText(context.e, context.userContent)
    const contextMode = resolveImageContextMode(basePrompt, quotedContext)
    const recentContext = contextMode === "source"
      ? this.getRecentPromptContextText(
          context.groupUserMessages || context.messages || [],
          context.userContent || context.currentIntentText || basePrompt,
          900
        )
      : contextMode === "draw"
        ? this.getRecentDrawContextText(
            context.groupUserMessages || context.messages || [],
            context.userContent || context.currentIntentText || basePrompt,
            900
          )
        : ""
    const referenceText = [basePrompt, quotedContext].filter(Boolean).join("\n")

    const compiled = compileImagePrompt({
      task: "image_generation",
      userPrompt: [basePrompt, avatarReferencePrompt].filter(Boolean).join("\n"),
      quotedContext,
      recentContext,
      hasReferenceImages: Array.isArray(context.images) && context.images.length > 0,
      hasContextualReference: contextMode !== "none",
      isComic: COMIC_DRAW_PATTERN.test(referenceText)
    })
    return [compiled, context.groupContextImagePrompt || context.e?._groupContextImagePrompt]
      .filter(Boolean)
      .join("\n")
  }

  getImageGenerationReferenceImages(images = [], session = {}) {
    if (Array.isArray(images) && images.length) return images
    if (Array.isArray(session.avatarDrawReference?.images) && session.avatarDrawReference.images.length) {
      return session.avatarDrawReference.images
    }
    return []
  }

  buildImageEditPrompt(context = {}) {
    const basePrompt = compactDrawPromptText(
      context.args || context.msg || context.currentIntentText || context.prompt || "请按用户要求编辑这张图片。",
      2400
    )
    const quotedContext = this.getQuotedPromptContextText(context.e, context.userContent)
    const contextMode = resolveImageContextMode(basePrompt, quotedContext)
    const recentContext = contextMode === "source"
      ? this.getRecentPromptContextText(
          context.groupUserMessages || context.messages || [],
          context.userContent || context.currentIntentText || basePrompt,
          1200
        )
      : contextMode === "draw"
        ? this.getRecentDrawContextText(
            context.groupUserMessages || context.messages || [],
            context.userContent || context.currentIntentText || basePrompt,
            1200
          )
        : ""

    const compiled = compileImagePrompt({
      task: "image_edit",
      userPrompt: basePrompt,
      quotedContext,
      recentContext,
      hasReferenceImages: true,
      hasContextualReference: contextMode !== "none"
    })
    return [compiled, context.groupContextImagePrompt || context.e?._groupContextImagePrompt]
      .filter(Boolean)
      .join("\n")
  }

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

  shouldUseSemanticToolIntent(e = {}, text = "", images = [], videos = [], options = {}) {
    const content = normalizeIntentText(text || e?.msg || "")
    return shouldRunSemanticToolPlanner({
      hasMedia: images.length > 0 || videos.length > 0,
      hasKnownToolCandidate: Array.isArray(options.knownToolCandidates) && options.knownToolCandidates.length > 0,
      hasExplicitToolIntent: isExplicitToolIntent(content),
      hasRealtimeRequest: isRealtimeInfoRequest(content),
      hasExplicitSearchRequest: isExplicitSearchRequest(content)
    })
  }

  normalizeToolDecision(decision = {}, context = {}) {
    const intent = String(decision.intent || "chat").trim()
    const confidence = Number(decision.confidence)
    if (!Number.isFinite(confidence) || confidence < SEMANTIC_TOOL_INTENT_MIN_CONFIDENCE) return null

    const requestedToolName = String(decision.toolName || decision.tool_name || "").trim()
    const availableToolNames = new Set(Array.isArray(context.availableToolNames) ? context.availableToolNames : [])
    if (requestedToolName === "mentionAdminsTool" && !isExplicitAdminCollectionMentionRequest(context.currentIntentText || context.args || context.msg || "")) {
      logger.warn("[语义工具分类] 拒绝非集合措辞的 mentionAdminsTool 请求")
      return null
    }
    if (requestedToolName && availableToolNames.has(requestedToolName)) {
      const params = decision.params && typeof decision.params === "object"
        ? decision.params
        : (decision.arguments && typeof decision.arguments === "object" ? decision.arguments : {})
      const tool = this.toolInstances?.[requestedToolName]
      let normalizedParams
      try {
        normalizedParams = normalizeToolSkillParams(tool, params, {
          userText: context.currentIntentText || context.args || context.msg || "",
          currentIntentText: context.currentIntentText || "",
          decision
        })
      } catch (error) {
        logger.warn(`[ToolSkill] 参数规范化失败 tool=${requestedToolName}: ${error.message}`)
        return null
      }
      return {
        intent: "tool",
        toolName: requestedToolName,
        params: normalizedParams
      }
    }

    if (!SEMANTIC_TOOL_INTENTS.has(intent)) return null

    const images = Array.isArray(context.images) ? context.images : []
    if (intent === "image_edit" && !images.length) return null
    if (intent === "image_analysis" && !images.length) return null

    const rawUserPrompt = String(context.args || context.msg || context.currentIntentText || "").trim()
    const prompt = String(rawUserPrompt || decision.prompt || "").trim()
    const query = String(decision.query || decision.prompt || context.args || context.msg || context.currentIntentText || "").trim()

    if (intent === "image_generate") {
      return {
        intent,
        toolName: "bananaTool",
        params: {
          prompt: this.buildImageGenerationPrompt({ ...context, prompt }),
          images
        }
      }
    }
    if (intent === "image_edit") {
      return {
        intent,
        toolName: "googleImageEditTool",
        params: {
          images,
          prompt: this.buildImageEditPrompt({ ...context, prompt })
        }
      }
    }
    if (intent === "image_analysis") {
      return { intent, toolName: "googleImageAnalysisTool", params: { images, prompt: prompt || "请识别这张图片里有什么内容，并用中文简洁描述。" } }
    }
    if (intent === "search") {
      if (!query) return null
      return { intent, toolName: "searchInformationTool", params: { query } }
    }
    return { intent: "chat" }
  }

  resolveChatCompletionUrl(apiUrl = "") {
    return normalizeChatCompletionUrl(apiUrl)
  }

  extractJsonObject(text = "") {
    const content = String(text || "").trim()
    if (!content) return null
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
    const raw = fenced ? fenced[1].trim() : content
    try {
      return JSON.parse(raw)
    } catch {}
    const start = raw.indexOf("{")
    const end = raw.lastIndexOf("}")
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(raw.slice(start, end + 1))
      } catch {}
    }
    return null
  }

  async fetchWithTimeout(url, options = {}, timeoutMs = SEMANTIC_TOOL_INTENT_TIMEOUT_MS) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await fetch(url, { ...options, signal: controller.signal })
    } catch (error) {
      if (error?.name === "AbortError") {
        throw new Error(`请求超过 ${Math.round(timeoutMs / 1000)} 秒没有返回`)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  async classifySemanticToolIntent(context = {}) {
    const cfg = this.config.toolsAiConfig || {}
    const apiUrl = cfg.toolsAiUrl
    const apiKey = cfg.toolsAiApikey
    const model = cfg.toolsAiModel
    if (!apiUrl || !apiKey || !model || String(apiKey).includes("sk-xxx")) return null

    const url = this.resolveChatCompletionUrl(apiUrl)
    const userText = safeTruncateUnicode(context.currentIntentText || "", 1200)
    const hasImages = Array.isArray(context.images) && context.images.length > 0
    const hasVideos = Array.isArray(context.videos) && context.videos.length > 0
    const quoted = safeTruncateUnicode(context.userContent || "", 1600)
    const availableTools = (context.sessionTools || context.tools || [])
      .map(tool => tool?.function)
      .filter(tool => tool?.name)
    const availableToolNames = availableTools.map(tool => tool.name)
    const knownToolCandidates = selectToolIntentCandidates(context.currentIntentText || "", availableToolNames)
    if (!this.shouldUseSemanticToolIntent(context.e, context.currentIntentText, context.images, context.videos, {
      knownToolCandidates: hasSemanticPlannerCandidate(knownToolCandidates) ? knownToolCandidates : []
    })) return null
    const toolCatalog = buildToolSkillCatalog(this.toolInstances, availableToolNames)

    const classifyStartedAt = Date.now()
    try {
      const response = await this.fetchWithTimeout(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          stream: false,
          temperature: 0,
          messages: [
            {
              role: "system",
              content: [
                "你是QQ群机器人前置工具意图分类器，只输出严格 JSON。",
                "可选 intent: chat, image_generate, image_edit, image_analysis, search。",
                "image_generate: 用户要从文字生成新图片、画图、出图、做图。",
                "image_edit: 用户给了图片并要求修改、去水印、加东西、换背景、美化、图生图。",
                "image_analysis: 用户给了图片并要求看图、识别、分析、说明图片内容。",
                "search: 用户询问实时信息或明确要搜索/查询/最新信息。",
                "chat: 普通闲聊、问能不能做某事但没有给出具体任务、玩梗、情绪回应。",
                "如果用户需求明确对应【候选工具】中的某个工具，优先输出该工具名；这适用于三角洲、提醒、点歌、禁言、改名片、戳一戳、点赞、礼物、聊天记录、表情、导图等已有工具。",
                "选择具体工具时，intent 写 tool，toolName 写工具名，params 按该工具参数名生成 JSON；不确定必要参数时不要乱填，选 chat 让希洛追问。",
                "如果【候选工具详细规则】出现，必须优先按详细规则抽参；详细规则比通用描述更可信。",
                "语义判断框架：先判断载体和真实目标。图片/截图/引用/转发常是载体，用户真正要处理的可能是里面的内容、说法、政策、事件或人物。",
                "带图片/截图并说“查一下这个是真的假的/是不是真的/看看最新信息”时，真实目标默认是核实图片里承载的内容或说法；应先选 image_analysis 提取内容，后续再搜索。不要直接选纯 search，也不要理解成图片AI检测。",
                "只有用户明确说“图片本身、AI生成、P图、合成、修过、改过、伪造痕迹”时，才把目标理解为图片本身真实性鉴定。",
                "带指代词“这个/这张/里面/上面/刚才/他说的”时，必须结合格式化消息、引用和媒体判断指代对象。",
                "不要受角色人设影响；只判断用户真实语义。用户明确要求做图时，不要因为角色说不会画而选 chat。",
                "prompt 字段只用于缺少原文时兜底；不要为了委婉、安全或总结而改写用户的画图/修图原话，真正给绘图工具的文本会优先使用用户原话。",
                "reason 只写简短依据，不要输出完整思维链。",
                "输出格式: {\"intent\":\"...\",\"confidence\":0到1,\"toolName\":\"可选工具名\",\"params\":{},\"prompt\":\"给工具用的中文任务文本\",\"query\":\"搜索词或空字符串\",\"reason\":\"简短原因\"}",
                "",
                "【已注册 Agent Skills】",
                toolCatalog || "(无)",
                "每项 Skill 都是当前可执行能力。不要因为措辞不在示例中就忽略能力；先按语义选 Skill，再让其参数规范化器处理同义词和枚举。"
              ].join("\n")
            },
            {
              role: "user",
              content: [
                `当前文本: ${userText || "(空)"}`,
                `是否带图片: ${hasImages ? "是" : "否"}`,
                `是否带视频: ${hasVideos ? "是" : "否"}`,
                `格式化消息: ${quoted || "(空)"}`,
                context.groupWorkflowPrompt ? `可执行群工作流: ${safeTruncateUnicode(context.groupWorkflowPrompt, 1800)}` : ""
              ].join("\n")
            }
          ]
        })
      }, SEMANTIC_TOOL_INTENT_TIMEOUT_MS)

      const text = await response.text()
      if (!response.ok) {
        logger.warn(`[语义工具分类] 请求失败: ${response.status} ${text.slice(0, 240)}`)
        return null
      }
      const data = JSON.parse(text)
      const content = data?.choices?.[0]?.message?.content
      const parsed = this.extractJsonObject(content)
      const normalized = this.normalizeToolDecision(parsed, {
        ...context,
        availableToolNames
      })
      if (normalized) {
        logger.info(`[语义工具分类] intent=${normalized.intent} tool=${normalized.toolName || "none"} confidence=${parsed?.confidence ?? ""} elapsed=${Date.now() - classifyStartedAt}ms reason=${String(parsed?.reason || "").slice(0, 80)}`)
      }
      return normalized
    } catch (error) {
      logger.warn(`[语义工具分类] 失败 elapsed=${Date.now() - classifyStartedAt}ms: ${error.message}`)
      return null
    }
  }

  buildToolCallFromDecision(decision, context = {}) {
    if (!decision?.toolName) return null
    const tools = this.getToolsByName([decision.toolName])
    if (!tools?.length) return null
    return {
      ...decision,
      tools,
      toolCall: this.buildForcedToolCall(decision.toolName, decision.params || {})
    }
  }

  buildMissingToolCommitmentCall(content, context = {}) {
    const images = Array.isArray(context.images) ? context.images : []
    const args = context.args || ""
    const msg = context.msg || ""
    const currentIntentText = context.currentIntentText || [args, msg].filter(Boolean).join("\n")
    const combinedText = [currentIntentText, content].filter(Boolean).join("\n")
    const userRequestedImageEdit = images.length && isImageCompositionEditRequest(currentIntentText)
    const userRequestedImageGeneration = isImageGenerationRequest(currentIntentText)
    const userRequestedSearch = isRealtimeInfoRequest(currentIntentText) || isExplicitSearchRequest(currentIntentText)
    const userRequestedImageAnalysis = images.length && isImageAnalysisRequest(currentIntentText)
    const modelCommitted = hasToolCommitmentText(content)
    const contextualDrawCall = modelCommitted
      ? this.resolveContextualDrawGeneration({
          ...context,
          images,
          args,
          msg,
          currentIntentText,
          modelCommittedToDraw: /(?:画|生成|出图|做图|捏|绘制)/i.test(normalizeIntentText(content))
        })
      : null

    if (!modelCommitted && !userRequestedImageEdit && !userRequestedImageGeneration && !userRequestedSearch && !userRequestedImageAnalysis) return null

    const candidates = []
    if (userRequestedImageEdit || (images.length && isImageCompositionEditRequest(combinedText))) {
      candidates.push({
        toolName: "googleImageEditTool",
        reason: "commitment_image_edit",
        params: {
          images,
          prompt: this.buildImageEditPrompt({
            e: context.e,
            args,
            msg,
            currentIntentText,
            userContent: context.userContent,
            groupUserMessages: context.groupUserMessages
          })
        }
      })
    }
    if (!userRequestedImageEdit && images.length && isImageAnalysisRequest(combinedText)) {
      candidates.push({
        toolName: "googleImageAnalysisTool",
        reason: "commitment_image_analysis",
        params: {
          images,
          prompt: args || msg || "请识别这张图片里有什么内容，并用中文简洁描述。"
        }
      })
    }
    if (contextualDrawCall || userRequestedImageGeneration || isImageGenerationRequest(combinedText)) {
      candidates.push({
        toolName: "bananaTool",
        reason: contextualDrawCall?.reason || "commitment_image_generation",
        params: {
          prompt: contextualDrawCall?.prompt || this.buildImageGenerationPrompt({
              e: context.e,
              args,
              msg,
              currentIntentText,
              userContent: context.userContent,
              images,
              groupUserMessages: context.groupUserMessages
            }),
          images
        }
      })
    }
    if (userRequestedSearch || isRealtimeInfoRequest(combinedText) || isExplicitSearchRequest(combinedText)) {
      candidates.push({
        toolName: "searchInformationTool",
        reason: "commitment_search",
        params: {
          query: args || msg || currentIntentText
        }
      })
    }

    for (const candidate of candidates) {
      const tools = this.getToolsByName([candidate.toolName])
      if (!tools?.length) continue
      return {
        ...candidate,
        tools,
        toolCall: this.buildForcedToolCall(candidate.toolName, candidate.params)
      }
    }

    return null
  }

  /**
   * 执行工具 - 统一处理本地工具和MCP工具
   */
  normalizeAssistantToolMessage(message) {
    const normalized = {
      role: "assistant",
      content: message.content || "",
      tool_calls: (message.tool_calls || []).map(toolCall => ({
        id: toolCall.id,
        type: toolCall.type || "function",
        function: {
          name: toolCall.function?.name,
          arguments: toolCall.function?.arguments || "{}"
        }
      }))
    }

    if (message.reasoning_content) {
      normalized.reasoning_content = message.reasoning_content
    }

    return normalized
  }

  serializeToolResult(result) {
    if (typeof result === "string") return result

    if (result?.content && Array.isArray(result.content)) {
      return result.content
        .map(item => item.type === "text" ? item.text : JSON.stringify(item))
        .join("\n")
    }

    return JSON.stringify(result ?? "")
  }

  getToolCallName(toolCall = {}) {
    return toolCall?.function?.name || ""
  }

  shouldRunTerminalToolsInBackground(toolCalls = []) {
    return toolCalls.length > 0 &&
      toolCalls.every(toolCall => BACKGROUND_TERMINAL_TOOL_NAMES.has(this.getToolCallName(toolCall)))
  }

  buildGroundedImageAnalysisPrompt(prompt = "", session = {}, e = {}) {
    const currentIntentText = [
      session.rawArgs,
      e?.msg,
      prompt
    ].filter(Boolean).join("\n")
    const originalPrompt = String(prompt || currentIntentText || "").trim()
    const sourcePrompt = session.groupContextImagePrompt || e?._groupContextImagePrompt || ""
    const needsVerification =
      looksLikeImageVerificationRequest(currentIntentText) ||
      isRealtimeInfoRequest(currentIntentText) ||
      isExplicitSearchRequest(currentIntentText)
    const mode = getImageVerificationMode(currentIntentText)

    if (!needsVerification) return [originalPrompt, sourcePrompt].filter(Boolean).join("\n")

    if (mode === "image_authenticity") {
      return [
        "用户明确想判断图片本身是否为AI生成、P图、合成或被篡改。你现在只负责读图和提取可核查线索，不要给泛泛的鉴定教程。",
        "请严格基于图片完成以下内容：",
        "1. OCR提取图片里所有可见文字。",
        "2. 描述图片里的关键视觉内容、版式、边缘、光影、透视、文字渲染等可疑或正常线索。",
        "3. 提取3-8个适合联网搜索核实来源、旧图或相关事件的关键词或短句。",
        "4. 如果看不清，明确说哪些地方看不清，不要编。",
        `用户原话：${originalPrompt || "请分析这张图片是否可能被生成或修改。"}`,
        sourcePrompt
      ].filter(Boolean).join("\n")
    }

    return [
      "用户给图片是把它当作截图/信息载体，想核实图片里那段内容、消息、公告、新闻、政策、事件或说法是真是假，以及现在最新情况。",
      "默认不要判断图片本身是不是AI生成、P图，也不要给反向搜图、Exif、AI检测工具这类泛泛鉴定教程；除非用户明确问图片本身。",
      "你现在只负责读图和提取可核查内容。",
      "请严格基于图片完成以下内容：",
      "1. OCR提取图片里所有可见文字，尽量保留标题、正文、机构名、地点、时间、金额、政策名、链接、账号名。",
      "2. 用一句话概括图片里到底在说什么主张/消息/事件。",
      "3. 提取3-8个适合联网搜索核实这个内容真实性和最新状态的关键词或短句。",
      "4. 如果图片太糊或文字看不清，明确说哪些地方看不清，不要编。",
      "注意：不要把“不能直接检测真假”当作最终回答；内容真假和最新信息会在下一步联网核查。",
      `用户原话：${originalPrompt || "请识别这张图片里有什么内容，并提取可核查信息。"}`,
      sourcePrompt
    ].filter(Boolean).join("\n")
  }

  extractToolResultText(result = "") {
    const text = String(result || "").trim()
    if (!text) return ""
    try {
      const parsed = JSON.parse(text)
      if (typeof parsed?.analysis === "string") return parsed.analysis
      if (typeof parsed?.content === "string") return parsed.content
      if (typeof parsed?.message === "string") return parsed.message
    } catch {}
    return text
  }

  buildImageVerificationSearchToolCall(validResults = [], session = {}, e = {}) {
    if (!session.imageVerificationNeedsSearch || session.imageVerificationSearchDone) return null
    if (!session.tools?.some(tool => tool.function?.name === "searchInformationTool")) return null

    const visionResult = validResults.find(result =>
      result?.toolName === "googleImageAnalysisTool" &&
      result?.result &&
      !this.isToolResultError(result.result)
    )
    if (!visionResult) return null

    const imageText = safeTruncateUnicode(this.extractToolResultText(visionResult.result), 1800)
    if (!imageText) return null

    const rawUserText = [
      session.rawArgs,
      e?.msg
    ].filter(Boolean).join("\n")
    const userText = safeTruncateUnicode(rawUserText, 500)
    const mode = session.imageVerificationMode || getImageVerificationMode(userText)
    const query = mode === "image_authenticity"
      ? [
          "请联网核查这张图片是否可能是旧图、AI生成、P图、合成或被误传，并查找相关来源和最新信息。",
          `用户原话：${userText || "查一下这张图是不是AI生成或P图"}`,
          `图片OCR和识别结果：${imageText}`,
          "要求：优先使用图片中的文字、标题、地点、账号名、事件名等关键词检索；说明能查到的来源、是否存在旧图/相似图/相关事件；如果证据不足就明确说不足。"
        ].join("\n")
      : [
          "请联网核查图片里承载的内容/消息/公告/新闻/政策/事件/说法是否真实，以及现在最新情况。",
          "注意：默认不是核查图片文件本身是否AI生成或P图，不要把主要结论写成反向搜图、Exif、AI检测建议。",
          `用户原话：${userText || "查一下这个是真的假的，看看最新信息"}`,
          `图片OCR和识别结果：${imageText}`,
          "要求：优先使用OCR中的标题、正文关键词、机构名、地点、时间、金额、政策名、账号名、链接等检索；说明目前查到的事实、权威来源、是否过期/断章取义/误传；如果证据不足就明确说不足。"
        ].join("\n")

    session.imageVerificationSearchDone = true
    logger.info(`[工具选择] group=${e?.group_id || ""} 识图后自动追加 searchInformationTool 核实图片信息`)
    return this.buildForcedToolCall("searchInformationTool", { query })
  }

  startBackgroundTerminalToolCalls(toolCalls = [], e, session, senderRole, currentMessages = []) {
    e._longRunningToolTask = true
    session.taskDedupeToolTouched = true
    session.backgroundTerminalToolTouched = true

    for (const toolCall of toolCalls) {
      const toolName = this.getToolCallName(toolCall)
      const taskPromise = this.runToolCall(toolCall, e, session, senderRole)
      taskPromise
        .then(async result => {
          if (!result) return
          session.toolName = result.toolName
          session.toolResults = [result]
          if (!this.isToolResultError(result.result)) {
            logger.info(`[工具调用] 后台终态工具 ${result.toolName} 执行完成`)
            return
          }

          logger.warn(`[工具调用] 后台终态工具 ${result.toolName} 执行失败，发送拟人化失败提示 result=${String(result.result || "").slice(0, 240)}`)
          await this.handleToolFailureResponse(result.toolName, {
            messages: currentMessages,
            factualReply: this.getFriendlyFailureMessage(result.toolName, {
              e,
              session,
              stage: "background_terminal_tool_failed",
              error: result.result
            }),
            e,
            session,
          })
        })
        .catch(async error => {
          logger.error(`[工具调用] 后台终态工具 ${toolName || "unknown"} 异常:`, error)
          try {
            await this.handleToolFailureResponse(toolName, {
              messages: currentMessages,
              factualReply: this.getFriendlyFailureMessage(toolName, {
                e,
                session,
                stage: "background_terminal_tool_exception",
                error: error.message
              }),
              e,
              session,
            })
          } catch (replyError) {
            logger.error(`[工具调用] 后台终态工具失败提示发送异常:`, replyError)
          }
        })
    }
  }

  async runToolCall(toolCall, e, session, senderRole) {
    const { type, function: funcData } = toolCall
    if (type !== "function" || !funcData?.name) return null

    const toolName = funcData.name
    const isMCPTool = mcpManager.isMCPTool(toolName)
    const isLocalTool = !isMCPTool && this.toolInstances[toolName]
    const isValidTool = session.tools?.some(t => t.function?.name === toolName)

    if (!isValidTool || (!isMCPTool && !isLocalTool)) {
      return {
        toolCall,
        toolName,
        result: `error: tool ${toolName} is not available in this session`
      }
    }

    let params
    try {
      params = JSON.parse(funcData.arguments || "{}")
    } catch (error) {
      return {
        toolCall,
        toolName,
        result: `error: 参数 JSON 解析失败：${buildVisibleFailureDetail(error)}`
      }
    }

    if (toolName === "mentionAdminsTool" && !isExplicitAdminCollectionMentionRequest(session?.rawArgs || e?.msg || "")) {
      logger.warn(`[工具调用] 拒绝非集合措辞的 mentionAdminsTool group=${e?.group_id || ""}`)
      return {
        toolCall,
        toolName,
        result: "error: mentionAdminsTool 只能用于明确要求所有管理员、管理员们或全体群管的通知"
      }
    }

    if (["bananaTool", "googleImageEditTool", "googleImageAnalysisTool", "searchInformationTool"].includes(toolName) && !params.agentContext) {
      params.agentContext = buildAgentProgressContext({
        userContent: session?.userContent || e?.msg || "",
        quotedContext: e?._quotedPromptContext?.text || "",
        messages: session?.groupUserMessages || []
      })
    }

    if (toolName === "googleImageAnalysisTool" && (!Array.isArray(params.images) || !params.images.length) && session.images?.length) {
      params.images = session.images
    }
    if (toolName === "googleImageAnalysisTool") {
      params.prompt = this.buildGroundedImageAnalysisPrompt(params.prompt, session, e) || params.prompt
    }
    if (toolName === "googleImageEditTool" && (!Array.isArray(params.images) || !params.images.length) && session.images?.length) {
      params.images = session.images
    }
    if (toolName === "googleImageEditTool") {
      params.prompt = this.buildImageEditPrompt({
        e,
        prompt: params.prompt,
        args: session.rawArgs,
        msg: e?.msg,
        currentIntentText: [session.rawArgs, e?.msg].filter(Boolean).join("\n"),
        userContent: session.userContent,
        groupUserMessages: session.groupUserMessages
      }) || params.prompt
      if (session.editAssets?.promptHint && !params.prompt.includes(session.editAssets.promptHint)) {
        params.prompt = [params.prompt, session.editAssets.promptHint].filter(Boolean).join("\n")
      }
      if (session.avatarEditBase?.promptHint && !params.prompt.includes(session.avatarEditBase.promptHint)) {
        params.prompt = [params.prompt, session.avatarEditBase.promptHint].filter(Boolean).join("\n")
      }
    }
    if (toolName === "bananaTool") {
      if (!params.prompt && session.rawArgs) params.prompt = session.rawArgs
      const imageGenerationReferenceImages = this.getImageGenerationReferenceImages(params.images, session)
      if ((!Array.isArray(params.images) || !params.images.length) && imageGenerationReferenceImages.length) {
        params.images = imageGenerationReferenceImages
      }
      if (session.avatarDrawReference?.images?.length) {
        params.referencePurpose = "member_avatar"
      }
      params.prompt = this.buildImageGenerationPrompt({
        e,
        prompt: params.prompt,
        args: session.rawArgs,
        msg: e?.msg,
        currentIntentText: [session.rawArgs, e?.msg].filter(Boolean).join("\n"),
        userContent: session.userContent,
        images: params.images,
        avatarDrawReference: session.avatarDrawReference
      }) || params.prompt
    }

    if (toolName === "jinyanTool" && senderRole) {
      params.senderRole = senderRole
    }
    if (toolName === "changeCardTool" && senderRole) {
      params.senderRole = senderRole
    }

    const dedupeEnabled = this.isDedupeTool(toolName)
    const task = session.taskContext || {}
    const toolRunKey = dedupeEnabled ? this.getToolRunKey(e.group_id, e.user_id, toolName) : ""
    const toolRunValue = {
      groupId: e.group_id,
      userId: e.user_id,
      messageId: task.messageId || e.message_id || null,
      toolName,
      startedAt: Date.now()
    }

    if (dedupeEnabled) {
      if (activeDedupeToolRuns.has(toolRunKey)) {
        return {
          toolCall,
          toolName,
          result: `工具 ${toolName} 正在处理同一用户的上一条请求，已跳过重复调用`
        }
      }

      activeDedupeToolRuns.set(toolRunKey, toolRunValue)
      session.taskDedupeToolTouched = true
      if (toolRunValue.messageId) {
        await this.saveTaskStatus({
          groupId: e.group_id,
          userId: e.user_id,
          messageId: toolRunValue.messageId,
          status: "tool_running",
          toolName
        })
      }
    }

    const toolStartedAt = Date.now()
    try {
      logger.info(`[工具调用] ${isMCPTool ? "MCP" : "本地"} ${formatTurnPlanLog(session.turnPlan)} tool=${toolName} params=${JSON.stringify(params)}`)
      const toolEvent = isMCPTool ? e : Object.assign(Object.create(e || null), {
        memoryManager: this.memoryManager
      })
      const rawResult = isMCPTool
        ? await this.executeTool(toolName, params, e)
        : await this.executeTool(this.toolInstances[toolName], params, toolEvent)
      const serializedResult = this.serializeToolResult(rawResult)
      // Tool output is fed back into another model and may later be shown to
      // the user. Normalize every failing result here, including legacy tools
      // that still return a raw error string instead of throwing.
      const result = this.isRawToolFailure(serializedResult)
        ? `error: ${buildVisibleFailureDetail(serializedResult)}`
        : serializedResult
      logger.info(`[工具耗时] group=${e?.group_id || ""} ${formatTurnPlanLog(session.turnPlan)} tool=${toolName} elapsed=${Date.now() - toolStartedAt}ms`)
      recordTurnPlanToolOutcome(session.turnPlan, {
        toolName,
        success: !this.isToolResultError(result)
      })
      if (dedupeEnabled && toolRunValue.messageId) {
        const failed = this.isToolResultError(result)
        await this.saveTaskStatus({
          groupId: e.group_id,
          userId: e.user_id,
          messageId: toolRunValue.messageId,
          status: failed ? "tool_failed" : "tool_success",
          toolName,
          error: failed ? result : ""
        })
      }
      return {
        toolCall,
        toolName,
        result: result?.trim() ? result : `工具 ${toolName} 执行成功`
      }
    } catch (error) {
      if (dedupeEnabled && toolRunValue.messageId) {
        await this.saveTaskStatus({
          groupId: e.group_id,
          userId: e.user_id,
          messageId: toolRunValue.messageId,
          status: "tool_failed",
          toolName,
          error: buildVisibleFailureDetail(error)
        })
      }
      logger.error(`[工具调用] ${toolName} 执行失败:`, error)
      recordTurnPlanToolOutcome(session.turnPlan, { toolName, success: false })
      return {
        toolCall,
        toolName,
        result: `error: ${buildVisibleFailureDetail(error)}`
      }
    } finally {
      if (dedupeEnabled && activeDedupeToolRuns.get(toolRunKey) === toolRunValue) {
        activeDedupeToolRuns.delete(toolRunKey)
      }
    }
  }

  dedupeToolCalls(toolCalls = []) {
    const seen = new Set()
    return toolCalls.filter(toolCall => {
      const key = `${toolCall.function?.name}:${toolCall.function?.arguments || "{}"}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  async processToolCalls(message, e, session, groupUserMessages, atQq, senderRole, options = {}) {
    const MAX_TOOL_ROUNDS = resolveToolRoundLimit(this.config, {
      messages: groupUserMessages,
      toolNames: (message?.tool_calls || []).map(toolCall => this.getToolCallName(toolCall))
    })
    let currentMessage = message
    let currentMessages = [...groupUserMessages]
    let round = 0
    const allToolResults = []

    while (currentMessage.tool_calls?.length && round < MAX_TOOL_ROUNDS) {
      round++
      const toolCalls = this.dedupeToolCalls(currentMessage.tool_calls)
      logger.info(`[工具调用] 第 ${round} 轮，共 ${toolCalls.length} 个工具`)

      currentMessages.push(this.normalizeAssistantToolMessage({
        ...currentMessage,
        tool_calls: toolCalls
      }))

      if (this.shouldRunTerminalToolsInBackground(toolCalls)) {
        session.toolName = this.getToolCallName(toolCalls[toolCalls.length - 1])
        this.startBackgroundTerminalToolCalls(toolCalls, e, session, senderRole, currentMessages)
        logger.info(`[工具调用] 后台启动终态工具(${toolCalls.map(toolCall => this.getToolCallName(toolCall)).join(',')})，主流程立即释放`)
        return
      }

      const validResults = (await Promise.all(
        toolCalls.map(toolCall => this.runToolCall(toolCall, e, session, senderRole))
      )).filter(Boolean)

      if (validResults.length === 0) break

      allToolResults.push(...validResults)
      session.toolName = validResults[validResults.length - 1]?.toolName

      currentMessages.push(...validResults.map(({ toolCall, toolName, result }) => ({
        role: "tool",
        tool_call_id: toolCall.id,
        name: toolName,
        content: result
      })))

      const imageVerificationSearchCall = this.buildImageVerificationSearchToolCall(validResults, session, e)
      if (imageVerificationSearchCall) {
        currentMessage = {
          role: "assistant",
          content: "",
          tool_calls: [imageVerificationSearchCall]
        }
        continue
      }

      if (
        session.imageVerificationSearchDone &&
        !session.imageVerificationFinalInstructionAdded &&
        validResults.some(result => result.toolName === "searchInformationTool")
      ) {
        session.imageVerificationFinalInstructionAdded = true
        const finalInstruction = session.imageVerificationMode === "image_authenticity"
          ? "【图片本身核实回复要求】请综合图片OCR/识别结果和联网搜索结果，回答用户这张图片本身是否可能是AI生成、P图、合成、旧图或误传。不要只列通用鉴定方法；如果证据不足，就明确说已查到什么、没查到什么、为什么还不能下定论。"
          : "【图片内容核实回复要求】用户问“这图/这个真的假的”时，默认是在问图片里承载的内容/消息/公告/新闻/政策/事件/说法是真是假，不是在问图片文件本身是否AI生成或P图。请综合图片OCR/识别结果和联网搜索结果，直接回答图里这段内容目前看是否真实、是否过期或误传、最新情况是什么。不要只列反向搜图、Exif、AI检测等通用鉴定方法；如果证据不足，就明确说已查到什么、没查到什么、为什么还不能下定论。"
        currentMessages.push({
          role: "system",
          content: finalInstruction
        })
      }

      if (validResults.some(result => result.toolName === "modrinthTool")) {
        currentMessages.push({ role: "system", content: buildModrinthBilingualReplyInstruction() })
      }

      const continuationMode = decideToolContinuation(validResults, options)
      if (continuationMode === "direct_result") {
        session.toolResults = allToolResults
        const directText = validResults
          .map(result => String(result.result || "").replace(/^error:\s*/i, ""))
          .filter(Boolean)
          .join("\n\n")
        await this.handleTextResponse(
          directText || "Excel 查询没有返回可用结果。",
          e,
          session,
          currentMessages,
          session.toolName
        )
        logger.info(`[工具调用] ${validResults.map(result => result.toolName).join(',')} 使用精确结果直接回复，跳过模型总结`)
        return
      }

	      if (validResults.every(r => TERMINAL_TOOL_NAMES.has(r.toolName))) {
		        session.toolResults = allToolResults
			        const failedResult = validResults.find(r => this.isToolResultError(r.result))
		        if (failedResult) {
		          logger.warn(`[工具调用] 终态工具 ${failedResult.toolName} 执行失败，发送拟人化失败提示 result=${String(failedResult.result || "").slice(0, 240)}`)
          await this.handleToolFailureResponse(failedResult.toolName, {
            messages: currentMessages,
            factualReply: this.getFriendlyFailureMessage(failedResult.toolName, {
              e,
              session,
              stage: "terminal_tool_failed",
              error: failedResult.result
            }),
            e,
            session
          })
	          return
	        }
	        logger.info(`[工具调用] 本轮全部为终态工具(${validResults.map(r => r.toolName).join(',')})且执行成功，跳过最终文本回复`)
	        return
	      }

      if (!hasUsableToolResult(allToolResults)) {
        session.toolResults = allToolResults
        const unavailableReply = buildUnavailableToolReply(allToolResults)
        logger.warn(`[工具事实边界] ${allToolResults.map(result => result.toolName).join(',')} 本轮无可用结果，禁止进入历史补全式总结`)
        await this.handleToolFailureResponse(session.toolName, {
          e,
          session,
          messages: currentMessages,
          factualReply: unavailableReply
        })
        return
      }
      currentMessages.push({
        role: "system",
        content: buildToolGroundingInstruction(allToolResults)
      })

      const isModrinthOnlyResult = allToolResults.length > 0 &&
        allToolResults.every(result => result.toolName === "modrinthTool") &&
        allToolResults.every(result => !this.isToolResultError(result.result))
      if (isModrinthOnlyResult) {
        const ranking = parseModrinthRankingData(validResults.at(-1)?.result)
        if (ranking) {
          const translateStartedAt = Date.now()
          const { cached, missing } = collectModrinthTranslations(ranking)
          const translations = new Map(cached)
          if (missing.length) {
            const compactMessages = buildModrinthTranslationMessages(missing)
            const compactResponse = await this.retryRequest(
              {
                model: this.config?.taskAiConfig?.translation?.model || this.config?.chatAiConfig?.chatApiModel,
                messages: compactMessages,
                stream: false,
                temperature: 0
              },
              session.toolContent,
              1,
              "modrinthTool",
              {
                taskBackend: "translation",
                routeLabel: "Modrinth 简介翻译",
                generation: { temperature: 0, maxOutputTokens: 1200 }
              }
            )
            const compactContent = compactResponse?.choices?.[0]?.message?.content
            const translated = parseModrinthTranslationResponse(compactContent, missing.map(item => item.projectId))
            if (!translated) {
              logger.warn(`[工具调用] Modrinth 简介翻译失败 elapsed=${Date.now() - translateStartedAt}ms error=${compactResponse?.error ? String(compactResponse.error).slice(0, 240) : "invalid_json"}`)
              await this.handleToolFailureResponse("modrinthTool", {
                e,
                session,
                messages: currentMessages,
                factualReply: this.getFriendlyFailureMessage("modrinthTool", { e, session, stage: "modrinth_translation", error: compactResponse?.error || "翻译模型没有返回完整 JSON" })
              })
              return
            }
            for (const [projectId, text] of translated) translations.set(projectId, text)
            cacheModrinthTranslations(ranking, translated)
          }
          const forwardItems = buildModrinthForwardItemsFromData(ranking, translations)
          const cardItems = buildModrinthCardItemsFromData(ranking, translations)
          if (forwardItems.length === ranking.items.length && cardItems.length === ranking.items.length) {
            session.toolResults = allToolResults
            session.modrinthCardItems = cardItems
            await this.handleTextResponse(wrapModrinthForwardItems(forwardItems), e, session, currentMessages, "modrinthTool")
            logger.info(`[工具调用] Modrinth 结构化翻译完成 items=${forwardItems.length} cacheHits=${cached.size} cacheMisses=${missing.length} elapsed=${Date.now() - translateStartedAt}ms`)
            return
          }
        }
        logger.warn(`[工具调用] Modrinth 结构化结果无效，回退通用续轮`)
      }

      if (continuationMode === "chat_only") {
        session.toolResults = allToolResults
        const finalRequest = this.buildRequestData(currentMessages, [], "none")
        const finalResponse = await this.retryRequest(finalRequest, session.toolContent, 1, session.toolName)
        const finalContent = finalResponse?.choices?.[0]?.message?.content
        if (finalContent) {
          await this.handleTextResponse(finalContent, e, session, currentMessages, session.toolName)
        } else {
          logger.warn(`[回复失败] group=${e?.group_id || ""} user=${e?.user_id || ""} stage=synthetic_tool_summary tool=${session.toolName || ""} error=${finalResponse?.error ? JSON.stringify(finalResponse.error).slice(0, 240) : "no_choices"}`)
          await this.handleToolFailureResponse(session.toolName, {
            e,
            session,
            messages: currentMessages,
            factualReply: this.getFriendlyFailureMessage(session.toolName, { e, session, stage: "synthetic_tool_summary", error: finalResponse?.error })
          })
        }
        logger.info(`[工具调用] 合成工具调用 ${session.toolName || "unknown"} 跳过 thinking 工具续轮，直接进入无工具总结`)
        return
      }

	      const nextRequest = this.buildRequestData(currentMessages, session.tools, "auto")
	      const nextResponse = await this.retryRequest(nextRequest, session.toolContent, 1, session.toolName)
	      const nextMessage = nextResponse?.choices?.[0]?.message
	      if (!nextMessage) {
	        logger.warn(`[回复失败] group=${e?.group_id || ""} user=${e?.user_id || ""} stage=tool_round_summary tool=${session.toolName || ""} error=${nextResponse?.error ? JSON.stringify(nextResponse.error).slice(0, 240) : "no_choices"}`)
	        break
	      }

      currentMessage = nextMessage
      if (!currentMessage.tool_calls?.length && currentMessage.content) {
        session.toolResults = allToolResults
        await this.handleTextResponse(
          currentMessage.content,
          e,
          session,
          currentMessages,
          session.toolName
        )
        return
      }
    }

    if (round >= MAX_TOOL_ROUNDS) {
      logger.warn(`[工具调用] 已达到最大轮数：${MAX_TOOL_ROUNDS}`)
    }

    session.toolResults = allToolResults
    const finalRequest = this.buildRequestData(currentMessages, [], "none")
    const finalResponse = await this.retryRequest(finalRequest, session.toolContent, 1, session.toolName)

	    if (finalResponse?.choices?.[0]?.message?.content) {
	      await this.handleTextResponse(
	        finalResponse.choices[0].message.content,
        e,
        session,
        currentMessages,
	        session.toolName
	      )
	    } else {
	      logger.warn(`[回复失败] group=${e?.group_id || ""} user=${e?.user_id || ""} stage=final_tool_summary tool=${session.toolName || ""} error=${finalResponse?.error ? JSON.stringify(finalResponse.error).slice(0, 240) : "no_choices"}`)
        await this.handleToolFailureResponse(session.toolName, {
          e,
          session,
          messages: currentMessages,
          factualReply: this.getFriendlyFailureMessage(session.toolName, { e, session, stage: "final_tool_summary", error: finalResponse?.error || "没有可用的最终回复" })
        })
	    }
	  }

  async executeTool(tool, params, e, isRetry = false) {
    try {
      if (typeof tool === "string" && mcpManager.isMCPTool(tool)) {
        return await mcpManager.executeToolByAlias(tool, params)
      }

      if (tool && typeof tool.execute === "function") {
        return await tool.execute(params, e)
      }

      return null
    } catch (error) {
      if (!isRetry) {
        return this.executeTool(tool, params, e, true)
      }
      throw error
    }
  }

  async handleTextResponse(content, e, session, messages, toolName) {
    let output = await this.processToolSpecificMessage(content, toolName)
    if (!output) {
      logger.warn("[最终回复清理] 模型回复只包含伪工具格式，已跳过发送")
      return
    }
    if (containsInternalStatusLeak(output)) {
      logger.warn(`[最终回复清理] 检测到内部状态泄漏，已替换为自然失败提示: ${output.slice(0, 120)}`)
      output = buildInternalStatusSafeReply(toolName, session)
    }
    const modrinthItems = toolName === "modrinthTool" ? extractModrinthForwardItems(output) : []
    const modrinthCardItems = modrinthItems.length && Array.isArray(session?.modrinthCardItems)
      ? session.modrinthCardItems
      : []
    if (session?.modrinthCardItems) session.modrinthCardItems = null
    if (toolName === "modrinthTool") output = stripModrinthForwardMarkers(output)
    if (!modrinthItems.length) {
      output = polishHumanReplyText(output)
      output = enforcePersonaToneBoundary(output, {
        userText: session?.userContent || e?.msg || "",
        toolName
      })
      output = personaFeedbackManager.guardReply(output, this.config.personaGuard, {
        userText: session?.userContent || e?.msg || "",
        botNames: [Bot?.nickname, this.config?.persona?.name]
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
        : await this.sendSegmentedMessage(e, output)

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

  async recordPersonaFeedback(e) {
    const result = await personaFeedbackManager.recordFeedback(e, e.msg || "")
    const feedback = personaFeedbackManager.getLatestFeedback(e)
    if (feedback) {
      try {
        globalStyleLearnerManager.observePersonaFeedback(
          feedback,
          this.config.globalStyleLearning,
          this.config.embeddingAiConfig
        )
      } catch (error) {
        logger.warn(`[全局表达学习] 记录主人反馈失败: ${error.message}`)
      }
    }
    await this.sendObservedReply(e, result)
    return true
  }

  async globalStyleLearningCommand(e) {
    if (!e?.isMaster) {
      await this.sendObservedReply(e, "只有主人可以查看或调整全局表达学习。")
      return true
    }
    const text = String(e.msg || "")
    const subCommand = text
      .replace(/^[#＃.。]\s*(全局表达学习|表达学习)\s*/, "")
      .trim()
    const helpText = [
      "全局表达学习：",
      ".表达学习 状态 - 看是否在学习、是否已注入",
      ".表达学习 记忆 - 看希洛当前会吸收/避开的表达策略",
      ".表达学习 报告 - 看样本和离散特征统计",
      ".表达学习 总结 - 调用模型，把脱敏样本沉淀成表达规则",
      ".表达学习 候选 - 看自主学习候选和影子策略",
      ".表达学习 清空 - 清空全局表达学习记忆"
    ].join("\n")

    if (!subCommand || /帮助/.test(subCommand)) {
      await this.sendObservedReply(e, helpText)
      return true
    }
    if (/清空/.test(subCommand)) {
      globalStyleLearnerManager.clear(this.config.globalStyleLearning)
      await this.sendObservedReply(e, "全局表达学习记忆已清空。")
      return true
    }
    if (/总结/.test(subCommand)) {
      try {
        const result = await globalStyleLearnerManager.summarizeWithAI(
          this.config.globalStyleLearning,
          this.config.memoryAiConfig
        )
        await this.sendObservedReply(e, [
          "全局表达学习总结完成：",
          `本次参考脱敏样本：${result.sampleCount} 条`,
          `新增/更新可吸收规则：${result.absorbChanged} 条`,
          `新增/更新避坑规则：${result.avoidChanged} 条`,
          `当前模型规则：可吸收 ${result.totalAbsorb} 条，避坑 ${result.totalAvoid} 条`
        ].join("\n"))
      } catch (error) {
        logger.warn(`[全局表达学习] 模型总结失败: ${error.message}`)
        await this.sendObservedReply(e, `全局表达学习总结失败：${error.message}`)
      }
      return true
    }
    if (/报告/.test(subCommand)) {
      await this.sendObservedReply(e, globalStyleLearnerManager.buildReport(this.config.globalStyleLearning))
      return true
    }
    if (/候选|自主/.test(subCommand)) {
      await this.sendObservedReply(e, globalStyleLearnerManager.buildAutoEvolutionView(this.config.globalStyleLearning))
      return true
    }
    if (/记忆/.test(subCommand)) {
      await this.sendObservedReply(e, globalStyleLearnerManager.buildMemoryView(this.config.globalStyleLearning))
      return true
    }
    if (/状态/.test(subCommand)) {
      await this.sendObservedReply(e, globalStyleLearnerManager.buildStatus(this.config.globalStyleLearning))
      return true
    }
    await this.sendObservedReply(e, helpText)
    return true
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

  async sendObservedReply(e, payload, quote = false, channel = "command") {
    try {
      const result = await e.reply(payload, quote)
      logDeliveryOutcome(logger, {
        status: "sent",
        channel,
        groupId: e?.group_id,
        userId: e?.user_id,
        messageId: extractDeliveryMessageId(result)
      })
      return result
    } catch (error) {
      logDeliveryOutcome(logger, {
        status: "failed",
        channel,
        groupId: e?.group_id,
        userId: e?.user_id,
        error
      })
      throw error
    }
  }

  async sendSegmentedMessage(e, output, quoteChance = 0.5) {
    try {
      const groupId = e?.group_id
      if (shouldCancelProactiveReply(e, lastIncomingMsgAt.get(groupId) || 0)) {
        logger.info(`[回复新鲜度] group=${groupId || ""} cancelled anchor=${e?._proactiveReplyAnchorAt || 0} latest=${lastIncomingMsgAt.get(groupId) || 0}`)
        return null
      }
      const replyWithReceipt = async (payload, quote, channel = "agent_text") => {
        return await this.sendObservedReply(e, payload, quote, channel)
      }
      if (typeof output === "string") {
        output = enforcePersonaToneBoundary(output, {
          userText: e?.msg || ""
        })
        output = personaFeedbackManager.guardReply(output, this.config.personaGuard, {
          userText: e?.msg || "",
          botNames: [Bot?.nickname, this.config?.persona?.name]
        })
      }
      output = sanitizeFinalReplyText(output)
      // QQ 不渲染围栏代码块，会把 ```bash 拆成 `` bash、游离反引号等碎片；
      // 走纯文本兜底时先压平成逐行行内代码胶囊。
      if (containsCodeFence(output)) {
        const flattened = flattenCodeFences(output)
        if (flattened !== output) {
          logger.info(`[代码块压平] 纯文本回复含围栏代码块，已转为行内代码发送 len=${output.length}`)
          output = flattened
        }
      }
      if (!output) return null
      if (output.includes("\\n")) {
        logger.warn(`[分段发送] sanitize后仍含字面\\n! raw=${JSON.stringify(output).slice(0, 200)}`)
      }
      // smart 模式：发完话后记录 bot 上次发言时间和关键词，给 prefilter R1/R2 识别接续用
      const triggerMode = String(this.config?.chatTriggerMode || 'strict').toLowerCase()
      if (groupId && triggerMode === 'smart') {
        try {
          const st = this.getSmartState(groupId)
          st.lastBotReplyAt = Date.now()
          st.lastBotReplyToUserId = e?.user_id ? String(e.user_id) : null
          const maxKw = Number(this.config?.smartTrigger?.continuationKeywordMaxCount) || 5
          st.lastBotReplyKeywords = extractChatKeywords(output, maxKw)
          logger.info(`[SmartState] group=${groupId} 记录bot回复 user=${st.lastBotReplyToUserId || ''} keywords=${JSON.stringify(st.lastBotReplyKeywords)}`)
        } catch (err) {
          logger.warn(`[SmartState] 记录 bot 发言失败：${err.message}`)
        }
      }
      // 主动搭话路径（smart 模式 Gate 非 force 触发）强制不引用：bot 像群友自然插话而非"回复某人"
      if (e?._proactiveReply && this.config?.smartTrigger?.proactiveReplyNoQuote !== false) {
        quoteChance = 0
      }
      const shouldQuote = Math.random() < quoteChance

      // @ 转换可能失败（group 对象过期等），失败时跳过不影响分段
      let groupForAt = null
      try {
        groupForAt = e.group
      } catch {}

      const rhythmPlan = planTextReplyMessages(output, {
        ...(this.config?.replyRhythm || {}),
        userText: e?.msg || ""
      })
      const messageSegments = rhythmPlan.messages.length > 1
        ? rhythmPlan.messages
        : this.splitMessage(output)

      // 含 @ 时也要分段：先拆分再对每段单独处理 @
      const hasNewline = output.includes("\n")
      if (groupForAt && hasNewline) {
        try {
          const { hasAt } = await this.convertAtInString(output, groupForAt)
          if (hasAt) {
            let lastMessageId = null
            for (let i = 0; i < messageSegments.length; i++) {
              const seg = messageSegments[i]?.trim()
              if (!seg) continue
              const { hasAt: segHasAt, msgSegments } = await this.convertAtInString(seg, groupForAt)
              const quote = shouldQuote && i === 0
              if (segHasAt && msgSegments) {
                const res = await replyWithReceipt(msgSegments, quote)
                lastMessageId = res?.message_id
              } else {
                const res = await replyWithReceipt(seg, quote)
                lastMessageId = res?.message_id
              }
              if (i < messageSegments.length - 1) {
                const typingSpeed = Number(this.config?.smartTrigger?.typingSpeed) || 0
                let delay
                if (typingSpeed > 0) {
                  delay = Math.min(Math.max(seg.length * 1000 / typingSpeed + Math.random() * 300, 200), 5000)
                } else {
                  delay = Math.min(1000 + seg.length * 5 + Math.random() * 500, 3000)
                }
                await new Promise(r => setTimeout(r, delay))
              }
            }
            return lastMessageId
          }
        } catch (err) {
          logger.warn(`[分段发送] @ 分段处理失败，走普通分段: ${err.message}`)
        }
      }

      // 无换行时含 @ 直接发（不需要分段）
      if (groupForAt && !hasNewline) {
        try {
          const { hasAt, msgSegments } = await this.convertAtInString(output, groupForAt)
          if (hasAt && msgSegments) {
            const res = await replyWithReceipt(msgSegments, false)
            return res?.message_id
          }
        } catch (err) {
          logger.warn(`[分段发送] convertAtInString 失败，跳过 @ 转换: ${err.message}`)
        }
      }

      // token 计算可能失败，失败时默认走分段逻辑
      let totalTokens = 999
      try {
        const result = await TotalTokens(output)
        totalTokens = result.total_tokens
      } catch (err) {
        logger.warn(`[分段发送] TotalTokens 计算失败，按需分段: ${err.message}`)
      }

      let lastMessageId = null
      if (totalTokens <= 10 && !hasNewline) {
        const res = await replyWithReceipt(output, shouldQuote)
        lastMessageId = res?.message_id
        return lastMessageId
      }

      for (let i = 0; i < messageSegments.length; i++) {
        if (messageSegments[i]?.trim()) {
          const quote = shouldQuote && i === 0
          const res = await replyWithReceipt(messageSegments[i].trim(), quote)
          lastMessageId = res?.message_id

          if (i < messageSegments.length - 1) {
            const typingSpeed = Number(this.config?.smartTrigger?.typingSpeed) || 0
            let delay
            if (typingSpeed > 0) {
              delay = Math.min(Math.max(messageSegments[i].length * 1000 / typingSpeed + Math.random() * 300, 200), 5000)
            } else {
              delay = Math.min(1000 + messageSegments[i].length * 5 + Math.random() * 500, 3000)
            }
            await new Promise(r => setTimeout(r, delay))
          }
        }
      }
      return lastMessageId
    } catch (error) {
      logger.error(`[分段发送-异常] 走了catch兜底! error=${error?.message || error}, stack=${error?.stack?.slice(0, 300)}`)
      try {
        const res = await this.sendObservedReply(e, String(output || "").trim(), false, "agent_text_fallback")
        return res?.message_id
      } catch {}
      const res = await this.sendObservedReply(e, output, false, "agent_text_fallback")
      return res?.message_id
    }
  }

  splitMessage(text) {
    const maxChars = Math.max(300, Number(this.config?.messageSplitMaxChars) || 900)
    const maxSegments = Math.max(1, Number(this.config?.messageSplitMaxSegments) || 2)
    const rawText = String(text || "").trim()
    if (!rawText || rawText.length <= maxChars) return rawText ? [rawText] : []

    const paragraphs = rawText.split(/\n{2,}/).map(s => s.trim()).filter(Boolean)
    const lineBlocks = paragraphs.length > 1
      ? paragraphs
      : rawText.split(/\n/).map(s => s.trim()).filter(Boolean)

    const merged = []
    let current = ""
    for (const block of lineBlocks) {
      const candidate = current ? `${current}\n${block}` : block
      if (candidate.length <= maxChars) {
        current = candidate
        continue
      }
      if (current) merged.push(current)
      current = block
    }
    if (current) merged.push(current)

    if (merged.length > 1) {
      if (merged.length <= maxSegments) return merged
      const result = merged.slice(0, maxSegments - 1)
      result.push(merged.slice(maxSegments - 1).join("\n"))
      return result
    }

    return this.splitLongMessageByPunctuation(rawText, maxChars, maxSegments)
  }

  splitLongMessageByPunctuation(text, maxChars = 900, maxSegments = 3) {
    const punctuations = ["。", "！", "？", "；", "!", "?", ";", "\n"]
    const cqCodes = [], emojis = []
    let processed = text

    processed = processed.replace(/$$CQ:[^$$]+$$/g, m => { cqCodes.push(m); return `{{CQ${cqCodes.length - 1}}}` })
    processed = processed.replace(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]/gu, m => { emojis.push(m); return `{{E${emojis.length - 1}}}` })
    processed = processed.replace(/\.{3,}|…+/g, "{{...}}")

    const idealLen = Math.min(maxChars, Math.ceil(processed.length / Math.min(Math.ceil(processed.length / maxChars), maxSegments)))
    const points = []
    let last = 0

    for (let i = 0; i < processed.length; i++) {
      const ch = processed[i]
      if (ch === '\n') {
        if (i - last + 1 < idealLen * 0.7) continue
        points.push(i + 1)
        last = i + 1
      } else if (punctuations.includes(ch) && i - last + 1 >= idealLen * 0.7) {
        points.push(i + 1)
        last = i + 1
      }
    }

    const segments = []
    let start = 0
    for (const p of points) {
      if (p > start) { segments.push(processed.slice(start, p)); start = p }
    }
    if (start < processed.length) segments.push(processed.slice(start))
    if (segments.length > maxSegments) {
      return [
        ...segments.slice(0, maxSegments - 1),
        segments.slice(maxSegments - 1).join("")
      ].map(s =>
        s.replace(/{{\.\.\.}}/g, "...")
          .replace(/{{CQ(\d+)}}/g, (_, i) => cqCodes[i])
          .replace(/{{E(\d+)}}/g, (_, i) => emojis[i])
          .trim()
      )
    }

    return segments.map(s =>
      s.replace(/{{\.\.\.}}/g, "...")
        .replace(/{{CQ(\d+)}}/g, (_, i) => cqCodes[i])
        .replace(/{{E(\d+)}}/g, (_, i) => emojis[i])
        .trim()
    )
  }

  async convertAtInString(content, group) {
    if (!group) return { result: content, hasAt: false, msgSegments: null }

    const members = await group.getMemberMap()
    const atList = []

    // 匹配 @QQ号 格式（5-11位纯数字）
    for (const match of content.matchAll(/@(\d{5,11})(?!\d)/g)) {
      const member = this.findMember(match[1], members)
      if (member) {
        atList.push({ index: match.index, length: match[0].length, qq: member.qq })
      }
    }

    // 匹配 @昵称 格式（非数字开头，取到标点或空白为止）
    for (const match of content.matchAll(/@([^\s\d@，。！？、；：""''（）【】,.!?;:'"()\[\]]{1,20})/g)) {
      const member = this.findMember(match[1], members)
      if (member && !atList.some(a => a.qq === member.qq)) {
        atList.push({ index: match.index, length: match[0].length, qq: member.qq })
      }
    }

    if (atList.length === 0) return { result: content, hasAt: false, msgSegments: null }

    // 按位置排序，构建消息段数组（@ 保持在原始位置）
    atList.sort((a, b) => a.index - b.index)
    const msgSegments = []
    let lastEnd = 0
    for (const at of atList) {
      if (at.index > lastEnd) {
        msgSegments.push(content.slice(lastEnd, at.index))
      }
      msgSegments.push(segment.at(at.qq))
      lastEnd = at.index + at.length
    }
    if (lastEnd < content.length) {
      msgSegments.push(content.slice(lastEnd))
    }

    return { result: content, hasAt: true, msgSegments }
  }

  findMember(target, members) {
    if (/^\d+$/.test(target)) {
      const member = members.get(Number(target))
      if (member) return { qq: Number(target), info: member }
    }

    const search = target.toLowerCase()
    for (const [qq, info] of members) {
      if ([info.card, info.nickname].some(n => n?.toLowerCase().includes(search))) {
        return { qq, info }
      }
    }
    return null
  }

  processToolSpecificMessage(content, toolName) {
    let output = sanitizeFinalReplyText(content.replace(/\n/g, "\n"))

    // 模型有时会照抄上下文里的聊天记录前缀；这里只剥掉前缀，保留真正回复内容。
    output = stripChatLogSpeakerPrefixes(output)

    // 清理模式
    const patterns = [
      /$$图片$$/g,
      /[\s\S]在群里说[:：]\s/g,
      /\[(?:\d{4}-\d{2}-\d{2}\s+|\d{2}-\d{2}\s+)?\d{2}:\d{2}:\d{2}\]\s*.?[:：]\s/g,
      /[\s\S]*?/g
    ]

    for (const p of patterns) output = output.replace(p, "").trim()
    // 提取消息内容
    const match = /$$群身份: .+?$$[:：]\s*(.)/i.exec(output)
    if (match) output = match[1]
    output = output.replace(/^[说說][:：]\s/, "")

    output = ThinkingProcessor.removeThinking(output)
    output = output.replace(/!?$$(.*?)$$(.∗?)(.∗?)/g, "$1\n- $2")
    // 清理多余空行
    output = output.replace(/\n{3,}/g, '\n').trim()
    return sanitizeFinalReplyText(output)
  }

  /**
   * 初始化MCP服务器连接
   */
  async initMCP() {
    try {
      const configDir = path.join(process.cwd(), "plugins/bl-chat-plugin/config")
      const configDefaultDir = path.join(process.cwd(), "plugins/bl-chat-plugin/config_default")
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

    for (const [sessionId, session] of this.sessionMap) {
      session.tools = this.tools
    }

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
  async clearGroupMemory(e) {
    if (!e.group_id) {
      await this.sendObservedReply(e, "请在群聊中使用此命令")
      return true
    }

    try {
      const cleared = await this.memoryManager.clearGroupRedis(e.group_id)
      await this.sendObservedReply(e, `已清除本群记忆，共 ${cleared} 项存储键。`)
    } catch (error) {
      logger.error("[群记忆] 清除失败:", error)
      await this.sendObservedReply(e, "清除失败，请查看日志")
    }
    return true
  }

  /**
   * 重载MCP配置（管理员命令）
   */
  isGroupMemoryAdmin(e) {
    return Boolean(e.isMaster || ["owner", "admin"].includes(e.sender?.role))
  }

  formatMemoryTime(timestamp) {
    if (!timestamp) return "无"
    return new Date(timestamp).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
  }

  // authority → 中文来源（新模型权威分级 config>self>teaching>mention）
  memoryAuthoritySource(authority) {
    const map = { config: "配置", self: "本人说", teaching: "群里教", mention: "提及推断" }
    return map[authority] || "提及推断"
  }

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

  async memoryStatus(e) {
    try {
      const status = await this.memoryManager.adminStatus({
        groupId: e.group_id,
        userId: e.user_id
      })
      const user = status.user || {}
      const group = status.group || {}
      const config = status.config || {}
      const lines = [
        `记忆系统：${status.enabled ? "开启" : "关闭"}`,
        `我的记忆：${user.optedOut ? "已禁用" : "启用"}，事实 ${user.factCount || 0} 条，别名 ${user.aliasCount || 0} 条`,
        `群记忆：${group.disabled ? "已禁用" : "启用"}，实体 ${group.entityCount || 0} 个，群事实 ${group.factCount || 0} 条，别名 ${group.aliasCount || 0} 条，工作流 ${group.workflowCount || 0} 条，群知识 ${group.knowledgeCount || 0} 条`,
        `群上次抽取：${this.formatMemoryTime(group.lastExtractAt)}，连续失败 ${group.failureCount || 0} 次`,
        `保存严格度：${config.saveStrictness ?? "默认"}，语义召回：${config.semanticRecallEnabled ? "开启" : "关闭"}，主动回扣：${config.proactiveCallback ? "开启" : "关闭"}`,
        `上限：实体/群 ${config.maxEntitiesPerGroup ?? "-"}，事实/群 ${config.maxFactsPerGroup ?? "-"}`
      ]
      await this.sendObservedReply(e, lines.join("\n"))
    } catch (error) {
      logger.error("[记忆管理] 读取记忆状态失败:", error)
      await this.sendObservedReply(e, "记忆状态读取失败，请看日志")
    }
    return true
  }

  // P1-4：进程内调用计数/耗时统计（主人或群管理员可见）。重启归零。
  async memoryStats(e) {
    if (!this.isGroupMemoryAdmin(e)) {
      await this.sendObservedReply(e, "只有群主、管理员或主人可以查看记忆统计")
      return true
    }
    try {
      const { counters, timings } = memStats.snapshot()
      const num = key => Number(counters[key] || 0)

      const embedTotal = num("embed.hit") + num("embed.miss")
      const embedHitRate = embedTotal ? ((num("embed.hit") / embedTotal) * 100).toFixed(1) : "0.0"
      const extractFailRate = num("llm.extract.call")
        ? ((num("llm.extract.fail") / num("llm.extract.call")) * 100).toFixed(1)
        : "0.0"
      const reflectFailRate = num("llm.reflect.call")
        ? ((num("llm.reflect.fail") / num("llm.reflect.call")) * 100).toFixed(1)
        : "0.0"
      const avgMs = key => (timings[key]?.avgMs ? timings[key].avgMs.toFixed(0) : "0")

      const lines = [
        "记忆系统调用统计（进程内，重启归零）",
        `抽取(用户)：flush ${num("extract.user.flushed")} / buffer ${num("extract.user.buffered")} / opt-out ${num("extract.user.optedOut")}`,
        `抽取(群)：run ${num("extract.group.run")} / 节流 ${num("extract.group.throttled")} / 边界丢弃 ${num("extract.boundary.drop")}`,
        `LLM 抽取：调用 ${num("llm.extract.call")}，失败 ${num("llm.extract.fail")}（${extractFailRate}%），平均 ${avgMs("llm.extract.ms")}ms`,
        `LLM 反思：调用 ${num("llm.reflect.call")}，失败 ${num("llm.reflect.fail")}（${reflectFailRate}%），平均 ${avgMs("llm.reflect.ms")}ms`,
        `Embedding：命中 ${num("embed.hit")} / 未命中 ${num("embed.miss")}（命中率 ${embedHitRate}%），失败 ${num("embed.fail")}，平均 ${avgMs("embed.ms")}ms`
      ]
      await this.sendObservedReply(e, lines.join("\n"))
    } catch (error) {
      logger.error("[记忆管理] 读取记忆统计失败:", error)
      await this.sendObservedReply(e, "记忆统计读取失败，请看日志")
    }
    return true
  }

  async listMyMemory(e) {
    try {
      const result = await this.memoryManager.adminListMemories({
        scope: "user",
        groupId: e.group_id,
        userId: e.user_id,
        limit: 30
      })
      await this.replyMemoryForward(e, "我的记忆", [
        { title: "我的记忆", facts: result.facts }
      ])
    } catch (error) {
      logger.error("[记忆管理] 读取我的记忆失败:", error)
      await this.sendObservedReply(e, "读取我的记忆失败，请看日志")
    }
    return true
  }

  async listGroupMemory(e) {
    if (!e.group_id) {
      await this.sendObservedReply(e, "请在群聊中使用这个命令")
      return true
    }

    try {
      const result = await this.memoryManager.adminListMemories({
        scope: "group",
        groupId: e.group_id,
        limit: 30
      })
      await this.replyMemoryForward(e, "群记忆", [
        { title: "群记忆", facts: result.facts }
      ])
    } catch (error) {
      logger.error("[记忆管理] 读取群记忆失败:", error)
      await this.sendObservedReply(e, "读取群记忆失败，请看日志")
    }
    return true
  }

  async listGroupWorkflows(e) {
    if (!e.group_id) {
      await this.sendObservedReply(e, "请在群聊中使用这个命令")
      return true
    }
    try {
      const workflows = await this.memoryManager.getGroupWorkflowRules(e.group_id)
      if (!workflows.length) {
        await this.sendObservedReply(e, "本群还没有已教会的工作流。")
        return true
      }
      const lines = ["本群已教会的工作流："]
      for (const rule of workflows) {
        const targets = (rule.targets || []).map(item => `${item.displayName || item.userId}(QQ:${item.userId})`).join("、")
        lines.push(`[${rule.id}] ${rule.condition} -> 通知 ${targets}`)
      }
      await this.sendObservedReply(e, lines.join("\n"))
    } catch (error) {
      logger.error("[群工作流] 列表失败:", error)
      await this.sendObservedReply(e, "读取群工作流失败，请看日志")
    }
    return true
  }

  async deleteGroupWorkflow(e) {
    if (!e.group_id) {
      await this.sendObservedReply(e, "请在群聊中使用这个命令")
      return true
    }
    const id = String(e.msg || "").replace(/^#删除群工作流\s+/, "").trim()
    try {
      const workflows = await this.memoryManager.getGroupWorkflowRules(e.group_id)
      const rule = workflows.find(item => String(item?.id || "") === id)
      if (!rule) {
        await this.sendObservedReply(e, "没有找到这条群工作流。")
        return true
      }
      if (!this.isGroupMemoryAdmin(e) && String(rule.createdBy || "") !== String(e.user_id || "")) {
        await this.sendObservedReply(e, "只有创建者、群主、管理员或主人可以删除这条群工作流。")
        return true
      }
      const result = await this.memoryManager.adminDeleteGroupWorkflow({ groupId: e.group_id, id })
      await this.sendObservedReply(e, result.deleted ? "已删除这条群工作流。" : "删除失败：没有找到这条群工作流。")
    } catch (error) {
      logger.error("[群工作流] 删除失败:", error)
      await this.sendObservedReply(e, "删除群工作流失败，请看日志")
    }
    return true
  }

  async listGroupKnowledge(e) {
    if (!e.group_id) {
      await this.sendObservedReply(e, "请在群聊中使用这个命令")
      return true
    }
    try {
      const entries = await this.memoryManager.getGroupKnowledgeEntries(e.group_id)
      if (!entries.length) {
        await this.sendObservedReply(e, "本群还没有已教会的群知识。")
        return true
      }
      const lines = ["本群已教会的群知识："]
      for (const entry of entries) {
        if (entry.kind === "group_file") {
          lines.push(`[${entry.id}] ${entry.ownerQQ ? `QQ:${entry.ownerQQ} 的` : ""}${entry.subject} = 群文件「${entry.resource?.fileName || "未知"}」`)
        } else {
          const targets = (entry.targets || []).map(item => `${item.displayName || item.userId}(QQ:${item.userId})`).join("、")
          lines.push(`[${entry.id}] ${entry.subject} = ${targets}`)
        }
      }
      await this.sendObservedReply(e, lines.join("\n"))
    } catch (error) {
      logger.error("[群知识] 列表失败:", error)
      await this.sendObservedReply(e, "读取群知识失败，请看日志")
    }
    return true
  }

  async deleteGroupKnowledge(e) {
    if (!e.group_id) {
      await this.sendObservedReply(e, "请在群聊中使用这个命令")
      return true
    }
    const id = String(e.msg || "").replace(/^#删除群知识\s+/, "").trim()
    try {
      const entries = await this.memoryManager.getGroupKnowledgeEntries(e.group_id)
      const entry = entries.find(item => String(item?.id || "") === id)
      if (!entry) {
        await this.sendObservedReply(e, "没有找到这条群知识。")
        return true
      }
      if (!this.isGroupMemoryAdmin(e) && String(entry.createdBy || "") !== String(e.user_id || "")) {
        await this.sendObservedReply(e, "只有创建者、群主、管理员或主人可以删除这条群知识。")
        return true
      }
      const result = await this.memoryManager.adminDeleteGroupKnowledge({ groupId: e.group_id, id })
      await this.sendObservedReply(e, result.deleted ? "已删除这条群知识。" : "删除失败：没有找到这条群知识。")
    } catch (error) {
      logger.error("[群知识] 删除失败:", error)
      await this.sendObservedReply(e, "删除群知识失败，请看日志")
    }
    return true
  }

  async searchMemory(e) {
    const query = String(e.msg || "").replace(/^#搜索记忆\s+/, "").trim()
    if (!query) {
      await this.sendObservedReply(e, "请输入要搜索的关键词")
      return true
    }

    try {
      const myResult = await this.memoryManager.adminListMemories({
        scope: "user",
        groupId: e.group_id,
        userId: e.user_id,
        query,
        limit: 10
      })
      const groupResult = e.group_id
        ? await this.memoryManager.adminListMemories({
            scope: "group",
            groupId: e.group_id,
            query,
            limit: 10
          })
        : { facts: [] }
      await this.replyMemoryForward(e, "搜索记忆", [
        { title: "我的匹配记忆", facts: myResult.facts },
        { title: "群匹配记忆", facts: groupResult.facts }
      ])
    } catch (error) {
      logger.error("[记忆管理] 搜索记忆失败:", error)
      await this.sendObservedReply(e, "搜索记忆失败，请看日志")
    }
    return true
  }

  async deleteMemory(e) {
    const id = String(e.msg || "").replace(/^#删除记忆\s+/, "").trim()
    if (!id) {
      await this.sendObservedReply(e, "请输入要删除的记忆 id")
      return true
    }

    try {
      const result = await this.memoryManager.adminDeleteMemory({ groupId: e.group_id, userId: e.user_id, id })

      await this.sendObservedReply(e, result.deleted ? `已删除记忆 ${id}` : "没有找到可删除的记忆，普通用户只能删除自己的记忆")
    } catch (error) {
      logger.error("[记忆管理] 删除记忆失败:", error)
      await this.sendObservedReply(e, "删除记忆失败，请看日志")
    }
    return true
  }

  async clearMyMemory(e) {
    if (!e.group_id) {
      await this.sendObservedReply(e, "请在群聊中使用这个命令")
      return true
    }
    try {
      // P0-1：只删该用户自己的 entity（旧实现误调 adminClearMemories 会清整群）。
      const result = await this.memoryManager.clearUserMemory(e.group_id, e.user_id)
      await this.sendObservedReply(e, result?.cleared ? "已清空你在本群的记忆" : "你在本群没有可清空的记忆")
    } catch (error) {
      logger.error("[记忆管理] 清空我的记忆失败:", error)
      await this.sendObservedReply(e, "清空我的记忆失败，请看日志")
    }
    return true
  }

  async clearGroupMemory(e) {
    if (!e.group_id) {
      await this.sendObservedReply(e, "请在群聊中使用这个命令")
      return true
    }
    if (!this.isGroupMemoryAdmin(e)) {
      await this.sendObservedReply(e, "只有群主、管理员或主人可以清空群记忆")
      return true
    }

    // P0-1 二次确认：首次仅登记 pending（30s 过期），需再发一次同命令才真正清空。
    const pendingKey = `${e.group_id}_${e.user_id}`
    const now = Date.now()
    const expireAt = clearGroupMemoryPending.get(pendingKey)
    if (!expireAt || expireAt < now) {
      clearGroupMemoryPending.set(pendingKey, now + CLEAR_GROUP_MEMORY_CONFIRM_TTL_MS)
      await this.sendObservedReply(e, "这会清空整群的记忆且不可恢复。请在 30 秒内再发一次 #清空群记忆 确认。")
      return true
    }
    clearGroupMemoryPending.delete(pendingKey)

    try {
      const result = await this.memoryManager.adminClearMemories({
        groupId: e.group_id
      })
      await this.sendObservedReply(e, `已清空本群群记忆，共 ${result.cleared} 项存储键。`)
    } catch (error) {
      logger.error("[记忆管理] 清空群记忆失败:", error)
      await this.sendObservedReply(e, "清空群记忆失败，请看日志")
    }
    return true
  }

  async disableMyMemory(e) {
    if (!e.group_id) {
      await this.sendObservedReply(e, "请在群聊中使用这个命令")
      return true
    }
    try {
      // P0-2：按真实返回写文案。返回 {enabled:<是否仍在记>}，false 表示已退出记忆。
      const result = await this.memoryManager.adminSetUserMemoryEnabled({
        groupId: e.group_id,
        userId: e.user_id,
        enabled: false
      })
      await this.sendObservedReply(e, result?.enabled === false
        ? "已禁用你在本群的长期记忆，之后不再记录你的发言"
        : "操作未生效，你的记忆仍处于启用状态")
    } catch (error) {
      logger.error("[记忆管理] 禁用我的记忆失败:", error)
      await this.sendObservedReply(e, "禁用失败，请看日志")
    }
    return true
  }

  async enableMyMemory(e) {
    if (!e.group_id) {
      await this.sendObservedReply(e, "请在群聊中使用这个命令")
      return true
    }
    try {
      // P0-2：返回 {enabled:<是否仍在记>}，true 表示已重新启用记忆。
      const result = await this.memoryManager.adminSetUserMemoryEnabled({
        groupId: e.group_id,
        userId: e.user_id,
        enabled: true
      })
      await this.sendObservedReply(e, result?.enabled
        ? "已启用你在本群的长期记忆"
        : "操作未生效，你的记忆仍处于禁用状态")
    } catch (error) {
      logger.error("[记忆管理] 启用我的记忆失败:", error)
      await this.sendObservedReply(e, "启用失败，请看日志")
    }
    return true
  }

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
