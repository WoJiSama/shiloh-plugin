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
import { buildDiceReplyPayload } from "../domains/dice/diceReplyCatalog.js"
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
  html, body { height: 100%; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f3f5f9; color: #1f2430; display: flex; flex-direction: column; }
  header { background: #fff; border-bottom: 1px solid #e5e9f0; padding: 14px 22px; display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  header h1 { font-size: 18px; }
  header .spacer { flex: 1; }
  input, select, button, textarea { font: inherit; border: 1px solid #d4dae3; border-radius: 8px; padding: 6px 10px; background: #fff; }
  button { cursor: pointer; background: #4c6ef5; border-color: #4c6ef5; color: #fff; }
  button.ghost { background: #fff; color: #4c6ef5; }
  button.danger { background: #fff; color: #e03131; border-color: #f1c1c1; }
  button:disabled { opacity: .5; cursor: not-allowed; }
  #token { width: 220px; }
  main { display: flex; flex: 1; min-height: 0; }
  #domains { width: 230px; background: #fff; border-right: 1px solid #e5e9f0; padding: 14px 10px; overflow-y: auto; flex-shrink: 0; }
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
  .section-title { font-size: 15px; font-weight: 600; margin: 24px 0 10px; }
  .card { background: #fff; border: 1px solid #e5e9f0; border-radius: 12px; margin-bottom: 12px; overflow: hidden; }
  .card-head { display: flex; align-items: center; gap: 10px; padding: 12px 14px; cursor: pointer; }
  .card-head:hover { background: #fafbfd; }
  .card-head .title { font-weight: 600; font-size: 14px; white-space: nowrap; }
  .card-head .desc { font-size: 12px; color: #8a93a5; flex: 1; }
  .card-head .toggle { font-size: 12px; color: #4c6ef5; white-space: nowrap; }
  .card.open .card-head { background: #fafbfd; border-bottom: 1px solid #e5e9f0; }
  .card-body { display: none; padding: 14px; }
  .card.open .card-body { display: block; }
  .chips { padding: 0 14px 10px; }
  .card.open .chips { display: none; }
  .chip { display: inline-block; background: #eef2ff; color: #4c6ef5; border-radius: 6px; padding: 2px 8px; font-size: 12px; margin: 0 6px 0 0; }
  .sub-title { font-size: 14px; font-weight: 600; margin: 14px 0 8px; }
  .sub-title:first-child { margin-top: 0; }
  .hint { font-size: 12px; color: #8a93a5; margin: 4px 0 8px; }
  .grid-row { display: grid; grid-template-columns: 150px 1fr; gap: 8px; align-items: start; margin-bottom: 6px; }
  .grid-row .label { font-size: 13px; color: #6b7280; padding-top: 8px; }
  .grid-row textarea { width: 100%; min-height: 42px; font-size: 13px; resize: vertical; line-height: 1.4; }
  .cmd-group { margin: 10px 0 14px; padding: 10px 12px; background: #f7f9fc; border-radius: 10px; }
  .cmd-group .cmd { font-weight: 600; font-size: 13px; margin-bottom: 6px; }
  .save-bar { position: sticky; bottom: 12px; background: #fff; border: 1px solid #e5e9f0; border-radius: 12px; padding: 10px 14px; display: flex; align-items: center; gap: 12px; margin-top: 16px; box-shadow: 0 4px 14px rgba(0,0,0,.08); }
  .save-bar .hint { margin: 0; flex: 1; }
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
const state = { token: localStorage.getItem("bl-commands-token") || "", domains: [], activeKey: null, dirty: false, diceTemplates: {}, dicePacks: [], diceCheckLevels: {}, diceInsanity: {}, diceBuiltin: [], diceLevelMeta: [] }

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
  const addCmd = document.createElement("button")
  addCmd.className = "ghost"
  addCmd.style.marginTop = "10px"
  addCmd.textContent = "+ 新增命令"
  addCmd.onclick = () => { d.commands.push({ usage: "#新命令", desc: "", perm: "all", src: "" }); state.dirty = true; renderDomains(); renderEditor() }

  if (d.key === "dice") {
    // 内置规则：可折叠卡片，点开编辑回复内容/档位/疯狂表
    const blSection = document.createElement("div")
    blSection.className = "section-title"
    blSection.textContent = "✅ 内置规则（引擎原生，点开卡片编辑，保存后热生效）"
    box.appendChild(blSection)

    const cardHost = document.createElement("div")
    box.appendChild(cardHost)
    const mappedTplKeys = new Set()

    const makeTplRows = (items, host) => {
      for (const item of items) {
        const key = typeof item === "string" ? item : item.key
        const labelText = typeof item === "string" ? item : (item.label || item.key)
        const hint = typeof item === "string" ? "" : (item.hint || "")
        mappedTplKeys.add(key)
        if (!(key in state.diceTemplates)) state.diceTemplates[key] = ""
        const row = document.createElement("div")
        row.className = "grid-row"
        const label = document.createElement("div")
        label.className = "label"
        label.textContent = labelText
        const input = document.createElement("textarea")
        input.rows = 2
        input.value = state.diceTemplates[key]
        const fallback = (key.indexOf("check_") === 0 && state.diceTemplates.check) ? state.diceTemplates.check : ""
        input.placeholder = hint || (fallback ? ("留空则发送： " + fallback) : "")
        input.oninput = () => { state.diceTemplates[key] = input.value }
        row.appendChild(label); row.appendChild(input)
        host.appendChild(row)
      }
    }

    const makeCard = (title, desc, commands, open) => {
      const card = document.createElement("div")
      card.className = "card" + (open ? " open" : "")
      const head = document.createElement("div")
      head.className = "card-head"
      const t = document.createElement("div")
      t.className = "title"; t.textContent = title
      const dEl = document.createElement("div")
      dEl.className = "desc"; dEl.textContent = desc || ""
      const toggle = document.createElement("div")
      toggle.className = "toggle"; toggle.textContent = open ? "收起 ▲" : "编辑 ▼"
      head.appendChild(t); head.appendChild(dEl); head.appendChild(toggle)
      head.onclick = () => {
        card.classList.toggle("open")
        toggle.textContent = card.classList.contains("open") ? "收起 ▲" : "编辑 ▼"
      }
      const chips = document.createElement("div")
      chips.className = "chips"
      for (const c of (commands || [])) {
        const chip = document.createElement("span")
        chip.className = "chip"; chip.textContent = c
        chips.appendChild(chip)
      }
      const body = document.createElement("div")
      body.className = "card-body"
      card.appendChild(head); card.appendChild(chips); card.appendChild(body)
      cardHost.appendChild(card)
      return body
    }

    let firstCard = true
    for (const b of state.diceBuiltin) {
      const body = makeCard(b.name, b.desc, b.commands, firstCard)
      firstCard = false
      const groups = Array.isArray(b.groups) ? b.groups : []
      if (groups.length) {
        const st = document.createElement("div")
        st.className = "sub-title"; st.textContent = "💬 回复内容（按命令编辑，保存后热生效）"
        body.appendChild(st)
        for (const g of groups) {
          const box = document.createElement("div")
          box.className = "cmd-group"
          const cmd = document.createElement("div")
          cmd.className = "cmd"
          cmd.textContent = g.title || g.command || ""
          box.appendChild(cmd)
          if (g.hint) {
            const hint = document.createElement("div")
            hint.className = "hint"
            hint.textContent = g.hint
            box.appendChild(hint)
          }
          if ((g.templates || []).length) makeTplRows(g.templates, box)
          body.appendChild(box)
        }
      } else if ((b.templateKeys || []).length) {
        const st = document.createElement("div")
        st.className = "sub-title"; st.textContent = "💬 回复内容（保存后热生效）"
        body.appendChild(st)
        makeTplRows(b.templateKeys, body)
      }
      if (b.hasLevels) {
        const st = document.createElement("div")
        st.className = "sub-title"; st.textContent = "🎯 判定档位短名（插入 {level} 的字，不是整句）"
        body.appendChild(st)
        const hint = document.createElement("div")
        hint.className = "hint"
        hint.textContent = "这里只改插入到 {level} 的两个字。要改失败/大失败整句发送，去上面「.ra 检定」里「失败」「大失败」两行。"
        body.appendChild(hint)
        const meta = (state.diceLevelMeta && state.diceLevelMeta.length)
          ? state.diceLevelMeta
          : [
              { key: "critical", label: "大成功" },
              { key: "extreme", label: "极难成功" },
              { key: "hard", label: "困难成功" },
              { key: "success", label: "成功" },
              { key: "fail", label: "失败" },
              { key: "fumble", label: "大失败" }
            ]
        for (const item of meta) {
          if (!(item.key in state.diceCheckLevels)) state.diceCheckLevels[item.key] = item.label
          const row = document.createElement("div")
          row.className = "grid-row"
          const label = document.createElement("div")
          label.className = "label"; label.textContent = item.label
          const input = document.createElement("input")
          input.value = state.diceCheckLevels[item.key]
          input.oninput = () => { state.diceCheckLevels[item.key] = input.value }
          row.appendChild(label); row.appendChild(input)
          body.appendChild(row)
        }
      }
      if (b.hasInsanity) {
        const st = document.createElement("div")
        st.className = "sub-title"; st.textContent = "🧠 疯狂表（每行一条）"
        body.appendChild(st)
        for (const tableKey of ["temp", "indefinite"]) {
          const label = document.createElement("div")
          label.className = "hint"
          label.textContent = tableKey === "temp" ? "临时疯狂表（.ti）" : "总结疯狂表（.li）"
          body.appendChild(label)
          const ta = document.createElement("textarea")
          ta.style.cssText = "width:100%;height:150px;font-size:13px;margin-bottom:10px"
          ta.value = (state.diceInsanity[tableKey] || []).join("\\n")
          ta.dataset.insanity = tableKey
          ta.oninput = () => { state.diceInsanity[tableKey] = ta.value.split("\\n").filter(Boolean) }
          body.appendChild(ta)
        }
      }
      if (!groups.length && !(b.templateKeys || []).length && !b.hasLevels && !b.hasInsanity) {
        const hint = document.createElement("div")
        hint.className = "hint"
        hint.textContent = "此规则无需配置模板，命令行为见上方命令表；牌堆文件放服务器 config/decks/ 目录。"
        body.appendChild(hint)
      }
    }

    // 未归组的模板 → 通用卡片
    const leftoverKeys = Object.keys(state.diceTemplates).filter(k => !mappedTplKeys.has(k))
    if (leftoverKeys.length) {
      const body = makeCard("通用模板", "未归类到具体规则的回复模板", [], false)
      const st = document.createElement("div")
      st.className = "sub-title"; st.textContent = "💬 回复内容（保存后热生效）"
      body.appendChild(st)
      makeTplRows(leftoverKeys, body)
    }

    // 吸底保存条
    const saveBar = document.createElement("div")
    saveBar.className = "save-bar"
    const saveHint = document.createElement("div")
    saveHint.className = "hint"
    saveHint.textContent = "修改回复模板 / 档位名 / 疯狂表后点保存，立即热生效（写入 message.yaml）"
    const saveBtn = document.createElement("button")
    saveBtn.textContent = "💾 保存骰子设置"
    saveBtn.onclick = async () => {
      try {
        const r = await api("api/dice-templates", { templates: state.diceTemplates, checkLevels: state.diceCheckLevels, insanityTables: state.diceInsanity })
        toast("骰子设置已保存并热生效：模板 " + r.saved + " 条、档位 " + r.savedLevels + " 项、疯狂表 " + r.savedInsanity + " 条")
      } catch (e) { toast(e.message, true) }
    }
    saveBar.appendChild(saveHint); saveBar.appendChild(saveBtn)
    box.appendChild(saveBar)

    if (state.dicePacks.length) {
      const packTitle = document.createElement("div")
      packTitle.className = "section-title"
      packTitle.textContent = "📦 已导入的规则包/海豹扩展（群里发 .骰规则列表 查看；.骰规则启用/禁用 <包名> 切换）"
      box.appendChild(packTitle)
      const packTable = document.createElement("table")
      packTable.innerHTML = "<thead><tr><th>包名</th><th>ID</th><th>版本</th><th>启用群数</th><th>命令</th><th></th></tr></thead><tbody></tbody>"
      const packBody = packTable.querySelector("tbody")
      for (const pack of state.dicePacks) {
        const tr = document.createElement("tr")
        tr.innerHTML = "<td>" + pack.name + "</td><td>" + pack.id + "</td><td>" + (pack.versions || []).join("/") + "</td><td>" + (pack.enabledGroups || 0) + "</td><td style='font-size:12px'>" + (pack.commands || []).join(" ") + "</td><td><button class='ghost' data-edit-pack='" + pack.id + "'>编辑源码</button></td>"
        packBody.appendChild(tr)
      }
      box.appendChild(packTable)

      // 海豹扩展源码编辑器
      const editorDiv = document.createElement("div")
      editorDiv.id = "seal-source-editor"
      editorDiv.style.cssText = "display:none;margin-top:14px"
      box.appendChild(editorDiv)

      packTable.addEventListener("click", async e => {
        const btn = e.target.closest("[data-edit-pack]")
        if (!btn) return
        const packId = btn.dataset.editPack
        try {
          const data = await api("api/seal-source/" + packId)
          editorDiv.style.display = "block"
          editorDiv.innerHTML = ""
          const title = document.createElement("h4")
          title.textContent = "📝 " + packId + " 源码（修改后保存即热生效，语法错误会被拒绝）"
          editorDiv.appendChild(title)
          const ta = document.createElement("textarea")
          ta.style.cssText = "width:100%;height:400px;font-family:monospace;font-size:12px;border:1px solid #d4dae3;border-radius:8px;padding:8px"
          ta.value = data.source
          editorDiv.appendChild(ta)
          const saveBtn = document.createElement("button")
          saveBtn.style.marginTop = "8px"
          saveBtn.textContent = "保存源码"
          saveBtn.onclick = async () => {
            try {
              const r = await api("api/seal-source/" + packId, { source: ta.value })
              toast("源码已保存并热生效（" + r.commands.join(",") + "）")
            } catch (e2) { toast(e2.message, true) }
          }
          editorDiv.appendChild(saveBtn)
        } catch (e2) {
          toast(e2.message, true)
        }
      })
    }
    const helpTitle = document.createElement("div")
    helpTitle.className = "section-title"
    helpTitle.textContent = "命令帮助（只改说明书，不改群里实际发送的话）"
    box.appendChild(helpTitle)
  }

  box.appendChild(table)
  box.appendChild(addCmd)
}

async function loadDiceExtras() {
  try {
    const data = await api("api/dice-data")
    state.diceTemplates = data.templates || {}
    state.dicePacks = data.packs || []
    state.diceCheckLevels = data.checkLevels || {}
    state.diceInsanity = data.insanityTables || {}
    state.diceBuiltin = data.builtin || []
    state.diceLevelMeta = data.checkLevelMeta || []
  } catch (e) { toast("骰子模板读取失败：" + e.message, true) }
}

async function load() {
  try {
    await loadDiceExtras()
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
  $("unlock").disabled = true
  $("unlock").textContent = "正在加载..."
  try {
    await load()
    localStorage.setItem("bl-commands-token", state.token)
  } catch {}
  $("unlock").disabled = false
  $("unlock").textContent = "进入管理"
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
const urlToken = new URLSearchParams(location.search).get("token")
if (urlToken) {
  state.token = urlToken
  localStorage.setItem("bl-commands-token", urlToken)
  $("token").value = urlToken
  history.replaceState(null, "", location.pathname)
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
      res.set("Cache-Control", "no-cache, no-store, must-revalidate")
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
          const reply = buildDiceReplyPayload(settings.diceSystem || {})
          const templates = reply.templates
          const checkLevels = reply.checkLevels
          const insanityTables = reply.insanityTables
          const builtin = reply.builtin
          const checkLevelMeta = reply.checkLevelMeta
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
          res.json({ templates, checkLevels, insanityTables, packs, builtin, checkLevelMeta })

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
            cleaned[key] = String(value ?? "").slice(0, 2000)
          }
          if (!Object.keys(cleaned).length) {
            res.status(400).json({ error: "没有合法模板" })
            return
          }
          // 档位名（可选，仅允许六个已知档位键）
          let levels = null
          if (req.body?.checkLevels != null) {
            const rawLevels = req.body.checkLevels
            if (typeof rawLevels !== "object" || Array.isArray(rawLevels)) {
              res.status(400).json({ error: "checkLevels 必须是对象" })
              return
            }
            levels = {}
            for (const key of ["critical", "extreme", "hard", "success", "fail", "fumble"]) {
              if (rawLevels[key] != null) levels[key] = String(rawLevels[key]).slice(0, 30)
            }
            if (!Object.keys(levels).length) {
              res.status(400).json({ error: "checkLevels 没有合法档位" })
              return
            }
          }
          // 疯狂表（可选，temp/indefinite 两张，每行限长、限条数）
          let insanity = null
          if (req.body?.insanityTables != null) {
            const rawTables = req.body.insanityTables
            if (typeof rawTables !== "object" || Array.isArray(rawTables)) {
              res.status(400).json({ error: "insanityTables 必须是对象" })
              return
            }
            insanity = {}
            for (const tableKey of ["temp", "indefinite"]) {
              const rows = Array.isArray(rawTables[tableKey]) ? rawTables[tableKey] : []
              insanity[tableKey] = rows.slice(0, 50).map(v => String(v ?? "").slice(0, 200)).filter(Boolean)
            }
          }
          const settingsPath = path2.join(pluginRoot, "config", "message.yaml")
          const source = fs2.existsSync(settingsPath)
            ? settingsPath
            : path2.join(pluginRoot, "config_default", "message.yaml")
          const doc = YAML2.parse(fs2.readFileSync(source, "utf8"))
          doc.pluginSettings ||= {}
          doc.pluginSettings.diceSystem ||= {}
          doc.pluginSettings.diceSystem.templates = { ...(doc.pluginSettings.diceSystem.templates || {}), ...cleaned }
          if (levels) doc.pluginSettings.diceSystem.checkLevels = levels
          if (insanity) doc.pluginSettings.diceSystem.insanityTables = insanity
          if (!fs2.existsSync(settingsPath)) fs2.copyFileSync(source, settingsPath)
          fs2.writeFileSync(settingsPath, YAML2.stringify(doc), "utf8")
          logger?.info?.(`[命令管理页] 已保存骰子设置：模板 ${Object.keys(cleaned).length} 条${levels ? "、档位 " + Object.keys(levels).length + " 项" : ""}${insanity ? "、疯狂表 " + (insanity.temp.length + insanity.indefinite.length) + " 条" : ""}（配置热更新自动生效）`)
          res.json({ ok: true, saved: Object.keys(cleaned).length, savedLevels: levels ? Object.keys(levels).length : 0, savedInsanity: insanity ? insanity.temp.length + insanity.indefinite.length : 0 })
        } catch (error) {
          res.status(400).json({ error: error?.message || String(error) })
        }
        return
      }
      if (req.path.startsWith("/api/seal-source/") && req.method === "GET") {
        try {
          const packId = req.path.slice("/api/seal-source/".length).replace(/[^\w-]/g, "")
          if (!packId) { res.status(400).json({ error: "缺少包名" }); return }
          const index = fs2.readFileSync(path2.join(pluginRoot, "data", "dice", "rules", "index.json"), "utf8")
          const packages = JSON.parse(index).packages || {}
          const record = packages[packId]
          if (!record?.versions?.length) { res.status(404).json({ error: `没有找到规则包 ${packId}` }); return }
          const latest = record.versions[record.versions.length - 1]
          if (latest.kind !== "seal-ext") { res.status(400).json({ error: "仅海豹扩展支持在线编辑源码" }); return }
          const sourcePath = path2.join(pluginRoot, "data", "dice", "rules", latest.sourceFile)
          const source = fs2.readFileSync(sourcePath, "utf8")
          res.json({ source, sourceFile: latest.sourceFile, packId, version: latest.version })
        } catch (error) {
          res.status(500).json({ error: error?.message || String(error) })
        }
        return
      }
      if (req.path.startsWith("/api/seal-source/") && req.method === "POST") {
        try {
          const packId = req.path.slice("/api/seal-source/".length).replace(/[^\w-]/g, "")
          const source = String(req.body?.source || "")
          if (!packId || !source.trim()) { res.status(400).json({ error: "缺少包名或源码" }); return }
          const index = fs2.readFileSync(path2.join(pluginRoot, "data", "dice", "rules", "index.json"), "utf8")
          const packages = JSON.parse(index).packages || {}
          const record = packages[packId]
          if (!record?.versions?.length) { res.status(404).json({ error: `没有找到规则包 ${packId}` }); return }
          const latest = record.versions[record.versions.length - 1]
          if (latest.kind !== "seal-ext") { res.status(400).json({ error: "仅海豹扩展支持在线编辑" }); return }
          // 语法预检
          const { SealExtRuntime } = await import("../domains/dice/SealExtRuntime.js")
          const testRuntime = new SealExtRuntime({ packId: "syntax-check", logger })
          const testResult = testRuntime.run(source)
          if (!testResult.commands.length) { res.status(400).json({ error: "修改后源码没有注册任何命令，请检查语法" }); return }
          const sourcePath = path2.join(pluginRoot, "data", "dice", "rules", latest.sourceFile)
          fs2.writeFileSync(sourcePath, source, "utf8")
          // 清运行时缓存（下次命令自动用新源码）
          logger?.info?.(`[命令管理页] 已保存海豹扩展 ${packId} 源码（${source.length} 字符，${testResult.commands.length} 命令），运行时缓存已刷新`)
          res.json({ ok: true, commands: testResult.commands.map(c => c.name) })
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
    ensureGuobaJumpLink({ pluginRoot, token })
    watchGuobaJumpLink({
      pluginRoot,
      token,
      watchImpl: (file, cb) => chokidar.watch(file).on("all", (event) => {
        if (event === "change" || event === "add") cb()
      })
    })
  } catch (error) {
    logger?.warn?.(`[命令管理页] 锅巴跳转按钮守护失败：${error?.message || error}`)
  }
  return { mounted: true, path: MOUNT_PATH }
}
