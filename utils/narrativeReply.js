function compact(value = "") {
  return String(value || "").replace(/\r\n/g, "\n").trim()
}

export function isNarrativeWritingRequest(text = "") {
  const source = compact(text)
  if (!source) return false
  return /(?:写|创作|编|续写|生成|来).{0,16}(?:小说|故事|短篇|校园(?:爱情)?|同人|剧情|文章)|(?:小说|故事|短篇|校园(?:爱情)?|同人|剧情).{0,16}(?:写|创作|来一|生成)/u.test(source)
}

function isNarrativeStart(line = "") {
  const value = String(line || "").trim().replace(/^＃/u, "#")
  return /^#{1,3}\s*\S/u.test(value) ||
    /^《[^》\n]{2,80}》\s*$/u.test(value) ||
    /^(?:正文|故事正文|小说正文)\s*[:：]?\s*$/u.test(value)
}

function normalizeNarrativeHeading(line = "") {
  const value = String(line || "").trim().replace(/^＃/u, "#")
  const match = value.match(/^(#{1,3})\s*(\S.*)$/u)
  return match ? `${match[1]} ${match[2]}` : value
}

function splitInlineNarrativeTitle(source = "") {
  // Some models put a transition dash, Markdown title and first story sentence
  // on one line: "好呀——#《标题》黄昏时分...". The presentation boundary must
  // still be deterministic even when the model ignores the formatting prompt.
  const value = String(source)
  const patterns = [
    /(^|[\n—–-])\s*#\s*(《[^》\n]{2,80}》)/u,
    /(^|[\n—–。！？”"）)])\s*[#＃]\s*([^\s#＃]{2,20})\s+/u
  ]
  const match = patterns.map(pattern => value.match(pattern)).find(Boolean)
  if (!match || !match[2] || match.index === undefined || match.index <= 0) return null

  const markerStart = match.index + match[1].length
  const lead = value.slice(0, markerStart).replace(/[\s—–-]+$/u, "").trim()
  const remaining = value.slice(match.index + match[0].length).trim()
  if (!lead || lead.length > 360 || remaining.length < 120) return null
  return {
    lead,
    story: `# ${match[2]}\n\n${remaining}`
  }
}

/**
 * A short conversational lead belongs in the chat stream. The titled story is
 * a separate document artifact so it keeps its reading rhythm and can be
 * referenced independently later.
 */
export function splitNarrativeReply(text = "", userText = "") {
  const source = compact(text)
  if (!isNarrativeWritingRequest(userText) || source.length < 180) {
    return { lead: "", story: source }
  }

  const lines = source.split("\n")
  const startIndex = lines.findIndex(isNarrativeStart)
  if (startIndex <= 0) return splitInlineNarrativeTitle(source) || { lead: "", story: source }

  const lead = lines.slice(0, startIndex).join("\n").trim()
  const storyLines = lines.slice(startIndex)
  storyLines[0] = normalizeNarrativeHeading(storyLines[0])
  const story = storyLines.join("\n").trim()
  // Do not discard genuine content merely because a model put a chapter title
  // far down its response. A lead is only a compact, chat-sized preface.
  if (!lead || lead.length > 360 || story.length < 160) return { lead: "", story: source }
  return { lead, story }
}
