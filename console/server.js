#!/usr/bin/env node
import { ensureBackendArtifacts } from "../utils/backendArtifactGuard.js";
await ensureBackendArtifacts();
// bl-chat 控制台: Vue 前端静态服务 + 配置与运营 API + 账密登录。
// 零外部新增依赖:
//   - 自带迷你 Redis 客户端(RESP,只读 SCAN/GET/HGETALL，支持嵌套 RESP 数组与查询超时)
//   - docker CLI / nsenter 取容器状态、内存与出口 IP
//   - 读哨兵(bot-sentinel)的状态与告警文件
//   - 生图直接复用插件内纯逻辑模块(utils/imageGenerationFallback.js 等,均零 import),
//     渠道与密钥仍以 config/message.yaml 为唯一来源,与 bot 走同一套 fallback 顺序
//   - AI 配置复用锅巴同源模块(utils/guobaAiProviderConfig.js 的 definitions 与归一化),
//     写入用 YAML 定点更新(不改排整份文件),保存前自动备份,各配置按初始化/热读/调度周期读取，保存不执行重启
//   - 登录:账密(scrypt 哈希,Cookie 会话)+ 原令牌并存(令牌供 curl/脚本自动化)
// yaml 包复用插件自身 node_modules,不新增安装项。
// 部署:systemd 独立服务(见 console/bl-console.service),与 Yunzai 进程解耦。
import { createImageService } from '../dist/backend/modules/image/application/imageService.js'
import { createImageResource } from '../dist/backend/modules/image/infrastructure/imageResource.js'
import { normalizeCustomSize, normalizeQuality } from '../dist/backend/modules/image/domain/imageInput.js'
import { createConfigRepository, ConfigConflictError } from '../dist/backend/modules/config/infrastructure/configRepository.js'
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import YAML from "yaml"
import { readImageDimensions } from "../utils/imageDimensions.js"
import { isGrokImageModel, applyImageAspectRatioToConfigs, resolveImageAspectRatioIntent } from "../utils/imageAspectRatio.js"
import {
  describeImageGenerationConfig,
  resolveImageEditConfigs,
  resolveImageGenerationConfigs,
  selectImageConfigsByProvider
} from "../utils/imageGenerationFallback.js"
import { serializeMultipartFormData } from "../utils/multipartFormData.js"
import {
  AI_PROVIDER_DEFINITIONS,
  getConfiguredProviders,
  getProviderDefinition,
  normalizeAiProviderUpdates,
  normalizeProviderForPanel,
  withAiProviderPanelDefaults
} from "../utils/guobaAiProviderConfig.js"
import { classifyConfigKind, probeProvider, probeProviders } from "../utils/aiProviderProbe.js"
import { createPersonaLibrary } from "../utils/personaLibrary.js"
import reasoningSchema from "../models/configSchemas/reasoning.js"
import conversationSchema from "../models/configSchemas/conversation.js"
import personaSchema from "../models/Guoba/schemas/persona.js"
import messagePipelineSchema from "../models/Guoba/schemas/messagePipeline.js"
import riskControlSchema from "../models/Guoba/schemas/riskControl.js"
import { buildTurnTraceReport } from "../scripts/turn-trace-report.mjs"
import { resolveTurnTraceArchiveDir } from "../utils/turnTrace.js"
import { readCachedGroupNames, mergeGroupNames } from "../utils/groupNames.js"

import { buildSchemaConfigView, prepareSchemaUpdates } from "./lib/schemaConfig.js"
import { identifiableProviders, maskProvider, restoreProviderCredentials, providerRevision } from "./lib/providerCredentials.js"
import { serveFrontend } from "./lib/frontendStatic.js"
import { MiniRedis } from "./lib/redisClient.js"
import { readPipelineJobs, pipelineJobFilters } from "./lib/pipelineJobs.js"

// Optional isolated fixture/deployment root; imports still resolve from the plugin code directory.
const PLUGIN_ROOT = path.resolve(process.env.CONSOLE_PLUGIN_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."))
const FRONTEND_DIST = path.join(PLUGIN_ROOT, "console", "frontend", "dist")
const PORT = Number(process.env.CONSOLE_PORT || 8787)
const HOST = process.env.CONSOLE_HOST || "0.0.0.0"
const MESSAGE_YAML = path.join(PLUGIN_ROOT, "config", "message.yaml")
const configRepository = createConfigRepository({ file: MESSAGE_YAML })

// ---------- 令牌(并存:供 curl/脚本自动化与 img 直链) ----------
function loadOrCreateToken() {
  const file = path.join(PLUGIN_ROOT, "config", "console.json")
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"))
    if (parsed?.token && parsed.token.length >= 8) return parsed.token
  } catch {}
  const token = crypto.randomBytes(12).toString("hex")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ token, createdAt: new Date().toISOString() }, null, 2))
  return token
}
const TOKEN = loadOrCreateToken()

// ---------- 账密登录 ----------
const USERS_FILE = path.join(PLUGIN_ROOT, "config", "console-users.json")
const SESSION_COOKIE = "bl_console_sid"
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000
const LOGIN_MAX_FAILS = 5
const LOGIN_WINDOW_MS = 15 * 60 * 1000
const LOGIN_LOCK_MS = 10 * 60 * 1000
const sessions = new Map() // sid -> { username, expiresAt }
const loginAttempts = new Map() // username -> { count, firstAt, lockedUntil }

function loadUserStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"))
    if (Array.isArray(parsed?.users)) return parsed
  } catch {}
  return { users: [] }
}

function saveUserStore(store) {
  fs.mkdirSync(path.dirname(USERS_FILE), { recursive: true })
  fs.writeFileSync(USERS_FILE, JSON.stringify(store, null, 2))
}

function scryptHash(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(String(password), String(salt), 64, (error, derived) =>
      error ? reject(error) : resolve(derived.toString("hex")))
  })
}

async function passwordMatches(user, password) {
  const expected = Buffer.from(String(user.hash || ""), "hex")
  if (!expected.length) return false
  const actual = Buffer.from(await scryptHash(String(password), user.salt), "hex")
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected)
}

function parseCookies(header = "") {
  const out = {}
  for (const part of String(header || "").split(";")) {
    const idx = part.indexOf("=")
    if (idx > 0) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim())
  }
  return out
}

function sessionUser(req) {
  const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE]
  const session = sid && sessions.get(sid)
  if (session && session.expiresAt > Date.now()) {
    session.expiresAt = Date.now() + SESSION_TTL_MS // 滑动续期
    return { username: session.username, via: "session" }
  }
  return null
}

function loginRateState(username) {
  const now = Date.now()
  const state = loginAttempts.get(username) || { count: 0, firstAt: now, lockedUntil: 0 }
  if (now - state.firstAt > LOGIN_WINDOW_MS) { state.count = 0; state.firstAt = now }
  return state
}

async function authenticateLogin(username, password) {
  const state = loginRateState(username)
  if (state.lockedUntil > Date.now()) {
    const waitMin = Math.ceil((state.lockedUntil - Date.now()) / 60000)
    throw Object.assign(new Error(`尝试次数过多，请 ${waitMin} 分钟后再试`), { status: 429 })
  }
  const store = loadUserStore()
  const user = store.users.find(item => item.username === username)
  const ok = user ? await passwordMatches(user, password) : false
  if (!ok) {
    state.count++
    if (state.count >= LOGIN_MAX_FAILS) {
      state.lockedUntil = Date.now() + LOGIN_LOCK_MS
      state.count = 0
      state.firstAt = Date.now()
    }
    loginAttempts.set(username, state)
    throw Object.assign(new Error(user ? "密码错误" : "用户名或密码错误"), { status: 401 })
  }
  loginAttempts.delete(username)
  return user
}

function issueSession(res, username) {
  const sid = crypto.randomBytes(24).toString("hex")
  sessions.set(sid, { username, expiresAt: Date.now() + SESSION_TTL_MS })
  res.setHeader("set-cookie",
    `${SESSION_COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`)
  return sid
}

// ---------- 工具 ----------
const run = (cmd, args, timeoutMs = 12000) => new Promise(resolve => {
  execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => resolve({ error, stdout: String(stdout || "") }))
})
// 二进制版 stdout(如容器里的二维码 png)
const runRaw = (cmd, args, timeoutMs = 15000) => new Promise(resolve => {
  execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: "buffer" }, (error, stdout) =>
    resolve({ error, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0) }))
})

