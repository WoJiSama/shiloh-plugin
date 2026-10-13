// utils/memory/constants.js
import {safeTruncateUnicode} from '../../../models/domain/unicodeText.js'

export const AUTHORITY_RANK = Object.freeze({ mention: 1, teaching: 2, self: 3, config: 4 })

export const ROUTES = new Set([
  'explicit_teaching',
  'self_statement',
  'user_preference',
  'group_consensus',
  'ordinary_chat'
])

export const KEY = Object.freeze({
  entities: (groupId: unknown) => `ytbot:mem:g:${groupId}:entities`,
  alias:    (groupId: unknown) => `ytbot:mem:g:${groupId}:alias`,
  facts:    (groupId: unknown) => `ytbot:mem:g:${groupId}:facts`,
  workflows: (groupId: unknown) => `ytbot:mem:g:${groupId}:workflows`,
  knowledge: (groupId: unknown) => `ytbot:mem:g:${groupId}:knowledge`,
  meta:     (groupId: unknown) => `ytbot:mem:g:${groupId}:meta`,
  prefix:   (groupId: unknown) => `ytbot:mem:g:${groupId}:`
})

export function authorityRank(authority: unknown) {
  return AUTHORITY_RANK[String(authority) as keyof typeof AUTHORITY_RANK] ?? 0
}

export function clamp(value: unknown, min = 0, max = 1) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, n))
}

export function normalizeAlias(text: unknown) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}一-龥]+/gu, '')
    .trim()
}

export function compactText(text: unknown, maxLength = 240) {
  return safeTruncateUnicode(String(text || '').replace(/\s+/g, ' ').trim(), maxLength)
}
