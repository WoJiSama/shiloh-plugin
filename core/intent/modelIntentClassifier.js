import { resolveChatCompletionUrl } from "../../utils/chatCompletionUrl.js"

// P4 意图层核心：全模型意图判定（主人拍板的方向）。
// 正则瀑布降级为精确命令直配 + 模型故障兜底；本模块是模型判定的唯一实现，
// 先以影子模式并行运行采集一致性数据，切换后成为主判定。

export const MODEL_INTENT_LABELS = [
  "chat",              // 普通闲聊/对话，不需要工具
  "image_generate",    // 画图/生成图片
  "image_edit",        // 修改/编辑已有图片
  "image_analysis",    // 识图/分析图片内容
  "search",            // 联网搜索/实时信息
  "dice",              // 骰子/规则包命令
  "deltaforce",        // 三角洲查询
  "magnet",            // 磁链搜索/下载
  "music",             // 音乐提取/搬运
  "memory_command",    // 记忆/表达学习管理命令（#记忆状态 等）
  "emoji",             // 表情包请求
  "group_admin",       // 群管理操作（禁言/公告/名片等）
  "other_tool",        // 其他明确需要工具的任务
  "noise"              // 纯表情包刷屏/无意义内容，机器人不必认真回应
]

const SYSTEM_PROMPT = [
  "你是聊天机器人的意图分类器。判断群聊消息希望机器人做什么，只输出严格 JSON。",
  `intent 必须是以下之一：${MODEL_INTENT_LABELS.join(" | ")}`,
  "分类要点：",
  "- 提到画/绘制/生成/捏某个图像内容（无论句中有没有「图」字）→ image_generate",
  "- 引用或附带已有图片并要求修改/P图/换背景 → image_edit",
  "- 问图片里是什么/真假/识别 → image_analysis",
  "- 问最新/今天/价格/新闻/版本等需要联网的事实 → search",
  "- 以 . 开头的骰子句式或规则包命令 → dice",
  "- 记忆管理命令（#记忆/#表达学习等）→ memory_command",
  "- 明确的游戏数据查询（三角洲等）→ deltaforce",
  "- 磁力/磁链 → magnet",
  "- 情绪化短语、表情包刷屏、与机器人无关的闲聊 → chat 或 noise",
  "输出格式：{\"intent\":\"...\",\"confidence\":0.0-1.0,\"reason\":\"不超过20字的依据\"}",
  "没有把握时给 chat 并降低 confidence。"
].join("\n")

/** 影子统计：并行对比期间记录正则路径与模型判定的一致性 */
const shadowStats = {
  startedAt: 0,
  total: 0,
  unavailable: 0,
  agree: 0,
  disagreementSamples: [],
  intentCounts: Object.create(null)
}

export function getShadowStats() {
  return {
    ...shadowStats,
    agreeRate: shadowStats.total ? shadowStats.agree / shadowStats.total : 0,
    intentCounts: { ...shadowStats.intentCounts }
  }
}

export function recordShadowComparison({ text = "", regexIntent = "", modelIntent = "", confidence = 0 } = {}) {
  shadowStats.startedAt ||= Date.now()
  shadowStats.total += 1
  if (modelIntent === "unavailable") {
    shadowStats.unavailable += 1
    return
  }
  const model = MODEL_INTENT_LABELS.includes(modelIntent) ? modelIntent : "chat"
  shadowStats.intentCounts[model] = (shadowStats.intentCounts[model] || 0) + 1
  const regex = String(regexIntent || "chat")
  const equivalent = areIntentsEquivalent(regex, model)
  if (equivalent) {
    shadowStats.agree += 1
    return
  }
  shadowStats.disagreementSamples.push({
    at: new Date().toISOString().slice(11, 19),
    text: String(text).slice(0, 60),
    regex,
    model,
    confidence
  })
  if (shadowStats.disagreementSamples.length > 50) shadowStats.disagreementSamples.shift()
}

/** 正则路径的粗粒度意图与模型意图的等价性判断 */
export function areIntentsEquivalent(regexIntent = "", modelIntent = "") {
  const regex = String(regexIntent || "chat")
  const model = String(modelIntent || "chat")
  if (regex === model) return true
  const groups = [
    ["chat", "noise", "emoji"],
    ["image_generate", "image_edit"],
    ["memory_command", "group_admin"]
  ]
  return groups.some(group => group.includes(regex) && group.includes(model))
}

/**
 * 模型意图判定。失败/超时返回 { intent: "unavailable", confidence: 0 }，
 * 调用方据此走正则兜底——模型挂了不影响现有行为。
 */
export async function classifyIntentWithModel({
  text = "",
  hasImages = false,
  config = {},
  fetchImpl = globalThis.fetch,
  timeoutMs = 6000,
  now = Date.now
} = {}) {
  const content = String(text || "").trim()
  if (!content) return { intent: "noise", confidence: 1, reason: "空消息" }

  // 分类需要低延迟：优先独立的 intentAiConfig（可指向快速模型），回落 tools 模型
  const ai = config?.intentAiConfig?.intentAiUrl ? config.intentAiConfig : config?.toolsAiConfig || {}
  const rawUrl = ai.intentAiUrl || ai.toolsAiUrl || ""
  const rawKey = ai.intentAiApikey || ai.toolsAiApikey || ""
  const rawModel = ai.intentAiModel || ai.toolsAiModel || ""
  const endpoint = resolveChatCompletionUrl(rawUrl)
  const apiKey = Array.isArray(rawKey) ? rawKey[0] : rawKey
  if (!endpoint || !apiKey || String(apiKey).includes("sk-xxx")) {
    return { intent: "unavailable", confidence: 0, reason: "意图模型未配置" }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: rawModel || "gpt-4o-mini",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify({ message: content.slice(0, 600), hasImages }) }
        ],
        temperature: 0,
        // 思考型模型（如 deepseek flash）会先输出推理过程，额度太小会导致正文为空
        max_tokens: 800,
        response_format: { type: "json_object" }
      }),
      signal: controller.signal
    })
    if (!response.ok) return { intent: "unavailable", confidence: 0, reason: `HTTP ${response.status}` }
    const data = await response.json()
    const raw = String(data?.choices?.[0]?.message?.content || "").trim()
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) return { intent: "unavailable", confidence: 0, reason: "无 JSON 输出" }
    const parsed = JSON.parse(match[0])
    const intent = MODEL_INTENT_LABELS.includes(parsed.intent) ? parsed.intent : "chat"
    return {
      intent,
      confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0)),
      reason: String(parsed.reason || "").slice(0, 40)
    }
  } catch (error) {
    const aborted = error?.name === "AbortError" || /abort/i.test(String(error?.message || ""))
    return { intent: "unavailable", confidence: 0, reason: aborted ? `超时>${timeoutMs / 1000 | 0}s` : String(error?.message || error).slice(0, 60) }
  } finally {
    clearTimeout(timer)
  }
}
