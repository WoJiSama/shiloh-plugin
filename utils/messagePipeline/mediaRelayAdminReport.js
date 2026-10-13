import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { readCachedGroupNames, collectBotGroupNames, mergeGroupNames } from "../groupNames.js"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { readUserSettings } from "../configWriter.js"
import { readDailyStats } from "../messageStats.js"

const execFileAsync = promisify(execFile)

const MIN_INTERVAL_MS = 60 * 60 * 1000
const MAX_INTERVAL_MS = 168 * 60 * 60 * 1000
const FIRST_PUSH_DELAY_MS = 2 * 60 * 1000
const FAILURE_LIST_MAX = 10
const ERROR_TEXT_MAX = 180
const LOGIN_LOG_TAIL = 400

const PLATFORM_LABELS = Object.freeze({
  bilibili: "B站",
  douyin: "抖音",
  youtube: "YouTube",
  pixiv: "Pixiv"
})

// napcat 登录态判定:按时间顺序找最后一条命中的日志特征(与 bl-console 总览页同源)
const LOGIN_MARKERS = [
  { re: /请扫描下面的二维码|二维码已保存到|二维码解码URL/, state: "待扫码" },
  { re: /KickedOffLine|登录已失效|账号已离线|下线通知/, state: "掉线" },
  { re: /\[Login\]\s*Login Error/i, state: "掉线" },
  { re: /快速登录|扫码登录成功|登录成功|反向WebSocket.*已(启动|连接)|WebSocket Client.*连接(成功|建立)|发送 ->|接收 <-|收到 <-/, state: "已登录" }
]

const STATE_CLASS = Object.freeze({
  "已登录": "state-ok",
  "待扫码": "state-warn",
  "掉线": "state-bad",
  "未知": "state-warn"
})

function platformLabel(platform = "") {
  return PLATFORM_LABELS[String(platform).toLowerCase()] || String(platform || "媒体")
}

function formatClock(ts = 0) {
  const date = new Date(Number(ts) || 0)
  const pad = value => String(value).padStart(2, "0")
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function compactError(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, ERROR_TEXT_MAX) || "未知错误"
}

