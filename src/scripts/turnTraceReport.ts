import fs from 'node:fs'
import path from 'node:path'
import { resolveTurnTraceArchiveDir } from '../modules/conversation/infrastructure/turnTrace.js'

export type TraceRecord = Record<string, unknown>
export type TallyEntry = [string, number]
export interface TraceStats { count: number; avg: number; p50: number; p95: number }
export interface TurnTraceReport {
  turns: number
  intents: TallyEntry[]
  triggers: TallyEntry[]
  routes: TallyEntry[]
  fastPathSkipCount: number
  totalMs: TraceStats
  modelStages: Record<string, TraceStats>
  tools: { runs: number; failures: number; topFailures: TallyEntry[] }
  failureStages: TallyEntry[]
  outbound: { total: number; avgPerTurn: number }
  toolRouting: { trackedTurns: number; destinations: TallyEntry[]; lossStages: TallyEntry[]; intentionalReductions: TallyEntry[]; reductionReasons: TallyEntry[]; removedTools: TallyEntry[]; plannerStatuses: TallyEntry[]; routeRules: TallyEntry[] }
  intentShadow: { samples: number; mismatches: number; statuses: TallyEntry[] }
}

function record(value: unknown): TraceRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as TraceRecord : {}
}
function records(value: unknown): TraceRecord[] {
  return Array.isArray(value) ? value.map(record) : []
}
function names(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && Boolean(item)))] : []
}
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1))
  return sorted[index] ?? 0
}
function stats(values: number[]): TraceStats {
  const sorted = [...values].sort((a, b) => a - b)
  const avg = sorted.length ? Math.round(sorted.reduce((sum, value) => sum + value, 0) / sorted.length) : 0
  return { count: sorted.length, avg, p50: percentile(sorted, 50), p95: percentile(sorted, 95) }
}
function tally(getKey: (item: TraceRecord) => unknown, items: TraceRecord[]): TallyEntry[] {
  const counts = new Map<string, number>()
  for (const item of items) {
    const key = String(getKey(item) || '-')
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1])
}

