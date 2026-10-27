import { createGlobalStyleLearnerClass } from "../../dist/backend/modules/memory/infrastructure/globalStyleLearner.js"
import { buildExpressionObservation } from "../../utils/expressionSequence.js"

export const GlobalStyleLearnerManager = createGlobalStyleLearnerClass({
  botId: () => { const u = globalThis.Bot?.uin; return Array.isArray(u) ? u.join(',') : u },
  buildExpressionObservation,
  logger: globalThis.logger
})
export const globalStyleLearnerManager = new GlobalStyleLearnerManager()
