import { createExpressionLearnerClass } from '../../dist/backend/modules/memory/application/expressionLearner.js'
export { normalizeExpressionData } from '../../dist/backend/modules/memory/application/expressionLearner.js'
export const ExpressionLearner = createExpressionLearnerClass({ store: { get: key => globalThis.redis.get(key), set: (...args) => globalThis.redis.set(...args) }, logger: { error: message => globalThis.logger?.error?.(message), info: message => globalThis.logger?.info?.(message) }, fetch: (...args) => globalThis.fetch(...args) })
