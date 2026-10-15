import type {PersonaScope} from '../../../contracts/persona.js'

/** Sent-account provenance only; snapshots and provider configuration never enter archives. */
export function parseSentPersonaSource(value: unknown, source: unknown, senderId: unknown): PersonaScope | undefined {
  if (source !== 'send' || !value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  const fields = ['botId', 'personaId', 'personaVersion', 'personaName'] as const
  if (!fields.every(field => typeof item[field] === 'string' && item[field].trim())) return undefined
  if (typeof senderId !== 'string' && typeof senderId !== 'number' || item.botId !== String(senderId)) return undefined
  return {botId: item.botId as string, personaId: item.personaId as string, personaVersion: item.personaVersion as string, personaName: item.personaName as string}
}
