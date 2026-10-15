/** Stable identity and revision of the resolved persona, independent of its display name. */
export interface PersonaIdentity {
  readonly personaId: string
  readonly personaVersion: string
  readonly personaName: string
}

export interface PersonaScope extends PersonaIdentity {
  readonly botId: string
}

export interface PersonaGuardConfig {
  enabled?: boolean
  badPatterns?: string[]
  [key: string]: unknown
}

/** Captured once before asynchronous turn work; all nested configuration is frozen. */
export interface PersonaSnapshot extends PersonaScope {
  readonly persona: Readonly<{name?: string; [key: string]: unknown}>
  readonly systemContent: string
  readonly personaGuard?: PersonaGuardConfig
}