export function describeRelayError(value = "") {
  const text = String(value || "")
  if (/video_thumbnail_missing|(?:ENOENT|找不到文件|文件不存在).*(?:thumbnail|thumb|封面|缩略图)|(?:thumbnail|thumb|封面|缩略图).*(?:ENOENT|找不到文件|文件不存在)/i.test(text)) return "视频封面文件缺失"
  if (/forward_resource_upload_failed|上传转发消息资源失败|上传转发信息资源失败/i.test(text)) return "转发中的图片或视频资源上传失败"
  if (/^(?:media_forward:)?send_api_error$/.test(text)) return "消息发送接口失败"
  if (/^missing_bot:/.test(text)) return "机器人账号未连接"
  return compactError(text)
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

export function parseLoginState(logText = "") {
  let matched = null
  for (const line of String(logText || "").split("\n")) {
    for (const marker of LOGIN_MARKERS) {
      if (marker.re.test(line)) { matched = marker.state; break }
    }
  }
  return matched || "未知"
}

function formatMemoryBytes(bytes = 0) {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)}GiB`
    : `${Math.round(bytes / 1024 ** 2)}MiB`
}

// docker stats --no-stream 要秒级采样;内存直接读 cgroup v2 文件,瞬时完成(与总览页同源)
function readContainerMemory(containerId = "", running = false) {
  if (!running || !containerId) return ""
  const scope = `/sys/fs/cgroup/system.slice/docker-${containerId}.scope`
  try {
    const current = Number(fs.readFileSync(`${scope}/memory.current`, "utf8").trim())
    if (!Number.isFinite(current)) return ""
    const maxRaw = fs.readFileSync(`${scope}/memory.max`, "utf8").trim()
    if (maxRaw !== "max" && Number(maxRaw) > 0) return `${formatMemoryBytes(current)}/${formatMemoryBytes(Number(maxRaw))}`
    return formatMemoryBytes(current)
  } catch {
    return ""
  }
}

async function runCommand(cmd, args, timeoutMs = 10000) {
  try {
    const { stdout } = await execFileAsync(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 })
    return { stdout: String(stdout || "") }
  } catch (error) {
    return { error: String(error?.message || error), stdout: "" }
  }
}

/**
 * 采集各 napcat 容器健康：QQ号、昵称、登录态、容器内存。
 * docker/cgroup 不可用（本地开发）时返回 error,报告降级跳过该段。
 */
export async function collectBotHealth({ logger = globalThis.logger } = {}) {
  const list = await runCommand("docker", ["ps", "-a", "--filter", "name=napcat", "--format", "{{.Names}}"])
  if (list.error) return { error: list.error, bots: [] }
  const names = list.stdout.split("\n").map(line => line.trim()).filter(Boolean)
  const bots = await Promise.all(names.map(async name => {
    const info = await runCommand("docker", ["inspect", "-f",
      "{{.Id}}|{{.State.Running}}|{{range .Config.Env}}{{.}} {{end}}", name])
    if (info.error) return null
    const [containerId, running, env] = info.stdout.trim().split("|")
    const account = String(env || "").split(" ").find(item => item.startsWith("ACCOUNT="))?.slice(8) || ""
    if (!account) return null
    const runningBool = running === "true"
    const logs = runningBool ? await runCommand("docker", ["logs", "--tail", String(LOGIN_LOG_TAIL), name], 20000) : { stdout: "" }
    return {
      account,
      nickname: globalThis.Bot?.bots?.[account]?.nickname || "昵称未获取",
      connected: Boolean(globalThis.Bot?.bots?.[account]),
      loginState: runningBool ? parseLoginState(logs.stdout) : "掉线",
      memory: readContainerMemory(containerId, runningBool)
    }
  }))
  return { error: "", bots: bots.filter(Boolean) }
}

async function collectUsageStats() {
  try {
    if (!globalThis.redis || !(typeof globalThis.redis.hgetall === "function" || typeof globalThis.redis.eval === "function")) throw new Error("统计服务未连接")
    const { bots } = await readDailyStats(globalThis.redis, {})
    return { statsByBot: bots || {}, error: "" }
  } catch (error) {
    return { statsByBot: {}, error: compactError(error?.message || error) }
  }
}

/**
 * 纯函数：提取窗口内的最终失败投递（搬运 outbox）。
 */
export function extractRelayFailures(deliveries = [], { windowMs = 24 * 60 * 60 * 1000, now = Date.now() } = {}) {
  const windowStart = now - Math.max(MIN_INTERVAL_MS, Number(windowMs) || 0)
  return (Array.isArray(deliveries) ? deliveries : [])
    .filter(job => (job?.state === "failed" || (job?.state === "sent" && job?.fallbackStatus === "link_sent")) && Number(job?.updatedAt || 0) >= windowStart)
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
    .slice(0, FAILURE_LIST_MAX)
    .map(job => ({
      source: "搬运",
      location: `群${job?.groupId || "?"}`,
      groupId: String(job?.groupId || ""),
      detail: `${platformLabel(job?.platform)}：${describeRelayError(job?.fallbackReason || job?.lastError)}`,
      occurredAt: Number(job?.updatedAt || 0),
      fallbackStatus: job?.fallbackStatus || "",
      degraded: job?.state === "sent" && job?.fallbackStatus === "link_sent",
      uncertain: Boolean(job?.uncertain)
    }))
}

/**
 * 纯函数：提取窗口内最终失败的事件任务（近期记录/归档/媒体消费者等管道级失败）。
 */
export function extractEventFailures(events = [], { windowMs = 24 * 60 * 60 * 1000, now = Date.now() } = {}) {
  const windowStart = now - Math.max(MIN_INTERVAL_MS, Number(windowMs) || 0)
  return (Array.isArray(events) ? events : [])
    .filter(job => job?.state === "failed" && Number(job?.updatedAt || 0) >= windowStart)
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
    .slice(0, 5)
    .map(job => ({
      source: "事件",
      location: `群${job?.envelope?.groupId || job?.envelope?.conversationId || "?"}`,
      groupId: String(job?.envelope?.groupId || ""),
      detail: compactError(job?.lastError),
      occurredAt: Number(job?.updatedAt || 0),
      uncertain: false
    }))
}

/**
 * 纯函数：从今日统计提取发送失败（按错误码聚合，任何出站通道的失败都在这里）。
 */
export function extractSendFailures(statsByBot = {}, { max = 6 } = {}) {
  const rows = []
  for (const [botId, stats] of Object.entries(statsByBot || {})) {
    for (const [code, count] of Object.entries(stats?.failCodes || {})) {
      const total = Number(count) || 0
      if (total > 0) rows.push({ botId, code: String(code), count: total })
    }
  }
  return rows.sort((a, b) => b.count - a.count).slice(0, max)
}

/**
 * 纯函数：合并三类失败为展示行（搬运/事件按窗口，发送为今日累计）。
 */
export function buildFailureRows({ relayFailures = [], eventFailures = [], sendFailures = [], nicknameOf = () => "", groupNameOf = () => "" } = {}) {
  const sendRows = sendFailures.map(item => ({
    source: "发送",
    location: `${nicknameOf(item.botId) || "昵称未获取"} · QQ ${item.botId}`,
    detail: `${describeRelayError(item.code)} ×${item.count}（今日）`,
    aggregate: true,
    uncertain: false
  }))
  const taskRows = [...relayFailures, ...eventFailures].map(item => ({
    ...item,
    location: item.groupId ? `${groupNameOf(item.groupId) || "群名未获取"} · 群 ${item.groupId}` : item.location
  }))
  return [...taskRows, ...sendRows].slice(0, FAILURE_LIST_MAX + 6)
}

function countValue(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0
}
function displayCount(value) { return countValue(value).toLocaleString("zh-CN") }

/** Build escaped markup shared by the production renderer and preview. */
export function buildHealthReportView({ now = Date.now(), windowStart = 0, bots = [], statsByBot = {}, failures = [], healthError = "", statsError = "" } = {}) {
  bots = Array.isArray(bots) ? [...bots].sort((a, b) => Number(b.loginState === "已登录" && b.connected !== false) - Number(a.loginState === "已登录" && a.connected !== false)) : []
  failures = Array.isArray(failures) ? failures : []
  const online = bots.filter(bot => bot.loginState === "已登录" && bot.connected !== false).length
  const attention = bots.length - online
  const totals = Object.values(statsByBot || {}).reduce((total, stats) => ({
    recv: total.recv + countValue(stats?.recv), send: total.send + countValue(stats?.send), fail: total.fail + countValue(stats?.fail)
  }), { recv: 0, send: 0, fail: 0 })
  const hasFailure = failures.some(item => !item.degraded) || totals.fail > 0
  const statusTone = hasFailure ? "danger" : healthError || statsError || attention || !bots.length ? "warning" : "success"
  const statusLabel = hasFailure ? "有失败需要排查" : healthError || statsError ? "部分数据待确认" : attention ? `${attention} 个账号需要关注` : bots.length ? "运行正常" : "未采集到机器人"
  const botsHtml = bots.length ? bots.map(bot => {
    const stats = statsByBot[bot.account] || {}
    const state = bot.loginState || "未知"
    const disconnected = state === "已登录" && bot.connected === false
    const stateClass = disconnected ? "state-warn" : STATE_CLASS[state] || "state-warn"
    const stateLabel = disconnected ? "已登录 · 服务未连接" : state === "未知" ? "状态待确认" : state
    const nickname = bot.nickname && bot.nickname !== "（未连接）" && bot.nickname !== String(bot.account) ? bot.nickname : "昵称未获取"
    const metric = (label, value, extra = "") => `<div class="bot-metric ${extra}"><span>${label}</span><strong>${escapeHtml(value)}</strong></div>`
    return `<article class="bot-card ${stateClass}">
      <div class="bot-heading"><div class="bot-identity"><div class="bot-avatar">${escapeHtml(String(bot.account).slice(-2))}</div><div class="bot-name"><h3>${escapeHtml(nickname)}</h3><p>QQ ${escapeHtml(bot.account)}</p></div></div><span class="state-pill ${stateClass}">${escapeHtml(stateLabel)}</span></div>
      <div class="bot-metrics">${metric("内存占用", bot.memory || "未采集", "memory")}${metric("今日收信", statsError ? "—" : displayCount(stats.recv))}${metric("今日发送", statsError ? "—" : displayCount(stats.send))}${metric("发送失败", statsError ? "—" : displayCount(stats.fail), countValue(stats.fail) ? "metric-danger" : "")}</div>
    </article>`
  }).join("") : '<div class="empty-bots">未采集到机器人容器</div>'
  const taskRows = failures.filter(item => !item.aggregate && item.source !== "发送")
  const aggregateRows = failures.filter(item => item.aggregate || item.source === "发送")
  const sendAggregatesHtml = aggregateRows.length ? `<div class="send-aggregates"><strong>今日发送统计（不重复计为任务故障）</strong>${aggregateRows.map(item => `<p>${escapeHtml(item.location)}：${escapeHtml(item.detail)}</p>`).join("")}</div>` : ""
  const failuresHtml = taskRows.length ? taskRows.map(item => `<article class="failure-row"><div class="failure-heading"><span class="source">${escapeHtml(item.source)}</span><strong>${escapeHtml(item.location)}</strong>${item.degraded ? '<span class="badge">已降级发送</span>' : item.uncertain ? '<span class="badge">结果不确定</span>' : ""}</div><p>${item.occurredAt ? `${escapeHtml(formatClock(item.occurredAt))} · ` : ""}${escapeHtml(item.detail)}${item.fallbackStatus === "link_sent" ? "；已发送原视频链接" : ""}</p></article>`).join("")
    : `<div class="failure-empty ${statsError || totals.fail ? "empty-warning" : ""}"><span class="empty-icon">${statsError || totals.fail ? "!" : "✓"}</span><div><strong>${statsError ? "发送统计暂不可用" : totals.fail ? `今日发送失败 ${displayCount(totals.fail)} 次` : "未发现失败记录"}</strong><p>${statsError ? "暂时无法确认今日发送结果，任务窗口内未发现最终失败。" : totals.fail ? "暂无详细错误码，请结合运行观测排查。" : "今日发送无失败，任务窗口内无最终失败。"}</p></div></div>`
  const errors = [healthError ? `容器状态采集不可用：${compactError(healthError)}` : "", statsError ? `消息统计暂不可用：${compactError(statsError)}` : ""].filter(Boolean)
  return {
    generatedAt: formatClock(now),
    windowLabel: `任务失败窗口 ${formatClock(windowStart || now)} ～ ${formatClock(now)}`,
    statsLabel: "收发及发送失败为今日累计",
    statusTone, statusLabel,
    onlineCount: online, botCount: bots.length, attentionCount: attention,
    recvTotal: statsError ? "—" : displayCount(totals.recv), sendTotal: statsError ? "—" : displayCount(totals.send),
    failTotal: statsError ? "—" : displayCount(totals.fail), failureCount: taskRows.filter(item => !item.degraded).length, degradedCount: taskRows.filter(item => item.degraded).length,
    healthErrorHtml: errors.length ? `<div class="data-warning">${errors.map(escapeHtml).join("<br>")}</div>` : "",
    botsHtml, failuresHtml, sendAggregatesHtml
  }
}

function buildTextFallback({ now, bots, statsByBot, failures, healthError, statsError }) {
  const lines = [`【健康报告】${formatClock(now)}（卡片生成暂不可用）`]
  if (healthError) lines.push(`机器人状态：采集不可用（${compactError(healthError)}）`)
  else if (bots.length) {
    lines.push("机器人状态：")
    for (const bot of bots) {
      const stats = statsByBot[bot.account]
      const usage = stats ? `｜今日 收${countValue(stats.recv)} 发${countValue(stats.send)} 败${countValue(stats.fail)}` : ""
      lines.push(`· ${bot.nickname}（${bot.account}）：${bot.loginState}${bot.memory ? `｜内存 ${bot.memory}` : ""}${usage}`)
    }
  }
  if (statsError) lines.push(`今日统计不可用：${compactError(statsError)}`)
  lines.push("任务详情（发送统计不重复计入故障）：")
  if (failures.length) for (const item of failures) lines.push(`- [${item.source}] ${item.location}：${item.occurredAt ? `${formatClock(item.occurredAt)} · ` : ""}${item.detail}${item.degraded ? "（已降级发送原视频链接）" : ""}${item.aggregate ? "（今日发送统计，非新增故障）" : ""}${item.uncertain ? "（结果不确定，未自动重试）" : ""}`)
  else lines.push(statsError ? "任务窗口内无最终失败；今日发送情况暂不可确认。" : "任务窗口内无最终失败。")
  return lines.join("\n")
}

/** Normalize renderer bytes and segments to a OneBot image readable inside NapCat containers. */
export async function healthReportImageMessage(rendered) {
  if (!rendered) return null
  if (Array.isArray(rendered) && !Buffer.isBuffer(rendered)) {
    const images = await Promise.all(rendered.map(healthReportImageMessage))
    const result = images.flatMap(value => value || [])
    return result.length ? result : null
  }
  const file = rendered?.file ?? rendered?.data?.file ?? rendered
  let bytes
  if (Buffer.isBuffer(file) || file instanceof Uint8Array) bytes = Buffer.from(file)
  else if (typeof file === "string") {
    if (file.startsWith("base64://")) bytes = Buffer.from(file.slice(9), "base64")
    else if (/^data:image\/[^;]+;base64,/.test(file)) bytes = Buffer.from(file.slice(file.indexOf(",") + 1), "base64")
    else if (!/^https?:\/\//.test(file)) bytes = await fs.promises.readFile(file.startsWith("file://") ? fileURLToPath(file) : file)
  }
  if (!bytes?.length) return null
  return [{ type: "image", data: { file: `base64://${bytes.toString("base64")}` } }]
}

