import fs from "fs"
import path from "path"
import crypto from "crypto"
import chokidar from "chokidar"
import {
  getCommandRegistry,
  writeRegistryConfig,
  writeCommandsMarkdown
} from "./commandRegistry.js"
import { ensureGuobaJumpLink, watchGuobaJumpLink } from "./guobaJumpLink.js"
import fs2 from "fs"
import path2 from "path"
import YAML2 from "yaml"

// 命令管理页：挂在 Yunzai 自带 express（cfg.server.port，默认 2536）上。
// 2536 端口可能无 Yunzai 层鉴权，因此本页强制自带令牌校验。

const MOUNT_PATH = "/bl-chat/commands"
const TOKEN_FILE = "commands-web.json"
let registered = false

function readOrCreateToken(pluginRoot) {
  const tokenPath = path.join(pluginRoot, "config", TOKEN_FILE)
  try {
    const parsed = JSON.parse(fs.readFileSync(tokenPath, "utf8"))
    if (parsed?.token && String(parsed.token).length >= 8) return String(parsed.token)
  } catch {}
  const token = crypto.randomBytes(12).toString("hex")
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true })
  fs.writeFileSync(tokenPath, JSON.stringify({ token, createdAt: new Date().toISOString() }, null, 2), "utf8")
  return token
}

function checkToken(req, token) {
  const provided = String(req?.query?.token || req?.headers?.["x-commands-token"] || "")
  if (!provided || provided !== token) return false
  return true
}

function buildPageHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>命令管理 · shiloh-plugin</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f3f5f9; color: #1f2430; }
  header { background: #fff; border-bottom: 1px solid #e5e9f0; padding: 14px 22px; display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  header h1 { font-size: 18px; }
  header .spacer { flex: 1; }
  input, select, button, textarea { font: inherit; border: 1px solid #d4dae3; border-radius: 8px; padding: 6px 10px; background: #fff; }
  button { cursor: pointer; background: #4c6ef5; border-color: #4c6ef5; color: #fff; }
  button.ghost { background: #fff; color: #4c6ef5; }
  button.danger { background: #fff; color: #e03131; border-color: #f1c1c1; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  #token { width: 220px; }
  main { display: flex; min-height: calc(100vh - 61px); }
  #domains { width: 230px; background: #fff; border-right: 1px solid #e5e9f0; padding: 14px 10px; }
  #domains .item { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px; cursor: pointer; margin-bottom: 4px; }
  #domains .item:hover { background: #f1f4fb; }
  #domains .item.active { background: #e3e9fd; }
  #domains .count { margin-left: auto; font-size: 12px; color: #8a93a5; }
  #domains .add { margin-top: 10px; width: 100%; }
  #editor { flex: 1; padding: 18px 22px; overflow: auto; }
  .meta { background: #fff; border: 1px solid #e5e9f0; border-radius: 12px; padding: 12px 14px; display: grid; grid-template-columns: 90px 1fr 1fr 2fr; gap: 10px; align-items: center; margin-bottom: 14px; }
  .meta label { font-size: 13px; color: #6b7280; }
  table { width: 100%; background: #fff; border: 1px solid #e5e9f0; border-radius: 12px; border-collapse: separate; border-spacing: 0; overflow: hidden; }
  th { text-align: left; font-size: 12px; color: #8a93a5; background: #fafbfd; padding: 9px 10px; border-bottom: 1px solid #e5e9f0; }
  td { padding: 6px 8px; border-bottom: 1px solid #f0f3f8; vertical-align: middle; }
  td input, td select { width: 100%; }
  td.usage { width: 34%; } td.desc { width: 34%; } td.perm { width: 90px; } td.src { width: 18%; }
  td.op { width: 60px; text-align: center; }
  .empty { padding: 40px; text-align: center; color: #8a93a5; }
  #status { position: fixed; bottom: 16px; right: 20px; background: #1f2430; color: #fff; border-radius: 10px; padding: 10px 16px; font-size: 13px; display: none; max-width: 70%; }
  #status.err { background: #a61e4d; }
  .lock { max-width: 460px; margin: 12vh auto; background: #fff; border: 1px solid #e5e9f0; border-radius: 14px; padding: 30px; text-align: center; }
  .lock p { color: #6b7280; font-size: 14px; margin: 12px 0 18px; }
</style>
</head>
<body>
<header>
  <h1>📖 命令管理</h1>
  <a href="/guoba/" target="_blank" style="color:#4c6ef5;text-decoration:none;font-size:14px">返回锅巴 →</a>
  <span id="summary" style="color:#8a93a5;font-size:13px"></span>
  <div class="spacer"></div>
  <input id="token" type="password" placeholder="访问令牌">
  <button class="ghost" id="reload">重新加载</button>
  <button class="ghost" id="export">导出文档</button>
  <button id="save" disabled>保存全部</button>
</header>
<div class="lock" id="lock">
  <h2>需要访问令牌</h2>
  <p>令牌保存在服务器插件目录 config/commands-web.json</p>
  <input id="token2" type="password" placeholder="输入令牌" style="width:70%">
  <br><br>
  <button id="unlock">进入管理</button>
</div>
<main id="app" style="display:none">
  <nav id="domains"></nav>
  <section id="editor"></section>
</main>
<div id="status"></div>
<script>
const state = { token: localStorage.getItem("bl-commands-token") || "", domains: [], activeKey: null, dirty: false, diceTemplates: {}, dicePacks: [] }

const $ = id => document.getElementById(id)
function toast(msg, isErr = false) {
  const el = $("status")
  el.textContent = msg
  el.className = isErr ? "err" : ""
  el.style.display = "block"
  clearTimeout(el._t)
  el._t = setTimeout(() => el.style.display = "none", 3500)
}
async function api(path, body) {
  const res = await fetch(path + (path.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(state.token), body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : {})
  if (res.status === 401) { showLock(); throw new Error("令牌无效") }
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || ("HTTP " + res.status))
  return data
}
function showLock() { $("lock").style.display = "block"; $("app").style.display = "none"; $("save").disabled = true }
function showApp() { $("lock").style.display = "none"; $("app").style.display = "flex"; $("save").disabled = false }

function renderDomains() {
  const nav = $("domains")
  nav.innerHTML = ""
  for (const d of state.domains) {
    const item = document.createElement("div")
    item.className = "item" + (d.key === state.activeKey ? " active" : "")
    item.innerHTML = '<span></span><span class="name"></span><span class="count"></span>'
    item.children[0].textContent = d.icon || ""
    item.children[1].textContent = d.name
    item.children[2].textContent = d.commands.length + " 条"
    item.onclick = () => { state.activeKey = d.key; renderDomains(); renderEditor() }
    nav.appendChild(item)
  }
  const add = document.createElement("button")
  add.className = "ghost add"
  add.textContent = "+ 新增模块"
  add.onclick = () => {
    const key = "domain_" + (state.domains.length + 1)
    state.domains.push({ key, name: "新模块", icon: "", desc: "", commands: [] })
    state.activeKey = key
    state.dirty = true
    renderDomains(); renderEditor()
  }
  nav.appendChild(add)
  const total = state.domains.reduce((n, d) => n + d.commands.length, 0)
  $("summary").textContent = total + " 条命令 / " + state.domains.length + " 个模块" + (state.dirty ? " · 有未保存修改" : "")
}

function renderEditor() {
  const d = state.domains.find(x => x.key === state.activeKey)
  const box = $("editor")
  if (!d) { box.innerHTML = '<div class="empty">左侧选择或新增一个模块</div>'; return }
  box.innerHTML = ""
  const meta = document.createElement("div")
  meta.className = "meta"
  meta.innerHTML = [
    "<label>图标</label>", "<input data-f='icon'>", "<label>名称 / key</label>", "<div style='display:flex;gap:8px'><input data-f='name'><input data-f='key' style='max-width:110px'></div>",
    "<label>说明</label>", '<input data-f="desc" style="grid-column:span 3">', "<label></label>", "<div style='grid-column:span 3;text-align:right'><button class='danger' id='delDomain'>删除整个模块</button></div>"
  ].join("")
  for (const input of meta.querySelectorAll("input")) {
    input.value = d[input.dataset.f] ?? ""
    input.oninput = () => {
      if (input.dataset.f === "key") return
      d[input.dataset.f] = input.value
      state.dirty = true; renderDomains()
    }
  }
  meta.querySelector("#delDomain").onclick = () => {
    if (!confirm("确定删除模块「" + d.name + "」及其 " + d.commands.length + " 条命令？")) return
    state.domains = state.domains.filter(x => x.key !== d.key)
    state.activeKey = state.domains[0]?.key || null
    state.dirty = true
    renderDomains(); renderEditor()
  }
  box.appendChild(meta)

  const table = document.createElement("table")
  table.innerHTML = "<thead><tr><th>用法</th><th>说明</th><th>权限</th><th>实现位置</th><th></th></tr></thead><tbody></tbody>"
  const tbody = table.querySelector("tbody")
  d.commands.forEach((c, i) => {
    const tr = document.createElement("tr")
    tr.innerHTML = '<td class="usage"><input data-f="usage"></td><td class="desc"><input data-f="desc"></td>' +
      '<td class="perm"><select data-f="perm"><option value="all">所有人</option><option value="admin">群管理</option><option value="master">仅主人</option></select></td>' +
      '<td class="src"><input data-f="src"></td><td class="op"><button class="danger">删</button></td>'
    for (const field of ["usage", "desc", "perm", "src"]) {
      const el = tr.querySelector('[data-f="' + field + '"]')
      el.value = c[field] ?? ""
      el.oninput = el.onchange = () => { c[field] = el.value; state.dirty = true; renderDomains() }
    }
    tr.querySelector("button").onclick = () => { d.commands.splice(i, 1); state.dirty = true; renderDomains(); renderEditor() }
    tbody.appendChild(tr)
  })
  box.appendChild(table)

  const addCmd = document.createElement("button")
  addCmd.className = "ghost"
  addCmd.style.marginTop = "10px"
  addCmd.textContent = "+ 新增命令"
  addCmd.onclick = () => { d.commands.push({ usage: "#新命令", desc: "", perm: "all", src: "" }); state.dirty = true; renderDomains(); renderEditor() }
  box.appendChild(addCmd)

  if (d.key === "dice") {
    const tplTitle = document.createElement("h3")
    tplTitle.style.cssText = "margin:18px 0 8px;font-size:15px"
    tplTitle.textContent = "🎲 回复模板（保存即热生效，改的是 message.yaml diceSystem.templates）"
    box.appendChild(tplTitle)
    const tplTable = document.createElement("table")
    tplTable.innerHTML = "<thead><tr><th style='width:110px'>模板名</th><th>内容（支持 {name} {roll} 等变量）</th></tr></thead><tbody></tbody>"
    const tplBody = tplTable.querySelector("tbody")
    for (const [key, value] of Object.entries(state.diceTemplates)) {
      const tr = document.createElement("tr")
      tr.innerHTML = '<td class="num">' + key + '</td><td><input data-tpl="' + key + '"></td>'
      const input = tr.querySelector("input")
      input.value = value
      input.oninput = () => { state.diceTemplates[key] = input.value }
      tplBody.appendChild(tr)
    }
    box.appendChild(tplTable)
    const tplSave = document.createElement("button")
    tplSave.style.marginTop = "10px"
    tplSave.textContent = "保存骰子模板"
    tplSave.onclick = async () => {
      try {
        const r = await api("api/dice-templates", { templates: state.diceTemplates })
        toast("骰子模板已保存并热生效：" + r.saved + " 条")
      } catch (e) { toast(e.message, true) }
    }
    box.appendChild(tplSave)

    if (state.dicePacks.length) {
      const packTitle = document.createElement("h3")
      packTitle.style.cssText = "margin:18px 0 8px;font-size:15px"
      packTitle.textContent = "📦 当前规则包/海豹扩展（群里发 .骰规则列表 查看；.骰规则启用/禁用 <包名> 切换）"
      box.appendChild(packTitle)
      const packTable = document.createElement("table")
      packTable.innerHTML = "<thead><tr><th>包名</th><th>ID</th><th>版本</th><th>启用群数</th><th>命令</th></tr></thead><tbody></tbody>"
      const packBody = packTable.querySelector("tbody")
      for (const pack of state.dicePacks) {
        const tr = document.createElement("tr")
        tr.innerHTML = "<td>" + pack.name + "</td><td>" + pack.id + "</td><td>" + (pack.versions || []).join("/") + "</td><td>" + (pack.enabledGroups || 0) + "</td><td style='font-size:12px'>" + (pack.commands || []).join(" ") + "</td>"
        packBody.appendChild(tr)
      }
      box.appendChild(packTable)
    }
  }
}

async function loadDiceExtras() {
  try {
    const data = await api("api/dice-data")
    state.diceTemplates = data.templates || {}
    state.dicePacks = data.packs || []
  } catch (e) { toast("骰子模板读取失败：" + e.message, true) }
}

async function load() {
  try {
    loadDiceExtras()
    const data = await api("api/data")
    state.domains = data.domains
    state.dirty = false
    if (!state.domains.find(x => x.key === state.activeKey)) state.activeKey = state.domains[0]?.key || null
    showApp(); renderDomains(); renderEditor()
    toast("已加载 " + data.commandCount + " 条命令")
  } catch (e) { toast(e.message, true) }
}
$("unlock").onclick = async () => {
  state.token = $("token2").value.trim()
  $("token").value = state.token
  try {
    await load()
    localStorage.setItem("bl-commands-token", state.token)
  } catch {}
}
$("token").onchange = () => { state.token = $("token").value.trim(); localStorage.setItem("bl-commands-token", state.token); load() }
$("reload").onclick = () => { if (state.dirty && !confirm("有未保存修改，重新加载将丢弃，确定？")) return; load() }
$("save").onclick = async () => {
  try {
    const data = await api("api/save", { domains: state.domains })
    state.dirty = false
    renderDomains()
    toast("已保存并热更新：" + data.commandCount + " 条命令，文档已同步")
  } catch (e) { toast(e.message, true) }
}
$("export").onclick = async () => {
  if (state.dirty && !confirm("有未保存修改，导出的将是已保存版本，继续？")) return
  try { const data = await api("api/export", {}); toast("文档已导出：" + data.docPath) } catch (e) { toast(e.message, true) }
}
if (state.token) load(); else showLock()
</script>
</body>
</html>`
}

/** 在 Yunzai 的 express 上挂载命令管理页（幂等） */
export function registerCommandsWebApp(pluginRoot = process.cwd(), { logger = globalThis.logger } = {}) {
  if (registered) return { mounted: true, already: true }
  const expressApp = globalThis.Bot?.express
  if (!expressApp?.use) {
    logger?.warn?.("[命令管理页] 当前环境没有可用的 Bot.express，跳过挂载")
    return { mounted: false }
  }
  const token = readOrCreateToken(pluginRoot)

  expressApp.use(MOUNT_PATH, async (req, res, next) => {
    if (req.path === "/" || req.path === "" || req.path === "/index.html") {
      res.type("html").send(buildPageHtml())
      return
    }
    if (req.path.startsWith("/api/")) {
      if (!checkToken(req, token)) {
        res.status(401).json({ error: "访问令牌无效" })
        return
      }
      if (req.path === "/api/data") {
        const registry = getCommandRegistry(pluginRoot, { force: true })
        res.json({
          domains: registry.domains,
          commandCount: registry.commandCount,
          configPath: registry.configPath,
          loadError: registry.loadError || ""
        })
        return
      }
      if (req.path === "/api/save" && req.method === "POST") {
        try {
          const target = writeRegistryConfig({ domains: req.body?.domains }, pluginRoot)
          const registry = getCommandRegistry(pluginRoot, { force: true })
          if (registry.loadError) throw new Error(registry.loadError)
          const docPath = writeCommandsMarkdown(registry, pluginRoot)
          logger?.info?.(`[命令管理页] 已保存命令表 ${registry.commandCount} 条 → ${target}`)
          res.json({ ok: true, commandCount: registry.commandCount, docPath: path.relative(pluginRoot, docPath) })
        } catch (error) {
          res.status(400).json({ error: error?.message || String(error) })
        }
        return
      }
      if (req.path === "/api/dice-data") {
        try {
          const pluginRootDir = pluginRoot
          const settingsPath = path2.join(pluginRootDir, "config", "message.yaml")
          const defaultsPath = path2.join(pluginRootDir, "config_default", "message.yaml")
          const cfgPath = fs2.existsSync(settingsPath) ? settingsPath : defaultsPath
          const settings = YAML2.parse(fs2.readFileSync(cfgPath, "utf8")).pluginSettings || {}
          const templates = settings.diceSystem?.templates || {}
          let packs = []
          try {
            const { DiceRulePackManager } = await import("../domains/dice/DiceRulePackManager.js")
            const { diceManager } = await import("../domains/dice/DiceManager.js")
            const manager = new DiceRulePackManager({ diceManager, logger })
            packs = manager.listPackages().map(item => ({
              id: item.id,
              name: item.name,
              versions: item.versions,
              enabledGroups: item.enabledGroups,
              commands: (item.latestCommands || []).map(cmd => `.${cmd}`)
            }))
          } catch (packError) {
            logger?.warn?.(`[命令管理页] 规则包列表读取失败: ${packError?.message || packError}`)
          }
          res.json({ templates, packs })
        } catch (error) {
          res.status(500).json({ error: error?.message || String(error) })
        }
        return
      }
      if (req.path === "/api/dice-templates" && req.method === "POST") {
        try {
          const templates = req.body?.templates
          if (!templates || typeof templates !== "object" || Array.isArray(templates)) {
            res.status(400).json({ error: "templates 必须是对象" })
            return
          }
          const cleaned = {}
          for (const [key, value] of Object.entries(templates)) {
            if (!/^[a-zA-Z][a-zA-Z0-9_]{0,30}$/.test(key)) continue
            cleaned[key] = String(value ?? "").slice(0, 500)
          }
          if (!Object.keys(cleaned).length) {
            res.status(400).json({ error: "没有合法模板" })
            return
          }
          const settingsPath = path2.join(pluginRoot, "config", "message.yaml")
          const source = fs2.existsSync(settingsPath)
            ? settingsPath
            : path2.join(pluginRoot, "config_default", "message.yaml")
          const doc = YAML2.parse(fs2.readFileSync(source, "utf8"))
          doc.pluginSettings ||= {}
          doc.pluginSettings.diceSystem ||= {}
          doc.pluginSettings.diceSystem.templates = { ...(doc.pluginSettings.diceSystem.templates || {}), ...cleaned }
          if (!fs2.existsSync(settingsPath)) fs2.copyFileSync(source, settingsPath)
          fs2.writeFileSync(settingsPath, YAML2.stringify(doc), "utf8")
          logger?.info?.(`[命令管理页] 已保存骰子回复模板 ${Object.keys(cleaned).length} 条（配置热更新自动生效）`)
          res.json({ ok: true, saved: Object.keys(cleaned).length })
        } catch (error) {
          res.status(400).json({ error: error?.message || String(error) })
        }
        return
      }
      if (req.path === "/api/export" && req.method === "POST") {
        const registry = getCommandRegistry(pluginRoot, { force: true })
        const docPath = writeCommandsMarkdown(registry, pluginRoot)
        res.json({ ok: true, docPath: path.relative(pluginRoot, docPath) })
        return
      }
      res.status(404).json({ error: "unknown api" })
      return
    }
    next()
  })

  registered = true
  logger?.mark?.(`[命令管理页] 已挂载 http://<机器人地址>:<端口>${MOUNT_PATH} （令牌见 config/${TOKEN_FILE}）`)
  try {
    ensureGuobaJumpLink({ pluginRoot })
    watchGuobaJumpLink({
      pluginRoot,
      watchImpl: (file, cb) => chokidar.watch(file).on("all", (event) => {
        if (event === "change" || event === "add") cb()
      })
    })
  } catch (error) {
    logger?.warn?.(`[命令管理页] 锅巴跳转按钮守护失败：${error?.message || error}`)
  }
  return { mounted: true, path: MOUNT_PATH }
}
