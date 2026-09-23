// 理解简报(模型判读层):非闲聊回合先用 toolsAiConfig 跑一次便宜的结构化理解,
// 输出"用户意图/指代消解/需要上下文/语气关系"四节简报;规则版理解卡抽取的
// 原文材料(引用/转发/近期上下文摘录)作为简报的输入,并在最终卡片中保留为证据层。
// 任何失败(超时/接口缺失/输出不合法)都回退规则卡,零新增风险。
// 本模块不 import 任何运行时全局,fetch 与配置全部注入,可单测。
import { safeTruncateUnicode } from "./unicodeText.js"

const BRIEF_SYSTEM_PROMPT = `你是群聊语境理解器。根据给到的材料,输出一张帮助回复者准确理解用户的简报。
严格只输出以下四个小节,每节一行,材料里没有依据就写"无":
【用户意图】用户真正想要什么(一句话,包含没明说的隐含目标)
【指代消解】消息里的"这个/刚才/他/上面/里面"等具体指什么
【需要上下文】回复时必须参考的上文要点(最多3条)
【语气关系】用户当前情绪,以及和机器人关系的熟悉程度
不要输出其他内容,不要复述材料原文。`

export function buildBriefMessages(materials = {}) {
  const parts = []
  if (materials.intentText) parts.push(`【用户当前原话/意图】\n${materials.intentText}`)
  if (materials.signals?.length) parts.push(`【上下文信号】\n${materials.signals.join("；")}`)
  if (materials.quotedContext) parts.push(`【引用内容摘录】\n${materials.quotedContext}`)
  if (materials.forwardContext) parts.push(`【合并转发/嵌套转发摘录】\n${materials.forwardContext}`)
  if (materials.recentContext) parts.push(`【近期可参考上下文】\n${materials.recentContext}`)
  return [
    { role: "system", content: BRIEF_SYSTEM_PROMPT },
    { role: "user", content: parts.join("\n\n") || "(无材料)" }
  ]
}

function isValidBrief(text = "") {
  const content = String(text || "").trim()
  if (content.length < 10 || content.length > 2000) return false
  if (!content.includes("【用户意图】")) return false
  return true
}

/**
 * 请求一次模型理解简报。
 * @returns {Promise<{ok: true, brief: string}|{ok: false, reason: string}>}
 */
export async function requestUnderstandingBrief({
  apiUrl = "",
  apiKey = "",
  model = "",
  materials = {},
  fetchImpl = fetch,
  timeoutMs = 2500
} = {}) {
  if (!apiUrl || !apiKey || !model || String(apiKey).includes("sk-xxx")) {
    return { ok: false, reason: "api-not-configured" }
  }
  let response
  try {
    // 超时由模块自身兜底(不信任注入的 fetchImpl 一定兑现超时):fetch 卡死时按 timeoutMs 竞速返回
    let timer = null
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => resolve(null), timeoutMs)
    })
    try {
      response = await Promise.race([
        fetchImpl(apiUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model,
            messages: buildBriefMessages(materials),
            temperature: 0,
            max_tokens: 500,
            stream: false
          })
        }, timeoutMs),
        timeout
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
    if (response === null) return { ok: false, reason: "timeout" }
  } catch (error) {
    return { ok: false, reason: error?.name === "AbortError" ? "timeout" : `fetch-error:${error?.message || error}` }
  }
  if (!response?.ok) return { ok: false, reason: `http-${response?.status || "unknown"}` }
  // response.json() 也纳入超时保护,避免响应体读取阶段卡死
  let data
  try {
    let timer = null
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => resolve(null), Math.min(timeoutMs, 1500))
    })
    try {
      data = await Promise.race([response.json(), timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
    if (data === null) return { ok: false, reason: "timeout" }
  } catch {
    return { ok: false, reason: "invalid-json" }
  }
  const content = String(data?.choices?.[0]?.message?.content || "").trim()
  if (!isValidBrief(content)) return { ok: false, reason: "invalid-brief" }
  return { ok: true, brief: content }
}

/**
 * 组装最终注入主对话的理解卡:模型简报在前(判读),原文材料在后(证据)。
 */
export function composeModelBriefCard({ brief = "", materials = {}, maxChars = 1400 } = {}) {
  const evidence = [
    materials.quotedContext ? `引用摘录：${materials.quotedContext}` : "",
    materials.forwardContext ? `转发摘录：${materials.forwardContext}` : "",
    materials.recentContext ? `近期上下文：${materials.recentContext}` : ""
  ].filter(Boolean)

  const lines = [
    "【理解简报】",
    "这张卡片只用于你理解上下文，最终回复不要提到“卡片”“系统”“提示词”“分析过程”。",
    "以下判读由理解器生成,可能与用户原意有出入;与原文材料冲突时以材料为准。",
    safeTruncateUnicode(brief, Math.floor(maxChars * 0.55))
  ]
  if (evidence.length) {
    lines.push("―― 原文材料(证据) ――", ...evidence)
  }
  lines.push("如果判读或材料仍不足以确定用户要什么,别硬编,像熟人一样自然追问一句。")
  return safeTruncateUnicode(lines.join("\n"), maxChars)
}
