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
}

function record(value: unknown): TraceRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as TraceRecord : {}
}
function records(value: unknown): TraceRecord[] {
  return Array.isArray(value) ? value.map(record) : []
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
  const turns = input.map(record).filter(item => Boolean(item.turnId))
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
    outbound: { total: outbound, avgPerTurn: turns.length ? Math.round(outbound / turns.length * 10) / 10 : 0 }
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
