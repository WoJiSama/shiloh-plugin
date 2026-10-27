// 伪工具文本清理族:从 apps/test.js 原样迁出。模型偶尔把工具调用写成
// [tool_code]/print(...)/JSON 片段,这组函数负责识别并剥出其中真正要发给用户的文本。
import { PSEUDO_TOOL_MARKER_SET, PSEUDO_TOOL_TEXT_KEYS, isPseudoToolMarker } from "./messageIntent.js"
import { ThinkingProcessor } from "../../models/domain/thinkingProcessor.js"
import { redactInternalStatusLeaks } from "./internalStatusLeak.js"

const CHAT_LOG_TIME_PREFIX_RE = /^[\[【]\s*(?:\d{4}-\d{2}-\d{2}\s+)?\d{1,2}:\d{2}(?::\d{2})?\s*[\]】]\s*/
const CHAT_LOG_SPEAKER_PREFIX_RE = /^.{1,80}?\((?:QQ号|qq号|QQ|qq)[:：]\s*\d{4,12}\)\s*(?:\[[^\]\n]{1,40}\]\s*)*[:：]\s*(?:在群里说[:：]\s*)?/i
const CHAT_LOG_SPEAKER_WITH_TIME_RE = /^(?:\d{4}-\d{2}-\d{2}\s+)?\d{1,2}:\d{2}(?::\d{2})?\s+.{1,80}?\((?:QQ号|qq号|QQ|qq)[:：]\s*\d{4,12}\)\s*(?:\[[^\]\n]{1,40}\]\s*)*[:：]\s*(?:在群里说[:：]\s*)?/i

/**
 * 工具参数形状识别（唯一权威实现；仿真侧 paramTolerance 由此再导出）：
 * 模型想要一个当前回合不存在的工具时，会把该工具的参数 JSON 当正文/聊天内容发出
 * （实测案例：sendLocalEmojiTool 的 tags/useCases/leadText/followUpText 整包外发）。
 * 命中词表 ≥2 键（或 ≥1 键且总键数 ≥3）判定为工具参数。
 */
const TOOL_ARG_VOCAB = new Set([
  'tags', 'useCases', 'leadText', 'followUpText', 'query', 'messages', 'purpose', 'quietMs', 'timeoutMs',
  'minNewMessages', 'minQuietAfterNewMs', 'throughSeq', 'action', 'kind', 'content', 'dueInMinutes', 'aboutUser',
  'id', 'delta', 'reason', 'userId', 'mode', 'sleepMinutes', 'keywords', 'speakerIds', 'probability', 'atMention',
  'nameMention', 'question', 'anyMessage', 'poke', 'replyToSeq', 'atUserIds', 'limit', 'afterSeq', 'offset', 'seq',
  'config', 'triggers', 'batchWindowMs', 'steps', 'images', 'prompt', 'replyToMessageId',
])

/**
 * AI 味短语黑名单（借鉴 qq-bridge 人格卡"出现即失败"词表，落到出站确定性过滤）：
 * 客服腔整句删除；句首论述标记（首先/其次/综上）剥掉标记保留正文。
 * persona.blacklist 的自定义词句同样整句删除（出站时由调用方合并传入）。
 */
const AI_FLAVOR_SENTENCE_RES: RegExp[] = [
  /(?:希望|希望这些)(?:这个)?(?:回答|内容|信息|整理)[^\n。！？!?]{0,12}(?:对你有帮助|对你有用|能帮到你|有所帮助)[。！？!?~～]*/g,
  /(?:还)?有(?:什么|任何)(?:可以|需要|随时)(?:帮(?:您|你)|帮忙|找我|吩咐)[。！？!?~～吗呀呢]*/g,
  /(?:作为)(?:一个)?(?:AI|人工智能|语言模型|助手)[，,。！？!?]?[^\n。！？!?]{0,30}[。！？!?]?/g,
  /这(?:真|是)?(?:个)?(?:好|不错的)问题[，,。！？!?][^\n。！？!?]{0,20}[。！？!?]?/g,
  /我(?:很)?理解(?:你|您)的(?:感受|心情)[，,。！？!?][^\n。！？!?]{0,20}[。！？!?]?/g,
  /(?:综上(?:所述)?|总而言之)[，,：:]?/g,
  /值得(?:注意的是|注意的是)[，,：:]/g,
  /(?:随时|欢迎)(?:找我|联系我|问我)[。！？!?~～]*/g,
]

const AI_FLAVOR_LINE_START_RES: RegExp[] = [
  // 行首或句末标点之后的论述标记（带分隔符才算，"最后一次机会"这类正常用语不受影响）
  /(?<=[。！？!?\n]|^)\s*(?:首先|其次|再次|最后|然后|接下来)[，,、：:]+/gm,
]

export function stripAIFlavorPhrases(text = "", extraPhrases: string[] = []): string {
  let output = String(text || "")
  for (const re of AI_FLAVOR_SENTENCE_RES) {
    re.lastIndex = 0
    output = output.replace(re, "")
  }
  for (const re of AI_FLAVOR_LINE_START_RES) {
    re.lastIndex = 0
    output = output.replace(re, "")
  }
  for (const phrase of extraPhrases) {
    const trimmed = String(phrase || "").trim()
    if (trimmed.length < 2) continue
    output = output.replace(new RegExp(escapeRegExpForFlavor(trimmed), 'g'), "")
  }
  return output.replace(/[ \t]*\n[ \t]*\n+/g, "\n").trim()
}

