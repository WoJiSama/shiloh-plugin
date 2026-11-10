/** 角色标识不随普通人设文本编辑变化；第一版所有经历与目标按三元组隔离。 */
export interface CharacterScope { botId: string; personaId: string; groupId: string }

export type CharacterMemoryKind = 'experience' | 'opinion' | 'interest'
export type CharacterEpistemic = 'reported' | 'observed' | 'inferred' | 'desired'
export interface CharacterMemoryInput {
  id: string
  kind: CharacterMemoryKind
  content: string
  epistemic: CharacterEpistemic
  evidenceRefs: string[]
  supersedes?: string
  /** Shared-self projections present when this memory was formed; used for revocation. */
  sharedSources?: string[]
}
export interface CharacterMemory extends CharacterMemoryInput { createdAt: number; updatedAt: number }

export type CharacterGoalStatus = 'active' | 'waiting' | 'paused' | 'completed' | 'abandoned' | 'failed'
export interface CharacterGoalInput {
  id: string
  title: string
  motivation: string
  nextStep: string
  completionCriteria: string
  stopConditions: string[]
  evidenceRefs: string[]
  nextCheckAt?: number
  expiresAt?: number
  maxAttempts?: number
  sharedSources?: string[]
}
export interface CharacterGoal {
  id: string
  kind: 'autonomous'
  title: string
  motivation: string
  nextStep: string
  completionCriteria: string
  stopConditions: string[]
  evidenceRefs: string[]
  status: CharacterGoalStatus
  nextCheckAt: number
  expiresAt: number
  attempts: number
  maxAttempts: number
  revision: number
  createdAt: number
  updatedAt: number
  lastOutcome?: string
  sharedSources?: string[]
}

export type CharacterReceiptStatus = 'pending' | 'succeeded' | 'failed' | 'unknown'
export interface CharacterReceipt {
  id: string
  toolName: string
  status: CharacterReceiptStatus
  summary: string
  at: number
  goalId?: string
  /** 行动开始时的目标版本，回执不能使后来取消的目标复活。 */
  goalRevision?: number
}

export interface CharacterDecision {
  kind: 'engage' | 'silent' | 'cannot' | 'unauthorized' | 'unwilling' | 'deferred'
  reason: string
  at: number
}

export interface CharacterState {
  schemaVersion: 1
  scope: CharacterScope
  revision: number
  paused: boolean
  memories: CharacterMemory[]
  goals: CharacterGoal[]
  receipts: CharacterReceipt[]
  decision?: CharacterDecision
}
