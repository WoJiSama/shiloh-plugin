// Legacy settings, bot and metrics composition for typed outbound policy.
import { readUserSettings } from '../configWriter.js'
import { defaultMonitor } from './riskSignalMonitor.js'
import { createOutboundThrottleModule } from '../../dist/backend/modules/messaging/application/outboundThrottle.js'
const throttle = createOutboundThrottleModule({ readUserSettings, getBotRoot: () => globalThis.Bot, logger:globalThis.logger, signalMonitor:defaultMonitor,
 recordCode: (botId,groupId,code) => { try { globalThis[Symbol.for('shiloh-plugin.message-pipeline.runtime')]?.stats?.recordFailure?.({botId,groupId,channel:'risk_throttle',code}) } catch {} }
})
export const isSendAction = throttle.isSendAction
export const computeDelayMs = throttle.computeDelayMs
export const compileWordList = throttle.compileWordList
export const censorOutbound = throttle.censorOutbound
export const createTokenBuckets = throttle.createTokenBuckets
export const readRiskControlConfig = throttle.readRiskControlConfig
export const bucketKeyForHelper = throttle.bucketKeyForHelper
export const installOutboundThrottle = throttle.installOutboundThrottle
