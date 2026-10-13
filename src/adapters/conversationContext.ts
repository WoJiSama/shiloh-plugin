import type { ConversationContext } from '../contracts/conversation.js'

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
}
function identity(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value.trim())) return null
  const normalized = value.trim().replace(/^0+/, '')
  return normalized || null
}

/** Parse only identity fields from a legacy event. Invalid identity does not interrupt legacy chat. */
export function resolveConversationContext(value: unknown): ConversationContext | null {
  const event = record(value)
  if (!event) return null
  const botId = identity(event.self_id) ?? identity(record(event.bot)?.uin)
  const userId = identity(event.user_id)
  if (!botId || !userId) return null
  const groupId = identity(event.group_id)
  if (event.message_type === 'group' || event.isGroup === true || groupId !== null) {
    if (!groupId) return null
    return { kind: 'group', botId, userId, groupId, conversationId: JSON.stringify(['qq', botId, 'group', groupId]) }
  }
  if (event.group_id != null && event.group_id !== '') return null
  return { kind: 'private', botId, userId, conversationId: JSON.stringify(['qq', botId, 'private', userId]) }
}
