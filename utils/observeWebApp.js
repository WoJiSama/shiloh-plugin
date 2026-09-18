import fs from "fs"
import path from "path"
import { buildTurnTraceReport } from "../scripts/turn-trace-report.mjs"
import { resolveTurnTraceArchiveDir } from "./turnTrace.js"

// 运行观测页：聚合 TurnTrace NDJSON 归档，回答"bot 今天干了什么、哪里不对劲"。
// 挂在 /bl-chat/observe，与命令管理页共用同一份令牌。

const MOUNT_PATH = "/bl-chat/observe"
let registered = false

function readRecentTraceRecords(days = 7, pluginRoot = process.cwd()) {
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
        const records = readRecentTraceRecords(7, pluginRoot)
          .filter(record => record && record.turnId)
        const today = new Date().toISOString().slice(0, 10)
        const todayTurns = records.filter(r => String(r.at || "").startsWith(today)).length

        const perTool = new Map()
        for (const r of records) {
          for (const tool of r.tools || []) {
            const entry = perTool.get(tool.name) || { name: tool.name, runs: 0, fails: 0, msTotal: 0, msCount: 0 }
            entry.runs += 1
            if (tool.ok === false) entry.fails += 1
            if (Number(tool.ms) > 0) { entry.msTotal += Number(tool.ms); entry.msCount += 1 }
            perTool.set(tool.name, entry)
          }
        }
        const tools = [...perTool.values()]
          .map(e => ({ name: e.name, runs: e.runs, fails: e.fails, avgMs: e.msCount ? Math.round(e.msTotal / e.msCount) : 0 }))
          .sort((a, b) => b.runs - a.runs)

        const errorCounts = new Map()
        const failureStageCounts = new Map()
        for (const r of records) {
          for (const failure of r.failures || []) {
            const stage = failure.stage || "-"
            failureStageCounts.set(stage, (failureStageCounts.get(stage) || 0) + 1)
            const errKey = String(failure.error || "").slice(0, 90)
            const key = stage + " · " + errKey
            errorCounts.set(key, (errorCounts.get(key) || 0) + 1)
          }
        }

        const dailyMap = new Map()
        const groupMap = new Map()
        const userSet = new Set()
        const intentCounts = new Map()
        const triggerCounts = new Map()
        const gateDecisionCounts = new Map()
        const stageMs = new Map()
        let outboundTotal = 0
        let emojiSends = 0
        let fastPathSkips = 0
        let msValues = []
        for (const r of records) {
          const date = String(r.at || "").slice(0, 10)
          const day = dailyMap.get(date) || { date, turns: 0, outbound: 0, emoji: 0, failures: 0, msList: [] }
          day.turns += 1
          day.outbound += Number(r.outbound) || 0
          if ((r.tools || []).some(t => t?.name === "sendLocalEmojiTool" && t.ok !== false)) { day.emoji += 1; emojiSends += 1 }
          if ((r.failures || []).length) day.failures += (r.failures || []).length
          if (Number(r.totalMs) > 0) { day.msList.push(Number(r.totalMs)); msValues.push(Number(r.totalMs)) }
          dailyMap.set(date, day)

          const gid = String(r.groupId || "")
          if (gid) {
            const g = groupMap.get(gid) || { groupId: gid, turns: 0, emoji: 0, outbound: 0, users: new Set() }
            g.turns += 1
            g.outbound += Number(r.outbound) || 0
            if ((r.tools || []).some(t => t?.name === "sendLocalEmojiTool" && t.ok !== false)) g.emoji += 1
            if (r.userId) g.users.add(String(r.userId))
            groupMap.set(gid, g)
          }
          if (r.userId) userSet.add(String(r.userId))
          if (r.intent?.kind) intentCounts.set(r.intent.kind, (intentCounts.get(r.intent.kind) || 0) + 1)
          if (r.intent?.source === "fast_path_skip") fastPathSkips += 1
          if (r.trigger?.mode) triggerCounts.set(r.trigger.mode, (triggerCounts.get(r.trigger.mode) || 0) + 1)
          if (r.trigger?.gateDecision) gateDecisionCounts.set(r.trigger.gateDecision, (gateDecisionCounts.get(r.trigger.gateDecision) || 0) + 1)
          for (const call of r.modelCalls || []) {
            if (!call?.stage) continue
            const entry = stageMs.get(call.stage) || { count: 0, total: 0, values: [] }
            entry.count += 1
            entry.total += Number(call.ms) || 0
            if (Number(call.ms) > 0) entry.values.push(Number(call.ms))
            stageMs.set(call.stage, entry)
          }
          outboundTotal += Number(r.outbound) || 0
        }

        const sortedMs = [...msValues].sort((a, b) => a - b)
        const pct = (list, p) => list.length ? list[Math.min(list.length - 1, Math.max(0, Math.ceil((p / 100) * list.length) - 1))] : 0

        res.json({
          summary: {
            turns: records.length,
            todayTurns,
            outboundTotal,
            emojiSends,
            toolRuns: tools.reduce((n, t) => n + t.runs, 0),
            toolFails: tools.reduce((n, t) => n + t.fails, 0),
            groups: groupMap.size,
            users: userSet.size,
            avgMs: sortedMs.length ? Math.round(sortedMs.reduce((a, b) => a + b, 0) / sortedMs.length) : 0,
            p95Ms: pct(sortedMs, 95),
            fastPathSkips,
            emojiShare: records.length ? Math.round((emojiSends / records.length) * 100) : 0
          },
          daily: [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date)).map(d => ({
            date: d.date, turns: d.turns, outbound: d.outbound, emoji: d.emoji, failures: d.failures,
            avgMs: d.msList.length ? Math.round(d.msList.reduce((a, b) => a + b, 0) / d.msList.length) : 0
          })),
          groups: [...groupMap.values()].sort((a, b) => b.turns - a.turns).slice(0, 10).map(g => ({
            groupId: g.groupId, turns: g.turns, emoji: g.emoji, outbound: g.outbound, users: g.users.size
          })),
          intents: [...intentCounts.entries()].sort((a, b) => b[1] - a[1]),
          triggers: [...triggerCounts.entries()].sort((a, b) => b[1] - a[1]),
          gateDecisions: [...gateDecisionCounts.entries()].sort((a, b) => b[1] - a[1]),
          modelStages: [...stageMs.entries()].map(([stage, e]) => ({
            stage, count: e.count, avgMs: e.count ? Math.round(e.total / e.count) : 0, p95Ms: pct([...e.values].sort((a, b) => a - b), 95), totalMs: e.total
          })).sort((a, b) => b.count - a.count),
          tools,
          failureStages: [...failureStageCounts.entries()].sort((a, b) => b[1] - a[1]),
          topErrors: [...errorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6),
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
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  @media (max-width: 900px) { .grid2 { grid-template-columns: 1fr; } }
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
  const s = d.summary || {}
  const total = Math.max(1, s.turns || 0)
  const cards = [
    ["回合（近7天）", s.turns], ["出站消息", s.outboundTotal],
    ["表情发送", (s.emojiSends || 0) + "（" + (s.emojiShare || 0) + "%）"], ["工具调用", (s.toolRuns || 0) + " / 失败 " + (s.toolFails || 0)],
    ["活跃群 / 用户", (s.groups || 0) + " / " + (s.users || 0)], ["快路跳过", (s.fastPathSkips || 0) + "（" + Math.round((s.fastPathSkips || 0) / total * 100) + "%）"],
    ["平均耗时", (s.avgMs || 0) + "ms"], ["p95 耗时", (s.p95Ms || 0) + "ms"]
  ].map(c => '<div class="card"><div class="num">' + c[1] + '</div><div class="label">' + c[0] + "</div></div>").join("")

  const dailyRows = (d.daily || []).map(day => "<tr><td>" + day.date.slice(5) + "</td><td>" + bar(day.turns, Math.max(1, ...d.daily.map(x => x.turns))) + "</td><td>" + day.outbound + "</td><td>" + day.emoji + "</td><td>" + (day.failures || 0) + "</td><td>" + (day.avgMs || 0) + "ms</td></tr>").join("") || emptyRow(6)

  const groupRows = (d.groups || []).map(g => "<tr><td>" + g.groupId.slice(-6) + "</td><td>" + bar(g.turns, Math.max(1, ...d.groups.map(x => x.turns))) + "</td><td>" + g.users + "</td><td>" + g.emoji + "</td><td>" + g.outbound + "</td></tr>").join("") || emptyRow(5)

  const intentRows = (d.intents || []).map(kv => distRow(kv[0], kv[1], s.turns)).join("") || emptyRow(3)
  const triggerRows = (d.triggers || []).map(kv => distRow(kv[0], kv[1], s.turns)).join("") || emptyRow(3)
  const gateTotal = (d.gateDecisions || []).reduce((n, kv) => n + kv[1], 0)
  const gateRows = (d.gateDecisions || []).map(kv => distRow(kv[0], kv[1], gateTotal)).join("") || emptyRow(3)

  const stageRows = (d.modelStages || []).map(m => "<tr><td>" + m.stage + "</td><td>" + m.count + "</td><td>" + m.avgMs + "ms</td><td>" + m.p95Ms + "ms</td><td>" + Math.round(m.totalMs / 1000) + "s</td></tr>").join("") || emptyRow(5)

  const toolRows = (d.tools || []).map(t => "<tr><td>" + t.name + "</td><td>" + bar(t.runs, Math.max(1, ...d.tools.map(x => x.runs))) + "</td><td>" + (t.runs ? Math.round((1 - t.fails / t.runs) * 100) : 100) + "%</td><td>" + t.fails + "</td><td>" + (t.avgMs || 0) + "ms</td></tr>").join("") || emptyRow(5)

  const errRows = (d.topErrors || []).map(kv => "<tr><td>" + escapeHtml(kv[0]) + "</td><td>" + kv[1] + "</td></tr>").join("") || emptyRow(2)

  const hours = (d.hourly || []).map(h => "<tr><td>" + h[0].slice(11) + ":00</td><td>" + bar(h[1].turns, Math.max.apply(null, d.hourly.map(x => x[1].turns).concat(1))) + "</td><td class='emoji'>" + bar(h[1].emoji, Math.max.apply(null, d.hourly.map(x => x[1].emoji).concat(1))) + "</td><td class='fail'>" + bar(h[1].failures, Math.max.apply(null, d.hourly.map(x => x[1].failures).concat(1))) + "</td></tr>").join("") || emptyRow(4)

  const recent = (d.recentTurns || []).map(t => "<tr><td>" + t.at + "</td><td>" + t.group + "</td><td>" + t.intent + "</td><td>" + t.trigger + "</td><td>" + escapeHtml(t.tools) + "</td><td>" + t.outbound + "</td><td>" + t.totalMs + "ms</td></tr>").join("") || emptyRow(7)

  $("app").innerHTML =
    '<div class="cards">' + cards + "</div>" +
    '<div class="grid2">' +
    '<section><h2>按天汇总</h2><table><tr><th>日期</th><th>回合</th><th>出站</th><th>表情</th><th>失败</th><th>平均耗时</th></tr>' + dailyRows + "</table></section>" +
    '<section><h2>分群排行 Top10</h2><table><tr><th>群（尾号）</th><th>回合</th><th>用户数</th><th>表情</th><th>出站</th></tr>' + groupRows + "</table></section>" +
    '<section><h2>意图分布</h2><table><tr><th>意图</th><th>分布</th><th>占比</th></tr>' + intentRows + "</table></section>" +
    '<section><h2>触发来源 / Gate 决策</h2><table><tr><th>触发</th><th>分布</th><th>占比</th></tr>' + triggerRows + "</table>" +
    '<table style="margin-top:10px"><tr><th>Gate 决策</th><th>分布</th><th>占比</th></tr>' + gateRows + "</table></section>" +
    "</div>" +
    '<section><h2>工具调用明细</h2><table><tr><th>工具</th><th>次数</th><th>成功率</th><th>失败</th><th>平均耗时</th></tr>' + toolRows + "</table></section>" +
    '<div class="grid2">' +
    '<section><h2>模型调用阶段</h2><table><tr><th>阶段</th><th>次数</th><th>平均</th><th>p95</th><th>累计</th></tr>' + stageRows + "</table></section>" +
    '<section><h2>错误 Top（阶段 · 信息）</h2><table><tr><th>错误</th><th>次数</th></tr>' + errRows + "</table></section>" +
    "</div>" +
    '<section><h2>按小时分布（回合 / 表情 / 失败）</h2><table><tr><th>小时</th><th>回合</th><th>表情</th><th>失败</th></tr>' + hours + "</table></section>" +
    '<section><h2>最近回合</h2><table><tr><th>时间</th><th>群</th><th>意图</th><th>触发</th><th>工具</th><th>出站</th><th>耗时</th></tr>' + recent + "</table></section>" +
    '<div style="color:#8a93a5;font-size:12px">生成于 ' + d.generatedAt + " · 数据源 data/turn_trace/（保留 7 天）</div>"
}
function emptyRow(n) { return "<tr><td colspan='" + n + "' class='empty'>暂无数据</td></tr>" }
function distRow(label, value, total) {
  const share = total > 0 ? Math.round((value / total) * 100) : 0
  return "<tr><td>" + label + "</td><td>" + bar(value, value) + "</td><td>" + share + "%</td></tr>"
}
function escapeHtml(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;") }
$("reload").onclick = () => load()
const urlToken = new URLSearchParams(location.search).get("token")
if (urlToken) { state.token = urlToken; history.replaceState(null, "", location.pathname) }
load()
</script>
</body>
</html>`
}
