// 内部状态泄漏检测(Redesign v2)
//
// 设计原则:
// 1. 只认"结构",不认"词"。正常讨论可以出现"工具调用/函数调用/API/超时/HTTP 502",
//    这些词在任何技术群里都是日常词汇;真正泄漏的是具有内部结构的东西:
//    工具协议 JSON、堆栈、内部日志行格式、网络错误码、内部路径/键名、工具调用语法。
// 2. 片段脱敏,不整段判死刑。命中只删对应片段,保住其余正常内容;
//    只有当脱敏占比过高(>30%)或剩余内容残破时才回退到安全话术。
// 3. "我去查一下"这类拟人化叙述不是泄漏(人设本来就鼓励),交给提示词约束,
//    不在硬过滤器里管。

const STRUCTURAL_PATTERNS = [
  // JS 堆栈帧: at someFunc (file:///...:12:34)
  { kind: "stack", re: /(?:^|\n)[ \t]*at [\w$./<>-]+ ?\(?[^\n]*:\d+:\d+\)?/g },
  // 错误对象原样文本: TypeError: xxx / DOMException [...] : xxx
  { kind: "error_text", re: /\b(?:TypeError|ReferenceError|SyntaxError|DOMException|AssertionError)(?:\[[^\]]{0,40}\])?:\s[^\n]{8,}/g },
  // 网络层错误码(不可能出现在正常回答里的系统级 token)
  { kind: "net_errno", re: /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNABORTED|ERR_INVALID_URL)\b/g },
  // 工具协议 JSON 片段(按内部字段名识别)
  { kind: "protocol_json", re: /\{[^{}]{0,240}"(?:kind|tool_outcome|tool_result|tool_calls|retcode|message_id)"\s*:[^{}]{0,240}\}?/g },
  // 内部日志行的方括号标签
  { kind: "log_tag", re: /\[(?:Smart(?:Skip|Queue|Lock|State)|GroupModeration|MessagePipeline|MediaOutbox|MediaTiming|TimingGate|失败诊断|工具插件|骰规则|回复失败|对话耗时|模型耗时)\]/g },
  // 内部日志键值对: stage=initial group=821466122 elapsed=12000ms
  { kind: "log_kv", re: /\b(?:stage|elapsed|merged|toolChoice|retcode)=[\w.:/+-]+|\bgroup=\d{5,}\b|\buser=\d{5,}\b/g },
  // 内部路径与存储键
  { kind: "internal_path", re: /(?:\/opt\/trss-yunzai|plugins\/bl-chat-plugin|ytbot:[\w:-]*|file:\/\/\/\S{3,})/g },
  // 工具调用语法
  { kind: "tool_syntax", re: /\[(?:tool(?:_code)?)\]|<tool(?:_code)?>|\btool_call|\bfunction_call/gi },
  // 本插件工具名 + 调用括号(裸提工具名不算,带调用形式才算)
  { kind: "tool_invoke", re: /\b(?:banana|googleImageAnalysis|googleImageEdit|textImage|sendLocalEmoji|searchInformation|webParser|deltaForce|torrentDownload|mentionAdmins|mentionMembers|forgetGroupKnowledge|excelWorkbook)Tool\s*\(/gi }
]

const HEAVY_RATIO = 0.3

function collectMatches(text) {
  const matches = []
  for (const { kind, re } of STRUCTURAL_PATTERNS) {
    re.lastIndex = 0
    let hit
    while ((hit = re.exec(text)) !== null) {
      matches.push({ start: hit.index, end: hit.index + hit[0].length, kind })
      if (hit[0].length === 0) re.lastIndex++
    }
  }
  return matches.sort((a, b) => a.start - b.start || b.end - a.end)
}

function mergeMatches(matches) {
  const merged = []
  for (const match of matches) {
    const last = merged[merged.length - 1]
    if (last && match.start <= last.end) {
      last.end = Math.max(last.end, match.end)
      if (!last.kinds.includes(match.kind)) last.kinds.push(match.kind)
    } else {
      merged.push({ start: match.start, end: match.end, kinds: [match.kind] })
    }
  }
  return merged
}

/**
 * 结构化检测:返回所有内部信息片段。
 */
export function detectInternalStatusLeaks(text = "") {
  const content = String(text || "")
  if (!content.trim()) return []
  return mergeMatches(collectMatches(content))
}

export function containsInternalStatusLeak(text = "") {
  return detectInternalStatusLeaks(text).length > 0
}

/**
 * 片段脱敏:移除命中的内部片段(不整段替换)。
 * 占比过高或剩余残破时标记 heavy,由调用方决定是否回退安全话术。
 */
export function redactInternalStatusLeaks(text = "", { heavyRatio = HEAVY_RATIO } = {}) {
  const content = String(text || "")
  const leaks = detectInternalStatusLeaks(content)
  if (!leaks.length) return { text: content, redactedChars: 0, ratio: 0, heavy: false, kinds: [] }

  let cleaned = ""
  let cursor = 0
  for (const span of leaks) {
    cleaned += content.slice(cursor, span.start)
    cursor = span.end
  }
  cleaned += content.slice(cursor)
  cleaned = cleaned
    .replace(/[ \t]*\n(?:[ \t]*\n)+/g, "\n\n")
    .replace(/^[ \t]*[#、•\-\d.、)（(]\s*$|[，。,；;：:]\s*$/gm, "")
    .trim()

  const redactedChars = Math.max(0, content.length - cleaned.length)
  const ratio = redactedChars / Math.max(1, content.length)
  const kinds = [...new Set(leaks.flatMap(leak => leak.kinds))]
  const heavy = ratio > heavyRatio || cleaned.replace(/\s/g, "").length < 6
  return { text: cleaned, redactedChars, ratio, heavy, kinds }
}
