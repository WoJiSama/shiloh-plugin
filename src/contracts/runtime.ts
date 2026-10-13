/** Capabilities injected at the platform boundary; application state never imports the host. */
export interface RuntimeLogger { warn(message: string): void }
export interface RuntimePorts<Timer, Topic, Social> {
  now(): number
  cancelTimer(timer: Timer): void
  peekTopic(groupId: string): Topic
  peekSocial(groupId: string): Social
  logger?: RuntimeLogger
}
export type RuntimeIdentity = string | number | null | undefined
export interface SmartRuntimeState<Timer> {
  pendingCount: number; lastMsgAt: number; replyLatencies: number[]
  forceContinue: boolean; forceGateCheck: boolean; lastGateNoActionAt: number
  inFlight: boolean; inFlightToken: number; inFlightSince: number; inFlightWatchdog: Timer | null
  needsRerun: boolean; rerunEvent: unknown; queuedWhileInFlight: number; queuedForceGateCheck: boolean
  waitTimers: Map<string, Timer>; conversationPhase: 'cold' | 'focus' | 'fading'; phaseUntil: number
  focusReplyCount: number; consecutiveNoAction: number; lastBotReplyAt: number
  lastBotReplyToUserId: string | number | null; lastBotReplyKeywords: string[]
  recentReplyTimestamps: number[]; recentIncomingTimestamps: number[]
  recentMessages: { userId: string | number; text: string; at: number }[]
  lastRepeatJoinAt: number; deferredTimer: Timer | null
}
export interface SweepOptions { ttlHours?: number }
export type RuntimeSweep = (options: SweepOptions) => number
