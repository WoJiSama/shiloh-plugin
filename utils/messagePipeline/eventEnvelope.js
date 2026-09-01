import { createHash } from "node:crypto"

const MAX_STRING_LENGTH = 100000
const MAX_ARRAY_LENGTH = 500
const MAX_DEPTH = 10

function copySerializable(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value
  if (typeof value === "string") return value.length > MAX_STRING_LENGTH ? value.slice(0, MAX_STRING_LENGTH) : value
  if (["number", "boolean"].includes(typeof value)) return value
  if (typeof value === "bigint") return String(value)
  if (typeof value !== "object" || depth >= MAX_DEPTH) return undefined
  if (Buffer.isBuffer(value)) return undefined
  if (seen.has(value)) return undefined
  seen.add(value)

  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_LENGTH).map(item => copySerializable(item, depth + 1, seen))
  }

  const output = {}
  for (const [key, item] of Object.entries(value)) {
    const copied = copySerializable(item, depth + 1, seen)
    if (copied !== undefined) output[key] = copied
  }
  return output
}
function stableHash(parts = []) {
  return createHash("sha256").update(parts.map(item => String(item ?? "")).join("\u001f")).digest("hex").slice(0, 24)
}

function normalizeId(value) {
  return value === undefined || value === null ? "" : String(value).trim()
}

export function createEventEnvelope(e = {}, forcedPostType = "") {
  const postType = normalizeId(forcedPostType || e.post_type || (e.notice_type ? "notice" : "message")) || "message"
  const messageType = normalizeId(e.message_type || (e.group_id ? "group" : "private"))
  const botId = normalizeId(e.self_id || e.bot?.uin || globalThis.Bot?.uin)
  const groupId = normalizeId(e.group_id)
  const userId = normalizeId(e.user_id || e.sender?.user_id)
  const conversationType = groupId ? "group" : "private"
  const conversationId = groupId || userId || "unknown"
  const messageId = normalizeId(e.message_id || e.messageId)
  const occurredAt = Number(e.time ? Number(e.time) * 1000 : Date.now())
  const rawMessage = String(e.raw_message || e.msg || "")
  const fallbackId = stableHash([
    botId,
    postType,
    messageType,
    e.notice_type,
    e.sub_type,
    conversationId,
    userId,
    occurredAt,
    rawMessage
  ])
  const eventId = ["v1", botId || "bot", postType, conversationType, conversationId, messageId || fallbackId].join(":")

  return Object.freeze({
    version: 1,
    eventId,
    postType,
    messageType,
    noticeType: normalizeId(e.notice_type),
    subType: normalizeId(e.sub_type),
    botId,
    conversationType,
    conversationId,
    groupId,
    groupName: String(e.group_name || e.group?.name || e.group?.group_name || ""),
    userId,
    messageId,
    occurredAt,
    capturedAt: Date.now(),
    rawMessage: rawMessage.length > MAX_STRING_LENGTH ? rawMessage.slice(0, MAX_STRING_LENGTH) : rawMessage,
    message: copySerializable(Array.isArray(e.message) ? e.message : []),
    sender: copySerializable(e.sender || { user_id: userId }),
    source: copySerializable(e.source || null),
    operatorId: normalizeId(e.operator_id || e.operatorId),
    targetId: normalizeId(e.target_id),
    adapterId: normalizeId(e.adapter_id || e.bot?.adapter?.id),
    adapterName: String(e.adapter_name || e.bot?.adapter?.name || "")
  })
}

export function envelopeToRuntimeEvent(envelope = {}, message = envelope.message) {
  const isGroup = envelope.conversationType === "group"
  return {
    event_id: envelope.eventId,
    post_type: envelope.postType,
    message_type: envelope.messageType || (isGroup ? "group" : "private"),
    notice_type: envelope.noticeType || undefined,
    sub_type: envelope.subType || undefined,
    self_id: envelope.botId ? Number(envelope.botId) || envelope.botId : undefined,
    group_id: isGroup ? Number(envelope.groupId) || envelope.groupId : undefined,
    group_name: envelope.groupName || "",
    user_id: envelope.userId ? Number(envelope.userId) || envelope.userId : undefined,
    message_id: envelope.messageId ? Number(envelope.messageId) || envelope.messageId : undefined,
    time: Math.floor(Number(envelope.occurredAt || Date.now()) / 1000),
    raw_message: envelope.rawMessage || "",
    msg: envelope.rawMessage || "",
    message: copySerializable(Array.isArray(message) ? message : []),
    forward_context: copySerializable(envelope.forwardContext || null),
    sender: copySerializable(envelope.sender || {}),
    source: copySerializable(envelope.source || null),
    operator_id: envelope.operatorId ? Number(envelope.operatorId) || envelope.operatorId : undefined,
    target_id: envelope.targetId ? Number(envelope.targetId) || envelope.targetId : undefined
  }
}

export function isEnvelopeFromBot(envelope = {}) {
  return Boolean(envelope.botId && envelope.userId && String(envelope.botId) === String(envelope.userId))
}
