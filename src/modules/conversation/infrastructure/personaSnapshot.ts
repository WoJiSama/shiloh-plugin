import {createHash} from 'node:crypto'
import type {PersonaGuardConfig, PersonaSnapshot} from '../../../contracts/persona.js'
import {resolvePersonaName} from '../domain/personaSource.js'

/** Configuration consists of JSON values; copy it without retaining live array/object references. */
function copyConfig(value: unknown): unknown {
  if (Array.isArray(value)) return Object.freeze(value.map(copyConfig))
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key]
      if (item !== undefined) result[key] = copyConfig(item)
    }
    return Object.freeze(result)
  }
  return value
}

export function createPersonaSnapshot({botId, personaId = 'default', persona = {}, systemContent = '', personaGuard}: {
  botId: string | number
  personaId?: string
  persona?: {name?: string; [key: string]: unknown}
  systemContent?: string
  personaGuard?: PersonaGuardConfig
}): PersonaSnapshot {
  const capturedPersona = copyConfig(persona) as PersonaSnapshot['persona']
  const capturedGuard = personaGuard === undefined ? undefined : copyConfig(personaGuard) as PersonaGuardConfig
  const content = String(systemContent || '')
  const personaVersion = createHash('sha256').update(JSON.stringify({persona: capturedPersona, systemContent: content, personaGuard: capturedGuard})).digest('hex')
  return Object.freeze({
    botId: String(botId),
    personaId: String(personaId || 'default'),
    personaVersion,
    personaName: resolvePersonaName(capturedPersona),
    persona: capturedPersona,
    systemContent: content,
    ...(capturedGuard === undefined ? {} : {personaGuard: capturedGuard})
  })
}
