import { createModelExecutor } from '../../dist/backend/modules/models/application/modelExecution.js'
import { removeToolPromptsFromMessages } from '../../utils/textUtils.js'
import { resolveChatCompletionUrl } from '../../utils/chatCompletionUrl.js'
import { resolveAgentBackend, shouldAcceptPlannerTextResponse, summarizeToolResultForAgent } from '../../utils/agentIntelligence.js'
export function modelExecutor(fetcher = fetch) {
  return createModelExecutor({ fetch: fetcher, logger: { info() {}, warn() {}, error() {} }, removeToolPromptsFromMessages,
    resolveChatCompletionUrl, resolveAgentBackend,
    shouldAcceptPlannerTextResponse, summarizeToolResultForAgent })
}
