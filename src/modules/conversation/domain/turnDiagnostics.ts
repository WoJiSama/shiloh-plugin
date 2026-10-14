import type {ToolChoice} from '../../../contracts/turnPlan.js'
interface DiagnosticInput {at?:number;groupId?:unknown;userId?:unknown;turnId?:string;promptLayerReport?:{profile?:string;reason?:string;included?:{name:string;chars:number}[];totalChars?:number;omitted?:string[]};routeApplied?:string[];routeToolChoice?:ToolChoice;turnPlan?:string;modelCalls?:{stage:string;ms:number}[];tools?:{name:string;ok:boolean;ms:number}[]}
interface Diagnostic {at:number;groupId:string;userId:string;turnId:string;profile:string;layerReason:string;layerCount:number;layerTotalChars:number;layerDetail:string;omittedLayers:string[];routeApplied:string[];routeTool:string;turnPlan:string;modelCalls:{stage:string;ms:number}[];tools:{name:string;ok:boolean;ms:number}[];guardStats:ReturnType<ReturnType<typeof createOutputGuardPipeline>["getOutputGuardStats"]>}
// 回合诊断环形缓冲:把每回合的提示词分层报告、路由命中轨迹、执行计划摘要
// 保留最近若干条,供 #希洛调试 命令回显。数据源全部来自既有观测产物
// (turnPromptComposer 的 report、routeDecision 的 applied、turnPlan 日志、输出守卫统计),
// 本模块只做留存与格式化,不参与任何主链路决策。
import type {createOutputGuardPipeline} from "../application/outputGuardPipeline.js"
export function createTurnDiagnostics(getOutputGuardStats:ReturnType<typeof createOutputGuardPipeline>["getOutputGuardStats"]) {

const MAX_TURNS = 20
const turns:Diagnostic[] = []

function toolChoiceName(toolChoice:ToolChoice|undefined) {
  if (typeof toolChoice === "string") return toolChoice
  return toolChoice?.function?.name || "auto"
}

function recordTurnDiagnostics(entry:DiagnosticInput = {}) {
  turns.push({
    at: entry.at || Date.now(),
    groupId: entry.groupId ? String(entry.groupId) : "",
    userId: entry.userId ? String(entry.userId) : "",
    turnId: entry.turnId || "",
    profile: entry.promptLayerReport?.profile || "",
    layerReason: entry.promptLayerReport?.reason || "",
    layerCount: entry.promptLayerReport?.included?.length ?? 0,
    layerTotalChars: entry.promptLayerReport?.totalChars ?? 0,
    layerDetail: (entry.promptLayerReport?.included || [])
      .map(item => `${item.name}=${item.chars}`)
      .join(" "),
    omittedLayers: entry.promptLayerReport?.omitted || [],
    routeApplied: entry.routeApplied || [],
    routeTool: toolChoiceName(entry.routeToolChoice),
    turnPlan: entry.turnPlan || "",
    modelCalls: Array.isArray(entry.modelCalls) ? entry.modelCalls.slice(0, 12) : [],
    tools: Array.isArray(entry.tools) ? entry.tools.slice(0, 12) : [],
    guardStats: getOutputGuardStats()
  })
  while (turns.length > MAX_TURNS) turns.shift()
  return turns.length
}

function getRecentTurns(groupId:unknown) {
  const key = groupId ? String(groupId) : ""
  return [...turns].reverse().filter(turn => !key || turn.groupId === key)
}

function clearTurnDiagnostics() {
  turns.length = 0
}

function formatTime(at:number) {
  const date = new Date(at)
  const pad = (value:number) => String(value).padStart(2, "0")
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function formatTurnDiagnosticsText({ groupId = "", limit = 3 }: {groupId?:string|number;limit?:number} = {}) {
  const recent = getRecentTurns(groupId).slice(0, Math.max(1, limit))
  if (!recent.length) {
    return `[希洛调试] 还没有已记录的回合${groupId ? `(群 ${groupId})` : ""}。让我回一轮消息后再看。`
  }
  const lines = [`[希洛调试] 最近 ${recent.length} 回合${groupId ? `(群 ${groupId})` : ""}:`]
  recent.forEach((turn, index) => {
    lines.push(
      `#${index + 1} ${formatTime(turn.at)} 用户=${turn.userId || "?"} ` +
      `分层:${turn.profile || "?"}${turn.layerReason ? `(${turn.layerReason})` : ""} ` +
      `${turn.layerCount}层/${turn.layerTotalChars}c`
    )
    if (turn.layerDetail) lines.push(`   层明细: ${turn.layerDetail}`)
    if (turn.omittedLayers?.length) lines.push(`   已裁剪层: ${turn.omittedLayers.join(",")}`)
    lines.push(
      `   路由: ${turn.routeApplied.length ? turn.routeApplied.join("→") : "(模型自选)"} ` +
      `最终=${turn.routeTool}`
    )
    if (turn.turnPlan) lines.push(`   计划: ${turn.turnPlan}`)
    if (turn.modelCalls?.length || turn.tools?.length) {
      const callParts = turn.modelCalls.map(call => `${call.stage}=${(call.ms || 0) / 1000 < 10 ? ((call.ms || 0) / 1000).toFixed(1) + "s" : Math.round((call.ms || 0) / 1000) + "s"}`)
      const toolParts = turn.tools.map(tool => `${tool.name}${tool.ok ? "" : "!"}=${((tool.ms || 0) / 1000).toFixed(1)}s`)
      lines.push(`   耗时: 模型[${callParts.join(" ")}] 工具[${toolParts.join(" ") || "-"}]`)
    }
  })
  const latest = recent[0]!
  const guard = latest.guardStats || getOutputGuardStats()
  const guardLine =
    `守卫累计: 应用${guard.applications}次 ` +
    `润色${guard.stageHits.polish}/-${guard.charsRemoved.polish}c ` +
    `语气边界${guard.stageHits.toneBoundary}/-${guard.charsRemoved.toneBoundary}c ` +
    `坏模式${guard.stageHits.guardReply}/-${guard.charsRemoved.guardReply}c`
  lines.push(guardLine)
  const topPatterns = Object.entries(guard.patternHits || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([pattern, count]) => `${pattern}×${count}`)
    .join("、")
  if (topPatterns) lines.push(`高频坏模式: ${topPatterns}`)
  return lines.join("\n")
}

return {recordTurnDiagnostics,getRecentTurns,clearTurnDiagnostics,formatTurnDiagnosticsText}
}
