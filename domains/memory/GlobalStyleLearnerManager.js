import { createGlobalStyleLearnerClass } from "../../dist/backend/modules/memory/infrastructure/globalStyleLearner.js"
import { buildExpressionObservation } from "../../utils/expressionSequence.js"

export const GlobalStyleLearnerManager = createGlobalStyleLearnerClass({
  botId: () => globalThis.Bot?.uin,
  buildExpressionObservation,
  logger: globalThis.logger
})
export const globalStyleLearnerManager = new GlobalStyleLearnerManager()
