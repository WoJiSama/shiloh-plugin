function record(value:unknown):Record<string,unknown>{return value && typeof value==='object' && !Array.isArray(value)?value as Record<string,unknown>:{}}
// 消息段/合并转发解析:JSON payload、转发 ID、可读文本、发送者名等纯函数。
// 从 apps/test.js 原样迁出(P2),行为不变。
import { getMentionTargetId } from "./mentionTargets.js"
import { getReplySender } from "./messageContext.js"
import { normalizeIntentText } from "./messageIntent.js"

export function parseForwardJsonPayload(value:unknown):Record<string,unknown> | null {
  if (!value) return null
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value))
    } catch {
      return null
    }
  }
  if (typeof value === "object") return record(value)
  return null
}

export function getSegmentData(segment:Record<string,unknown> = {}) {
  const data = segment?.data
  if (data && typeof data === "object" && !Array.isArray(data)) return record(data)
  return {}
}

export function normalizeMessageSegments(value:unknown): Record<string,unknown>[] {
  const message=record(value)
  if (Array.isArray(value)) return value.map(record)
  if (Array.isArray(message?.message)) return message.message.map(record)
  if (Array.isArray(message?.content)) return message.content.map(record)
  return []
}

export function normalizeForwardMessageList(payload:unknown):unknown[] {
  const data = record(payload).data || payload
  if (Array.isArray(data)) return data
  if (Array.isArray(record(data).messages)) return record(data).messages as unknown[]
  if (Array.isArray(record(data).nodes)) return record(data).nodes as unknown[]
  return []
}

export function extractForwardIdFromSegment(segment:Record<string,unknown> = {}) {
  const data = getSegmentData(segment)
  if (segment?.type === "forward") {
    return segment.id || data.id || segment.resid || data.resid || segment.file || data.file || ""
  }

  if (segment?.type === "json") {
    const raw = data.data ?? segment.data
    const jsonData = parseForwardJsonPayload(raw)
    if (jsonData?.app === "com.tencent.multimsg") {
      return record(record(jsonData.meta).detail).resid || record(record(jsonData.meta).detail).uniseq || ""
    }
  }

  return ""
}

export function extractForwardIdsFromSegments(segments:unknown = []) {
  const ids:string[] = []
  for (const segment of normalizeMessageSegments(segments)) {
    const id = String(extractForwardIdFromSegment(segment) || "").trim()
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}

export function extractReadableTextFromSegments(segments:unknown = [], fallback = "") {
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

export function getForwardSenderName(message:Record<string,unknown> = {}) {
  return record(message.sender).card ||
    record(message.sender).nickname ||
    message.nickname ||
    message.user_name ||
    message.name ||
    "未知"
}

export function normalizeForContainment(text = "") {
  return normalizeIntentText(text)
    .replace(/[^\p{L}\p{N}\u4e00-\u9fa5]+/gu, "")
    .toLowerCase()
}


export function getReplyTargetUserId(value:unknown = {}) {
  const reply=record(value)
  return record(reply.sender).user_id || record(reply.sender).qq || getReplySender(reply)
}