export function buildTurnTraceReport(input: unknown[] = []): TurnTraceReport {
  const entries = input.map(record).filter(item => Boolean(item.turnId) || item.event === 'intent_shadow' && Boolean(item.parentTurnId))
  const turns = entries.filter(item => Boolean(item.turnId) && item.event !== 'intent_shadow')
  const shadows = new Map<string, TraceRecord>()
  for (const entry of entries) {
    if (record(entry.intentShadow).status) shadows.set(String(entry.parentTurnId || entry.turnId), record(entry.intentShadow))
  }
  const routing: TraceRecord[] = turns.filter(turn => Object.keys(record(turn.toolRouting)).length > 0)
    .map(turn => ({...record(turn.toolRouting), routeReason: record(turn.route).reason}))
  const losses: TraceRecord[] = []
  const intentionalReductions: TraceRecord[] = []
  const reductionReasons: TraceRecord[] = []
  const removedTools: TraceRecord[] = []
  for (const item of routing) {
    const planner = record(item.planner)
    const normalizedNoAction = planner.reason === 'normalized_no_action'
    if (normalizedNoAction) {
      // Normalization may have rejected an unavailable tool or invalid target
      // before beforeFilter was captured. It is not an explicit chat decision,
      // and empty downstream snapshots must not hide the planner transition.
      losses.push({stage: 'planner'})
      reductionReasons.push({key: 'planner/normalized_no_action'})
    }
    for (const [stage, before, after] of [['filter', 'beforeFilter', 'afterFilter'], ['plan', 'afterFilter', 'finalTools'], ['request', 'finalTools', 'requestTools']] as const) {
      // A deterministic call bypasses the main model. An empty requestTools is
      // expected there, and incomplete legacy records cannot prove a loss.
      if (stage === 'request' && item.executionPath === 'forced') continue
      if (!Array.isArray(item[before]) || !Array.isArray(item[after])) continue
      const kept = new Set(names(item[after]))
      const removed = names(item[before]).filter(name => !kept.has(name))
      if (removed.length) {
        // Preserve interpretation of old traces without a reason while giving
        // the new validation-fallback reason precedence over semantic_chat.
        const explicitChat = !normalizedNoAction && (planner.status === 'chat' || item.routeReason === 'semantic_chat')
        const selected = typeof item.toolChoice === 'string' && !['auto', 'none'].includes(item.toolChoice) && names(item.finalTools).includes(item.toolChoice)
        const selectionReduction = stage === 'plan' && (selected || item.executionPath === 'forced' && names(item.finalTools).length > 0)
        const reason = normalizedNoAction ? 'normalized_no_action' : explicitChat ? 'explicit_chat' : selectionReduction ? 'selected_tool' : String(item.routeReason || planner.status || 'unclassified')
        reductionReasons.push({key: `${stage}/${reason}`})
        if (!normalizedNoAction) {
          if (explicitChat || selectionReduction) intentionalReductions.push({key: `${stage}/${reason}`})
          else losses.push({stage})
        }
      }
      removedTools.push(...removed.map(name => ({key: `${stage}/${name}`})))
    }
  }
  const modelValues = new Map<string, number[]>()
  for (const turn of turns) {
    for (const call of records(turn.modelCalls)) {
      if (!call.stage) continue
      const stage = String(call.stage)
      const values = modelValues.get(stage) || []
      values.push(Number(call.ms) || 0)
      modelValues.set(stage, values)
    }
  }
  const modelStages: Record<string, TraceStats> = {}
  for (const [stage, values] of modelValues) modelStages[stage] = stats(values)
  const toolRuns = turns.flatMap(turn => records(turn.tools))
  const failures = toolRuns.filter(tool => tool.ok === false)
  const outbound = turns.reduce((sum, turn) => sum + (Number(turn.outbound) || 0), 0)
  return {
    turns: turns.length,
    intents: tally(turn => {
      const intent = record(turn.intent)
      return turn.intent ? `${intent.kind}${intent.source === 'fast_path_skip' ? '(快路)' : ''}` : 'unknown'
    }, turns),
    triggers: tally(turn => record(turn.trigger).mode, turns),
    routes: tally(turn => {
      const route = record(turn.route)
      return turn.route ? `${route.mode}/${route.profile}` : 'unknown'
    }, turns),
    fastPathSkipCount: turns.filter(turn => record(turn.intent).source === 'fast_path_skip').length,
    totalMs: stats(turns.map(turn => Number(turn.totalMs) || 0).filter(value => value > 0)),
    modelStages,
    tools: { runs: toolRuns.length, failures: failures.length, topFailures: tally(tool => tool.name, failures).slice(0, 5) },
    failureStages: tally(failure => failure.stage, turns.flatMap(turn => records(turn.failures))),
    outbound: { total: outbound, avgPerTurn: turns.length ? Math.round(outbound / turns.length * 10) / 10 : 0 },
    toolRouting: {
      trackedTurns: routing.length,
      destinations: tally(item => {
        if (item.executionPath === 'forced') return 'forced_call'
        if (Array.isArray(item.requestTools)) return names(item.requestTools).length && item.toolChoice !== 'none' ? 'gateway_input_tools' : 'gateway_input_text'
        if (!Array.isArray(item.finalTools)) return 'unknown'
        // A plan can exist even when execution fails before gateway dispatch.
        return names(item.finalTools).length && item.toolChoice !== 'none' ? 'planned_tools' : 'planned_text'
      }, routing),
      // These are observed reductions, not labelled false negatives. Narrowing
      // to a selected tool or honoring explicit chat is often correct behavior.
      lossStages: tally(item => item.stage, losses),
      intentionalReductions: tally(item => item.key, intentionalReductions),
      reductionReasons: tally(item => item.key, reductionReasons),
      removedTools: tally(item => item.key, removedTools),
      plannerStatuses: tally(item => record(item.planner).status, routing.filter(item => record(item.planner).status)),
      routeRules: tally(item => item.name, routing.flatMap(item => names(item.applied).map(name => ({name}))))
    },
    intentShadow: { samples: shadows.size, mismatches: [...shadows.values()].filter(item => item.status === 'mismatch').length, statuses: tally(item => item.status, [...shadows.values()]) }
  }
}

