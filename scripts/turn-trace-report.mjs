#!/usr/bin/env node
import { pathToFileURL } from "node:url"
import { buildTurnTraceReport, collectTurnTraceRecords, formatTurnTraceReport } from "../dist/backend/scripts/turnTraceReport.js"

export { buildTurnTraceReport, formatTurnTraceReport }

const direct = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href
if (direct) {
  const { records, fileCount } = collectTurnTraceRecords(process.argv.slice(2))
  if (!records.length) {
    console.log(`没有可分析的 trace 记录（读取了 ${fileCount} 个文件）。先跑一段时间对话，或用 node scripts/turn-trace-report.mjs <文件> 指定输入。`)
  } else {
    console.log(`已读取 ${fileCount} 个文件、${records.length} 条 trace\n`)
    console.log(formatTurnTraceReport(buildTurnTraceReport(records)))
  }
}
