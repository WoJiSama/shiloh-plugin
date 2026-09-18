import { safeTruncateUnicode } from "./unicodeText.js"

function compact(value = "") {
  return String(value || "").replace(/[ \t]+/g, " ").trim()
}

function codePointLength(value = "") {
  return Array.from(String(value || "")).length
}

function looksStructuredOrFormal(text = "", userText = "") {
  const source = `${userText}\n${text}`
  return /```|^\s*(?:[-*+] |\d+[.)、] )|\|.+\||(?:报错|代码|接口|配置|日志|服务器|数据库|部署|测试|公式|合同|医疗|法律|财务|总结报告|工作汇报)/im.test(source)
}

function isCompleteBeat(text = "") {
  const value = compact(text)
  if (!value) return false
  if (/[，,、：:；;（(]$/.test(value)) return false
  return /[。！？!?…~～]$/.test(value) || codePointLength(value) <= 14
}

function splitSentences(text = "") {
  return (String(text || "").match(/[^。！？!?…～~]+[。！？!?…～~]*/g) || [])
    .map(compact)
    .filter(Boolean)
}

// 单段多句的闲聊式回复按句拆条：人不会把两三句完整的话憋成一条消息。
// 只对无结构、每句都完整收尾、总量不长的内容生效，避免把正式回答拆碎。
function planSentenceBeat(raw, options = {}, maxMessages = 2) {
  if (looksStructuredOrFormal(raw, options.userText)) return null
  const sentences = splitSentences(raw)
  if (sentences.length < 2 || sentences.length > Math.min(3, maxMessages)) return null
  const perSentenceMax = Math.max(20, Number(options.sentenceMaxChars) || 70)
  const totalMax = Math.max(80, Number(options.sentenceTotalMaxChars) || 220)
  if (codePointLength(sentences.join("")) > totalMax) return null
  if (sentences.some(part => codePointLength(part) > perSentenceMax || !isCompleteBeat(part))) return null
  return sentences
}

export function planTextReplyMessages(text = "", options = {}) {
  const raw = String(text || "").trim()
  if (!raw) return { mode: "empty", messages: [] }
  const enabled = options.enabled !== false
  const maxMessages = Math.max(1, Math.min(3, Number(options.maxTextMessages) || 2))
  if (!enabled || maxMessages < 2) return { mode: "single", messages: [raw] }

  const paragraphs = raw.split(/\n{2,}/).map(compact).filter(Boolean)
  if (paragraphs.length === 2) {
    const [lead, follow] = paragraphs
    const leadLimit = Math.max(12, Number(options.naturalLeadMaxChars) || 42)
    const followLimit = Math.max(30, Number(options.naturalFollowMaxChars) || 130)
    const totalLimit = Math.max(60, Number(options.naturalTotalMaxChars) || 170)
    const natural = codePointLength(lead) <= leadLimit &&
      codePointLength(follow) <= followLimit &&
      codePointLength(`${lead}${follow}`) <= totalLimit &&
      isCompleteBeat(lead) &&
      isCompleteBeat(follow) &&
      !looksStructuredOrFormal(raw, options.userText)

    if (natural) return { mode: "two_beat", messages: [lead, follow] }
  }
  const sentenceBeat = planSentenceBeat(raw, options, maxMessages)
  if (sentenceBeat) return { mode: "sentence_beat", messages: sentenceBeat }
  return { mode: "single", messages: [raw] }
}

function normalizeForComparison(text = "") {
  return compact(text).toLowerCase().replace(/[\s，,。.!！?？~～…]/g, "")
}

function isDuplicateText(left = "", right = "") {
  const a = normalizeForComparison(left)
  const b = normalizeForComparison(right)
  if (!a || !b) return false
  return a === b || (Math.min(a.length, b.length) >= 6 && (a.includes(b) || b.includes(a)))
}

export function planEmojiReplySequence(input = {}, options = {}) {
  const maxTextChars = Math.max(20, Number(options.maxEmojiTextChars) || 80)
  const maxMessages = Math.max(1, Math.min(3, Number(options.maxEmojiReplyMessages) || 3))
  let leadText = compact(safeTruncateUnicode(input.leadText || "", maxTextChars))
  let followUpText = compact(safeTruncateUnicode(input.followUpText || "", maxTextChars))
  if (isDuplicateText(leadText, followUpText)) followUpText = ""
  if (leadText && followUpText && (options.allowThreePartEmojiReply === false || maxMessages < 3)) {
    followUpText = ""
  }

  const sequence = []
  if (leadText && maxMessages >= 2) sequence.push({ type: "text", text: leadText })
  sequence.push({ type: "emoji" })
  if (followUpText && sequence.length < maxMessages) sequence.push({ type: "text", text: followUpText })

  const layout = sequence.map(item => item.type === "emoji" ? "emoji" : "text").join("_")
  return { layout, sequence, leadText, followUpText }
}
