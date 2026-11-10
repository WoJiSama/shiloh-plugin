import type { CharacterScope } from '../../../contracts/character.js'
import type { SimMessage, SimWakeReason } from '../../../contracts/simulation.js'

export interface SimulationActor extends CharacterScope {
  kind: 'user' | 'autonomous' | 'commitment'
  userId?: string
  userName?: string
}

/** A timer/goal never borrows a nearby user's permissions. Only the triggering message owns a user turn. */
export function resolveSimulationActor(scope: CharacterScope, reason: SimWakeReason, messages: SimMessage[]): SimulationActor {
  if (reason.kind === 'commitment') return { ...scope, kind: 'commitment' }
  const directed = ['atMention', 'nameMention', 'question', 'continuation', 'session'].includes(reason.kind)
  const source = !directed || reason.seq === undefined ? undefined : messages.find(message => message.seq === reason.seq)
  return source?.userId ? { ...scope, kind: 'user', userId: source.userId, userName: source.name } : { ...scope, kind: 'autonomous' }
}

/** Autonomous work uses known reading capabilities and the group-bound simulation tools. Unknown/custom capabilities require a user turn. */
export const AUTONOMOUS_EXTRA_TOOLS: readonly string[] = ['searchInformationTool', 'webParserTool']
export const AUTONOMOUS_DENIED_SIM_TOOLS: readonly string[] = ['simQzoneInteract', 'simSendPoke', 'simUpdateAffinity']
export const AUTONOMOUS_CREATIVE_TOOLS: readonly string[] = ['bananaTool', 'googleImageEditTool', 'googleImageAnalysisTool']
