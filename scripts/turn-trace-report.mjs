#!/usr/bin/env node
/**
 * turn trace 聚合报告：把 data/turn_trace/ 下的 NDJSON 汇总成一次可读的分布图。
 * 用法：node scripts/turn-trace-report.mjs [ndjson 文件或目录 ...]
 * 不带参数时读默认归档目录（plugins/shiloh-plugin/data/turn_trace 或 data/turn_trace）。
 * 也可以在 package.json 里跑：npm run trace:report
 */
import fs from "node:fs"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { resolveTurnTraceArchiveDir } from "../utils/turnTrace.js"

function percentile(sortedValues, p) {
  if (!sortedValues.length) return 0
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1))
  return sortedValues[index]
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const avg = sorted.length ? Math.round(sorted.reduce((sum, item) => sum + item, 0) / sorted.length) : 0
  return { count: sorted.length, avg, p50: percentile(sorted, 50), p95: percentile(sorted, 95) }
}

function tally(getKey, items) {
  const counts = new Map()
  for (const item of items) {
    const key = getKey(item) || "-"
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])
}

export function buildTurnTraceReport(records = []) {
  const turns = records.filter(record => record && record.turnId)
  const modelStageValues = new Map()
  for (const record of turns) {
    for (const call of record.modelCalls || []) {
      if (!call?.stage) continue
      if (!modelStageValues.has(call.stage)) modelStageValues.set(call.stage, [])
      modelStageValues.get(call.stage).push(Number(call.ms) || 0)
    }
  }
  const modelStages = {}
  for (const [stage, values] of modelStageValues) modelStages[stage] = stats(values)

  const toolRuns = turns.flatMap(record => record.tools || [])
  const toolFailures = toolRuns.filter(tool => tool.ok === false)
  return {
    turns: turns.length,
    intents: tally(record => record.intent ? `${record.intent.kind}${record.intent.source === "fast_path_skip" ? "(快路)" : ""}` : "unknown", turns),
    triggers: tally(record => record.trigger?.mode, turns),
    routes: tally(record => record.route ? `${record.route.mode}/${record.route.profile}` : "unknown", turns),
    fastPathSkipCount: turns.filter(record => record.intent?.source === "fast_path_skip").length,
    totalMs: stats(turns.map(record => Number(record.totalMs) || 0).filter(value => value > 0)),
    modelStages,
    tools: {
      runs: toolRuns.length,
      failures: toolFailures.length,
      topFailures: tally(tool => tool.ok === false ? tool.name : "", toolFailures).slice(0, 5)
    },
    failureStages: tally(failure => failure?.stage, turns.flatMap(record => record.failures || [])),
    outbound: {
      total: turns.reduce((sum, record) => sum + (Number(record.outbound) || 0), 0),
      avgPerTurn: turns.length
        ? Math.round((turns.reduce((sum, record) => sum + (Number(record.outbound) || 0), 0) / turns.length) * 10) / 10
        : 0
    }
  }
}

function renderTally(entries, limit = 8) {
  if (!entries.length) return "  (无)"
  return entries.slice(0, limit).map(([key, count]) => `  ${key}: ${count}`).join("\n")
}

export function formatTurnTraceReport(report = {}) {
  const lines = []
  lines.push(`回合数: ${report.turns || 0}  出站消息: ${report.outbound?.total || 0}（均 ${report.outbound?.avgPerTurn || 0} 条/回合）`)
  lines.push(`意图分布:\n${renderTally(report.intents)}`)
  lines.push(`触发来源:\n${renderTally(report.triggers)}`)
  lines.push(`路由 mode/profile:\n${renderTally(report.routes)}`)
  lines.push(`回合总耗时: p50=${report.totalMs?.p50 || 0}ms p95=${report.totalMs?.p95 || 0}ms avg=${report.totalMs?.avg || 0}ms`)
  lines.push("模型调用耗时:")
  for (const [stage, value] of Object.entries(report.modelStages || {})) {
    lines.push(`  ${stage}: n=${value.count} p50=${value.p50}ms p95=${value.p95}ms avg=${value.avg}ms`)
  }
  lines.push(`工具执行: ${report.tools?.runs || 0} 次，失败 ${report.tools?.failures || 0} 次`)
  if (report.tools?.topFailures?.length) lines.push(`失败工具 Top:\n${renderTally(report.tools.topFailures)}`)
  if (report.failureStages?.length) lines.push(`失败阶段:\n${renderTally(report.failureStages)}`)
  return lines.join("\n")
}

function collectRecords(inputPaths = []) {
  const paths = inputPaths.length ? inputPaths : [resolveTurnTraceArchiveDir()]
  const files = []
  for (const input of paths) {
    const stat = fs.statSync(input)
    if (stat.isDirectory()) {
      files.push(...fs.readdirSync(input).filter(name => name.endsWith(".ndjson")).map(name => path.join(input, name)))
    } else if (stat.isFile()) {
      files.push(input)
    }
  }
  const records = []
  for (const file of files) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        records.push(JSON.parse(trimmed))
      } catch {
        // 跳过损坏行
      }
    }
  }
  return { records, fileCount: files.length }
}

let isDirectRun = false
try {
  isDirectRun = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href
} catch {
  // 测试运行器下 argv[1] 不是本脚本，视为模块导入
  isDirectRun = false
}
if (isDirectRun) {
  const { records, fileCount } = collectRecords(process.argv.slice(2))
  if (!records.length) {
    console.log(`没有可分析的 trace 记录（读取了 ${fileCount} 个文件）。先跑一段时间对话，或用 node scripts/turn-trace-report.mjs <文件> 指定输入。`)
    process.exit(0)
  }
  console.log(`已读取 ${fileCount} 个文件、${records.length} 条 trace\n`)
  console.log(formatTurnTraceReport(buildTurnTraceReport(records)))
}
