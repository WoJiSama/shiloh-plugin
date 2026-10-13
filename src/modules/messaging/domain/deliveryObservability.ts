export interface DeliveryLog { status?: string; channel?: string; groupId?: string | number; userId?: string | number; turnId?: string; messageId?: string | number | null; parts?: number; error?: unknown }
function compactError(error: unknown = "") {
  return String((error instanceof Error ? error.message : error) || "unknown")
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/\s+/g, " ")
    .slice(0, 300)
}

export function extractDeliveryMessageId(result: unknown): string | number | null {
 const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
 const receipt = object(result)
 const id = receipt.message_id ?? receipt.messageId ?? object(receipt.data).message_id
 return typeof id === 'string' || typeof id === 'number' ? id : null
}

export function logDeliveryOutcome(logger: {info?(message:string):void;warn?(message:string):void} | null | undefined, {
  status,
  channel,
  groupId = "",
  userId = "",
  turnId = "",
  messageId = null,
  parts = 1,
  error = ""
}: DeliveryLog = {}) {
  const level = status === "sent" ? "info" : "warn"
  const suffix = status === "sent"
    ? `message=${messageId ?? ""}`
    : `error=${compactError(error)}`
  logger?.[level]?.(`[Delivery] turn=${turnId || ""} status=${status || "unknown"} channel=${channel || "unknown"} group=${groupId || ""} user=${userId || ""} parts=${Math.max(1, Number(parts) || 1)} ${suffix}`)
}
