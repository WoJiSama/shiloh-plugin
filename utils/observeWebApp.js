import fs from "fs"
import path from "path"
import { buildTurnTraceReport } from "../scripts/turn-trace-report.mjs"
import { resolveTurnTraceArchiveDir } from "./turnTrace.js"

// 运行观测页：聚合 TurnTrace NDJSON 归档，回答"bot 今天干了什么、哪里不对劲"。
// 挂在 /bl-chat/observe，与命令管理页共用同一份令牌。

const MOUNT_PATH = "/bl-chat/observe"
let registered = false

function readRecentTraceRecords(days = 2, pluginRoot = process.cwd()) {
  const dir = resolveTurnTraceArchiveDir(path.join(String(pluginRoot || ""), "data", "turn_trace"))
  const records = []
  if (!fs.existsSync(dir)) return records
  const wanted = new Set()
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000)
    const pad = v => String(v).padStart(2, "0")
    wanted.add(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)
  }
  for (const file of fs.readdirSync(dir).sort().reverse()) {
    if (!wanted.has(file.replace(/\.ndjson$/, ""))) continue
    try {
      for (const line of fs.readFileSync(path.join(dir, file), "utf8").split("\n")) {
        if (!line.trim()) continue
        try { records.push(JSON.parse(line)) } catch {}
      }
    } catch {}
  }
  return records
}

function buildHourlyBuckets(records = []) {
  const buckets = new Map()
  for (const record of records) {
    if (!record?.turnId) continue
    const hour = String(record.at || "").slice(0, 13)
    const entry = buckets.get(hour) || { turns: 0, emoji: 0, failures: 0 }
    entry.turns += 1
    if ((record.tools || []).some(tool => tool?.name === "sendLocalEmojiTool" && tool.ok !== false)) entry.emoji += 1
    if ((record.failures || []).length) entry.failures += 1
    buckets.set(hour, entry)
  }
  return [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-24)
}

function buildRecentTurns(records = []) {
  return records
    .filter(record => record?.turnId)
    .slice(-20)
    .reverse()
    .map(record => ({
      at: String(record.at || "").slice(11, 19),
      group: String(record.groupId || "").slice(-6),
      intent: record.intent ? `${record.intent.kind}${record.intent.source === "fast_path_skip" ? "(快路)" : ""}` : "-",
      trigger: record.trigger?.mode || "-",
      tools: (record.tools || []).map(tool => `${tool.name}${tool.ok === false ? "✗" : ""}`).join(",") || "-",
      outbound: record.outbound || 0,
      totalMs: record.totalMs || 0
    }))
}

function checkToken(req, token) {
  const provided = String(req?.query?.token || req?.headers?.["x-commands-token"] || "")
  return Boolean(provided) && provided === token
}

export function registerObserveWebApp(expressApp, pluginRoot, tokens = {}, logger = globalThis.logger) {
  const token = tokens?.token || tokens
  const observeToken = tokens?.observeToken || token
  if (!expressApp || registered) return
  registered = true

  expressApp.use(MOUNT_PATH, async (req, res, next) => {
    if (req.path === "/" || req.path === "" || req.path === "/index.html") {
      res.set("Cache-Control", "no-cache, no-store, must-revalidate")
      res.type("html").send(buildPageHtml(observeToken))
      return
    }
    if (req.path === "/api/stats") {
      if (!checkToken(req, token) && !checkToken(req, observeToken)) {
        res.status(401).json({ error: "访问令牌无效" })
        return
      }
      try {
        const records = readRecentTraceRecords(2, pluginRoot)
        const today = String(new Date().toISOString().slice(0, 10))
        const todayRecords = records.filter(r => String(r?.at || "").startsWith(today))
        const emojiSends = records.filter(record => (record?.tools || []).some(tool => tool?.name === "sendLocalEmojiTool" && tool.ok !== false)).length
        res.json({
          report: buildTurnTraceReport(records),
          todayTurns: todayRecords.length,
          emojiSends,
          hourly: buildHourlyBuckets(records),
          recentTurns: buildRecentTurns(records),
          generatedAt: new Date().toISOString()
        })
      } catch (error) {
        res.status(500).json({ error: error?.message || String(error) })
      }
      return
    }
    next()
  })
  logger?.mark?.(`[运行观测页] 已挂载 http://<机器人地址>:<端口>${MOUNT_PATH} （与命令管理页同一令牌）`)
}

