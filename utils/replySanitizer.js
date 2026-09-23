// 伪工具文本清理族:从 apps/test.js 原样迁出。模型偶尔把工具调用写成
// [tool_code]/print(...)/JSON 片段,这组函数负责识别并剥出其中真正要发给用户的文本。
import { PSEUDO_TOOL_MARKER_SET, PSEUDO_TOOL_TEXT_KEYS, isPseudoToolMarker } from "../core/intent/messageIntent.js"
import { ThinkingProcessor } from "./providers/ThinkingProcessor.js"

const CHAT_LOG_TIME_PREFIX_RE = /^[\[【]\s*(?:\d{4}-\d{2}-\d{2}\s+)?\d{1,2}:\d{2}(?::\d{2})?\s*[\]】]\s*/
const CHAT_LOG_SPEAKER_PREFIX_RE = /^.{1,80}?\((?:QQ号|qq号|QQ|qq)[:：]\s*\d{4,12}\)\s*(?:\[[^\]\n]{1,40}\]\s*)*[:：]\s*(?:在群里说[:：]\s*)?/i
const CHAT_LOG_SPEAKER_WITH_TIME_RE = /^(?:\d{4}-\d{2}-\d{2}\s+)?\d{1,2}:\d{2}(?::\d{2})?\s+.{1,80}?\((?:QQ号|qq号|QQ|qq)[:：]\s*\d{4,12}\)\s*(?:\[[^\]\n]{1,40}\]\s*)*[:：]\s*(?:在群里说[:：]\s*)?/i

export function stripChatLogSpeakerPrefix(text = "") {
  let output = String(text || "").trim()
  if (!output) return ""

  for (let i = 0; i < 3; i++) {
    const before = output
    output = output.replace(CHAT_LOG_TIME_PREFIX_RE, "")
    output = output.replace(CHAT_LOG_SPEAKER_PREFIX_RE, "")
    output = output.replace(CHAT_LOG_SPEAKER_WITH_TIME_RE, "")
    output = output.trim()
    if (output === before) break
  }

  return output
}

export function stripChatLogSpeakerPrefixes(text = "") {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map(line => stripChatLogSpeakerPrefix(line))
    .join("\n")
}

// 从 apps/test.js 原样迁出:模型回复的拟人化润色(去舞台指示、去自我审稿收尾)。
export function polishHumanReplyText(text = "") {
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


export function stripCqMarkup(text = "") {
  return String(text || "")
    .replace(/\[CQ:[^\]]+\]/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim()
}

export function extractReadableTextFromObject(value) {
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

export function extractReadableTextFromPseudoCall(args = "") {
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

export function sanitizePseudoToolLine(line) {
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
      isPseudoToolMarker(functionName) ||
      // 名单外的真实工具形态（analyzeImageByUrl(image_urls=[...])、getBilibiliVideoSummary(bvid="...")），
      // 按参数形态拦：键值参数(=后接引号/数组)或 URL——正常人话里不会出现这种括号内容
      (/=\s*["'[]/.test(functionCall[2]) || /https?:\/\//.test(functionCall[2]))

    if (looksLikeToolCall) {
      const readable = extractReadableTextFromPseudoCall(functionCall[2])
      return readable ? sanitizePseudoToolLine(readable) : null
    }
  }

  return rawLine
}

export function sanitizeFinalReplyText(content) {
  let output = String(content || "").replace(/\r\n/g, "\n")
  if (output.includes("\\n")) output = output.split("\\n").join("\n")
  output = output.replace(/(?<!\w)\/n(?!\w)/g, "\n").trim()
  if (!output) return ""

  output = ThinkingProcessor.removeThinking(output).trim()
  // 模型把工具调用写成正文的泄漏（grok/glm 系的 <tool_call> 块与特殊 token）：整块剥离
  output = output.replace(/<tool[_\s]?call>[\s\S]*?<\/tool[_\s]?call>/gi, "\n")
  output = output.replace(/<\/?tool[_\s]?call>/gi, "\n")
  output = output.replace(/<\|[a-z_]+\|>/gi, "\n")
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
