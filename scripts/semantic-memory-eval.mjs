#!/usr/bin/env node
// 语义记忆离线工具:全量回填索引 / 检索质量评估(recall@k 消融)。
// 与线上命令共用同一套模块,可在 yunzai 根目录独立运行:
//   node plugins/shiloh-plugin/scripts/semantic-memory-eval.mjs --rebuild
//   node plugins/shiloh-plugin/scripts/semantic-memory-eval.mjs --samples 30
//   node plugins/shiloh-plugin/scripts/semantic-memory-eval.mjs --group 763694201 --rebuild
import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"

const cwd = process.cwd()
const args = process.argv.slice(2)
const flag = name => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : ""
}

function readPluginSettings() {
  const userPath = path.join(cwd, "plugins/shiloh-plugin/config/message.yaml")
  const defaultPath = path.join(cwd, "plugins/shiloh-plugin/config_default/message.yaml")
  for (const file of [userPath, defaultPath]) {
    try {
      const settings = YAML.parse(fs.readFileSync(file, "utf8"))?.pluginSettings
      if (settings?.semanticMemory) return settings
    } catch {}
  }
  throw new Error("未找到 semanticMemory 配置(plugins/shiloh-plugin/config/message.yaml)")
}

const { MessageArchiveManager } = await import("../utils/MessageArchiveManager.js")
const { installSemanticMemoryRuntime, getSemanticMemoryRuntime } = await import("../domains/semanticMemory/runtime.js")
const { runRetrievalEval } = await import("../domains/semanticMemory/retrievalEval.js")

const pluginSettings = readPluginSettings()
const archiveManager = new MessageArchiveManager({ cwd, logger: console })
const runtime = installSemanticMemoryRuntime({ pluginSettings, archiveManager, logger: console })
if (!runtime) {
  console.error("语义记忆不可用:检查 semanticMemory.enabled 与 embeddingAiConfig")
  process.exit(1)
}

if (args.includes("--rebuild")) {
  const group = flag("group")
  const startedAt = Date.now()
  const report = group ? [await runtime.indexer.backfillGroup(group)] : await runtime.indexer.backfillAll()
  const ok = report.filter(item => !item.error)
  console.log(`回填完成:${ok.length} 群 / 新增 ${ok.reduce((sum, item) => sum + (item.indexed || 0), 0)} 分块 / ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
  for (const item of report) {
    console.log(`  群 ${item.group}: 消息 ${item.messages ?? "-"} → 分块 ${item.chunks ?? "-"}(新增 ${item.indexed ?? 0})${item.error ? ` 失败:${item.error}` : ""}`)
  }
  if (group) process.exit(0)
}

const samples = Math.min(50, Math.max(3, Number(flag("samples")) || 30))
console.log(`开始评估:抽样 ${samples} …`)
const report = await runRetrievalEval(runtime, { sampleCount: samples })
if (!report) {
  console.error("没有可用索引分块,先 --rebuild")
  process.exit(1)
}
const pct = value => `${Math.round(value * 100)}%`
const rerankLine = report.recallAt5Rerank !== undefined
  ? `recall@5 混合+重排:${pct(report.recallAt5Rerank)}(重排生效 ${report.rerankApplied}/${report.samples}) | recall@10 重排:${pct(report.recallAt10Rerank)}`
  : '重排:未启用'
console.log([
  `评估样本:${report.samples}(出题失败 ${report.questionFailures})`,
  `recall@5:纯向量 ${pct(report.recallAt5Vector)} | 混合 ${pct(report.recallAt5Hybrid)}`,
  `recall@10:混合 ${pct(report.recallAt10Hybrid)}`,
  rerankLine,
  `延迟:P50 ${report.latencyP50Ms}ms / P95 ${report.latencyP95Ms}ms`
].join("\n"))
const reportPath = path.join(runtime.baseDir, "eval-report.json")
fs.mkdirSync(runtime.baseDir, { recursive: true })
fs.writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), ...report }, null, 2))
console.log(`报告已写入 ${reportPath}`)
process.exit(0)
