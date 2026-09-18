function compactError(error = "") {
  return String(error?.message || error || "unknown")
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/\s+/g, " ")
    .slice(0, 300)
}

export function extractDeliveryMessageId(result) {
  return result?.message_id ?? result?.messageId ?? result?.data?.message_id ?? null
}

export function logDeliveryOutcome(logger, {
  status,
  channel,
  groupId = "",
  userId = "",
  turnId = "",
  messageId = null,
  parts = 1,
  error = ""
} = {}) {
  const level = status === "sent" ? "info" : "warn"
  const suffix = status === "sent"
    ? `message=${messageId ?? ""}`
    : `error=${compactError(error)}`
  logger?.[level]?.(`[Delivery] turn=${turnId || ""} status=${status || "unknown"} channel=${channel || "unknown"} group=${groupId || ""} user=${userId || ""} parts=${Math.max(1, Number(parts) || 1)} ${suffix}`)
}
