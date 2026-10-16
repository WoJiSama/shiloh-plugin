import fs from "fs"
import path from "path"
import type {Browser} from "puppeteer"
import {adminRecord,adminError} from "../../../contracts/groupAdmin.js"
import type {AdminEvent,GroupAdminLogger} from "../../../contracts/groupAdmin.js"
import {resolveGroupAdminSettings,groupAdminOverrides,groupAdminRowId} from "../domain/groupAdminPolicy.js"
import {normalizeGroupModerationConfig} from "../domain/groupModerationRules.js"
import {normalizeGroupGuardConfig} from "./GroupGuardManager.js"
import {normalizeGroupNoticeConfig} from "./GroupNoticeManager.js"
import type {GroupModerationManager} from "./GroupModerationManager.js"

type Data = Record<string, unknown>
const enabledInGroups = (source:unknown, id:string) => {
  const groups = adminRecord(source).enabledGroups
  return Array.isArray(groups) && groups.map(String).includes(id)
}

// ---------- 命令表：功能开关与规则设置 ----------

interface ToggleFeature {names:string[];module:string;path:string;label:string}
interface SetRule {names:string[];module:string;path:string;label:string;kind:"number"|"boolean";min?:number;max?:number}

const TOGGLE_FEATURES:ToggleFeature[] = [
  {names:["广告检测","广告扫描","广告与刷屏检测","风控检测"],module:"groupModeration",path:"adScan.enabled",label:"广告与刷屏检测"},
  {names:["超长折叠","超长消息折叠","长消息折叠"],module:"groupModeration",path:"overlongMessage.enabled",label:"超长消息折叠"},
  {names:["连发折叠","连发消息折叠","刷屏折叠"],module:"groupModeration",path:"burstMessage.enabled",label:"连发消息折叠"},
  {names:["入群验证","入群审核","进群验证"],module:"groupGuard",path:"enabled",label:"入群验证"},
  {names:["群通知","欢迎退群","退群通知"],module:"groupNotice",path:"enabled",label:"群通知"},
  {names:["广告与刷屏","群管模块"],module:"groupModeration",path:"enabled",label:"广告与刷屏模块"}
]

const SET_RULES:SetRule[] = [
  {names:["超长字数","超长判定字数"],module:"groupModeration",path:"overlongMessage.maxLength",label:"超长判定字数",kind:"number",min:100,max:20000},
  {names:["连发条数","连发条数上限"],module:"groupModeration",path:"burstMessage.maxMessages",label:"连发条数上限",kind:"number",min:3,max:100},
  {names:["连发窗口","连发时间窗","连发秒数"],module:"groupModeration",path:"burstMessage.windowSeconds",label:"连发时间窗(秒)",kind:"number",min:2,max:600},
  {names:["禁言秒数","禁言时长"],module:"groupModeration",path:"burstMessage.muteSeconds",label:"禁言秒数",kind:"number",min:0,max:2592000},
  {names:["答题超时","验证超时"],module:"groupGuard",path:"timeoutSeconds",label:"答题超时(秒)",kind:"number",min:30,max:3600},
  {names:["超长转发"],module:"groupModeration",path:"overlongMessage.forwardEnabled",label:"超长折叠后转发",kind:"boolean"},
  {names:["连发转发"],module:"groupModeration",path:"burstMessage.forwardEnabled",label:"连发折叠后转发",kind:"boolean"}
]

export type GroupAdminCommand =
  | {ok:true;type:"view"}
  | {ok:true;type:"toggle";feature:ToggleFeature;enable:boolean}
  | {ok:true;type:"set";rule:SetRule;value:number|boolean}
  | {ok:false;type:"toggle"|"set";message:string}

const TRUE_WORDS = new Set(["开","开启","打开","true","on","yes","是"])
const FALSE_WORDS = new Set(["关","关闭","关掉","false","off","no","否"])

