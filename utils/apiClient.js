// Legacy composition only: request routing and response handling live in TypeScript.
// 独立控制台进程没有云崽运行环境:静态导入 dependencies 会拖进整个云崽 lib 并 ENOENT。
// 这里实际只需要 node-fetch;拿不到时用全局 fetch 兜底(模型调用只发生在 bot 进程内)。
let executorFetch = globalThis.fetch
try { executorFetch = (await import('../dependence/dependencies.js')).dependencies.fetch || globalThis.fetch } catch { /* 无云崽环境(独立控制台/本地):用全局 fetch */ }
import { removeToolPromptsFromMessages } from './textUtils.js'
import { resolveChatCompletionUrl } from './chatCompletionUrl.js'
import { resolveAgentBackend, shouldAcceptPlannerTextResponse, summarizeToolResultForAgent } from './agentIntelligence.js'
import { createModelExecutor } from '../dist/backend/modules/models/application/modelExecution.js'
import { recordTokenUsage } from './tokenLedger.js'
const executor = createModelExecutor({
  fetch: executorFetch,
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
