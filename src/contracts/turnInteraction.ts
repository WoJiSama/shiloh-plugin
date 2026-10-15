import type {TurnActionFacts} from './turnActionFacts.js'
import type {DiagnosticContext} from './diagnosticContext.js'

export type InteractionKind = 'conversation' | 'banter' | 'clarification' | 'delivery' | 'comfort' | 'serious_answer'

export type SocialAct = 'conversation' | 'attention_bid' | 'teasing' | 'help_request' | 'criticism' | 'comfort' | 'clarification' | 'factual_question' | 'delivery' | 'unknown'
export type SocialStance = 'playful' | 'supportive' | 'matter_of_fact' | 'repairing' | 'boundary' | 'neutral'
export type SocialInterpretationSource = 'local' | 'gate_model' | 'intent_model' | 'understanding_model'
export interface InteractionTarget {
  kind: 'bot' | 'other' | 'group' | 'unknown'
  source: 'quote' | 'mention' | 'addressee' | 'interpretation' | 'unknown'
  userId?: string
  messageId?: string
  label?: string
}
export interface SocialReference {
  text: string
  source: TurnEvidence['origin'] | 'verified_continuity'
  messageId?: string
}
/** Stored under the same bot/persona/version boundary as the confirmed lastReply.
 * Text fields are excerpts of that reply, not new promises or factual memories. */
export interface SocialContinuity {
  activeBit?: string
  pendingInteraction?: string
  stance?: SocialStance
}
/** One interpretation shared by participation, tone and generation. Confidence
 * describes a speech-act inference; it never verifies relationships or events. */
export interface SocialTurnState {
  act: SocialAct
  source: SocialInterpretationSource
  confidence: number
  needsDisambiguation: boolean
  target: InteractionTarget
  activeBit?: SocialReference
  pendingInteraction?: {text: string; source: 'quote' | 'verified_continuity'}
  previousStance?: {kind: SocialStance; text: string; source: 'quote' | 'verified_continuity'}
}

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
  forwardCompleteness?: import('./forwardContext.js').ForwardCompleteness
}

/** One turn's interpretation cues. Text and media references are not interchangeable evidence. */
export interface TurnInteractionContext {
  rawUserText: string
  kind: InteractionKind
  speaker: { userId?: string; name?: string }
  target: InteractionTarget
  evidence: TurnEvidence[]
  previousBotReply?: { text: string; source: 'quote' | 'verified_continuity' }
  actionFacts?: TurnActionFacts
  diagnosticContext?: DiagnosticContext
  social?: SocialTurnState
  allowPlayfulness: boolean
}