function renderTally(entries: TallyEntry[] | undefined, limit = 8): string {
  if (!entries?.length) return '  (无)'
  return entries.slice(0, limit).map(([key, count]) => `  ${key}: ${count}`).join('\n')
}
export function formatTurnTraceReport(report: Partial<TurnTraceReport> = {}): string {
  const lines = [
    `回合数: ${report.turns || 0}  出站消息: ${report.outbound?.total || 0}（均 ${report.outbound?.avgPerTurn || 0} 条/回合）`,
    `意图分布:\n${renderTally(report.intents)}`,
    `触发来源:\n${renderTally(report.triggers)}`,
    `路由 mode/profile:\n${renderTally(report.routes)}`,
    `回合总耗时: p50=${report.totalMs?.p50 || 0}ms p95=${report.totalMs?.p95 || 0}ms avg=${report.totalMs?.avg || 0}ms`,
    '模型调用耗时:'
  ]
  for (const [stage, value] of Object.entries(report.modelStages || {})) {
    lines.push(`  ${stage}: n=${value.count} p50=${value.p50}ms p95=${value.p95}ms avg=${value.avg}ms`)
  }
  lines.push(`工具执行: ${report.tools?.runs || 0} 次，失败 ${report.tools?.failures || 0} 次`)
  if (report.toolRouting?.trackedTurns) {
    lines.push(`工具路由观测: ${report.toolRouting.trackedTurns} 回合\n${renderTally(report.toolRouting.destinations)}`)
    lines.push('requestTools = 模型网关入口暴露；不代表最终后端已消费，后续文字降级未追踪。')
    lines.push(`待复核的工具集合收窄环节（不等于漏调）:\n${renderTally(report.toolRouting.lossStages)}`)
    if (report.toolRouting.intentionalReductions.length) lines.push(`明确不执行或选中工具后的收窄:\n${renderTally(report.toolRouting.intentionalReductions)}`)
    if (report.toolRouting.reductionReasons.length) lines.push(`收窄原因:\n${renderTally(report.toolRouting.reductionReasons)}`)
    if (report.toolRouting.removedTools.length) lines.push(`被移除的工具:\n${renderTally(report.toolRouting.removedTools)}`)
    if (report.toolRouting.plannerStatuses.length) lines.push(`规划器状态:\n${renderTally(report.toolRouting.plannerStatuses)}`)
    if (report.toolRouting.routeRules.length) lines.push(`命中路由规则:\n${renderTally(report.toolRouting.routeRules)}`)
  }
  if (report.intentShadow?.samples) lines.push(`快路影子: ${report.intentShadow.samples} 次，分歧 ${report.intentShadow.mismatches} 次（分歧需复核）\n${renderTally(report.intentShadow.statuses)}`)
  if (report.tools?.topFailures?.length) lines.push(`失败工具 Top:\n${renderTally(report.tools.topFailures)}`)
  if (report.failureStages?.length) lines.push(`失败阶段:\n${renderTally(report.failureStages)}`)
  return lines.join('\n')
}

export function collectTurnTraceRecords(inputPaths: string[] = []): { records: TraceRecord[]; fileCount: number } {
  const inputs = inputPaths.length ? inputPaths : [resolveTurnTraceArchiveDir()]
  const files: string[] = []
  for (const input of inputs) {
    const stat = fs.statSync(input)
    if (stat.isDirectory()) {
      files.push(...fs.readdirSync(input).filter(name => name.endsWith('.ndjson')).map(name => path.join(input, name)))
    } else if (stat.isFile()) files.push(input)
  }
  const output: TraceRecord[] = []
  for (const file of files) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try { output.push(record(JSON.parse(trimmed))) }
      catch { /* Skip a damaged NDJSON line; retain valid records. */ }
    }
  }
  return { records: output, fileCount: files.length }
}
