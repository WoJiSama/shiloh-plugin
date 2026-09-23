// 回合诊断留存测试:环形缓冲、按群过滤、格式化输出、守卫统计快照随回合留存。
import { test, beforeEach } from "node:test"
import assert from "node:assert/strict"
import {
  recordTurnDiagnostics,
  getRecentTurns,
  formatTurnDiagnosticsText,
  clearTurnDiagnostics
} from "../utils/turnDiagnostics.js"
import { resetOutputGuardStats, getOutputGuardStats } from "../utils/outputGuardPipeline.js"

beforeEach(() => {
  clearTurnDiagnostics()
  resetOutputGuardStats()
})

function buildReport(included = [{ name: "memory", chars: 210 }, { name: "personaTone", chars: 480 }]) {
  return {
    profile: "task",
    reason: "intent:search",
    totalChars: included.reduce((sum, item) => sum + item.chars, 0),
    included,
    omitted: ["knowledge"]
  }
}

test("记录与按群过滤,最新在前", () => {
  recordTurnDiagnostics({ groupId: "1", userId: "10", promptLayerReport: buildReport() })
  recordTurnDiagnostics({ groupId: "2", userId: "20", promptLayerReport: buildReport() })
  recordTurnDiagnostics({ groupId: "1", userId: "30", promptLayerReport: buildReport() })

  const all = getRecentTurns()
  assert.equal(all.length, 3)
  assert.equal(all[0].userId, "30", "最新在前")

  const group1 = getRecentTurns("1")
  assert.equal(group1.length, 2)
  assert.ok(group1.every(turn => turn.groupId === "1"))
})

test("环形缓冲上限 20 条,超限淘汰最旧", () => {
  for (let i = 0; i < 25; i++) {
    recordTurnDiagnostics({ groupId: "1", userId: String(i), promptLayerReport: buildReport() })
  }
  const all = getRecentTurns()
  assert.equal(all.length, 20)
  assert.equal(all[0].userId, "24", "最新保留")
  assert.equal(all.at(-1).userId, "5", "最旧被淘汰")
})

test("格式化输出包含分层/路由/守卫三块信息", () => {
  recordTurnDiagnostics({
    groupId: "123",
    userId: "10001",
    promptLayerReport: buildReport(),
    routeApplied: ["imageAnalysis"],
    routeToolChoice: { type: "function", function: { name: "googleImageAnalysisTool" } },
    turnPlan: "chat|search|tools=searchInformationTool"
  })
  const text = formatTurnDiagnosticsText({ groupId: "123" })
  assert.ok(text.includes("[希洛调试]"))
  assert.ok(text.includes("分层:task(intent:search) 2层/690c"))
  assert.ok(text.includes("层明细: memory=210 personaTone=480"))
  assert.ok(text.includes("已裁剪层: knowledge"))
  assert.ok(text.includes("路由: imageAnalysis 最终=googleImageAnalysisTool"))
  assert.ok(text.includes("守卫累计: 应用0次"))
})

test("无回合时给出可行动的提示;无命中回合的路由显示模型自选", () => {
  assert.ok(formatTurnDiagnosticsText({ groupId: "999" }).includes("还没有已记录的回合"))
  recordTurnDiagnostics({ groupId: "1", userId: "1", promptLayerReport: buildReport([]) })
  const text = formatTurnDiagnosticsText({ groupId: "1" })
  assert.ok(text.includes("路由: (模型自选) 最终=auto"))
})

test("守卫统计快照随回合留存:后续增长不影响历史回合的数字", async () => {
  const { applyOutputPersonaGuards } = await import("../utils/outputGuardPipeline.js")
  recordTurnDiagnostics({ groupId: "1", userId: "1", promptLayerReport: buildReport() })
  const before = getRecentTurns()[0].guardStats.applications

  applyOutputPersonaGuards("作为AI，我看了下。", { userText: "看看", botNames: ["希洛"], personaGuard: { enabled: true } })
  assert.equal(getOutputGuardStats().applications, before + 1)

  recordTurnDiagnostics({ groupId: "1", userId: "2", promptLayerReport: buildReport() })
  const turns = getRecentTurns()
  assert.equal(turns[1].guardStats.applications, before, "第一回合留存的是当时快照")
  assert.equal(turns[0].guardStats.applications, before + 1, "第二回合是增长后的快照")
})

test("命令接线:主链路 finally 记录诊断,命令规则已注册", async () => {
  const fs = await import("node:fs")
  const src = fs.readFileSync(new URL("../apps/test.js", import.meta.url), "utf8")
  assert.ok(src.includes("recordTurnDiagnostics({"), "主链路 finally 中记录回合诊断")
  assert.ok(src.includes('reg: "^#希洛调试", fnc: "handleDebugDiagnostics"'), "命令规则已注册")
  assert.ok(src.includes("async handleDebugDiagnostics(e)"), "命令处理方法存在")
})
