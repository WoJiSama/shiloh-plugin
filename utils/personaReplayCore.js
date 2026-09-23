// 人设回放核心(纯函数,供 scripts/personaReplay.mjs 与单测共用):
// 场景校验、自动检查(禁语/长度带)、基线对比与报告渲染。
// 不做网络调用;API 回放由脚本层负责。

export const GLOBAL_ANTI_PATTERNS = ["作为AI", "作为一个AI", "我是机器人", "我是一个人工智能", "很抱歉", "无法协助", "别加戏"]

export function normalizeScenario(raw = {}, index = 0) {
  const id = String(raw.id || `scenario-${index + 1}`)
  const input = String(raw.input || "").trim()
  if (!input) throw new Error(`场景 ${id} 缺少 input`)
  return {
    id,
    input,
    expect: String(raw.expect || ""),
    recentContext: Array.isArray(raw.recentContext) ? raw.recentContext : [],
    anti: (Array.isArray(raw.anti) ? raw.anti : []).map(String),
    minLength: Number(raw.minLength) || 0,
    maxLength: Number(raw.maxLength) || 0
  }
}

export function normalizeScenarios(list = []) {
  return (Array.isArray(list) ? list : []).map(normalizeScenario)
}

/**
 * 对单条输出跑自动检查。返回 {ok, failures: [string]}。
 * 检查项:全局+场景禁语、长度带、空输出。
 */
export function runAutoChecks(scenario, output = "") {
  const text = String(output || "").trim()
  const failures = []
  if (!text) failures.push("输出为空")
  for (const pattern of [...GLOBAL_ANTI_PATTERNS, ...scenario.anti]) {
    if (pattern && text.includes(pattern)) failures.push(`命中禁语「${pattern}」`)
  }
  if (scenario.minLength && text.length < scenario.minLength) failures.push(`过短(${text.length}c < ${scenario.minLength})`)
  if (scenario.maxLength && text.length > scenario.maxLength) failures.push(`过长(${text.length}c > ${scenario.maxLength})`)
  return { ok: failures.length === 0, failures }
}

/**
 * 与基线对比:标记内容变化与自动检查回归。
 * baseline: { [scenarioId]: outputText }
 */
export function compareWithBaseline(results = [], baseline = {}) {
  return results.map(result => ({
    ...result,
    baseline: baseline[result.scenario.id] ?? null,
    changed: baseline[result.scenario.id] !== undefined && baseline[result.scenario.id] !== result.output,
    baselineFailures: baseline[result.scenario.id] !== undefined
      ? runAutoChecks(result.scenario, baseline[result.scenario.id]).failures
      : null
  }))
}

export function renderConsoleReport(entries = []) {
  const lines = []
  for (const entry of entries) {
    const status = entry.checks.ok ? "PASS" : `FAIL(${entry.checks.failures.join("; ")})`
    lines.push(`[${status}] ${entry.scenario.id}`)
    lines.push(`  输入: ${entry.scenario.input}`)
    if (entry.baseline !== null && entry.changed) {
      lines.push(`  旧: ${entry.baseline}`)
      lines.push(`  新: ${entry.output}`)
    } else {
      lines.push(`  出: ${entry.output}`)
    }
    if (entry.error) lines.push(`  错误: ${entry.error}`)
    lines.push("")
  }
  const pass = entries.filter(entry => entry.checks.ok).length
  lines.push(`自动检查: ${pass}/${entries.length} 通过(语气手感请人工过目;判据见场景 expect)`)
  return lines.join("\n")
}
