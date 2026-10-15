import type {TurnActionFacts} from './turnActionFacts.js'
import type {DiagnosticContext} from './diagnosticContext.js'

export type InteractionKind = 'conversation' | 'banter' | 'clarification' | 'delivery' | 'comfort' | 'serious_answer'

export interface TurnEvidence {
  origin: 'current' | 'quote' | 'forward' | 'tool'
  kind: 'text' | 'image' | 'video' | 'audio' | 'file'
  state: 'readable' | 'reference_only' | 'unavailable'
  text?: string
  source?: string
  toolName?: string
  toolCallId?: string
  speaker?: {userId?: string; name?: string}
  messageId?: string
}

/** One turn's interpretation cues. Text and media references are not interchangeable evidence. */
export interface TurnInteractionContext {
  rawUserText: string
  kind: InteractionKind
  speaker: { userId?: string; name?: string }
  target: {
    kind: 'bot' | 'other' | 'group' | 'unknown'
    source: 'quote' | 'mention' | 'addressee' | 'unknown'
    userId?: string
    messageId?: string
    label?: string
  }
  evidence: TurnEvidence[]
  previousBotReply?: { text: string; source: 'quote' | 'verified_continuity' }
  actionFacts?: TurnActionFacts
  diagnosticContext?: DiagnosticContext
  allowPlayfulness: boolean
}
