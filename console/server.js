#!/usr/bin/env node
import path from "node:path"
import { ensureBackendArtifacts } from "../utils/backendArtifactGuard.js"
await ensureBackendArtifacts()
const { createConsoleServer } = await import("../dist/backend/modules/platform/infrastructure/console/consoleServer.js")
const { buildTurnTraceReport } = await import("../dist/backend/scripts/turnTraceReport.js")
const pluginRoot = process.env.CONSOLE_PLUGIN_ROOT || new URL("..", import.meta.url).pathname.replace(/\/$/, "")
// 尽早固定插件根:令牌账本/仿真 shim 都按此环境变量解析数据目录,独立进程 cwd 不可靠
process.env.CONSOLE_PLUGIN_ROOT = pluginRoot
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
    setGroupBudget: (groupId, cap) => simulationRuntime.setGroupBudget(groupId, cap),
    setGroupTurnsCap: (groupId, cap) => simulationRuntime.setGroupTurnsCap(groupId, cap),
    setReplyMode: (groupId, mode) => simulationRuntime.setGroupReplyMode(groupId, mode),
    setDefaultBudget: (cny) => simulationRuntime.setDefaultBudget(cny),
    listPersonProfiles: () => simulationRuntime.listPersonProfiles(),
    deletePersonProfile: (userId) => simulationRuntime.deletePersonProfile(userId),
    deletePersonProfileField: (userId, field, value) => simulationRuntime.deletePersonProfileField(userId, field, value),
    lifeOverview: () => simulationRuntime.lifeOverview?.() ?? { rhythm: { sleepFrom: 1, sleepTo: 8 }, threads: [], now: { hour: 0, sleeping: false } },
    setLifeRhythm: (from, to) => simulationRuntime.setLifeRhythm?.(from, to) ?? '未接入',
  }
} catch (error) {
  console.warn?.(`[console] 仿真运行时不可用（相关页面将显示未启用）：${error?.message || error}`)
}
let style = null
try {
  const { GlobalStyleLearnerManager } = await import("../domains/memory/GlobalStyleLearnerManager.js")
  const { ExpressionLearner } = await import("../domains/memory/ExpressionLearner.js")
  const { readPluginSettings, lazyRedis } = await import("../utils/simulationRuntime.js")
  // 控制台是独立进程，cwd 是插件目录：
  // 1) 全局风格学习的文件路径按「cwd/plugins/shiloh-plugin/...」拼接——必须用云崽根构造实例才能与 bot 进程读写同一文件
  // 2) ExpressionLearner 走 globalThis.redis——独立进程没有，按需自建本机连接（与仿真端口同款惰性代理）
  if (!globalThis.redis) globalThis.redis = lazyRedis()
  const styleLearner = new GlobalStyleLearnerManager({ cwd: path.resolve(pluginRoot, "..", "..") })
  const expressionLearner = new ExpressionLearner()
  style = {
    overview: async (groups) => {
      const settings = readPluginSettings()
      const cfg = settings.globalStyleLearning || {}
      const prompt = styleLearner.buildPrompt(cfg)
      const memory = styleLearner.readMemory(cfg)
      return {
        enabled: cfg.enabled !== false,
        autoSummaryEnabled: cfg.autoSummaryEnabled !== false,
        totalSamples: Number(memory?.totalSamples) || 0,
        // 活性信号：最近一次 AI 总结与最近一次观察落盘（区分「没学到」与「视图坏了」）
        lastSummaryAt: String(memory?.aiSummary?.lastAt || memory?.aiSummary?.lastAutoAt || ''),
        memoryUpdatedAt: String(memory?.updatedAt || ''),
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
      styleLearner.removeAiRule(kind, key)
      return true
    },
  }
} catch (error) {
  console.warn?.(`[console] 风格学习视图不可用：${error?.message || error}`)
}
const app = createConsoleServer({ pluginRoot, buildTurnTraceReport, tokens, simulation, style })
app.listen()
