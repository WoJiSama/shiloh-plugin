import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { evaluateDiceRuleExpression } from "./DiceRuleExpression.js"
import { DICE_RULE_MAX_PACKAGE_BYTES, validateDiceRulePack } from "./DiceRuleSchema.js"
import { KeyedSerialQueue } from "../../utils/messagePipeline/keyedSerialQueue.js"
import { withFileLock } from "../../utils/fileLock.js"
import { secureDiceRandom } from "../../utils/diceRandom.js"
import {
  actorStorageKey,
  createRuleRandom,
  ensureRuleGroupState,
  getRuleGmRecipients,
  getRulePermission,
  newAuditId,
  requireRulePermission,
  resolveRuleActor,
  roleLabel,
  sanitizeAuditValue,
  selfActor
} from "./DiceRuleSession.js"
import { getSegmentData, normalizeMessageSegments } from "../../utils/groupContextResolver.js"

const require = createRequire(import.meta.url)
import { SealExtRuntime, looksLikeSealExtensionSource, extractUserScriptMeta } from "./SealExtRuntime.js"
let parseYaml = null
try {
  const yaml = require("yaml")
  parseYaml = text => yaml.parse(text, { maxAliasCount: 50 })
} catch {}

const INDEX_VERSION = 1
const PENDING_TTL_MS = 24 * 60 * 60 * 1000
const BUILTIN_CARD_ALIASES = new Set(["卡", "card"])
const BUILTIN_SET_ALIASES = new Set(["设", "set"])
const BUILTIN_GET_ALIASES = new Set(["查", "get"])
const BUILTIN_CLEAR_ALIASES = new Set(["删", "clear"])
const BUILTIN_ROLE_ALIASES = new Set(["权限", "role", "roles"])
const BUILTIN_NPC_ALIASES = new Set(["npc"])
const BUILTIN_GROUP_CARD_ALIASES = new Set(["群卡", "groupcard"])
const BUILTIN_GROUP_SET_ALIASES = new Set(["群设", "groupset"])
const BUILTIN_GROUP_GET_ALIASES = new Set(["群查", "groupget"])
const BUILTIN_SESSION_ALIASES = new Set(["团务", "session"])
const BUILTIN_CAMPAIGN_ALIASES = new Set(["战役", "campaign", "群组"])
const BUILTIN_INITIATIVE_ALIASES = new Set(["先攻", "init"])
const BUILTIN_STATUS_ALIASES = new Set(["状态", "status"])
const BUILTIN_ITEM_ALIASES = new Set(["物品", "item", "inventory"])
const BUILTIN_ABILITY_ALIASES = new Set(["技能", "ability", "abilities", "spell"])
const BUILTIN_AUDIT_ALIASES = new Set(["审计", "audit"])
const BUILTIN_DELIVERY_ALIASES = new Set(["投递", "delivery"])
const MAX_AUDIT_RECORDS = 200
const MAX_PRIVATE_DELIVERIES = 100

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function writeFileAtomic(file, content) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(tmp, content)
    fs.renameSync(tmp, file)
  } finally {
    try { fs.rmSync(tmp, { force: true }) } catch {}
  }
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex")
}

function verifyHash(content, expected, label) {
  if (expected && sha256(content) !== expected) throw new Error(`${label}完整性校验失败`)
}

function serializePack(pack) {
  return JSON.stringify(pack, null, 2)
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const item of Object.values(value)) deepFreeze(item)
  return value
}

function sanitizeRuleOutput(value) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\[CQ:/gi, "［CQ:")
}

function defaultIndex() {
  return { version: INDEX_VERSION, packages: {}, groups: {}, pending: {} }
}

function safeIndex(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...defaultIndex(), ...value, packages: value.packages || {}, groups: value.groups || {}, pending: value.pending || {} }
    : defaultIndex()
}

function normalizeText(value = "") {
  return String(value ?? "").trim()
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value))
}

function normalizeCommandText(value = "") {
  const text = normalizeText(value)
  return text.startsWith("。") ? `.${text.slice(1)}` : text
}

function parseQuotedTokens(value = "") {
  const text = String(value || "")
  const tokens = []
  let current = ""
  let quote = ""
  let escaping = false
  for (const ch of text) {
    if (escaping) {
      current += ch
      escaping = false
      continue
    }
    if (ch === "\\" && quote) {
      escaping = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = ""
      else current += ch
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current)
        current = ""
      }
      continue
    }
    current += ch
  }
  if (quote) throw new Error("参数中的引号没有闭合")
  if (current) tokens.push(current)
  return tokens
}

function matchTextAlias(text, aliases = []) {
  const source = String(text || "")
  const ordered = [...new Set(aliases.map(String))].sort((a, b) => b.length - a.length)
  for (const alias of ordered) {
    if (!source.toLowerCase().startsWith(alias.toLowerCase())) continue
    const rest = source.slice(alias.length)
    if (!rest || /^\s/.test(rest) || /[^A-Za-z]/.test(alias[alias.length - 1] || "") || /^[^A-Za-z]/.test(rest)) {
      return { alias, rest: rest.trim() }
    }
  }
  return null
}

function getOwnPath(root, reference) {
  let value = root
  for (const part of String(reference || "").split(".")) {
    if (!part || value === null || typeof value !== "object" || !Object.prototype.hasOwnProperty.call(value, part)) return undefined
    value = value[part]
  }
  return value
}

function renderRuleTemplate(template, context, { strict = true } = {}) {
  return String(template || "").replace(/\{([^{}]+)\}/g, (_, reference) => {
    const value = getOwnPath(context, reference.trim())
    if (value === undefined) {
      if (strict) throw new Error(`模板变量不存在：${reference.trim()}`)
      return ""
    }
    if (Array.isArray(value)) return value.join("、")
    return value === null ? "" : String(value)
  })
}

function formatValidationReport(result, pending = null, sample = "") {
  if (!result.ok) {
    return [
      `规则包校验失败，共 ${result.errors.length} 项：`,
      ...result.errors.slice(0, 20).map((error, index) => `${index + 1}. ${error}`),
      result.errors.length > 20 ? `其余 ${result.errors.length - 20} 项已省略。` : "",
      "现有规则和人物卡没有修改。"
    ].filter(Boolean).join("\n")
  }
  const pack = result.pack
  const fields = Object.keys(pack.character?.fields || {})
  const commands = pack.commands.map(command => `${command.id}(${command.aliases.join("/")})`)
  return [
    `规则包预检通过：${pack.name}（${pack.id}）`,
    `包版本：${pack.compatibility?.package_version || "1.0.0"}`,
    `命令：${commands.join("，")}`,
    `人物卡字段：${fields.join("，") || "无"}`,
    `自定义骰：${Object.keys(pack.dice_sets || {}).join("，") || "无"}`,
    `随机表：${Object.keys(pack.tables || {}).join("，") || "无"}`,
    sample ? `无副作用试掷：${sample}` : "",
    pending ? `待确认编号：${pending.stageId}\n确认导入：.骰规则确认 ${pack.id}` : ""
  ].filter(Boolean).join("\n")
}

/** 动作摘要：一行说清 op + 作用对象，详情留给 .骰规则查看 的完整层级 */
function summarizeRuleAction(action = {}) {
  const op = String(action.op || "?")
  const bits = []
  if (action.field) bits.push(`${action.field}${action.value !== undefined ? `=${action.value}` : ""}`)
  if (action.status) bits.push(`状态 ${action.status}${action.duration !== undefined ? ` ${action.duration}轮` : ""}`)
  if (action.item) bits.push(`物品 ${action.item}${action.quantity !== undefined ? `×${action.quantity}` : ""}`)
  if (action.ability) bits.push(`能力 ${action.ability}${action.rank !== undefined ? ` Lv${action.rank}` : ""}`)
  if (action.scope === "group") bits.push("写群字段")
  else if (action.scope === "target") bits.push(`作用于 ${action.target || "?"}`)
  if (!bits.length && action.value !== undefined) bits.push(String(action.value))
  return `${op} ${bits.join(" ")}`.trim()
}

/** 输出模板取第一段有内容的文本做预览 */
function firstTemplateLine(template = "") {
  const text = String(template || "").replace(/\s+/g, " ").trim()
  return text.length > 40 ? `${text.slice(0, 40)}…` : text || "（空）"
}

/** seal-ext 帮助文本压到可放进卡片的长度，保留行结构 */
function compactSealHelp(help = "") {
  const lines = String(help || "").split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const kept = []
  let total = 0
  for (const line of lines) {
    if (total + line.length > 320 || kept.length >= 10) {
      kept.push("…（完整说明发送该命令的 help 查看）")
      break
    }
    kept.push(line)
    total += line.length
  }
  return kept.length ? kept : ["（无帮助文本）"]
}

function resolveDefaultValue(value, sender) {
  if (typeof value !== "string") return value
  return value
    .replaceAll("{sender.card}", sender.card || sender.nickname || "")
    .replaceAll("{sender.nickname}", sender.nickname || sender.card || "")
}

function previewValue(definition = {}) {
  if (definition.default !== undefined) return resolveDefaultValue(definition.default, { card: "示例角色", nickname: "示例角色" })
  if (definition.type === "string") return "示例"
  if (definition.type === "boolean") return false
  const value = Math.max(Number(definition.min) || 0, 0)
  return definition.max !== undefined ? Math.min(value, Number(definition.max)) : value
}

function convertInputValue(raw, definition, path = "value") {
  if (definition.type === "string") return String(raw)
  if (definition.type === "boolean") {
    const normalized = String(raw).toLowerCase()
    if (["true", "1", "yes", "on", "是", "开"].includes(normalized)) return true
    if (["false", "0", "no", "off", "否", "关"].includes(normalized)) return false
    throw new Error(`${path} 必须是布尔值`)
  }
  if (definition.type === "enum") {
    const candidate = (definition.enum || []).find(item => String(item) === String(raw))
    if (candidate === undefined) throw new Error(`${path} 可选值：${(definition.enum || []).join("、")}`)
    return candidate
  }
  const value = Number(raw)
  if (!Number.isFinite(value) || (definition.type === "integer" && !Number.isInteger(value))) throw new Error(`${path} 必须是${definition.type === "integer" ? "整数" : "数字"}`)
  return value
}

function validateFieldValue(value, definition, path) {
  if (definition.type === "integer" && !Number.isInteger(value)) throw new Error(`${path} 必须是整数`)
  if (definition.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`${path} 必须是有限数字`)
  if (definition.type === "string" && typeof value !== "string") throw new Error(`${path} 必须是字符串`)
  if (definition.type === "boolean" && typeof value !== "boolean") throw new Error(`${path} 必须是布尔值`)
  if (["integer", "number"].includes(definition.type)) {
    if (definition.min !== undefined && value < definition.min) throw new Error(`${path} 不能小于 ${definition.min}`)
    if (definition.max !== undefined && value > definition.max) throw new Error(`${path} 不能大于 ${definition.max}`)
  }
  if (definition.max_length && Array.from(String(value)).length > definition.max_length) throw new Error(`${path} 长度不能超过 ${definition.max_length}`)
  if (Array.isArray(definition.enum) && !definition.enum.some(item => typeof item === typeof value && item === value)) throw new Error(`${path} 可选值：${definition.enum.join("、")}`)
  return value
}

function drawTable(definition = {}, random = secureDiceRandom) {
  const entries = definition.entries || []
  const total = entries.reduce((sum, entry) => sum + Math.max(1, Number(entry.weight) || 1), 0)
  let cursor = Math.floor(random() * total)
  for (const entry of entries) {
    const weight = Math.max(1, Number(entry.weight) || 1)
    if (cursor < weight) return { text: String(entry.text || ""), value: entry.value ?? null, tags: Array.isArray(entry.tags) ? entry.tags : [] }
    cursor -= weight
  }
  const entry = entries[entries.length - 1] || {}
  return { text: String(entry.text || ""), value: entry.value ?? null, tags: Array.isArray(entry.tags) ? entry.tags : [] }
}

function readYamlCandidates(segments = [], origin = "current") {
  const candidates = []
  for (const segment of normalizeMessageSegments(segments)) {
    if (segment?.type !== "file") continue
    const data = getSegmentData(segment)
    const name = String(segment.name || data.name || segment.file_name || data.file_name || segment.file || data.file || "").trim()
    if (!/\.(?:ya?ml|js|mjs|cjs)$/i.test(name)) continue
    candidates.push({
      name,
      origin,
      source: String(segment.url || segment.file_url || data.url || data.file_url || "").trim(),
      fileId: String(segment.file_id || segment.fid || data.file_id || data.fid || data.id || "").trim(),
      busId: String(segment.busid || segment.bus_id || data.busid || data.bus_id || "").trim()
    })
  }
  return candidates
}

function readMessageText(message) {
  if (typeof message === "string") return message
  return normalizeMessageSegments(message)
    .filter(segment => segment?.type === "text")
    .map(segment => {
      const data = getSegmentData(segment)
      return String(segment.text || data.text || "")
    })
    .join("")
}

function extractInlineYaml(value = "") {
  const text = String(value || "").trim()
  const fenced = text.match(/```(?:yaml|yml)?\s*([\s\S]*?)\s*```/i)?.[1]
  if (fenced) return fenced.trim()
  return /^(?:version|id|name|aliases|commands)\s*:/m.test(text) ? text : ""
}

function extractInlineJs(value = "") {
  const text = String(value || "").trim()
  const fenced = text.match(/```(?:js|javascript|node)\s*([\s\S]*?)\s*```/i)?.[1]
  if (fenced) return fenced.trim()
  return ""
}

