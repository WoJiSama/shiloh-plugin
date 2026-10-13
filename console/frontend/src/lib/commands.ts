import { api } from './api'
export const COMMANDS_API = '/bl-chat/commands/api'
export function commandsApi<T = any>(path: string, options: RequestInit = {}) {
  return api<T>(`${COMMANDS_API}/${path}`, options)
}
export interface Command {
  usage: string
  desc: string
  perm: 'all' | 'admin' | 'master'
  src: string
}
export interface CommandDomain {
  key: string
  name: string
  icon: string
  desc: string
  order: number
  commands: Command[]
}
export interface DiceTemplateMeta {
  key: string
  label: string
  hint?: string
}
export interface DiceBuiltin {
  id: string
  name: string
  desc: string
  commands: string[]
  hasLevels?: boolean
  hasInsanity?: boolean
  templateKeys?: DiceTemplateMeta[]
  groups?: Array<{ title: string; command: string; hint?: string; templates: DiceTemplateMeta[] }>
}
export interface DicePack {
  id: string
  name: string
  versions: string[]
  enabledGroups: number
  commands: string[]
}
export interface Deck {
  name: string
  fileName: string
  author: string
  version: string
  visibleCount: number
  entryCount: number
  keys: string[]
}
export interface DiceData {
  templates: Record<string, string>
  checkLevels: Record<string, string>
  insanityTables: { temp: string[]; indefinite: string[] }
  jrrpComments: string[]
  builtin: DiceBuiltin[]
  checkLevelMeta: Array<{ key: string; label: string }>
  packs: DicePack[]
  decks: Deck[]
  deckError?: string
}
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
/** Reject rather than silently rename so overwrite confirmation uses the exact backend identity. */
export function uploadFileName(value: string): string | null {
  const name = value.trim()
  if (/[\\/:*?"<>|]/.test(name)) return null
  return /^[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5 .-]{0,80}\.(json|ya?ml|js|cjs|mjs)$/i.test(name)
    ? name
    : null
}
export function changes(next: unknown, before: unknown): number {
  if (JSON.stringify(next) === JSON.stringify(before)) return 0
  if (!next || !before || typeof next !== 'object' || typeof before !== 'object') return 1
  const keys = new Set([...Object.keys(next), ...Object.keys(before)])
  return [...keys].reduce(
    (total, key) => total + changes((next as any)[key], (before as any)[key]),
    0
  )
}
