import type { CharacterMemory, CharacterReceipt } from './character.js'

export interface CharacterProfile {
  persona: { name: string; identity: string; tone: string; preferences: string[]; speechStyle: string[] }
  mood: { status: 'disabled' | 'unrecorded' | 'recorded'; summary?: string; updatedAt?: number }
  rhythm: { enabled: boolean; sleepFrom: number; sleepTo: number; sleeping: boolean }
  interests: CharacterMemory[]
  opinions: CharacterMemory[]
  habits: { id: string; content: string; updatedAt: number; evidenceRefs?: string[] }[]
  life: { id: string; title: string; kind: 'anime' | 'game'; status: 'active' | 'dropped'; lastEpisode?: number; lastSyncAt: number; notes: string[] }[]
  evidence: Record<string, CharacterProfileEvidence>
}

export type CharacterProfileEvidence =
  | { kind: 'message'; at: number; text: string }
  | { kind: 'memory'; at: number; text: string }
  | { kind: 'receipt'; at: number; text: string; status: CharacterReceipt['status'] }
