import type { ExecutionConfig } from '../../../contracts/modelExecution.js'

/** Explicit review routing cannot inherit another task's model or silently fall back. */
export function resolveCharacterConsistencyRoute(config: ExecutionConfig): { config: ExecutionConfig; taskBackend: 'characterConsistency' } {
  const backend = config.taskAiConfig?.characterConsistency
  const keys = typeof backend?.apiKey === 'string' ? [backend.apiKey] : backend?.apiKey
  if (!backend || typeof backend.apiUrl !== 'string' || !backend.apiUrl.trim() || typeof backend.model !== 'string' || !backend.model.trim() || !Array.isArray(keys) || !keys.length || keys.some(key => typeof key !== 'string' || !key.trim())) {
    throw new Error('独立审核后端 taskAiConfig.characterConsistency 未配置完整；请明确配置 apiUrl、model、apiKey，未借用其他模型')
  }
  return { config: { ...config, useTools: false }, taskBackend: 'characterConsistency' }
}