function dayKey(offsetDays = 0) {
  const d = new Date(Date.now() - offsetDays * 86400000)
  const pad = n => String(n).padStart(2, "0")
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

// ---------- 数据采集 ----------
const exitIpCache = new Map() // sidecarName -> { ip, at }
async function sidecarExitIp(sidecar) {
  const cached = exitIpCache.get(sidecar)
  if (cached && Date.now() - cached.at < 60000) return cached.ip
  const pid = await run("docker", ["inspect", "-f", "{{.State.Pid}}", sidecar])
  if (pid.error || !Number(pid.stdout.trim())) return null
  const curl = await run("nsenter", ["-t", pid.stdout.trim(), "-n", "curl", "-s", "-m", "6", "http://ifconfig.me"], 15000)
  const ip = curl.error ? null : curl.stdout.trim()
  if (ip) exitIpCache.set(sidecar, { ip, at: Date.now() })
  return ip
}

// napcat 登录态判定:按时间顺序找最后一条命中的日志特征(特征格式取自真实生产日志)
const LOGIN_LOG_TAIL = 400
const LOGIN_MARKERS = [
  { re: /请扫描下面的二维码|二维码已保存到|二维码解码URL/, state: "待扫码" },
  { re: /KickedOffLine|登录已失效|账号已离线|下线通知/, state: "掉线" },
  { re: /\[Login\]\s*Login Error/i, state: "掉线" },
  { re: /快速登录|扫码登录成功|登录成功|反向WebSocket.*已(启动|连接)|WebSocket Client.*连接(成功|建立)|发送 ->|接收 <-|收到 <-/, state: "已登录" }
]
function parseLoginState(logText = "") {
  const lines = String(logText || "").split("\n")
  let matched = null
  for (const line of lines) {
    for (const marker of LOGIN_MARKERS) {
      if (marker.re.test(line)) { matched = marker.state; break }
    }
  }
  return matched || "未知"
}

async function loginStateOf(container, running) {
  if (!running) return "掉线"
  const logs = await run("docker", ["logs", "--tail", String(LOGIN_LOG_TAIL), container], 15000)
  if (logs.error) return "未知"
  return parseLoginState(logs.stdout)
}

// ---------- 设备指纹持久化(NapCat 的 QQ 数据目录 = 设备身份载体) ----------
// 容器重建若丢失 /opt/napcat-<qq>/qq 挂载,QQ 会生成全新设备身份——指纹频繁漂移是
// 高危风控信号。这里对目录结构做哈希并跨周期追踪,变化即标记。
const FINGERPRINT_FILE = path.join(PLUGIN_ROOT, "config", "device-fingerprints.json")

function fingerprintOfDir(dir = "") {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .map(entry => `${entry.name}${entry.isDirectory() ? "/" : ""}`)
      .sort()
    if (!entries.length) return ""
    const hash = crypto.createHash("sha1")
    hash.update(entries.join("\n"))
    return hash.digest("hex").slice(0, 16)
  } catch {
    return ""
  }
}

function loadFingerprintStore() {
  try { return JSON.parse(fs.readFileSync(FINGERPRINT_FILE, "utf8")) || {} } catch { return {} }
}

function trackDeviceFingerprint(account = "") {
  if (!account) return null
  const dir = path.join(NAPCAT_BASE, `napcat-${account}`, "qq")
  const hash = fingerprintOfDir(dir)
  if (!hash) return null
  const store = loadFingerprintStore()
  const prev = store[account]
  const nowIso = new Date().toISOString()
  if (prev && prev.hash === hash) {
    store[account] = { ...prev, lastSeen: nowIso }
  } else if (prev) {
    store[account] = { hash, firstSeen: prev.firstSeen, lastSeen: nowIso, changes: (Number(prev.changes) || 0) + 1 }
    console.error(`[指纹] 账号 ${account} 设备指纹变化: ${prev.hash} -> ${hash}`)
  } else {
    store[account] = { hash, firstSeen: nowIso, lastSeen: nowIso, changes: 0 }
  }
  try {
    fs.mkdirSync(path.dirname(FINGERPRINT_FILE), { recursive: true })
    fs.writeFileSync(FINGERPRINT_FILE, JSON.stringify(store, null, 2))
  } catch {}
  const tracked = store[account]
  return { stable: tracked.changes === 0, changes: tracked.changes, firstSeen: tracked.firstSeen }
}

async function collectAccounts() {
  const list = await run("docker", ["ps", "-a", "--filter", "name=napcat", "--format", "{{.Names}}"])
  if (list.error) return []
  const names = list.stdout.split("\n").map(s => s.trim()).filter(Boolean)
  if (!names.length) return []
  // 逐容器并行采集;内存走 cgroup 直读(见 containerMemoryFromCgroup),不再调用 docker stats
  const accounts = await Promise.all(names.map(async name => {
    const info = await run("docker", ["inspect", "-f",
      "{{.Id}}|{{.State.Status}}|{{.State.Running}}|{{.HostConfig.NetworkMode}}|{{range $k, $v := .NetworkSettings.Ports}}{{$k}}->{{(index $v 0).HostPort}} {{end}}|{{range .Config.Env}}{{.}} {{end}}", name])
    if (info.error) return null
    const [containerId, status, running, networkMode, portMaps, env] = info.stdout.trim().split("|")
    const account = (env || "").split(" ").find(item => item.startsWith("ACCOUNT="))?.slice(8) || ""
    const sidecarRef = networkMode?.startsWith("container:") ? networkMode.slice("container:".length) : ""
    // 端口映射挂在 sidecar(网络的 owner)身上,napcat 只共享命名空间
    let webuiPort = [...(portMaps || "").matchAll(/6099\/tcp->(\d+)/g)][0]?.[1]
    let sidecarName = sidecarRef
    if (sidecarRef) {
      const sidecarInfo = await run("docker", ["inspect", "-f",
        "{{.Name}}|{{range $k, $v := .NetworkSettings.Ports}}{{$k}}->{{(index $v 0).HostPort}} {{end}}", sidecarRef])
      if (!sidecarInfo.error) {
        const [sname, sports] = sidecarInfo.stdout.trim().split("|")
        sidecarName = (sname || "").replace(/^\//, "") || sidecarRef
        if (!webuiPort) webuiPort = [...(sports || "").matchAll(/6099\/tcp->(\d+)/g)][0]?.[1]
      }
    }
    const exitIp = sidecarRef ? await sidecarExitIp(sidecarRef) : "host-network(未隔离)"
    const runningBool = running === "true"
    const loginState = await loginStateOf(name, runningBool)
    return {
      container: name,
      containerId,
      account,
      status: status || "unknown",
      running: runningBool,
      sidecar: sidecarName || null,
      exitIp,
      loginState,
      qrAvailable: runningBool && loginState === "待扫码",
      webuiPort,
      webui: null
    }
  }))
  const [ip, directory] = await Promise.all([publicIp(), collectIdentityDirectory()])
  const botNames = new Map(directory.bots.map(bot => [bot.id, bot.name]))
  for (const item of accounts) {
    if (!item) continue
    item.nickname = botNames.get(item.account) || ""
    item.memory = containerMemoryFromCgroup(item.containerId, item.running)
    item.webui = item.webuiPort ? `http://${ip}:${item.webuiPort}` : null
    item.fingerprint = item.account ? trackDeviceFingerprint(item.account) : null
    delete item.webuiPort
    delete item.containerId
  }
  return accounts.filter(Boolean)
}

// docker stats --no-stream 要秒级采样;内存直接读 cgroup v2 文件,瞬时完成
function containerMemoryFromCgroup(containerId = "", running = false) {
  if (!running || !containerId) return ""
  const scope = `/sys/fs/cgroup/system.slice/docker-${containerId}.scope`
  try {
    const current = Number(fs.readFileSync(`${scope}/memory.current`, "utf8").trim())
    if (!Number.isFinite(current)) return ""
    const format = bytes => bytes >= 1024 ** 3
      ? `${(bytes / 1024 ** 3).toFixed(2)}GiB`
      : `${(bytes / 1024 ** 2).toFixed(0)}MiB`
    const maxRaw = fs.readFileSync(`${scope}/memory.max`, "utf8").trim()
    if (maxRaw !== "max" && Number(maxRaw) > 0) return `${format(current)} / ${format(Number(maxRaw))}`
    return format(current)
  } catch {
    return ""
  }
}

// 后台保温:每 45 秒预热出口IP缓存,用户请求不再等 nsenter curl(最多6秒)
function prefetchExitIps() {
  setTimeout(async () => {
    try {
      const list = await run("docker", ["ps", "--filter", "name=napcat", "--format", "{{.Names}}"])
      for (const name of list.stdout.split("\n").map(s => s.trim()).filter(Boolean)) {
        const info = await run("docker", ["inspect", "-f", "{{.HostConfig.NetworkMode}}", name])
        const ref = (String(info.stdout || "").trim().match(/^container:(.+)$/) || [])[1]
        if (ref) await sidecarExitIp(ref)
      }
    } catch {}
    prefetchExitIps()
  }, 45000)
}
prefetchExitIps()

let publicIpCache = null
async function publicIp() {
  if (publicIpCache) return publicIpCache
  const res = await run("curl", ["-s", "-m", "6", "http://ifconfig.me"])
  publicIpCache = res.error ? "127.0.0.1" : res.stdout.trim()
  return publicIpCache
}

function collectSentinel() {
  const statusFile = "/var/lib/bot-sentinel/status.txt"
  const logFile = "/var/log/bot-sentinel.log"
  let status = ""
  try { status = fs.readFileSync(statusFile, "utf8").trim() } catch { status = "(哨兵状态不可读)" }
  let alerts = []
  try {
    const lines = fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean)
    alerts = lines.slice(-8)
  } catch {}
  return { status, alerts }
}

async function collectStats(redis) {
  if (!redis) return null
  let total = { recv: 0, send: 0, fail: 0 }
  const perDay = []
  for (let offset = 6; offset >= 0; offset--) {
    const key = `shiloh:stats:d:${dayKey(offset)}`
    const hash = await redis.hgetall(key).catch(() => ({}))
    let recv = 0, send = 0, fail = 0
    for (const [field, count] of Object.entries(hash)) {
      const value = Number(count) || 0
      if (field.startsWith("recv:") && !field.includes(":g:")) recv += value
      else if (field.startsWith("send:") && !field.includes(":ch:") && !field.includes(":g:")) send += value
      else if (field.startsWith("fail:") && field.split(":").length === 2) fail += value
    }
    perDay.push({ day: dayKey(offset), recv, send, fail })
    total.recv += recv
    total.send += send
    total.fail += fail
  }
  const today = await redis.hgetall(`shiloh:stats:d:${dayKey(0)}`).catch(() => ({}))
  const todayGroups = {}
  for (const [field, count] of Object.entries(today)) {
    const groupMatch = field.match(/:g:(\d+)$/)
    if (groupMatch) {
      todayGroups[groupMatch[1]] ||= { recv: 0, send: 0 }
      if (field.startsWith("recv:")) todayGroups[groupMatch[1]].recv += Number(count) || 0
      if (field.startsWith("send:")) todayGroups[groupMatch[1]].send += Number(count) || 0
    }
  }
  return { week: perDay, total, todayGroups }
}

