import { MessageStatsEmitter as TypedEmitter, createStatsEmitterFromSettings as createTypedEmitter } from '../dist/backend/modules/messaging/application/messageStats.js'
export { statsDayKey, statsHourKey, readDailyStats } from '../dist/backend/modules/messaging/application/messageStats.js'
export class MessageStatsEmitter extends TypedEmitter { constructor(options = {}) { super({ redis: globalThis.redis, logger: globalThis.logger, ...options }) } }
export function createStatsEmitterFromSettings(options = {}) { return createTypedEmitter({ redis: globalThis.redis, logger: globalThis.logger, ...options }, MessageStatsEmitter) }
