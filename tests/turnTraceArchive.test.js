import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createTurnTrace, pruneTurnTraceArchive, resolveTurnTraceArchiveDir } from "../utils/turnTrace.js"
import { buildTurnTraceReport, formatTurnTraceReport } from "../scripts/turn-trace-report.mjs"

test("finished turns are archived as one NDJSON line per day file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "turn-trace-"))
  const trace = createTurnTrace({
    groupId: "g",
    userId: "u",
    sessionId: "s",
    logger: { info: () => {} },
    archive: { enabled: true, dir, retentionDays: 7 }
  })
  trace.setIntent("chat", null, "fast_path_skip")
  trace.setRoute("chat", "casual", "no_required_action")
  trace.addModelCall("initial", 800)
  trace.addTool("bananaTool", true, 3200)
  const record = trace.finish()
  // 归档是异步串行队列，等它落盘
  await new Promise(resolve => setTimeout(resolve, 200))
  const files = fs.readdirSync(dir).filter(name => name.endsWith(".ndjson"))
  assert.equal(files.length, 1)
  assert.ok(/^\d{4}-\d{2}-\d{2}\.ndjson$/.test(files[0]), "按天滚动命名")
  const lines = fs.readFileSync(path.join(dir, files[0]), "utf8").trim().split("\n")
  assert.equal(lines.length, 1)
  assert.equal(JSON.parse(lines[0]).turnId, record.turnId)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("archive write failures never break the turn", async () => {
  const trace = createTurnTrace({
    logger: { info: () => {}, debug: () => {} },
    archive: { enabled: true, dir: path.join(os.tmpdir(), "turn-trace- Readonly-".replace(/\s/g, ""), "\0bad"), retentionDays: 7 }
  })
  assert.doesNotThrow(() => trace.finish())
  await new Promise(resolve => setTimeout(resolve, 100))
})

test("prune removes day files beyond retention", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "turn-trace-prune-"))
  const today = new Date()
  const pad = value => String(value).padStart(2, "0")
  const tag = offset => new Date(today.getTime() + offset * 86400000)
  const names = ["2020-01-01.ndjson", `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}.ndjson`]
  for (const name of names) fs.writeFileSync(path.join(dir, name), "{}\n")
  const removed = await pruneTurnTraceArchive(dir, 7)
  assert.equal(removed, 1)
  assert.ok(!fs.existsSync(path.join(dir, "2020-01-01.ndjson")))
  void tag
  fs.rmSync(dir, { recursive: true, force: true })
})

test("report aggregates stages, fast-path skips, and failures", () => {
  const base = { turnId: "t1", modelCalls: [{ stage: "initial", ms: 100 }, { stage: "initial", ms: 300 }], tools: [{ name: "bananaTool", ok: false, ms: 500 }], failures: [{ stage: "final_tool_summary", error: "x" }], outbound: 2, totalMs: 900, intent: { kind: "chat", source: "fast_path_skip" }, route: { mode: "chat", profile: "casual" }, trigger: { mode: "strict_trigger" } }
  const report = buildTurnTraceReport([base, { turnId: "t2", modelCalls: [{ stage: "intent", ms: 900 }], tools: [], failures: [], outbound: 1, totalMs: 1000, intent: { kind: "image_generate", confidence: 0.9, source: "model" }, route: { mode: "tool", profile: "task" }, trigger: { mode: "smart_gate" } }])
  assert.equal(report.turns, 2)
  assert.equal(report.fastPathSkipCount, 1)
  assert.equal(report.modelStages.initial.p50, 100)
  assert.equal(report.modelStages.initial.p95, 300)
  assert.equal(report.modelStages.intent.p95, 900)
  assert.equal(report.tools.failures, 1)
  assert.deepEqual(report.tools.topFailures[0], ["bananaTool", 1])
  assert.equal(report.failureStages[0][0], "final_tool_summary")
  assert.equal(report.outbound.total, 3)
  const text = formatTurnTraceReport(report)
  assert.ok(text.includes("回合数: 2"))
  assert.ok(text.includes("chat(快路): 1"))
  assert.ok(text.includes("initial: n=2"))
})

test("default archive dir resolves without throwing", () => {
  assert.ok(typeof resolveTurnTraceArchiveDir() === "string")
  assert.ok(resolveTurnTraceArchiveDir("/tmp/custom-trace") === path.resolve("/tmp/custom-trace"))
})
