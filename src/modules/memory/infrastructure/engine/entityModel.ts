import { memoryRecord } from '../../../../contracts/memoryEngine.js'
import type { MemoryEntity,MemoryFact,MemoryAlias } from '../../../../contracts/memoryEngine.js'
// utils/memory/entityModel.js
import { createHash } from 'node:crypto'
import { clamp, compactText } from './constants.js'

const FACT_ORIGINS = Object.freeze(['extract', 'reflection', 'config'])

// 稳定短 id（§0.1）：sha256(text) 前 8 位 hex。展示与按 id 删除引用同一短 id，
// 保证"看到的 id"能删到对应事实。纯函数，对相同文本恒定。
export function factShortId(text: unknown) {
  return createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 8)
}

function uniqStrings(value: unknown = []) {
  const values = Array.isArray(value) ? value : []
  return [...new Set((values || [])
    .filter(v => v !== undefined && v !== null && String(v).trim() !== '')
    .map(String))]
}

function normalizeEmbedding(value: unknown) {
  return Array.isArray(value) && value.every(item => typeof item === "number" && Number.isFinite(item)) ? value as number[] : null
}

function normalizeEventAt(value: unknown) {
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function normalizeOrigin(value: unknown) {
  return FACT_ORIGINS.includes(String(value)) ? String(value) : 'extract'
}

export function makeAlias(raw: unknown = {}): MemoryAlias {
  const input = memoryRecord(raw)
  return {
    text: compactText(input.text, 64),
    authority: String(input.authority || 'mention'),
    confidence: clamp(input.confidence ?? 0.7),
    by: uniqStrings(input.by),
    at: Number(input.at) || 0,
    superseded: input.superseded === true
  }
}

export function makeFact(raw: unknown = {}): MemoryFact {
  const input = memoryRecord(raw)
  return {
    text: compactText(input.text, 240),
    tags: uniqStrings(input.tags),
    refs: uniqStrings(input.refs),
    authority: String(input.authority || 'mention'),
    confidence: clamp(input.confidence ?? 0.7),
    at: Number(input.at) || 0,
    superseded: input.superseded === true,
    embedding: normalizeEmbedding(input.embedding),
    eventAt: normalizeEventAt(input.eventAt),
    origin: normalizeOrigin(input.origin),
    // 多账号共享记忆的来源标注:这条事实是哪个 bot 在场时听来的(人设名);
    // 注入给其他 bot 时可自然引用为"听XX说过"
    ...(compactText(input.heardFrom, 24) ? { heardFrom: compactText(input.heardFrom, 24) } : {})
  }
}

export function makeEntity(raw: unknown = {}): MemoryEntity {
  const input = memoryRecord(raw)
  return {
    qq: input.qq === undefined || input.qq === null || input.qq === '' ? null : String(input.qq),
    canonicalName: compactText(input.canonicalName, 64) || null,
    aliases: Array.isArray(input.aliases) ? input.aliases.map(makeAlias) : [],
    facts: Array.isArray(input.facts) ? input.facts.map(makeFact) : [],
    updatedAt: Number(input.updatedAt) || 0
  }
}

export function slimEntityDoc(raw: unknown = {}) {
  const doc=memoryRecord(raw)
  const out:Record<string,MemoryEntity> = {}
  for (const [id, entity] of Object.entries(doc || {})) {
    out[id] = makeEntity(entity)
  }
  return out
}

export function slimGroupFacts(facts: unknown = []) {
  return (Array.isArray(facts) ? facts : []).map(makeFact)
}
