import { isExplicitToolIntent, isExplicitSearchRequest, isRealtimeInfoRequest } from "../core/intent/messageIntent.js"
import { isCasualChatTurn } from "./turnPlan.js"

/**
 * 意图模型快路：对「零工具信号 + 无图无视频 + 短句闲聊」的消息跳过意图分类，
 * 闲聊回合从 2 次模型调用降到 1 次。
 *
 * 跳过有代价（可能漏掉只有模型能看出的隐式意图），因此条件从严：
 * 任何一个显式工具/搜索/实时信息信号、素材或工具候选都会放行分类。
 * 调用方必须按比例抽样跑影子意图（shouldSampleSkippedIntent），
 * 用 [意图影子](fast_path) 分歧日志持续验证跳过规则的漏判率。
 */
// isCasualChatTurn 之外的快路专属排除：时间/天气/新闻等事实型短问句，
// 意图分类器可能把它们路由到搜索，不能因为"句子短"就跳过
const FAST_PATH_BLOCKED_PATTERN = /(几点|时间|日期|星期|礼拜|天气|新闻|热搜|比分|汇率|股价|价格|今天几号|多少号)/

export function shouldSkipIntentModel({ text = "", hasImages = false, hasVideos = false, toolCandidates = [] } = {}) {
  const content = String(text || "").trim()
  if (!content) return false
  if (hasImages || hasVideos) return false
  if (Array.isArray(toolCandidates) && toolCandidates.length > 0) return false
  if (isExplicitToolIntent(content) || isExplicitSearchRequest(content) || isRealtimeInfoRequest(content)) return false
  if (FAST_PATH_BLOCKED_PATTERN.test(content)) return false
  return isCasualChatTurn(content)
}

/** 被跳过的消息按比例抽样做影子验证，默认 10% */
export function shouldSampleSkippedIntent(rate = 0.1) {
  const value = Math.max(0, Math.min(1, Number(rate) || 0))
  return Math.random() < value
}
