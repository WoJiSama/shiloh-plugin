#!/usr/bin/env node
// bl-chat 控制台 v1:只读看板(账号状态/统计/哨兵/出口IP) + 各账号登录入口聚合。
// 零依赖单文件:
//   - 自带迷你 Redis 客户端(RESP,只实现 HGETALL/HGET/EXPIRE 所需的解析)
//   - docker CLI / nsenter 取容器状态、内存与出口 IP
//   - 读哨兵(bot-sentinel)的状态与告警文件
// 部署:systemd 独立服务(见 console/bl-console.service),与 Yunzai 进程解耦。
import http from "node:http"
import net from "node:net"
import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { execFile } from "node:child_process"
import { fileURLToPath } from "node:url"

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const PORT = Number(process.env.CONSOLE_PORT || 8787)
const HOST = process.env.CONSOLE_HOST || "0.0.0.0"

// ---------- 令牌 ----------
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

async function collectAccounts() {
  const list = await run("docker", ["ps", "-a", "--filter", "name=napcat", "--format", "{{.Names}}"])
  if (list.error) return []
  const names = list.stdout.split("\n").map(s => s.trim()).filter(Boolean)
  if (!names.length) return []
  const statsRaw = await run("docker", ["stats", "--no-stream", "--format", "{{.Name}}|{{.MemUsage}}"], 20000)
  const memByContainer = {}
  for (const line of statsRaw.stdout.split("\n")) {
    const [name, mem] = line.split("|")
    if (name) memByContainer[name.trim()] = (mem || "").trim()
  }
  const accounts = []
  for (const name of names) {
    const info = await run("docker", ["inspect", "-f",
      "{{.State.Status}}|{{.State.Running}}|{{.HostConfig.NetworkMode}}|{{range $k, $v := .NetworkSettings.Ports}}{{$k}}->{{(index $v 0).HostPort}} {{end}}|{{range .Config.Env}}{{.}} {{end}}", name])
    if (info.error) continue
    const [status, running, networkMode, portMaps, env] = info.stdout.trim().split("|")
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
    accounts.push({
      container: name,
      account,
      status: status || "unknown",
      running: running === "true",
      sidecar: sidecarName || null,
      exitIp,
      memory: memByContainer[name] || "",
      webui: webuiPort ? `http://${await publicIp()}:${webuiPort}` : null
    })
  }
  return accounts
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

// ---------- 页面 ----------
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
</style></head><body>
<h1>bl-chat 控制台 <span class="muted" id="at"></span></h1>
<div id="login" class="card" style="display:none">令牌 <input id="tok" type="password"> <button onclick="save()">进入</button></div>
<div id="app"></div>
<div id="err" class="muted"></div>
<script>
const KEY='bl-console-token'
let token=localStorage.getItem(KEY)||new URLSearchParams(location.search).get('token')||''
if(token)localStorage.setItem(KEY,token)
function save(){token=document.getElementById('tok').value;localStorage.setItem(KEY,token);load()}
async function load(){
  try{
    const r=await fetch('/api/overview',{headers:{'x-console-token':token}})
    if(r.status===401){document.getElementById('login').style.display='block';document.getElementById('app').innerHTML='';return}
    const d=await r.json();document.getElementById('login').style.display='none';document.getElementById('err').textContent=''
    document.getElementById('at').textContent=new Date(d.at).toLocaleString()
    const acc=(d.accounts||[]).map(a=>{
      const cls=a.running?(a.status==='running'?'ok':'warn'):'bad'
      const label=a.running?(a.status==='running'?'在线':'已停止'):(a.status==='created'?'冷备':'异常')
      return '<div class="card"><b>'+(a.account||a.container)+'</b> <span class="badge '+cls+'">'+label+'</span>'
        +'<table><tr><td>容器</td><td>'+a.container+'</td><td>内存</td><td>'+(a.memory||'-')+'</td></tr>'
        +'<tr><td>出口IP</td><td>'+(a.exitIp||'未知')+'</td><td>登录入口</td><td>'+(a.webui?'<a href='+a.webui+' target=_blank>'+a.webui+'</a>':'-')+'</td></tr></table></div>'
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
    const sen='<div class="card"><h2 style="margin:0 0 8px">哨兵</h2><div class="muted">'+(d.sentinel.status||'').replace(/\\n/g,'<br>')+'</div>'
      +(d.sentinel.alerts&&d.sentinel.alerts.length?'<h2 style="margin:12px 0 8px">最近告警</h2>'+d.sentinel.alerts.map(a=>'<div class=muted>'+a+'</div>').join(''):'')+'</div>'
    document.getElementById('app').innerHTML='<h2>账号</h2><div class=row>'+acc+'</div><h2>统计</h2>'+statsHtml+sen
  }catch(e){document.getElementById('err').textContent='加载失败: '+e.message}
}
function card(t,v){return '<div class=card style=flex:1;min-width:120px><div class=muted>'+t+'</div><div style="font-size:22px">'+(v||0)+'</div></div>'}
load();setInterval(load,30000)
</script></body></html>`

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`)
  const provided = String(url.searchParams.get("token") || req.headers["x-console-token"] || "")
  if (url.pathname === "/" ) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    return res.end(HTML)
  }
  if (provided !== TOKEN) {
    res.writeHead(401, { "content-type": "application/json" })
    return res.end(JSON.stringify({ error: "unauthorized" }))
  }
  if (url.pathname === "/api/overview") {
    try {
      const overview = await buildOverview()
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" })
      return res.end(JSON.stringify(overview))
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" })
      return res.end(JSON.stringify({ error: String(error?.message || error) }))
    }
  }
  res.writeHead(404, { "content-type": "application/json" })
  res.end(JSON.stringify({ error: "not found" }))
})

server.listen(PORT, HOST, () => {
  console.log(`[bl-console] listening on http://${HOST}:${PORT} (token: ${TOKEN.slice(0, 4)}****)`)
})
