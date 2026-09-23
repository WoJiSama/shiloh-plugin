// 消息段/合并转发解析:JSON payload、转发 ID、可读文本、发送者名等纯函数。
// 从 apps/test.js 原样迁出(P2),行为不变。

export function parseForwardJsonPayload(value) {
  if (!value) return null
  if (typeof value === "string") {
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }
  if (typeof value === "object") return value
  return null
}

export function getSegmentData(segment = {}) {
  const data = segment?.data
  if (data && typeof data === "object" && !Array.isArray(data)) return data
  return {}
}

export function normalizeMessageSegments(message) {
  if (Array.isArray(message)) return message
  if (Array.isArray(message?.message)) return message.message
  if (Array.isArray(message?.content)) return message.content
  return []
}

export function normalizeForwardMessageList(payload) {
  const data = payload?.data || payload
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.messages)) return data.messages
  if (Array.isArray(data?.nodes)) return data.nodes
  return []
}

export function extractForwardIdFromSegment(segment = {}) {
  const data = getSegmentData(segment)
  if (segment?.type === "forward") {
    return segment.id || data.id || segment.resid || data.resid || segment.file || data.file || ""
  }

  if (segment?.type === "json") {
    const raw = data.data ?? segment.data
    const jsonData = parseForwardJsonPayload(raw)
    if (jsonData?.app === "com.tencent.multimsg") {
      return jsonData.meta?.detail?.resid || jsonData.meta?.detail?.uniseq || ""
    }
  }

  return ""
}

export function extractForwardIdsFromSegments(segments = []) {
  const ids = []
  for (const segment of normalizeMessageSegments(segments)) {
    const id = String(extractForwardIdFromSegment(segment) || "").trim()
    if (id && !ids.includes(id)) ids.push(id)
  }
  return ids
}

export function extractReadableTextFromSegments(segments = [], fallback = "") {
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

export function getForwardSenderName(message = {}) {
  return message.sender?.card ||
    message.sender?.nickname ||
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


export function getReplyTargetUserId(reply = {}) {
  return reply?.sender?.user_id || reply?.sender?.qq || getReplySender(reply)
}