function escapeRegExpForFlavor(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function looksLikeToolArguments(text: string): boolean {
  const trimmed = String(text || '').trim()
  if (trimmed.length < 8 || !trimmed.startsWith('{') || !trimmed.endsWith('}')) return false
  let parsed: unknown
  try { parsed = JSON.parse(trimmed) } catch { return false }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false
  const keys = Object.keys(parsed as Record<string, unknown>)
  if (!keys.length || keys.length > 8) return false
  const hits = keys.filter(key => TOOL_ARG_VOCAB.has(key)).length
  return hits >= 2 || (hits >= 1 && keys.length >= 3)
}

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

export function extractReadableTextFromObject(input: unknown): string {
  const value = input && typeof input === "object" ? input as Record<string,unknown> : null
  if (!value || typeof value !== "object") return ""
  for (const key of PSEUDO_TOOL_TEXT_KEYS) {
    if (typeof value[key] === "string" && String(value[key]).trim()) return String(value[key]).trim()
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
  if (quotedOnly) return quotedOnly[1]!.trim()

  const textArg = rawArgs.match(/(?:^|[,{\s])(?:text|content|message|reply|spoken_text|speech|voice)\s*[:=]\s*["'`]([\s\S]*?)["'`](?:[,}\s]|$)/i)
  if (textArg) return textArg[1]!.trim()

  const jsonLike = rawArgs.match(/^\s*(\{[\s\S]*\}|\[[\s\S]*\])\s*$/)
  if (jsonLike) {
    try {
      const parsed = JSON.parse(jsonLike[1]!)
      return extractReadableTextFromObject(parsed)
    } catch {}
  }

  return ""
}

export function sanitizePseudoToolLine(line: unknown): string | null {
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
    const input: unknown = JSON.parse(current)
    const parsed = input && typeof input === "object" ? input as Record<string,unknown> : null
    const hasToolShape = parsed && typeof parsed === "object" &&
      (parsed.tool || parsed.tool_name || parsed.name || parsed.function || parsed.arguments || parsed.args)
    if (hasToolShape) {
      const readable = extractReadableTextFromObject(parsed)
      return readable ? sanitizePseudoToolLine(readable) : null
    }
  } catch {}

  const functionCall = current.match(/^([A-Za-z_][\w.-]{0,80})\s*\(([\s\S]*)\)$/)
  if (functionCall) {
    const functionName = functionCall[1]!
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
      (/=\s*["'[]/.test(functionCall[2]!) || /https?:\/\//.test(functionCall[2]!))

    if (looksLikeToolCall) {
      const readable = extractReadableTextFromPseudoCall(functionCall[2]!)
      return readable ? sanitizePseudoToolLine(readable) : null
    }
  }

  return rawLine
}

// 字面 \n 展开是为模型把换行写成 "\n" 文本兜底的;
// 但 \nabla、\neq、\nu 这类以 n 开头的 LaTeX 命令会被劈成换行+残词。
// 数学片段先整体摘出,展开时再跳过后跟 ASCII 字母的 \n(命令形态)。
function expandLiteralNewlines(text: string) {
  const masked: string[] = []
  const stashSegment = (whole: string) => {
    masked.push(whole)
    return `\ue004${masked.length - 1}\ue005`
  }
  let out = text
    .replace(/\\\[([\s\S]+?)\\\]/g, stashSegment)
    .replace(/\$\$([\s\S]+?)\$\$/g, stashSegment)
    .replace(/\\\(([\s\S]+?)\\\)/g, stashSegment)
  out = out.replace(/\\n(?![a-zA-Z])/g, "\n")
  out = out.replace(/(?<!\w)\/n(?!\w)/g, "\n")
  if (masked.length) out = out.replace(/\ue004(\d+)\ue005/g, (_:string, index:string) => masked[Number(index)] ?? "")
  return out
}

export function sanitizeFinalReplyText(content: unknown, options: { aiFlavorPhrases?: string[] } = {}) {
  let output = String(content || "").replace(/\r\n/g, "\n")
  output = expandLiteralNewlines(output).trim()
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
    // 整行是工具参数形状 JSON（模型把不存在工具的调用参数当正文）→ 丢弃该行；
    // 整条回复只有这一行时结果为空，调用方按"无可发送内容"自然跳过。
    if (looksLikeToolArguments(cleaned)) continue
    const stripped = stripChatLogSpeakerPrefix(cleaned)
    if (!String(stripped).trim()) {
      if (!previousWasBlank) sanitizedLines.push("")
      previousWasBlank = true
      continue
    }
    sanitizedLines.push(stripped)
    previousWasBlank = false
  }

  // 内部状态与凭据形状脱敏（与 finalReply 同源；在所有回复路径的统一出口执行，幂等）
  const redacted = redactInternalStatusLeaks(sanitizedLines.join("\n").replace(/\n{3,}/g, "\n").trim())
  // AI 味黑名单（默认词表 + persona.blacklist）：确定性出站过滤
  const deFlavored = redacted.text ? stripAIFlavorPhrases(redacted.text, options.aiFlavorPhrases || []) : redacted.text
  return polishHumanReplyText(deFlavored)
}
