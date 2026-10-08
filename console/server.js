#!/usr/bin/env node
// bl-chat 控制台 v3:只读看板 + 生图工作台 + AI 模型配置 + 账密登录。
// 零外部新增依赖:
//   - 自带迷你 Redis 客户端(RESP,只实现 HGETALL/HGET/EXPIRE 所需的解析)
//   - docker CLI / nsenter 取容器状态、内存与出口 IP
//   - 读哨兵(bot-sentinel)的状态与告警文件
//   - 生图直接复用插件内纯逻辑模块(utils/imageGenerationFallback.js 等,均零 import),
//     渠道与密钥仍以 config/message.yaml 为唯一来源,与 bot 走同一套 fallback 顺序
//   - AI 配置复用锅巴同源模块(utils/guobaAiProviderConfig.js 的 definitions 与归一化),
//     写入用 YAML 定点更新(不改排整份文件),保存前自动备份,保存后 bot 热读即生效
//   - 登录:账密(scrypt 哈希,Cookie 会话)+ 原令牌并存(令牌供 curl/脚本自动化)
// yaml 包复用插件自身 node_modules,不新增安装项。
// 部署:systemd 独立服务(见 console/bl-console.service),与 Yunzai 进程解耦。
import http from "node:http"
import net from "node:net"
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"
import YAML from "yaml"
import { applyImageAspectRatioToConfigs, resolveImageAspectRatioIntent } from "../utils/imageAspectRatio.js"
import {
  describeImageGenerationConfig,
  resolveImageEditConfigs,
  resolveImageGenerationConfigs,
  selectImageConfigsByProvider,
  shouldRetryWithoutUrlResponseFormat
} from "../utils/imageGenerationFallback.js"
import { serializeMultipartFormData } from "../utils/multipartFormData.js"
import {
  AI_PROVIDER_DEFINITIONS,
  getConfiguredProviders,
  getProviderDefinition,
  normalizeAiProviderUpdates,
  withAiProviderPanelDefaults
} from "../utils/guobaAiProviderConfig.js"
import { classifyConfigKind, probeProvider, probeProviders } from "../utils/aiProviderProbe.js"
import { createPersonaLibrary } from "../utils/personaLibrary.js"
import personaSchema from "../models/Guoba/schemas/persona.js"

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const PORT = Number(process.env.CONSOLE_PORT || 8787)
const HOST = process.env.CONSOLE_HOST || "0.0.0.0"
const MESSAGE_YAML = path.join(PLUGIN_ROOT, "config", "message.yaml")

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

