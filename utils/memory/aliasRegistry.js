// utils/memory/aliasRegistry.js
import { normalizeAlias, clamp } from './constants.js'
import { resolveClaim } from './conflictResolver.js'

function uniq(values = []) {
  return [...new Set((values || []).filter(Boolean).map(String))]
}

// doc: { [normAlias]: {qq, authority, confidence, at, by[], createdBy, sourceMessageId, proposalId, display} }
// claim: {text, qq, authority, confidence, by[], createdBy, sourceMessageId, proposalId, at}
// 返回 {doc, changed}
export function upsertAlias(doc, claim) {
  const key = normalizeAlias(claim.text)
  if (!key || !claim.qq) return { doc, changed: false }

  const next = { ...(doc || {}) }
  const existing = next[key]
  const incoming = {
    qq: String(claim.qq),
    authority: claim.authority || 'mention',
    confidence: clamp(claim.confidence ?? 0.7),
    at: Number(claim.at) || 0,
    by: uniq(claim.by),
    createdBy: String(claim.createdBy || claim.by?.[0] || ''),
    sourceMessageId: String(claim.sourceMessageId || ''),
    proposalId: String(claim.proposalId || claim.sourceMessageId || ''),
    display: claim.text
  }

  // 同 QQ：合并 by / 取较新 / 取较高 confidence
  if (existing && existing.qq === incoming.qq) {
    next[key] = {
      ...existing,
      confidence: Math.max(existing.confidence ?? 0, incoming.confidence),
      at: Math.max(existing.at ?? 0, incoming.at),
      by: uniq([...(existing.by || []), ...incoming.by]),
      authority: incoming.authority && incoming.authority !== existing.authority
        ? pickStrongerAuthority(existing.authority, incoming.authority)
        : existing.authority,
      display: incoming.display || existing.display,
      createdBy: existing.createdBy || incoming.createdBy || '',
      sourceMessageId: incoming.sourceMessageId || existing.sourceMessageId || '',
      proposalId: incoming.proposalId || existing.proposalId || ''
    }
    return { doc: next, changed: true }
  }

  // 不同 QQ 或不存在：权威分级裁决
  const { winner, changed } = resolveClaim(existing || null, incoming)
  if (!changed) return { doc: next, changed: false }
  next[key] = winner
  return { doc: next, changed: true }
}

function pickStrongerAuthority(a, b) {
  return resolveClaim({ authority: a, at: 0, by: [] }, { authority: b, at: 0, by: [] }).winner.authority
}

export function resolveAlias(doc, text) {
  const key = normalizeAlias(text)
  if (!key) return null
  return (doc && doc[key]) || null
}

export function listAliasesForQQ(doc, qq) {
  const target = String(qq)
  return Object.entries(doc || {})
    .filter(([, v]) => v.qq === target)
    .map(([key, v]) => ({ key, ...v }))
}