async function buildOverview() {
  const [accounts, stats, sentinel] = await Promise.all([
    collectAccounts(),
    (async () => {
      try {
        const redis = await new MiniRedis().connect()
        const stats = await collectStats(redis)
        redis.socket?.end()
        return stats
      } catch { return null }
    })(),
    Promise.resolve(collectSentinel())
  ])
  return { at: new Date().toISOString(), accounts, stats, sentinel }
}

// ---------- 实体 API:机器人详情 / 群聊 / 原生运行观测 ----------
async function collectBotStats(qq = "") {
  try {
    const redis = await new MiniRedis().connect()
    const hash = await redis.hgetall(`shiloh:stats:d:${dayKey(0)}`).catch(() => ({}))
    redis.socket?.end()
    const today = { recv: 0, send: 0, fail: 0 }
    const failCodes = {}
    for (const [field, count] of Object.entries(hash || {})) {
      const parts = String(field).split(":")
      if (parts[1] !== String(qq)) continue
      const value = Number(count) || 0
      if (parts[0] === "recv" && parts.length === 2) today.recv += value
      else if (parts[0] === "send" && parts.length === 2) today.send += value
      else if (parts[0] === "fail" && parts.length === 2) today.fail += value
      else if (parts[0] === "fail" && parts.length > 2) failCodes[parts.slice(2).join(":")] = value
    }
    return { today, failCodes }
  } catch {
    return { today: { recv: 0, send: 0, fail: 0 }, failCodes: {} }
  }
}

async function collectGroups() {
  const settings = loadPluginSettings()
  const allowed = (Array.isArray(settings.allowedGroups) ? settings.allowedGroups : []).map(String)
  const groups = new Map()
  const ensure = id => {
    let entry = groups.get(id)
    if (!entry) {
      entry = { id, whitelisted: allowed.includes(id), today: { recv: 0, send: 0 }, bots: new Set() }
      groups.set(id, entry)
    }
    return entry
  }
  for (const id of allowed) ensure(id)
  // 直接读今日 hash,拿到"每号×每群"的活跃拆分
  try {
    const redis = await new MiniRedis().connect()
    const hash = await redis.hgetall(`shiloh:stats:d:${dayKey(0)}`).catch(() => ({}))
    redis.socket?.end()
    for (const [field, count] of Object.entries(hash || {})) {
      const match = field.match(/^(recv|send):([^:]+):g:(\d+)$/)
      if (!match) continue
      const [, kind, botId, groupId] = match
      const entry = ensure(groupId)
      entry.today[kind] += Number(count) || 0
      entry.bots.add(botId)
    }
  } catch {}
  const directory = await collectIdentityDirectory()
  const names = new Map(directory.groups.map(group => [group.id, group.name]))
  return {
    groups: [...groups.values()]
      .map(entry => ({ ...entry, name: names.get(entry.id) || "", bots: [...entry.bots] }))
      .sort((a, b) => (b.today.recv + b.today.send) - (a.today.recv + a.today.send))
  }
}

function readRecentTraceRecords(days = 2) {
  const dir = resolveTurnTraceArchiveDir(path.join(PLUGIN_ROOT, "data", "turn_trace"))
  if (!fs.existsSync(dir)) return []
  const wanted = new Set()
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 86400000)
    const pad = v => String(v).padStart(2, "0")
    wanted.add(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)
  }
  const records = []
  for (const file of fs.readdirSync(dir).sort().reverse()) {
    if (!wanted.has(file.replace(/\.ndjson$/, ""))) continue
    try {
      for (const line of fs.readFileSync(path.join(dir, file), "utf8").split("\n")) {
        if (line.trim()) { try { records.push(JSON.parse(line)) } catch {} }
      }
    } catch {}
  }
  return records
}

function collectObserveSummary() {
  const records = readRecentTraceRecords(2)
  const buckets = new Map()
  for (const record of records) {
    if (!record?.turnId) continue
    const hour = String(record.at || "").slice(0, 13)
    const entry = buckets.get(hour) || { turns: 0, failures: 0 }
    entry.turns += 1
    if ((record.failures || []).length) entry.failures += 1
    buckets.set(hour, entry)
  }
  const recent = records
    .filter(record => record?.turnId)
    .slice(-20)
    .reverse()
    .map(record => ({
      at: String(record.at || "").slice(11, 19),
      group: String(record.groupId || ""),
      trigger: record.trigger?.mode || "-",
      tools: (record.tools || []).map(tool => `${tool.name}${tool.ok === false ? "✗" : ""}`).join(",") || "-",
      outbound: record.outbound || 0,
      totalMs: record.totalMs || 0,
      failures: (record.failures || []).slice(0, 3).map(f => f?.stage).filter(Boolean)
    }))
  return {
    report: buildTurnTraceReport(records),
    hours: [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-24).map(([hour, v]) => ({ hour, ...v })),
    recent
  }
}

// ---------- 账号托管操作(P3) ----------
const CONTAINER_ACTIONS = new Set(["start", "stop", "restart"])
const CONTAINER_NAME_RE = /^[\w][\w.-]*$/
let activeAccountOps = 0

async function listNapcatContainers() {
  const list = await run("docker", ["ps", "-a", "--filter", "name=napcat", "--format", "{{.Names}}"])
  if (list.error) return []
  return list.stdout.split("\n").map(s => s.trim()).filter(Boolean)
}

async function handleAccountAction(payload = {}) {
  const action = String(payload.action || "").trim()
  if (!CONTAINER_ACTIONS.has(action)) throw new Error(`不支持的操作: ${action || "(空)"}(可用 start/stop/restart)`)
  const requested = (Array.isArray(payload.containers) ? payload.containers : [payload.containers])
    .map(name => String(name || "").trim())
    .filter(Boolean)
  if (!requested.length) throw new Error("没有指定容器")
  if (requested.length > 10) throw new Error("单次最多操作 10 个容器")
  for (const name of requested) {
    if (!CONTAINER_NAME_RE.test(name) || !name.includes("napcat")) {
      throw new Error(`容器名不合法: ${name}(只允许操作 napcat 账号容器)`)
    }
  }
  const known = new Set(await listNapcatContainers())
  const unknown = requested.filter(name => !known.has(name))
  if (unknown.length) throw new Error(`未发现的容器: ${unknown.join(", ")}`)

  if (activeAccountOps > 0) throw new Error("已有账号操作在进行中，请稍候")
  activeAccountOps++
  try {
    const results = []
    for (const name of requested) {
      const note = []
      // 网络依赖:napcat 共享 mihomo sidecar 的网络命名空间,
      // 启动前必须先拉起 sidecar,否则 docker start 报 cannot join network of a non running container
      let sidecarId = ""
      if (action === "start" || action === "restart") {
        const netInfo = await run("docker", ["inspect", "-f", "{{.HostConfig.NetworkMode}}", name])
        sidecarId = (String(netInfo.stdout || "").trim().match(/^container:(.+)$/) || [])[1] || ""
        if (sidecarId) {
          const sidecarState = await run("docker", ["inspect", "-f", "{{.State.Running}}", sidecarId])
          if (String(sidecarState.stdout || "").trim() !== "true") {
            const boot = await run("docker", ["start", sidecarId], 60000)
            if (boot.error) {
              results.push({ container: name, ok: false, error: `出口 sidecar 启动失败: ${String(boot.error.message || boot.error).slice(0, 160)}` })
              continue
            }
            note.push("已先启动出口 sidecar")
          }
        }
      }
      const outcome = await run("docker", [action, name], 60000)
      // 停止时把 sidecar 一并停掉,回到"停机备号 0 内存"形态
      if (!outcome.error && action === "stop" && sidecarId === "") {
        const netInfo = await run("docker", ["inspect", "-f", "{{.HostConfig.NetworkMode}}", name])
        const stopId = (String(netInfo.stdout || "").trim().match(/^container:(.+)$/) || [])[1] || ""
        if (stopId) {
          await run("docker", ["stop", stopId], 60000)
          note.push("出口 sidecar 已一并停止")
        }
      }
      results.push({
        container: name,
        ok: !outcome.error,
        error: outcome.error ? String(outcome.error.message || outcome.error).slice(0, 200) : "",
        note: note.join(";")
      })
    }
    return { ok: results.every(item => item.ok), action, results }
  } finally {
    activeAccountOps--
  }
}


