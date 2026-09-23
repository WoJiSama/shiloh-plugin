// 人设回放:把固定场景喂给真实的人设提示词栈(线上同款),回放模型输出,
// 自动检查禁语/长度,支持基线保存与对比。改人设先跑一遍,手感调优不再是打地鼠。
//
// 用法:
//   node scripts/personaReplay.mjs --config config_default/message.yaml        # 默认配置全量回放
//   node scripts/personaReplay.mjs --config /path/to/live/message.yaml --save v1     # 存基线
//   node scripts/personaReplay.mjs --config ... --compare v1                    # 与基线对比
//   node scripts/personaReplay.mjs --config ... --scenario only-me              # 只跑命中关键词的场景(省 token)
//   node scripts/personaReplay.mjs --config ... --model grok-xxx                # 临时换模型
//
// 成本:全量 12 场景 ≈ 5 万 token(约等于群里几十条消息);--scenario 过滤后单场景几千 token。
import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"
import { fileURLToPath } from "node:url"
import { buildMainSystemPrompt } from "../utils/systemPromptTemplate.js"
import { buildPersonaStyleOverride, renderPersonaTemplate, resolvePersonaName } from "../utils/personaSource.js"
import { buildPersonaTonePrompt } from "../utils/personaTonePolicy.js"
import { fetchWithTimeout } from "../utils/modelGateway.js"
import { normalizeScenarios, runAutoChecks, compareWithBaseline, renderConsoleReport } from "../utils/personaReplayCore.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, "..")

function parseArgs(argv = []) {
  const args = { config: path.join(ROOT, "config_default/message.yaml"), scenario: "", save: "", compare: "", model: "" }
  for (let i = 0; i < argv.length; i++) {
    const key = String(argv[i]).replace(/^--/, "")
    if (key in args) args[key] = String(argv[++i] ?? "")
  }
  return args
}

function loadConfig(configPath) {
  const doc = YAML.parse(fs.readFileSync(configPath, "utf8"))
  return doc.pluginSettings || doc
}

function buildScenarioMessages(config, scenario) {
  const persona = config.persona || {}
  const system = buildMainSystemPrompt({
    baseIdentity: renderPersonaTemplate(config.systemContent || "", persona),
    personaOverride: buildPersonaStyleOverride(persona),
    runtimeData: {
      group_info: { group_id: 609235590, group_name: "人设回放测试群" },
      environmental_factors: { local_time: `北京时间: ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}` }
    },
    enhancedPrompts: buildPersonaTonePrompt({ userText: scenario.input, persona }),
    mcpPrompts: "",
    personaName: resolvePersonaName(persona)
  })
  const messages = [{ role: "system", content: system }]
  for (const line of scenario.recentContext) {
    messages.push({ role: line.role === "bot" ? "assistant" : "user", content: String(line.text || "") })
  }
  messages.push({ role: "user", content: scenario.input })
  return messages
}

async function callChatModel({ config, model, messages }) {
  const chat = config.chatAiConfig || {}
  const apiUrl = String(chat.chatApiUrl || "").replace(/\/$/, "")
  const apiKey = String(chat.chatApiKey || "")
  const modelName = model || chat.chatApiModel
  if (!apiUrl || !apiKey || !modelName || apiKey.includes("sk-xxx")) {
    throw new Error(`chatAiConfig 不完整(url=${apiUrl || "无"} model=${modelName || "无"} key=${apiKey ? "有" : "无"})`)
  }
  const url = apiUrl.endsWith("/chat/completions") ? apiUrl : `${apiUrl}/chat/completions`
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: modelName, messages, temperature: 0.7, top_p: 0.9, stream: false })
  }, 60000)
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
  const data = await response.json()
  const content = String(data?.choices?.[0]?.message?.content || "").trim()
  if (!content) throw new Error(`空回复(raw=${JSON.stringify(data?.choices?.[0] || {}).slice(0, 200)})`)
  return content
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const config = loadConfig(args.config)
  const allScenarios = normalizeScenarios(JSON.parse(fs.readFileSync(path.join(here, "persona-scenarios.json"), "utf8")))
  const scenarios = args.scenario
    ? allScenarios.filter(scenario => scenario.id.includes(args.scenario) || scenario.input.includes(args.scenario))
    : allScenarios
  if (!scenarios.length) {
    console.log(`没有匹配「${args.scenario}」的场景`)
    process.exit(2)
  }

  const baselinePath = name => path.join(here, "persona-baselines", `${name}.json`)
  let baseline = {}
  if (args.compare) {
    const file = baselinePath(args.compare)
    if (!fs.existsSync(file)) {
      console.log(`基线不存在: ${file}`)
      process.exit(2)
    }
    baseline = JSON.parse(fs.readFileSync(file, "utf8"))
  }

  console.log(`人设回放: ${scenarios.length} 个场景 | 模型 ${args.model || config.chatAiConfig?.chatApiModel} | 配置 ${args.config}`)
  const results = []
  for (const scenario of scenarios) {
    const startedAt = Date.now()
    try {
      const output = await callChatModel({ config, model: args.model, messages: buildScenarioMessages(config, scenario) })
      results.push({ scenario, output, checks: runAutoChecks(scenario, output), elapsedMs: Date.now() - startedAt })
    } catch (error) {
      results.push({ scenario, output: "", error: error.message, checks: { ok: false, failures: ["调用失败"] }, elapsedMs: Date.now() - startedAt })
    }
  }

  const entries = compareWithBaseline(results, baseline)
  console.log(renderConsoleReport(entries))

  if (args.save) {
    const dir = path.join(here, "persona-baselines")
    fs.mkdirSync(dir, { recursive: true })
    const payload = Object.fromEntries(results.map(result => [result.scenario.id, result.output]))
    fs.writeFileSync(baselinePath(args.save), JSON.stringify(payload, null, 2))
    console.log(`\n基线已保存: ${args.save}`)
  }

  const failed = entries.filter(entry => !entry.checks.ok)
  process.exit(failed.length ? 1 : 0)
}

main().catch(error => {
  console.error("回放失败:", error.message)
  process.exit(2)
})
