import type { CharacterMemory, CharacterState } from '../../../contracts/character.js'
import type { CharacterProfile } from '../../../contracts/characterProfile.js'
import type { SimMessage, SimSessionState } from '../../../contracts/simulation.js'
import { resolvePersonaName, type PersonaText } from '../../conversation/domain/personaSource.js'
import { activeCharacterMemories } from './characterState.js'

export function describePersona(persona: PersonaText): CharacterProfile['persona'] {
  const text = (value: unknown) => typeof value === 'string' ? value.trim().slice(0, 360) : ''
  const list = (value: unknown) => (Array.isArray(value) ? value : [value]).map(text).filter(Boolean).slice(0, 10)
  return { name: resolvePersonaName(persona).slice(0, 80), identity: text(persona.identity), tone: text(persona.tone), preferences: list(persona.preferences), speechStyle: list(persona.speechStyle) }
}

export function describeCharacterTaste(character: CharacterState): Pick<CharacterProfile, 'interests' | 'opinions'> {
  const active = activeCharacterMemories(character.memories)
  const select = (kind: CharacterMemory['kind']) => active.filter(memory => memory.kind === kind)
    .sort((left, right) => right.updatedAt - left.updatedAt)
  return { interests: select('interest'), opinions: select('opinion') }
}

/** Resolve only references attached to displayed records. Missing messages may have aged out or been recalled. */
export function describeCharacterEvidence(character: CharacterState, recent: SimMessage[], refs: string[],
  replies: SimSessionState['recentConfirmedReplies'] = [], replyRefs: string[] = []): CharacterProfile['evidence'] {
  const evidence: CharacterProfile['evidence'] = {}
  const byRef = new Set(refs)
  const confirmed = new Map(replies.map(({ seq, at, text }) => [`message:${seq}`, { at, text }]))
  const includesReply = new Set(replyRefs)
  for (const message of recent) {
    const ref = `message:${message.seq}`
    const reply = includesReply.has(ref) ? confirmed.get(ref) : undefined
    if (byRef.has(ref)) evidence[ref] = { kind: 'message', at: message.at, text: message.text.slice(0, 240), ...(reply ? { reply } : {}) }
  }
  for (const memory of character.memories) {
    const ref = `memory:${memory.id}`
    if (byRef.has(ref)) evidence[ref] = { kind: 'memory', at: memory.updatedAt, text: memory.content.slice(0, 240) }
  }
  for (const receipt of character.receipts) {
    const ref = `receipt:${receipt.id}`
    if (byRef.has(ref)) evidence[ref] = { kind: 'receipt', at: receipt.at, text: receipt.summary.slice(0, 240), status: receipt.status }
  }
  return evidence
}