// ---------- 添加账号(封装 /opt/napcat-exit/add-account.sh 开通停机备号) ----------
// 依据现有编排自动分配:子网取 172.28.N 最小未用序号,端口取 mihomo-* 已占 6099 映射之外的最小值
async function nextSubnetAndPort() {
  const usedSubnets = new Set()
  const nets = await run("docker", ["network", "ls", "--format", "{{.Name}}"])
  for (const name of nets.stdout.split("\n").map(s => s.trim()).filter(n => n.startsWith("napcat-net-"))) {
    const detail = await run("docker", ["network", "inspect", name, "--format", "{{range .IPAM.Config}}{{.Subnet}} {{end}}"])
    const match = detail.stdout.match(/172\.28\.(\d+)\./)
    if (match) usedSubnets.add(Number(match[1]))
  }
  let subnet = 1
  while (usedSubnets.has(subnet) && subnet <= 250) subnet++

  const usedPorts = new Set()
  const sidecars = await run("docker", ["ps", "-a", "--filter", "name=mihomo", "--format", "{{.Names}}"])
  for (const name of sidecars.stdout.split("\n").map(s => s.trim()).filter(Boolean)) {
    const detail = await run("docker", ["inspect", "-f",
      "{{range $k, $v := .NetworkSettings.Ports}}{{$k}}->{{(index $v 0).HostPort}} {{end}}", name])
    for (const m of detail.stdout.matchAll(/6099\/tcp->(\d+)/g)) usedPorts.add(Number(m[1]))
  }
  let port = 6100
  while (usedPorts.has(port) && port < 65500) port++
  return { subnet, port }
}


// 开号后预配 onebot11 反向 ws:抄主号的 token 与参数,url 按本账号子网生成,
// 免去登录后手工编辑 onebot11_<qq>.json 的步骤
const NAPCAT_BASE = process.env.CONSOLE_NAPCAT_BASE || "/opt"

function findMainOnebotTemplate() {
  let bases = []
  try {
    bases = fs.readdirSync(NAPCAT_BASE).filter(n => n.startsWith("napcat")).map(n => path.join(NAPCAT_BASE, n, "config"))
  } catch { return null }
  for (const dir of bases) {
    try {
      for (const name of fs.readdirSync(dir).sort()) {
        if (!/^onebot11_.*\.json$/.test(name)) continue
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"))
        const client = parsed?.network?.websocketClients?.[0]
        if (client?.token) return client
      }
    } catch {}
  }
  return null
}

function writeOnebotConfig(qq, subnet) {
  const dir = path.join(NAPCAT_BASE, `napcat-${qq}`, "config")
  fs.mkdirSync(dir, { recursive: true })
  const url = `ws://172.28.${subnet}.1:2536/OneBotv11`
  const template = findMainOnebotTemplate()
  const client = template
    ? { ...template, enable: true, name: `napcat-${qq}`, url }
    : { enable: true, name: `napcat-${qq}`, url, reportSelfMessage: false, messagePostFormat: "array", token: "", debug: false, heartInterval: 30000, reconnectInterval: 30000, verifyCertificate: true }
  const config = { network: { httpServers: [], httpSseServers: [], httpClients: [], websocketServers: [], websocketClients: [client] }, musicSignUrl: "" }
  fs.writeFileSync(path.join(dir, `onebot11_${qq}.json`), JSON.stringify(config, null, 2))
  return url
}

async function handleAddAccount(payload = {}) {
  const qq = String(payload.qq || "").trim()
  if (!/^([1-9]\d{4,11})$/.test(qq)) throw new Error("QQ 号格式不正确(5-12位数字)")
  let port = Number(payload.port)
  let subnet = Number(payload.subnet)
  if (port && !(Number.isInteger(port) && port >= 1024 && port <= 65535)) throw new Error("WebUI 端口需在 1024-65535")
  if (subnet && !(Number.isInteger(subnet) && subnet >= 1 && subnet <= 250)) throw new Error("子网序号需在 1-250")
  const known = new Set(await listNapcatContainers())
  if (known.has(`napcat-${qq}`)) throw new Error(`账号 ${qq} 的容器已存在`)
  if (!port || !subnet) {
    const auto = await nextSubnetAndPort()
    port = port || auto.port
    subnet = subnet || auto.subnet
  }
  const script = process.env.CONSOLE_ADD_ACCOUNT_SH || "/opt/napcat-exit/add-account.sh"
  if (!fs.existsSync(script)) throw new Error(`开通脚本不存在: ${script}`)
  const outcome = await run("bash", [script, qq, String(port), String(subnet)], 90000)
  if (outcome.error) {
    throw new Error(`开通失败: ${String(outcome.error.message || outcome.error).slice(0, 300)}`)
  }
  let wsUrl = ""
  try { wsUrl = writeOnebotConfig(qq, subnet) } catch {}
  return {
    ok: true,
    qq,
    port,
    subnet,
    wsUrl,
    output: String(outcome.stdout || "").trim(),
    hint: `已创建停机备号(0内存,反向ws已预配${wsUrl ? ":" + wsUrl : ""})。下一步:点「启动」,卡片出二维码扫码登录即可入列。`
  }
}

// 容器内的扫码二维码(napcat 每次签发会写 /app/napcat/cache/qrcode.png,约2分钟一换)
async function readContainerQrcode(container) {
  if (!CONTAINER_NAME_RE.test(container) || !container.includes("napcat")) return null
  const outcome = await runRaw("docker", ["exec", container, "cat", "/app/napcat/cache/qrcode.png"])
  if (outcome.error || outcome.stdout.length < 16) return null
  if (!(outcome.stdout[0] === 0x89 && outcome.stdout[1] === 0x50 && outcome.stdout[2] === 0x4e)) return null
  return outcome.stdout
}

// ---------- 生图工作台(文生图/图生图) ----------
// 渠道解析与 fallback 语义完全复用 utils/imageGenerationFallback.js,请求构造对齐
// BananaTool(grok-imagine 走 quality 载荷、edits 走 multipart、b64_json 不支持时退回默认格式)。
const DRAW_DIR = process.env.CONSOLE_DRAW_DIR || "/var/lib/bl-console/draw"
const DRAW_HISTORY_KEEP = 100
const DRAW_HISTORY_LIST = 24
const MAX_CONCURRENT_IMAGE_JOBS = 2
const MAX_IMAGE_BODY_BYTES = 60 * 1024 * 1024
const IMAGE_FILE_RE = /^[\w][\w.-]*\.(?:png|jpe?g|webp|gif)$/i
const EXT_BY_MIME = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }
const MIME_BY_EXT = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" }
let activeImageJobs = 0
const imageJobSignals = new Set() // 每个进行中生图任务的外部取消信号

function loadPluginSettings() {
  return configRepository.read().settings
}

function describeImageProvider(config = {}, index = 0) {
  let host = ""
  try { host = new URL(config.apiUrl).host } catch {}
  return {
    label: describeImageGenerationConfig(config, index),
    model: config.model || "",
    host,
    size: config.size || "(渠道默认)",
    priority: config.priority ?? null
  }
}

function imageProviderOverview() {
  const settings = loadPluginSettings()
  return {
    generation: resolveImageGenerationConfigs(settings).map(describeImageProvider),
    edit: resolveImageEditConfigs(settings).map(describeImageProvider)
  }
}

const materializeImageResult = createImageResource()
const imageService = createImageService({
  fetch: (url, init) => fetch(url, init),
  loadReference: async (value, signal) => {
    if (/^data:image\//.test(value)) return value
    const { buffer, mime } = await materializeImageResult(value, signal)
    return `data:${mime};base64,${buffer.toString("base64")}`
  },
  encodeMultipart: async (fields, files) => {
    const form = new FormData()
    for (const [key, value] of Object.entries(fields)) form.append(key, value)
    for (const file of files) form.append("image", new Blob([file.data], { type: file.mimeType }), file.filename)
    return serializeMultipartFormData(form)
  },
  resolveImage: async (image, signal) => (await materializeImageResult(image, signal)).buffer,
  metadata: async bytes => {
    const dimensions = readImageDimensions(Buffer.from(bytes))
    if (!dimensions) throw new Error("上游返回的图片无效")
    return dimensions
  }
})

function saveDrawResult(buffer, mime, provider, seq = 0) {
  fs.mkdirSync(DRAW_DIR, { recursive: true })
  const ext = EXT_BY_MIME[mime] || "png"
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const safeProvider = String(provider || "unknown").replace(/[^\w.-]+/g, "_").slice(0, 40) || "unknown"
  const file = `${stamp}_${safeProvider}${seq > 0 ? `_${seq + 1}` : ""}.${ext}`
  fs.writeFileSync(path.join(DRAW_DIR, file), buffer)
  try {
    const entries = fs.readdirSync(DRAW_DIR)
    const images = entries.filter(name => IMAGE_FILE_RE.test(name)).sort()
    for (const stale of images.slice(0, Math.max(0, images.length - DRAW_HISTORY_KEEP))) {
      fs.unlinkSync(path.join(DRAW_DIR, stale))
      fs.rmSync(path.join(DRAW_DIR, `${stale}.json`), { force: true })
    }
    // 清理没有对应图片的孤儿元数据
    for (const name of entries.filter(n => n.endsWith(".json"))) {
      const base = name.replace(/\.json$/, "")
      if (!images.includes(base)) fs.rmSync(path.join(DRAW_DIR, name), { force: true })
    }
  } catch {}
  return file
}

// 每张成图旁写一份元数据 sidecar(<file>.json),历史详情/一键重生成依赖它
function saveDrawMeta(file, meta) {
  try {
    fs.writeFileSync(path.join(DRAW_DIR, `${file}.json`), JSON.stringify(meta))
  } catch {}
}

function readDrawMeta(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DRAW_DIR, `${file}.json`), "utf8"))
  } catch { return null }
}

