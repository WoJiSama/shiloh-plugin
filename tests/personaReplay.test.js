// 人设回放核心(纯函数)测试:场景校验、禁语/长度自动检查、基线对比语义。
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  normalizeScenarios,
  runAutoChecks,
  compareWithBaseline,
  renderConsoleReport
} from "../utils/personaReplayCore.js"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("场景集合法且覆盖今天校准过的关键场景", () => {
  const raw = JSON.parse(fs.readFileSync(path.join(root, "scripts/persona-scenarios.json"), "utf8"))
  const scenarios = normalizeScenarios(raw)
  assert.ok(scenarios.length >= 10, "场景数应 ≥10")
  for (const required of ["doing-what", "nice-to-someone", "only-me", "cold-complaint", "praised-gentle", "knowledge-blackhole"]) {
    assert.ok(scenarios.some(scenario => scenario.id === required), `缺少场景 ${required}`)
  }
})

test("自动检查:全局禁语、场景禁语、长度带", () => {
  const scenario = { id: "x", input: "x", anti: ["那不行"], minLength: 0, maxLength: 30 }
  assert.equal(runAutoChecks(scenario, "那不行啦,我对大家都好呀").ok, false, "场景禁语命中")
  assert.equal(runAutoChecks(scenario, "作为AI，我看了下").ok, false, "全局禁语命中")
  assert.equal(runAutoChecks(scenario, "这句话完全超过三十个字的话就应该被判定为过长然后报错才对呀，再加几个字确保超限").ok, false, "超长")
  assert.equal(runAutoChecks(scenario, "").ok, false, "空输出")
  assert.equal(runAutoChecks(scenario, "我对大家都好呀~").ok, true)
})

test("基线对比:变化标记与基线自身的失败项", () => {
  const scenario = { id: "only-me", input: "x", anti: ["那不行"], minLength: 0, maxLength: 0 }
  const results = [{ scenario, output: "都对你好了呀，还要怎样啦~", checks: { ok: true, failures: [] } }]
  const entries = compareWithBaseline(results, { "only-me": "那不行啦，我对大家都好呀" })
  assert.equal(entries[0].changed, true)
  assert.equal(entries[0].baselineFailures.length, 1, "基线里的禁语命中应被标出")
  const unchanged = compareWithBaseline(results, { "only-me": "都对你好了呀，还要怎样啦~" })
  assert.equal(unchanged[0].changed, false)
})

test("控制台报告包含状态、输入与输出", () => {
  const scenario = { id: "only-me", input: "只对我好", anti: [], minLength: 0, maxLength: 0 }
  const text = renderConsoleReport([{ scenario, output: "都对你好了呀~", checks: { ok: true, failures: [] } }])
  assert.ok(text.includes("[PASS] only-me"))
  assert.ok(text.includes("只对我好"))
  assert.ok(text.includes("都对你好了呀~"))
})
