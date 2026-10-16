/** Read-only projection of runtime-owned task and delivery records, never assistant prose. */
export interface ActionFactScope {
  botId: string
  conversationId: string
  userId: string
}

export interface TurnTaskFact {
  taskId: string
  requestMessageId: string
  toolName: string
  source: 'task_record' | 'live_job' | 'reminder'
  observedAt: number
  execution: 'queued' | 'running' | 'completed' | 'failed' | 'unknown'
  result: 'available' | 'unavailable' | 'unknown'
  delivery: {state: 'not_attempted' | 'sent' | 'failed' | 'unknown'; messageId?: string}
  followUp: {state: 'registered' | 'none' | 'unknown'; kind?: 'job_completion' | 'reminder'; id?: string; dueAt?: number}
}

export interface TurnActionFacts {
  scope: ActionFactScope
  observedAt: number
  lookup: 'ok' | 'unavailable'
  tasks: TurnTaskFact[]
}

export interface ActionFactsEvent {
  self_id?: string | number | null
  bot?: {uin?: string | number | null}
  group_id?: string | number | null
  user_id?: string | number | null
  message_id?: unknown
}

export interface ActionFactsQuery {
  referenceMessageId?: string
  recentRequestMessageIds?: string[]
}