export async function renderHealthReportCard(view, { render } = {}) {
  if (!render) {
    const { default: renderer } = await import("../../../../lib/renderer/loader.js")
    render = (name, data) => renderer.getRenderer().render(name, data)
  }
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
  const data = { tplFile: path.join(pluginRoot, "resources/html/healthReport/healthReport.html"), saveId: "health-report", imgType: "png", pageGotoParams: { waitUntil: "load", timeout: 60000 }, sys: { scale: "" }, ...view }
  const message = await healthReportImageMessage(await render("healthReport", data))
  if (!message) throw new Error("渲染器未返回可用图片")
  return message
}

function pickSendBot(deliveries = []) {
  const root = globalThis.Bot
  if (!root) return null
  const frequency = new Map()
  for (const job of deliveries) {
    const botId = String(job?.botId || "").trim()
    if (botId) frequency.set(botId, (frequency.get(botId) || 0) + 1)
  }
  const preferred = [...frequency.entries()].sort((a, b) => b[1] - a[1]).map(([botId]) => botId)
  for (const botId of preferred) {
    const bot = root.bots?.[botId]
    if (typeof bot?.sendApi === "function") return bot
  }
  for (const bot of Object.values(root.bots || {})) {
    if (typeof bot?.sendApi === "function") return bot
  }
  return typeof root.sendApi === "function" ? root : null
}

