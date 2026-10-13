import { TURN_SESSION_FIELDS } from '../../src/modules/runtime/domain/turnSession.js'
import type { TurnSession, TurnSessionStore } from '../../src/modules/runtime/domain/turnSession.js'

// Compiled only: the registry has no permissive string index and primitive fields are strict.
export function sessionTypeContracts(session: TurnSession, store: TurnSessionStore): void {
  session.thinkingChars = 10
  session.thinkingChunks = ['summary']
  session.responseAttempted = true
  store.getOrCreate('uuid', [])
  store.getOrCreate(0, [])
  // @ts-expect-error unregistered session state must be explicitly owned
  session.unregisteredField = true
  // @ts-expect-error character budget must be numeric
  session.thinkingChars = '10'
  // @ts-expect-error response guard must be boolean
  session.responseAttempted = 'true'
  // @ts-expect-error opaque legacy data must be narrowed before use
  session.turnPlan.steps
  // @ts-expect-error caller keys are identifiers, not objects
  store.get({ id: 'uuid' })
}

// Every public session field must also have a documented runtime owner.
type MissingOwner = Exclude<keyof TurnSession, typeof TURN_SESSION_FIELDS[number]['name'] | '__createdAt' | '__lastActiveAt'>
export const everySessionFieldHasOwner: MissingOwner extends never ? true : false = true

export function contextContracts(session: TurnSession): void {
  if (session.context?.kind === 'group') session.context.groupId.toUpperCase()
  if (session.context?.kind === 'private') {
    // @ts-expect-error private conversations have no group identity
    session.context.groupId
  }
  // @ts-expect-error context identity must be fully specified
  session.context = { kind: 'group', botId: '1', userId: '2' }
}
