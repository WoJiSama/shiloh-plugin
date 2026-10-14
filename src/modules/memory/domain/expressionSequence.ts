export interface ExpressionObservation { text: string; hasEmojiPack: boolean; sample: string; userId: string; messageId: string; at: number }
export interface ExpressionMetadata extends Record<string, unknown> { message?: unknown[] | undefined; segments?: unknown[] | undefined }
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
import { safeTruncateUnicode } from "../../models/domain/unicodeText.js"

const EMOJI_SUMMARY_RE = /表情|动画表情|梗图|反应图|贴纸|sticker/i
const EMOJI_SEGMENT_TYPES = new Set(["mface", "marketface", "bface"])

function segmentData(input: unknown = {}) {
  const segment = object(input)
  return segment?.data && typeof segment.data === "object" ? object(segment.data) : segment
}

export function isLikelyEmojiPackSegment(input: unknown = {}) {
  const segment = object(input)
  const type = String(segment?.type || "").toLowerCase()
  if (EMOJI_SEGMENT_TYPES.has(type)) return true
  if (type !== "image") return false
  const data = segmentData(segment)
  const subtype = segment?.sub_type ?? data?.sub_type
  const summary = String(segment?.summary || data?.summary || "")
  return String(subtype) === "1" || EMOJI_SUMMARY_RE.test(summary)
}

export function cleanExpressionText(content = "") {
  return String(content || "")
    .replace(/https?:\/\/\S+/gi, "[链接]")
    .replace(/\[CQ:[^\]]+\]/g, " ")
    .replace(/@\S{1,24}/g, "@某人")
    .replace(/\b\d{5,12}\b/g, "[数字]")
    .replace(/\s+/g, " ")
    .trim()
}

function rawContentHasEmojiPack(content = "") {
  const raw = String(content || "")
  return /\[CQ:(?:mface|marketface|bface)\b/i.test(raw) ||
    /\[CQ:image\b[^\]]*(?:sub_type=1|summary=[^,\]]*(?:表情|梗图|反应图|贴纸))/i.test(raw)
}

export function buildExpressionObservation(content = "", metadata: ExpressionMetadata = {}): ExpressionObservation | null {
  const raw = String(content || "")
  const text = cleanExpressionText(raw)
  const segments = Array.isArray(metadata?.message)
    ? metadata.message
    : Array.isArray(metadata?.segments) ? metadata.segments : []
  const detectedEmojiPack = segments.some(isLikelyEmojiPackSegment) || rawContentHasEmojiPack(raw)
  const hasEmojiPack = typeof metadata?.hasEmojiPack === "boolean"
    ? metadata.hasEmojiPack
    : detectedEmojiPack
  if (!text && !hasEmojiPack) return null
  const sample = text && hasEmojiPack
    ? `${text} [表情包]`
    : hasEmojiPack ? "[表情包]" : text
  return {
    text,
    hasEmojiPack,
    sample: safeTruncateUnicode(sample, 180),
    userId: String(metadata?.userId ?? metadata?.user_id ?? ""),
    messageId: String(metadata?.messageId ?? metadata?.message_id ?? ""),
    at: Number(metadata?.at) || Date.now()
  }
}

export function buildExpressionSequenceSample(items: Partial<ExpressionObservation>[] = []) {
  return safeTruncateUnicode(items
    .map(item => String(item?.sample || "").trim())
    .filter(Boolean)
    .join(" [下一条] "), 360)
}

export function classifyExpressionRhythm(items: Partial<ExpressionObservation>[] = []) {
  const observations = items.filter(Boolean)
  if (!observations.length) return "single"
  const roles = []
  for (const item of observations) {
    if (item.text) roles.push("text")
    if (item.hasEmojiPack) roles.push("emoji")
  }
  const signature = roles.join("_")
  if (signature === "emoji") return "emojiOnly"
  if (signature === "text_emoji") return "textEmoji"
  if (signature === "emoji_text") return "emojiText"
  if (signature === "text_emoji_text") return "textEmojiText"
  if (!roles.includes("emoji")) {
    if (observations.length === 2) return "twoBeat"
    if (observations.length >= 3) return "multiBeat"
    return "single"
  }
  return observations.length >= 3 ? "mixedMultiBeat" : "mixedTwoBeat"
}