function listDrawHistory() {
  try {
    return fs.readdirSync(DRAW_DIR)
      .filter(name => IMAGE_FILE_RE.test(name))
      .sort()
      .reverse()
      .slice(0, DRAW_HISTORY_LIST)
      .map(name => {
        const stat = fs.statSync(path.join(DRAW_DIR, name))
        return { file: name, bytes: stat.size, at: stat.mtimeMs, meta: readDrawMeta(name) }
      })
  } catch { return [] }
}

async function handleImageDraw(payload = {}, mode, owner = "token") {
  const prompt = String(payload.prompt || "").trim()
  if (!prompt) throw new Error("提示词不能为空")
  // 下拉/历史里带的是展示名,形如 krill-image-2(gpt-image-2);匹配渠道用其主体名
  const provider = String(payload.provider || "").trim().replace(/\s*\([^)]*\)\s*$/, "")
  const aspectRatio = String(payload.aspectRatio || "").trim()
  const customSize = normalizeCustomSize(payload.size)
  const quality = normalizeQuality(payload.quality)
  const count = Math.min(4, Math.max(1, Math.floor(Number(payload.n)) || 1))
  const images = (Array.isArray(payload.images) ? payload.images : [payload.images])
    .map(item => String(item || "").trim())
    .filter(Boolean)
  if (mode === "edit" && !images.length) throw new Error("图生图需要至少上传一张参考图片")
  if (images.length > 4) throw new Error("参考图片最多 4 张")

  const settings = loadPluginSettings()
  let configs = mode === "edit" ? resolveImageEditConfigs(settings) : resolveImageGenerationConfigs(settings)
  if (provider) configs = selectImageConfigsByProvider(configs, provider, mode === "edit" ? "图片编辑" : "文生图")
  if (customSize) {
    // 显式尺寸优先于比例,原样透传(渠道不支持时会在尝试明细里暴露错误)
    configs = configs.map(config => isGrokImageModel(config.model)
      ? applyImageAspectRatioToConfigs([config], resolveImageAspectRatioIntent("", customSize), { operation: mode })[0]
      : ({ ...config, size: customSize }))
  } else {
    const intent = resolveImageAspectRatioIntent(prompt, aspectRatio)
    configs = applyImageAspectRatioToConfigs(configs, intent, { operation: mode })
  }
  if (!configs.length) throw new Error("没有可用的图片渠道(检查 config/message.yaml 的 imageGenerationAiConfig / imageEditAiConfig)")

  if (activeImageJobs >= MAX_CONCURRENT_IMAGE_JOBS) throw new Error("已有生图任务在进行中，请稍候再试")
  activeImageJobs++
  const cancelSignal = new AbortController()
  cancelSignal.owner = owner
  imageJobSignals.add(cancelSignal)
  const startedAt = Date.now()
  try {
    const { images: rawImages, format, provider: usedProvider, attempts } =
      await imageService.run(configs, { operation: mode, prompt, images, count, quality, signal: cancelSignal.signal })
    const results = []
    for (let index = 0; index < rawImages.length; index++) {
      if (cancelSignal.signal.aborted) throw new Error("已取消")
      const { buffer, mime } = await materializeImageResult(rawImages[index], cancelSignal.signal)
      if (cancelSignal.signal.aborted) throw new Error("已取消")
      const file = saveDrawResult(buffer, mime, usedProvider, rawImages.length > 1 ? index : 0)
      saveDrawMeta(file, {
        at: new Date().toISOString(),
        mode,
        prompt,
        provider: usedProvider,
        aspectRatio: aspectRatio || "auto",
        size: customSize,
        quality,
        n: count,
        format
      })
      results.push({
        file,
        bytes: buffer.length,
        dataUri: `data:${mime};base64,${buffer.toString("base64")}`
      })
    }
    return {
      ok: true,
      mode,
      provider: usedProvider,
      format,
      tookMs: Date.now() - startedAt,
      attempts,
      aspectRatio: customSize ? `自定义 ${customSize}` : (aspectRatio || "auto"),
      count: results.length,
      images: results,
      // 兼容字段:单图场景下旧调用方仍可直接读
      dataUri: results[0]?.dataUri,
      file: results[0]?.file,
      bytes: results[0]?.bytes
    }
  } catch (error) {
    error.tookMs = Date.now() - startedAt
    throw error
  } finally {
    activeImageJobs--
    imageJobSignals.delete(cancelSignal)
  }
}

function readJsonBody(req, limitBytes = MAX_IMAGE_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let rejected = false
    const fail = error => { if (!rejected) { rejected = true; reject(error) } }
    req.on("data", chunk => {
      if (rejected) return
      size += chunk.length
      if (size > limitBytes) {
        fail(new Error("请求体过大(参考图片请压缩后再上传)"))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => {
      if (rejected) return
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")) }
      catch { fail(Object.assign(new Error("请求体不是有效 JSON"), { status: 400 })) }
    })
    req.on("error", fail)
  })
}

// ---------- AI 模型配置(从锅巴抽出,同一套 definitions 与归一化) ----------
const MESSAGE_BACKUP_PREFIX = "message.yaml.bak-console-"
const MESSAGE_BACKUP_KEEP = 10

function configuredConsoleProviders(settings, configKey, def) {
  const cfg = settings[configKey] || {}
  const normalized = getConfiguredProviders(cfg, def)
  const raw = [cfg.providers, ...(def.legacyProviderFields || []).map(field => cfg[field])]
    .find(list => Array.isArray(list) && list.some(item => normalizeProviderForPanel(item, def))) || []
  return identifiableProviders(configKey, normalized, raw.filter(item => normalizeProviderForPanel(item, def)))
}

// Repository provides cross-process locking and compare-and-swap over the exact read snapshot.
function applyConsoleFlatUpdates(updates = {}, expectedRevision) {
  try { return configRepository.updateFlat(updates, { expectedRevision }) }
  catch (error) {
    if (error instanceof ConfigConflictError) throw Object.assign(new Error("配置已被其他进程修改，请重新加载并核对草稿后保存"), { status: 409 })
    throw error
  }
}

function backupMessageYaml() {
  if (!fs.existsSync(MESSAGE_YAML)) return null
  const dir = path.dirname(MESSAGE_YAML)
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const backup = path.join(dir, `${MESSAGE_BACKUP_PREFIX}${stamp}`)
  fs.copyFileSync(MESSAGE_YAML, backup)
  try {
    const backups = fs.readdirSync(dir).filter(name => name.startsWith(MESSAGE_BACKUP_PREFIX)).sort()
    for (const stale of backups.slice(0, Math.max(0, backups.length - MESSAGE_BACKUP_KEEP))) {
      fs.unlinkSync(path.join(dir, stale))
    }
  } catch {}
  return path.basename(backup)
}

function aiConfigOverview() {
  // 锅巴时代的老配置多为扁平字段(chatApiUrl 等),展示前先做同款迁移合成,
  // 否则这些配置位会显示为空——迁移只影响视图,不写盘
  const settings = withAiProviderPanelDefaults(loadPluginSettings())
  return {
    definitions: AI_PROVIDER_DEFINITIONS.map(def => ({
      configKey: def.configKey,
      title: def.title,
      usageHint: def.usageHint,
      urlPlaceholder: def.urlPlaceholder,
      modelPlaceholder: def.modelPlaceholder,
      kind: classifyConfigKind(def.configKey),
      extraFields: (def.extraFields || []).map(extra => ({
        field: extra.panelField,
        label: extra.label,
        placeholder: extra.placeholder
      }))
    })),
    sections: Object.fromEntries(AI_PROVIDER_DEFINITIONS.map(def => [
      def.configKey,
      configuredConsoleProviders(settings, def.configKey, def).map(maskProvider)
    ])),
    revisions: Object.fromEntries(AI_PROVIDER_DEFINITIONS.map(def => [
      def.configKey, providerRevision(def.configKey, configuredConsoleProviders(settings, def.configKey, def))
    ]))
  }
}

function saveAiProviders(configKey, providers = [], revision) {
  const def = getProviderDefinition(configKey)
  if (!def) throw Object.assign(new Error(`未知的配置位: ${configKey}`), { status: 400 })
  if (!Array.isArray(providers) || !providers.length) {
    throw Object.assign(new Error("渠道列表不能为空(要清空请手工编辑 message.yaml,避免误操作抹掉配置)"), { status: 400 })
  }
  const snapshot = configRepository.read()
  const settings = withAiProviderPanelDefaults(snapshot.settings)
  const current = configuredConsoleProviders(settings, configKey, def)
  if (revision !== undefined && revision !== providerRevision(configKey, current)) {
    throw Object.assign(new Error("渠道配置已被其他页面修改，请重新加载后保存"), { status: 409 })
  }
  const restoredCredentials = restoreProviderCredentials(providers, current)
  const rawSection = snapshot.settings[configKey] || {}
  const rawProviders = [rawSection.providers, ...(def.legacyProviderFields || []).map(field => rawSection[field])]
    .find(list => Array.isArray(list) && list.some(item => normalizeProviderForPanel(item, def))) || []
  const validRaw = rawProviders.filter(item => normalizeProviderForPanel(item, def))
  const currentById = new Map(current.map((item, index) => [item._consoleId, validRaw[index] || {}]))
  // Restore unexposed provider extensions by stable identity; omitted channels remain deleted.
  const restored = restoredCredentials.map(item => ({ ...currentById.get(item._consoleId), ...item }))
  const valid = restored.filter(item => normalizeProviderForPanel(item, def))
  if (!valid.length) throw Object.assign(new Error("渠道列表没有有效配置，未写入"), { status: 400 })
  const updates = normalizeAiProviderUpdates({ [`${configKey}.providers`]: restored })
  // Guoba's pure normalizer intentionally drops UI metadata. Store only the stable, non-secret ID afterward.
  updates[`${configKey}.providers`] = updates[`${configKey}.providers`].map((item, index) => ({ ...item, _consoleId: valid[index]._consoleId }))
  const backup = backupMessageYaml()
  applyConsoleFlatUpdates(updates, snapshot.revision)
  const after = configuredConsoleProviders(withAiProviderPanelDefaults(loadPluginSettings()), configKey, def)
  return { ok: true, backup, providers: after.map(maskProvider), revision: providerRevision(configKey, after),
    applyMode: "hot", applyHint: "渠道配置已持久化；后续模型请求读取更新" }
}

