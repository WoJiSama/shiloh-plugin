import { schemas, getConfigData, setConfigData } from "./schemas/index.js"
import { getProviderDefinition, getConfiguredProviders, withAiProviderPanelDefaults } from "../../utils/guobaAiProviderConfig.js"
import { readUserSettings } from "../../utils/configWriter.js"
import { classifyConfigKind, probeProviders, summarizeProbes } from "../../utils/aiProviderProbe.js"

// 锅巴「测试连通性」按钮的后端 action：
// 前端 GButtons -> POST /plugin/do/{pluginName}/action -> 此处执行 -> toast 显示结果。
async function testAiProviders(args = [], { Result }) {
  try {
    const configKey = String(args?.[0] || "")
    const definition = getProviderDefinition(configKey)
    if (!definition) return Result.error(`未知的模型配置：${configKey || "(空)"}。请用按钮自带参数，不要改动 action。`)
    // 旧版扁平字段（chatApiUrl 等）先同步成 providers 形状，与面板展示一致
    const settings = withAiProviderPanelDefaults(readUserSettings())
    const providers = getConfiguredProviders(settings[configKey] || {}, definition)
    if (!providers.length) return Result.error(`${definition.title} 还没有已保存的模型：先填写并保存，再点测试。`)
    const kind = classifyConfigKind(configKey)
    const results = await probeProviders(providers, kind)
    const { allOk, text } = summarizeProbes(results)
    globalThis.logger?.info?.(`[锅巴测试] ${configKey}: ${text}`)
    return allOk ? Result.ok(results, text) : Result.error(text)
  } catch (error) {
    globalThis.logger?.error?.(`[锅巴测试] 执行失败: ${error?.stack || error}`)
    return Result.error(`测试执行失败：${error?.message || error}`)
  }
}

export const configInfo = {
  schemas,
  getConfigData,
  setConfigData,
  actions: {
    testAiProviders
  }
}
