// Legacy composition only: request routing and response handling live in TypeScript.
import { dependencies } from '../dependence/dependencies.js'
import { removeToolPromptsFromMessages } from './textUtils.js'
import { resolveChatCompletionUrl } from './chatCompletionUrl.js'
import { resolveAgentBackend, shouldAcceptPlannerTextResponse, summarizeToolResultForAgent } from './agentIntelligence.js'
import { createModelExecutor } from '../dist/backend/modules/models/application/modelExecution.js'
const executor = createModelExecutor({
  fetch: dependencies.fetch,
  logger: {
    info: (...values) => globalThis.logger?.info?.(...values),
    warn: (...values) => globalThis.logger?.warn?.(...values),
    error: (...values) => globalThis.logger?.error?.(...values)
  },
  removeToolPromptsFromMessages,
  resolveChatCompletionUrl, resolveAgentBackend, shouldAcceptPlannerTextResponse, summarizeToolResultForAgent
})
export const YTapi = executor.YTapi
export const resolveConfiguredTaskBackend = executor.resolveConfiguredTaskBackend