async function pushReport({ store, logger, groupId, windowMs }) {
  const now = Date.now()
  const [deliveries, events] = await Promise.all([store.list("delivery"), store.list("event")])
  const relayFailures = extractRelayFailures(deliveries, { windowMs, now })
  const eventFailures = extractEventFailures(events, { windowMs, now })
  const [health, usage] = await Promise.all([collectBotHealth({ logger }), collectUsageStats()])
  const { statsByBot } = usage
  const names = mergeGroupNames(readCachedGroupNames(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")), collectBotGroupNames())
  const failures = buildFailureRows({
    relayFailures,
    eventFailures,
    sendFailures: extractSendFailures(statsByBot),
    nicknameOf: botId => globalThis.Bot?.bots?.[String(botId)]?.nickname || "",
    groupNameOf: id => names.get(String(id)) || ""
  })
  const context = {
    now,
    windowStart: now - windowMs,
    bots: health.bots,
    statsByBot,
    failures,
    healthError: health.error,
    statsError: usage.error
  }
  const bot = pickSendBot(deliveries)
  if (!bot) {
    logger?.warn?.(`[健康报告] 没有可用的 OneBot sendApi，跳过本次推送 group=${groupId}`)
    return
  }
  let message = null
  try {
    message = await renderHealthReportCard(buildHealthReportView(context), { logger })
  } catch (error) {
    logger?.warn?.(`[健康报告] 卡面渲染失败，回退纯文本：${compactError(error)}`)
  }
  const format = message ? "image" : "text-fallback"
  if (!message) message = buildTextFallback(context)
  const result = await bot.sendApi("send_group_msg", { group_id: Number(groupId), message })
  if (Number(result?.retcode) !== 0) {
    logger?.warn?.(`[健康报告] 推送失败 group=${groupId} retcode=${result?.retcode ?? "?"} ${String(result?.wording || result?.msg || "").slice(0, 120)}`)
    return
  }
  logger?.info?.(`[健康报告] 已推送 format=${format} group=${groupId} message=${result?.data?.message_id || result?.message_id || ""}`)
}

function readReportConfig() {
  const cfg = readUserSettings()?.mediaRelayAdminReport || {}
  return {
    enabled: cfg.enabled !== false,
    groupId: String(cfg.groupId || "").trim(),
    intervalMs: Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, (Number(cfg.intervalHours) || 24) * 60 * 60 * 1000))
  }
}