async function probeAiSection(configKey) {
  const def = getProviderDefinition(configKey)
  if (!def) throw Object.assign(new Error(`未知的配置位: ${configKey}`), { status: 400 })
  const settings = withAiProviderPanelDefaults(loadPluginSettings())
  const providers = getConfiguredProviders(settings[configKey] || {}, def)
  if (!providers.length) throw Object.assign(new Error("这个配置位还没有已保存的渠道,先保存再测试"), { status: 400 })
  const results = await probeProviders(providers, classifyConfigKind(configKey))
  return { results }
}

async function probeAiProvider(configKey, provider = {}) {
  const def = getProviderDefinition(configKey)
  if (!def) throw Object.assign(new Error(`未知的配置位: ${configKey}`), { status: 400 })
  const settings = withAiProviderPanelDefaults(loadPluginSettings())
  const current = configuredConsoleProviders(settings, configKey, def)
  const [restored] = restoreProviderCredentials([provider], current, { allowNew: false })
  const result = await probeProvider(restored, classifyConfigKind(configKey))
  return { results: [result] }
}

// ---------- 应用页代理(命令/骰子管理、运行观测、语义记忆) ----------
// 这三个页面挂在 Yunzai 的 express(2536)上,内部用绝对路径互相调用,
// 因此在原路径 /bl-chat/* 透传代理;控制台会话统一鉴权,入口页自动注入
// 页面自身令牌(config/commands-web.json),令牌不暴露给浏览器。
const YUNZAI_HOST = process.env.CONSOLE_YUNZAI_HOST || "127.0.0.1"
const YUNZAI_PORT = Number(process.env.CONSOLE_YUNZAI_PORT || 2536)

function readAppPageTokens() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "config", "commands-web.json"), "utf8"))
    return { token: String(parsed.token || ""), observeToken: String(parsed.observeToken || "") }
  } catch { return { token: "", observeToken: "" } }
}

let identityCache = { bots: [], groups: [] }
let identityCacheAt = 0
let identityInFlight = null
async function collectIdentityDirectory() {
  if (Date.now() - identityCacheAt < 30000) return identityCache
  if (identityInFlight) return identityInFlight
  identityInFlight = (async () => {
    const groups = mergeGroupNames(readCachedGroupNames(PLUGIN_ROOT), identityCache.groups)
    const bots = new Map(identityCache.bots.map(bot => [bot.id, bot.name]))
    try {
      const token = readAppPageTokens().token
      if (token) {
        const response = await fetch(`http://${YUNZAI_HOST}:${YUNZAI_PORT}/bl-chat/commands/api/identities`, {
          headers: { "x-commands-token": token }, signal: AbortSignal.timeout(2500)
        })
        if (response.ok) {
          const payload = await response.json()
          for (const group of Array.isArray(payload.groups) ? payload.groups : []) {
            if (/^\d+$/.test(String(group?.id)) && typeof group?.name === "string" && group.name.trim()) groups.set(String(group.id), group.name.trim())
          }
          for (const bot of Array.isArray(payload.bots) ? payload.bots : []) {
            if (/^\d+$/.test(String(bot?.id)) && typeof bot?.name === "string" && bot.name.trim()) bots.set(String(bot.id), bot.name.trim())
          }
        }
      }
    } catch {}
    identityCache = { bots: [...bots].map(([id, name]) => ({ id, name })), groups: [...groups].map(([id, name]) => ({ id, name })) }
    identityCacheAt = Date.now()
    return identityCache
  })().finally(() => { identityInFlight = null })
  return identityInFlight
}

