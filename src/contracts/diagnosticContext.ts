export type DiagnosticIncidentStatus = 'asserted' | 'denied' | 'figurative' | 'unknown'
export type DiagnosticSignal = 'burning_odor' | 'smoke' | 'fire' | 'electrical_fault'

export interface DiagnosticSubject {
  kind: 'speaker_device' | 'third_party_device' | 'unspecified_device'
  /** A conversation-local association, not a verified physical asset identifier. */
  key: string
  label: string
  userId?: string
}

export interface DiagnosticSource {
  origin: 'current' | 'history' | 'quote' | 'forward'
  text: string
  subject: DiagnosticSubject
  incidentStatus: DiagnosticIncidentStatus
  signals: DiagnosticSignal[]
  /** Milliseconds since epoch, when the source has an unambiguous timestamp. */
  at?: number
  /** Only recent, timestamped reports can establish transient power/cooling state. */
  transientFactsFresh?: boolean
  userId?: string
  messageId?: string
}

/** Reported preconditions for this device; these are not a remote safety certification. */
export interface DiagnosticContext {
  purpose: 'troubleshooting' | 'discussion' | 'figurative'
  subject: DiagnosticSubject
  incident: { status: DiagnosticIncidentStatus; signals: DiagnosticSignal[] }
  /** off means reported unplugged/isolated, not merely a front-panel shutdown. */
  power: 'unknown' | 'off' | 'on'
  damageExclusion: 'unknown' | 'reported_professional_clearance'
  /** Kinds of checks that may be described after their prerequisites are met. */
  allowedChecks: ('static_observation' | 'operational_monitoring')[]
  unmetPrerequisites: ('power_isolated' | 'cooled' | 'electrical_damage_excluded')[]
  sources: DiagnosticSource[]
}