// ---------- 迷你 Redis 客户端(仅平铺数组应答:HGETALL 足够) ----------
class MiniRedis {
  constructor({ host = "127.0.0.1", port = 6379 } = {}) {
    this.host = host
    this.port = port
    this.queue = []
    this.buf = Buffer.alloc(0)
    this.socket = null
  }
  connect() {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: this.host, port: this.port })
      socket.setNoDelay(true)
      const onError = error => { this.socket = null; reject(error); this.queue.forEach(item => item.reject(error)); this.queue = [] }
      socket.once("error", onError)
      socket.once("connect", () => {
        this.socket = socket
        socket.on("data", chunk => {
          this.buf = Buffer.concat([this.buf, chunk])
          this.drain()
        })
        socket.once("close", () => { this.socket = null })
        resolve(this)
      })
    })
  }
  // 解析一条完整应答;不够一条返回 null。支持 + -: $ 与平铺 * 数组
  parseOne(buf, offset = 0) {
    if (offset >= buf.length) return null
    const lineEnd = buf.indexOf(0x0a, offset)
    if (lineEnd < 0) return null
    const line = buf.subarray(offset, lineEnd).toString()
    const type = line[0]
    const payload = line.slice(1)
    if (type === "+" || type === "-") return { used: lineEnd + 1 - offset, value: type === "+" ? payload : new Error(payload) }
    if (type === ":") return { used: lineEnd + 1 - offset, value: Number(payload) }
    if (type === "$") {
      const len = Number(payload)
      if (len < 0) return { used: lineEnd + 1 - offset, value: null }
      const total = lineEnd + 1 + len + 2
      if (buf.length - offset < total) return null
      return { used: total, value: buf.subarray(lineEnd + 1, lineEnd + 1 + len).toString() }
    }
    if (type === "*") {
      const count = Number(payload)
      if (count < 0) return { used: lineEnd + 1 - offset, value: null }
      let used = lineEnd + 1 - offset
      const items = []
      for (let i = 0; i < count; i++) {
        const item = this.parseOne(buf, offset + used)
        if (!item) return null
        used += item.used
        items.push(item.value)
      }
      return { used, value: items }
    }
    return { used: lineEnd + 1 - offset, value: null }
  }
  drain() {
    while (this.queue.length) {
      const parsed = this.parseOne(this.buf)
      if (!parsed) return
      this.buf = this.buf.subarray(parsed.used)
      const entry = this.queue.shift()
      if (parsed.value instanceof Error) entry.reject(parsed.value)
      else entry.resolve(parsed.value)
    }
  }
  cmd(...args) {
    if (!this.socket) return Promise.reject(new Error("redis not connected"))
    const payload = Buffer.concat(args.map(arg => {
      const body = Buffer.from(String(arg))
      return Buffer.concat([Buffer.from(`$${body.length}\r\n`), body, Buffer.from("\r\n")])
    }), Buffer.from(`*${args.length}\r\n`))
    // Buffer.concat 的参数顺序:先数组头
    const frame = Buffer.concat([Buffer.from(`*${args.length}\r\n`), payload])
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject })
      this.socket.write(frame)
    })
  }
  async hgetall(key) {
    const flat = await this.cmd("HGETALL", key)
    const hash = {}
    for (let i = 0; i + 1 < flat.length; i += 2) hash[flat[i]] = flat[i + 1]
    return hash
  }
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
  { re: /快速登录|反向WebSocket.*已(启动|连接)|WebSocket Client.*连接(成功|建立)|发送 ->|收到 <-/, state: "已登录" }
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
  const ip = await publicIp()
  for (const item of accounts) {
    if (!item) continue
    item.memory = containerMemoryFromCgroup(item.containerId, item.running)
    item.webui = item.webuiPort ? `http://${ip}:${item.webuiPort}` : null
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
      const outcome = await run("docker", [action, name], 60000)
      results.push({
        container: name,
        ok: !outcome.error,
        error: outcome.error ? String(outcome.error.message || outcome.error).slice(0, 200) : ""
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
  return {
    ok: true,
    qq,
    port,
    subnet,
    output: String(outcome.stdout || "").trim(),
    hint: `已创建停机备号(0内存)。下一步:点「启动」两个容器,卡片出现二维码扫码登录;WebUI http://<服务器IP>:${port}`
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
const IMAGE_GENERATION_TIMEOUT_MS = 120000
const IMAGE_RESULT_FETCH_TIMEOUT_MS = 30000
const MAX_CONCURRENT_IMAGE_JOBS = 2
const MAX_IMAGE_BODY_BYTES = 60 * 1024 * 1024
const IMAGE_FILE_RE = /^[\w][\w.-]*\.(?:png|jpe?g|webp|gif)$/i
const EXT_BY_MIME = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }
const MIME_BY_EXT = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif" }
let activeImageJobs = 0
const imageJobSignals = new Set() // 每个进行中生图任务的外部取消信号

function loadPluginSettings() {
  const parsed = YAML.parse(fs.readFileSync(MESSAGE_YAML, "utf8"))
  if (!parsed?.pluginSettings) throw new Error("message.yaml 缺少 pluginSettings 段")
  return parsed.pluginSettings
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

function buildImageGenerationPayload(config, prompt, responseFormat = "", options = {}) {
  if (/^grok-imagine-image(?:-edit)?$/i.test(String(config.model || "").trim())) {
    const payload = { model: config.model, prompt, quality: options.quality || config.quality || "high" }
    if (config.size) payload.size = config.size
    return payload
  }
  const payload = { model: config.model, prompt, n: options.count || 1 }
  if (config.size) payload.size = config.size
  // quality 仅 gpt-image 家族明确支持,其他渠道发送会被判未知参数
  if (options.quality && /gpt-image/i.test(String(config.model || ""))) payload.quality = options.quality
  if (responseFormat) payload.response_format = responseFormat
  return payload
}

function parseDataImage(dataUri = "") {
  const match = String(dataUri || "").match(/^data:([^;,]+);base64,(.+)$/)
  if (!match) throw new Error("参考图片格式无效(需要 data:image/...;base64)")
  return { mimeType: match[1], buffer: Buffer.from(match[2], "base64") }
}

async function buildImageEditRequest(config, prompt, images, responseFormat = "", options = {}) {
  const form = new FormData()
  form.append("model", config.model || "gpt-image-2")
  form.append("prompt", prompt)
  form.append("n", String(options.count || 1))
  if (config.size) form.append("size", config.size)
  if (options.quality && /gpt-image/i.test(String(config.model || ""))) form.append("quality", options.quality)
  if (responseFormat) form.append("response_format", responseFormat)
  let count = 0
  for (const dataUri of images) {
    if (!dataUri) continue
    const image = parseDataImage(dataUri)
    const ext = EXT_BY_MIME[image.mimeType] || "png"
    form.append("image", new Blob([image.buffer], { type: image.mimeType }), `reference-${count + 1}.${ext}`)
    count++
  }
  if (!count) throw new Error("没有可用的参考图片")
  const multipart = await serializeMultipartFormData(form)
  return {
    url: config.apiUrl,
    init: {
      method: "POST",
      headers: { ...multipart.headers, Authorization: `Bearer ${config.apiKey || "sk-xxxxxx"}` },
      body: multipart.body
    }
  }
}

function buildImageGenerationRequest(config, prompt, responseFormat = "", options = {}) {
  return {
    url: config.apiUrl,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(buildImageGenerationPayload(config, prompt, responseFormat, options))
    }
  }
}

// 计时器持续到响应体读完为止:上游可能先回 header 再无限拖住 body
async function fetchImageApiResponse(url, init, timeoutMs = IMAGE_GENERATION_TIMEOUT_MS, externalSignal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onExternalAbort = () => controller.abort()
  externalSignal?.addEventListener("abort", onExternalAbort, { once: true })
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    const text = await response.text()
    let data
    try { data = JSON.parse(text) } catch { data = { raw: text } }
    return { response, data }
  } catch (error) {
    if (externalSignal?.aborted) throw new Error("已取消")
    if (error?.name === "AbortError") throw new Error(`图片接口超过 ${Math.ceil(timeoutMs / 1000)} 秒没有返回完整响应`)
    throw error
  } finally {
    clearTimeout(timer)
    externalSignal?.removeEventListener("abort", onExternalAbort)
  }
}

function parseImageGenerationPayload(response, data) {
  if (!response.ok) {
    const message = data?.error?.message || data?.detail || data?.raw || response.statusText || "未知错误"
    return { ok: false, errorMessage: `API请求失败: ${response.status} ${String(message).slice(0, 400)}` }
  }
  const items = (Array.isArray(data?.data) ? data.data : []).filter(item => item?.url || item?.b64_json)
  if (items.length) {
    return {
      ok: true,
      images: items.map(item => item.url ? item.url : `base64://${item.b64_json}`),
      format: items[0].url ? "url" : "b64_json"
    }
  }
  const keys = Object.keys(data?.data?.[0] || {}).join(",")
  const revised = data?.data?.[0]?.revised_prompt ? ` revised_prompt=${String(data.data[0].revised_prompt).slice(0, 120)}` : ""
  const upstreamError = data?.error ? ` error=${String(data.error.message || JSON.stringify(data.error)).slice(0, 200)}` : ""
  return { ok: false, errorMessage: `未接收到有效图片，上游返回字段: data0=[${keys || "无"}]${upstreamError}${revised}` }
}

async function runImageCandidate(config, mode, prompt, images, responseFormat, options, externalSignal) {
  const { url, init } = mode === "edit"
    ? await buildImageEditRequest(config, prompt, images, responseFormat, options)
    : buildImageGenerationRequest(config, prompt, responseFormat, options)
  const { response, data } = await fetchImageApiResponse(url, init, IMAGE_GENERATION_TIMEOUT_MS, externalSignal)
  return parseImageGenerationPayload(response, data)
}

// 与 generateImage*WithFallbacks 同语义的顺序尝试,额外记录每个渠道的耗时与失败原因
async function runImageConfigsWithAttempts(configs, runOnce, externalSignal) {
  const attempts = []
  for (let index = 0; index < configs.length; index++) {
    const label = describeImageGenerationConfig(configs[index], index)
    const startedAt = Date.now()
    try {
      let result = await runOnce(configs[index], "b64_json")
      if (!result.ok && shouldRetryWithoutUrlResponseFormat(result.errorMessage)) {
        result = await runOnce(configs[index], "")
      }
      if (result.ok) {
        attempts.push({ provider: label, ok: true, ms: Date.now() - startedAt })
        return { images: result.images, format: result.format, provider: label, attempts }
      }
      throw new Error(result.errorMessage || "未接收到有效图片")
    } catch (error) {
      // 用户取消:立即终止整个循环,不再尝试下一个渠道
      if (externalSignal?.aborted) {
        attempts.push({
          provider: label,
          ok: false,
          ms: Date.now() - startedAt,
          error: "已取消"
        })
        const cancelled = new Error("已取消")
        cancelled.attempts = attempts
        cancelled.cancelled = true
        throw cancelled
      }
      attempts.push({
        provider: label,
        ok: false,
        ms: Date.now() - startedAt,
        error: String(error?.message || error || "未知错误").slice(0, 400)
      })
    }
  }
  const detail = attempts.map(item => `${item.provider}: ${item.error}`).join("；")
  const error = new Error(attempts.length ? `所有候选渠道都失败了：${detail}` : "没有可用的图片渠道")
  error.attempts = attempts
  throw error
}

function sniffImageMime(buffer) {
  if (buffer?.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "image/png"
  if (buffer?.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg"
  if (buffer?.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp"
  if (buffer?.length >= 3 && buffer.toString("ascii", 0, 3) === "GIF") return "image/gif"
  return "image/png"
}

async function fetchImageResultBuffer(url, timeoutMs = IMAGE_RESULT_FETCH_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`成图 URL 拉取失败: ${response.status} ${response.statusText}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    if (!buffer.length) throw new Error("成图 URL 返回空内容")
    const contentType = String(response.headers.get("content-type") || "").split(";")[0]
    return { buffer, contentType }
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`成图 URL 拉取超过 ${Math.ceil(timeoutMs / 1000)} 秒`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

async function materializeImageResult(image) {
  const value = String(image || "")
  if (value.startsWith("base64://")) {
    const buffer = Buffer.from(value.slice("base64://".length), "base64")
    if (!buffer.length) throw new Error("上游返回的图片数据为空")
    return { buffer, mime: sniffImageMime(buffer) }
  }
  if (/^https?:\/\//i.test(value)) {
    const { buffer, contentType } = await fetchImageResultBuffer(value)
    return { buffer, mime: MIME_BY_EXT[contentType] ? contentType : sniffImageMime(buffer) }
  }
  throw new Error(`未知图片结果格式: ${value.slice(0, 60)}`)
}

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

// 自定义尺寸:WxH 像素或 2K/4K/auto 分辨率档位(后者为 seedream 类渠道的语言)
function normalizeCustomSize(value = "") {
  const size = String(value || "").trim().replace(/[×*]/g, "x").replace(/\s+/g, "")
  if (!size) return ""
  if (/^\d{1,5}x\d{1,5}$/i.test(size)) return size.toLowerCase()
  if (/^auto$/i.test(size)) return "auto"
  if (/^[1-9]\d*(?:\.\d+)?k$/i.test(size)) return size.replace(/k$/i, "K")
  throw new Error(`自定义尺寸格式无效: ${value}(可填 1024x1536、2K、auto 等)`)
}

function normalizeQuality(value = "") {
  const quality = String(value || "").trim().toLowerCase()
  return ["low", "medium", "high"].includes(quality) ? quality : ""
}

async function handleImageDraw(payload = {}, mode) {
  const prompt = String(payload.prompt || "").trim()
  if (!prompt) throw new Error("提示词不能为空")
  // 下拉/历史里带的是展示名,形如 krill-image-2(gpt-image-2);匹配渠道用其主体名
  const provider = String(payload.provider || "").trim().replace(/\s*\([^)]*\)\s*$/, "")
  const aspectRatio = String(payload.aspectRatio || "").trim()
  const customSize = normalizeCustomSize(payload.size)
  const quality = normalizeQuality(payload.quality)
  const count = Math.min(4, Math.max(1, Number(payload.n) || 1))
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
    configs = configs.map(config => ({ ...config, size: customSize }))
  } else {
    const intent = resolveImageAspectRatioIntent("", aspectRatio)
    configs = applyImageAspectRatioToConfigs(configs, intent, { operation: mode })
  }
  if (!configs.length) throw new Error("没有可用的图片渠道(检查 config/message.yaml 的 imageGenerationAiConfig / imageEditAiConfig)")

  if (activeImageJobs >= MAX_CONCURRENT_IMAGE_JOBS) throw new Error("已有生图任务在进行中，请稍候再试")
  activeImageJobs++
  const cancelSignal = new AbortController()
  imageJobSignals.add(cancelSignal)
  const startedAt = Date.now()
  try {
    const { images: rawImages, format, provider: usedProvider, attempts } =
      await runImageConfigsWithAttempts(configs, (config, responseFormat) =>
        runImageCandidate(config, mode, prompt, images, responseFormat, { count, quality }, cancelSignal.signal), cancelSignal.signal)
    const results = []
    for (let index = 0; index < rawImages.length; index++) {
      if (cancelSignal.signal.aborted) throw new Error("已取消")
      const { buffer, mime } = await materializeImageResult(rawImages[index])
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
      catch { fail(new Error("请求体不是有效 JSON")) }
    })
    req.on("error", fail)
  })
}

// ---------- AI 模型配置(从锅巴抽出,同一套 definitions 与归一化) ----------
const MESSAGE_BACKUP_PREFIX = "message.yaml.bak-console-"
const MESSAGE_BACKUP_KEEP = 10

function maskApiKey(key = "") {
  const value = String(key || "")
  if (!value) return ""
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : "****"
}

function maskProvider(provider = {}) {
  return { ...provider, apiKey: maskApiKey(provider.apiKey) }
}

// 控制台自己的定点写入器:与 utils/configWriter.applyFlatUpdates 同语义,
// 但用 PLUGIN_ROOT 定位(后者依赖 process.cwd(),在 console 的 cwd 下会指错位置)。
function applyConsoleFlatUpdates(updates = {}) {
  const source = fs.existsSync(MESSAGE_YAML) ? fs.readFileSync(MESSAGE_YAML, "utf8") : "pluginSettings:\n"
  const doc = YAML.parseDocument(source)
  if (doc.errors?.length) throw new Error("message.yaml 当前不是有效 YAML，拒绝写入: " + doc.errors[0].message)
  for (const [flatKey, value] of Object.entries(updates || {})) {
    // undefined/null 不写:避免表单未加载出的字段把已有配置整个抹掉
    if (!flatKey || value === undefined || value === null) continue
    doc.setIn(["pluginSettings", ...String(flatKey).split(".")], value)
  }
  const tmp = `${MESSAGE_YAML}.tmp-console`
  fs.writeFileSync(tmp, doc.toString(), "utf8")
  fs.renameSync(tmp, MESSAGE_YAML)
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
      getConfiguredProviders(settings[def.configKey] || {}, def).map(maskProvider)
    ]))
  }
}

function saveAiProviders(configKey, providers = []) {
  const def = getProviderDefinition(configKey)
  if (!def) throw new Error(`未知的配置位: ${configKey}`)
  if (!Array.isArray(providers) || !providers.length) {
    throw new Error("渠道列表不能为空(要清空请手工编辑 message.yaml,避免误操作抹掉配置)")
  }
  // 表单里的 key 是打码回显:未改动(仍等于打码值)时换回磁盘上的真实 key。
  // 对照的"当前值"同样要经过扁平字段迁移合成,否则老配置首存会把打码串写进盘
  const settings = withAiProviderPanelDefaults(loadPluginSettings())
  const current = getConfiguredProviders(settings[configKey] || {}, def)
  const restored = providers.map((provider, index) => {
    const existing = current[index]
    if (existing && String(provider?.apiKey || "") === maskApiKey(existing.apiKey)) {
      return { ...provider, apiKey: existing.apiKey }
    }
    return provider
  })
  const backup = backupMessageYaml()
  const updates = normalizeAiProviderUpdates({ [`${configKey}.providers`]: restored })
  applyConsoleFlatUpdates(updates)
  const after = getConfiguredProviders(loadPluginSettings()[configKey] || {}, def)
  return { ok: true, backup, providers: after.map(maskProvider) }
}

async function probeAiSection(configKey) {
  const def = getProviderDefinition(configKey)
  if (!def) throw new Error(`未知的配置位: ${configKey}`)
  const settings = loadPluginSettings()
  const providers = getConfiguredProviders(settings[configKey] || {}, def)
  if (!providers.length) throw new Error("这个配置位还没有已保存的渠道,先保存再测试")
  const results = await probeProviders(providers, classifyConfigKind(configKey))
  return { results }
}

async function probeAiProvider(configKey, provider = {}) {
  const def = getProviderDefinition(configKey)
  if (!def) throw new Error(`未知的配置位: ${configKey}`)
  const result = await probeProvider(provider, classifyConfigKind(configKey))
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

function proxyToYunzai(req, res, targetPath, { injectEmbed = false } = {}) {
  const upstreamHeaders = { ...req.headers, host: `${YUNZAI_HOST}:${YUNZAI_PORT}` }
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
  const tokens = readAppPageTokens()
  return [
    { key: "commands", label: "命令 / 骰子管理", src: tokens.token ? `/bl-chat/commands/?token=${encodeURIComponent(tokens.token)}` : "/bl-chat/commands/" },
    { key: "observe", label: "运行观测", src: tokens.observeToken ? `/bl-chat/observe/?token=${encodeURIComponent(tokens.observeToken)}` : "/bl-chat/observe/" },
    { key: "semantic", label: "语义记忆", src: tokens.observeToken ? `/bl-chat/semantic-memory/?token=${encodeURIComponent(tokens.observeToken)}` : "/bl-chat/semantic-memory/" }
  ]
}

function handleAppPageProxy(req, res, url, session) {
  const tokens = readAppPageTokens()
  const validPageTokens = new Set([tokens.token, tokens.observeToken].filter(Boolean))
  const providedPageToken = String(url.searchParams.get("token") || req.headers["x-commands-token"] || "")
  // 放宽为三选一:控制台会话 / 控制台令牌 / 页面自身令牌(iframe 与页内 API 都要能过)
  if (!session && providedPageToken !== TOKEN && !validPageTokens.has(providedPageToken)) {
    return sendJson(res, 401, { error: "unauthorized" })
  }
  let targetPath = url.pathname + url.search
  // 会话模式下入口页没带页面令牌 → 代理注入(commands 用主令牌;observe 页自带无需)
  const entry = url.pathname.match(/^\/bl-chat\/(commands|semantic-memory)\/?$/)
  if (entry && !url.searchParams.get("token")) {
    const pageToken = entry[1] === "commands" ? tokens.token : tokens.observeToken
    if (pageToken) targetPath = `${url.pathname}${url.search ? url.search : "?"}token=${encodeURIComponent(pageToken)}`
  }
  return proxyToYunzai(req, res, targetPath, { injectEmbed: url.searchParams.get("embed") === "1" })
}


// ---------- 通用配置表单引擎(锅巴 schema 同源渲染) ----------
// schema 是纯声明式数据(字段/组件/帮助文案),控制台按组件词汇表渲染;
// 写入只提交变更字段,与锅巴共用同一份 schema 即同一份真相源。
const CONFIG_SCHEMAS = {
  persona: { title: "默认人设与画像", schema: personaSchema }
}

function getIn(obj, dottedPath = "") {
  let cursor = obj
  for (const key of String(dottedPath).split(".")) {
    if (cursor == null || typeof cursor !== "object") return undefined
    cursor = cursor[key]
  }
  return cursor
}

function schemaFieldGroups(schema = []) {
  const groups = []
  let current = { label: "通用", fields: [] }
  for (const item of schema) {
    if (!item || typeof item !== "object") continue
    if (item.component === "SOFT_GROUP_BEGIN" || item.component === "Divider") {
      if (current.fields.length) groups.push(current)
      current = { label: String(item.label || "通用"), fields: [] }
      continue
    }
    if (item.component === "SOFT_GROUP_END") continue
    if (!item.field) continue
    current.fields.push({
      field: item.field,
      label: item.label || item.field,
      component: item.component || "Input",
      props: item.componentProps || {},
      subFields: (item.componentProps?.schemas || []).map(sub => ({
        field: sub.field,
        label: sub.label || sub.field,
        component: sub.component || "Input",
        props: sub.componentProps || {}
      })),
      help: item.bottomHelpMessage || ""
    })
  }
  if (current.fields.length) groups.push(current)
  return groups
}

// 按组件类型归一值:语义比较与写入都走这里,避免"改回原值仍判脏"
function normalizeSchemaValue(component = "", value) {
  if (component === "Switch") return value === true || value === "true"
  if (component === "InputNumber") {
    const num = Number(value)
    return Number.isFinite(num) ? num : null
  }
  if (component === "GTags") {
    if (Array.isArray(value)) return value.map(v => String(v || "").trim()).filter(Boolean)
    return String(value || "").split(/[,\n，]/).map(v => v.trim()).filter(Boolean)
  }
  if (component === "GSubForm") return Array.isArray(value) ? value : []
  return value === undefined || value === null ? "" : String(value)
}

function schemaValuesEqual(component, a, b) {
  return JSON.stringify(normalizeSchemaValue(component, a)) === JSON.stringify(normalizeSchemaValue(component, b))
}

function schemaConfigView(key) {
  const entry = CONFIG_SCHEMAS[key]
  if (!entry) throw new Error(`未注册的配置页: ${key}`)
  const settings = loadPluginSettings()
  const groups = schemaFieldGroups(entry.schema).map(group => ({
    label: group.label,
    fields: group.fields.map(field => ({
      ...field,
      value: normalizeSchemaValue(field.component, getIn(settings, field.field))
    }))
  }))
  return { key, title: entry.title, groups }
}

function saveSchemaConfig(key, submitted = {}) {
  const entry = CONFIG_SCHEMAS[key]
  if (!entry) throw new Error(`未注册的配置页: ${key}`)
  const settings = loadPluginSettings()
  const updates = {}
  let changed = 0
  for (const group of schemaFieldGroups(entry.schema)) {
    for (const field of group.fields) {
      if (!(field.field in submitted)) continue
      const next = normalizeSchemaValue(field.component, submitted[field.field])
      if (schemaValuesEqual(field.component, getIn(settings, field.field), next)) continue
      updates[field.field] = next
      changed++
    }
  }
  if (!changed) return { ok: true, changed: 0, backup: null }
  const backup = backupMessageYaml()
  applyConsoleFlatUpdates(updates)
  return { ok: true, changed, backup }
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
  return accounts
}

function personaLibraryView() {
  const lib = personaLibraryOf()
  const state = lib.exportState()
  let basePersona = {}
  try { basePersona = loadPluginSettings().persona || {} } catch {}
  return {
    ...state,
    basePersona: { name: basePersona.name || "", identity: basePersona.identity || "", tone: basePersona.tone || "" },
    personaFields: ["name", "identity", "tone", "speechStyle", "preferences", "boundaries", "notes", "moods"]
  }
}

function savePersonaLibrary(payload = {}) {
  const lib = personaLibraryOf()
  const backup = backupPersonaLibrary()
  const state = lib.replaceAll({
    personas: payload.personas,
    groupBindings: payload.groupBindings,
    accountBindings: payload.accountBindings,
    privateBinding: payload.privateBinding
  })
  return { ok: true, backup, personas: state.personas.length, groups: Object.keys(state.groupBindings).length, accounts: Object.keys(state.accountBindings || {}).length }
}

const HTML = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>bl-chat 控制台</title>
<style>
  :root { color-scheme: dark }
  body { font-family: -apple-system, "PingFang SC", sans-serif; background:#111418; color:#dfe6ee; margin:0; padding:24px; }
  h1 { font-size:18px } h2 { font-size:14px; color:#8fa3b8; margin:24px 0 8px }
  .card { background:#1a2027; border:1px solid #2a3440; border-radius:10px; padding:14px 16px; margin-bottom:12px }
  .row { display:flex; flex-wrap:wrap; gap:12px }
  .badge { display:inline-block; padding:2px 8px; border-radius:6px; font-size:12px; margin-right:6px }
  .ok { background:#12351f; color:#7ee2a8 } .bad { background:#3a1c1c; color:#ff9d9d } .warn{ background:#3a311c; color:#ffd97e }
  table { width:100%; border-collapse:collapse; font-size:13px }
  td,th { text-align:left; padding:5px 8px; border-bottom:1px solid #242d38 }
  .muted { color:#7b8a99; font-size:12px }
  .bar { height:6px; background:#2a3440; border-radius:3px; overflow:hidden }
  .bar > i { display:block; height:100%; background:#5aa9e6 }
  nav { display:flex; gap:8px; margin:0 0 18px; align-items:center; flex-wrap:wrap }
  nav a { color:#8fa3b8; text-decoration:none; padding:6px 14px; border-radius:8px; border:1px solid #2a3440; font-size:13px }
  nav a.on { background:#1f3a52; color:#cfe6ff; border-color:#3a5a78 }
  nav .who { margin-left:auto; font-size:12px; color:#7b8a99; display:flex; gap:10px; align-items:center }
  nav .who a { cursor:pointer; border:0; padding:2px 6px }
  .seg { display:inline-flex; border:1px solid #2a3440; border-radius:8px; overflow:hidden }
  .seg button { background:transparent; color:#8fa3b8; border:0; padding:6px 16px; cursor:pointer; font-size:13px }
  .seg button.on { background:#1f3a52; color:#cfe6ff }
  textarea, select, input[type=text], input[type=password] { background:#111418; color:#dfe6ee; border:1px solid #2a3440; border-radius:8px; padding:8px 10px; font-size:13px; font-family:inherit }
  textarea { width:100%; min-height:88px; resize:vertical }
  label.fl { display:block; font-size:12px; color:#8fa3b8; margin:0 0 4px }
  .btn { background:#1f3a52; color:#cfe6ff; border:1px solid #3a5a78; border-radius:8px; padding:8px 22px; font-size:14px; cursor:pointer }
  .btn:disabled { opacity:.45; cursor:not-allowed }
  .btn.small { padding:4px 12px; font-size:12px; border-radius:6px }
  .btn.ghost { background:transparent; color:#8fa3b8; border-color:#2a3440 }
  .thumbs { display:flex; flex-wrap:wrap; gap:8px; margin-top:8px }
  .thumb { position:relative; width:86px; height:86px; border:1px solid #2a3440; border-radius:8px; overflow:hidden }
  .thumb img { width:100%; height:100%; object-fit:cover; display:block }
  .thumb b { position:absolute; top:2px; right:2px; background:#3a1c1c; color:#ff9d9d; border-radius:6px; font-size:11px; padding:1px 6px; cursor:pointer }
  #drawResult img { max-width:100%; border-radius:8px; display:block }
  .attempts td { font-size:12px }
  .authbox { max-width:360px; margin:80px auto }
  .authbox input { width:100%; box-sizing:border-box; margin-bottom:10px }
  .fieldline { display:flex; gap:8px; margin-bottom:8px; flex-wrap:wrap }
  .fieldline > div { flex:1; min-width:130px }
  .fieldline input, .fieldline select { width:100%; box-sizing:border-box }
  .pcard { border:1px solid #2a3440; border-radius:10px; padding:10px 12px; margin-bottom:10px; background:#161c23 }
  .pcard .ops { display:flex; gap:6px; margin-top:8px; flex-wrap:wrap }
  .tabs { display:flex; flex-direction:column; gap:4px; min-width:190px }
  .tabs a { color:#8fa3b8; text-decoration:none; padding:7px 10px; border-radius:8px; font-size:13px; border:1px solid transparent; cursor:pointer }
  .tabs a.on { background:#1f3a52; color:#cfe6ff; border-color:#3a5a78 }
  .probe-line { font-size:12px; margin-top:4px }
  #toast { position:fixed; bottom:18px; right:18px; background:#1f3a52; border:1px solid #3a5a78; color:#cfe6ff; padding:10px 16px; border-radius:10px; font-size:13px; display:none; max-width:420px; z-index:9 }
  #lightbox { position:fixed; inset:0; background:rgba(0,0,0,.84); display:none; z-index:99; align-items:center; justify-content:center; flex-direction:column }
  #lightbox img { max-width:92vw; max-height:76vh; border-radius:8px }
  #lightbox .lb-cap { color:#cfe6ff; font-size:13px; margin-top:10px; max-width:80vw; text-align:center; line-height:1.6 }
  #lightbox .lb-ops { display:flex; gap:10px; margin-top:10px }
  #lightbox .lb-nav { position:fixed; top:50%; transform:translateY(-50%); font-size:30px; color:#cfe6ff; cursor:pointer; padding:22px 14px; user-select:none }
  .card.dropping { border-color:#5aa9e6 !important }
</style></head><body>
<h1>bl-chat 控制台 <span class="muted" id="at"></span></h1>
<nav id="nav" style="display:none">
  <a href="#/" id="nav-home">总览</a>
  <a href="#/draw" id="nav-draw">生图工作台</a>
  <a href="#/ai" id="nav-ai">AI 配置</a>
  <a href="#/persona" id="nav-persona">人设</a>
  <a href="#/commands" id="nav-commands">命令/骰子</a>
  <a href="#/observe" id="nav-observe">运行观测</a>
  <a href="#/semantic" id="nav-semantic">语义记忆</a>
  <span class="who"><span id="whoami"></span><a onclick="showChangePassword()">改密</a><a onclick="logout()">退出</a></span>
</nav>
<div id="app"></div>
<div id="err" class="muted"></div>
<div id="toast"></div>
<div id="lightbox" onclick="if(event.target===this)closeLightbox()"></div>
<script>
const KEY='bl-console-token'
let token=localStorage.getItem(KEY)||new URLSearchParams(location.search).get('token')||''
if(token)localStorage.setItem(KEY,token)
let me=null
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
function toast(msg,ms){const t=document.getElementById('toast');t.textContent=msg;t.style.display='block';clearTimeout(t._h);t._h=setTimeout(()=>{t.style.display='none'},ms||3500)}
function page(){
  const h=location.hash
  if(h==='#/draw')return 'draw'
  if(h==='#/ai')return 'ai'
  if(h==='#/commands')return 'commands'
  if(h==='#/observe')return 'observe'
  if(h==='#/semantic')return 'semantic'
  if(h==='#/persona')return 'persona'
  return 'home'
}
const APP_PAGES={commands:{label:'命令 / 骰子管理'},observe:{label:'运行观测'},semantic:{label:'语义记忆'}}
let appEntriesCache=null
async function renderAppPage(key){
  const meta=APP_PAGES[key]
  if(!meta){load();return}
  document.getElementById('app').innerHTML='<div class="card"><span class="muted">加载中…</span></div>'
  let src='/bl-chat/'+({commands:'commands/',observe:'observe/',semantic:'semantic-memory/'}[key]||'')
  try{
    if(!appEntriesCache)appEntriesCache=await api('/api/apps')
    const found=(appEntriesCache.apps||[]).find(a=>a.key===key)
    if(found&&found.src)src=found.src
  }catch(e){}
  document.getElementById('app').innerHTML='<div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">'
    +'<b>'+esc(meta.label)+'</b><span class="muted">由 Yunzai 提供 · 控制台统一鉴权代理</span>'
    +'<a class="btn small ghost" href="'+esc(src)+'" target="_blank" rel="noopener">新窗口打开</a></div>'
    +'<iframe src="'+esc(src + (src.includes('?') ? '&' : '?') + 'embed=1')+'" style="width:100%;height:calc(100vh - 210px);min-height:480px;border:1px solid #2a3440;border-radius:10px;background:#1a2027"></iframe>'
}

async function api(path,opt){
  const headers={'content-type':'application/json'}
  if(token)headers['x-console-token']=token
  const r=await fetch(path,Object.assign({headers:headers},opt||{}))
  if(r.status===401){renderLogin();throw new Error('未登录或登录已过期')}
  const d=await r.json().catch(()=>({}))
  if(!r.ok){const err=new Error(d.error||('HTTP '+r.status));throw err}
  return d
}
async function boot(){
  try{
    const r=await fetch('/api/auth/state',{headers:token?{'x-console-token':token}:{}})
    const st=await r.json().catch(()=>({}))
    if(!st.hasUser&&!st.tokenWorks){renderSetup();return}
    if(!st.username&&!st.tokenWorks){renderLogin();return}
    me=st
    document.getElementById('nav').style.display='flex'
    document.getElementById('whoami').textContent=st.username?('👤 '+st.username):'令牌模式'
    route()
  }catch(e){document.getElementById('err').textContent='初始化失败: '+e.message}
}
function renderSetup(){
  document.getElementById('app').innerHTML='<div class="card authbox"><h2 style="margin:0 0 10px">首次使用 · 设置管理员账密</h2>'
    +'<label class="fl">用户名</label><input id="su-name" type="text" autocomplete="username">'
    +'<label class="fl">密码(至少 8 位)</label><input id="su-pass" type="password" autocomplete="new-password">'
    +'<label class="fl">确认密码</label><input id="su-pass2" type="password" autocomplete="new-password">'
    +'<button class="btn" onclick="doSetup()">创建并进入</button></div>'
}
async function doSetup(){
  const u=document.getElementById('su-name').value.trim()
  const p=document.getElementById('su-pass').value
  if(!u||p.length<8){toast('用户名必填,密码至少 8 位');return}
  if(p!==document.getElementById('su-pass2').value){toast('两次密码不一致');return}
  try{
    await api('/api/auth/setup',{method:'POST',body:JSON.stringify({username:u,password:p})})
    toast('创建成功');boot()
  }catch(e){toast(e.message)}
}
function renderLogin(){
  document.getElementById('nav').style.display='none'
  document.getElementById('app').innerHTML='<div class="card authbox"><h2 style="margin:0 0 10px">登录控制台</h2>'
    +'<label class="fl">用户名</label><input id="li-name" type="text" autocomplete="username">'
    +'<label class="fl">密码</label><input id="li-pass" type="password" autocomplete="current-password" onkeydown="if(event.key===\\'Enter\\')doLogin()">'
    +'<button class="btn" onclick="doLogin()">登录</button>'
    +'<div class="muted" style="margin-top:14px">— 或者 —</div>'
    +'<label class="fl" style="margin-top:10px">访问令牌(脚本/自动化用)</label>'
    +'<input id="li-token" type="password" placeholder="console.json 里的 token">'
    +'<button class="btn ghost small" onclick="doTokenLogin()">用令牌进入</button></div>'
}
async function doLogin(){
  try{
    await api('/api/auth/login',{method:'POST',body:JSON.stringify({username:document.getElementById('li-name').value.trim(),password:document.getElementById('li-pass').value})})
    boot()
  }catch(e){toast(e.message)}
}
function doTokenLogin(){
  const t=document.getElementById('li-token').value.trim()
  if(!t){toast('请填写令牌');return}
  token=t;localStorage.setItem(KEY,t);boot()
}
async function logout(){
  try{await api('/api/auth/logout',{method:'POST',body:'{}'})}catch(e){}
  me=null;token='';localStorage.removeItem(KEY)
  location.hash='#/';renderLogin()
}
function showChangePassword(){
  const box=document.getElementById('chgbox')
  if(box){box.remove();return}
  const div=document.createElement('div')
  div.id='chgbox';div.className='card';div.style.maxWidth='360px'
  div.innerHTML='<h2 style="margin:0 0 10px">修改密码</h2>'
    +'<label class="fl">当前密码</label><input id="cp-old" type="password">'
    +'<label class="fl">新密码(至少 8 位)</label><input id="cp-new" type="password">'
    +'<button class="btn small" onclick="doChangePassword()">保存</button> <button class="btn small ghost" onclick="document.getElementById(\\'chgbox\\').remove()">取消</button>'
  document.getElementById('app').prepend(div)
}
async function doChangePassword(){
  try{
    await api('/api/auth/password',{method:'POST',body:JSON.stringify({oldPassword:document.getElementById('cp-old').value,newPassword:document.getElementById('cp-new').value})})
    toast('密码已修改');document.getElementById('chgbox').remove()
  }catch(e){toast(e.message)}
}
// 语义化相等:只比可编辑字段并归一化(数字/空串/缺省键),
// 避免"改回去仍报未保存"(toggle 开关往返会新增 autoResolve 键、空字段输入再清空会残留空串)
function aiProvidersEqual(listA, listB, def) {
  const norm = p => {
    const o = {
      name: String((p || {}).name || "").trim(),
      apiUrl: String((p || {}).apiUrl || "").trim(),
      model: String((p || {}).model || "").trim(),
      apiKey: String((p || {}).apiKey || "").trim(),
      priority: Number((p || {}).priority) > 0 ? Number((p || {}).priority) : 1
    }
    o.autoResolve = (p || {}).autoResolve === false ? false : true
    for (const extra of (def && def.extraFields) || []) {
      // 前端 definitions 里附加字段的键名是 field(后端 schema 里叫 panelField),两者都要认
      const key = extra.panelField || extra.field
      const v = String((p || {})[key] == null ? "" : (p || {})[key]).trim()
      if (v) o[key] = v
    }
    return o
  }
  return JSON.stringify((listA || []).map(norm)) === JSON.stringify((listB || []).map(norm))
}
function aiDirty(){
  try{
    if(!aiData||!aiActive)return false
    const def=(aiData.definitions||[]).find(d=>d.configKey===aiActive)
    return !aiProvidersEqual(aiModel, aiData.sections[aiActive], def)
  }catch(e){ return false }
}
let aiRestore=false
let personaRestore=false
let lastPage='home'
function route(){
  // 离开 AI 配置且本组有未保存修改时拦截(防误触导航手势/侧键丢编辑)
  if(page()!=='ai'&&aiDirty()){
    if(confirm('AI 配置有未保存的修改,确定离开?\\n(留在本页请点"取消")')){ aiData=null }
    else{ aiRestore=true; history.back(); return }
  }
  if(lastPage==='persona'&&page()!=='persona'&&(plDirty()||cfgDirty)){
    if(confirm('人设页有未保存的修改,确定离开?\\n(留在本页请点"取消")')){ plData=null; cfgData=null; cfgDirty=false }
    else{ personaRestore=true; history.back(); return }
  }
  document.getElementById('nav-home').className=page()==='home'?'on':''
  document.getElementById('nav-draw').className=page()==='draw'?'on':''
  document.getElementById('nav-ai').className=page()==='ai'?'on':''
  document.getElementById('nav-commands').className=page()==='commands'?'on':''
  document.getElementById('nav-observe').className=page()==='observe'?'on':''
  document.getElementById('nav-semantic').className=page()==='semantic'?'on':''
  document.getElementById('nav-persona').className=page()==='persona'?'on':''
  if(page()==='draw'){document.getElementById('at').textContent='';renderDrawPage()}
  else if(page()==='ai'){
    document.getElementById('at').textContent=''
    if(aiRestore){ aiRestore=false } // 拦截后返回:DOM 原样,保住未保存的编辑
    else renderAiPage()
  }
  else if(page()==='commands'||page()==='observe'||page()==='semantic'){document.getElementById('at').textContent='';renderAppPage(page())}
  else if(page()==='persona'){
    document.getElementById('at').textContent=''
    if(personaRestore){ personaRestore=false } else renderPersonaPage()
  }
  else load()
  lastPage=page()
}
window.addEventListener('hashchange',route)

let loadSeq=0
async function load(){
  const seq=++loadSeq
  // 骨架先行:采集要 1-3 秒(docker stats),先让页面立刻切过来
  if(page()==='home'){
    document.getElementById('err').textContent=''
    document.getElementById('app').innerHTML='<h2>账号</h2><div class="card muted">采集中(docker stats 较慢,约 1-3 秒)…</div><h2>统计</h2><div class="card muted">加载中…</div>'
  }
  try{
    const d=await api('/api/overview')
    // 过期响应丢弃:总览采集慢(docker stats 数秒),切页后回来的旧数据不得覆盖当前页面
    if(seq!==loadSeq||page()!=='home')return
    window.__accounts=d.accounts||[]
    document.getElementById('err').textContent=''
    document.getElementById('at').textContent=new Date(d.at).toLocaleString()
    const batchBar='<div class="card" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><b style="font-size:13px">批量操作</b>'
      +'<button class="btn small" onclick="batchAction(\\'restart\\',\\'all\\')">全部重启</button>'
      +'<button class="btn small ghost" onclick="batchAction(\\'restart\\',\\'abnormal\\')">重启掉线/待扫码</button>'
      +'<button class="btn small ghost" onclick="showAddAccount()">＋ 添加账号</button>'
      +'<span class="muted" id="batchState"></span></div>'
    +'<div class="card" id="addAccountBox" style="display:none"><b>添加账号</b> <span class="muted">创建停机备号(独立网络+独立出口 sidecar,0 内存)</span>'
      +'<div class="fieldline" style="margin-top:8px">'
      +'<div style="flex:1;min-width:140px"><label class="fl">QQ 号 *</label><input type="text" id="aa-qq" placeholder="新账号 QQ"></div>'
      +'<div style="flex:1;min-width:120px"><label class="fl">WebUI 端口(留空自动)</label><input type="text" id="aa-port" placeholder="自动分配"></div>'
      +'<div style="flex:1;min-width:120px"><label class="fl">子网序号(留空自动)</label><input type="text" id="aa-subnet" placeholder="自动分配"></div>'
      +'<div style="flex:0 0 auto;align-self:end"><button class="btn small" onclick="doAddAccount()">创建</button></div>'
      +'</div>'
      +'<div class="muted">创建后到账号卡片点「启动」→ 出现二维码扫码登录;WebUI 端口即扫码备用入口。</div></div>'
    const acc=(d.accounts||[]).map(a=>{
      const cls=a.running?(a.status==='running'?'ok':'warn'):'bad'
      const label=a.running?(a.status==='running'?'在线':'已停止'):(a.status==='created'?'冷备':'异常')
      const ops='<div style="margin-top:8px;display:flex;gap:6px">'
        +(a.running
          ?'<button class="btn small" onclick="accountAction(\\''+esc(a.container)+'\\',\\'restart\\')">重启</button>'
            +'<button class="btn small ghost" onclick="accountAction(\\''+esc(a.container)+'\\',\\'stop\\')">停止</button>'
          :'<button class="btn small" onclick="accountAction(\\''+esc(a.container)+'\\',\\'start\\')">启动</button>')
        +'</div>'
      const qrUrl='/img/qrcode/'+encodeURIComponent(a.container)+(token?('?token='+encodeURIComponent(token)):'')
      const qr=a.qrAvailable
        ?'<div style="margin-top:8px"><a href="'+qrUrl+'" target="_blank"><img src="'+qrUrl+'" style="width:150px;border-radius:8px;display:block"></a><div class="muted">扫码重新登录(点图放大;二维码约2分钟一换,刷新页面取最新)</div></div>'
        :''
      return '<div class="card"><b>'+esc(a.account||a.container)+'</b> <span class="badge '+cls+'">'+label+'</span>'+loginBadge(a)
        +'<table><tr><td>容器</td><td>'+esc(a.container)+'</td><td>内存</td><td>'+esc(a.memory||'-')+'</td></tr>'
        +'<tr><td>出口IP</td><td>'+esc(a.exitIp||'未知')+'</td><td>登录入口</td><td>'+(a.webui?'<a href='+a.webui+' target=_blank>'+esc(a.webui)+'</a>':'-')+'</td></tr></table>'
        +ops+qr+'</div>'
    }).join('')||'<div class="card muted">没有发现 napcat 容器</div>'
    let statsHtml='<div class="muted">统计不可用(Redis 未连接?)</div>'
    if(d.stats){
      const max=Math.max(...d.stats.week.map(x=>x.recv+x.send),1)
      statsHtml='<div class="row">'
        +card('7日收信',d.stats.total.recv)+card('7日发送',d.stats.total.send)+card('7日失败',d.stats.total.fail)+'</div>'
        +'<div class="card"><table><tr><th>日期</th><th>收</th><th>发</th><th>败</th><th></th></tr>'
        +d.stats.week.map(x=>'<tr><td>'+x.day+'</td><td>'+x.recv+'</td><td>'+x.send+'</td><td>'+(x.fail||0)+'</td><td style="width:40%"><div class=bar><i style="width:'+Math.round((x.recv+x.send)/max*100)+'%"></i></div></td></tr>').join('')
        +'</table></div>'
      const groups=Object.entries(d.stats.todayGroups||{}).sort((a,b)=>(b[1].recv+b[1].send)-(a[1].recv+a[1].send)).slice(0,10)
      if(groups.length)statsHtml+='<div class="card"><h2 style="margin:0 0 8px">今日按群</h2><table><tr><th>群</th><th>收</th><th>发</th></tr>'
        +groups.map(([g,v])=>'<tr><td>'+g+'</td><td>'+v.recv+'</td><td>'+v.send+'</td></tr>').join('')+'</table></div>'
    }
    const sen='<div class="card"><h2 style="margin:0 0 8px">哨兵</h2><div class="muted">'+esc(d.sentinel.status||'').replace(/\\n/g,'<br>')+'</div>'
      +(d.sentinel.alerts&&d.sentinel.alerts.length?'<h2 style="margin:12px 0 8px">最近告警</h2>'+d.sentinel.alerts.map(a=>'<div class=muted>'+esc(a)+'</div>').join(''):'')+'</div>'
    document.getElementById('app').innerHTML='<h2>账号</h2>'+batchBar+'<div class=row>'+acc+'</div><h2>统计</h2>'+statsHtml+sen
  }catch(e){document.getElementById('err').textContent='加载失败: '+e.message}
}
function card(t,v){return '<div class=card style=flex:1;min-width:120px><div class=muted>'+t+'</div><div style="font-size:22px">'+(v||0)+'</div></div>'}
function loginBadge(a){
  const s=a.loginState||'未知'
  if(s==='已登录')return ' <span class="badge ok">已登录</span>'
  if(s==='待扫码')return ' <span class="badge warn">掉线·待扫码</span>'
  if(s==='掉线')return ' <span class="badge bad">掉线</span>'
  return ' <span class="badge warn">'+esc(s)+'</span>'
}
async function accountAction(container,action){
  if(!confirm('确认对容器 '+container+' 执行 '+action+' ?'))return
  try{
    const d=await api('/api/accounts/action',{method:'POST',body:JSON.stringify({containers:[container],action})})
    toast(d.results.map(r=>r.container+(r.ok?' ✔':' ✘ '+(r.error||''))).join('; '))
    load()
  }catch(e){toast(e.message,6000)}
}
function showAddAccount(){
  const box=document.getElementById('addAccountBox')
  if(!box)return
  box.style.display=box.style.display==='none'?'block':'none'
}
async function doAddAccount(){
  const qq=document.getElementById('aa-qq').value.trim()
  if(!qq){toast('请填 QQ 号');return}
  try{
    const d=await api('/api/accounts/add',{method:'POST',body:JSON.stringify({
      qq,
      port:document.getElementById('aa-port').value.trim(),
      subnet:document.getElementById('aa-subnet').value.trim()
    })})
    toast('账号 '+d.qq+' 已创建(端口 '+d.port+' · 子网 '+d.subnet+') · 到卡片点「启动」后扫码',8000)
    document.getElementById('addAccountBox').style.display='none'
    load()
  }catch(e){toast(e.message,8000)}
}
async function batchAction(action,scope){
  const list=window.__accounts||[]
  const names=scope==='all'?list.map(a=>a.container):list.filter(a=>!a.running||a.loginState==='掉线'||a.loginState==='待扫码').map(a=>a.container)
  if(!names.length){toast('没有符合条件的容器');return}
  if(!confirm('确认对 '+names.length+' 个容器执行 '+action+' ?\\n'+names.join(', ')))return
  const state=document.getElementById('batchState')
  if(state)state.textContent='执行中…'
  try{
    const d=await api('/api/accounts/action',{method:'POST',body:JSON.stringify({containers:names,action})})
    if(state)state.textContent=''
    toast(d.results.map(r=>r.container+(r.ok?' ✔':' ✘')).join('; '),6000)
    load()
  }catch(e){if(state)state.textContent='';toast(e.message,6000)}
}

// ===== 生图工作台 =====
let drawMode='generate'
let providersCache=null
let uploadImages=[]
let drawTimer=null
let drawAbort=null
function imgSrc(name){return '/img/'+encodeURIComponent(name)+(token?('?token='+encodeURIComponent(token)):'')}
async function ensureProviders(force){
  if(providersCache&&!force)return providersCache
  providersCache=await api('/api/image/providers')
  return providersCache
}
function providerOptions(list){
  return ['<option value="">自动（按优先级 fallback）</option>']
    .concat((list||[]).map(p=>'<option value="'+esc(p.label)+'">'+esc(p.label)+(p.size?' · '+esc(p.size):'')+'</option>'))
    .join('')
}
async function renderDrawPage(){
  document.getElementById('app').innerHTML=
   '<div class="card" id="drawFormCard">'
  +'<div class="seg"><button id="mode-generate" onclick="setDrawMode(\\'generate\\')">文生图</button>'
  +'<button id="mode-edit" onclick="setDrawMode(\\'edit\\')">图生图</button></div>'
  +'<div class="row" style="margin-top:12px">'
  +'<div style="flex:1;min-width:200px"><label class="fl">渠道</label><select id="provider" style="width:100%"></select></div>'
  +'<div style="flex:1;min-width:160px"><label class="fl">画面比例</label><select id="ratio" style="width:100%">'
  +'<option value="">自动</option><option>1:1</option><option>3:4</option><option>4:3</option><option>9:16</option><option>16:9</option></select></div>'
  +'</div>'
  +'<div class="row" style="margin-top:12px">'
  +'<div style="flex:2;min-width:200px"><label class="fl">自定义尺寸 / 分辨率（留空按比例；可填 1024x1536、2K、4K、auto，填了则优先生效）</label>'
  +'<input type="text" id="customSize" style="width:100%" placeholder="例如 1024x1536 / 2K / auto"></div>'
  +'<div style="flex:1;min-width:110px"><label class="fl">数量</label><select id="count" style="width:100%">'
  +'<option>1</option><option>2</option><option>3</option><option>4</option></select>'
  +'<div class="muted" style="margin-top:3px">grok 渠道固定 1 张</div></div>'
  +'<div style="flex:1;min-width:110px"><label class="fl">质量</label><select id="quality" style="width:100%">'
  +'<option value="">自动</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option></select>'
  +'<div class="muted" style="margin-top:3px">仅 gpt-image / grok 渠道</div></div>'
  +'</div>'
  +'<div id="refBlock" style="display:none;margin-top:12px"><label class="fl">参考图片（最多 4 张;可拖拽到本卡片,或直接 Ctrl/Cmd+V 粘贴截图）</label>'
  +'<input type="file" id="refInput" accept="image/*" multiple onchange="handleRefFiles(this.files)">'
  +'<div class="thumbs" id="refThumbs"></div></div>'
  +'<div style="margin-top:12px"><label class="fl">提示词</label><textarea id="prompt" placeholder="描述想要的画面，例如：一只戴帽子的橘猫，水彩风格"></textarea></div>'
  +'<div style="margin-top:12px"><button class="btn" id="goDraw" onclick="doDraw()">生成</button> <span class="muted" id="drawState"></span></div>'
  +'</div>'
  +'<h2>本次会话 <span class="muted">结果累积显示 · 刷新页面清空</span></h2><div id="drawGallery"></div>'
  +'<h2>渠道（实际 fallback 顺序）</h2><div class="card" id="providersBox"><span class="muted">加载中…</span></div>'
  +'<h2>最近生成 <span class="muted">点击查看参数 · 可一键重生成</span></h2><div class="card"><div class="thumbs" id="historyBox"></div></div>'
  try{
    await ensureProviders()
    refreshProviderSelect()
    renderProviders()
  }catch(e){document.getElementById('providersBox').innerHTML='<span class="muted" style="color:#ff9d9d">'+esc(e.message)+'</span>'}
  renderGallery()
  installDropZone()
  loadHistory()
}
function setDrawMode(mode){
  drawMode=mode
  document.getElementById('mode-generate').className=mode==='generate'?'on':''
  document.getElementById('mode-edit').className=mode==='edit'?'on':''
  document.getElementById('refBlock').style.display=mode==='edit'?'block':'none'
  refreshProviderSelect()
}
function refreshProviderSelect(){
  if(!providersCache)return
  const list=drawMode==='edit'?providersCache.edit:providersCache.generation
  const sel=document.getElementById('provider')
  if(!sel)return
  const keep=sel.value
  sel.innerHTML=providerOptions(list)
  if(keep&&[...sel.options].some(o=>o.value===keep))sel.value=keep
}
function renderProviders(){
  const box=document.getElementById('providersBox')
  if(!box)return
  const rows=list=>(list||[]).map((p,i)=>'<tr><td>'+(i+1)+'. '+esc(p.label)+'</td><td>'+esc(p.model)+'</td><td>'+esc(p.host)+'</td><td>'+esc(p.size)+'</td><td>'+(p.priority==null?'-':p.priority)+'</td></tr>').join('')
  box.innerHTML='<table class="attempts"><tr><th>文生图渠道</th><th>模型</th><th>host</th><th>size</th><th>priority</th></tr>'+rows(providersCache.generation)
    +'</table><table class="attempts" style="margin-top:10px"><tr><th>图生图渠道</th><th>模型</th><th>host</th><th>size</th><th>priority</th></tr>'+rows(providersCache.edit)+'</table>'
}
function handleRefFiles(files){addRefImageFiles(files)}
function addRefImageFiles(files){
  const room=4-uploadImages.length
  const picked=[...files].filter(f=>f&&String(f.type||'').startsWith('image/')).slice(0,Math.max(0,room))
  if(!picked.length)return
  if(drawMode!=='edit')setDrawMode('edit')
  picked.forEach(f=>{
    const reader=new FileReader()
    reader.onload=()=>{uploadImages.push({name:f.name,dataUri:String(reader.result)});renderRefThumbs()}
    reader.readAsDataURL(f)
  })
}
function removeRef(i){uploadImages.splice(i,1);renderRefThumbs()}
function renderRefThumbs(){
  const box=document.getElementById('refThumbs')
  if(!box)return
  box.innerHTML=uploadImages.map((img,i)=>'<div class="thumb"><img src="'+img.dataUri+'"><b onclick="removeRef('+i+')">✕</b></div>').join('')
}
function installDropZone(){
  const card=document.getElementById('drawFormCard')
  if(!card)return
  card.addEventListener('dragover',e=>{e.preventDefault();card.classList.add('dropping')})
  card.addEventListener('dragleave',()=>card.classList.remove('dropping'))
  card.addEventListener('drop',e=>{
    e.preventDefault();card.classList.remove('dropping')
    addRefImageFiles(e.dataTransfer?e.dataTransfer.files:[])
  })
}
document.addEventListener('paste',e=>{
  if(page()!=='draw')return
  const items=[...((e.clipboardData&&e.clipboardData.items)||[])].filter(it=>it.kind==='file'&&String(it.type).startsWith('image/'))
  if(!items.length)return
  e.preventDefault()
  addRefImageFiles(items.map(it=>it.getAsFile()).filter(Boolean))
})

// ===== 会话画廊与生成执行 =====
let drawGallery=[]
let historyCache=[]
function drawModeOf(payload){return payload.images&&payload.images.length?'edit':'generate'}
function gatherDrawPayload(){
  const payload={
    prompt:document.getElementById('prompt').value.trim(),
    provider:document.getElementById('provider').value,
    aspectRatio:document.getElementById('ratio').value||'',
    size:document.getElementById('customSize').value.trim(),
    n:Number(document.getElementById('count').value)||1,
    quality:document.getElementById('quality').value||''
  }
  if(drawMode==='edit')payload.images=uploadImages.map(x=>x.dataUri)
  return payload
}
async function doDraw(){
  const payload=gatherDrawPayload()
  if(!payload.prompt){alert('请填写提示词');return}
  if(drawMode==='edit'&&!payload.images.length){alert('图生图需要至少上传一张参考图片');return}
  executeDraw(payload)
}
async function executeDraw(payload){
  const entry={state:'running',payload,startedAt:Date.now()}
  drawGallery.unshift(entry)
  renderGallery()
  const btn=document.getElementById('goDraw')
  if(btn)btn.disabled=true
  const state=document.getElementById('drawState')
  const abort=new AbortController()
  drawAbort=abort
  clearInterval(drawTimer)
  drawTimer=setInterval(()=>{
    const el=document.getElementById('gal-state')
    if(el)el.textContent='生成中… 已耗时 '+Math.round((Date.now()-entry.startedAt)/1000)+' 秒'
  },500)
  try{
    const d=await api(drawModeOf(payload)==='edit'?'/api/image/edit':'/api/image/generate',{method:'POST',body:JSON.stringify(payload),signal:abort.signal})
    entry.state='ok';entry.result=d
  }catch(e){
    entry.state='fail'
    if(e&&e.name==='AbortError'){entry.error='已取消';entry.attempts=[]}
    else{entry.error=(e&&e.message)||'未知错误';entry.attempts=(e&&e.attempts)||[]}
  }finally{
    clearInterval(drawTimer);drawAbort=null
    if(state)state.textContent=''
    if(btn)btn.disabled=false
    renderGallery()
    loadHistory()
  }
}
async function cancelDraw(){
  try{await api('/api/image/cancel',{method:'POST',body:'{}'})}catch(e){}
  if(drawAbort)drawAbort.abort()
}
function applyDrawPayload(p){
  if(!p)return
  document.getElementById('prompt').value=p.prompt||''
  const prov=document.getElementById('provider')
  if(prov)prov.value=p.provider||''
  document.getElementById('ratio').value=p.aspectRatio||''
  document.getElementById('customSize').value=p.size||''
  document.getElementById('count').value=String(p.n||1)
  document.getElementById('quality').value=p.quality||''
  toast('参数已回填'+(drawModeOf(p)==='edit'?'(历史参考图不保留,请重新上传)':''))
}
function renderGallery(){
  const box=document.getElementById('drawGallery')
  if(!box)return
  if(!drawGallery.length){box.innerHTML='<div class="card muted">还没有生成记录,填好参数点「生成」。</div>';return}
  box.innerHTML='<div style="margin-bottom:8px"><button class="btn small ghost" onclick="drawGallery=[];renderGallery()">清空画廊</button></div>'
    +drawGallery.map((g,i)=>galleryCard(g,i)).join('')
}
function galleryCard(g,i){
  if(g.state==='running'){
    return '<div class="card"><span class="badge warn">生成中</span> <span class="muted" id="gal-state"></span>'
      +'<div class="muted" style="margin-top:4px">'+esc(String(g.payload.prompt||'').slice(0,80))+'</div>'
      +'<div style="margin-top:8px"><button class="btn small ghost" onclick="cancelDraw()">取消</button></div></div>'
  }
  if(g.state==='ok'){
    const d=g.result
    const figs=(d.images||[]).map((im,ii)=>'<div style="flex:1;min-width:220px"><img src="'+im.dataUri+'" style="cursor:zoom-in" onclick="openLightboxFromGallery('+i+','+ii+')">'
      +'<div class="muted" style="margin-top:4px"><a href="'+im.dataUri+'" download="'+esc(im.file)+'">下载 '+esc(im.file)+'</a> · '+(im.bytes/1024).toFixed(0)+' KB</div></div>').join('')
    return '<div class="card"><div class="muted" style="margin-bottom:8px">'+esc(d.provider)+' · '+esc(d.format)+' · '+(d.count||1)+' 张 · '+(d.tookMs/1000).toFixed(1)+' 秒 · '+esc(d.aspectRatio||'auto')+'</div>'
      +'<div class="row">'+figs+'</div>'
      +'<div style="margin-top:8px;display:flex;gap:6px"><button class="btn small ghost" onclick="executeDraw(drawGallery['+i+'].payload)">再次生成</button>'
      +'<button class="btn small ghost" onclick="applyDrawPayload(drawGallery['+i+'].payload)">参数回填</button></div>'
      +renderAttempts(d.attempts)+'</div>'
  }
  return '<div class="card" style="border-color:#5a2a2a"><b style="color:#ff9d9d">失败</b> <span class="muted">'+esc(g.error||'')+'</span>'
    +'<div style="margin-top:8px"><button class="btn small" onclick="executeDraw(drawGallery['+i+'].payload)">重试</button></div>'
    +renderAttempts(g.attempts)+'</div>'
}
function renderAttempts(attempts){
  if(!attempts||!attempts.length)return ''
  return '<details style="margin-top:8px"><summary class="muted">渠道尝试明细</summary><table class="attempts"><tr><th>渠道</th><th>结果</th><th>耗时</th><th>说明</th></tr>'
    +attempts.map(a=>'<tr><td>'+esc(a.provider)+'</td><td>'+(a.ok?'<span class="badge ok">成功</span>':'<span class="badge bad">失败</span>')+'</td><td>'+(a.ms/1000).toFixed(1)+'s</td><td>'+esc(a.error||'')+'</td></tr>').join('')
    +'</table></details>'
}

// ===== 灯箱 =====
let lbList=[],lbIdx=0
function showLightbox(){
  const lb=document.getElementById('lightbox')
  const item=lbList[lbIdx]||{src:''}
  lb.innerHTML='<div class="lb-nav" style="left:6px" onclick="lbMove(-1)">‹</div>'
    +'<img src="'+item.src+'">'
    +'<div class="lb-nav" style="right:6px" onclick="lbMove(1)">›</div>'
    +'<div style="position:fixed;top:12px;right:16px;color:#8fa3b8;cursor:pointer;font-size:22px" onclick="closeLightbox()">✕</div>'
    +'<div class="lb-cap">'+(item.caption||'')+(lbList.length>1?' <span class="muted">('+(lbIdx+1)+'/'+lbList.length+',方向键切换)</span>':'')+(item.ops||'')+'</div>'
  lb.style.display='flex'
}
function openLightboxFromGallery(gi,ii){
  const g=drawGallery[gi]
  if(!g||!g.result)return
  lbList=(g.result.images||[]).map(im=>({src:im.dataUri,caption:esc(g.result.provider)+' · '+(im.bytes/1024).toFixed(0)+' KB'}))
  lbIdx=ii;showLightbox()
}
function openLightboxFromHistory(i){
  const h=historyCache[i]
  if(!h)return
  const m=h.meta||{}
  const params=[m.mode==='edit'?'图生图':'文生图',m.provider,m.size?('尺寸 '+m.size):(m.aspectRatio&&m.aspectRatio!=='auto'?'比例 '+m.aspectRatio:''),m.quality?('质量 '+m.quality):'',m.n>1?(m.n+' 张'):''].filter(Boolean).join(' · ')
  lbList=[{src:imgSrc(h.file),caption:'提示词: '+esc(m.prompt||'')+'<br><span class="muted">'+esc(params)+'</span>',
    ops:'<div class="lb-ops"><button class="btn small" onclick="regenFromHistory('+i+')">用同参数重新生成</button><button class="btn small ghost" onclick="fillFromHistory('+i+')">参数回填</button></div>'}]
  lbIdx=0;showLightbox()
}
function historyPayload(i){
  const m=(historyCache[i]&&historyCache[i].meta)||{}
  return {prompt:m.prompt||'',provider:m.provider||'',aspectRatio:(m.aspectRatio&&m.aspectRatio!=='auto')?m.aspectRatio:'',size:m.size||'',quality:m.quality||'',n:m.n||1}
}
function regenFromHistory(i){
  const m=(historyCache[i]&&historyCache[i].meta)||{}
  if(m.mode==='edit'&&!uploadImages.length){applyDrawPayload(historyPayload(i));toast('历史是图生图:参数已回填,请上传参考图后点生成');return}
  closeLightbox()
  executeDraw(historyPayload(i))
}
function fillFromHistory(i){closeLightbox();applyDrawPayload(historyPayload(i))}
function lbMove(d){if(!lbList.length)return;lbIdx=(lbIdx+d+lbList.length)%lbList.length;showLightbox()}
function closeLightbox(){const lb=document.getElementById('lightbox');if(lb)lb.style.display='none'}
document.addEventListener('keydown',e=>{
  const lb=document.getElementById('lightbox')
  if(lb&&lb.style.display==='flex'){
    if(e.key==='Escape')closeLightbox()
    if(e.key==='ArrowLeft')lbMove(-1)
    if(e.key==='ArrowRight')lbMove(1)
  }
})

// ===== 历史 =====
async function loadHistory(){
  const box=document.getElementById('historyBox')
  if(!box)return
  try{
    const list=await api('/api/image/history')
    historyCache=list
    box.innerHTML=list.length?list.map((h,i)=>{
      const m=h.meta||{}
      const tip=(h.file+' · '+(h.bytes/1024).toFixed(0)+' KB'+(m.prompt?(' · '+m.prompt):'')).slice(0,140)
      return '<div class="thumb" style="cursor:pointer" title="'+esc(tip)+'" onclick="openLightboxFromHistory('+i+')"><img src="'+imgSrc(h.file)+'"></div>'
    }).join(''):'<span class="muted">还没有生成记录</span>'
  }catch(e){box.innerHTML='<span class="muted">'+esc(e.message)+'</span>'}
}

// ===== 人设页(多套人设 + 账号/群/私聊绑定 + 默认人设) =====
let plTab='library'
let plData=null
let plModel=null
let plAccounts=[]
let cfgData=null
let cfgModel={}
let cfgDirty=false
function plDirty(){ return Boolean(plModel&&plData&&JSON.stringify(plModel)!==JSON.stringify({personas:plData.personas,groupBindings:plData.groupBindings,accountBindings:plData.accountBindings||{},privateBinding:plData.privateBinding})) }
async function renderPersonaPage(){
  document.getElementById('app').innerHTML='<div class="card"><span class="muted">加载中…</span></div>'
  let lib
  try{ lib=await api('/api/persona/library') }catch(e){ document.getElementById('app').innerHTML='<div class="card" style="color:#ff9d9d">'+esc(e.message)+'</div>'; return }
  plData=lib
  plModel=JSON.parse(JSON.stringify({personas:lib.personas,groupBindings:lib.groupBindings,accountBindings:lib.accountBindings||{},privateBinding:lib.privateBinding}))
  plTab='library'
  try{ plAccounts=(await api('/api/persona/accounts')).accounts||[] }catch(e){ plAccounts=[] }
  document.getElementById('app').innerHTML='<div id="personaTabs"></div><div id="personaBody"></div>'
  renderPersonaTabs()
  renderPersonaTab()
}
function renderPersonaTabs(){
  let box=document.getElementById('personaTabs')
  if(!box)return
  box.innerHTML='<div class="seg">'
    +'<button class="'+(plTab==='library'?'on':'')+'" onclick="switchPlTab(\\'library\\')">人设库与绑定</button>'
    +'<button class="'+(plTab==='base'?'on':'')+'" onclick="switchPlTab(\\'base\\')">默认人设与画像</button></div>'
}
function switchPlTab(t){
  if(t!==plTab&&plTab==='library'&&plDirty()){ if(!confirm('人设库有未保存的修改,切换将丢弃,确定?'))return }
  if(t!==plTab&&plTab==='base'&&cfgDirty()){ if(!confirm('默认人设有未保存的修改,切换将丢弃,确定?'))return }
  plTab=t
  renderPersonaTabs()
  renderPersonaTab()
}
function renderPersonaTab(){
  const box=document.getElementById('personaBody')
  if(!box)return
  if(plTab==='library')renderPersonaLibrary(box)
  else renderBasePersona(box)
}
// ---- 人设库 ----
function personaSelectOptions(selected,withDefault){
  const opts=withDefault?['<option value="default"'+(selected==='default'?' selected':'')+'>默认人设</option>']:[]
  for(const p of (plModel.personas||[]))opts.push('<option value="'+esc(p.id)+'"'+(selected===p.id?' selected':'')+'>'+esc(p.name)+'</option>')
  return opts.join('')
}
function renderPersonaLibrary(box){
  let html='<div class="card"><b>多套人设</b> <span class="badge '+(plDirty()?'warn':'ok')+'">'+(plDirty()?'未保存':'干净')+'</span>'
    +'<div class="muted" style="margin-top:4px">未写的字段自动回退默认人设;解析优先级:群绑定/私聊绑定 > 账号默认 > 全局默认。保存写入 persona-library.yaml,立即热生效。</div></div>'
  // 默认人设卡片(只读指引)
  html+='<div class="pcard" style="opacity:.85"><b>默认人设</b> <span class="badge ok">message.yaml</span>'
    +'<div class="muted" style="margin-top:4px">'+esc(plData.basePersona.name||'(未命名)')+' · '+esc(String(plData.basePersona.identity||'').slice(0,60))+'</div>'
    +'<div class="ops"><button class="btn small ghost" onclick="switchPlTab(\\'base\\')">去编辑默认人设</button></div></div>'
  // 库内人设
  html+=(plModel.personas||[]).map((p,i)=>personaCard(p,i)).join('')||'<div class="card muted">库里还没有其他人设,点下面新建。</div>'
  html+='<button class="btn small ghost" onclick="plAddPersona()">+ 新建人设</button>'
  // 绑定
  html+='<h2 style="margin:18px 0 8px">账号绑定 <span class="muted">每个 bot QQ 的默认身份</span></h2>'
  html+='<div class="card">'+(plAccounts.length?plAccounts.map(a=>{
    const bound=plModel.accountBindings[a.qq]||'default'
    return '<div class="fieldline"><div style="flex:1;min-width:150px"><label class="fl">'+esc(a.qq||('(未识别) '+a.container))+(a.running?' <span class="badge ok">在线</span>':' <span class="badge bad">停</span>')+'</label><input type="text" value="'+esc(a.container)+'" disabled></div>'
      +'<div style="flex:2;min-width:200px"><label class="fl">人设</label><select style="width:100%" onchange="plSetAccount(\\''+esc(a.qq)+'\\',this.value)">'+personaSelectOptions(bound,true)+'</select></div></div>'
  }).join(''):'<div class="muted">没有发现 napcat 账号容器;可手动添加绑定。</div>')
  html+='<div class="fieldline"><div style="flex:1;min-width:150px"><label class="fl">手动添加 QQ</label><input type="text" id="plAccQq" placeholder="bot QQ 号"></div>'
    +'<div style="flex:2;min-width:200px"><label class="fl">人设</label><select id="plAccPersona" style="width:100%">'+personaSelectOptions('default',true)+'</select></div>'
    +'<div style="flex:0 0 auto;align-self:end"><button class="btn small ghost" onclick="plAddAccount()">添加</button></div></div></div>'
  html+='<h2 style="margin:18px 0 8px">群绑定</h2><div class="card">'
  const groupRows=Object.entries(plModel.groupBindings||{})
  html+=groupRows.map(([g,id])=>'<div class="fieldline"><div style="flex:1;min-width:150px"><label class="fl">群号</label><input type="text" value="'+esc(g)+'" onchange="plRenameGroup(\\''+esc(g)+'\\',this.value)"></div>'
    +'<div style="flex:2;min-width:200px"><label class="fl">人设</label><select style="width:100%" onchange="plSetGroup(\\''+esc(g)+'\\',this.value)">'+personaSelectOptions(id,true)+'</select></div>'
    +'<div style="flex:0 0 auto;align-self:end"><button class="btn small ghost" style="color:#ff9d9d;border-color:#5a2a2a" onclick="plDelGroup(\\''+esc(g)+'\\')">删除</button></div></div>').join('')||'<div class="muted">还没有群绑定(所有群走账号默认/全局默认)。</div>'
  html+='<div class="fieldline"><div style="flex:1;min-width:150px"><label class="fl">群号</label><input type="text" id="plGroupNew" placeholder="新群号"></div>'
    +'<div style="flex:2;min-width:200px"><label class="fl">人设</label><select id="plGroupPersona" style="width:100%">'+personaSelectOptions('default',true)+'</select></div>'
    +'<div style="flex:0 0 auto;align-self:end"><button class="btn small ghost" onclick="plAddGroup()">添加</button></div></div></div>'
  html+='<h2 style="margin:18px 0 8px">私聊绑定</h2><div class="card"><div class="fieldline"><div style="max-width:320px"><label class="fl">所有私聊默认人设(账号绑定优先)</label><select style="width:100%" onchange="plModel.privateBinding=this.value;renderPersonaTab()">'+personaSelectOptions(plModel.privateBinding||'default',true)+'</select></div></div></div>'
  html+='<div style="margin:16px 0"><button class="btn" onclick="plSave()">保存人设库</button> <span class="muted">'+(plDirty()?'有未保存修改':'无改动')+'</span></div>'
  box.innerHTML=html
}
function personaCard(p,i){
  const moodsLen=(p.moods||[]).length
  return '<div class="pcard"><b>'+esc(p.name)+'</b> <span class="badge">id '+esc(p.id)+'</span>'
    +'<div class="muted" style="margin-top:4px">'+esc(String(p.identity||'').slice(0,80)||'(身份未填,回退默认)')+'</div>'
    +'<div class="muted">'+esc(String(p.tone||'').slice(0,60))+(moodsLen?(' · '+moodsLen+' 个心情'):'')+'</div>'
    +'<div class="ops"><button class="btn small ghost" onclick="plEditPersona('+i+')">编辑</button>'
    +'<button class="btn small ghost" style="color:#ff9d9d;border-color:#5a2a2a" onclick="plDelPersona('+i+')">删除</button></div>'
    +'<div id="plEditor-'+i+'" style="display:none;margin-top:10px"></div></div>'
}
function plEditPersona(i){ const box=document.getElementById('plEditor-'+i); if(!box)return; if(box.style.display==='none'){ box.style.display='block'; box.innerHTML=personaEditor(plModel.personas[i],i) } else { box.style.display='none'; box.innerHTML='' } }
function personaEditor(p,i){
  const tags=f=>((p[f]||[]).join(','))
  let html='<div class="fieldline">'
    +'<div style="flex:1;min-width:140px"><label class="fl">名字</label><input type="text" value="'+esc(p.name||'')+'" oninput="plField('+i+',\\'name\\',this.value)"></div>'
    +'<div style="flex:3;min-width:220px"><label class="fl">身份定位</label><input type="text" value="'+esc(p.identity||'')+'" oninput="plField('+i+',\\'identity\\',this.value)"></div>'
    +'<div style="flex:2;min-width:160px"><label class="fl">语气</label><input type="text" value="'+esc(p.tone||'')+'" oninput="plField('+i+',\\'tone\\',this.value)"></div>'
    +'</div>'
  for(const [f,label] of [['speechStyle','说话风格(逗号分隔)'],['preferences','偏好(逗号分隔)'],['boundaries','边界(逗号分隔)']]){
    html+='<div class="fieldline"><div><label class="fl">'+label+'</label><input type="text" value="'+esc(tags(f))+'" oninput="plTags('+i+',\\''+f+'\\',this.value)"></div></div>'
  }
  html+='<div class="fieldline"><div><label class="fl">其他备注</label><input type="text" value="'+esc(p.notes||'')+'" oninput="plField('+i+',\\'notes\\',this.value)"></div></div>'
  html+='<label class="fl">调皮心情时刻(按概率着色,建议 0.05~0.2)</label>'
  html+=(p.moods||[]).map((m,mi)=>'<div class="fieldline">'
    +'<div style="flex:1;min-width:100px"><input type="text" value="'+esc(m.name||'')+'" placeholder="心情名" oninput="plMood('+i+','+mi+',\\'name\\',this.value)"></div>'
    +'<div style="flex:3;min-width:180px"><input type="text" value="'+esc(m.hint||'')+'" placeholder="一句话描述" oninput="plMood('+i+','+mi+',\\'hint\\',this.value)"></div>'
    +'<div style="flex:0 0 110px"><input type="text" value="'+esc(String(m.probability==null?'':m.probability))+'" placeholder="概率 0.12" oninput="plMoodNum('+i+','+mi+',this.value)"></div>'
    +'<div style="flex:0 0 auto;align-self:center"><button class="btn small ghost" onclick="plDelMood('+i+','+mi+')">✕</button></div></div>').join('')
  html+='<button class="btn small ghost" onclick="plAddMood('+i+')">+ 心情</button>'
  return html
}
function plField(i,f,v){ plModel.personas[i][f]=v; plTouch() }
function plTags(i,f,v){ plModel.personas[i][f]=v.split(/[,，]/).map(s=>s.trim()).filter(Boolean); plTouch() }
function plMood(i,mi,f,v){ plModel.personas[i].moods[mi][f]=v; plTouch() }
function plMoodNum(i,mi,v){ const n=Number(v); plModel.personas[i].moods[mi].probability=Number.isFinite(n)&&n>0?n:0.1; plTouch() }
function plAddMood(i){ plModel.personas[i].moods=plModel.personas[i].moods||[]; plModel.personas[i].moods.push({name:'',hint:'',probability:0.1}); plRerenderKeepEditor(i) }
function plDelMood(i,mi){ plModel.personas[i].moods.splice(mi,1); plRerenderKeepEditor(i) }
function plRerenderKeepEditor(i){ renderPersonaTab(); const box=document.getElementById('plEditor-'+i); if(box){ box.style.display='block'; box.innerHTML=personaEditor(plModel.personas[i],i) } }
function plAddPersona(){ plModel.personas.push({id:'',name:'新人设',identity:'',tone:'',speechStyle:[],preferences:[],boundaries:[],notes:'',moods:[]}); renderPersonaTab(); const last=plModel.personas.length-1; plEditPersona(last) }
function plDelPersona(i){ if(!confirm('删除人设「'+plModel.personas[i].name+'」?绑定它的群/账号会回退。'))return; plModel.personas.splice(i,1); renderPersonaTab() }
function plSetAccount(qq,id){ if(id==='default')delete plModel.accountBindings[qq]; else plModel.accountBindings[qq]=id; plTouch() }
function plAddAccount(){ const qq=document.getElementById('plAccQq').value.trim(); const id=document.getElementById('plAccPersona').value; if(!/^\\d{4,12}$/.test(qq)){toast('QQ 号格式不正确');return} plSetAccount(qq,id); renderPersonaTab() }
function plSetGroup(g,id){ if(id==='default')delete plModel.groupBindings[g]; else plModel.groupBindings[g]=id; plTouch() }
function plAddGroup(){ const g=document.getElementById('plGroupNew').value.trim(); const id=document.getElementById('plGroupPersona').value; if(!g){toast('群号不能为空');return} plSetGroup(g,id); renderPersonaTab() }
function plRenameGroup(oldG,newG){ const id=plModel.groupBindings[oldG]; if(!newG||newG===oldG)return; delete plModel.groupBindings[oldG]; if(id)plModel.groupBindings[newG]=id; plTouch(); renderPersonaTab() }
function plDelGroup(g){ delete plModel.groupBindings[g]; plTouch(); renderPersonaTab() }
function plTouch(){ const b=document.querySelector('#personaBody > .card > .badge'); if(b){ b.className='badge warn'; b.textContent='未保存' } }
async function plSave(){
  try{
    const d=await api('/api/persona/library',{method:'PUT',body:JSON.stringify(plModel)})
    plData=await api('/api/persona/library')
    plModel=JSON.parse(JSON.stringify({personas:plData.personas,groupBindings:plData.groupBindings,accountBindings:plData.accountBindings||{},privateBinding:plData.privateBinding}))
    renderPersonaTab()
    toast('人设库已保存并热生效'+(d.backup?('(备份 '+d.backup+')'):''))
  }catch(e){toast(e.message,6000)}
}
// ---- 默认人设(schema 引擎) ----
async function renderBasePersona(box){
  box.innerHTML='<div class="card"><span class="muted">加载中…</span></div>'
  try{ cfgData=await api('/api/config/persona') }catch(e){ box.innerHTML='<div class="card" style="color:#ff9d9d">'+esc(e.message)+'</div>'; return }
  cfgModel={}
  for(const g of cfgData.groups||[])for(const f of g.fields)cfgModel[f.field]=f.value
  cfgDirty=false
  renderCfgGroups(box)
}
function renderCfgGroups(box){
  let html='<div class="card"><b>'+esc(cfgData.title)+'</b> <span class="badge '+(cfgDirty?'warn':'ok')+'">'+(cfgDirty?'未保存':'干净')+'</span>'
    +'<div class="muted" style="margin-top:4px">保存写入 message.yaml(自动备份),bot 热读即生效。schema 与锅巴同源。</div></div>'
  for(const g of cfgData.groups||[]){
    html+='<h2 style="margin:16px 0 6px">'+esc(g.label)+'</h2><div class="card">'
    for(const f of g.fields)html+=cfgFieldHtml(f)
    html+='</div>'
  }
  html+='<div style="margin:16px 0"><button class="btn" onclick="cfgSave()">保存默认人设</button> <span class="muted">'+(cfgDirty?'有未保存修改':'无改动')+'</span></div>'
  box.innerHTML=html
}
function cfgFieldHtml(f){
  const v=cfgModel[f.field]
  const on='oninput="cfgSet(\\''+esc(f.field)+'\\',this.value,\\''+f.component+'\\')"'
  const help=f.help?'<div class="muted" style="margin-top:3px;font-size:11px">'+esc(f.help)+'</div>':''
  if(f.component==='Switch')return '<div class="fieldline"><div style="display:flex;align-items:center;gap:8px"><input type="checkbox" '+(v===true?'checked':'')+' onchange="cfgSet(\\''+esc(f.field)+'\\',this.checked,\\'Switch\\')"><span style="font-size:13px">'+esc(f.label)+'</span></div>'+help+'</div>'
  if(f.component==='InputTextArea')return '<div class="fieldline"><div><label class="fl">'+esc(f.label)+'</label><textarea style="min-height:64px" '+on+'>'+esc(v)+'</textarea>'+help+'</div></div>'
  if(f.component==='InputNumber')return '<div class="fieldline"><div style="max-width:260px"><label class="fl">'+esc(f.label)+'</label><input type="text" inputmode="decimal" value="'+esc(v===null?'':v)+'" '+on+'>'+help+'</div></div>'
  if(f.component==='GTags')return '<div class="fieldline"><div><label class="fl">'+esc(f.label)+'(逗号分隔)</label><input type="text" value="'+esc(Array.isArray(v)?v.join(','):'')+'" '+on+'>'+help+'</div></div>'
  if(f.component==='GSubForm'){
    let html='<label class="fl">'+esc(f.label)+'</label>'
    html+=(Array.isArray(v)?v:[]).map((row,ri)=>'<div class="fieldline">'
      +f.subFields.map(sub=>'<div style="flex:'+(sub.component==='InputTextArea'?'3':'1')+';min-width:120px"><label class="fl">'+esc(sub.label)+'</label><input type="text" value="'+esc(row[sub.field]==null?'':row[sub.field])+'" oninput="cfgSubSet(\\''+esc(f.field)+'\\','+ri+',\\''+esc(sub.field)+'\\',this.value)"></div>').join('')
      +'<div style="flex:0 0 auto;align-self:end"><button class="btn small ghost" onclick="cfgSubDel(\\''+esc(f.field)+'\\','+ri+')">✕</button></div></div>').join('')
    html+='<button class="btn small ghost" onclick="cfgSubAdd(\\''+esc(f.field)+'\\')">+ 添加</button>'+help
    return '<div class="fieldline"><div>'+html+'</div></div>'
  }
  return '<div class="fieldline"><div><label class="fl">'+esc(f.label)+'</label><input type="text" value="'+esc(v||'')+'" '+on+'>'+help+'</div></div>'
}
function cfgSet(field,value,component){
  let v=value
  if(component==='InputNumber'){ const n=Number(value); v=(value===''||value===null?'':(Number.isFinite(n)?n:value)) }
  if(component==='GTags')v=String(value).split(/[,，]/).map(s=>s.trim()).filter(Boolean)
  cfgModel[field]=v
  cfgDirty=true
  const badges=document.querySelectorAll('#personaBody .card .badge'); if(badges.length)badges[0].outerHTML='<span class="badge warn">未保存</span>'
}
function cfgSubSet(field,ri,subField,value){ cfgModel[field][ri][subField]=value; cfgDirty=true }
function cfgSubDel(field,ri){ cfgModel[field].splice(ri,1); cfgDirty=true; renderCfgGroups(document.getElementById('personaBody')) }
function cfgSubAdd(field){ cfgModel[field]=cfgModel[field]||[]; cfgModel[field].push({}); cfgDirty=true; renderCfgGroups(document.getElementById('personaBody')) }
async function cfgSave(){
  try{
    const d=await api('/api/config/persona',{method:'PUT',body:JSON.stringify({values:cfgModel})})
    cfgDirty=false
    renderBasePersona(document.getElementById('personaBody'))
    toast(d.changed?('已保存 '+d.changed+' 个字段'+(d.backup?('(备份 '+d.backup+')'):'')):'没有变更')
  }catch(e){toast(e.message,6000)}
}

// ===== AI 配置 =====
let aiData=null
let aiActive=null
let aiModel={}
let aiProbe={configKey:'',index:-1,text:''}
function renderAiSkeleton(){
  document.getElementById('app').innerHTML='<div class="row" style="align-items:flex-start"><div id="aiTabs"></div><div id="aiEditor" style="flex:1;min-width:320px"></div></div>'
}
let aiSeq=0
async function renderAiPage(){
  const seq=++aiSeq
  document.getElementById('app').innerHTML='<div class="card"><span class="muted">加载中…</span></div>'
  try{
    const fetched=await api('/api/ai/config')
    if(seq!==aiSeq||page()!=='ai')return
    aiData=fetched
  }catch(e){
    if(seq!==aiSeq||page()!=='ai')return
    document.getElementById('app').innerHTML='<div class="card" style="color:#ff9d9d">'+esc(e.message)+'</div>'
    return
  }
  renderAiSkeleton()
  aiActive=(aiData.definitions||[])[0]?.configKey||null
  renderAiTabs()
  selectAiSection(aiActive)
}
function renderAiTabs(){
  let html='<div class="tabs">'
  for(const def of (aiData.definitions||[])){
    html+='<a class="'+(def.configKey===aiActive?'on':'')+'" onclick="selectAiSection(\\''+esc(def.configKey)+'\\')">'+esc(def.title)+'</a>'
  }
  html+='</div>'
  document.getElementById('aiTabs').innerHTML=html
}
function selectAiSection(configKey){
  if(configKey!==aiActive&&aiDirty()){
    if(!confirm('当前配置位有未保存的修改,切换后将丢弃,确定切换?')) return
  }
  aiActive=configKey
  renderAiTabs()
  const def=(aiData.definitions||[]).find(d=>d.configKey===configKey)
  if(!def)return
  aiModel=JSON.parse(JSON.stringify((aiData.sections||{})[configKey]||[]))
  aiProbe={configKey:'',index:-1,text:''}
  renderAiEditor()
}
function renderAiEditor(){
  const def=(aiData.definitions||[]).find(d=>d.configKey===aiActive)
  const box=document.getElementById('aiEditor')
  // 重渲染(↑↓/删除/探测完成)不丢输入状态:保持滚动与焦点
  const active=document.activeElement
  const focusedAttr=active&&active.dataset?active.dataset.aiField||'':''
  const selStart=active&&typeof active.selectionStart==='number'?active.selectionStart:null
  const scrollY=window.scrollY
  let html='<div class="card"><b>'+esc(def.title)+'</b> <span id="aiDirtyFlag"></span><div class="muted" style="margin-top:4px">'+esc(def.usageHint||'')+'</div>'
    +'<div class="muted" style="margin-top:6px">保存后立即生效(bot 每次调用现读配置,无需重启);每次保存自动备份,优先级数字越小越优先。</div></div>'
  html+=(aiModel||[]).map((p,i)=>providerCard(def,p,i)).join('')||'<div class="card muted">这个配置位还没有渠道,点下面添加。</div>'
  html+='<button class="btn ghost small" onclick="aiAddProvider()">+ 添加渠道</button> '
  html+='<button class="btn small" onclick="aiSave()">保存本组</button> '
  html+='<button class="btn ghost small" onclick="aiProbeGroup()">测试本组已保存渠道</button>'
  html+='<div id="aiProbeResult" style="margin-top:10px"></div>'
  box.innerHTML=html
  window.scrollTo(0,scrollY)
  for(let i=0;i<(aiModel||[]).length;i++)renderUrlPreview(i)
  updateDirtyFlag()
  if(focusedAttr){
    const el=box.querySelector('[data-ai-field="'+focusedAttr+'"]')
    if(el){ el.focus(); if(selStart!=null&&el.setSelectionRange){ try{ el.setSelectionRange(selStart,selStart) }catch(e){} } }
  }
}
function updateDirtyFlag(){
  const el=document.getElementById('aiDirtyFlag')
  if(el)el.innerHTML=aiDirty()?'<span class="badge warn">未保存</span>':''
}
// URL 自动补全预览:与后端实际请求的补全规则保持一致
// (chat: utils/chatCompletionUrl;图片: utils/imageGenerationFallback 的 toImage*Url;embedding: 探针规则)
function previewUrl(def,p){
  const url=String(p.apiUrl||'').trim().replace(/\\/+$/,'')
  if(!url)return ''
  if(def.kind==='image'){
    const tail=def.configKey==='imageEditAiConfig'?'/images/edits':'/images/generations'
    if(/\\/images\\/generations\\/?.*$/i.test(url))return def.configKey==='imageEditAiConfig'?url.replace(/\\/images\\/generations\\/?.*$/i,'/images/edits'):url
    if(/\\/images\\/edits\\/?.*$/i.test(url))return def.configKey==='imageEditAiConfig'?url:url.replace(/\\/images\\/edits\\/?.*$/i,'/images/generations')
    if(/\\/chat\\/completions\\/?.*$/i.test(url))return url.replace(/\\/chat\\/completions\\/?.*$/i,tail)
    if(/\\/v1\\/?$/i.test(url))return url+tail
    return url
  }
  if(def.kind==='embedding'){
    if(/\\/embeddings$/i.test(url))return url
    if(/\\/v\\d+$/i.test(url))return url+'/embeddings'
    return url+'/v1/embeddings'
  }
  if(p.autoResolve===false)return ''
  if(/\\/chat\\/completions$/i.test(url))return url
  if(/\\/v[0-9]+$/i.test(url))return url+'/chat/completions'
  return url+'/v1/chat/completions'
}
function renderUrlPreview(i){
  const box=document.querySelector('[data-ai-urlpreview="'+i+'"]')
  if(!box)return
  const def=(aiData.definitions||[]).find(d=>d.configKey===aiActive)
  const resolved=def?previewUrl(def,aiModel[i]||{}):''
  box.innerHTML=resolved?('实际请求: <code style="color:#8fa3b8;word-break:break-all">'+esc(resolved)+'</code>'):'<span style="opacity:.6">按原文发送(未开自动补全)</span>'
}
function toggleKeyVisibility(btn){
  const input=btn.parentElement.querySelector('input')
  if(!input)return
  input.type=input.type==='password'?'text':'password'
  btn.textContent=input.type==='password'?'👁':'🙈'
}
function providerCard(def,p,i){
  let html='<div class="pcard"><div class="fieldline">'
    +'<div style="flex:2;min-width:150px"><label class="fl">名称</label><input type="text" data-ai-field="'+i+':name" value="'+esc(p.name||'')+'" oninput="aiField('+i+',\\'name\\',this.value)"></div>'
    +'<div style="flex:3;min-width:220px"><label class="fl">URL</label><input type="text" data-ai-field="'+i+':apiUrl" value="'+esc(p.apiUrl||'')+'" placeholder="'+esc(def.urlPlaceholder||'')+'" oninput="aiField('+i+',\\'apiUrl\\',this.value)"><div class="muted" data-ai-urlpreview="'+i+'" style="font-size:11px;margin-top:3px"></div></div>'
    +'<div style="flex:2;min-width:140px"><label class="fl">模型</label><input type="text" data-ai-field="'+i+':model" value="'+esc(p.model||'')+'" placeholder="'+esc(def.modelPlaceholder||'')+'" oninput="aiField('+i+',\\'model\\',this.value)"></div>'
    +'</div><div class="fieldline">'
    +'<div style="flex:3;min-width:220px"><label class="fl">API Key(打码显示,未改动则沿用原值)</label><div style="display:flex;gap:6px;align-items:center"><input type="password" data-ai-field="'+i+':apiKey" style="flex:1" value="'+esc(p.apiKey||'')+'" placeholder="sk-xxxxx" oninput="aiField('+i+',\\'apiKey\\',this.value)"><button class="btn small ghost" type="button" title="显示/隐藏" onclick="toggleKeyVisibility(this)">👁</button></div></div>'
    +'<div style="flex:1;min-width:90px"><label class="fl">优先级</label><input type="text" data-ai-field="'+i+':priority" value="'+esc(String(p.priority==null?1:p.priority))+'" oninput="aiField('+i+',\\'priority\\',this.value)"></div>'
    +'<div style="flex:0 0 auto;align-self:end;display:flex;align-items:center;gap:6px;padding-bottom:8px;white-space:nowrap"><input type="checkbox" data-ai-field="'+i+':autoResolve" style="margin:0" '+(p.autoResolve!==false?'checked':'')+' onchange="aiField('+i+',\\'autoResolve\\',this.checked)"><span class="muted" style="font-size:12px">URL 自动补全</span></div>'
    +'</div>'
  for(const extra of (def.extraFields||[])){
    html+='<div class="fieldline"><div><label class="fl">'+esc(extra.label)+'</label><input type="text" data-ai-field="'+i+':'+esc(extra.field)+'" value="'+esc(p[extra.field]==null?'':p[extra.field])+'" placeholder="'+esc(extra.placeholder||'')+'" oninput="aiField('+i+',\\''+esc(extra.field)+'\\',this.value)"></div></div>'
  }
  html+='<div class="ops">'
    +'<button class="btn small ghost" onclick="aiMove('+i+',-1)" '+(i===0?'disabled':'')+'>↑</button>'
    +'<button class="btn small ghost" onclick="aiMove('+i+',1)" '+(i===aiModel.length-1?'disabled':'')+'>↓</button>'
    +'<button class="btn small ghost" onclick="aiProbeOne('+i+')">测试</button>'
    +'<button class="btn small ghost" style="color:#ff9d9d;border-color:#5a2a2a" onclick="aiRemove('+i+')">删除</button>'
    +'</div>'
  if(aiProbe.configKey===aiActive&&aiProbe.index===i){
    html+='<div class="probe-line">'+(aiProbe.ok?'<span class="badge ok">通</span> ':'<span class="badge bad">不通</span> ')+esc(aiProbe.text)+'</div>'
  }
  html+='</div>'
  return html
}
function aiField(i,field,value){
  if(field==='priority'){ const n=Number(value); aiModel[i][field]=Number.isFinite(n)&&n>0?n:1 }
  else aiModel[i][field]=value
  if(field==='apiUrl'||field==='autoResolve')renderUrlPreview(i)
  updateDirtyFlag()
}
function aiMove(i,dir){
  const j=i+dir
  if(j<0||j>=aiModel.length)return
  const t=aiModel[i];aiModel[i]=aiModel[j];aiModel[j]=t
  renderAiEditor()
}
function aiRemove(i){aiModel.splice(i,1);renderAiEditor()}
function aiAddProvider(){aiModel.push({name:'',apiUrl:'',model:'',apiKey:'',priority:aiModel.length+1,autoResolve:true});renderAiEditor()}
async function aiSave(){
  try{
    const d=await api('/api/ai/config',{method:'PUT',body:JSON.stringify({configKey:aiActive,providers:aiModel})})
    aiData.sections[aiActive]=d.providers
    aiModel=JSON.parse(JSON.stringify(d.providers))
    renderAiEditor()
    providersCache=null
    toast('已保存并生效(备份: '+d.backup+')')
  }catch(e){toast(e.message,6000)}
}
async function aiProbeGroup(){
  const box=document.getElementById('aiProbeResult')
  box.innerHTML='<span class="muted">探测中…(对已保存渠道逐个发最小请求)</span>'
  try{
    const d=await api('/api/ai/probe',{method:'POST',body:JSON.stringify({configKey:aiActive})})
    box.innerHTML=(d.results||[]).map(r=>'<div class="probe-line">'+(r.ok?'<span class="badge ok">通</span> ':'<span class="badge bad">不通</span> ')+esc(r.name)+' '+(r.ms||0)+'ms '+esc(r.detail)+'</div>').join('')||'<span class="muted">没有已保存渠道</span>'
  }catch(e){box.innerHTML='<span class="muted" style="color:#ff9d9d">'+esc(e.message)+'</span>'}
}
async function aiProbeOne(i){
  const p=aiModel[i]
  if(String(p.apiKey||'').includes('…')||String(p.apiKey||'')==='****'){toast('这条的 key 还是打码值:先保存(会用磁盘上的真实 key)或手动输入完整 key');return}
  aiProbe={configKey:aiActive,index:i,ok:false,text:'探测中…'}
  renderAiEditor()
  try{
    const d=await api('/api/ai/probe-provider',{method:'POST',body:JSON.stringify({configKey:aiActive,provider:p})})
    const r=(d.results||[])[0]||{}
    aiProbe={configKey:aiActive,index:i,ok:r.ok,text:(r.ms||0)+'ms '+(r.detail||'')}
  }catch(e){aiProbe={configKey:aiActive,index:i,ok:false,text:e.message}}
  renderAiEditor()
}
renderAiSkeleton()
boot();setInterval(()=>{if(me&&page()==='home')load()},30000)
</script></body></html>`

// ---------- HTTP ----------
function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(payload))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`)
  const provided = String(url.searchParams.get("token") || req.headers["x-console-token"] || "")
  const session = sessionUser(req)
  const authed = Boolean(session) || provided === TOKEN

  if (url.pathname === "/" ) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    return res.end(HTML)
  }
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
    if (url.pathname === "/api/apps") {
      return sendJson(res, 200, { apps: appPageEntryList() })
    }
    if (url.pathname === "/api/config/persona") {
      if (req.method === "GET") return sendJson(res, 200, schemaConfigView("persona"))
      if (req.method === "PUT") {
        const body = await readJsonBody(req, 2 * 1024 * 1024)
        return sendJson(res, 200, saveSchemaConfig("persona", body.values || {}))
      }
      return sendJson(res, 405, { error: "method not allowed" })
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
      for (const signal of imageJobSignals) { signal.abort(); cancelled++ }
      imageJobSignals.clear()
      return sendJson(res, 200, { ok: true, cancelled })
    }
    if (url.pathname === "/api/image/generate" || url.pathname === "/api/image/edit") {
      if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" })
      const mode = url.pathname.endsWith("/edit") ? "edit" : "generate"
      const body = await readJsonBody(req)
      const result = await handleImageDraw(body, mode)
      return sendJson(res, 200, result)
    }
    if (url.pathname === "/api/ai/config") {
      if (req.method === "GET") return sendJson(res, 200, aiConfigOverview())
      if (req.method === "PUT") {
        const body = await readJsonBody(req, 2 * 1024 * 1024)
        return sendJson(res, 200, saveAiProviders(body.configKey, body.providers))
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
    return sendJson(res, 500, {
      error: String(error?.message || error || "未知错误"),
      attempts: error?.attempts,
      tookMs: error?.tookMs
    })
  }

  sendJson(res, 404, { error: "not found" })
})

server.listen(PORT, HOST, () => {
  console.log(`[bl-console] listening on http://${HOST}:${PORT} (token: ${TOKEN.slice(0, 4)}****, users: ${loadUserStore().users.length})`)
  console.log(`[bl-console] draw dir: ${DRAW_DIR}`)
})