// JS 规则包特征：必须导出规则对象（module.exports / export default / export const）
export function looksLikeJsRuleSource(text = "") {
  return /^\s*(?:module\.exports\s*=|exports\.(?:default|pack)\s*=|export\s+default\b|export\s+const\s+\w+\s*=|export\s+\{)/m.test(String(text || ""))
}

const JS_RULE_MAX_FUNCTIONS = 32

/**
 * 加载 JS 规则包源码：module.exports / export default 一个规则对象，
 * 可选 functions: { 名字: (args, ctx) => value } 注册进受限表达式。
 * 仅主人可走到这里（导入与确认都是主人权限）；JS 会在本进程执行。
 */
export async function loadJsRuleSource(text, { rulesDir } = {}) {
  const source = String(text || "")
  if (!looksLikeJsRuleSource(source)) throw new Error("JS 规则包必须以 module.exports 或 export default 导出规则对象")
  const useEsm = /^\s*export\s+(?:default|const|\{)/m.test(source)
  const ext = useEsm ? "mjs" : "cjs"
  const dir = path.join(rulesDir || path.join(process.cwd(), "plugins/shiloh-plugin/data/dice_rules"), "pending", ".js-load")
  ensureDir(dir)
  const file = path.join(dir, `load-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext}`)
  writeFileAtomic(file, source)
  try {
    const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`)
    const exported = mod?.default ?? mod?.pack ?? null
    if (!exported || typeof exported !== "object" || Array.isArray(exported)) {
      throw new Error("JS 规则包必须导出一个规则对象（module.exports = {...} 或 export default {...}）")
    }
    const functions = {}
    if (exported.functions !== undefined) {
      if (!exported.functions || typeof exported.functions !== "object" || Array.isArray(exported.functions)) {
        throw new Error("functions 必须是 { 函数名: (args, ctx) => 值 } 形式的对象")
      }
      for (const [name, fn] of Object.entries(exported.functions)) {
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new Error(`自定义函数名不合法：${name}`)
        if (typeof fn !== "function") throw new Error(`functions.${name} 必须是函数`)
        functions[name] = fn
      }
      if (Object.keys(functions).length > JS_RULE_MAX_FUNCTIONS) throw new Error(`自定义函数最多 ${JS_RULE_MAX_FUNCTIONS} 个`)
    }
    const packObject = { ...exported }
    delete packObject.functions
    return { packObject, functions, ext, functionNames: Object.keys(functions) }
  } catch (error) {
    throw new Error(`JS 规则包加载失败：${error.message}`)
  } finally {
    try { fs.rmSync(file, { force: true }) } catch {}
  }
}

async function resolveFileUrl(candidate, e) {
  if (/^https?:\/\//i.test(candidate.source)) return candidate.source
  if (!candidate.fileId) return ""
  try {
    const direct = e.group_id
      ? await e?.group?.getFileUrl?.(candidate.fileId)
      : await e?.friend?.getFileUrl?.(candidate.fileId)
    const url = typeof direct === "string" ? direct : direct?.data?.url || direct?.url
    if (/^https?:\/\//i.test(String(url || ""))) return String(url)
  } catch {}
  if (!e?.bot?.sendApi) return ""
  try {
    const response = await e.bot.sendApi(e.group_id ? "get_group_file_url" : "get_private_file_url", e.group_id
      ? { group_id: e.group_id, file_id: candidate.fileId, ...(candidate.busId ? { busid: candidate.busId } : {}) }
      : { user_id: e.user_id, file_id: candidate.fileId })
    const data = response?.data?.data || response?.data || response || {}
    return String(data.url || data.file_url || "")
  } catch {
    return ""
  }
}

async function downloadYaml(url, options = {}) {
  if (!/^https?:\/\//i.test(String(url || ""))) throw new Error("YAML 文件下载链接无效")
  const controller = new AbortController()
  const timeoutMs = Math.max(1000, Math.min(30000, Number(options.timeoutMs) || 12000))
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await (options.fetchImpl || globalThis.fetch)(url, { signal: controller.signal, redirect: "follow" })
    if (!response?.ok) throw new Error(`YAML 文件下载失败：HTTP ${response?.status || "未知"}`)
    const declared = Number(response.headers?.get?.("content-length") || 0)
    if (declared > DICE_RULE_MAX_PACKAGE_BYTES) throw new Error(`YAML 文件超过 ${DICE_RULE_MAX_PACKAGE_BYTES} 字节上限`)
    const chunks = []
    let total = 0
    if (response.body?.getReader) {
      const reader = response.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = Buffer.from(value)
        total += chunk.length
        if (total > DICE_RULE_MAX_PACKAGE_BYTES) {
          await reader.cancel().catch(() => {})
          throw new Error(`YAML 文件超过 ${DICE_RULE_MAX_PACKAGE_BYTES} 字节上限`)
        }
        chunks.push(chunk)
      }
    } else {
      const chunk = Buffer.from(await response.arrayBuffer())
      total = chunk.length
      chunks.push(chunk)
    }
    const buffer = Buffer.concat(chunks, total)
    if (buffer.length > DICE_RULE_MAX_PACKAGE_BYTES) throw new Error(`YAML 文件超过 ${DICE_RULE_MAX_PACKAGE_BYTES} 字节上限`)
    return buffer.toString("utf8")
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`YAML 文件下载超时（${timeoutMs}ms）`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function resolveDiceRuleImportSource(e = {}, raw = "", options = {}) {
  const inline = extractInlineYaml(raw) || extractInlineJs(raw)
  if (inline) return inline

  const candidates = [...readYamlCandidates(e.message, "current")]
  let reply = null
  if (e.getReply) {
    try { reply = await e.getReply() } catch {}
  }
  if (reply) {
    const replyText = [reply.raw_message, reply.msg, typeof reply.content === "string" ? reply.content : "", readMessageText(reply.message || reply.content)]
      .map(value => extractInlineYaml(value) || extractInlineJs(value))
      .find(Boolean)
    if (replyText) return replyText
    candidates.push(...readYamlCandidates(reply.message || reply.content, "reply"))
  }
  const candidate = candidates[0]
  if (!candidate) throw new Error("请把 YAML/JS 代码放在命令后，或引用一个 .yaml/.yml/.js/.mjs/.cjs 文件再发送 .骰规则导入")
  const url = await resolveFileUrl(candidate, e)
  if (!url) throw new Error(`无法取得 ${candidate.name} 的下载链接`)
  return await downloadYaml(url, options)
}

export class DiceRulePackManager {
  constructor({ diceManager, cwd = process.cwd(), logger = globalThis.logger, random = null } = {}) {
    if (!diceManager) throw new Error("DiceRulePackManager 需要 DiceManager")
    this.diceManager = diceManager
    this.cwd = cwd
    this.logger = logger
    this.random = random
    this.writeChain = Promise.resolve()
    this.runtimeQueue = new KeyedSerialQueue()
    this.packCache = new Map()
    this.jsFunctionsCache = new Map()
    this.sealRuntimes = new Map()
    this.sealWriteQueue = Promise.resolve()
  }

  // 启动时预热 JS 规则包的自定义函数（loadPack 是同步的，函数从这里同步取）
  async warmupJsPacks() {
    const index = this.readIndex()
    const records = []
    for (const record of Object.values(index.packages || {})) {
      for (const version of record.versions || []) {
        if (version.kind === "js") records.push(version)
      }
    }
    for (const record of records) {
      try {
        if (this.jsFunctionsCache.has(record.hash)) continue
        const source = fs.readFileSync(this.resolveRulePath(record.sourceFile), "utf8")
        const loaded = await loadJsRuleSource(source, { rulesDir: this.getRulesDir() })
        this.jsFunctionsCache.set(record.hash, { functions: loaded.functions, packObject: loaded.packObject })
      } catch (error) {
        this.logger?.warn?.(`[骰规则] JS 规则包 ${record.id}@${record.version} 函数预热失败: ${error.message}`)
      }
    }
    return records.length
  }

  getRulesDir() {
    return path.join(this.diceManager.getDataDir(), "rules")
  }

  getIndexPath() {
    return path.join(this.getRulesDir(), "index.json")
  }

  resolveRulePath(file = "") {
    const root = path.resolve(this.getRulesDir())
    const value = String(file || "")
    const target = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value)
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("规则文件路径越界")
    return target
  }

  deletePendingArtifacts(item) {
    for (const relative of [item?.sourceFile, item?.normalizedFile]) {
      if (!relative) continue
      try { fs.unlinkSync(this.resolveRulePath(relative)) } catch {}
    }
  }

  readIndex() {
    const file = this.getIndexPath()
    if (!fs.existsSync(file)) return defaultIndex()
    try {
      return safeIndex(JSON.parse(fs.readFileSync(file, "utf8")))
    } catch (error) {
      this.logger?.warn?.(`[骰规则] 读取索引失败: ${error.message}`)
      throw new Error("规则包索引损坏，已停止写入，请先检查 data/dice/rules/index.json")
    }
  }

  async mutateIndex(mutator) {
    const task = this.writeChain.then(async () => {
      return await withFileLock(path.join(this.getRulesDir(), "locks", "index.lock"), async () => {
        const index = this.readIndex()
        const result = await mutator(index)
        writeFileAtomic(this.getIndexPath(), JSON.stringify(index, null, 2))
        return result
      })
    })
    this.writeChain = task.catch(() => {})
    return await task
  }

  parseAndValidate(source, { jsPack = null, nameHint = "", extraFunctions = [] } = {}) {
    const bytes = Buffer.byteLength(String(source || ""), "utf8")
    if (bytes < 1) return { ok: false, pack: null, errors: ["$: 规则包内容为空"], warnings: [] }
    if (bytes > DICE_RULE_MAX_PACKAGE_BYTES) return { ok: false, pack: null, errors: [`$: 规则包超过 ${DICE_RULE_MAX_PACKAGE_BYTES} 字节上限`], warnings: [] }
    let raw
    if (jsPack) {
      raw = jsPack
    } else {
      if (!parseYaml) return { ok: false, pack: null, errors: ["$: 服务器没有可用的 yaml 解析器"], warnings: [] }
      try {
        raw = parseYaml(String(source))
      } catch (error) {
        return { ok: false, pack: null, errors: [`$: YAML 语法错误：${error.message}`], warnings: [] }
      }
    }
    if (nameHint) raw = { ...raw, name: String(nameHint) }
    return validateDiceRulePack(raw, { maxDiceCount: this.diceManager.getConfig().maxDiceCount, extraFunctions })
  }

  buildDryRunPreview(pack) {
    const command = pack.commands[0]
    const random = createRuleRandom(this.random).random
    const attr = {}
    for (const [id, definition] of Object.entries(pack.character?.fields || {})) {
      if (definition.formula === undefined) attr[id] = previewValue(definition)
    }
    const inventory = this.buildInventoryContext(pack, { inventory: {} })
    const abilities = this.buildAbilityContext(pack, { abilities: {} })
    const shared = {}
    for (const [id, definition] of Object.entries(pack.group?.fields || {})) if (definition.formula === undefined) shared[id] = previewValue(definition)
    const session = { active: false, title: "示例团", round: 0, turn: 0, phase: "idle" }
    const args = {}
    let target = null
    for (const definition of command.arguments || []) {
      if (definition.type === "actor") {
        const sample = { id: "sample-target", name: "示例目标", kind: "npc", attr: { ...attr }, derived: {}, statuses: {}, inventory: { ...inventory }, abilities: { ...abilities } }
        args[definition.id] = definition.multiple ? [sample] : sample
        target ||= sample
      } else args[definition.id] = definition.default !== undefined ? definition.default : previewValue(definition)
    }
    const derived = this.computeDerived(pack, attr, { inventory, abilities, shared, session, __random: random })
    if (target) target.derived = { ...derived }
    const context = { arg: args, attr, derived, roll: {}, table: {}, let: {}, group: { id: 10000 }, shared, session, inventory, abilities, target, opposed: null, result: "" }
    let diceUsed = 0
    const maxDiceCount = pack.limits?.max_dice_count || this.diceManager.getConfig().maxDiceCount
    for (const [id, expression] of Object.entries(command.rolls || {})) {
      const evaluation = this.evaluate(expression, context, pack, { allowDice: true, remainingDice: Math.max(1, maxDiceCount - diceUsed), random })
      diceUsed += evaluation.diceCount
      if (diceUsed > maxDiceCount) throw new Error(`骰子总数超过上限 ${maxDiceCount}`)
      context.roll[id] = { expr: String(expression), total: evaluation.value, detail: evaluation.traces.join(" + ") || String(evaluation.value) }
    }
    for (const [id, tableId] of Object.entries(command.draws || {})) context.table[id] = drawTable(pack.tables[tableId], random)
    for (const [id, expression] of Object.entries(command.let || {})) context.let[id] = this.evaluate(expression, context, pack, { random }).value
    if (command.opposed) {
      const actorValue = Number(this.evaluate(command.opposed.actor_value, context, pack, { allowDice: true, random }).value)
      const targetValue = Number(this.evaluate(command.opposed.target_value, context, pack, { allowDice: true, random }).value)
      const mode = command.opposed.mode || "higher"
      const result = actorValue === targetValue ? command.opposed.tie || "tie" : mode === "higher" ? (actorValue > targetValue ? "actor" : "target") : (actorValue < targetValue ? "actor" : "target")
      context.opposed = { actor: actorValue, target: targetValue, result, winner: result === "actor" ? "示例角色" : result === "target" ? "示例目标" : "平手", margin: Math.abs(actorValue - targetValue) }
    }
    let branch = null
    for (const candidate of command.branches || []) {
      if (candidate.when === undefined || Boolean(this.evaluate(candidate.when, context, pack, { random }).value)) {
        branch = candidate
        break
      }
    }
    if (branch) {
      context.result = branch.result || ""
      for (const [id, expression] of Object.entries(branch.let || {})) context.let[id] = this.evaluate(expression, context, pack, { random }).value
    }
    const sender = { card: "示例角色", nickname: "示例角色" }
    const actor = renderRuleTemplate(pack.identity?.display_name || pack.identity?.fallback || "{sender.card}", { ...context, sender }, { strict: false }) || "示例角色"
    const template = branch?.output ?? command.output ?? pack.templates?.[command.template]
    return renderRuleTemplate(template, { ...context, actor, sender, command: { label: command.label || command.id } }).slice(0, 300)
  }

  /** 海豹骰 JS 扩展：沙箱试跑提取扩展名与命令，包装成 kind=seal-ext 的规则包 */
  async stageSealExtImport(source, actorId = "", options = {}) {
    const meta = extractUserScriptMeta(source)
    const runtime = new SealExtRuntime({ packId: "preview", logger: this.logger, statePath: path.join(this.getRulesDir(), "seal-ext-preview-state.json") })
    let runResult
    try {
      runResult = runtime.run(source)
    } catch (error) {
      const failed = { ok: false, pack: null, errors: [`海豹扩展执行失败：${error.message}`], warnings: [] }
      return { ...failed, report: formatValidationReport(failed) }
    }
    if (!runResult.commands.length) {
      const failed = { ok: false, pack: null, errors: ["海豹扩展没有注册任何命令（seal.ext.register + cmdMap）"], warnings: [] }
      return { ...failed, report: formatValidationReport(failed) }
    }
    const extName = runResult.extensions[0] || meta.name || "seal-ext"
    const packId = String(extName).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 40) || "seal-ext"
    const pack = {
      id: packId,
      name: meta.name || extName,
      aliases: [extName],
      description: `${meta.description || "海豹骰 JS 扩展（兼容层运行）"} 作者:${meta.author || "unknown"} 版本:${meta.version || "?"}`,
      kind: "seal-ext",
      commands: runResult.commands.map(cmd => ({ id: cmd.name, aliases: [cmd.name], label: `${cmd.name}${cmd.allowDelegate ? "（可代骰）" : ""}` })),
      __sealUnsupported: runResult.unsupported
    }
    const stageId = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`
    const commands = pack.commands.map(command => `.${command.id}`)
    const report = [
      `海豹扩展预检通过：${pack.name}（${packId}）`,
      `命令：${commands.join("，")}（直接以 .命令 使用，无需前缀）`,
      runResult.unsupported.length ? `兼容性提示：${runResult.unsupported.join("；")}` : "兼容性：调用的 API 均已支持",
      `待确认编号：${stageId}`,
      `确认导入：.骰规则确认 ${packId}`
    ].join("\n")
    const sourceText = String(source)
    const normalizedText = serializePack(pack)
    const pending = {
      stageId,
      id: pack.id,
      actorId: String(actorId || ""),
      createdAt: Date.now(),
      kind: "seal-ext",
      functionNames: [],
      sourceFile: path.join("pending", pack.id, `${stageId}.js`),
      normalizedFile: path.join("pending", pack.id, `${stageId}.json`),
      sourceHash: sha256(sourceText),
      normalizedHash: sha256(normalizedText)
    }
    const cleanup = []
    await this.mutateIndex(index => {
      for (const [id, item] of Object.entries(index.pending)) {
        if (Date.now() - Number(item.createdAt || 0) > PENDING_TTL_MS) {
          cleanup.push(item)
          delete index.pending[id]
        }
      }
      if (index.pending[pack.id]) cleanup.push(index.pending[pack.id])
      writeFileAtomic(this.resolveRulePath(pending.sourceFile), sourceText)
      writeFileAtomic(this.resolveRulePath(pending.normalizedFile), normalizedText)
      index.pending[pack.id] = pending
    })
    for (const item of cleanup) this.deletePendingArtifacts(item)
    return { ok: true, pack, warnings: [], pending, report }
  }

  /** 取（或创建）某个海豹扩展包的沙箱运行时；vars 直通人物卡 attrs */
  getSealRuntime(pack, record) {
    const key = `${pack.id}@${record?.version || ""}`
    if (this.sealRuntimes.has(key)) return this.sealRuntimes.get(key)
    const sourceFile = path.join(this.getRulesDir(), record?.sourceFile || path.join("packages", pack.id, "source.js"))
    let source = ""
    try {
      source = fs.readFileSync(sourceFile, "utf-8")
    } catch {
      source = ""
    }
    const runtime = new SealExtRuntime({
      packId: pack.id,
      logger: this.logger,
      statePath: path.join(this.getRulesDir(), `seal-ext-${pack.id}-state.json`)
    })
    // vars 直通 .st 人物卡：读走当前卡 attrs；写改卡并异步落盘
    const readCardState = () => {
      const config = this.diceManager.getConfig()
      const state = this.diceManager.readState(config)
      return { config, state }
    }
    const cardOf = (state, groupId, userId) => {
      const user = state.users[String(userId)]
      if (!user) return null
      user.cards ||= {}
      user.activeCard ||= Object.keys(user.cards)[0] || "默认"
      if (!user.cards[user.activeCard]) user.cards[user.activeCard] = { name: user.nickname || "角色", attrs: {}, skills: {} }
      return user.cards[user.activeCard]
    }
    runtime.varsAdapter = {
      get: (groupId, userId, name) => {
        const { state } = readCardState()
        const card = cardOf(state, groupId, userId)
        const raw = card?.attrs?.[name]
        if (raw === undefined) return [0, false]
        return [Number(raw) || 0, true]
      },
      set: (groupId, userId, name, value) => {
        try {
          const { config, state } = readCardState()
          const card = cardOf(state, groupId, userId)
          if (!card) return false
          card.attrs ||= {}
          card.attrs[name] = Math.trunc(Number(value) || 0)
          this.sealWriteQueue = this.sealWriteQueue.then(() => this.diceManager.writeState(state, config)).catch(() => {})
          return true
        } catch {
          return false
        }
      }
    }
    runtime.run(source || "")
    this.sealRuntimes.set(key, runtime)
    return runtime
  }

  /** 海豹扩展命令分发：直接 .命令（无前缀），仅对启用该包的群生效 */
  async handleSealExtCommand(e) {
    const text = normalizeCommandText(e?.msg || "")
    if (!text.startsWith(".")) return { matched: false }
    const body = text.slice(1)
    const cmdName = String(body.split(/\s+/)[0] || "").toLowerCase()
    if (!cmdName) return { matched: false }
    const groupKey = String(e?.group_id || "private")
    for (const loaded of this.getActivePacks(groupKey)) {
      if (loaded.pack?.kind !== "seal-ext") continue
      const hasCommand = (loaded.pack.commands || []).some(command => String(command.id).toLowerCase() === cmdName)
      if (!hasCommand) continue
      const runtime = this.getSealRuntime(loaded.pack, loaded.record)
      if (!runtime.findCommand(cmdName)) continue
      const rawArgs = body.slice(cmdName.length).trim()
      const at = Array.isArray(e?.message)
        ? e.message.filter(seg => seg?.type === "at").map(seg => ({ userId: String(seg?.qq ?? seg?.data?.qq ?? "") , name: "" }))
        : []
      const userName = this.diceManager.getUserName?.(e) || String(e?.sender?.card || e?.sender?.nickname || e?.user_id || "")
      const result = runtime.dispatch(cmdName, {
        event: e,
        userId: String(e?.user_id || ""),
        userName,
        groupId: e?.group_id ? String(e.group_id) : "",
        isPrivate: !e?.group_id,
        args: rawArgs ? rawArgs.split(/\s+/).filter(Boolean) : [],
        kwargs: [],
        at,
        rawArgs,
        command: cmdName
      })
      if (!result.matched) continue
      const texts = []
      if (result.showHelp) {
        const help = runtime.listCommands().find(cmd => cmd.name === cmdName)?.help
        if (help) texts.push(help)
      }
      for (const reply of result.replies) texts.push(reply.text)
      if (result.error) texts.push(`（扩展执行出错：${result.error}）`)
      return { matched: true, text: texts.join("\n") || "（该命令没有产生输出）" }
    }
    return { matched: false }
  }

  async stageImport(source, actorId = "", options = {}) {
    if (looksLikeSealExtensionSource(source)) return this.stageSealExtImport(source, actorId, options)
    const isJs = looksLikeJsRuleSource(source)
    if (isJs && options.allowJs === false) {
      const blocked = { ok: false, pack: null, errors: ["$: JS 规则包当前没有启用（diceSystem.customJsRulesEnabled）"], warnings: [] }
      return { ...blocked, report: formatValidationReport(blocked) }
    }
    let jsLoaded = null
    let validation
    try {
      if (isJs) {
        jsLoaded = await loadJsRuleSource(source, { rulesDir: this.getRulesDir() })
        this.jsFunctionsCache.set(sha256(String(source)), { functions: jsLoaded.functions, packObject: jsLoaded.packObject })
      }
      validation = this.parseAndValidate(source, { jsPack: jsLoaded?.packObject || null, nameHint: String(options.nameHint || ""), extraFunctions: jsLoaded?.functionNames || [] })
    } catch (error) {
      const failed = { ok: false, pack: null, errors: [`$: ${error.message}`], warnings: [] }
      return { ...failed, report: formatValidationReport(failed) }
    }
    if (!validation.ok) return { ...validation, report: formatValidationReport(validation) }
    const pack = validation.pack
    // 自定义函数挂为非枚举属性：试掷可用，serializePack(JSON.stringify) 不会带出去
    if (jsLoaded && Object.keys(jsLoaded.functions).length) {
      Object.defineProperty(pack, "__functions", { value: jsLoaded.functions, enumerable: false, configurable: true })
    }
    let sample
    try {
      sample = this.buildDryRunPreview(pack)
    } catch (error) {
      const failed = { ...validation, ok: false, errors: [`preview: 无副作用试掷失败：${error.message}`] }
      return { ...failed, report: formatValidationReport(failed) }
    }
    const stageId = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`
    const sourceExt = jsLoaded ? `.${jsLoaded.ext}` : ".yaml"
    const sourceFile = path.join("pending", pack.id, `${stageId}${sourceExt}`)
    const normalizedFile = path.join("pending", pack.id, `${stageId}.json`)
    const sourceText = String(source)
    const normalizedText = serializePack(pack)
    const pending = {
      stageId,
      id: pack.id,
      actorId: String(actorId || ""),
      createdAt: Date.now(),
      nameHint: String(options.nameHint || ""),
      kind: jsLoaded ? "js" : "yaml",
      functionNames: jsLoaded ? jsLoaded.functionNames : [],
      sourceFile,
      normalizedFile,
      sourceHash: sha256(sourceText),
      normalizedHash: sha256(normalizedText)
    }
    const cleanup = []
    await this.mutateIndex(index => {
      for (const [id, item] of Object.entries(index.pending)) {
        if (Date.now() - Number(item.createdAt || 0) > PENDING_TTL_MS) {
          cleanup.push(item)
          delete index.pending[id]
        }
      }
      if (index.pending[pack.id]) cleanup.push(index.pending[pack.id])
      writeFileAtomic(this.resolveRulePath(sourceFile), sourceText)
      writeFileAtomic(this.resolveRulePath(normalizedFile), normalizedText)
      index.pending[pack.id] = pending
    })
    for (const item of cleanup) this.deletePendingArtifacts(item)
    return { ...validation, pending, sample, report: formatValidationReport(validation, pending, sample) }
  }

  async confirmImport(id, actorId = "") {
    const packId = normalizeText(id)
    let cleanup = null
    const result = await this.mutateIndex(async index => {
      const pending = index.pending[packId]
      if (!pending) throw new Error(`没有找到待确认规则包：${packId}`)
      if (Date.now() - Number(pending.createdAt || 0) > PENDING_TTL_MS) throw new Error(`规则包 ${packId} 的待确认导入已过期，请重新导入`)
      if (pending.actorId && String(pending.actorId) !== String(actorId || "")) throw new Error("只能由发起预检的主人确认本次导入")
      const source = fs.readFileSync(this.resolveRulePath(pending.sourceFile), "utf8")
      const normalized = fs.readFileSync(this.resolveRulePath(pending.normalizedFile), "utf8")
      verifyHash(source, pending.sourceHash, "待确认规则包源文件 ")
      verifyHash(normalized, pending.normalizedHash, "待确认规范化文件 ")
      if (pending.kind === "seal-ext") {
        const runtime = new SealExtRuntime({ packId: "recheck", logger: this.logger, statePath: path.join(this.getRulesDir(), "seal-ext-preview-state.json") })
        const runResult = runtime.run(source)
        if (!runResult.commands.length) throw new Error("待确认海豹扩展重新校验失败：没有注册命令")
        const pack = JSON.parse(normalized)
        if (pack.id !== packId) throw new Error(`待确认海豹扩展 ID 已改变：期望 ${packId}，实际 ${pack.id}`)
        const record = index.packages[packId] ||= { id: packId, name: pack.name, versions: [] }
        const version = Math.max(0, ...record.versions.map(item => Number(item.version) || 0)) + 1
        const sourceFile = path.join("packages", packId, `${version}.js`)
        const normalizedFile = path.join("packages", packId, `${version}.json`)
        writeFileAtomic(this.resolveRulePath(sourceFile), source)
        writeFileAtomic(this.resolveRulePath(normalizedFile), normalized)
        record.name = pack.name
        record.versions.push({
          id: packId,
          version,
          packageVersion: "1.0.0",
          createdAt: Date.now(),
          nameHint: String(pending.nameHint || ""),
          kind: "seal-ext",
          functionNames: [],
          sourceFile,
          normalizedFile,
          hash: sha256(source),
          normalizedHash: sha256(normalized)
        })
        delete index.pending[packId]
        cleanup = () => this.deletePendingArtifacts(pending)
        return `已导入海豹扩展 ${pack.name}（${packId}），命令：${pack.commands.map(command => "." + command.id).join("，")}。发送 .骰规则启用 ${packId} 后在本群生效。`
      }
      const isJs = pending.kind === "js"
      let jsLoaded = null
      if (isJs) {
        jsLoaded = await loadJsRuleSource(source, { rulesDir: this.getRulesDir() })
        this.jsFunctionsCache.set(sha256(source), { functions: jsLoaded.functions, packObject: jsLoaded.packObject })
        if (JSON.stringify(jsLoaded.functionNames) !== JSON.stringify(pending.functionNames || [])) {
          throw new Error("待确认 JS 规则包的自定义函数列表与预检时不一致")
        }
      }
      const validation = this.parseAndValidate(source, { jsPack: jsLoaded?.packObject || null, nameHint: String(pending.nameHint || ""), extraFunctions: jsLoaded?.functionNames || [] })
      if (!validation.ok) throw new Error(`待确认规则包重新校验失败：${validation.errors.slice(0, 3).join("；")}`)
      const pack = validation.pack
      if (pack.id !== packId) throw new Error(`待确认规则包 ID 已改变：期望 ${packId}，实际 ${pack.id}`)
      if (serializePack(pack) !== normalized) throw new Error("待确认规则包与规范化文件不一致")
      const record = index.packages[packId] ||= { id: packId, name: pack.name, versions: [] }
      const version = Math.max(0, ...record.versions.map(item => Number(item.version) || 0)) + 1
      const sourceFile = path.join("packages", packId, `${version}${isJs ? `.${jsLoaded.ext}` : ".yaml"}`)
      const normalizedFile = path.join("packages", packId, `${version}.json`)
      const normalizedText = serializePack(pack)
      writeFileAtomic(this.resolveRulePath(sourceFile), source)
      writeFileAtomic(this.resolveRulePath(normalizedFile), normalizedText)
      record.name = pack.name
      record.versions.push({
        id: packId,
        version,
        packageVersion: pack.compatibility?.package_version || "1.0.0",
        createdAt: Date.now(),
        nameHint: String(pending.nameHint || ""),
        kind: isJs ? "js" : "yaml",
        functionNames: jsLoaded ? jsLoaded.functionNames : [],
        sourceFile,
        normalizedFile,
        hash: sha256(source),
        normalizedHash: sha256(normalizedText)
      })
      cleanup = pending
      delete index.pending[packId]
      return { id: packId, name: pack.name, version, packageVersion: pack.compatibility?.package_version || "1.0.0", wantsGroupCard: pack.identity?.sync_group_card === true }
    })
    this.deletePendingArtifacts(cleanup)
    return result
  }

  listPackages() {
    const index = this.readIndex()
    return Object.values(index.packages).map(record => ({
      id: record.id,
      name: record.name,
      versions: record.versions.map(item => item.version),
      latestVersion: Math.max(0, ...record.versions.map(item => Number(item.version) || 0)),
      enabledGroups: Object.values(index.groups).filter(group => group?.active?.[record.id]).length
    }))
  }

  getVersionRecord(id, version = 0, index = this.readIndex()) {
    const record = index.packages[String(id || "")]
    if (!record) return null
    const selectedVersion = Number(version) || Math.max(0, ...record.versions.map(item => Number(item.version) || 0))
    return record.versions.find(item => Number(item.version) === selectedVersion) || null
  }

  loadPack(id, version = 0, index = this.readIndex()) {
    const record = this.getVersionRecord(id, version, index)
    if (!record) return null
    try {
      const sourcePath = this.resolveRulePath(record.sourceFile)
      const normalizedPath = this.resolveRulePath(record.normalizedFile)
      const sourceStat = fs.statSync(sourcePath)
      const normalizedStat = fs.statSync(normalizedPath)
      const cacheKey = `${id}@${record.version}`
      const fingerprint = `${record.hash || ""}:${record.normalizedHash || ""}:${sourceStat.size}:${sourceStat.mtimeMs}:${normalizedStat.size}:${normalizedStat.mtimeMs}`
      const cached = this.packCache.get(cacheKey)
      if (cached?.fingerprint === fingerprint) {
        this.packCache.delete(cacheKey)
        this.packCache.set(cacheKey, cached)
        return { pack: cached.pack, record }
      }
      const source = fs.readFileSync(sourcePath, "utf8")
      const normalized = fs.readFileSync(normalizedPath, "utf8")
      verifyHash(source, record.hash, "规则包源文件 ")
      verifyHash(normalized, record.normalizedHash, "规范化文件 ")
      if (record.kind === "seal-ext") {
        const pack = JSON.parse(normalized)
        if (!pack.kind || !Array.isArray(pack.commands)) throw new Error("海豹扩展包缺少 commands")
        const validatedPack = deepFreeze(pack)
        this.packCache.set(cacheKey, { fingerprint, pack: validatedPack })
        return { pack: validatedPack, record }
      }
      const isJs = record.kind === "js"
      let jsPackObject = null
      let jsFunctions = null
      if (isJs) {
        const warmed = this.jsFunctionsCache.get(record.hash) || null
        if (!warmed) {
          this.warmupJsPacks().catch(() => {})
          throw new Error("JS 规则包尚未预热完成，请几秒后重试")
        }
        jsFunctions = warmed.functions
        jsPackObject = warmed.packObject
      }
      const sourceValidation = this.parseAndValidate(source, { jsPack: jsPackObject, nameHint: String(record.nameHint || ""), extraFunctions: Object.keys(jsFunctions || {}) })
      if (!sourceValidation.ok) throw new Error(sourceValidation.errors.slice(0, 3).join("；"))
      const pack = JSON.parse(normalized)
      const validation = validateDiceRulePack(pack, { maxDiceCount: this.diceManager.getConfig().maxDiceCount, extraFunctions: Object.keys(jsFunctions || {}) })
      if (!validation.ok) throw new Error(validation.errors.slice(0, 3).join("；"))
      if (sourceValidation.pack.id !== id || validation.pack.id !== id) throw new Error("规则包 ID 与索引不一致")
      if (serializePack(sourceValidation.pack) !== serializePack(validation.pack)) throw new Error("规则包源文件与规范化文件不一致")
      if (isJs && jsFunctions && Object.keys(jsFunctions).length) {
        Object.defineProperty(validation.pack, "__functions", { value: jsFunctions, enumerable: false, configurable: true })
      }
      const validatedPack = deepFreeze(validation.pack)
      this.packCache.set(cacheKey, { fingerprint, pack: validatedPack })
      while (this.packCache.size > 100) this.packCache.delete(this.packCache.keys().next().value)
      return { pack: validatedPack, record }
    } catch (error) {
      this.logger?.warn?.(`[骰规则] 读取 ${id}@${record.version} 失败: ${error.message}`)
      throw new Error(`规则包 ${id}@${record.version} 文件损坏或丢失`)
    }
  }

  async enableForGroup(groupId, id, version = 0) {
    const gid = String(groupId || "")
    if (!gid) throw new Error("只能在群聊中启用规则包")
    const previewIndex = this.readIndex()
    const preview = this.loadPack(id, version, previewIndex)
    if (!preview) throw new Error(`没有找到规则包：${id}${version ? `@${version}` : ""}`)
    this.preflightGroupMigration(gid, preview.pack)
    return await this.mutateIndex(index => {
      const loaded = this.loadPack(id, version, index)
      if (!loaded) throw new Error(`没有找到规则包：${id}${version ? `@${version}` : ""}`)
      const group = index.groups[gid] ||= { active: {} }
      group.active ||= {}
      const prefixes = new Set([loaded.pack.id, ...loaded.pack.aliases].map(alias => alias.toLowerCase()))
      for (const [activeId, activeVersion] of Object.entries(group.active)) {
        if (activeId === id) continue
        const other = this.loadPack(activeId, activeVersion, index)
        if (!other) continue
        const conflict = [other.pack.id, ...other.pack.aliases].find(alias => prefixes.has(alias.toLowerCase()))
        if (conflict) throw new Error(`前缀 ${conflict} 已被规则包 ${activeId} 使用`)
      }
      group.active[id] = loaded.record.version
      return { id, name: loaded.pack.name, version: loaded.record.version }
    })
  }

  async disableForGroup(groupId, id) {
    const gid = String(groupId || "")
    if (!gid) throw new Error("只能在群聊中禁用规则包")
    return await this.mutateIndex(index => {
      if (!index.groups[gid]?.active?.[id]) throw new Error(`当前群没有启用规则包：${id}`)
      delete index.groups[gid].active[id]
      return { id }
    })
  }

  async rollbackForGroup(groupId, id, version) {
    return await this.enableForGroup(groupId, id, Number(version))
  }

  preflightGroupMigration(groupId, pack) {
    const config = this.diceManager.getConfig()
    const state = this.diceManager.readState(config)
    const gid = String(groupId)
    for (const user of Object.values(state.users || {})) {
      for (const card of Object.values(user?.cards || {})) {
        const root = card?.ruleData?.[pack.id]
        const stored = root?._scopeVersion === 2 ? root.groups?.[gid] : root
        if (stored) this.applyMigration(pack, stored, { card: card.name || "", nickname: card.name || "" })
      }
    }
    const ruleState = state.groups?.[gid]?.diceRuleSessions?.[pack.id]
    if (ruleState?.group) this.applyMigration(pack, ruleState.group, { card: "", nickname: "" }, { scope: "group" })
    for (const npc of Object.values(ruleState?.npcs || {})) {
      if (npc?.ruleData) this.applyMigration(pack, npc.ruleData, { card: npc.name || "", nickname: npc.name || "" })
    }
    return true
  }

  async archivePackage(id) {
    const packId = normalizeText(id)
    let cleanup = null
    let sourceDir = ""
    let archiveDir = ""
    let moved = false
    try {
      const result = await this.mutateIndex(index => {
        const record = index.packages[packId]
        if (!record) throw new Error(`没有找到规则包：${packId}`)
        let affectedGroups = 0
        for (const group of Object.values(index.groups)) {
          if (group?.active?.[packId]) {
            delete group.active[packId]
            affectedGroups += 1
          }
        }
        sourceDir = path.join(this.getRulesDir(), "packages", packId)
        if (fs.existsSync(sourceDir)) {
          archiveDir = path.join(this.getRulesDir(), "archived", `${packId}-${Date.now()}`)
          ensureDir(path.dirname(archiveDir))
          writeFileAtomic(path.join(sourceDir, "archive-manifest.json"), JSON.stringify({ archivedAt: Date.now(), record }, null, 2))
          fs.renameSync(sourceDir, archiveDir)
          moved = true
        }
        delete index.packages[packId]
        cleanup = index.pending[packId]
        delete index.pending[packId]
        return { id: packId, affectedGroups }
      })
      for (const key of [...this.packCache.keys()]) if (key.startsWith(`${packId}@`)) this.packCache.delete(key)
      this.deletePendingArtifacts(cleanup)
      return result
    } catch (error) {
      try {
        if (moved && fs.existsSync(archiveDir) && !fs.existsSync(sourceDir)) fs.renameSync(archiveDir, sourceDir)
        if (sourceDir) fs.rmSync(path.join(sourceDir, "archive-manifest.json"), { force: true })
      } catch (rollbackError) {
        throw new Error(`${error.message}；归档回滚也失败：${rollbackError.message}`)
      }
      throw error
    }
  }

  async restoreArchivedPackage(id) {
    const packId = normalizeText(id)
    let archiveDir = ""
    let targetDir = ""
    let moved = false
    try {
      const result = await this.mutateIndex(index => {
        if (index.packages[packId]) throw new Error(`规则包已经存在：${packId}`)
        const archiveRoot = path.join(this.getRulesDir(), "archived")
        const candidates = fs.existsSync(archiveRoot)
          ? fs.readdirSync(archiveRoot).filter(name => name.startsWith(`${packId}-`)).sort().reverse()
          : []
        const selected = candidates.find(name => fs.existsSync(path.join(archiveRoot, name, "archive-manifest.json")))
        if (!selected) throw new Error(`没有找到可恢复的归档规则包：${packId}`)
        archiveDir = path.join(archiveRoot, selected)
        const manifest = JSON.parse(fs.readFileSync(path.join(archiveDir, "archive-manifest.json"), "utf8"))
        if (manifest?.record?.id !== packId || !Array.isArray(manifest.record.versions)) throw new Error("归档清单损坏")
        targetDir = path.join(this.getRulesDir(), "packages", packId)
        if (fs.existsSync(targetDir)) throw new Error(`规则包目录已经存在：${packId}`)
        ensureDir(path.dirname(targetDir))
        fs.renameSync(archiveDir, targetDir)
        moved = true
        index.packages[packId] = manifest.record
        return { id: packId, name: manifest.record.name || packId, versions: manifest.record.versions.map(item => item.version) }
      })
      fs.rmSync(path.join(targetDir, "archive-manifest.json"), { force: true })
      return result
    } catch (error) {
      try {
        if (moved && fs.existsSync(targetDir) && !fs.existsSync(archiveDir)) fs.renameSync(targetDir, archiveDir)
      } catch (rollbackError) {
        throw new Error(`${error.message}；恢复回滚也失败：${rollbackError.message}`)
      }
      throw error
    }
  }

  getExportFile(id, version = 0) {
    const loaded = this.loadPack(id, version)
    const file = loaded ? this.resolveRulePath(loaded.record.sourceFile) : ""
    if (!loaded || !fs.existsSync(file)) throw new Error(`没有找到可导出的规则包：${id}${version ? `@${version}` : ""}`)
    return { file, record: loaded.record }
  }

  /** 规则包详情：一级规则（命令）后面必须跟它的二级规则（参数/分支/掷骰），
   * 分支下再列三级内容（动作/输出），每一级都展开，不留"看不见的子规则" */
  describePackage(id, version = 0) {
    const loaded = this.loadPack(id, version)
    if (!loaded) throw new Error(`没有找到规则包：${id}`)
    const pack = loaded.pack
    const commands = Array.isArray(pack.commands) ? pack.commands : []
    const kindLabel = loaded.record.kind === "seal-ext" ? "海豹 JS 扩展" : loaded.record.kind === "js" ? "JS 规则包" : "YAML 声明式"
    const lines = [
      `## ${pack.name}（${pack.id}@${loaded.record.version}）`,
      "",
      String(pack.description || "无说明"),
      "",
      "| 包版本 | 前缀 | 类型 | 命令数 |",
      "| --- | --- | --- | --- |",
      `| ${pack.compatibility?.package_version || "1.0.0"} | ${(pack.aliases || []).join("、") || "无"} | ${kindLabel} | ${commands.length} |`
    ]

    // seal-ext：从沙箱运行时取每个命令注册时声明的帮助文本（包清单里没存）
    let sealHelp = new Map()
    if (loaded.record.kind === "seal-ext") {
      try {
        sealHelp = new Map(this.getSealRuntime(pack, loaded.record).listCommands().map(cmd => [cmd.name, cmd.help]))
      } catch {}
    }

    lines.push("", `### 命令（一级规则 · ${commands.length} 条）`)
    const prefix = pack.aliases?.[0] || pack.id
    for (const command of commands) {
      const extraAliases = (command.aliases || []).filter(alias => alias !== command.id)
      const title = loaded.record.kind === "seal-ext"
        ? `.${command.id}`
        : `.${prefix} ${command.id}`
      const tags = []
      // seal-ext 的 label 常以命令名开头（"dd（可代骰）"），去掉重复的命令名只留修饰
      const label = String(command.label || "")
      const shortLabel = label.startsWith(command.id) ? label.slice(command.id.length).replace(/^[（(]|[）)]$/g, "").trim() : label
      if (shortLabel) tags.push(shortLabel)
      if (extraAliases.length) tags.push(`别名 ${extraAliases.join("/")}`)
      if (command.permission && command.permission !== "all") tags.push(`权限 ${command.permission}`)
      if (command.visibility && command.visibility !== "public") tags.push(command.visibility === "private" ? "结果私发" : `可见性 ${command.visibility}`)
      lines.push("", `#### ${title}${tags.length ? `（${tags.join(" · ")}）` : ""}`)
      if (command.description) lines.push(command.description)

      if (loaded.record.kind === "seal-ext") {
        const help = String(sealHelp.get(command.id) || "").trim()
        lines.push(...(help ? compactSealHelp(help) : ["（无帮助文本；直接发送该命令试试）"]))
        continue
      }

      // 二级规则：参数
      const args = Array.isArray(command.arguments) ? command.arguments : []
      if (args.length) {
        lines.push("", `参数（二级规则 · ${args.length} 个）：`, "", "| 参数 | 类型 | 必填 | 默认 | 说明 |", "| --- | --- | --- | --- | --- |")
        for (const arg of args) {
          const note = [arg.description, Array.isArray(arg.enum) ? `可选：${arg.enum.join("/")}` : ""].filter(Boolean).join("；")
          lines.push(`| ${arg.rest ? "…" : ""}${arg.id} | ${arg.type || "string"}${arg.multiple ? "（可多个）" : ""} | ${arg.required ? "是" : "否"} | ${arg.default ?? "—"} | ${note || "—"} |`)
        }
      }

      // 二级规则：命名掷骰 / 抽表 / 对抗
      const rolls = Object.entries(command.rolls || {})
      if (rolls.length) lines.push("", `掷骰（二级规则）：${rolls.map(([rollId, expr]) => `${rollId}=${expr}`).join("，")}`)
      const draws = Object.entries(command.draws || {})
      if (draws.length) lines.push("", `抽表（二级规则）：${draws.map(([drawId, tableId]) => `${drawId}←${tableId}`).join("，")}`)
      if (command.opposed) lines.push("", `对抗（二级规则）：${command.opposed.actor || "?"} vs ${command.opposed.target || "?"}`)

      // 二级规则：分支（每个分支下再列三级动作/输出）
      const branches = Array.isArray(command.branches) ? command.branches : []
      if (branches.length) {
        lines.push("", `分支（二级规则 · ${branches.length} 个，自上而下取第一个命中的）：`)
        branches.forEach((branch, index) => {
          const name = branch.result ? `「${branch.result}」` : branch.when === undefined ? "「默认」" : `「分支${index + 1}」`
          const cond = branch.when === undefined ? "其余情况" : `当 ${branch.when}`
          lines.push(`- ${name}${cond}`)
          // 三级：条件分支内的动作与输出
          const actions = Array.isArray(branch.actions) ? branch.actions : []
          if (actions.length) lines.push(`  - 动作（三级）：${actions.slice(0, 4).map(summarizeRuleAction).join("；")}${actions.length > 4 ? ` 等${actions.length}个` : ""}`)
          if (branch.output) lines.push(`  - 输出（三级）：${firstTemplateLine(branch.output)}`)
        })
      }
      const commandActions = Array.isArray(command.actions) ? command.actions : []
      if (commandActions.length) lines.push("", `命令动作（三级）：${commandActions.slice(0, 4).map(summarizeRuleAction).join("；")}${commandActions.length > 4 ? ` 等${commandActions.length}个` : ""}`)

      if (!args.length && !branches.length && !rolls.length && !draws.length && !command.opposed && !commandActions.length && !command.description) {
        lines.push("（无二级规则，发送即触发）")
      }
    }

    // 同样挂在包下的其它规则集合
    const collections = [
      ["随机表", Object.keys(pack.tables || {})],
      ["自定义骰", Object.keys(pack.dice_sets || {})],
      ["状态", Object.keys(pack.statuses || {})],
      ["物品", Object.keys(pack.items || {})],
      ["能力", Object.keys(pack.abilities || {})],
      ["事件", Object.keys(pack.events || {})],
      ["输出模板", Object.keys(pack.templates || {})],
      ["人物卡字段", Object.keys(pack.character?.fields || {})]
    ].filter(([, keys]) => keys.length)
    if (collections.length) {
      lines.push("", "### 其它所属规则", "")
      for (const [label, keys] of collections) lines.push(`- ${label}（${keys.length}）：${keys.join("、")}`)
    }
    return lines.join("\n")
  }

  previewPackage(id) {
    const packId = normalizeText(id)
    const index = this.readIndex()
    const pending = index.pending[packId]
    if (pending) {
      try {
        const source = fs.readFileSync(this.resolveRulePath(pending.sourceFile), "utf8")
        const normalized = fs.readFileSync(this.resolveRulePath(pending.normalizedFile), "utf8")
        verifyHash(source, pending.sourceHash, "待确认 YAML ")
        verifyHash(normalized, pending.normalizedHash, "待确认规范化文件 ")
        const validation = this.parseAndValidate(source, { nameHint: String(pending.nameHint || "") })
        if (validation.ok && serializePack(validation.pack) !== normalized) throw new Error("待确认 YAML 与规范化文件不一致")
        const sample = validation.ok ? this.buildDryRunPreview(validation.pack) : ""
        return formatValidationReport(validation, pending, sample)
      } catch (error) {
        throw new Error(`待确认规则包 ${packId} 文件损坏或丢失：${error.message}`)
      }
    }
    return this.describePackage(packId)
  }

  /** 单个包的命令速览：seal-ext 直发命令；声明式包给前缀入口 */
  packCommandSummary(pack, kind = "yaml") {
    if (kind === "seal-ext") {
      const names = (pack.commands || []).map(command => "." + String(command.id || "")).filter(Boolean)
      return names.slice(0, 10).join(" · ") + (names.length > 10 ? ` 等${names.length}个` : "")
    }
    const names = (pack.commands || []).map(command => `.${pack.aliases?.[0] || pack.id} ${command.aliases?.[0] || command.id}`).filter(Boolean)
    return names.slice(0, 10).join(" · ") + (names.length > 10 ? ` 等${names.length}个` : "")
  }

  /** 规则包入口提示：告诉用户第一发什么能马上看到效果 */
  packEntryHint(pack, kind = "seal-ext") {
    if (kind === "seal-ext") {
      const first = (pack.commands || [])[0]?.id
      return first ? `发 .${first} help 看该命令用法；.dice help 末尾也有本群包速览` : ""
    }
    return `发 .${pack.aliases?.[0] || pack.id} 看完整命令菜单`
  }

  listText(groupId = "") {
    const index = this.readIndex()
    const active = index.groups[String(groupId || "")]?.active || {}
    const records = Object.values(index.packages)
    if (!records.length) return "还没有导入任何自定义规则包。\n导入方式：网页命令管理页拖入文件，或群里发文件并引用它发送 .骰规则导入。"
    const lines = [
      `自定义骰娘规则包（${records.length} 个）——id 就是下表括号里的字母名`,
      "",
      "| 规则包 | 本群状态 | 命令 | 看用法 |",
      "| --- | --- | --- | --- |"
    ]
    for (const record of records) {
      const activeVersion = active[record.id]
      const latest = record.versions[record.versions.length - 1] || {}
      let pack = null
      try {
        pack = this.loadPack(record.id, activeVersion || 0, index)?.pack
      } catch {}
      const commands = pack ? this.packCommandSummary(pack, latest.kind).replace(/ · /g, " ") : "—"
      const usage = pack ? (this.packEntryHint(pack, latest.kind).split("；")[0] || "—") : "—"
      const status = activeVersion ? "已启用" : `未启用 · 发送 .骰规则启用 ${record.id}`
      lines.push(`| ${record.name}（${record.id}） | ${status} | ${commands} | ${usage} |`)
    }
    const firstId = records[0]?.id || "包id"
    const tryCommand = (() => {
      for (const record of records) {
        const kind = record.versions[record.versions.length - 1]?.kind
        const activeVersion = active[record.id]
        try {
          const pack = this.loadPack(record.id, activeVersion || 0, index)?.pack
          const cmd = this.packCommandSummary(pack, kind).split(" ")[0].replace(/^·\s*/, "")
          if (!cmd || cmd === "—") continue
          // seal-ext 直发命令带 help 看用法；YAML 发前缀直接出命令菜单
          return kind === "seal-ext" ? `${cmd} help` : cmd
        } catch {}
      }
      return ""
    })()
    lines.push("", `### 快速上手`, "")
    lines.push(`- 启用：.骰规则启用 ${firstId}（id 就是上表括号里的字母名）`)
    lines.push(tryCommand ? `- 试用：启用后直接发 ${tryCommand} 试试` : "- 试用：启用后发上表「命令」列里的命令")
    lines.push(`- 看全部规则：.骰规则查看 ${firstId}（命令 → 参数 → 分支逐级列出）`)
    lines.push("- 停用：.骰规则禁用 包id（人物卡数据保留）；本群速览：.dice help")
    return lines.join("\n")
  }

  /** 启用后的入口提示（按本群激活版本的类型给真实可用命令） */
  packEntryHintForGroup(groupId, id) {
    const index = this.readIndex()
    const version = index.groups[String(groupId || "")]?.active?.[String(id || "")]
    if (!version) return ""
    const loaded = this.loadPack(id, version, index)
    if (!loaded) return ""
    const kind = this.getVersionRecord(id, version, index)?.kind
    return this.packEntryHint(loaded.pack, kind)
  }

  /** 帮助用的本群包速览（一段紧凑文本） */
  activePacksHelpText(groupId = "") {
    const loaded = this.getActivePacks(groupId)
    if (!loaded.length) return ""
    return loaded.map(({ pack, record }) => {
      const kind = record?.kind
      const commands = this.packCommandSummary(pack, kind)
      return `◆ 规则包 ${pack.name}：${commands}`
    }).join("\n")
  }

  getActivePacks(groupId) {
    const index = this.readIndex()
    const active = index.groups[String(groupId || "")]?.active || {}
    const result = []
    for (const [id, version] of Object.entries(active)) {
      const loaded = this.loadPack(id, version, index)
      if (loaded) result.push(loaded)
    }
    return result
  }

  findInvocation(groupId, message) {
    const text = normalizeCommandText(message)
    if (!text.startsWith(".")) return null
    const body = text.slice(1)
    for (const loaded of this.getActivePacks(groupId)) {
      const prefix = matchTextAlias(body, [loaded.pack.id, ...loaded.pack.aliases])
      if (!prefix) continue
      return { ...loaded, rest: prefix.rest, prefix: prefix.alias }
    }
    return null
  }

  buildPersistentValues(pack, stored, sender) {
    const values = stored && typeof stored.values === "object" && stored.values ? { ...stored.values } : {}
    const fields = pack.character?.fields || {}
    for (const [id, definition] of Object.entries(fields)) {
      if (definition.formula !== undefined) continue
      if (definition.persistent === false) {
        delete values[id]
        if (definition.default !== undefined) values[id] = resolveDefaultValue(definition.default, sender)
        continue
      }
      if (!Object.prototype.hasOwnProperty.call(values, id) && definition.default !== undefined) values[id] = resolveDefaultValue(definition.default, sender)
    }
    return values
  }

  buildStoredValues(pack, values) {
    const stored = { ...(values || {}) }
    for (const [id, definition] of Object.entries(pack.character?.fields || {})) {
      if (definition.persistent === false) delete stored[id]
    }
    return stored
  }

  applyMigration(pack, stored, sender, { scope = "character" } = {}) {
    const current = stored && typeof stored === "object" ? { ...stored, values: { ...(stored.values || {}) } } : { values: {} }
    const targetVersion = pack.compatibility?.package_version || "1.0.0"
    let version = current._packageVersion
    if (version && version !== targetVersion) {
      const visited = new Set()
      while (version !== targetVersion) {
        if (visited.has(version)) throw new Error(`规则数据迁移存在循环：${[...visited, version].join(" -> ")}`)
        visited.add(version)
        const migration = (pack.compatibility?.migrations || []).find(item => item.from === version)
        if (!migration) throw new Error(`规则数据仍是 ${version}，但 ${targetVersion} 没有从该版本出发的迁移；已停止访问，原数据未改写`)
        const rename = scope === "group" ? migration.rename_group_fields : migration.rename_fields
        const defaults = scope === "group" ? migration.add_group_defaults : migration.add_defaults
        for (const [oldId, newId] of Object.entries(rename || {})) {
          if (Object.prototype.hasOwnProperty.call(current.values, oldId) && !Object.prototype.hasOwnProperty.call(current.values, newId)) current.values[newId] = current.values[oldId]
          delete current.values[oldId]
        }
        for (const [id, value] of Object.entries(defaults || {})) {
          if (!Object.prototype.hasOwnProperty.call(current.values, id)) current.values[id] = value
        }
        version = migration.to || targetVersion
        if (visited.size > 20) throw new Error("规则数据迁移步骤超过 20，已停止访问")
      }
    }
    if (scope === "character") current.values = this.buildPersistentValues(pack, current, sender)
    current._packageVersion = targetVersion
    return current
  }

  evaluate(source, context, pack, { allowDice = false, remainingDice = null, random = this.random || secureDiceRandom } = {}) {
    return evaluateDiceRuleExpression(typeof source === "string" ? source : String(source), context, {
      diceSets: pack.dice_sets || {},
      rollStandard: expression => this.diceManager.rollExpression(expression, this.diceManager.getConfig(), random),
      random,
      customFunctions: pack.__functions || null,
      maxDiceCount: remainingDice ?? pack.limits?.max_dice_count ?? this.diceManager.getConfig().maxDiceCount,
      maxLength: pack.limits?.max_expression_length || 512
    })
  }

  computeDerived(pack, attr, extraContext = {}, fields = pack.character?.fields || {}) {
    const derived = {}
    const visiting = new Set()
    const resolve = id => {
      if (Object.prototype.hasOwnProperty.call(derived, id)) return derived[id]
      const definition = fields[id]
      if (!definition || definition.formula === undefined) throw new Error(`未知派生字段 ${id}`)
      if (visiting.has(id)) throw new Error(`派生字段循环依赖：${[...visiting, id].join(" -> ")}`)
      visiting.add(id)
      const proxy = new Proxy(derived, {
        get: (target, key) => typeof key === "string" && !Object.prototype.hasOwnProperty.call(target, key) && fields[key]?.formula !== undefined ? resolve(key) : target[key],
        has: (target, key) => Object.prototype.hasOwnProperty.call(target, key) || fields[key]?.formula !== undefined,
        getOwnPropertyDescriptor: (target, key) => Object.prototype.hasOwnProperty.call(target, key)
          ? Object.getOwnPropertyDescriptor(target, key)
          : fields[key]?.formula !== undefined ? { enumerable: true, configurable: true, value: resolve(key) } : undefined
      })
      const value = this.evaluate(definition.formula, { ...extraContext, attr, derived: proxy }, pack, { random: extraContext.__random || this.random || secureDiceRandom }).value
      visiting.delete(id)
      derived[id] = validateFieldValue(value, definition, `derived.${id}`)
      return derived[id]
    }
    for (const [id, definition] of Object.entries(fields)) if (definition.formula !== undefined) resolve(id)
    return derived
  }

  buildGroupStored(pack, ruleState, sender) {
    const definitions = pack.group?.fields || {}
    const stored = this.applyMigration(pack, ruleState.group, sender, { scope: "group" })
    for (const [id, definition] of Object.entries(definitions)) {
      if (definition.formula !== undefined) continue
      if (definition.persistent === false) {
        delete stored.values[id]
        if (definition.default !== undefined) stored.values[id] = resolveDefaultValue(definition.default, sender)
      } else if (!Object.prototype.hasOwnProperty.call(stored.values, id) && definition.default !== undefined) {
        stored.values[id] = resolveDefaultValue(definition.default, sender)
      }
    }
    return stored
  }

  buildInventoryContext(pack, stored) {
    const inventory = stored?.inventory || {}
    const result = {}
    for (const id of Object.keys(pack.items || {})) {
      const current = inventory[id] || {}
      result[id] = { quantity: Math.max(0, Number(current.quantity) || 0), equipped: Boolean(current.equipped) }
    }
    return result
  }

  buildAbilityContext(pack, stored) {
    const abilities = stored?.abilities || {}
    const result = {}
    for (const id of Object.keys(pack.abilities || {})) {
      const current = abilities[id] || {}
      result[id] = {
        learned: Boolean(current.learned),
        rank: Math.max(0, Number(current.rank) || 0),
        cooldown: Math.max(0, Number(current.cooldown) || 0),
        uses: Math.max(0, Number(current.uses) || 0)
      }
    }
    return result
  }

  getEntityDraft(state, e, pack, ruleState, actor) {
    const sender = { card: actor.name || "", nickname: actor.name || "" }
    let container
    let cardName = actor.name || actor.id
    if (actor.kind === "npc") {
      const npc = ruleState.npcs?.[actor.id]
      if (!npc) throw new Error(`NPC 不存在：${actor.id}`)
      container = npc
      cardName = npc.name || actor.id
    } else {
      const targetEvent = {
        ...e,
        user_id: actor.id,
        sender: { ...(e?.sender || {}), user_id: actor.id, card: actor.name || "", nickname: actor.name || actor.id, role: actor.role || "member" }
      }
      const user = this.diceManager.ensureUser(state, targetEvent)
      const card = user.cards[user.activeCard]
      card.ruleData ||= {}
      const groupId = String(e?.group_id || "")
      let root = card.ruleData[pack.id]
      if (!root || root._scopeVersion !== 2) {
        root = {
          _scopeVersion: 2,
          groups: root && typeof root === "object" ? { [groupId]: root } : {},
          migratedAt: new Date().toISOString()
        }
        card.ruleData[pack.id] = root
      }
      root.groups ||= {}
      container = {
        get ruleData() { return root.groups[groupId] },
        set ruleData(value) { root.groups[groupId] = value }
      }
      cardName = card.name || user.activeCard || actor.name || actor.id
    }
    const original = actor.kind === "npc" ? container.ruleData : container.ruleData
    const stored = this.applyMigration(pack, original, sender)
    stored.statuses = { ...(stored.statuses || {}) }
    stored.inventory = { ...(stored.inventory || {}) }
    stored.abilities = { ...(stored.abilities || {}) }
    const attr = { ...stored.values }
    const inventory = this.buildInventoryContext(pack, stored)
    const abilities = this.buildAbilityContext(pack, stored)
    return {
      key: actorStorageKey(actor),
      actor: { ...actor, name: cardName },
      container,
      original,
      stored,
      attr,
      inventory,
      abilities,
      commit: value => {
        if (actor.kind === "npc") container.ruleData = value
        else container.ruleData = value
      }
    }
  }

  describeDraft(pack, draft, shared, session, random) {
    const derived = this.computeDerived(pack, draft.attr, { shared, inventory: draft.inventory, abilities: draft.abilities, session, __random: random })
    return {
      id: draft.actor.id,
      name: draft.actor.name,
      kind: draft.actor.kind,
      attr: draft.attr,
      derived,
      statuses: draft.stored.statuses || {},
      inventory: draft.inventory,
      abilities: draft.abilities
    }
  }

  async parseArguments(command, raw, e, ruleState) {
    const tokens = parseQuotedTokens(raw)
    const result = {}
    let cursor = 0
    for (const definition of command.arguments || []) {
      if (definition.type === "actor") {
        const allowed = definition.allowed || ["self"]
        const rawValues = definition.multiple === true
          ? tokens.slice(cursor)
          : tokens[cursor] === undefined ? [] : [tokens[cursor]]
        cursor += definition.multiple === true ? rawValues.length : rawValues.length ? 1 : 0
        if (!rawValues.length) {
          if (definition.required) throw new Error(`缺少参数：${definition.label || definition.id}`)
          if (allowed.includes("self")) result[definition.id] = definition.multiple ? [await resolveRuleActor(e, "self", ruleState, allowed)] : await resolveRuleActor(e, "self", ruleState, allowed)
          continue
        }
        const actors = []
        for (const token of rawValues) {
          const actor = await resolveRuleActor(e, token, ruleState, allowed)
          if (!actors.some(item => actorStorageKey(item) === actorStorageKey(actor))) actors.push(actor)
        }
        result[definition.id] = definition.multiple ? actors : actors[0]
        continue
      }
      let rawValue
      if (definition.rest) {
        rawValue = tokens.slice(cursor).join(" ")
        cursor = tokens.length
      } else rawValue = tokens[cursor++]
      if (rawValue === undefined || rawValue === "") {
        if (definition.required) throw new Error(`缺少参数：${definition.label || definition.id}`)
        if (definition.default !== undefined) result[definition.id] = definition.default
        continue
      }
      const value = convertInputValue(rawValue, definition, `arg.${definition.id}`)
      if (["integer", "number"].includes(definition.type)) {
        if (definition.min !== undefined && value < definition.min) throw new Error(`${definition.label || definition.id} 不能小于 ${definition.min}`)
        if (definition.max !== undefined && value > definition.max) throw new Error(`${definition.label || definition.id} 不能大于 ${definition.max}`)
      }
      result[definition.id] = value
    }
    if (cursor < tokens.length) throw new Error(`多余参数：${tokens.slice(cursor).join(" ")}`)
    return result
  }

  refreshRuleContext(pack, runtime, targetDraft = null, status = null) {
    const shared = runtime.groupStored.values
    const session = runtime.ruleState.session
    const actor = this.describeDraft(pack, runtime.actorDraft, shared, session, runtime.random)
    const target = targetDraft ? this.describeDraft(pack, targetDraft, shared, session, runtime.random) : runtime.defaultTarget
    runtime.context.attr = actor.attr
    runtime.context.derived = actor.derived
    runtime.context.inventory = actor.inventory
    runtime.context.abilities = actor.abilities
    runtime.context.shared = shared
    runtime.context.session = session
    runtime.context.target = target || null
    runtime.context.status = status || null
    return { actor, target }
  }

  getActionDrafts(action, runtime) {
    const scope = action.scope || "actor"
    if (scope === "actor") return [runtime.actorDraft]
    if (scope === "group") return [{
      key: "group",
      actor: { kind: "group", id: String(runtime.context.group.id), name: "群共享状态" },
      attr: runtime.groupStored.values,
      stored: runtime.groupStored,
      inventory: {},
      group: true
    }]
    const value = runtime.args[action.target]
    const actors = Array.isArray(value) ? value : value ? [value] : []
    if (!actors.length) throw new Error(`目标参数 ${action.target} 为空`)
    return actors.map(actor => {
      const draft = runtime.entityDrafts.get(actorStorageKey(actor))
      if (!draft) throw new Error(`目标状态没有加载：${actor.name || actor.id}`)
      return draft
    })
  }

  evaluateActionValue(source, pack, runtime, targetDraft, options = {}) {
    this.refreshRuleContext(pack, runtime, targetDraft?.group ? null : targetDraft, options.status)
    return this.evaluate(source, runtime.context, pack, { ...options, random: runtime.random }).value
  }

  applyValueAction(pack, action, runtime, draft, options = {}) {
    const fields = draft.group ? pack.group?.fields || {} : pack.character?.fields || {}
    const definition = fields[action.field]
    if (!definition || definition.formula !== undefined) throw new Error(`字段 ${action.field} 不可写入`)
    const before = draft.attr[action.field]
    if (action.op === "clear") {
      delete draft.attr[action.field]
      if (definition.default !== undefined) draft.attr[action.field] = resolveDefaultValue(definition.default, { card: draft.actor.name, nickname: draft.actor.name })
    } else if (action.op === "clamp") {
      const min = Number(this.evaluateActionValue(action.min, pack, runtime, draft, options))
      const max = Number(this.evaluateActionValue(action.max, pack, runtime, draft, options))
      if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) throw new Error(`字段 ${action.field} 的 clamp 范围无效`)
      draft.attr[action.field] = Math.min(max, Math.max(min, Number(before)))
    } else {
      const value = this.evaluateActionValue(action.value, pack, runtime, draft, options)
      if (action.op === "set") draft.attr[action.field] = value
      else if (action.op === "add") draft.attr[action.field] = Number(before) + Number(value)
      else if (action.op === "subtract") draft.attr[action.field] = Number(before) - Number(value)
      else if (action.op === "min") draft.attr[action.field] = Math.min(Number(before), Number(value))
      else if (action.op === "max") draft.attr[action.field] = Math.max(Number(before), Number(value))
    }
    validateFieldValue(draft.attr[action.field], definition, `${draft.group ? "shared" : "attr"}.${action.field}`)
    if (!draft.group) draft.stored.values = this.buildStoredValues(pack, draft.attr)
    return { before, after: draft.attr[action.field] }
  }

  async applyStatusAction(pack, action, runtime, draft, depth) {
    if (draft.group) throw new Error("状态不能作用于群共享字段")
    const definition = pack.statuses?.[action.status]
    if (!definition) throw new Error(`未知状态 ${action.status}`)
    draft.stored.statuses ||= {}
    const previous = draft.stored.statuses[action.status] ? { ...draft.stored.statuses[action.status] } : null
    if (action.op === "remove_status") {
      if (previous && definition.on_expire?.length) {
        await this.applyActionList(pack, definition.on_expire, { ...runtime, actorDraft: draft }, depth + 1, { status: { id: action.status, ...previous } })
      }
      delete draft.stored.statuses[action.status]
      return { before: previous, after: null }
    }
    const stacks = Math.max(1, Math.trunc(Number(action.stacks === undefined ? 1 : this.evaluateActionValue(action.stacks, pack, runtime, draft))))
    const durationSource = action.duration ?? definition.default_duration
    const duration = durationSource === undefined ? null : Math.max(1, Math.trunc(Number(this.evaluateActionValue(durationSource, pack, runtime, draft))))
    const maxStacks = Math.max(1, Number(definition.max_stacks) || 1)
    const current = {
      stacks: Math.min(maxStacks, Math.max(0, Number(previous?.stacks) || 0) + stacks),
      duration: duration ?? previous?.duration ?? null,
      appliedAt: previous?.appliedAt || new Date().toISOString(),
      source: runtime.actorDraft.actor.id
    }
    draft.stored.statuses[action.status] = current
    if (definition.on_apply?.length) {
      await this.applyActionList(pack, definition.on_apply, { ...runtime, actorDraft: draft }, depth + 1, { status: { id: action.status, ...current } })
    }
    return { before: previous, after: { ...current } }
  }

  applyItemAction(pack, action, runtime, draft) {
    if (draft.group) throw new Error("物品不能作用于群共享字段")
    const definition = pack.items?.[action.item]
    if (!definition) throw new Error(`未知物品 ${action.item}`)
    draft.stored.inventory ||= {}
    const previous = draft.stored.inventory[action.item] ? { ...draft.stored.inventory[action.item] } : { quantity: 0, equipped: false }
    const current = { ...previous }
    if (["add_item", "remove_item"].includes(action.op)) {
      const quantity = Math.max(1, Math.trunc(Number(action.quantity === undefined ? 1 : this.evaluateActionValue(action.quantity, pack, runtime, draft))))
      current.quantity += action.op === "add_item" ? quantity : -quantity
      if (current.quantity < 0) throw new Error(`${definition.label || action.item} 数量不足`)
      const max = definition.stackable === false ? 1 : Math.max(1, Number(definition.max_quantity) || 1000000)
      if (current.quantity > max) throw new Error(`${definition.label || action.item} 数量不能超过 ${max}`)
      if (current.quantity === 0) current.equipped = false
    } else if (action.op === "equip") {
      if (current.quantity < 1) throw new Error(`没有可装备的 ${definition.label || action.item}`)
      if (definition.slot) {
        for (const [itemId, itemState] of Object.entries(draft.stored.inventory)) {
          if (itemId !== action.item && itemState?.equipped && pack.items?.[itemId]?.slot === definition.slot) itemState.equipped = false
        }
      }
      current.equipped = true
    } else current.equipped = false
    if (current.quantity === 0) delete draft.stored.inventory[action.item]
    else draft.stored.inventory[action.item] = current
    draft.inventory = this.buildInventoryContext(pack, draft.stored)
    return { before: previous, after: current.quantity === 0 ? null : { ...current } }
  }

  applyAbilityAction(pack, action, runtime, draft) {
    if (draft.group) throw new Error("能力不能作用于群共享字段")
    const definition = pack.abilities?.[action.ability]
    if (!definition) throw new Error(`未知能力 ${action.ability}`)
    draft.stored.abilities ||= {}
    const previous = draft.stored.abilities[action.ability] ? { ...draft.stored.abilities[action.ability] } : { learned: false, rank: 0, cooldown: 0, uses: 0 }
    let current = { ...previous }
    if (action.op === "learn_ability") {
      const rank = Math.max(1, Math.trunc(Number(action.rank === undefined ? Math.max(1, current.rank || 1) : this.evaluateActionValue(action.rank, pack, runtime, draft))))
      const maxRank = Math.max(1, Number(definition.max_rank) || 1)
      if (rank > maxRank) throw new Error(`${definition.label || action.ability} 等级不能超过 ${maxRank}`)
      current = { ...current, learned: true, rank }
    } else if (action.op === "forget_ability") {
      delete draft.stored.abilities[action.ability]
      draft.abilities = this.buildAbilityContext(pack, draft.stored)
      return { before: previous, after: null }
    } else if (action.op === "reset_ability") {
      if (!current.learned) throw new Error(`尚未学习 ${definition.label || action.ability}`)
      current.cooldown = 0
    } else {
      if (!current.learned) throw new Error(`尚未学习 ${definition.label || action.ability}`)
      if (Number(current.cooldown) > 0) throw new Error(`${definition.label || action.ability} 仍有 ${current.cooldown} 回合冷却`)
      if (definition.resource_field) {
        const resourceDraft = definition.resource_scope === "group"
          ? { group: true, attr: runtime.groupStored.values, actor: { kind: "group", id: String(runtime.context.group.id), name: "群共享状态" } }
          : draft
        const fields = definition.resource_scope === "group" ? pack.group?.fields || {} : pack.character?.fields || {}
        const fieldDefinition = fields[definition.resource_field]
        const before = Number(resourceDraft.attr[definition.resource_field])
        const cost = Math.max(0, Number(definition.resource_cost) || 0)
        if (!Number.isFinite(before) || before < cost) throw new Error(`${fieldDefinition?.label || definition.resource_field} 不足，需要 ${cost}`)
        resourceDraft.attr[definition.resource_field] = before - cost
        validateFieldValue(resourceDraft.attr[definition.resource_field], fieldDefinition, `${definition.resource_scope === "group" ? "shared" : "attr"}.${definition.resource_field}`)
        runtime.auditActions.push({ op: "ability_cost", scope: definition.resource_scope || "actor", target: sanitizeAuditValue(resourceDraft.actor), field: definition.resource_field, before, after: resourceDraft.attr[definition.resource_field] })
      }
      current.cooldown = Math.max(0, Number(definition.cooldown) || 0)
      current.uses = Math.max(0, Number(current.uses) || 0) + 1
    }
    draft.stored.abilities[action.ability] = current
    draft.abilities = this.buildAbilityContext(pack, draft.stored)
    return { before: previous, after: { ...current } }
  }

  async applyActionList(pack, actions, runtime, depth = 0, options = {}) {
    if (!actions?.length) return
    if (depth > 8) throw new Error("状态或事件动作递归超过 8 层")
    for (const action of actions) {
      for (const draft of this.getActionDrafts(action, runtime)) {
        if (action.when !== undefined && !Boolean(this.evaluateActionValue(action.when, pack, runtime, draft, options))) continue
        let change
        if (["set", "add", "subtract", "min", "max", "clamp", "clear"].includes(action.op)) change = this.applyValueAction(pack, action, runtime, draft, options)
        else if (["add_status", "remove_status"].includes(action.op)) change = await this.applyStatusAction(pack, action, runtime, draft, depth)
        else if (["add_item", "remove_item", "equip", "unequip"].includes(action.op)) change = this.applyItemAction(pack, action, runtime, draft)
        else change = this.applyAbilityAction(pack, action, runtime, draft)
        runtime.auditActions.push({
          op: action.op,
          scope: action.scope || "actor",
          target: { kind: draft.actor.kind, id: draft.actor.id, name: draft.actor.name },
          field: action.field || action.status || action.item || action.ability,
          ...sanitizeAuditValue(change)
        })
        this.refreshRuleContext(pack, runtime, draft.group ? null : draft, options.status)
      }
    }
  }

  async executeCommand(e, pack, command, raw) {
    const config = this.diceManager.getConfig()
    const state = this.diceManager.readState(config)
    const ruleState = ensureRuleGroupState(state, e?.group_id, pack.id)
    requireRulePermission(e, ruleState, command.permission || "player")
    const invocationRandom = createRuleRandom(this.random)
    const random = invocationRandom.random
    const sender = { card: e?.sender?.card || "", nickname: e?.sender?.nickname || "" }
    const actorDraft = this.getEntityDraft(state, e, pack, ruleState, selfActor(e))
    const args = await this.parseArguments(command, raw, e, ruleState)
    const entityDrafts = new Map([[actorDraft.key, actorDraft]])
    for (const definition of command.arguments || []) {
      if (definition.type !== "actor") continue
      const values = Array.isArray(args[definition.id]) ? args[definition.id] : args[definition.id] ? [args[definition.id]] : []
      for (const actor of values) {
        const key = actorStorageKey(actor)
        if (!entityDrafts.has(key)) entityDrafts.set(key, this.getEntityDraft(state, e, pack, ruleState, actor))
      }
    }
    const groupStored = this.buildGroupStored(pack, ruleState, sender)
    const rawGroupId = e.group_id
    const numericGroupId = Number(rawGroupId)
    const firstTargetActor = [...entityDrafts.values()].find(draft => draft.key !== actorDraft.key) || null
    const context = {
      arg: args,
      attr: actorDraft.attr,
      derived: {},
      roll: {},
      table: {},
      let: {},
      group: { id: Number.isSafeInteger(numericGroupId) ? numericGroupId : String(rawGroupId) },
      shared: groupStored.values,
      session: ruleState.session,
      inventory: actorDraft.inventory,
      abilities: actorDraft.abilities,
      target: null,
      opposed: null,
      result: ""
    }
    const runtime = {
      state,
      e,
      pack,
      command,
      ruleState,
      actorDraft,
      entityDrafts,
      groupStored,
      args,
      context,
      random,
      defaultTarget: firstTargetActor ? this.describeDraft(pack, firstTargetActor, groupStored.values, ruleState.session, random) : null,
      auditActions: []
    }
    this.refreshRuleContext(pack, runtime, firstTargetActor)
    let diceUsed = 0
    const maxDiceCount = pack.limits?.max_dice_count || config.maxDiceCount
    for (const [id, expression] of Object.entries(command.rolls || {})) {
      const evaluation = this.evaluate(expression, context, pack, { allowDice: true, remainingDice: Math.max(1, maxDiceCount - diceUsed), random })
      if (typeof evaluation.value !== "number" || !Number.isFinite(evaluation.value)) throw new Error(`roll.${id} 必须得到数值`)
      diceUsed += evaluation.diceCount
      if (diceUsed > maxDiceCount) throw new Error(`骰子总数超过上限 ${maxDiceCount}`)
      context.roll[id] = { expr: String(expression), total: evaluation.value, detail: evaluation.traces.join(" + ") || String(evaluation.value) }
    }
    for (const [id, tableId] of Object.entries(command.draws || {})) context.table[id] = drawTable(pack.tables[tableId], random)
    for (const [id, expression] of Object.entries(command.let || {})) context.let[id] = this.evaluate(expression, context, pack, { random }).value

    if (command.opposed) {
      const targetValue = args[command.opposed.target]
      if (Array.isArray(targetValue)) throw new Error("对抗检定只支持一个目标")
      const targetDraft = targetValue ? entityDrafts.get(actorStorageKey(targetValue)) : null
      if (!targetDraft) throw new Error("对抗检定目标不存在")
      this.refreshRuleContext(pack, runtime, targetDraft)
      const actorEvaluation = this.evaluate(command.opposed.actor_value, context, pack, { allowDice: true, remainingDice: Math.max(1, maxDiceCount - diceUsed), random })
      diceUsed += actorEvaluation.diceCount
      const targetEvaluation = this.evaluate(command.opposed.target_value, context, pack, { allowDice: true, remainingDice: Math.max(1, maxDiceCount - diceUsed), random })
      diceUsed += targetEvaluation.diceCount
      if (diceUsed > maxDiceCount) throw new Error(`骰子总数超过上限 ${maxDiceCount}`)
      const actorValue = Number(actorEvaluation.value)
      const targetNumber = Number(targetEvaluation.value)
      if (!Number.isFinite(actorValue) || !Number.isFinite(targetNumber)) throw new Error("对抗值必须是有限数字")
      const mode = command.opposed.mode || "higher"
      let result = actorValue === targetNumber ? command.opposed.tie || "tie" : mode === "higher" ? (actorValue > targetNumber ? "actor" : "target") : (actorValue < targetNumber ? "actor" : "target")
      const winner = result === "actor" ? actorDraft.actor.name : result === "target" ? targetDraft.actor.name : "平手"
      context.opposed = { actor: actorValue, target: targetNumber, result, winner, margin: Math.abs(actorValue - targetNumber) }
    }

    let branch = null
    for (const candidate of command.branches || []) {
      if (candidate.when === undefined || Boolean(this.evaluate(candidate.when, context, pack, { random }).value)) {
        branch = candidate
        break
      }
    }
    if (branch) {
      context.result = branch.result || ""
      for (const [id, expression] of Object.entries(branch.let || {})) context.let[id] = this.evaluate(expression, context, pack, { random }).value
    }
    await this.applyActionList(pack, [...(command.actions || []), ...(branch?.actions || [])], runtime)
    this.refreshRuleContext(pack, runtime, firstTargetActor)
    const identityContext = { ...context, sender }
    const actorTemplate = pack.identity?.display_name || "{sender.card}"
    let actor = ""
    try {
      actor = renderRuleTemplate(actorTemplate, identityContext).trim()
    } catch {}
    if (!actor) actor = renderRuleTemplate(pack.identity?.fallback || "{sender.card}", identityContext, { strict: false }).trim()
    if (!actor) actor = actorDraft.actor.name || sender.nickname || String(e?.user_id || "调查员")
    const groupCardUpdates = []
    if (pack.identity?.sync_group_card === true && actorDraft.actor.self) {
      const cardTemplate = pack.identity.group_card || pack.identity.display_name || "{sender.card}"
      const cardName = sanitizeRuleOutput(renderRuleTemplate(cardTemplate, identityContext, { strict: false })).trim().slice(0, 60)
      if (cardName) groupCardUpdates.push({ userId: String(e.user_id || ""), name: cardName })
    }
    const outputContext = { ...context, actor, sender, command: { label: command.label || command.id }, message: "" }
    const template = branch?.output ?? command.output ?? pack.templates?.[command.template]
    const output = sanitizeRuleOutput(renderRuleTemplate(template, outputContext))
    const maxOutput = pack.limits?.max_output_length || 2000
    if (Array.from(output).length > maxOutput) throw new Error(`规则输出超过 ${maxOutput} 字符上限`)
    const visibility = command.visibility || "public"
    const auditId = newAuditId()
    let text = output
    let privateMessages = []
    if (visibility !== "public") {
      const recipients = visibility === "private" ? [String(e.user_id || "")] : await getRuleGmRecipients(e, ruleState)
      if (!recipients.length) throw new Error("没有找到可接收私密结果的 GM 或管理员")
      const publicTemplate = command.public_output || "{actor}进行了一次暗骰，结果已发送给有权限的接收者。"
      text = sanitizeRuleOutput(renderRuleTemplate(publicTemplate, outputContext))
      const queued = this.queuePrivateRuleResult(e, pack, ruleState, output, text, { recipients, auditId })
      privateMessages = queued.privateMessages
    }
    for (const draft of entityDrafts.values()) {
      draft.stored.values = this.buildStoredValues(pack, draft.attr)
      draft.commit(draft.stored)
    }
    for (const [id, definition] of Object.entries(pack.group?.fields || {})) if (definition.persistent === false) delete groupStored.values[id]
    ruleState.group = groupStored
    const audit = {
      id: auditId,
      at: new Date().toISOString(),
      packId: pack.id,
      packageVersion: pack.compatibility?.package_version || "1.0.0",
      command: command.id,
      visibility,
      invoker: { id: String(e.user_id || ""), name: actor },
      targets: [...entityDrafts.values()].filter(draft => draft.key !== actorDraft.key).map(draft => ({ kind: draft.actor.kind, id: draft.actor.id, name: draft.actor.name })),
      seed: invocationRandom.seed,
      args: sanitizeAuditValue(args),
      rolls: sanitizeAuditValue(context.roll),
      tables: sanitizeAuditValue(context.table),
      opposed: sanitizeAuditValue(context.opposed),
      result: context.result,
      tags: Array.isArray(branch?.tags) ? [...branch.tags] : [],
      actions: runtime.auditActions,
      output
    }
    ruleState.audit.push(audit)
    if (ruleState.audit.length > MAX_AUDIT_RECORDS) ruleState.audit.splice(0, ruleState.audit.length - MAX_AUDIT_RECORDS)
    await this.diceManager.writeState(state, config)

    await this.diceManager.recordStructuredRuleEvent(e, {
      content: text,
      auditId,
      packId: pack.id,
      command: command.id,
      visibility,
      result: visibility === "public" ? context.result : "[private]",
      tags: Array.isArray(branch?.tags) ? [...branch.tags] : []
    }, state, config).catch(error => this.logger?.warn?.(`[骰规则] 写入团录失败: ${error.message}`))
    return { text, privateMessages, auditId, packId: pack.id, groupCardUpdates }
  }

  findField(pack, raw) {
    const text = normalizeText(raw)
    return Object.entries(pack.character?.fields || {}).find(([id, definition]) => id === text || definition.label === text) || null
  }

  splitBuiltinTarget(raw = "") {
    const tokens = parseQuotedTokens(raw)
    const first = tokens[0] || ""
    const isSelector = /^(?:self|me|我|自己|reply|回复|qq:\d+|npc:.+|\d{5,20}|<@!?\d+>|\[CQ:at,)/i.test(first)
    return isSelector ? { selector: first, rest: tokens.slice(1).join(" ") } : { selector: "self", rest: String(raw || "").trim() }
  }

  async handleCardOperation(e, pack, operation, raw) {
    const config = this.diceManager.getConfig()
    const state = this.diceManager.readState(config)
    const ruleState = ensureRuleGroupState(state, e?.group_id, pack.id)
    const parsed = this.splitBuiltinTarget(raw)
    const target = await resolveRuleActor(e, parsed.selector, ruleState, ["self", "member", "npc"])
    const permission = getRulePermission(e, ruleState)
    if (!target.self && !["gm", "admin", "master"].includes(permission)) throw new Error("只有 GM、群管理员或主人可以直接查看或修改其他角色的人物卡")
    const draft = this.getEntityDraft(state, e, pack, ruleState, target)
    const attr = draft.attr
    const fields = pack.character?.fields || {}
    if (operation === "card") {
      const derived = this.computeDerived(pack, attr, { shared: ruleState.group?.values || {}, inventory: draft.inventory, session: ruleState.session })
      const rows = []
      for (const [id, definition] of Object.entries(fields)) {
        if (definition.secret) continue
        const value = definition.formula === undefined ? attr[id] : derived[id]
        rows.push(`${definition.label || id}(${id})：${value ?? "未设置"}${definition.formula !== undefined ? " [派生]" : ""}`)
      }
      const secretCount = Object.values(fields).filter(definition => definition.secret).length
      return `${pack.name} / ${draft.actor.name}\n${rows.join("\n") || "暂无公开字段"}${secretCount ? `\n${secretCount} 个秘密字段未在群内展示；GM 可用「查 字段」私聊查看。` : ""}`
    }
    if (operation === "get") {
      const found = this.findField(pack, parsed.rest)
      if (!found) throw new Error(`没有找到字段：${normalizeText(parsed.rest)}`)
      const [id, definition] = found
      if (definition.secret && !["gm", "admin", "master"].includes(permission)) throw new Error(`字段 ${definition.label || id} 仅 GM 可见`)
      const value = definition.formula === undefined ? attr[id] : this.computeDerived(pack, attr, { shared: ruleState.group?.values || {}, inventory: draft.inventory, session: ruleState.session })[id]
      if (definition.secret) {
        const result = this.queuePrivateRuleResult(e, pack, ruleState, `${definition.label || id}(${id})=${value ?? "未设置"}`, `${draft.actor.name} 的秘密字段结果已私聊发送。`)
        await this.diceManager.writeState(state, config)
        return result
      }
      return `${definition.label || id}(${id})=${value ?? "未设置"}`
    }
    if (operation === "set") {
      const source = parsed.rest
      const matcher = /([a-z][a-z0-9_]{0,47})\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g
      const updates = []
      let secretTouched = false
      let consumed = 0
      let match
      while ((match = matcher.exec(source))) {
        if (source.slice(consumed, match.index).trim()) throw new Error(`无法识别人物卡设置：${source.slice(consumed, match.index).trim()}`)
        const id = match[1]
        const definition = fields[id]
        if (!definition) throw new Error(`未知字段：${id}`)
        if (definition.secret && !["gm", "admin", "master"].includes(permission)) throw new Error(`字段 ${definition.label || id} 仅 GM 可修改`)
        if (definition.secret) secretTouched = true
        if (definition.formula !== undefined) throw new Error(`派生字段 ${id} 不能直接设置`)
        if (definition.persistent === false) throw new Error(`临时字段 ${id} 只能由规则命令在本次执行中修改`)
        const value = convertInputValue(match[2] ?? match[3] ?? match[4], definition, `attr.${id}`)
        validateFieldValue(value, definition, `attr.${id}`)
        attr[id] = value
        updates.push(`${definition.label || id}=${value}`)
        consumed = matcher.lastIndex
      }
      if (!updates.length) throw new Error("格式：.规则前缀 设 field=value；包含空格的值请加引号")
      if (source.slice(consumed).trim()) throw new Error(`无法识别人物卡设置：${source.slice(consumed).trim()}`)
      draft.stored.values = this.buildStoredValues(pack, attr)
      draft.commit(draft.stored)
      const result = secretTouched
        ? this.queuePrivateRuleResult(e, pack, ruleState, `已更新 ${draft.actor.name} 的 ${pack.name} 人物卡：${updates.join("，")}`, `${draft.actor.name} 的秘密人物卡字段已更新，具体值已私聊发送。`)
        : `已更新 ${draft.actor.name} 的 ${pack.name} 人物卡：${updates.join("，")}`
      return await this.finishDirectBuiltinMutation(e, pack, state, ruleState, "card_set", result, {
        targets: [draft.actor],
        actions: updates.map(update => ({ op: "set_field", target: draft.actor.id, field: update.split("=")[0], value: secretTouched ? "[private]" : update.split("=").slice(1).join("=") }))
      })
    }
    if (operation === "clear") {
      const found = this.findField(pack, parsed.rest)
      if (!found) throw new Error(`没有找到字段：${normalizeText(parsed.rest)}`)
      const [id, definition] = found
      if (definition.secret && !["gm", "admin", "master"].includes(permission)) throw new Error(`字段 ${definition.label || id} 仅 GM 可修改`)
      if (definition.formula !== undefined) throw new Error(`派生字段 ${id} 没有可删除的存储值`)
      if (definition.persistent === false) throw new Error(`临时字段 ${id} 没有可删除的持久值`)
      delete attr[id]
      if (definition.default !== undefined) attr[id] = resolveDefaultValue(definition.default, { card: draft.actor.name, nickname: draft.actor.name })
      draft.stored.values = this.buildStoredValues(pack, attr)
      draft.commit(draft.stored)
      const result = definition.secret
        ? this.queuePrivateRuleResult(e, pack, ruleState, `已清除 ${definition.label || id}，当前值为 ${attr[id] ?? "未设置"}`, `${draft.actor.name} 的秘密字段已清除，当前值已私聊发送。`)
        : `已清除 ${definition.label || id}，当前值为 ${attr[id] ?? "未设置"}`
      return await this.finishDirectBuiltinMutation(e, pack, state, ruleState, "card_clear", result, {
        targets: [draft.actor],
        actions: [{ op: "clear_field", target: draft.actor.id, field: id, value: definition.secret ? "[private]" : attr[id] }]
      })
    }
    throw new Error("未知人物卡操作")
  }

  async handleRoleOperation(e, pack, raw) {
    const config = this.diceManager.getConfig()
    const state = this.diceManager.readState(config)
    const ruleState = ensureRuleGroupState(state, e?.group_id, pack.id)
    const tokens = parseQuotedTokens(raw)
    if (!tokens.length || ["list", "列表", "show"].includes(tokens[0].toLowerCase())) {
      const rows = Object.entries(ruleState.roles).map(([id, role]) => `${id}：${roleLabel(role)}`)
      return `当前规则角色：\n${rows.join("\n") || "尚未指定 GM；群主和管理员仍具有管理权限。"}`
    }
    requireRulePermission(e, ruleState, "admin")
    if (["set", "设置", "add", "添加"].includes(tokens[0].toLowerCase())) tokens.shift()
    const role = String(tokens.shift() || "").toLowerCase()
    if (!["gm", "player"].includes(role)) throw new Error("格式：权限 设置 gm @成员；可设置 gm 或 player")
    const selector = tokens.shift()
    if (!selector) throw new Error("请指定成员")
    const actor = await resolveRuleActor(e, selector, ruleState, ["self", "member"])
    if (actor.kind !== "member") throw new Error("只有群成员可以分配规则角色")
    if (role === "gm") ruleState.roles[actor.id] = "gm"
    else delete ruleState.roles[actor.id]
    const result = `已将 ${actor.name} 的规则角色设置为${roleLabel(role)}。`
    return await this.finishDirectBuiltinMutation(e, pack, state, ruleState, "role_set", result, {
      targets: [actor], actions: [{ op: "set_role", target: actor.id, value: role }]
    })
  }

  async handleNpcOperation(e, pack, raw) {
    const config = this.diceManager.getConfig()
    const state = this.diceManager.readState(config)
    const ruleState = ensureRuleGroupState(state, e?.group_id, pack.id)
    const tokens = parseQuotedTokens(raw)
    const action = String(tokens.shift() || "list").toLowerCase()
    if (["list", "列表", "show"].includes(action)) {
      const rows = Object.values(ruleState.npcs).map(npc => `${npc.id}：${npc.name}`)
      return `NPC 列表：\n${rows.join("\n") || "暂无 NPC"}`
    }
    requireRulePermission(e, ruleState, "gm")
    if (["create", "add", "创建", "新增"].includes(action)) {
      const id = String(tokens.shift() || "")
      const name = tokens.join(" ").trim()
      if (!/^[a-z][a-z0-9_-]{1,47}$/.test(id)) throw new Error("NPC ID 必须以小写字母开头，只含小写字母、数字、下划线或连字符")
      if (!name) throw new Error("格式：npc 创建 <id> <名称>")
      if (ruleState.npcs[id]) throw new Error(`NPC 已存在：${id}`)
      ruleState.npcs[id] = { id, name: name.slice(0, 60), ruleData: null, createdAt: new Date().toISOString(), createdBy: String(e.user_id || "") }
      const draft = this.getEntityDraft(state, e, pack, ruleState, { kind: "npc", id, name, role: "npc", self: false })
      draft.commit(draft.stored)
      const result = `已创建 NPC：${id}（${name.slice(0, 60)}）`
      return await this.finishDirectBuiltinMutation(e, pack, state, ruleState, "npc_create", result, {
        targets: [{ kind: "npc", id, name: name.slice(0, 60) }], actions: [{ op: "create_npc", target: id }]
      })
    }
    if (["delete", "del", "remove", "删除"].includes(action)) {
      const id = String(tokens.shift() || "").replace(/^npc:/i, "")
      if (!ruleState.npcs[id]) throw new Error(`NPC 不存在：${id}`)
      const name = ruleState.npcs[id].name || id
      delete ruleState.npcs[id]
      ruleState.session.initiative = ruleState.session.initiative.filter(item => !(item.kind === "npc" && item.id === id))
      if (ruleState.session.current?.kind === "npc" && ruleState.session.current?.id === id) ruleState.session.current = null
      const result = `已删除 NPC：${name}`
      return await this.finishDirectBuiltinMutation(e, pack, state, ruleState, "npc_delete", result, {
        targets: [{ kind: "npc", id, name }], actions: [{ op: "delete_npc", target: id }]
      })
    }
    if (["card", "卡"].includes(action)) return await this.handleCardOperation(e, pack, "card", `npc:${tokens.shift() || ""}`)
    if (["set", "设"].includes(action)) return await this.handleCardOperation(e, pack, "set", `npc:${tokens.shift() || ""} ${tokens.join(" ")}`)
    if (["get", "查"].includes(action)) return await this.handleCardOperation(e, pack, "get", `npc:${tokens.shift() || ""} ${tokens.join(" ")}`)
    throw new Error("NPC 命令：npc 列表 / 创建 id 名称 / 删除 id / 卡 id / 设 id field=value")
  }

  async handleGroupFieldOperation(e, pack, operation, raw) {
    const config = this.diceManager.getConfig()
    const state = this.diceManager.readState(config)
    const ruleState = ensureRuleGroupState(state, e?.group_id, pack.id)
    const permission = getRulePermission(e, ruleState)
    const stored = this.buildGroupStored(pack, ruleState, { card: e?.sender?.card || "", nickname: e?.sender?.nickname || "" })
    const attr = stored.values
    const fields = pack.group?.fields || {}
    const find = value => Object.entries(fields).find(([id, definition]) => id === normalizeText(value) || definition.label === normalizeText(value)) || null
    if (operation === "card") {
      const derived = this.computeDerived(pack, attr, { session: ruleState.session }, fields)
      const rows = Object.entries(fields).filter(([, definition]) => !definition.secret).map(([id, definition]) => {
        const value = definition.formula === undefined ? attr[id] : derived[id]
        return `${definition.label || id}(${id})：${value ?? "未设置"}${definition.formula !== undefined ? " [派生]" : ""}`
      })
      const secretCount = Object.values(fields).filter(definition => definition.secret).length
      return `${pack.name} 群共享状态：\n${rows.join("\n") || "未定义公开共享字段"}${secretCount ? `\n${secretCount} 个秘密群字段未在群内展示；GM 可用「群查 字段」私聊查看。` : ""}`
    }
    if (operation === "get") {
      const found = find(raw)
      if (!found) throw new Error(`没有找到群字段：${normalizeText(raw)}`)
      const [id, definition] = found
      if (definition.secret && !["gm", "admin", "master"].includes(permission)) throw new Error(`字段 ${definition.label || id} 仅 GM 可见`)
      const value = definition.formula === undefined ? attr[id] : this.computeDerived(pack, attr, { session: ruleState.session }, fields)[id]
      if (definition.secret) {
        const result = this.queuePrivateRuleResult(e, pack, ruleState, `${definition.label || id}(${id})=${value ?? "未设置"}`, "秘密群字段结果已私聊发送。")
        await this.diceManager.writeState(state, config)
        return result
      }
      return `${definition.label || id}(${id})=${value ?? "未设置"}`
    }
    requireRulePermission(e, ruleState, "gm")
    const source = String(raw || "")
    const matcher = /([a-z][a-z0-9_]{0,47})\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g
    const updates = []
    let secretTouched = false
    let consumed = 0
    let match
    while ((match = matcher.exec(source))) {
      if (source.slice(consumed, match.index).trim()) throw new Error(`无法识别群字段设置：${source.slice(consumed, match.index).trim()}`)
      const definition = fields[match[1]]
      if (!definition || definition.formula !== undefined || definition.persistent === false) throw new Error(`群字段 ${match[1]} 不可直接设置`)
      if (definition.secret) secretTouched = true
      const value = convertInputValue(match[2] ?? match[3] ?? match[4], definition, `shared.${match[1]}`)
      validateFieldValue(value, definition, `shared.${match[1]}`)
      attr[match[1]] = value
      updates.push(`${definition.label || match[1]}=${value}`)
      consumed = matcher.lastIndex
    }
    if (!updates.length || source.slice(consumed).trim()) throw new Error("格式：群设 field=value；包含空格的值请加引号")
    ruleState.group = stored
    const result = secretTouched
      ? this.queuePrivateRuleResult(e, pack, ruleState, `已更新群共享状态：${updates.join("，")}`, "秘密群共享字段已更新，具体值已私聊发送。")
      : `已更新群共享状态：${updates.join("，")}`
    return await this.finishDirectBuiltinMutation(e, pack, state, ruleState, "group_set", result, {
      actions: updates.map(update => ({ op: "set_group_field", field: update.split("=")[0], value: secretTouched ? "[private]" : update.split("=").slice(1).join("=") }))
    })
  }

  createLifecycleRuntime(state, e, pack, ruleState, actor, sharedGroupStored = null) {
    const randomState = createRuleRandom(this.random)
    const actorDraft = this.getEntityDraft(state, e, pack, ruleState, actor)
    const groupStored = sharedGroupStored || this.buildGroupStored(pack, ruleState, { card: e?.sender?.card || "", nickname: e?.sender?.nickname || "" })
    const rawGroupId = e.group_id
    const numericGroupId = Number(rawGroupId)
    const runtime = {
      state,
      e,
      pack,
      ruleState,
      actorDraft,
      entityDrafts: new Map([[actorDraft.key, actorDraft]]),
      groupStored,
      args: {},
      context: {
        arg: {}, attr: actorDraft.attr, derived: {}, roll: {}, table: {}, let: {}, result: "",
        group: { id: Number.isSafeInteger(numericGroupId) ? numericGroupId : String(rawGroupId) },
        shared: groupStored.values, session: ruleState.session, inventory: actorDraft.inventory, abilities: actorDraft.abilities, target: null, opposed: null, status: null
      },
      random: randomState.random,
      randomSeed: randomState.seed,
      defaultTarget: null,
      auditActions: []
    }
    this.refreshRuleContext(pack, runtime)
    return runtime
  }

  commitLifecycleRuntime(pack, runtime) {
    for (const draft of runtime.entityDrafts.values()) {
      draft.stored.values = this.buildStoredValues(pack, draft.attr)
      draft.commit(draft.stored)
    }
    for (const [id, definition] of Object.entries(pack.group?.fields || {})) if (definition.persistent === false) delete runtime.groupStored.values[id]
    runtime.ruleState.group = runtime.groupStored
  }

  appendRuleAudit(ruleState, record) {
    ruleState.audit ||= []
    ruleState.audit.push(record)
    if (ruleState.audit.length > MAX_AUDIT_RECORDS) ruleState.audit.splice(0, ruleState.audit.length - MAX_AUDIT_RECORDS)
  }

  async finishDirectBuiltinMutation(e, pack, state, ruleState, command, result, { targets = [], actions = [] } = {}) {
    const auditId = result?.auditId || newAuditId()
    const visibility = result && typeof result === "object" && result.privateMessages?.length ? "private" : "public"
    const publicText = sanitizeRuleOutput(typeof result === "object" ? result.text : result)
    this.appendRuleAudit(ruleState, {
      id: auditId,
      at: new Date().toISOString(),
      packId: pack.id,
      packageVersion: pack.compatibility?.package_version || "1.0.0",
      command,
      visibility,
      invoker: { id: String(e.user_id || ""), name: e?.sender?.card || e?.sender?.nickname || String(e.user_id || "") },
      targets: sanitizeAuditValue(targets),
      seed: "",
      actions: sanitizeAuditValue(actions),
      output: visibility === "public" ? publicText : "[private]"
    })
    const config = this.diceManager.getConfig()
    await this.diceManager.writeState(state, config)
    await this.diceManager.recordStructuredRuleEvent(e, { content: publicText, auditId, packId: pack.id, command, visibility }, state, config)
      .catch(error => this.logger?.warn?.(`[骰规则] 写入团录失败: ${error.message}`))
    if (result && typeof result === "object") return { ...result, auditId, packId: pack.id }
    return publicText
  }

  queuePrivateRuleResult(e, pack, ruleState, privateText, publicText, { recipients = null, auditId = newAuditId() } = {}) {
    const targets = [...new Set((recipients || [String(e.user_id || "")]).map(String).filter(Boolean))]
    if (!targets.length) throw new Error("没有找到可接收私密结果的成员")
    ruleState.privateDeliveries ||= []
    const privateMessages = targets.map(userId => {
      const deliveryId = `${auditId}:${userId}`
      const message = {
        deliveryId,
        userId,
        text: `【${pack.name}私密结果】\n${privateText}\n审计编号：${auditId}`,
        createdAt: new Date().toISOString(),
        attempts: 0,
        lastError: ""
      }
      ruleState.privateDeliveries.push(message)
      return { deliveryId, userId, text: message.text }
    })
    if (ruleState.privateDeliveries.length > MAX_PRIVATE_DELIVERIES) {
      ruleState.privateDeliveries.splice(0, ruleState.privateDeliveries.length - MAX_PRIVATE_DELIVERIES)
    }
    return { text: sanitizeRuleOutput(publicText), privateMessages, auditId, packId: pack.id }
  }

  async settlePrivateDeliveries(groupId, packId, outcomes = []) {
    if (!groupId || !packId || !outcomes.length) return
    const config = this.diceManager.getConfig()
    await this.diceManager.withStateTransaction(async () => {
      const state = this.diceManager.readState(config)
      const ruleState = state.groups?.[String(groupId)]?.diceRuleSessions?.[packId]
      if (!ruleState?.privateDeliveries) return
      const outcomeMap = new Map(outcomes.map(item => [item.deliveryId, item]))
      ruleState.privateDeliveries = ruleState.privateDeliveries.filter(delivery => {
        const outcome = outcomeMap.get(delivery.deliveryId)
        if (!outcome) return true
        if (outcome.ok) return false
        delivery.attempts = (Number(delivery.attempts) || 0) + 1
        delivery.lastAttemptAt = new Date().toISOString()
        delivery.lastError = String(outcome.error || "私聊发送失败").slice(0, 200)
        return true
      })
      await this.diceManager.writeState(state, config)
    })
  }

  async handleDeliveryOperation(e, pack, raw) {
    const config = this.diceManager.getConfig()
    const state = this.diceManager.readState(config)
    const ruleState = ensureRuleGroupState(state, e?.group_id, pack.id)
    requireRulePermission(e, ruleState, "gm")
    const action = String(parseQuotedTokens(raw).shift() || "status").toLowerCase()
    const pending = ruleState.privateDeliveries || []
    if (["status", "list", "状态", "列表"].includes(action)) return `待重试私密投递：${pending.length} 条。重试：.${pack.id} 投递 重试`
    if (["retry", "重试"].includes(action)) {
      if (!pending.length) return "当前没有待重试的私密结果。"
      const privateMessages = pending.slice(0, 20).map(item => ({ deliveryId: item.deliveryId, userId: item.userId, text: item.text }))
      return { text: `正在重试 ${privateMessages.length} 条私密结果；失败项会继续保留。`, privateMessages, packId: pack.id }
    }
    throw new Error("投递命令：投递 状态 / 投递 重试")
  }

  async runRuleEvent(pack, eventName, runtime) {
    await this.applyActionList(pack, pack.events?.[eventName] || [], runtime)
  }

  async tickActorStatuses(pack, tick, runtime) {
    const statuses = runtime.actorDraft.stored.statuses ||= {}
    for (const [statusId, currentValue] of Object.entries({ ...statuses })) {
      const definition = pack.statuses?.[statusId]
      if (!definition || (definition.tick || "manual") !== tick) continue
      let current = { ...currentValue }
      if (definition.on_tick?.length) await this.applyActionList(pack, definition.on_tick, runtime, 0, { status: { id: statusId, ...current } })
      if (!statuses[statusId]) continue
      current = { ...statuses[statusId] }
      if (current.duration !== null && current.duration !== undefined) current.duration = Math.max(0, Number(current.duration) - 1)
      if (current.duration === 0) {
        if (definition.on_expire?.length) await this.applyActionList(pack, definition.on_expire, runtime, 0, { status: { id: statusId, ...current } })
        delete statuses[statusId]
        runtime.auditActions.push({ op: "expire_status", scope: "actor", target: sanitizeAuditValue(runtime.actorDraft.actor), field: statusId, before: currentValue, after: null })
      } else statuses[statusId] = current
    }
    this.refreshRuleContext(pack, runtime)
  }

  tickActorAbilities(pack, runtime) {
    const abilities = runtime.actorDraft.stored.abilities ||= {}
    for (const [abilityId, currentValue] of Object.entries(abilities)) {
      const before = Math.max(0, Number(currentValue.cooldown) || 0)
      if (before < 1) continue
      currentValue.cooldown = before - 1
      runtime.auditActions.push({
        op: "ability_cooldown",
        scope: "actor",
        target: sanitizeAuditValue(runtime.actorDraft.actor),
        field: abilityId,
        before,
        after: currentValue.cooldown
      })
    }
    runtime.actorDraft.abilities = this.buildAbilityContext(pack, runtime.actorDraft.stored)
    this.refreshRuleContext(pack, runtime)
  }

  async finishBuiltinMutation(e, pack, state, ruleState, runtime, command, text, options = {}) {
    return await this.finishBuiltinBatch(e, pack, state, ruleState, [runtime], command, text, options)
  }

  async finishBuiltinBatch(e, pack, state, ruleState, runtimes, command, text, options = {}) {
    for (const runtime of runtimes) this.commitLifecycleRuntime(pack, runtime)
    const auditId = newAuditId()
    this.appendRuleAudit(ruleState, {
      id: auditId,
      at: new Date().toISOString(),
      packId: pack.id,
      packageVersion: pack.compatibility?.package_version || "1.0.0",
      command,
      visibility: "public",
      invoker: { id: String(e.user_id || ""), name: e?.sender?.card || e?.sender?.nickname || String(e.user_id || "") },
      targets: runtimes.map(runtime => ({ kind: runtime.actorDraft.actor.kind, id: runtime.actorDraft.actor.id, name: runtime.actorDraft.actor.name })),
      seed: runtimes.map(runtime => runtime.randomSeed).join(","),
      actions: runtimes.flatMap(runtime => runtime.auditActions),
      output: text
    })
    const config = this.diceManager.getConfig()
    await this.diceManager.writeState(state, config)
    await this.diceManager.recordStructuredRuleEvent(e, { content: text, auditId, packId: pack.id, command, visibility: "public" }, options.logState || state, config)
      .catch(error => this.logger?.warn?.(`[骰规则] 写入团录失败: ${error.message}`))
    return text
  }

  ensureActiveCampaign(e, pack, ruleState) {
    ruleState.campaigns ||= {}
    let id = ruleState.activeCampaignId
    if (id && ruleState.campaigns[id]?.status !== "archived") return ruleState.campaigns[id]
    id = "default"
    ruleState.campaigns[id] ||= {
      id,
      name: `${pack.name} 默认战役`,
      status: "active",
      createdAt: new Date().toISOString(),
      createdBy: String(e.user_id || ""),
      members: {},
      chapters: [],
      records: [],
      sessions: []
    }
    ruleState.activeCampaignId = id
    return ruleState.campaigns[id]
  }

  formatCampaign(campaign) {
    if (!campaign) return "当前没有选中的战役。"
    const chapter = [...(campaign.chapters || [])].reverse().find(item => !item.endedAt)
    return [
      `战役：${campaign.name}（${campaign.id}）`,
      `状态：${campaign.status || "active"}；当前章节：${chapter?.title || "无"}`,
      `登记角色：${Object.keys(campaign.members || {}).length}；场次：${(campaign.sessions || []).length}；记录：${(campaign.records || []).length}`
    ].join("\n")
  }

  async handleCampaignOperation(e, pack, raw) {
    const config = this.diceManager.getConfig()
    const state = this.diceManager.readState(config)
    const ruleState = ensureRuleGroupState(state, e?.group_id, pack.id)
    const tokens = parseQuotedTokens(raw)
    const action = String(tokens.shift() || "status").toLowerCase()
    if (["list", "列表"].includes(action)) {
      const rows = Object.values(ruleState.campaigns || {}).map(item => `${item.id}：${item.name} [${item.status || "active"}]${ruleState.activeCampaignId === item.id ? " [当前]" : ""}`)
      return `战役列表：\n${rows.join("\n") || "暂无；创建：战役 创建 <id> <名称>"}`
    }
    if (["status", "show", "状态", "查看"].includes(action)) return this.formatCampaign(ruleState.campaigns?.[ruleState.activeCampaignId])
    if (["register", "join", "登记", "加入"].includes(action)) {
      const campaign = this.ensureActiveCampaign(e, pack, ruleState)
      const selector = tokens.shift() || "self"
      const actor = await resolveRuleActor(e, selector, ruleState, ["self", "member"])
      if (!actor.self) requireRulePermission(e, ruleState, "gm")
      const character = tokens.join(" ").trim().slice(0, 80) || actor.name
      campaign.members[actor.id] = { userId: actor.id, name: actor.name, character, joinedAt: new Date().toISOString() }
      return await this.finishDirectBuiltinMutation(e, pack, state, ruleState, "campaign_register", `已登记：${actor.name} → ${character}`, { targets: [actor], actions: [{ op: "register_character", target: actor.id, value: character }] })
    }
    requireRulePermission(e, ruleState, "gm")
    if (["create", "new", "创建", "新建"].includes(action)) {
      const id = String(tokens.shift() || "").toLowerCase()
      const name = tokens.join(" ").trim()
      if (!/^[a-z][a-z0-9_-]{1,47}$/.test(id)) throw new Error("战役 ID 必须以小写字母开头，只含小写字母、数字、下划线或连字符")
      if (!name) throw new Error("格式：战役 创建 <id> <名称>")
      if (ruleState.campaigns[id]) throw new Error(`战役已存在：${id}`)
      ruleState.campaigns[id] = { id, name: name.slice(0, 80), status: "active", createdAt: new Date().toISOString(), createdBy: String(e.user_id || ""), members: {}, chapters: [], records: [], sessions: [] }
      ruleState.activeCampaignId = id
      return await this.finishDirectBuiltinMutation(e, pack, state, ruleState, "campaign_create", `已创建并选中战役：${name.slice(0, 80)}（${id}）`, { actions: [{ op: "create_campaign", target: id }] })
    }
    if (["use", "select", "使用", "选择", "切换"].includes(action)) {
      const id = String(tokens.shift() || "")
      const campaign = ruleState.campaigns?.[id]
      if (!campaign) throw new Error(`战役不存在：${id}`)
      if (campaign.status === "archived") throw new Error(`战役 ${id} 已归档；请先恢复`)
      if (ruleState.session.active) throw new Error("当前场次进行中，不能切换战役")
      ruleState.activeCampaignId = id
      return await this.finishDirectBuiltinMutation(e, pack, state, ruleState, "campaign_select", `已切换到战役：${campaign.name}（${id}）`, { actions: [{ op: "select_campaign", target: id }] })
    }
    let campaign = this.ensureActiveCampaign(e, pack, ruleState)
    if (["chapter", "章节"].includes(action)) {
      const operation = String(tokens.shift() || "list").toLowerCase()
      campaign.chapters ||= []
      if (["list", "列表"].includes(operation)) return `章节：\n${campaign.chapters.map((item, index) => `${index + 1}. ${item.title}${item.endedAt ? " [已结束]" : " [进行中]"}`).join("\n") || "无"}`
      if (["start", "new", "开始", "新建"].includes(operation)) {
        if (campaign.chapters.some(item => !item.endedAt)) throw new Error("已有进行中的章节，请先结束")
        const title = tokens.join(" ").trim().slice(0, 100)
        if (!title) throw new Error("格式：战役 章节 开始 <标题>")
        const chapter = { id: `chapter-${Date.now().toString(36)}`, title, startedAt: new Date().toISOString(), startedBy: String(e.user_id || ""), endedAt: "" }
        campaign.chapters.push(chapter)
        return await this.finishDirectBuiltinMutation(e, pack, state, ruleState, "campaign_chapter_start", `章节已开始：${title}`, { actions: [{ op: "start_chapter", target: chapter.id }] })
      }
      if (["end", "stop", "结束"].includes(operation)) {
        const chapter = [...campaign.chapters].reverse().find(item => !item.endedAt)
        if (!chapter) throw new Error("当前没有进行中的章节")
        chapter.endedAt = new Date().toISOString()
        return await this.finishDirectBuiltinMutation(e, pack, state, ruleState, "campaign_chapter_end", `章节已结束：${chapter.title}`, { actions: [{ op: "end_chapter", target: chapter.id }] })
      }
      throw new Error("章节命令：战役 章节 列表 / 开始 <标题> / 结束")
    }
    if (["record", "note", "记录", "线索", "手记"].includes(action)) {
      const type = action === "线索" ? "clue" : action === "手记" ? "note" : String(tokens.shift() || "note").toLowerCase()
      if (!new Set(["note", "clue", "file", "link"]).has(type)) throw new Error("记录类型支持 note、clue、file、link")
      const content = tokens.join(" ").trim().slice(0, 1000)
      if (!content) throw new Error("格式：战役 记录 <note|clue|file|link> <内容>")
      const record = { id: `record-${Date.now().toString(36)}`, type, content, at: new Date().toISOString(), by: String(e.user_id || "") }
      campaign.records ||= []
      campaign.records.push(record)
      if (campaign.records.length > 500) campaign.records.splice(0, campaign.records.length - 500)
      return await this.finishDirectBuiltinMutation(e, pack, state, ruleState, "campaign_record", `已记录${type === "clue" ? "线索" : type === "file" ? "文件" : type === "link" ? "链接" : "手记"}：${content}`, { actions: [{ op: "add_campaign_record", target: record.id, value: type }] })
    }
    if (["archive", "归档", "restore", "恢复"].includes(action)) {
      const restore = ["restore", "恢复"].includes(action)
      const targetId = String(tokens.shift() || campaign.id)
      campaign = ruleState.campaigns?.[targetId]
      if (!campaign) throw new Error(`战役不存在：${targetId}`)
      if (!restore && ruleState.session.active) throw new Error("当前场次进行中，不能归档战役")
      campaign.status = restore ? "active" : "archived"
      if (!restore && ruleState.activeCampaignId === campaign.id) ruleState.activeCampaignId = ""
      if (restore) ruleState.activeCampaignId = campaign.id
      return await this.finishDirectBuiltinMutation(e, pack, state, ruleState, restore ? "campaign_restore" : "campaign_archive", `战役已${restore ? "恢复" : "归档"}：${campaign.name}`, { actions: [{ op: restore ? "restore_campaign" : "archive_campaign", target: campaign.id }] })
    }
    throw new Error("战役命令：列表 / 创建 <id> <名称> / 使用 <id> / 登记 <目标> [角色名] / 章节 / 记录 / 归档 / 恢复")
  }

  formatSessionStatus(ruleState) {
    const session = ruleState.session
    const current = session.current ? `${session.current.name}（${session.current.kind}:${session.current.id}）` : "无"
    return [
      `团务：${session.active ? "进行中" : "未开始"}`,
      `战役：${session.campaignId || ruleState.activeCampaignId || "未选择"}；暂停：${session.paused ? "是" : "否"}`,
      `标题：${session.title || "未命名"}`,
      `轮次：${session.round || 0}；回合：${session.turn || 0}；阶段：${session.phase || "idle"}`,
      `当前行动者：${current}`,
      `先攻项：${session.initiative.length}；历史场次：${ruleState.sessions?.length || 0}；快照：${ruleState.snapshots?.length || 0}`
    ].join("\n")
  }

  createSessionSnapshot(state, e, pack, ruleState, name = "") {
    const groupId = String(e.group_id)
    const players = {}
    for (const [userId, user] of Object.entries(state.users || {})) {
      for (const [cardName, card] of Object.entries(user?.cards || {})) {
        const root = card?.ruleData?.[pack.id]
        const stored = root?._scopeVersion === 2 ? root.groups?.[groupId] : null
        if (stored) players[`${userId}:${cardName}`] = cloneJson(stored)
      }
    }
    return {
      id: `snapshot-${Date.now().toString(36)}`,
      name: String(name || "").trim().slice(0, 80) || `快照 ${new Date().toISOString().replace("T", " ").slice(0, 19)}`,
      createdAt: new Date().toISOString(),
      createdBy: String(e.user_id || ""),
      group: cloneJson(ruleState.group || { values: {} }),
      npcs: cloneJson(ruleState.npcs || {}),
      session: cloneJson(ruleState.session || {}),
      players
    }
  }

  restoreSessionSnapshot(state, e, pack, ruleState, snapshot) {
    const groupId = String(e.group_id)
    ruleState.group = cloneJson(snapshot.group || { values: {} })
    ruleState.npcs = cloneJson(snapshot.npcs || {})
    ruleState.session = cloneJson(snapshot.session || {})
    for (const user of Object.values(state.users || {})) {
      for (const card of Object.values(user?.cards || {})) {
        const root = card?.ruleData?.[pack.id]
        if (root?._scopeVersion === 2 && root.groups) delete root.groups[groupId]
      }
    }
    for (const [key, stored] of Object.entries(snapshot.players || {})) {
      const split = key.indexOf(":")
      const userId = key.slice(0, split)
      const cardName = key.slice(split + 1)
      const card = state.users?.[userId]?.cards?.[cardName]
      if (!card) continue
      card.ruleData ||= {}
      card.ruleData[pack.id] ||= { _scopeVersion: 2, groups: {} }
      card.ruleData[pack.id].groups ||= {}
      card.ruleData[pack.id].groups[groupId] = cloneJson(stored)
    }
  }

  async handleSessionOperation(e, pack, raw) {
    const config = this.diceManager.getConfig()
    const state = this.diceManager.readState(config)
    const ruleState = ensureRuleGroupState(state, e?.group_id, pack.id)
    const tokens = parseQuotedTokens(raw)
    const action = String(tokens.shift() || "status").toLowerCase()
    if (["status", "show", "状态", "查看"].includes(action)) return this.formatSessionStatus(ruleState)
    if (["history", "历史", "场次"].includes(action)) {
      const rows = [...(ruleState.sessions || [])].reverse().slice(0, 20).map((item, index) => `${index + 1}. ${item.title || "未命名"}｜${item.startedAt || ""} → ${item.endedAt || ""}｜战役 ${item.campaignId || "default"}`)
      return `历史场次：\n${rows.join("\n") || "暂无"}`
    }
    requireRulePermission(e, ruleState, "gm")
    if (["pause", "暂停"].includes(action)) {
      if (!ruleState.session.active) throw new Error("当前没有进行中的团务")
      if (ruleState.session.paused) throw new Error("团务已经暂停")
      ruleState.session.previousPhase = ruleState.session.phase || "setup"
      ruleState.session.paused = true
      ruleState.session.phase = "paused"
      return await this.finishDirectBuiltinMutation(e, pack, state, ruleState, "session_pause", `团务已暂停：${ruleState.session.title || "未命名"}`, { actions: [{ op: "pause_session" }] })
    }
    if (["resume", "恢复", "继续"].includes(action)) {
      if (!ruleState.session.active || !ruleState.session.paused) throw new Error("当前没有暂停中的团务")
      ruleState.session.paused = false
      ruleState.session.phase = ruleState.session.previousPhase || (ruleState.session.current ? "turn_start" : "setup")
      delete ruleState.session.previousPhase
      return await this.finishDirectBuiltinMutation(e, pack, state, ruleState, "session_resume", `团务已恢复：${ruleState.session.title || "未命名"}`, { actions: [{ op: "resume_session" }] })
    }
    if (["snapshot", "快照"].includes(action)) {
      const snapshot = this.createSessionSnapshot(state, e, pack, ruleState, tokens.join(" "))
      ruleState.snapshots ||= []
      ruleState.snapshots.push(snapshot)
      if (ruleState.snapshots.length > 10) ruleState.snapshots.splice(0, ruleState.snapshots.length - 10)
      return await this.finishDirectBuiltinMutation(e, pack, state, ruleState, "session_snapshot", `已创建团务快照：${snapshot.name}（${snapshot.id}）`, { actions: [{ op: "create_snapshot", target: snapshot.id }] })
    }
    if (["restore-snapshot", "回退", "恢复快照"].includes(action)) {
      if (ruleState.session.active && !ruleState.session.paused) throw new Error("进行中的团务必须先暂停，才能回退快照")
      const selector = String(tokens.shift() || "1")
      const snapshots = [...(ruleState.snapshots || [])].reverse()
      const snapshot = /^\d+$/.test(selector) ? snapshots[Number(selector) - 1] : snapshots.find(item => item.id === selector || item.name === selector)
      if (!snapshot) throw new Error(`没有找到快照：${selector}`)
      this.restoreSessionSnapshot(state, e, pack, ruleState, snapshot)
      return await this.finishDirectBuiltinMutation(e, pack, state, ruleState, "session_restore_snapshot", `已回退到团务快照：${snapshot.name}`, { actions: [{ op: "restore_snapshot", target: snapshot.id }] })
    }
    const runtime = this.createLifecycleRuntime(state, e, pack, ruleState, selfActor(e))
    if (["start", "new", "开始", "新建"].includes(action)) {
      if (ruleState.session.active) throw new Error(`团务已经开始：${ruleState.session.title || "未命名"}`)
      const campaign = this.ensureActiveCampaign(e, pack, ruleState)
      const groupId = String(e.group_id)
      const existingLog = state.groups?.[groupId]?.log
      let logMessage = ""
      if (existingLog?.active) {
        ruleState.session.logOwned = false
        ruleState.session.logFile = existingLog.file || ""
        logMessage = `沿用已有团录：${existingLog.title || "未命名"}；结束团务时不会替你停止它。`
      } else {
        const preparedLog = this.diceManager.prepareStartLog(e, state, tokens.join(" ").trim() || pack.name, config, { authorized: true })
        if (!preparedLog.changed) throw new Error(preparedLog.text)
        ruleState.session.logOwned = true
        ruleState.session.logFile = preparedLog.log?.file || ""
        logMessage = "团录已开启，并与本次团务绑定。"
      }
      ruleState.session.active = true
      ruleState.session.campaignId = campaign.id
      ruleState.session.paused = false
      ruleState.session.title = tokens.join(" ").trim().slice(0, 80) || `${pack.name}-${new Date().toISOString().slice(0, 10)}`
      ruleState.session.startedAt = new Date().toISOString()
      ruleState.session.startedBy = String(e.user_id || "")
      ruleState.session.endedAt = ""
      ruleState.session.round = 0
      ruleState.session.turn = 0
      ruleState.session.phase = "setup"
      ruleState.session.current = null
      ruleState.session.initiative = []
      await this.runRuleEvent(pack, "session_start", runtime)
      const text = `团务已开始：${ruleState.session.title}`
      await this.finishBuiltinMutation(e, pack, state, ruleState, runtime, "session_start", text)
      return `${text}\n${logMessage}`
    }
    if (["end", "stop", "结束", "停止"].includes(action)) {
      if (!ruleState.session.active) throw new Error("当前没有进行中的团务")
      await this.runRuleEvent(pack, "session_end", runtime)
      const title = ruleState.session.title || "未命名"
      const ownedLog = ruleState.session.logOwned === true
      const logSnapshot = state.groups?.[String(e.group_id)]?.log
      let logState = null
      let logMessage = "已有团录保持开启。"
      if (ownedLog) {
        const preparedLog = this.diceManager.prepareStopLog(e, state, config, { authorized: true })
        if (!preparedLog.changed) throw new Error(`团务未结束：配套团录无法原子停止（${preparedLog.text}）`)
        logState = { groups: { [String(e.group_id)]: { log: { ...logSnapshot, active: true } } } }
        logMessage = "本次团务创建的团录已停止，可使用 .log export 导出。"
      }
      ruleState.session.active = false
      ruleState.session.endedAt = new Date().toISOString()
      ruleState.session.phase = "ended"
      ruleState.session.current = null
      ruleState.sessions ||= []
      const sessionRecord = {
        id: `session-${Date.now().toString(36)}`,
        title,
        campaignId: ruleState.session.campaignId || ruleState.activeCampaignId || "default",
        startedAt: ruleState.session.startedAt || "",
        endedAt: ruleState.session.endedAt,
        startedBy: ruleState.session.startedBy || "",
        logFile: ruleState.session.logFile || "",
        initiative: [...(ruleState.session.initiative || [])]
      }
      ruleState.sessions.push(sessionRecord)
      const campaign = ruleState.campaigns?.[sessionRecord.campaignId]
      if (campaign) {
        campaign.sessions ||= []
        campaign.sessions.push(sessionRecord.id)
      }
      if (ruleState.sessions.length > 50) ruleState.sessions.splice(0, ruleState.sessions.length - 50)
      const text = `团务已结束：${title}`
      await this.finishBuiltinMutation(e, pack, state, ruleState, runtime, "session_end", text, { logState })
      return `${text}\n${logMessage}`
    }
    throw new Error("团务命令：状态 / 开始 [标题] / 暂停 / 恢复 / 快照 [名称] / 回退 <序号|ID> / 历史 / 结束")
  }

  initiativeActor(entry) {
    return { kind: entry.kind, id: String(entry.id), name: entry.name || String(entry.id), role: entry.role || (entry.kind === "npc" ? "npc" : "member"), self: false }
  }

  formatInitiative(ruleState) {
    const session = ruleState.session
    if (!session.initiative.length) return "当前先攻列表为空。"
    return [
      `第 ${session.round || 0} 轮 / 回合 ${session.turn || 0}`,
      ...session.initiative.map((item, index) => `${session.current?.kind === item.kind && String(session.current?.id) === String(item.id) ? "→" : "  "}${index + 1}. ${item.name} ${item.value}`)
    ].join("\n")
  }

  getOrCreateLifecycleRuntime(runtimes, state, e, pack, ruleState, actor, sharedGroupStored) {
    const key = actorStorageKey(actor)
    const existing = runtimes.find(runtime => runtime.actorDraft.key === key)
    if (existing) return existing
    const runtime = this.createLifecycleRuntime(state, e, pack, ruleState, actor, sharedGroupStored)
    runtimes.push(runtime)
    return runtime
  }

  async tickInitiativeStatuses(state, e, pack, ruleState, tick, sharedGroupStored, runtimes) {
    const seen = new Set()
    for (const entry of ruleState.session.initiative) {
      const actor = this.initiativeActor(entry)
      const key = actorStorageKey(actor)
      if (seen.has(key)) continue
      seen.add(key)
      const runtime = this.getOrCreateLifecycleRuntime(runtimes, state, e, pack, ruleState, actor, sharedGroupStored)
      await this.tickActorStatuses(pack, tick, runtime)
    }
  }

  async handleInitiativeOperation(e, pack, raw) {
    const config = this.diceManager.getConfig()
    const state = this.diceManager.readState(config)
    const ruleState = ensureRuleGroupState(state, e?.group_id, pack.id)
    const tokens = parseQuotedTokens(raw)
    const action = String(tokens.shift() || "list").toLowerCase()
    if (["list", "show", "列表", "查看"].includes(action)) return this.formatInitiative(ruleState)
    requireRulePermission(e, ruleState, "gm")
    if (["add", "set", "添加", "设置"].includes(action)) {
      const selector = tokens.shift()
      const value = Number(tokens.shift())
      if (!selector || !Number.isFinite(value)) throw new Error("格式：先攻 添加 <目标> <数值>")
      const actor = await resolveRuleActor(e, selector, ruleState, ["self", "member", "npc"])
      const item = { kind: actor.kind, id: actor.id, name: actor.name, role: actor.role, value }
      const index = ruleState.session.initiative.findIndex(old => old.kind === item.kind && String(old.id) === String(item.id))
      if (index >= 0) ruleState.session.initiative[index] = item
      else ruleState.session.initiative.push(item)
      const result = `已设置先攻：${actor.name} ${value}`
      return await this.finishDirectBuiltinMutation(e, pack, state, ruleState, "initiative_set", result, {
        targets: [actor], actions: [{ op: "set_initiative", target: actor.id, value }]
      })
    }
    if (["remove", "delete", "del", "删除"].includes(action)) {
      const actor = await resolveRuleActor(e, tokens.shift(), ruleState, ["self", "member", "npc"])
      if (ruleState.session.current?.kind === actor.kind && String(ruleState.session.current?.id) === String(actor.id)) {
        throw new Error("当前行动者正在回合中，不能直接删除；请先执行下一回合或结束先攻")
      }
      const before = ruleState.session.initiative.length
      ruleState.session.initiative = ruleState.session.initiative.filter(item => !(item.kind === actor.kind && String(item.id) === String(actor.id)))
      if (before === ruleState.session.initiative.length) throw new Error(`${actor.name} 不在先攻列表中`)
      const result = `已从先攻列表移除：${actor.name}`
      return await this.finishDirectBuiltinMutation(e, pack, state, ruleState, "initiative_remove", result, {
        targets: [actor], actions: [{ op: "remove_initiative", target: actor.id }]
      })
    }
    if (["clear", "清空"].includes(action)) {
      if (ruleState.session.current) throw new Error("战斗正在进行，不能直接清空先攻；请先结束先攻")
      const removed = ruleState.session.initiative.map(item => ({ kind: item.kind, id: item.id, name: item.name }))
      ruleState.session.initiative = []
      ruleState.session.current = null
      ruleState.session.round = 0
      ruleState.session.turn = 0
      ruleState.session.phase = ruleState.session.active ? "setup" : "idle"
      return await this.finishDirectBuiltinMutation(e, pack, state, ruleState, "initiative_clear", "先攻列表已清空。", {
        targets: removed, actions: [{ op: "clear_initiative", count: removed.length }]
      })
    }
    if (["start", "开始"].includes(action)) {
      if (!ruleState.session.initiative.length) throw new Error("先攻列表为空")
      if (!ruleState.session.active) throw new Error("正式团务尚未开始；请先执行「团务 开始 标题」")
      if (ruleState.session.paused) throw new Error("团务已暂停；请先执行「团务 恢复」")
      if (ruleState.session.current || ["turn_start", "turn_end", "round_start", "round_end"].includes(ruleState.session.phase)) {
        throw new Error("战斗先攻已经开始，重复开始会重复结算生命周期；请使用「先攻 下一回合」或先结束")
      }
      ruleState.session.initiative.sort((a, b) => b.value - a.value || a.name.localeCompare(b.name, "zh-CN"))
      ruleState.session.round = 1
      ruleState.session.turn = 1
      ruleState.session.phase = "turn_start"
      ruleState.session.current = { ...ruleState.session.initiative[0] }
      const shared = this.buildGroupStored(pack, ruleState, { card: e?.sender?.card || "", nickname: e?.sender?.nickname || "" })
      const runtimes = []
      const currentRuntime = this.getOrCreateLifecycleRuntime(runtimes, state, e, pack, ruleState, this.initiativeActor(ruleState.session.current), shared)
      await this.runRuleEvent(pack, "round_start", currentRuntime)
      await this.tickInitiativeStatuses(state, e, pack, ruleState, "round_start", shared, runtimes)
      await this.runRuleEvent(pack, "turn_start", currentRuntime)
      this.tickActorAbilities(pack, currentRuntime)
      await this.tickActorStatuses(pack, "turn_start", currentRuntime)
      const text = `战斗开始。第 1 轮，${ruleState.session.current.name} 行动。`
      return await this.finishBuiltinBatch(e, pack, state, ruleState, runtimes, "initiative_start", text)
    }
    if (["next", "下一位", "下一个", "下一回合"].includes(action)) {
      if (!ruleState.session.current || !ruleState.session.initiative.length) throw new Error("战斗尚未开始")
      if (ruleState.session.paused) throw new Error("团务已暂停；请先执行「团务 恢复」")
      const shared = this.buildGroupStored(pack, ruleState, { card: e?.sender?.card || "", nickname: e?.sender?.nickname || "" })
      const runtimes = []
      const currentIndex = ruleState.session.initiative.findIndex(item => item.kind === ruleState.session.current.kind && String(item.id) === String(ruleState.session.current.id))
      const oldRuntime = this.getOrCreateLifecycleRuntime(runtimes, state, e, pack, ruleState, this.initiativeActor(ruleState.session.current), shared)
      ruleState.session.phase = "turn_end"
      await this.runRuleEvent(pack, "turn_end", oldRuntime)
      await this.tickActorStatuses(pack, "turn_end", oldRuntime)
      const wrapped = currentIndex < 0 || currentIndex >= ruleState.session.initiative.length - 1
      if (wrapped) {
        ruleState.session.phase = "round_end"
        await this.runRuleEvent(pack, "round_end", oldRuntime)
        await this.tickInitiativeStatuses(state, e, pack, ruleState, "round_end", shared, runtimes)
        ruleState.session.round = Math.max(1, Number(ruleState.session.round) || 1) + 1
      }
      const nextIndex = wrapped ? 0 : currentIndex + 1
      ruleState.session.turn = Math.max(0, Number(ruleState.session.turn) || 0) + 1
      ruleState.session.current = { ...ruleState.session.initiative[nextIndex] }
      const nextRuntime = this.getOrCreateLifecycleRuntime(runtimes, state, e, pack, ruleState, this.initiativeActor(ruleState.session.current), shared)
      if (wrapped) {
        ruleState.session.phase = "round_start"
        await this.runRuleEvent(pack, "round_start", nextRuntime)
        await this.tickInitiativeStatuses(state, e, pack, ruleState, "round_start", shared, runtimes)
      }
      ruleState.session.phase = "turn_start"
      await this.runRuleEvent(pack, "turn_start", nextRuntime)
      this.tickActorAbilities(pack, nextRuntime)
      await this.tickActorStatuses(pack, "turn_start", nextRuntime)
      const text = `${wrapped ? `第 ${ruleState.session.round} 轮开始。` : ""}${ruleState.session.current.name} 行动。`
      return await this.finishBuiltinBatch(e, pack, state, ruleState, runtimes, "initiative_next", text)
    }
    if (["end", "stop", "结束"].includes(action)) {
      ruleState.session.current = null
      ruleState.session.phase = ruleState.session.active ? "setup" : "idle"
      const runtime = this.createLifecycleRuntime(state, e, pack, ruleState, selfActor(e))
      return await this.finishBuiltinMutation(e, pack, state, ruleState, runtime, "initiative_end", "战斗先攻已结束，列表仍保留。")
    }
    throw new Error("先攻命令：先攻 列表 / 添加 <目标> <值> / 删除 <目标> / 开始 / 下一回合 / 结束 / 清空")
  }

  formatActorStatuses(pack, draft) {
    const rows = Object.entries(draft.stored.statuses || {}).map(([id, value]) => {
      const definition = pack.statuses?.[id] || {}
      return `${definition.label || id}(${id})：层数 ${value.stacks || 1}，持续 ${value.duration ?? "永久"}`
    })
    return `${draft.actor.name} 的状态：\n${rows.join("\n") || "无"}`
  }

  async handleStatusOperation(e, pack, raw) {
    const config = this.diceManager.getConfig()
    const state = this.diceManager.readState(config)
    const ruleState = ensureRuleGroupState(state, e?.group_id, pack.id)
    const tokens = parseQuotedTokens(raw)
    const action = String(tokens.shift() || "list").toLowerCase()
    if (["list", "show", "列表", "查看"].includes(action)) {
      const selector = tokens.shift() || "self"
      const actor = await resolveRuleActor(e, selector, ruleState, ["self", "member", "npc"])
      const draft = this.getEntityDraft(state, e, pack, ruleState, actor)
      return this.formatActorStatuses(pack, draft)
    }
    requireRulePermission(e, ruleState, "gm")
    const selector = tokens.shift()
    if (!selector) throw new Error("请指定目标")
    const actor = await resolveRuleActor(e, selector, ruleState, ["self", "member", "npc"])
    const runtime = this.createLifecycleRuntime(state, e, pack, ruleState, actor)
    if (["add", "添加", "施加"].includes(action)) {
      const status = tokens.shift()
      if (!pack.statuses?.[status]) throw new Error(`未知状态：${status || ""}`)
      const duration = tokens[0] === undefined ? undefined : Number(tokens.shift())
      const stacks = tokens[0] === undefined ? undefined : Number(tokens.shift())
      if (duration !== undefined && (!Number.isInteger(duration) || duration < 1)) throw new Error("持续时间必须是正整数")
      if (stacks !== undefined && (!Number.isInteger(stacks) || stacks < 1)) throw new Error("层数必须是正整数")
      await this.applyActionList(pack, [{ op: "add_status", status, ...(duration === undefined ? {} : { duration }), ...(stacks === undefined ? {} : { stacks }) }], runtime)
      const current = runtime.actorDraft.stored.statuses[status]
      const text = `已给 ${actor.name} 添加状态 ${pack.statuses[status].label || status}：层数 ${current.stacks}，持续 ${current.duration ?? "永久"}`
      return await this.finishBuiltinMutation(e, pack, state, ruleState, runtime, "status_add", text)
    }
    if (["remove", "delete", "删除", "解除"].includes(action)) {
      const status = tokens.shift()
      if (!runtime.actorDraft.stored.statuses?.[status]) throw new Error(`${actor.name} 没有状态 ${status || ""}`)
      await this.applyActionList(pack, [{ op: "remove_status", status }], runtime)
      const text = `已移除 ${actor.name} 的状态 ${pack.statuses?.[status]?.label || status}`
      return await this.finishBuiltinMutation(e, pack, state, ruleState, runtime, "status_remove", text)
    }
    if (["tick", "结算", "推进"].includes(action)) {
      await this.tickActorStatuses(pack, "manual", runtime)
      const text = `已结算 ${actor.name} 的手动状态。\n${this.formatActorStatuses(pack, runtime.actorDraft)}`
      return await this.finishBuiltinMutation(e, pack, state, ruleState, runtime, "status_tick", text)
    }
    throw new Error("状态命令：状态 列表 [目标] / 添加 <目标> <状态> [持续] [层数] / 删除 <目标> <状态> / 结算 <目标>")
  }

  formatActorInventory(pack, draft) {
    const rows = Object.entries(draft.stored.inventory || {}).filter(([, value]) => Number(value.quantity) > 0).map(([id, value]) => {
      const definition = pack.items?.[id] || {}
      return `${definition.label || id}(${id}) x${value.quantity}${value.equipped ? ` [已装备${definition.slot ? `:${definition.slot}` : ""}]` : ""}`
    })
    return `${draft.actor.name} 的物品：\n${rows.join("\n") || "无"}`
  }

  async handleItemOperation(e, pack, raw) {
    const config = this.diceManager.getConfig()
    const state = this.diceManager.readState(config)
    const ruleState = ensureRuleGroupState(state, e?.group_id, pack.id)
    const tokens = parseQuotedTokens(raw)
    const action = String(tokens.shift() || "list").toLowerCase()
    if (["list", "show", "列表", "查看"].includes(action)) {
      const actor = await resolveRuleActor(e, tokens.shift() || "self", ruleState, ["self", "member", "npc"])
      return this.formatActorInventory(pack, this.getEntityDraft(state, e, pack, ruleState, actor))
    }
    const selector = tokens.shift()
    const item = tokens.shift()
    if (!selector || !pack.items?.[item]) throw new Error("请指定有效目标和物品 ID")
    const actor = await resolveRuleActor(e, selector, ruleState, ["self", "member", "npc"])
    const runtime = this.createLifecycleRuntime(state, e, pack, ruleState, actor)
    const operation = { add: "add_item", 添加: "add_item", remove: "remove_item", delete: "remove_item", 删除: "remove_item", equip: "equip", 装备: "equip", unequip: "unequip", 卸下: "unequip", use: "use_item", 使用: "use_item" }[action]
    if (!operation) throw new Error("物品命令：物品 列表 [目标] / 添加 <目标> <物品> [数量] / 删除 / 装备 / 卸下 / 使用")
    if (!actor.self || ["add_item", "remove_item"].includes(operation)) requireRulePermission(e, ruleState, "gm")
    const quantity = tokens[0] === undefined ? undefined : Number(tokens.shift())
    if (quantity !== undefined && (!Number.isInteger(quantity) || quantity < 1)) throw new Error("数量必须是正整数")
    const definition = pack.items[item]
    if (operation === "use_item") {
      const current = runtime.actorDraft.stored.inventory?.[item]
      if (!current || Number(current.quantity) < 1) throw new Error(`没有可使用的 ${definition.label || item}`)
      if (definition.on_use?.length) await this.applyActionList(pack, definition.on_use, runtime)
      if (definition.consumable === true) await this.applyActionList(pack, [{ op: "remove_item", item, quantity: 1 }], runtime)
      runtime.auditActions.push({ op: "use_item", scope: "actor", target: sanitizeAuditValue(actor), field: item, before: current.quantity, after: definition.consumable === true ? current.quantity - 1 : current.quantity })
    } else {
      const beforeEquipped = runtime.actorDraft.stored.inventory?.[item]?.equipped === true
      if (operation === "equip" && beforeEquipped) throw new Error(`${definition.label || item} 已经装备`)
      if (operation === "unequip" && !beforeEquipped) throw new Error(`${definition.label || item} 尚未装备`)
      await this.applyActionList(pack, [{ op: operation, item, ...(quantity === undefined ? {} : { quantity }) }], runtime)
      const hook = operation === "equip" ? definition.on_equip : operation === "unequip" ? definition.on_unequip : null
      if (hook?.length) await this.applyActionList(pack, hook, runtime)
    }
    const text = `${actor.name}：${operation === "add_item" ? "获得" : operation === "remove_item" ? "失去" : operation === "equip" ? "装备" : operation === "unequip" ? "卸下" : "使用"} ${definition.label || item}${quantity ? ` x${quantity}` : ""}`
    return await this.finishBuiltinMutation(e, pack, state, ruleState, runtime, `item_${operation}`, text)
  }

  formatActorAbilities(pack, draft) {
    const rows = Object.entries(draft.stored.abilities || {}).filter(([, value]) => value.learned).map(([id, value]) => {
      const definition = pack.abilities?.[id] || {}
      return `${definition.label || id}(${id})：等级 ${value.rank || 1}，冷却 ${value.cooldown || 0}，使用 ${value.uses || 0} 次${definition.kind === "spell" ? " [法术]" : " [技能]"}`
    })
    return `${draft.actor.name} 的技能/法术：\n${rows.join("\n") || "无"}`
  }

  async handleAbilityOperation(e, pack, raw) {
    const config = this.diceManager.getConfig()
    const state = this.diceManager.readState(config)
    const ruleState = ensureRuleGroupState(state, e?.group_id, pack.id)
    const tokens = parseQuotedTokens(raw)
    const action = String(tokens.shift() || "list").toLowerCase()
    if (["list", "show", "列表", "查看"].includes(action)) {
      const actor = await resolveRuleActor(e, tokens.shift() || "self", ruleState, ["self", "member", "npc"])
      return this.formatActorAbilities(pack, this.getEntityDraft(state, e, pack, ruleState, actor))
    }
    let selector = "self"
    let ability
    if (["use", "cast", "使用", "施放"].includes(action) && tokens.length === 1) ability = tokens.shift()
    else {
      selector = tokens.shift() || "self"
      ability = tokens.shift()
    }
    if (!pack.abilities?.[ability]) throw new Error(`未知技能或法术：${ability || ""}`)
    const actor = await resolveRuleActor(e, selector, ruleState, ["self", "member", "npc"])
    const useAction = ["use", "cast", "使用", "施放"].includes(action)
    const definition = pack.abilities[ability]
    const resourceFields = definition.resource_scope === "group" ? pack.group?.fields : pack.character?.fields
    const secretResource = definition.resource_field && resourceFields?.[definition.resource_field]?.secret === true
    if (!useAction || !actor.self || secretResource) requireRulePermission(e, ruleState, "gm")
    const runtime = this.createLifecycleRuntime(state, e, pack, ruleState, actor)
    const operation = useAction ? "use_ability" : ["learn", "学习"].includes(action) ? "learn_ability" : ["forget", "遗忘"].includes(action) ? "forget_ability" : ["reset", "重置"].includes(action) ? "reset_ability" : ""
    if (!operation) throw new Error("技能命令：技能 列表 [目标] / 学习 <目标> <能力> [等级] / 遗忘 / 使用 [目标] <能力> / 重置")
    const rank = operation === "learn_ability" && tokens[0] !== undefined ? Number(tokens.shift()) : undefined
    if (rank !== undefined && (!Number.isInteger(rank) || rank < 1)) throw new Error("技能等级必须是正整数")
    await this.applyActionList(pack, [{ op: operation, ability, ...(rank === undefined ? {} : { rank }) }], runtime)
    if (operation === "use_ability" && definition.on_use?.length) await this.applyActionList(pack, definition.on_use, runtime)
    const label = pack.abilities[ability].label || ability
    const verb = operation === "learn_ability" ? "学习" : operation === "forget_ability" ? "遗忘" : operation === "use_ability" ? "使用" : "重置"
    const text = `${actor.name}${verb}了${label}${rank ? `（等级 ${rank}）` : ""}。`
    return await this.finishBuiltinMutation(e, pack, state, ruleState, runtime, `ability_${operation}`, text)
  }

  async handleAuditOperation(e, pack, raw) {
    const state = this.diceManager.readState()
    const ruleState = ensureRuleGroupState(state, e?.group_id, pack.id)
    requireRulePermission(e, ruleState, "gm")
    const count = Math.max(1, Math.min(20, Number(String(raw || "").match(/\d+/)?.[0]) || 5))
    const records = ruleState.audit.slice(-count).reverse()
    if (!records.length) return "当前还没有结构化审计记录。"
    return records.map(record => {
      const rolls = Object.entries(record.rolls || {}).map(([id, value]) => `${id}=${value.detail || value.total}`).join("；")
      const targets = (record.targets || []).map(target => target.name || target.id).join("、") || "无"
      return [
        `[${record.id}] ${String(record.at || "").replace("T", " ").slice(0, 19)}`,
        `命令：${record.command}；执行者：${record.invoker?.name || record.invoker?.id || "未知"}；目标：${targets}`,
        `可见性：${record.visibility || "public"}；种子：${record.seed || "无"}`,
        rolls ? `骰点：${rolls}` : "",
        record.opposed ? `对抗：${JSON.stringify(record.opposed)}` : "",
        `动作数：${record.actions?.length || 0}；结果：${record.result || "无"}`
      ].filter(Boolean).join("\n")
    }).join("\n\n")
  }

  async executeInvocation(e, invocation) {
    const pack = invocation.pack
    const rest = invocation.rest
    if (!rest) {
      return [
        `${pack.name}（.${invocation.prefix}）`,
        ...pack.commands.map(command => `.${invocation.prefix} ${command.aliases[0]}${(command.arguments || []).map(arg => ` <${arg.label || arg.id}>`).join("")} - ${command.description || command.label || command.id}`),
        `人物卡：.${invocation.prefix} 卡 [目标] / 设 [目标] field=value / 查 [目标] field / 删 [目标] field`,
        `团务：权限 / npc / 群卡 / 群设 / 群查 / 战役 / 团务 / 先攻 / 状态 / 物品 / 技能 / 审计 / 投递`,
        ...(pack.identity?.sync_group_card === true
          ? [`名片同步：发送 .sn on 把数值显示到群名片（需机器人是群管理；.sn off 恢复原名）`]
          : []),
        `战役支持角色登记、章节和记录；团务支持暂停、恢复、历史、快照与回退。`
      ].join("\n")
    }
    const builtins = [
      [BUILTIN_CARD_ALIASES, "card"], [BUILTIN_SET_ALIASES, "set"], [BUILTIN_GET_ALIASES, "get"], [BUILTIN_CLEAR_ALIASES, "clear"]
    ]
    for (const [aliases, operation] of builtins) {
      const matched = matchTextAlias(rest, [...aliases])
      if (matched) return await this.handleCardOperation(e, pack, operation, matched.rest)
    }
    const serviceBuiltins = [
      [BUILTIN_ROLE_ALIASES, raw => this.handleRoleOperation(e, pack, raw)],
      [BUILTIN_NPC_ALIASES, raw => this.handleNpcOperation(e, pack, raw)],
      [BUILTIN_GROUP_CARD_ALIASES, raw => this.handleGroupFieldOperation(e, pack, "card", raw)],
      [BUILTIN_GROUP_SET_ALIASES, raw => this.handleGroupFieldOperation(e, pack, "set", raw)],
      [BUILTIN_GROUP_GET_ALIASES, raw => this.handleGroupFieldOperation(e, pack, "get", raw)],
      [BUILTIN_CAMPAIGN_ALIASES, raw => this.handleCampaignOperation(e, pack, raw)],
      [BUILTIN_SESSION_ALIASES, raw => this.handleSessionOperation(e, pack, raw)],
      [BUILTIN_INITIATIVE_ALIASES, raw => this.handleInitiativeOperation(e, pack, raw)],
      [BUILTIN_STATUS_ALIASES, raw => this.handleStatusOperation(e, pack, raw)],
      [BUILTIN_ITEM_ALIASES, raw => this.handleItemOperation(e, pack, raw)],
      [BUILTIN_ABILITY_ALIASES, raw => this.handleAbilityOperation(e, pack, raw)],
      [BUILTIN_AUDIT_ALIASES, raw => this.handleAuditOperation(e, pack, raw)],
      [BUILTIN_DELIVERY_ALIASES, raw => this.handleDeliveryOperation(e, pack, raw)]
    ]
    for (const [aliases, handler] of serviceBuiltins) {
      const matched = matchTextAlias(rest, [...aliases])
      if (matched) return await handler(matched.rest)
    }
    let commandMatch = null
    for (const command of pack.commands) {
      const matched = matchTextAlias(rest, command.aliases)
      if (!matched) continue
      if (!commandMatch || matched.alias.length > commandMatch.matched.alias.length) commandMatch = { command, matched }
    }
    if (commandMatch) {
      const { command, matched } = commandMatch
      try {
        return await this.executeCommand(e, pack, command, matched.rest)
      } catch (error) {
        if (command.error_output) {
          const text = renderRuleTemplate(command.error_output, { message: error.message }, { strict: false })
          if (text) return text
        }
        throw error
      }
    }
    throw new Error(`没有找到 ${pack.name} 子命令：${rest.split(/\s+/)[0]}。发送 .${invocation.prefix} 查看帮助`)
  }

  async handleDynamicCommand(e) {
    const sealResult = await this.handleSealExtCommand(e)
    if (sealResult.matched) return { matched: true, text: sanitizeRuleOutput(sealResult.text) }
    const invocation = this.findInvocation(e?.group_id || "private", e?.msg)
    if (!invocation) return { matched: false, text: "" }
    const groupKey = String(e?.group_id || "private")
    const task = this.runtimeQueue.run(groupKey, () => withFileLock(
      path.join(this.getRulesDir(), "locks", `runtime-${groupKey.replace(/[^0-9A-Za-z_-]/g, "_")}.lock`),
      () => this.diceManager.withStateTransaction(() => this.executeInvocation(e, invocation))
    ))
    try {
      const result = await task
      if (result && typeof result === "object") return { matched: true, ...result, text: sanitizeRuleOutput(result.text) }
      return { matched: true, text: sanitizeRuleOutput(result) }
    } catch (error) {
      this.logger?.warn?.(`[骰规则] ${packSafe(invocation.pack?.id)} 执行失败: ${error.message}`)
      return { matched: true, text: `这次规则执行失败：${error.message}。本次人物卡、群状态和团务变更都没有按成功提交。` }
    }
  }
}

function packSafe(value) {
  return String(value || "unknown").replace(/[^a-z0-9_-]/gi, "")
}
