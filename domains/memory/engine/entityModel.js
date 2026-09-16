// utils/memory/entityModel.js
import { createHash } from 'node:crypto'
import { clamp, compactText } from './constants.js'

const FACT_ORIGINS = Object.freeze(['extract', 'reflection', 'config'])

// 稳定短 id（§0.1）：sha256(text) 前 8 位 hex。展示与按 id 删除引用同一短 id，
// 保证"看到的 id"能删到对应事实。纯函数，对相同文本恒定。
export function factShortId(text) {
  return createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 8)
}

function uniqStrings(values = []) {
  return [...new Set((values || [])
    .filter(v => v !== undefined && v !== null && String(v).trim() !== '')
    .map(String))]
}

function normalizeEmbedding(value) {
  return Array.isArray(value) ? value : null
}

function normalizeEventAt(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function normalizeOrigin(value) {
  return FACT_ORIGINS.includes(value) ? value : 'extract'
}

export function makeAlias(input = {}) {
  return {
    text: compactText(input.text, 64),
    authority: input.authority || 'mention',
    confidence: clamp(input.confidence ?? 0.7),
    by: uniqStrings(input.by),
    at: Number(input.at) || 0,
    superseded: input.superseded === true
  }
}

export function makeFact(input = {}) {
  return {
    text: compactText(input.text, 240),
    tags: uniqStrings(input.tags),
    refs: uniqStrings(input.refs),
    authority: input.authority || 'mention',
    confidence: clamp(input.confidence ?? 0.7),
    at: Number(input.at) || 0,
    superseded: input.superseded === true,
    embedding: normalizeEmbedding(input.embedding),
    eventAt: normalizeEventAt(input.eventAt),
    origin: normalizeOrigin(input.origin)
  }
}

export function makeEntity(input = {}) {
  return {
    qq: input.qq === undefined || input.qq === null || input.qq === '' ? null : String(input.qq),
    canonicalName: compactText(input.canonicalName, 64) || null,
    aliases: Array.isArray(input.aliases) ? input.aliases.map(makeAlias) : [],
    facts: Array.isArray(input.facts) ? input.facts.map(makeFact) : [],
    updatedAt: Number(input.updatedAt) || 0
  }
}

export function slimEntityDoc(doc = {}) {
  const out = {}
  for (const [id, entity] of Object.entries(doc || {})) {
    out[id] = makeEntity(entity)
  }
  return out
}

export function slimGroupFacts(facts = []) {
  return (Array.isArray(facts) ? facts : []).map(makeFact)
}
