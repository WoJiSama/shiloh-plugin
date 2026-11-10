import type { CharacterScope } from './character.js'

export interface CharacterWorkVersion {
  revision: number; content: string; evidenceRefs: string[]; createdAt: number; sharedSources?: string[]
}
export interface CharacterWork {
  id: string; title: string; kind: 'note' | 'research' | 'story';
  status: 'draft' | 'archived'; revision: number; versions: CharacterWorkVersion[]; createdAt: number; updatedAt: number
}
export interface CharacterWorkState { schemaVersion: 1; scope: CharacterScope; works: CharacterWork[] }
export interface CharacterFeedItem { id: string; title: string; url: string; summary: string; receivedAt: number; publishedAt?: number }
export interface CharacterSubscription {
  id: string; title: string; kind: 'rss' | 'github'; url: string; status: 'active' | 'paused';
  intervalMs: number; nextPollAt: number; failures: number; revision: number;
  seenIds: string[]; items: CharacterFeedItem[]; createdAt: number; updatedAt: number
}
export interface CharacterSubscriptionState { schemaVersion: 1; scope: CharacterScope; subscriptions: CharacterSubscription[] }
export type CharacterActivityOperation = 'work-archive' | 'work-restore' | 'work-delete' | 'subscription-pause' | 'subscription-resume' | 'subscription-remove' | 'shared-approve' | 'shared-delete' | 'reflection-reset'
