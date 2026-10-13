import { createEmotionManagerClass } from '../../dist/backend/modules/memory/application/emotionManager.js'
export const EmotionManager = createEmotionManagerClass({ store: { get: key => globalThis.redis.get(key), set: (...args) => globalThis.redis.set(...args) }, logger: { error: message => globalThis.logger?.error?.(message), debug: message => globalThis.logger?.debug?.(message) } })