// ---------- QQ空间说说(Yunzai 侧 /bl-chat/qzone API 的转发) ----------
// 发布要用各 bot 的登录态 Cookie,只有 Yunzai 进程里的 Bot 拿得到,
// 控制台后端带主令牌转发;浏览器只见本机 /api/qzone/*,令牌不出境。
async function proxyQzoneApi(pathname, { method = "GET", body } = {}) {
  const tokens = readAppPageTokens()
  if (!tokens.token) throw new Error("命令页令牌未配置(config/commands-web.json)")
  const response = await fetch(`http://${YUNZAI_HOST}:${YUNZAI_PORT}/bl-chat/qzone${pathname}`, {
    method,
    headers: {
      "x-commands-token": tokens.token,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000)
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload?.error || `Yunzai 返回 HTTP ${response.status}`)
  return payload
}

// 嵌入态注入:深色化(对齐控制台配色) + 隐藏跨页导航(返回锅巴/互跳链接/页内大标题)
// 目标页是浅色独立页(#f3f5f9/#fff/#e5e9f0/#4c6ef5),这里按选择器覆盖到控制台色板
const EMBED_INJECT_CSS = `<style id="bl-console-embed">
body{background:#111418!important;color:#dfe6ee!important}
header,#domains,.meta,table,.card,.import-panel,.save-bar,.lock,#lock,section,pre{background:#1a2027!important;border-color:#2a3440!important}
th{background:#161c23!important;color:#8fa3b8!important;border-color:#242d38!important}
td{border-color:#242d38!important}
input,select,textarea{background:#111418!important;color:#dfe6ee!important;border-color:#2a3440!important}
button{background:#1f3a52!important;border-color:#3a5a78!important;color:#cfe6ff!important}
button.ghost{background:transparent!important;color:#8ec5ff!important}
button.danger{background:transparent!important;color:#ff9d9d!important;border-color:#5a2a2a!important}
a{color:#7ec3f5!important}
header h1{display:none!important}
a[href^="/guoba"],a[href^="/bl-chat/"]{display:none!important}
#domains .item:hover,.card-head:hover,.card.open .card-head{background:#202832!important}
#domains .item.active{background:#1f3a52!important;color:#cfe6ff!important}
.chip{background:#16324a!important;color:#8ec5ff!important}
.cmd-group,.import-panel pre{background:#161c23!important}
.hint,.sub,.empty,#domains .count,.card-head .desc,.grid-row .label,.meta label,.card .label,.muted{color:#8fa3b8!important}
#drop-overlay{background:rgba(90,169,230,.12)!important;border-color:#5aa9e6!important;color:#8ec5ff!important}
.import-panel pre{color:#c6d2df!important}
</style>`

function proxyToYunzai(req, res, targetPath, { injectEmbed = false, pageToken = "" } = {}) {
  const upstreamHeaders = { ...req.headers, host: `${YUNZAI_HOST}:${YUNZAI_PORT}` }
  // Authenticate at the console boundary. Never forward its session or automation credential.
  delete upstreamHeaders.cookie
  delete upstreamHeaders["x-console-token"]
  delete upstreamHeaders.referer
  if (pageToken) upstreamHeaders["x-commands-token"] = pageToken
  // 嵌入态要改写 HTML,要求上游回明文(浏览器默认带 gzip 头会让上游压缩导致无法注入)
  if (injectEmbed) upstreamHeaders["accept-encoding"] = "identity"
  const upstream = http.request({
    host: YUNZAI_HOST,
    port: YUNZAI_PORT,
    method: req.method,
    path: targetPath,
    headers: upstreamHeaders
  }, upstreamRes => {
    const headers = { ...upstreamRes.headers }
    const contentType = String(headers["content-type"] || "")
    const isHtml = injectEmbed && contentType.includes("text/html") && !headers["content-encoding"]
    if (!isHtml) {
      res.writeHead(upstreamRes.statusCode || 502, headers)
      return upstreamRes.pipe(res)
    }
    // HTML 且要求嵌入态:整段缓冲后注入样式再下发
    const chunks = []
    upstreamRes.on("data", chunk => chunks.push(chunk))
    upstreamRes.on("end", () => {
      let html = Buffer.concat(chunks).toString("utf8")
      if (html.includes("</head>")) html = html.replace("</head>", `${EMBED_INJECT_CSS}</head>`)
      else html = EMBED_INJECT_CSS + html
      delete headers["transfer-encoding"]
      headers["content-length"] = String(Buffer.byteLength(html))
      res.writeHead(upstreamRes.statusCode || 502, headers)
      res.end(html)
    })
  })
  upstream.on("error", error => {
    if (!res.headersSent) return sendJson(res, 502, { error: `Yunzai(${YUNZAI_PORT}) 不可达: ${error?.message || error}` })
    res.end()
  })
  req.pipe(upstream)
}

function appPageEntryList() {
  return [
    { key: "commands", label: "命令 / 骰子管理", src: "/bl-chat/commands/" },
    { key: "observe", label: "运行观测", src: "/bl-chat/observe/" },
    { key: "semantic", label: "语义记忆", src: "/bl-chat/semantic-memory/" }
  ]
}

function handleAppPageProxy(req, res, url, session) {
  const tokens = readAppPageTokens()
  const validPageTokens = new Set([tokens.token, tokens.observeToken].filter(Boolean))
  const providedPageToken = String(url.searchParams.get("token") || req.headers["x-commands-token"] || "")
  const consoleAuthorized = Boolean(session) || req.headers["x-console-token"] === TOKEN || providedPageToken === TOKEN
  // 放宽为三选一:控制台会话 / 控制台令牌 / 页面自身令牌(iframe 与页内 API 都要能过)
  if (!consoleAuthorized && !validPageTokens.has(providedPageToken)) {
    return sendJson(res, 401, { error: "unauthorized" })
  }
  const forwarded = new URL(url)
  let pageToken = ""
  if (consoleAuthorized) {
    // Native pages call these APIs directly; authenticate all their requests, not only HTML entries.
    forwarded.searchParams.delete("token")
    pageToken = /^\/bl-chat\/commands(?:\/|$)/.test(url.pathname) ? tokens.token : (tokens.observeToken || tokens.token)
  }
  return proxyToYunzai(req, res, forwarded.pathname + forwarded.search, { injectEmbed: url.searchParams.get("embed") === "1", pageToken })
}


// ---------- 通用配置表单引擎(锅巴 schema 同源渲染) ----------
// schema 是纯声明式数据(字段/组件/帮助文案),控制台按组件词汇表渲染;
// 写入只提交变更字段,与锅巴共用同一份 schema 即同一份真相源。
const CONFIG_SCHEMAS = {
  conversation: { title: "对话与权限", schema: conversationSchema },
  reasoning: { title: "思考程度", schema: reasoningSchema },
  persona: { title: "默认人设与画像", schema: personaSchema },
  pipeline: { title: "消息管道与搬运", schema: messagePipelineSchema },
  riskControl: { title: "风控管理", schema: riskControlSchema }
}

function schemaConfigView(key) {
  const entry = CONFIG_SCHEMAS[key]
  if (!entry) throw new Error(`未注册的配置页: ${key}`)
  return buildSchemaConfigView(key, entry, loadPluginSettings())
}

function saveSchemaConfig(key, payload = {}) {
  const entry = CONFIG_SCHEMAS[key]
  if (!entry) throw new Error(`未注册的配置页: ${key}`)
  const snapshot = configRepository.read()
  const prepared = prepareSchemaUpdates(key, entry, snapshot.settings, payload)
  const backup = prepared.changed ? backupMessageYaml() : null
  if (prepared.changed) applyConsoleFlatUpdates(prepared.updates, snapshot.revision)
  const revision = schemaConfigView(key).revision
  const modes = [...new Set(prepared.apply.map(field => field.applyMode))]
  return { ok: true, changed: prepared.changed, backup, revision, apply: prepared.apply,
    applyMode: modes.length > 1 ? "mixed" : (modes[0] || "none"),
    applyHint: prepared.changed ? "配置已持久化；具体生效时机请查看字段说明。本次保存不重启机器人服务。" : "配置未发生变化" }
}

async function pipelineJobsView(query) {
  pipelineJobFilters(query)
  const redis = new MiniRedis()
  try {
    await redis.connect()
    return await readPipelineJobs(redis, query, loadPluginSettings())
  } catch (cause) {
    if (cause?.status) throw cause
    throw Object.assign(new Error(`持久任务记录暂不可读：${cause.message || cause}`), { status: 503 })
  } finally { redis.close() }
}

// ---------- 人设库(多套人设 + 群/账号/私聊绑定) ----------
const PERSONA_LIBRARY_FILE = path.join(PLUGIN_ROOT, "config", "persona-library.yaml")

function personaLibraryOf() {
  return createPersonaLibrary({
    libraryPath: PERSONA_LIBRARY_FILE,
    getBasePersona: () => {
      try { return loadPluginSettings().persona || {} } catch { return {} }
    }
  })
}

function backupPersonaLibrary() {
  if (!fs.existsSync(PERSONA_LIBRARY_FILE)) return null
  const dir = path.dirname(PERSONA_LIBRARY_FILE)
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const backup = path.join(dir, `persona-library.yaml.bak-console-${stamp}`)
  fs.copyFileSync(PERSONA_LIBRARY_FILE, backup)
  try {
    const backups = fs.readdirSync(dir).filter(n => n.startsWith("persona-library.yaml.bak-console-")).sort()
    for (const stale of backups.slice(0, Math.max(0, backups.length - MESSAGE_BACKUP_KEEP))) {
      fs.unlinkSync(path.join(dir, stale))
    }
  } catch {}
  return path.basename(backup)
}

// 轻量账号列表:只查 napcat 容器的 ACCOUNT env,不走 stats/出口IP
async function listBotAccounts() {
  const list = await run("docker", ["ps", "-a", "--filter", "name=napcat", "--format", "{{.Names}}"])
  if (list.error) return []
  const accounts = []
  for (const name of list.stdout.split("\n").map(s => s.trim()).filter(Boolean)) {
    const info = await run("docker", ["inspect", "-f", "{{.State.Running}}|{{range .Config.Env}}{{.}} {{end}}", name])
    if (info.error) continue
    const [running, env] = info.stdout.trim().split("|")
    const qq = (env || "").split(" ").find(item => item.startsWith("ACCOUNT="))?.slice(8) || ""
    accounts.push({ container: name, qq, running: running === "true" })
  }
  const directory = await collectIdentityDirectory()
  const names = new Map(directory.bots.map(bot => [bot.id, bot.name]))
  return accounts.map(account => ({ ...account, nickname: names.get(account.qq) || "" }))
}

function personaLibraryRevision() {
  const source = fs.existsSync(PERSONA_LIBRARY_FILE) ? fs.readFileSync(PERSONA_LIBRARY_FILE, "utf8") : ""
  return crypto.createHash("sha256").update(source).digest("hex")
}

function personaLibraryView() {
  const lib = personaLibraryOf()
  const state = lib.exportState()
  let basePersona = {}
  try { basePersona = loadPluginSettings().persona || {} } catch {}
  return {
    ...state,
    revision: personaLibraryRevision(),
    basePersona: { name: basePersona.name || "", identity: basePersona.identity || "", tone: basePersona.tone || "" },
    personaFields: ["name", "identity", "tone", "speechStyle", "preferences", "boundaries", "notes", "moods"]
  }
}

function savePersonaLibrary(payload = {}) {
  if (payload.revision !== undefined && payload.revision !== personaLibraryRevision()) {
    throw Object.assign(new Error("人设库已被其他页面修改，请重新加载后保存"), { status: 409 })
  }
  const lib = personaLibraryOf()
  const backup = backupPersonaLibrary()
  const state = lib.replaceAll({
    personas: payload.personas,
    groupBindings: payload.groupBindings,
    accountBindings: payload.accountBindings,
    privateBinding: payload.privateBinding
  })
  return { ok: true, backup, revision: personaLibraryRevision(), personas: state.personas.length, groups: Object.keys(state.groupBindings).length, accounts: Object.keys(state.accountBindings || {}).length, applyMode: "hot", applyHint: "人设库已持久化，后续对话读取更新" }
}

// ---------- HTTP ----------
function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" })
  res.end(JSON.stringify(payload))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`)
  const provided = String(url.searchParams.get("token") || req.headers["x-console-token"] || "")
  const session = sessionUser(req)
  const authed = Boolean(session) || provided === TOKEN

  if (serveFrontend(req, res, url.pathname, FRONTEND_DIST)) return
  if (url.pathname.startsWith("/img/qrcode/")) {
    if (!authed) return sendJson(res, 401, { error: "unauthorized" })
    const container = path.basename(url.pathname.slice("/img/qrcode/".length))
    const png = await readContainerQrcode(container)
    if (!png) return sendJson(res, 404, { error: "qrcode not available" })
    res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" })
    return res.end(png)
  }
  if (url.pathname.startsWith("/img/")) {
    if (!authed) return sendJson(res, 401, { error: "unauthorized" })
    const name = path.basename(url.pathname.slice("/img/".length))
    if (!IMAGE_FILE_RE.test(name)) return sendJson(res, 404, { error: "not found" })
    try {
      const buffer = fs.readFileSync(path.join(DRAW_DIR, name))
      const ext = name.split(".").pop().toLowerCase()
      res.writeHead(200, {
        "content-type": MIME_BY_EXT[ext] || "application/octet-stream",
        "cache-control": "private, max-age=86400"
      })
      return res.end(buffer)
    } catch {
      return sendJson(res, 404, { error: "not found" })
    }
  }

  // ---------- 认证相关 ----------
  if (url.pathname === "/api/auth/state") {
    return sendJson(res, 200, {
      hasUser: loadUserStore().users.length > 0,
      username: session?.username || null,
      via: session ? "session" : (provided === TOKEN ? "token" : null),
      tokenWorks: provided === TOKEN
    })
  }
  if (url.pathname === "/api/auth/setup" && req.method === "POST") {
    try {
      const store = loadUserStore()
      if (store.users.length) return sendJson(res, 409, { error: "管理员已存在,请直接登录" })
      const body = await readJsonBody(req, 64 * 1024)
      const username = String(body.username || "").trim()
      const password = String(body.password || "")
      if (!/^[A-Za-z0-9_.-]{2,32}$/.test(username)) return sendJson(res, 400, { error: "用户名需为 2-32 位字母/数字/_.-" })
      if (password.length < 8) return sendJson(res, 400, { error: "密码至少 8 位" })
      const salt = crypto.randomBytes(16).toString("hex")
      store.users.push({
        username,
        salt,
        hash: await scryptHash(password, salt),
        createdAt: new Date().toISOString()
      })
      saveUserStore(store)
      issueSession(res, username)
      return sendJson(res, 200, { ok: true, username })
    } catch (error) {
      return sendJson(res, 500, { error: String(error?.message || error) })
    }
  }
  if (url.pathname === "/api/auth/login" && req.method === "POST") {
    try {
      const body = await readJsonBody(req, 64 * 1024)
      const username = String(body.username || "").trim()
      const user = await authenticateLogin(username, String(body.password || ""))
      issueSession(res, user.username)
      return sendJson(res, 200, { ok: true, username: user.username })
    } catch (error) {
      return sendJson(res, error?.status || 500, { error: String(error?.message || error) })
    }
  }
  if (url.pathname === "/api/auth/logout" && req.method === "POST") {
    const sid = parseCookies(req.headers.cookie)[SESSION_COOKIE]
    if (sid) sessions.delete(sid)
    res.setHeader("set-cookie", `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`)
    return sendJson(res, 200, { ok: true })
  }
  if (url.pathname === "/api/auth/password" && req.method === "POST") {
    if (!session) return sendJson(res, 401, { error: "请先用账密登录(令牌模式不支持改密)" })
    try {
      const body = await readJsonBody(req, 64 * 1024)
      const newPassword = String(body.newPassword || "")
      if (newPassword.length < 8) return sendJson(res, 400, { error: "新密码至少 8 位" })
      const store = loadUserStore()
      const user = store.users.find(item => item.username === session.username)
      if (!user) return sendJson(res, 404, { error: "用户不存在" })
      if (!(await passwordMatches(user, String(body.oldPassword || "")))) {
        return sendJson(res, 401, { error: "当前密码错误" })
      }
      user.salt = crypto.randomBytes(16).toString("hex")
      user.hash = await scryptHash(newPassword, user.salt)
      user.updatedAt = new Date().toISOString()
      saveUserStore(store)
      return sendJson(res, 200, { ok: true })
    } catch (error) {
      return sendJson(res, 500, { error: String(error?.message || error) })
    }
  }

  // 应用页代理有自己的三选一鉴权(会话/控制台令牌/页面令牌),先于统一登录门
  if (url.pathname.startsWith("/bl-chat/")) {
    return handleAppPageProxy(req, res, url, session)
  }

  // ---------- 以下全部需要登录(会话或令牌) ----------
  if (!authed) return sendJson(res, 401, { error: "unauthorized" })

  try {
    if (url.pathname === "/api/overview") {
      return sendJson(res, 200, await buildOverview())
    }
    // 总览模块化:三个细粒度接口,前端各模块独立加载互不影响
    if (url.pathname === "/api/overview/accounts") {
      return sendJson(res, 200, { accounts: await collectAccounts() })
    }
    if (url.pathname === "/api/overview/stats") {
      const stats = await (async () => {
        try {
          const redis = await new MiniRedis().connect()
          const stats = await collectStats(redis)
          redis.socket?.end()
          return stats
        } catch { return null }
      })()
      return sendJson(res, 200, { stats })
    }
    if (url.pathname === "/api/sentinel") {
      return sendJson(res, 200, collectSentinel())
    }
    if (url.pathname === "/api/apps") {
      return sendJson(res, 200, { apps: appPageEntryList() })
    }
    if (url.pathname === "/api/config/conversation") {
      if (req.method === "GET") return sendJson(res, 200, schemaConfigView("conversation"))
      if (req.method === "PUT") return sendJson(res, 200, saveSchemaConfig("conversation", await readJsonBody(req, 2 * 1024 * 1024)))
      return sendJson(res, 405, { error: "method not allowed" })
    }
    if (url.pathname === "/api/config/reasoning") {
      if (req.method === "GET") return sendJson(res, 200, schemaConfigView("reasoning"))
      if (req.method === "PUT") return sendJson(res, 200, saveSchemaConfig("reasoning", await readJsonBody(req, 2 * 1024 * 1024)))
      return sendJson(res, 405, { error: "method not allowed" })
    }
    if (url.pathname === "/api/config/persona") {
      if (req.method === "GET") return sendJson(res, 200, schemaConfigView("persona"))
      if (req.method === "PUT") {
        const body = await readJsonBody(req, 2 * 1024 * 1024)
        return sendJson(res, 200, saveSchemaConfig("persona", body))
      }
      return sendJson(res, 405, { error: "method not allowed" })
    }
    if (url.pathname === "/api/config/pipeline") {
      if (req.method === "GET") return sendJson(res, 200, schemaConfigView("pipeline"))
      if (req.method === "PUT") {
        const body = await readJsonBody(req, 2 * 1024 * 1024)
        return sendJson(res, 200, saveSchemaConfig("pipeline", body))
      }
      return sendJson(res, 405, { error: "method not allowed" })
    }
    if (url.pathname === "/api/config/riskControl") {
      if (req.method === "GET") return sendJson(res, 200, schemaConfigView("riskControl"))
      if (req.method === "PUT") {
        const body = await readJsonBody(req, 2 * 1024 * 1024)
        return sendJson(res, 200, saveSchemaConfig("riskControl", body))
      }
      return sendJson(res, 405, { error: "method not allowed" })
    }
    if (url.pathname === "/api/pipeline/jobs" && req.method === "GET") {
      return sendJson(res, 200, await pipelineJobsView(Object.fromEntries(url.searchParams)))
    }
    if (url.pathname === "/api/persona/library") {
      if (req.method === "GET") return sendJson(res, 200, personaLibraryView())
      if (req.method === "PUT") {
        const body = await readJsonBody(req, 4 * 1024 * 1024)
        return sendJson(res, 200, savePersonaLibrary(body))
      }
      return sendJson(res, 405, { error: "method not allowed" })
    }
    if (url.pathname === "/api/persona/accounts") {
      return sendJson(res, 200, { accounts: await listBotAccounts() })
    }
    if (url.pathname === "/api/accounts/action" && req.method === "POST") {
      const body = await readJsonBody(req, 64 * 1024)
      return sendJson(res, 200, await handleAccountAction(body))
    }
    if (url.pathname === "/api/accounts/add" && req.method === "POST") {
      const body = await readJsonBody(req, 64 * 1024)
      return sendJson(res, 200, await handleAddAccount(body))
    }
    if (url.pathname === "/api/image/providers") {
      return sendJson(res, 200, imageProviderOverview())
    }
    if (url.pathname === "/api/image/history") {
      return sendJson(res, 200, listDrawHistory())
    }
    if (url.pathname === "/api/image/cancel" && req.method === "POST") {
      let cancelled = 0
      for (const signal of imageJobSignals) { if (signal.owner === (session?.username || "token")) { signal.abort(); cancelled++ } }
      return sendJson(res, 200, { ok: true, cancelled })
    }
    if (url.pathname === "/api/image/generate" || url.pathname === "/api/image/edit") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" })
      const mode = url.pathname.endsWith("/edit") ? "edit" : "generate"
      const body = await readJsonBody(req)
      const result = await handleImageDraw(body, mode, session?.username || "token")
      return sendJson(res, 200, result)
    }
    if (url.pathname === "/api/bot/stats" && req.method === "GET") {
      const qq = String(url.searchParams.get("qq") || "").trim()
      if (!/^\d{4,12}$/.test(qq)) return sendJson(res, 400, { error: "无效的 QQ 号" })
      return sendJson(res, 200, await collectBotStats(qq))
    }
    if (url.pathname === "/api/groups" && req.method === "GET") {
      return sendJson(res, 200, await collectGroups())
    }
    if (url.pathname === "/api/identities" && req.method === "GET") {
      return sendJson(res, 200, await collectIdentityDirectory())
    }
    if (url.pathname === "/api/observe/summary" && req.method === "GET") {
      return sendJson(res, 200, collectObserveSummary())
    }
    if (url.pathname === "/api/qzone/bots" && req.method === "GET") {
      return sendJson(res, 200, await proxyQzoneApi("/api/bots"))
    }
    if (url.pathname === "/api/qzone/publish" && req.method === "POST") {
      const body = await readJsonBody(req, 256 * 1024)
      return sendJson(res, 200, await proxyQzoneApi("/api/publish", { method: "POST", body }))
    }
    if (url.pathname === "/api/ai/config") {
      if (req.method === "GET") return sendJson(res, 200, aiConfigOverview())
      if (req.method === "PUT") {
        const body = await readJsonBody(req, 2 * 1024 * 1024)
        return sendJson(res, 200, saveAiProviders(body.configKey, body.providers, body.revision))
      }
      return sendJson(res, 405, { error: "method not allowed" })
    }
    if (url.pathname === "/api/ai/probe" && req.method === "POST") {
      const body = await readJsonBody(req, 64 * 1024)
      return sendJson(res, 200, await probeAiSection(body.configKey))
    }
    if (url.pathname === "/api/ai/probe-provider" && req.method === "POST") {
      const body = await readJsonBody(req, 64 * 1024)
      return sendJson(res, 200, await probeAiProvider(body.configKey, body.provider))
    }
  } catch (error) {
    return sendJson(res, error?.status || 500, {
      error: String(error?.message || error || "未知错误"),
      attempts: error?.attempts,
      tookMs: error?.tookMs
    })
  }

  sendJson(res, 404, { error: "not found" })
})

server.listen(PORT, HOST, () => {
  console.log(`[bl-console] listening on http://${HOST}:${server.address().port} (token: ${TOKEN.slice(0, 4)}****, users: ${loadUserStore().users.length})`)
  console.log(`[bl-console] draw dir: ${DRAW_DIR}`)
})
