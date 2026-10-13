import { normalizeAiProviderUpdates, withAiProviderPanelDefaults, getProviderDefinition, getConfiguredProviders } from '../domain/aiProviderConfig.js'
import type { PanelProvider } from '../domain/aiProviderConfig.js'
export interface PanelResult {
 ok(data: unknown, message: string): unknown
 error(message: string): unknown
}
interface ProbeSummary { allOk: boolean; text: string }
export interface ConfigPanelPorts {
 readSettings(): unknown
 applyUpdates(updates: Record<string, unknown>): unknown
 probeProviders(providers: PanelProvider[], kind: string): Promise<unknown[]>
 classifyKind(configKey: string): string
 summarizeProbes(results: unknown[]): ProbeSummary
 logger?: { info(message: string): void; error(message: string): void }
}
function message(error: unknown) { return error instanceof Error ? error.message : String(error) }
export function createConfigPanel(ports: ConfigPanelPorts) {
 function getConfigData() { return withAiProviderPanelDefaults(ports.readSettings()) }
 function setConfigData(data: unknown, { Result }: { Result: PanelResult }) {
  try { ports.applyUpdates(normalizeAiProviderUpdates(data, ports.readSettings())); return Result.ok({}, '保存成功 (´。• ᵕ •。`)') }
  catch (error) { return Result.error(`保存失败: ${message(error)}`) }
 }
 async function testAiProviders(args: unknown[] = [], { Result }: { Result: PanelResult }) {
  try {
   const configKey = String(args[0] || '')
   const definition = getProviderDefinition(configKey)
   if (!definition) return Result.error(`未知的模型配置：${configKey || '(空)'}。请用按钮自带参数，不要改动 action。`)
   const providers = getConfiguredProviders(getConfigData()[configKey], definition)
   if (!providers.length) return Result.error(`${definition.title} 还没有已保存的模型：先填写并保存，再点测试。`)
   const results = await ports.probeProviders(providers, ports.classifyKind(configKey))
   const { allOk, text } = ports.summarizeProbes(results)
   ports.logger?.info(`[锅巴测试] ${configKey}: ${text}`)
   return allOk ? Result.ok(results, text) : Result.error(text)
  } catch (error) { ports.logger?.error(`[锅巴测试] 执行失败: ${message(error)}`); return Result.error(`测试执行失败：${message(error)}`) }
 }
 return { getConfigData, setConfigData, testAiProviders }
}