function buildPageHtml(observeToken = "") {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>运行观测 · shiloh-plugin</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f3f5f9; color: #1f2430; padding: 20px; }
  header { display: flex; align-items: center; gap: 14px; margin-bottom: 16px; flex-wrap: wrap; }
  h1 { font-size: 18px; }
  .spacer { flex: 1; }
  a { color: #4c6ef5; text-decoration: none; font-size: 14px; }
  input, button { font: inherit; border: 1px solid #d4dae3; border-radius: 8px; padding: 6px 10px; }
  button { cursor: pointer; background: #4c6ef5; border-color: #4c6ef5; color: #fff; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; margin-bottom: 16px; }
  .card { background: #fff; border: 1px solid #e5e9f0; border-radius: 12px; padding: 12px 14px; }
  .card .num { font-size: 26px; font-weight: 700; }
  .card .label { font-size: 12px; color: #8a93a5; margin-top: 2px; }
  .card.warn .num { color: #e03131; }
  section { background: #fff; border: 1px solid #e5e9f0; border-radius: 12px; padding: 14px; margin-bottom: 14px; }
  section h2 { font-size: 14px; margin-bottom: 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; color: #8a93a5; font-size: 12px; border-bottom: 1px solid #e5e9f0; padding: 6px 8px; }
  td { padding: 5px 8px; border-bottom: 1px solid #f0f3f8; }
  .bar { position: relative; background: #f1f4fb; border-radius: 6px; height: 20px; min-width: 120px; }
  .bar .fill { position: absolute; left: 0; top: 0; bottom: 0; background: #748ffc; border-radius: 6px; }
  .bar span { position: relative; font-size: 11px; line-height: 20px; padding-left: 6px; color: #1f2430; }
  .bar.emoji .fill { background: #f783ac; }
  .bar.fail .fill { background: #ff8787; }
  .empty { color: #8a93a5; text-align: center; padding: 24px; }
  #lock { max-width: 420px; margin: 12vh auto; background: #fff; border: 1px solid #e5e9f0; border-radius: 14px; padding: 28px; text-align: center; }
  #status { position: fixed; bottom: 16px; right: 20px; background: #1f2430; color: #fff; border-radius: 10px; padding: 10px 16px; font-size: 13px; display: none; }
</style>
</head>
<body>
<header>
  <h1>📈 运行观测</h1>
  <a href="/bl-chat/commands/">← 命令管理</a>
  <span class="spacer"></span>
  <button id="reload">刷新</button>
</header>
<div id="app" style="display:none"></div>
<div id="status"></div>
<script>
window.__OBSERVE_TOKEN__ = ${JSON.stringify(String(observeToken || ""))}
const $ = id => document.getElementById(id)
function bar(value, max) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0
  return '<div class="bar"><div class="fill" style="width:' + Math.max(pct, value > 0 ? 4 : 0) + '%"></div><span>' + value + "</span></div>"
}
// 观测令牌由服务端内嵌（只读，不能用于命令管理接口）；URL 带主令牌时优先进 localStorage
const state = { token: window.__OBSERVE_TOKEN__ || "" }
function toast(msg) { const el = $("status"); el.textContent = msg; el.style.display = "block"; setTimeout(() => el.style.display = "none", 3000) }
async function load() {
  try {
    const res = await fetch("api/stats?token=" + encodeURIComponent(state.token))
    if (res.status === 401) throw new Error("令牌无效")
    const data = await res.json()
    render(data)
    $("app").style.display = "block"
  } catch (e) { toast(e.message) }
}
function tallyRows(list) {
  return list.map(([k, v]) => "<tr><td>" + k + "</td><td>" + bar(v, list[0][1]) + "</td></tr>").join("") || "<tr><td colspan=2 class=empty>暂无</td></tr>"
}
function render(d) {
  const r = d.report
  const emojiCount = d.emojiSends || 0
  const cards = [
    ["近2天回合", r.turns], ["今日回合", d.todayTurns],
    ["快路跳过", r.fastPathSkipCount], ["工具失败", (r.tools?.failures || 0), (r.tools?.failures || 0) > 0],
    ["表情发送", emojiCount], ["平均耗时", (r.totalMs?.avg || 0) + "ms"]
  ].map(c => '<div class="card' + (c[2] ? ' warn' : '') + '"><div class="num">' + c[1] + '</div><div class="label">' + c[0] + '</div></div>').join("")
  const hours = d.hourly.map(([h, e]) => "<tr><td>" + h.slice(11) + ":00</td><td>" + bar(e.turns, Math.max(...d.hourly.map(x => x[1].turns))) + "</td><td class='bar emoji'>" + bar(e.emoji, Math.max(1, ...d.hourly.map(x => x[1].emoji))) + "</td><td class='bar fail'>" + bar(e.failures, Math.max(1, ...d.hourly.map(x => x[1].failures))) + "</td></tr>").join("") || "<tr><td colspan=4 class=empty>暂无数据</td></tr>"
  const stageRows = Object.entries(r.modelStages || {}).map(([s, v]) => "<tr><td>" + s + "</td><td>" + v.count + "</td><td>" + v.avg + "ms</td><td>" + v.p95 + "ms</td></tr>").join("") || "<tr><td colspan=4 class=empty>暂无</td></tr>"
  const recent = d.recentTurns.map(t => "<tr><td>" + t.at + "</td><td>" + t.group + "</td><td>" + t.intent + "</td><td>" + t.trigger + "</td><td>" + t.tools + "</td><td>" + t.outbound + "</td><td>" + t.totalMs + "ms</td></tr>").join("") || "<tr><td colspan=7 class=empty>暂无</td></tr>"
  $("app").innerHTML =
    '<div class="cards">' + cards + '</div>' +
    '<section><h2>按小时分布（回合 / 表情 / 失败）</h2><table><tr><th>小时</th><th>回合</th><th>表情</th><th>失败</th></tr>' + hours + '</table></section>' +
    '<section><h2>意图分布 / 触发来源</h2><table><tr><th>意图</th><th></th><th>触发</th><th></th></tr>' +
    tallyRows(r.intents) + '</table><table style="margin-top:8px">' + tallyRows(r.triggers) + '</table></section>' +
    '<section><h2>模型阶段耗时</h2><table><tr><th>阶段</th><th>次数</th><th>平均</th><th>p95</th></tr>' + stageRows + '</table></section>' +
    '<section><h2>最近回合</h2><table><tr><th>时间</th><th>群</th><th>意图</th><th>触发</th><th>工具</th><th>出站</th><th>耗时</th></tr>' + recent + '</table></section>' +
    '<div style="color:#8a93a5;font-size:12px">生成于 ' + d.generatedAt + ' · 数据源 data/turn_trace/（保留 7 天）</div>'
}
$("reload").onclick = () => load()
const urlToken = new URLSearchParams(location.search).get("token")
if (urlToken) { state.token = urlToken; history.replaceState(null, "", location.pathname) }
load()
</script>
</body>
</html>`
}