/** 解析 `.群管` 系列命令；非群管命令返回 null */
export function parseGroupAdminCommand(msg:unknown):GroupAdminCommand|null {
  const text = String(msg || "").trim()
  if (/^[#＃.。]\s*群管(?:页面|面板)?\s*$/.test(text)) return {ok:true,type:"view"}
  const toggle = text.match(/^[#＃.。]\s*群管\s+(开启|关闭)\s+(\S.*?)\s*$/)
  if (toggle) {
    const name = toggle[2]!.trim()
    const feature = TOGGLE_FEATURES.find(item => item.names.includes(name))
    if (!feature) return {ok:false,type:"toggle",message:`没有叫「${name}」的功能。可开关：${TOGGLE_FEATURES.map(item => item.names[0]).join("、")}`}
    return {ok:true,type:"toggle",feature,enable:toggle[1] === "开启"}
  }
  const set = text.match(/^[#＃.。]\s*群管\s+设置\s+(\S+?)\s+(\S+)\s*$/)
  if (set) {
    const name = set[1]!.trim()
    const rawValue = set[2]!.trim()
    const rule = SET_RULES.find(item => item.names.includes(name))
    if (!rule) return {ok:false,type:"set",message:`没有叫「${name}」的规则。可设置：${SET_RULES.map(item => item.names[0]).join("、")}`}
    if (rule.kind === "boolean") {
      if (TRUE_WORDS.has(rawValue.toLowerCase())) return {ok:true,type:"set",rule,value:true}
      if (FALSE_WORDS.has(rawValue.toLowerCase())) return {ok:true,type:"set",rule,value:false}
      return {ok:false,type:"set",message:`「${rule.label}」只能填 开 或 关`}
    }
    const value = Number(rawValue)
    if (!Number.isFinite(value) || !Number.isInteger(value)) return {ok:false,type:"set",message:`「${rule.label}」需要填整数`}
    if (value < (rule.min ?? -Infinity) || value > (rule.max ?? Infinity)) return {ok:false,type:"set",message:`「${rule.label}」需在 ${rule.min} 到 ${rule.max} 之间`}
    return {ok:true,type:"set",rule,value}
  }
  return null
}

// ---------- 面板数据 ----------

export interface PageFeatureRow {label:string;on:boolean;detail:string}
export interface PageSection {label:string;enabled:boolean;masterOk:boolean;rows:PageFeatureRow[]}
export interface GroupAdminPageData {groupId:string;sections:PageSection[]}

export function buildGroupAdminPageData(settings:Data, groupId:unknown):GroupAdminPageData {
  const id = String(groupId || "")
  const resolved = resolveGroupAdminSettings(settings, id)
  const moderation = normalizeGroupModerationConfig(resolved.groupModeration)
  const guard = normalizeGroupGuardConfig(resolved.groupGuard)
  const notice = normalizeGroupNoticeConfig(resolved.groupNotice)
  const masterOk = (key:string) => adminRecord(settings[key]).enabled === true
  const on = (key:string) => enabledInGroups(resolved[key], id)
  return {
    groupId: id,
    sections: [
      {
        label: "广告与刷屏",
        enabled: on("groupModeration"),
        masterOk: masterOk("groupModeration"),
        rows: [
          {label: "广告与刷屏检测", on: moderation.adScan.enabled, detail: "广告/刷屏判定、撤回禁言踢人处置"},
          {
            label: "超长消息折叠",
            on: moderation.overlongMessage.enabled,
            detail: `单条超过 ${moderation.overlongMessage.maxLength} 字撤回并转聊天记录${moderation.overlongMessage.forwardEnabled ? "" : "（不转发）"}`
          },
          {
            label: "连发消息折叠",
            on: moderation.burstMessage.enabled,
            detail: `${moderation.burstMessage.windowSeconds} 秒内连发 ${moderation.burstMessage.maxMessages} 条整批撤回转发`
              + (moderation.burstMessage.muteSeconds > 0 ? `，禁言 ${moderation.burstMessage.muteSeconds} 秒` : "（不禁言）")
          }
        ]
      },
      {
        label: "入群验证",
        enabled: on("groupGuard"),
        masterOk: masterOk("groupGuard"),
        rows: [{label: "入群答题验证", on: on("groupGuard"), detail: `新成员需在 ${guard.timeoutSeconds} 秒内答对题目`}]
      },
      {
        label: "群通知",
        enabled: on("groupNotice"),
        masterOk: masterOk("groupNotice"),
        rows: [{label: "入群欢迎 / 退群提示", on: on("groupNotice"), detail: notice.welcomeEnabled || notice.leaveEnabled ? "按下方文案发送" : "文案开关均已关闭"}]
      }
    ]
  }
}

/** 渲染失败时的纯文本降级版面板 */
export function buildGroupAdminPageText(data:GroupAdminPageData) {
  const lines = [`群 ${data.groupId} 群管面板`]
  for (const section of data.sections) {
    const state = !section.masterOk ? "总开关未开" : section.enabled ? "本群已开启" : "本群未开启"
    lines.push(`\n【${section.label}】${state}`)
    for (const row of section.rows) lines.push(`${row.on ? "✅" : "▫️"} ${row.label}：${row.detail}`)
  }
  lines.push("\n命令：.群管 开启/关闭 <功能>，.群管 设置 <规则> <值>，.群管 查看")
  return lines.join("\n")
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

export function buildGroupAdminPageHtml(data:GroupAdminPageData) {
  const sections = data.sections.map(section => {
    const state = !section.masterOk
      ? '<i class="badge warn">总开关未开</i>'
      : section.enabled
        ? '<i class="badge ok">本群已开启</i>'
        : '<i class="badge no">本群未开启</i>'
    const rows = section.rows.map(row => `
      <tr class="${row.on ? "" : "off"}">
        <td class="name">${escapeHtml(row.label)}</td>
        <td class="detail">${escapeHtml(row.detail)}</td>
        <td class="state">${row.on ? '<i class="badge ok">开</i>' : '<i class="badge no">关</i>'}</td>
      </tr>`).join("")
    return `
    <div class="section">
      <div class="section-head"><h2>${escapeHtml(section.label)}</h2>${state}</div>
      <table><tbody>${rows}</tbody></table>
    </div>`
  }).join("")
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { width: 760px; font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; background: #f3f5f9; color: #1f2430; padding: 22px; }
  .card { background: #fff; border-radius: 14px; box-shadow: 0 6px 24px rgba(15, 23, 42, .08); overflow: hidden; }
  .head { padding: 18px 22px 14px; border-bottom: 1px solid #e8ecf3; display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .head h1 { font-size: 20px; }
  .head .gid { font-size: 13px; color: #6b7280; font-variant-numeric: tabular-nums; }
  .section { padding: 6px 0 2px; }
  .section + .section { border-top: 1px solid #eef1f6; }
  .section-head { display: flex; justify-content: space-between; align-items: center; padding: 10px 22px 6px; }
  .section-head h2 { font-size: 15px; }
  table { width: 100%; border-collapse: collapse; font-size: 13.5px; }
  td { padding: 7px 10px 7px 0; vertical-align: middle; }
  td.name { width: 150px; padding-left: 22px; font-weight: 550; }
  td.detail { color: #5b6472; word-break: break-all; }
  td.state { width: 52px; text-align: center; padding-right: 22px; }
  tr.off .name, tr.off .detail { color: #a2abba; }
  .badge { font-style: normal; font-size: 12px; padding: 2px 9px; border-radius: 999px; white-space: nowrap; }
  .badge.ok { background: #e7f6ec; color: #147d3d; }
  .badge.no { background: #eceef2; color: #6b7280; }
  .badge.warn { background: #fef3c7; color: #92400e; }
  .foot { padding: 12px 22px 16px; border-top: 1px solid #e8ecf3; font-size: 12.5px; color: #5b6472; line-height: 1.8; }
  .foot code { background: #f1f4f9; border-radius: 5px; padding: 1px 6px; font-family: ui-monospace, Menlo, monospace; color: #1f2430; white-space: nowrap; display: inline-block; }
</style>
</head>
<body>
  <div class="card">
    <div class="head">
      <h1>群管面板</h1>
      <span class="gid">群 ${escapeHtml(data.groupId)}</span>
    </div>
    ${sections}
    <div class="foot">
      群主/群管理可命令修改：<code>.群管 开启 连发折叠</code> · <code>.群管 关闭 广告检测</code> · <code>.群管 设置 连发条数 8</code> · <code>.群管 设置 禁言秒数 60</code><br>
      开关：广告检测、超长折叠、连发折叠、入群验证、群通知；规则：超长字数、连发条数、连发窗口、禁言秒数、答题超时、超长/连发转发
    </div>
  </div>
</body>
</html>`
}

// ---------- 写入：按群覆盖 ----------

function setPath(target:Data, dotted:string, value:unknown) {
  const parts = dotted.split(".")
  let cursor = target
  for (const part of parts.slice(0, -1)) {
    const next = JSON.parse(JSON.stringify(adminRecord(cursor[part]))) as Data
    cursor[part] = next
    cursor = next
  }
  cursor[parts.at(-1)!] = value
}

export function buildGroupAdminOverrideUpdates(settings:Data, groupId:unknown, changes:{module:string;path:string;value:unknown}[]) {
  const id = String(groupId || "").trim()
  const rows = groupAdminOverrides(settings).map(row => JSON.parse(JSON.stringify(row)) as Data)
  let row = rows.find(item => groupAdminRowId(item) === id)
  if (!row) {
    row = { groupId: id }
    rows.push(row)
  }
  for (const change of changes) setPath(row, `${change.module}.${change.path}`, change.value)
  const meaningful = Object.keys(row).some(key => !["groupId", "group_id", "group"].includes(key))
  const filtered = meaningful ? rows : rows.filter(item => groupAdminRowId(item) !== id)
  return { "groupAdmin.overrides": filtered }
}

// ---------- 插件 ----------

export interface GroupAdminPagePorts {
  readSettings():Data
  applyUpdates(updates:Data):unknown
  logger?:GroupAdminLogger
  cwd:string
  getSharedBrowser():Promise<Browser>
  scheduleSharedBrowserClose():void
  image(imagePath:string):unknown
}

export function createGroupAdminPageMessage(Plugin:new(options:Record<string,unknown>)=>object,ports:GroupAdminPagePorts,manager:GroupModerationManager) {
  async function renderPage(data:GroupAdminPageData) {
    const outputDir = path.join(ports.cwd, "resources", "shiloh-plugin", "group_admin_pages")
    await fs.promises.mkdir(outputDir, { recursive: true })
    const outputPath = path.join(outputDir, `group-admin-page-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`)
    const browser = await ports.getSharedBrowser()
    const page = await browser.newPage()
    try {
      await page.setViewport({ width: 760, height: 900, deviceScaleFactor: 2 })
      await page.setContent(buildGroupAdminPageHtml(data), { waitUntil: "domcontentloaded", timeout: 30000 })
      const height = await page.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height))
      await page.screenshot({ path: outputPath, clip: { x: 0, y: 0, width: 760, height: Math.max(1, height) }, type: "png" })
      return outputPath
    } finally {
      await page.close().catch(() => {})
      ports.scheduleSharedBrowserClose()
    }
  }

  async function deletePage(path_ = "") {
    if (!path_) return
    try { await fs.promises.unlink(path_) } catch {}
  }

  async function sendPage(e:AdminEvent & {reply(message:unknown):Promise<unknown>}) {
    const data = buildGroupAdminPageData(ports.readSettings(), e.group_id)
    let imagePath = ""
    try {
      imagePath = await renderPage(data)
      await e.reply(ports.image(imagePath))
    } catch (error) {
      ports.logger?.warn?.(`[GroupAdminPage] 面板渲染失败，改发文本: ${adminError(error)}`)
      await e.reply(buildGroupAdminPageText(data))
    } finally {
      await deletePage(imagePath)
    }
    return true
  }

  function canManage(e:AdminEvent) {
    const config = manager.getConfig(e.group_id)
    return Boolean(e?.isMaster || manager.isNativeGroupAdmin(e) || manager.isConfiguredAdmin(config, e.group_id, e.user_id))
  }

  function notAllowedMessage() {
    return "只有群主、群管理或群管配置的管理员可以用命令修改，发送 .群管 查看当前面板。"
  }

  return class GroupAdminPageMessage extends Plugin {
    constructor() {
      super({
        name: "群管理-群管面板",
        dsc: "群内群管面板：查看本群功能与规则，群主/群管理可用命令开启关闭和调参",
        event: "message.group",
        priority: 4800,
        rule: [
          { reg: "^[#＃.。]\\s*群管\\s+(?:开启|关闭)\\s+\\S", fnc: "handleGroupAdminToggle" },
          { reg: "^[#＃.。]\\s*群管\\s+设置\\s+\\S", fnc: "handleGroupAdminSet" },
          { reg: "^[#＃.。]\\s*群管(?:页面|面板)?\\s*$", fnc: "handleGroupAdminView" }
        ]
      })
    }

    async handleGroupAdminView(e:AdminEvent & {reply(message:unknown):Promise<unknown>}) {
      return await sendPage(e)
    }

    async handleGroupAdminToggle(e:AdminEvent & {reply(message:unknown):Promise<unknown>}) {
      if (!canManage(e)) {
        await e.reply(notAllowedMessage())
        return true
      }
      const command = parseGroupAdminCommand(e.msg)
      if (!command || !command.ok || command.type !== "toggle") return false
      const { feature, enable } = command
      ports.applyUpdates(buildGroupAdminOverrideUpdates(ports.readSettings(), e.group_id, [
        { module: feature.module, path: feature.path, value: enable }
      ]))
      ports.logger?.info?.(`[GroupAdminPage] ${e.group_id} user=${e.user_id} ${enable ? "开启" : "关闭"} ${feature.label}`)
      await e.reply(`已${enable ? "开启" : "关闭"}「${feature.label}」，发送 .群管 查看最新面板。`)
      return true
    }

    async handleGroupAdminSet(e:AdminEvent & {reply(message:unknown):Promise<unknown>}) {
      if (!canManage(e)) {
        await e.reply(notAllowedMessage())
        return true
      }
      const command = parseGroupAdminCommand(e.msg)
      if (!command || !command.ok || command.type !== "set") return false
      const { rule, value } = command
      ports.applyUpdates(buildGroupAdminOverrideUpdates(ports.readSettings(), e.group_id, [
        { module: rule.module, path: rule.path, value }
      ]))
      ports.logger?.info?.(`[GroupAdminPage] ${e.group_id} user=${e.user_id} 设置 ${rule.label}=${String(value)}`)
      await e.reply(`已设置「${rule.label}」为 ${rule.kind === "boolean" ? (value ? "开" : "关") : value}，发送 .群管 查看最新面板。`)
      return true
    }
  }
}
