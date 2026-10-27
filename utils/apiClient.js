// Legacy composition only: request routing and response handling live in TypeScript.
import { dependencies } from '../dependence/dependencies.js'
import { removeToolPromptsFromMessages } from './textUtils.js'
import { resolveChatCompletionUrl } from './chatCompletionUrl.js'
import { resolveAgentBackend, shouldAcceptPlannerTextResponse, summarizeToolResultForAgent } from './agentIntelligence.js'
import { createModelExecutor } from '../dist/backend/modules/models/application/modelExecution.js'
import { recordTokenUsage } from './tokenLedger.js'
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
// 全局用量采集：所有 YTapi 调用都记一行（scope=global；带群上下文的调用点会再记归组行）
const rawYTapi = executor.YTapi
export const YTapi = async (requestData, ...rest) => {
  const startedAt = Date.now()
  const response = await rawYTapi(requestData, ...rest)
  try {
    recordTokenUsage({
      scope: 'global',
      stage: 'api',
      model: response?.model || requestData?.model || '',
      usage: response?.usage,
      ms: Date.now() - startedAt,
    })
  } catch { /* 账本不可用不影响模型调用 */ }
  return response
}
export const resolveConfiguredTaskBackend = executor.resolveConfiguredTaskBackend
