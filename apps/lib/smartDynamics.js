import { createSmartDynamics } from '../../dist/backend/modules/conversation/domain/smartDynamics.js'
const dynamics=createSmartDynamics({info:message=>globalThis.logger?.info?.(message)})
export const resolveConversationPhase=dynamics.resolveConversationPhase
export const applyRateLimitGuard=dynamics.applyRateLimitGuard
export const resolveTalkValue=dynamics.resolveTalkValue
export const idleCompensationMet=dynamics.idleCompensationMet
export const computeAvgReplyLatency=dynamics.computeAvgReplyLatency
export const recordReplyLatency=dynamics.recordReplyLatency
export const computeGroupMsgRate5min=dynamics.computeGroupMsgRate5min
export const getDirectTriggerMergeMs=dynamics.getDirectTriggerMergeMs
export const getDirectTriggerMergeMaxMessages=dynamics.getDirectTriggerMergeMaxMessages
