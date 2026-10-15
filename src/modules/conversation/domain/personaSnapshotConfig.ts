import type {PersonaGuardConfig, PersonaSnapshot} from '../../../contracts/persona.js'

interface PersonaConfigFields {
  persona?: PersonaSnapshot['persona']
  systemContent?: string
  personaGuard?: PersonaGuardConfig | undefined
}

/** Keep provider/runtime settings live while pinning this turn's personality. */
export function withPersonaSnapshot<T extends object>(
  config: T,
  event?: {_personaSnapshot?: PersonaSnapshot} | null
): Omit<T, keyof PersonaConfigFields> & PersonaConfigFields {
  const snapshot = event?._personaSnapshot
  if (!snapshot) return config
  return {
    ...config,
    persona: snapshot.persona,
    systemContent: snapshot.systemContent,
    // Missing guard is a captured choice too; never inherit a newly loaded guard.
    personaGuard: snapshot.personaGuard
  }
}
