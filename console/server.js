#!/usr/bin/env node
import { ensureBackendArtifacts } from "../utils/backendArtifactGuard.js"
await ensureBackendArtifacts()
const { createConsoleServer } = await import("../dist/backend/modules/platform/infrastructure/console/consoleServer.js")
const { buildTurnTraceReport } = await import("../dist/backend/scripts/turnTraceReport.js")
const pluginRoot = process.env.CONSOLE_PLUGIN_ROOT || new URL("..", import.meta.url).pathname.replace(/\/$/, "")
// 可选装配：令牌账本与仿真运行时依赖 Yunzai 运行环境（model/config 等），
// 在测试夹具/独立部署目录下可能不可用——降级为不接（对应控制台路由返回 503）。
let tokens = null
let simulation = null
try {
  const { tokenLedger } = await import("../utils/tokenLedger.js")
  tokens = {
    summary: () => tokenLedger.summary(),
    series: (hours) => tokenLedger.series(hours),
    recent: (limit) => tokenLedger.recent(limit),
  }
} catch (error) {
  console.warn?.(`[console] 令牌账本不可用（相关页面将显示未启用）：${error?.message || error}`)
}
try {
  const { simulationRuntime } = await import("../utils/simulationRuntime.js")
  simulation = {
    overview: () => simulationRuntime.overview(),
    describeGroup: groupId => simulationRuntime.describeGroup(groupId),
    setGroup: (groupId, action) => action === "enable" ? simulationRuntime.enableGroup(groupId)
      : action === "disable" ? simulationRuntime.disableGroup(groupId)
        : simulationRuntime.resetGroup(groupId),
    setInitialPrompt: (groupId, text) => simulationRuntime.setInitialPrompt(groupId, text),
  }
} catch (error) {
  console.warn?.(`[console] 仿真运行时不可用（相关页面将显示未启用）：${error?.message || error}`)
}
let style = null
try {
  const { globalStyleLearnerManager } = await import("../domains/memory/GlobalStyleLearnerManager.js")
  const { ExpressionLearner } = await import("../domains/memory/ExpressionLearner.js")
  const { readPluginSettings } = await import("../utils/simulationRuntime.js")
  const expressionLearner = new ExpressionLearner()
  style = {
    overview: async (groups) => {
      const settings = readPluginSettings()
      const cfg = settings.globalStyleLearning || {}
      const prompt = globalStyleLearnerManager.buildPrompt(cfg)
      const memory = globalStyleLearnerManager.readMemory(cfg)
      return {
        enabled: cfg.enabled !== false,
        autoSummaryEnabled: cfg.autoSummaryEnabled !== false,
        totalSamples: Number(memory?.totalSamples) || 0,
        aiRules: {
          absorb: (memory?.aiRules?.absorb || []).map(r => ({ key: r.key, label: r.label, rule: r.rule, confidence: r.confidence })),
          avoid: (memory?.aiRules?.avoid || []).map(r => ({ key: r.key, label: r.label, rule: r.rule, confidence: r.confidence })),
        },
        promptPreview: prompt.slice(0, 2000),
        groups: await Promise.all((groups || []).slice(0, 30).map(async groupId => {
          try {
            return { groupId, expressions: await expressionLearner.getGroupExpressionsSnapshot(String(groupId)) }
          } catch { return { groupId, expressions: null } }
        })),
      }
    },
    blockWord: async (groupId, word) => {
      expressionLearner.addBlockedWords([String(word || '')])
      return true
    },
    removeGlobalRule: (kind, key) => {
      globalStyleLearnerManager.removeAiRule(kind, key)
      return true
    },
  }
} catch (error) {
  console.warn?.(`[console] 风格学习视图不可用：${error?.message || error}`)
}
const app = createConsoleServer({ pluginRoot, buildTurnTraceReport, tokens, simulation, style })
app.listen()