/**
 * 定时向管理群推送健康报告卡面：机器人登录态与内存、今日收发统计、失败汇总。
 * 每次触发时重读配置（控制台"消息管道"页保存即生效，无需重启）；
 * 推送失败只记日志，一小时后重试，不影响下一周期。
 */
export function startMediaRelayAdminReport({ store, logger = globalThis.logger } = {}) {
  if (!store) return null
  let stopped = false
  let timer = null
  const schedule = delayMs => {
    if (stopped) return
    timer = setTimeout(tick, Math.max(60_000, delayMs))
    timer.unref?.()
  }
  const tick = async () => {
    if (stopped) return
    try {
      const { enabled, groupId, intervalMs } = readReportConfig()
      if (enabled && /^\d{5,12}$/.test(groupId)) {
        await pushReport({ store, logger, groupId, windowMs: intervalMs })
      }
      schedule(intervalMs)
    } catch (error) {
      logger?.warn?.(`[健康报告] 周期执行异常，1 小时后重试：${String(error?.message || error).slice(0, 160)}`)
      schedule(60 * 60 * 1000)
    }
  }
  schedule(FIRST_PUSH_DELAY_MS)
  logger?.info?.("[健康报告] 定时推送已就绪（控制台\"消息管道\"页启用后生效）")
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
