import fs from "fs"
import path from "path"
import { createRequire } from "module"
import { withFileLock } from "../../utils/fileLock.js"
import { collectMentionTargetIds, getMentionTargetId, stripCqMentions } from "../../utils/mentionTargets.js"
import { KeyedSerialQueue } from "../../utils/messagePipeline/keyedSerialQueue.js"
import { canManageGroupDice, sanitizeDiceCommandError } from "./diceCommandGateway.js"
import { secureDiceInt, secureDiceRandom } from "../../utils/diceRandom.js"
import {
  DEFAULT_TEMPLATES,
  DEFAULT_CHECK_LEVELS,
  DEFAULT_TEMP_INSANITY,
  DEFAULT_INDEFINITE_INSANITY,
  mergeDiceReplyConfig,
  pickCheckTemplate,
  pickJrrpComment,
  cocRankToCompareRank
} from "./diceReplyCatalog.js"

const require = createRequire(import.meta.url)
let yamlParser = null
try {
  yamlParser = require("yaml")
} catch {}

const DEFAULT_CONFIG = {
  enabled: true,
  customRulesEnabled: true,
  customJsRulesEnabled: true,
  defaultRule: "0",
  maxDiceCount: 100,
  maxDiceSides: 100000,
  maxRounds: 20,
  allowHiddenRoll: true,
  baseDir: "data/dice",
  logAiSilent: true,
  logExportMaxMb: 8,
  timeZone: "Asia/Shanghai",
  templates: { ...DEFAULT_TEMPLATES }
}

const ATTR_ALIASES = {
  力量: "STR", str: "STR", STR: "STR",
  体质: "CON", con: "CON", CON: "CON",
  体型: "SIZ", siz: "SIZ", SIZ: "SIZ",
  敏捷: "DEX", dex: "DEX", DEX: "DEX",
  外貌: "APP", app: "APP", APP: "APP",
  智力: "INT", int: "INT", INT: "INT",
  意志: "POW", pow: "POW", POW: "POW",
  教育: "EDU", edu: "EDU", EDU: "EDU",
  幸运: "LUCK", luck: "LUCK", LUCK: "LUCK",
  理智: "SAN", san: "SAN", SAN: "SAN",
  hp: "HP", HP: "HP", mp: "MP", MP: "MP"
}

const DND_ATTRS = ["力量", "敏捷", "体质", "智力", "感知", "魅力"]
const COC_PRIMARY_ATTRS = ["STR", "CON", "SIZ", "DEX", "APP", "INT", "POW", "EDU"]
const COC_DISPLAY_ATTRS = [...COC_PRIMARY_ATTRS, "LUCK", "SAN", "HP", "MP"]
const COC_ATTR_LABELS = {
  STR: "力量",
  CON: "体质",
  SIZ: "体型",
  DEX: "敏捷",
  APP: "外貌",
  INT: "智力",
  POW: "意志",
  EDU: "教育",
  LUCK: "幸运",
  SAN: "理智",
  HP: "体力",
  MP: "魔法"
}
const DND_NAMES = [
  "Alden", "Bran", "Cedric", "Daria", "Elara", "Finn", "Garrick", "Helena",
  "Iris", "Joran", "Kael", "Lyra", "Mira", "Nolan", "Orin", "Rhea",
  "Seren", "Talia", "Ulric", "Vera"
]

// .name 随机姓名库（中/英/日）
const NAME_BANKS = {
  zh: {
    label: "中文",
    first: "伟芳娜秀敏静丽强磊军洋勇艳杰娟涛明超霞平刚玉兰凤洁梅琳云莲真雪荣佳嘉琼勤珍贞莉璐娅琦晶妍茜秋珊莎锦青倩婷婉娴瑾颖露瑶怡雁蓓仪荷丹蓉眉君琴蕊薇菁梦岚苑婕馨瑗韵融园艺咏卿聪澜纯毓悦昭冰爽琬茗羽希宁欣飘育滢馥筠柔竹凝晓欢霄枫芸菲寒伊亚宜可姬舒影荔枝思".split(""),
    last: "王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾萧田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦付方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤常乔贺赖龚文".split("")
  },
  en: {
    label: "英文",
    first: ["James", "Mary", "Robert", "Patricia", "John", "Jennifer", "Michael", "Linda", "David", "Elizabeth", "William", "Susan", "Richard", "Jessica", "Joseph", "Sarah", "Thomas", "Karen", "Charles", "Lisa", "Daniel", "Nancy", "Matthew", "Betty", "Anthony", "Sandra", "Mark", "Ashley", "Steven", "Emily", "Andrew", "Donna", "Joshua", "Michelle", "Kevin", "Carol", "Brian", "Amanda", "George", "Melissa", "Timothy", "Deborah", "Ronald", "Stephanie", "Jason", "Rebecca", "Edward", "Sharon", "Jeffrey", "Laura"],
    last: ["Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller", "Davis", "Wilson", "Anderson", "Taylor", "Thomas", "Moore", "Jackson", "Martin", "Lee", "Thompson", "White", "Harris", "Clark", "Lewis", "Robinson", "Walker", "Young", "Allen", "King", "Wright", "Scott", "Green", "Baker", "Adams", "Nelson", "Hill", "Campbell", "Mitchell", "Roberts", "Carter", "Phillips", "Evans", "Turner", "Parker", "Collins", "Edwards", "Stewart", "Morris", "Murphy", "Cook", "Rogers", "Peterson", "Cooper"]
  },
  jp: {
    label: "日文",
    last: ["佐藤", "鈴木", "高橋", "田中", "渡辺", "伊藤", "山本", "中村", "小林", "加藤", "吉田", "山田", "佐々木", "中野", "松本", "井上", "木村", "林", "斎藤", "清水", "山口", "森", "阿部", "池田", "橋本", "石川", "山下", "中島", "石井", "小川", "藤田", "岡田", "村上", "長谷川", "近藤", "藤井", "青木", "福田", "西村", "藤本"],
    first: ["太郎", "花子", "一郎", "美咲", "健太", "陽菜", "翔太", "さくら", "大輔", "愛", "悠真", "結衣", "蓮", "陽菜", "樹", "芽衣", "翼", "千夏", "奏太", "美月", "和也", "朋美", "亮介", "由美", "拓海", "彩", "駿", "凛", "颯太", "智子", "陽介", "麻衣", "裕樹", "千尋", "淳", "奈々", "孝史", "美穂", "剛", "杏"]
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function normalizeStateShape(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("数据根节点不是对象")
  if (data.users !== undefined && (!data.users || typeof data.users !== "object" || Array.isArray(data.users))) throw new Error("users 字段损坏")
  if (data.groups !== undefined && (!data.groups || typeof data.groups !== "object" || Array.isArray(data.groups))) throw new Error("groups 字段损坏")
  return { version: 1, ...data, users: data.users || {}, groups: data.groups || {} }
}

function readStateFile(file) {
  return normalizeStateShape(JSON.parse(fs.readFileSync(file, "utf8")))
}

function safeNumber(value, fallback, min, max) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, num))
}

function rollInt(sides) {
  return secureDiceInt(sides)
}

function renderTemplate(template, values = {}) {
  return String(template || "").replace(/\{([A-Za-z0-9_]+)\}/g, (_, key) => {
    const value = values[key]
    return value === undefined || value === null ? "" : String(value)
  })
}

function parseScalar(value = "") {
  const raw = String(value || "").trim()
  if (raw === "true") return true
  if (raw === "false") return false
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw)
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"')
  }
  return raw
}

function parseDiceSystemConfig(text = "") {
  const lines = String(text || "").split(/\r?\n/)
  const start = lines.findIndex(line => /^\s*diceSystem\s*:\s*$/.test(line))
  if (start < 0) return {}
  const baseIndent = lines[start].match(/^\s*/)?.[0].length || 0
  const config = {}
  let section = null
  const readBlock = (index, parentIndent) => {
    const block = []
    let next = index + 1
    for (; next < lines.length; next += 1) {
      const blockLine = lines[next]
      const indent = blockLine.match(/^\s*/)?.[0].length || 0
      if (blockLine.trim() && indent <= parentIndent) break
      block.push(blockLine.slice(Math.min(indent, parentIndent + 2)))
    }
    return { value: block.join("\n").replace(/\n$/, ""), next: next - 1 }
  }
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith("#")) continue
    const indent = line.match(/^\s*/)?.[0].length || 0
    if (indent <= baseIndent) break
    const trimmed = line.trim()
    const m = trimmed.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/)
    if (!m) continue
    if (indent === baseIndent + 2) {
      section = null
      if (m[1] === "templates" && !m[2]) {
        config.templates = config.templates || {}
        section = "templates"
      } else if (/^[>|]/.test(m[2].trim())) {
        const block = readBlock(i, indent)
        config[m[1]] = block.value
        i = block.next
      } else {
        config[m[1]] = parseScalar(m[2])
      }
    } else if (section === "templates" && indent >= baseIndent + 4) {
      config.templates = config.templates || {}
      if (/^[>|]/.test(m[2].trim())) {
        const block = readBlock(i, indent)
        config.templates[m[1]] = block.value
        i = block.next
      } else {
        config.templates[m[1]] = parseScalar(m[2])
      }
    }
  }
  return config
}

function normalizeSkillName(name = "") {
  return String(name || "").trim().replace(/[：:=]\s*\d+$/, "").trim()
}

function formatUpdates(updates = []) {
  return updates.map(([k, v]) => `${k}=${v}`).join("，")
}

function todayKey(date = new Date(), timeZone = DEFAULT_CONFIG.timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date)
    const get = type => parts.find(part => part.type === type)?.value
    return `${get("year")}-${get("month")}-${get("day")}`
  } catch {
    return date.toISOString().slice(0, 10)
  }
}

function normalizeDiceExpression(expr = "") {
  return String(expr || "1d100")
    .replace(/[！-～]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xFEE0))
    .replace(/[＋﹢]/g, "+")
    .replace(/[－﹣]/g, "-")
    .replace(/[＊×]/g, "*")
    .replace(/[／÷]/g, "/")
    .replace(/[％]/g, "%")
    .replace(/[（]/g, "(")
    .replace(/[）]/g, ")")
    .replace(/\bmod\b/gi, "%")
    .replace(/\s+/g, "")
    .toLowerCase()
}

class DiceExpressionParser {
  constructor(expr, config, random = secureDiceRandom) {
    this.expr = normalizeDiceExpression(expr)
    this.config = config
    this.random = typeof random === "function" ? random : secureDiceRandom
    this.pos = 0
    this.diceCount = 0
    this.detailParts = []
  }

  peek() {
    return this.expr[this.pos] || ""
  }

  consume(char) {
    if (this.peek() === char) {
      this.pos += 1
      return true
    }
    return false
  }

  readNumber() {
    const start = this.pos
    while (/\d/.test(this.peek())) this.pos += 1
    if (start === this.pos) return null
    return Number(this.expr.slice(start, this.pos))
  }

  parse() {
    if (!this.expr) throw new Error("骰点表达式不能为空")
    const value = this.parseExpression()
    if (this.pos !== this.expr.length) {
      throw new Error(`骰点表达式在「${this.expr.slice(this.pos)}」附近格式不正确`)
    }
    if (!Number.isFinite(value)) throw new Error("骰点结果无效")
    return {
      expr: this.expr.toUpperCase(),
      detail: this.detailParts.length ? this.detailParts.join("+") : String(Math.trunc(value)),
      total: Math.trunc(value)
    }
  }

  parseExpression() {
    let value = this.parseTerm()
    while (true) {
      if (this.consume("+")) value += this.parseTerm()
      else if (this.consume("-")) value -= this.parseTerm()
      else break
    }
    return value
  }

  parseTerm() {
    let value = this.parseUnary()
    while (true) {
      if (this.consume("*")) value *= this.parseUnary()
      else if (this.consume("/")) {
        const right = this.parseUnary()
        if (right === 0) throw new Error("骰点表达式不能除以 0")
        value /= right
      } else if (this.consume("%")) {
        const right = this.parseUnary()
        if (right === 0) throw new Error("骰点表达式不能对 0 取余")
        value %= right
      } else break
    }
    return value
  }

  parseUnary() {
    if (this.consume("+")) return this.parseUnary()
    if (this.consume("-")) return -this.parseUnary()
    return this.parsePrimary()
  }

  parsePrimary() {
    if (this.consume("(")) {
      const value = this.parseExpression()
      if (!this.consume(")")) throw new Error("括号未闭合")
      return value
    }
    const number = this.readNumber()
    if (this.consume("d")) return this.parseDice(number || 1)
    if (number !== null) return number
    if (this.peek() === "d") {
      this.pos += 1
      return this.parseDice(1)
    }
    throw new Error(`骰点表达式在「${this.expr.slice(this.pos)}」附近格式不正确`)
  }

  parseDice(count) {
    const sides = this.readNumber()
    if (!Number.isInteger(sides)) throw new Error("骰子面数不能为空")
    if (!Number.isInteger(count) || count < 1 || count > this.config.maxDiceCount) throw new Error(`骰子数量必须是 1-${this.config.maxDiceCount}`)
    if (sides < 2 || sides > this.config.maxDiceSides) throw new Error(`骰子面数必须是 2-${this.config.maxDiceSides}`)
    this.diceCount += count
    if (this.diceCount > this.config.maxDiceCount) throw new Error(`单次最多掷 ${this.config.maxDiceCount} 颗骰子`)

    const rolls = Array.from({ length: count }, () => Math.floor(this.random() * sides) + 1)
    const suffix = this.parseDiceSuffix(count)
    let kept = [...rolls]
    let suffixText = ""
    if (suffix) {
      const sortedAsc = [...rolls].sort((a, b) => a - b)
      const n = Math.min(count, Math.max(0, suffix.n))
      if (suffix.type === "kh") kept = sortedAsc.slice(-n)
      if (suffix.type === "kl") kept = sortedAsc.slice(0, n)
      if (suffix.type === "dh") kept = sortedAsc.slice(0, Math.max(0, count - n))
      if (suffix.type === "dl") kept = sortedAsc.slice(n)
      if (suffix.type === "min") kept = rolls.map(v => Math.max(v, n))
      if (suffix.type === "max") kept = rolls.map(v => Math.min(v, n))
      suffixText = suffix.raw.toUpperCase()
    }
    const total = kept.reduce((sum, value) => sum + value, 0)
    const keptText = suffix ? `=>${kept.join("+")}` : ""
    this.detailParts.push(`${count}D${sides}${suffixText}[${rolls.join("+")}${keptText}]`)
    return total
  }

  parseDiceSuffix(count) {
    const rest = this.expr.slice(this.pos)
    const match = rest.match(/^(kh|kl|dh|dl|min|max)(\d*)/)
    if (!match) return null
    const raw = match[0]
    this.pos += raw.length
    const defaultN = match[1] === "kh" || match[1] === "kl" || match[1] === "dh" || match[1] === "dl" ? 1 : count
    return { type: match[1], n: match[2] ? Number(match[2]) : defaultN, raw }
  }
}

export class DiceManager {
  constructor({ cwd = process.cwd(), logger = globalThis.logger } = {}) {
    this.cwd = cwd
    this.logger = logger
    this.writeChain = Promise.resolve()
    this.stateQueue = new KeyedSerialQueue()
  }

  getConfig() {
    const userPath = path.join(this.cwd, "plugins/shiloh-plugin/config/message.yaml")
    const defaultPath = path.join(this.cwd, "plugins/shiloh-plugin/config_default/message.yaml")
    const configPath = fs.existsSync(userPath) ? userPath : defaultPath
    let raw = {}
    try {
      const text = fs.readFileSync(configPath, "utf8")
      raw = yamlParser?.parse
        ? (yamlParser.parse(text)?.pluginSettings?.diceSystem || {})
        : parseDiceSystemConfig(text)
    } catch (error) {
      this.logger?.warn?.(`[骰娘] 读取配置失败: ${error.message}`)
    }
    const merged = mergeDiceReplyConfig(raw)
    return {
      ...DEFAULT_CONFIG,
      ...raw,
      templates: merged.templates,
      checkLevels: merged.checkLevels,
      insanityTables: merged.insanityTables,
      maxDiceCount: safeNumber(raw.maxDiceCount, DEFAULT_CONFIG.maxDiceCount, 1, 10000),
      maxDiceSides: safeNumber(raw.maxDiceSides, DEFAULT_CONFIG.maxDiceSides, 2, 100000000),
      maxRounds: safeNumber(raw.maxRounds, DEFAULT_CONFIG.maxRounds, 1, 1000),
      logExportMaxMb: safeNumber(raw.logExportMaxMb, DEFAULT_CONFIG.logExportMaxMb, 1, 100),
      allowHiddenRoll: raw.allowHiddenRoll !== false
    }
  }

  getDataDir(config = this.getConfig()) {
    return path.isAbsolute(config.baseDir)
      ? config.baseDir
      : path.join(this.cwd, "plugins/shiloh-plugin", config.baseDir)
  }

  getDataPath(config = this.getConfig()) {
    return path.join(this.getDataDir(config), "state.json")
  }

  getLogDir(groupId, config = this.getConfig()) {
    return path.join(this.getDataDir(config), "logs", String(groupId || "private"))
  }

  readState(config = this.getConfig()) {
    const file = this.getDataPath(config)
    if (!fs.existsSync(file)) return { version: 1, users: {}, groups: {} }
    try {
      return readStateFile(file)
    } catch (error) {
      this.logger?.warn?.(`[骰娘] 读取数据失败: ${error.message}`)
      const backup = `${file}.bak`
      if (fs.existsSync(backup)) {
        try {
          const recovered = readStateFile(backup)
          this.logger?.warn?.("[骰娘] 已从 state.json.bak 读取最近一次有效状态；下一次写入会隔离损坏文件。")
          return recovered
        } catch (backupError) {
          this.logger?.error?.(`[骰娘] 备份数据也无法读取: ${backupError.message}`)
        }
      }
      throw new Error("骰娘状态文件损坏，且没有可用备份；为防止覆盖原数据，本次操作已停止")
    }
  }

  async writeState(state, config = this.getConfig()) {
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
      const file = this.getDataPath(config)
      ensureDir(path.dirname(file))
      const tmp = `${file}.${process.pid}.tmp`
      const backup = `${file}.bak`
      try {
        fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8")
        readStateFile(tmp)
        if (fs.existsSync(file)) {
          try {
            readStateFile(file)
            const backupTmp = `${backup}.${process.pid}.tmp`
            fs.copyFileSync(file, backupTmp)
            fs.renameSync(backupTmp, backup)
          } catch {
            const corrupt = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`
            fs.renameSync(file, corrupt)
            this.logger?.error?.(`[骰娘] 已隔离损坏状态文件：${path.basename(corrupt)}`)
          }
        }
        fs.renameSync(tmp, file)
      } finally {
        try { fs.rmSync(tmp, { force: true }) } catch {}
      }
    })
    return this.writeChain
  }

  async withStateTransaction(work, config = this.getConfig()) {
    return await this.stateQueue.run("state", () => withFileLock(
      path.join(this.getDataDir(config), "locks", "state.lock"),
      work
    ))
  }

  canManageGroupDice(e) {
    return canManageGroupDice(e)
  }

  isReplyEnabled(e, config = this.getConfig(), state = null) {
    if (!e?.group_id) return true
    const currentState = state || this.readState(config)
    return currentState.groups?.[String(e.group_id)]?.replyEnabled !== false
  }

  getTodayKey(date = new Date(), config = this.getConfig()) {
    return todayKey(date, config.timeZone || DEFAULT_CONFIG.timeZone)
  }

  isLogActive(groupId, config = this.getConfig()) {
    if (!groupId || !config.enabled || config.logAiSilent === false) return false
    return this.isLogRecording(groupId, config)
  }

  isLogRecording(groupId, config = this.getConfig()) {
    if (!groupId || !config.enabled) return false
    const state = this.readState(config)
    return Boolean(state.groups?.[String(groupId)]?.log?.active)
  }

  formatLogSegment(segment = {}) {
    const type = segment.type || ""
    const data = segment.data || segment
    if (type === "text") return data.text || segment.text || ""
    if (type === "at") return `[@${getMentionTargetId(segment) || ""}]`
    if (type === "face") return `[表情:${data.id || segment.id || ""}]`
    if (type === "image") return `[图片:${data.file || segment.file || data.url || segment.url || ""}]`
    if (type === "record") return `[语音:${data.file || segment.file || ""}]`
    if (type === "video") return `[视频:${data.file || segment.file || ""}]`
    if (type === "reply") return `[回复:${data.id || segment.id || ""}]`
    if (type === "json") return "[JSON卡片]"
    if (type === "xml") return "[XML卡片]"
    return type ? `[${type}]` : ""
  }

  formatLogMessage(e = {}) {
    if (Array.isArray(e.message) && e.message.length) {
      return e.message.map(seg => this.formatLogSegment(seg)).join("").trim()
    }
    return String(e.msg || e.raw_message || "").trim()
  }

  async recordLogMessage(e) {
    const config = this.getConfig()
    if (!config.enabled || !e?.group_id) return
    const groupId = String(e.group_id)
    const state = this.readState(config)
    const log = state.groups?.[groupId]?.log
    if (!log?.active || !log.file) return
    const content = this.formatLogMessage(e)
    if (!content) return
    const sender = e.sender || {}
    const record = {
      at: new Date().toISOString(),
      time: Date.now(),
      groupId,
      userId: String(e.user_id || sender.user_id || ""),
      name: sender.card || sender.nickname || String(e.user_id || ""),
      messageId: e.message_id || "",
      content
    }
    ensureDir(path.dirname(log.file))
    await fs.promises.appendFile(log.file, JSON.stringify(record) + "\n", "utf8")
  }

  async recordStructuredRuleEvent(e, event = {}, state = null, config = this.getConfig()) {
    if (!config.enabled || !e?.group_id) return false
    const groupId = String(e.group_id)
    const currentState = state || this.readState(config)
    const log = currentState.groups?.[groupId]?.log
    if (!log?.active || !log.file) return false
    const sender = e.sender || {}
    const record = {
      at: new Date().toISOString(),
      time: Date.now(),
      type: "dice_rule",
      groupId,
      userId: String(e.user_id || sender.user_id || ""),
      name: sender.card || sender.nickname || String(e.user_id || ""),
      messageId: e.message_id || "",
      ...event
    }
    ensureDir(path.dirname(log.file))
    await fs.promises.appendFile(log.file, JSON.stringify(record) + "\n", "utf8")
    return true
  }

  async startLog(e, raw = "") {
    const config = this.getConfig()
    const state = this.readState(config)
    const result = this.prepareStartLog(e, state, raw, config)
    if (result.changed) await this.writeState(state, config)
    return result.text
  }

  prepareStartLog(e, state, raw = "", config = this.getConfig(), { authorized = false } = {}) {
    if (!config.enabled) return { changed: false, text: "骰娘模块现在没开。", log: null }
    if (!e?.group_id) return { changed: false, text: "log 只能在群聊中开启。", log: null }
    if (!authorized && !this.canManageGroupDice(e)) {
      return { changed: false, text: renderTemplate(config.templates.logPermDenied, { action: "开启" }), log: null }
    }
    const groupId = String(e.group_id)
    state.groups[groupId] ||= {}
    state.groups[groupId].logs ||= []
    const current = state.groups[groupId].log
    if (current?.active) return { changed: false, text: renderTemplate(config.templates.logAlreadyOpen, { title: current.title || "未命名" }), log: current }
    if (current?.file && !state.groups[groupId].logs.some(item => item.file === current.file)) {
      state.groups[groupId].logs.push({ ...current })
    }
    const title = String(raw || "").trim() || `COC-log-${new Date().toISOString().slice(0, 10)}`
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const file = path.join(this.getLogDir(groupId, config), `${stamp}.jsonl`)
    state.groups[groupId].log = {
      active: true,
      title: title.slice(0, 80),
      startedAt: new Date().toISOString(),
      startedBy: String(e.user_id || ""),
      file
    }
    return {
      changed: true,
      log: state.groups[groupId].log,
      text: renderTemplate(config.templates.logStarted, { title: state.groups[groupId].log.title })
    }
  }

  async stopLog(e) {
    const config = this.getConfig()
    const state = this.readState(config)
    const result = this.prepareStopLog(e, state, config)
    if (result.changed) await this.writeState(state, config)
    return result.text
  }

  prepareStopLog(e, state, config = this.getConfig(), { authorized = false } = {}) {
    if (!e?.group_id) return { changed: false, text: "log 只能在群聊中使用。", log: null }
    if (!authorized && !this.canManageGroupDice(e)) {
      return { changed: false, text: renderTemplate(config.templates.logPermDenied, { action: "停止" }), log: null }
    }
    const groupId = String(e.group_id)
    const log = state.groups?.[groupId]?.log
    if (!log?.active) return { changed: false, text: renderTemplate(config.templates.logNotActive), log: null }
    log.active = false
    log.endedAt = new Date().toISOString()
    state.groups[groupId].logs ||= []
    const index = state.groups[groupId].logs.findIndex(item => item.file === log.file)
    if (index >= 0) state.groups[groupId].logs[index] = { ...log }
    else state.groups[groupId].logs.push({ ...log })
    return {
      changed: true,
      log,
      text: renderTemplate(config.templates.logStopped, { title: log.title || "未命名" })
    }
  }

  async handleBotControl(e, raw = "") {
    const text = String(raw || "").trim().toLowerCase()

    // .bot bye / .bot dismiss:真正退群(仅主人或群主/管理员)
    if (/^(bye|dismiss|退出)$/.test(text)) {
      const isMaster = Boolean(e?.isMaster)
      const senderRole = String(e?.sender?.role || "").toLowerCase()
      const isAdmin = senderRole === "admin" || senderRole === "owner"
      if (!isMaster && !isAdmin) {
        return "只有主人或群主/管理员可以让希洛退群。"
      }
      if (!e?.group_id) {
        return "退群只能在群聊中使用。"
      }
      const groupName = e?.group?.group_name || `群${e.group_id}`
      try {
        // 发告别语后退群
        await this.replyText(e, "好的，希洛先走了。有需要再拉我进来～")
        await new Promise(resolve => setTimeout(resolve, 2000))
        const bot = e?.bot || globalThis.Bot
        if (typeof bot?.sendApi === "function") {
          await bot.sendApi("set_group_leave", { group_id: Number(e.group_id) })
          globalThis.logger?.info?.(`[bot] 已退出群 ${groupName}(${e.group_id})，操作者=${e?.sender?.card || e?.sender?.nickname || e?.user_id}`)
        } else {
          return "当前适配器不支持退群操作。"
        }
        return "" // 已发告别语,不再重复回复
      } catch (error) {
        globalThis.logger?.warn?.(`[bot] 退群失败: ${error?.message || error}`)
        return `退群没成功：${error?.message || error}`
      }
    }

    if (/^(on|off|开启|关闭)/.test(text) || !text) {
      return "希洛不是独立骰娘实例，`.bot on/off` 已做兼容响应。\n`.bot bye` 可以让希洛退出当前群（仅主人或群主/管理员）。"
    }
    return "bot 命令：.bot on / .bot off / .bot bye（退群，需主人或管理员）"
  }

  async replyText(e, text) {
    if (typeof e?.reply === "function") {
      await e.reply(text)
    }
  }

  async handleReplyControl(e, raw = "") {
    const config = this.getConfig()
    const state = this.readState(config)
    const groupId = String(e?.group_id || "private")
    state.groups[groupId] ||= {}
    const text = String(raw || "").trim().toLowerCase()
    if (text && !this.canManageGroupDice(e)) return "只有主人、群主或管理员可以修改 reply 开关。"
    if (/^(on|开启)$/.test(text)) state.groups[groupId].replyEnabled = true
    else if (/^(off|关闭)$/.test(text)) state.groups[groupId].replyEnabled = false
    else return `reply 状态：${state.groups[groupId].replyEnabled === false ? "关闭" : "开启"}`
    await this.writeState(state, config)
    return `reply 已${state.groups[groupId].replyEnabled === false ? "关闭" : "开启"}。`
  }

  handleSendToMaster(e, raw = "") {
    const text = String(raw || "").trim()
    if (!text) return "格式：.send 要转达给主人/管理员的内容"
    return "已收到转达内容。出于安全限制，当前不会自动私发给主人；请改用群管理后台或直接联系管理员。"
  }

  async handleSetOption(e, raw = "") {
    const config = this.getConfig()
    const state = this.readState(config)
    const groupId = String(e?.group_id || "private")
    state.groups[groupId] ||= {}
    const text = String(raw || "").trim()
    if (!text) {
      const group = state.groups[groupId]
      return `当前设置：默认骰 d${group.defaultDiceSides || 100}；规则 ${group.system || "coc"}`
    }
    if (!this.canManageGroupDice(e)) return "只有主人、群主或管理员可以修改当前群骰娘设置。"
    const diceMatch = text.match(/^(?:d|骰子|默认骰)\s*(\d+)$/i) || text.match(/^(\d+)$/)
    if (diceMatch) {
      const sides = Math.max(2, Math.min(100000000, Number(diceMatch[1])))
      state.groups[groupId].defaultDiceSides = sides
      await this.writeState(state, config)
      return `默认骰已设置为 d${sides}。`
    }
    if (/^(coc|coc7|dnd|dnd5e)$/i.test(text)) {
      state.groups[groupId].system = text.toLowerCase()
      await this.writeState(state, config)
      return `当前群规则系统已设置为：${state.groups[groupId].system}`
    }
    return "set 命令：.set d20 / .set coc / .set dnd"
  }

  async handleSn(e, raw = "") {
    const text = String(raw || "").trim()
    if (!e?.group_id) return "自动群名片只能在群聊中使用。"
    const config = this.getConfig()
    const state = this.readState(config)
    const groupId = String(e.group_id)
    const userId = String(e.user_id || e?.sender?.user_id || "")
    state.groups[groupId] ||= {}
    state.groups[groupId].autoCardNames ||= {}
    const current = state.groups[groupId].autoCardNames[userId]
    if (/^(on|开启)$/i.test(text)) {
      const user = this.ensureUser(state, e)
      const desired = String(user.cards?.[user.activeCard]?.name || user.nickname || e?.sender?.card || e?.sender?.nickname || userId).slice(0, 60)
      try {
        await this.setGroupCardName(e, desired)
      } catch (error) {
        return `自动群名片没有开启：${sanitizeDiceCommandError(error)}`
      }
      state.groups[groupId].autoCardNames[userId] = {
        enabled: true,
        original: current?.original || e?.sender?.card || e?.sender?.nickname || "",
        updatedAt: new Date().toISOString()
      }
      await this.writeState(state, config)
      return `自动群名片已开启，当前同步为：${desired}`
    }
    if (/^(off|关闭)$/i.test(text)) {
      if (!current?.enabled) return "自动群名片本来就是关闭的。"
      current.enabled = false
      current.updatedAt = new Date().toISOString()
      await this.writeState(state, config)
      let suffix = ""
      if (current.original) {
        try {
          await this.setGroupCardName(e, current.original)
          suffix = `，并恢复为：${current.original}`
        } catch (error) {
          suffix = `；自动同步已关闭，但原名恢复失败：${sanitizeDiceCommandError(error)}`
        }
      }
      return `自动群名片已关闭${suffix}`
    }
    return `自动群名片：${current?.enabled ? "开启" : "关闭"}\n命令：.sn on / .sn off`
  }

  async setGroupCardName(e, name, userId = e?.user_id || e?.sender?.user_id) {
    if (!e?.group_id) throw new Error("不在群聊中")
    const card = String(name || "").trim().slice(0, 60)
    if (!card) throw new Error("群名片不能为空")
    const bot = e?.bot || globalThis.Bot
    if (typeof bot?.sendApi !== "function") throw new Error("当前 QQ 适配器没有修改群名片的接口")
    const result = await bot.sendApi("set_group_card", {
      group_id: Number(e.group_id),
      user_id: Number(userId),
      card
    })
    if (!result || result.status === "failed" || (result.retcode !== undefined && Number(result.retcode) !== 0)) {
      throw new Error(result?.wording || result?.msg || "QQ 平台没有返回成功回执；请确认机器人具有群管理权限")
    }
    return true
  }

  isAutoCardNameEnabled(state, e) {
    return state?.groups?.[String(e?.group_id || "")]?.autoCardNames?.[String(e?.user_id || e?.sender?.user_id || "")]?.enabled === true
  }

  async syncAutoGroupCard(e, name, state = null, config = this.getConfig()) {
    if (!e?.group_id) return ""
    const currentState = state || this.readState(config)
    if (!this.isAutoCardNameEnabled(currentState, e)) return ""
    try {
      await this.setGroupCardName(e, name)
      return `\n群名片已同步为：${String(name).slice(0, 60)}`
    } catch (error) {
      return `\n人物卡已更新，但群名片同步失败：${sanitizeDiceCommandError(error)}`
    }
  }

  // 规则包想同步名片但用户没 .sn on 时,给一次性引导(每个用户每群只提示一次)
  async buildGroupCardSyncHint(e) {
    if (!e?.group_id) return ""
    const hint = await this.withStateTransaction(() => {
      const config = this.getConfig()
      const state = this.readState(config)
      const groupId = String(e.group_id)
      const userId = String(e.user_id || e?.sender?.user_id || "")
      if (!userId) return ""
      state.groups[groupId] ||= {}
      state.groups[groupId].autoCardNames ||= {}
      const entry = state.groups[groupId].autoCardNames[userId] ||= {}
      if (entry.enabled || entry.cardHintShown) return ""
      entry.cardHintShown = true
      this.writeState(state, config)
      return true
    })
    return hint
      ? "\n提示：发送 .sn on 可开启群名片自动同步，数值变化会实时显示到名片上（需机器人是群管理；.sn off 恢复原名）。"
      : ""
  }

  handleFind(e, raw = "") {
    const key = String(raw || "").trim()
    if (!key) return "格式：.find 关键词"
    const files = [
      path.join(this.cwd, "plugins/shiloh-plugin/database/knowledge-base.txt"),
      path.join(this.cwd, "plugins/shiloh-plugin/database_default/knowledge-base.txt"),
      path.join(this.cwd, "database_default/knowledge-base.txt")
    ]
    const file = files.find(item => fs.existsSync(item))
    if (!file) return "当前没有可搜索的词条库。"
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(line => line.includes(key)).slice(0, 5)
    if (!lines.length) return `没有找到包含「${key}」的词条。`
    return `找到 ${lines.length} 条：\n${lines.join("\n")}`.slice(0, 4500)
  }

  handleDnd(e, raw = "") {
    const config = this.getConfig()
    const count = Math.min(config.maxRounds, Math.max(1, Number(normalizeDiceExpression(raw).match(/\d+/)?.[0]) || 1))
    const rows = []
    for (let i = 0; i < count; i += 1) {
      const attrs = DND_ATTRS.map(name => [name, this.rollExpression("4d6kh3", config).total])
      rows.push(`${count > 1 ? `${i + 1}. ` : ""}${attrs.map(([k, v]) => `${k} ${v}`).join(" / ")}`)
    }
    return renderTemplate(config.templates.dnd, { attributes: rows.join("\n") })
  }

  shouldUseDndCheck(e, raw = "") {
    const state = this.readState()
    const groupId = String(e?.group_id || "private")
    const system = state.groups?.[groupId]?.system || ""
    return /^dnd/i.test(system) || /优势|劣势|adv|dis/i.test(String(raw || ""))
  }

  handleDndCheck(e, raw = "") {
    const text = String(raw || "").trim()
    let mode = "普通"
    if (/优势|adv/i.test(text)) mode = "优势"
    if (/劣势|dis/i.test(text)) mode = "劣势"
    const bonus = Number(text.match(/[+\-]\d+/)?.[0] || 0)
    const rolls = [rollInt(20)]
    if (mode !== "普通") rolls.push(rollInt(20))
    const picked = mode === "优势" ? Math.max(...rolls) : mode === "劣势" ? Math.min(...rolls) : rolls[0]
    const label = text.replace(/优势|劣势|adv|dis|[+\-]\d+/gi, "").trim() || "检定"
    return `${this.getUserName(e)} 进行 ${label}：${mode}${mode === "普通" ? "" : `[${rolls.join("/")}]`} 1D20=${picked}${bonus >= 0 ? "+" : ""}${bonus}=${picked + bonus}`
  }

  async handleDndUtility(e, command = "", raw = "") {
    const config = this.getConfig()
    const state = this.readState(config)
    const user = this.ensureUser(state, e)
    const card = user.cards[user.activeCard]
    if (!card.dnd && user.dnd) {
      card.dnd = user.dnd
      delete user.dnd
    }
    card.dnd ||= { buffs: [], spellSlots: {}, deathSaves: { success: 0, failure: 0 } }
    const dnd = card.dnd
    dnd.buffs ||= []
    dnd.spellSlots ||= {}
    dnd.deathSaves ||= { success: 0, failure: 0 }
    const cmd = String(command || "").toLowerCase()
    const text = String(raw || "").trim()
    if (cmd === "buff") {
      if (!text || /^(list|列表)$/i.test(text)) return `当前 Buff：${dnd.buffs.join("，") || "无"}`
      if (this.isCardLocked(card)) return this.lockedCardReply(card)
      if (/^(clr|clear|清空)$/i.test(text)) dnd.buffs = []
      else dnd.buffs.push(text.slice(0, 80))
      await this.writeState(state, config)
      return `当前 Buff：${dnd.buffs.join("，") || "无"}`
    }
    if (cmd === "ss") {
      const m = text.match(/^(\d+)\s+(\d+)(?:\s*\/\s*(\d+))?$/)
      if (m) {
        if (this.isCardLocked(card)) return this.lockedCardReply(card)
        dnd.spellSlots[m[1]] = { current: Number(m[2]), max: Number(m[3] ?? m[2]) }
        await this.writeState(state, config)
      }
      const slots = Object.entries(dnd.spellSlots).map(([lv, value]) => {
        const slot = typeof value === "object" ? value : { current: Number(value) || 0, max: Number(value) || 0 }
        return `${lv}环:${slot.current}/${slot.max}`
      }).join("，") || "未记录"
      return `法术位：${slots}`
    }
    if (cmd === "cast") {
      const level = String(text.match(/\d+/)?.[0] || "")
      if (!level) return "格式：.cast 环数"
      if (this.isCardLocked(card)) return this.lockedCardReply(card)
      const rawSlot = dnd.spellSlots[level]
      const slot = typeof rawSlot === "object" ? rawSlot : { current: Number(rawSlot) || 0, max: Number(rawSlot) || 0 }
      const left = Number(slot.current || 0)
      if (left <= 0) return `${level}环法术位不足。`
      slot.current = left - 1
      dnd.spellSlots[level] = slot
      await this.writeState(state, config)
      return `已消耗 ${level} 环法术位，剩余 ${slot.current}/${slot.max}。`
    }
    if (cmd === "longrest") {
      if (this.isCardLocked(card)) return this.lockedCardReply(card)
      dnd.deathSaves = { success: 0, failure: 0 }
      for (const [level, value] of Object.entries(dnd.spellSlots)) {
        const slot = typeof value === "object" ? value : { current: Number(value) || 0, max: Number(value) || 0 }
        slot.current = slot.max
        dnd.spellSlots[level] = slot
      }
      await this.writeState(state, config)
      return "长休完成：死亡豁免已清空，已记录法术位恢复到上限。"
    }
    if (cmd === "ds") {
      if (this.isCardLocked(card)) return this.lockedCardReply(card)
      const roll = rollInt(20)
      if (roll === 1) dnd.deathSaves.failure += 2
      else if (roll === 20) dnd.deathSaves.success = 3
      else if (roll >= 10) dnd.deathSaves.success += 1
      else dnd.deathSaves.failure += 1
      await this.writeState(state, config)
      return `死亡豁免：1D20=${roll}；成功 ${dnd.deathSaves.success}/3，失败 ${dnd.deathSaves.failure}/3`
    }
    return "DND 命令：.buff / .ss / .cast / .longrest / .ds"
  }

  handleNameDnd(e, raw = "") {
    const count = Math.min(20, Math.max(1, Number(normalizeDiceExpression(raw).match(/\d+/)?.[0]) || 1))
    const names = []
    for (let i = 0; i < count; i += 1) names.push(DND_NAMES[rollInt(DND_NAMES.length) - 1])
    return `DND 随机姓名：${names.join("、")}`
  }

  // .name [zh|en|jp] [数量] - sealdice 随机姓名
  handleName(e, raw = "") {
    const text = String(raw || "").trim()
    let lang = "zh"
    let rest = text
    const langMatch = rest.match(/^(en|english|英文|jp|ja|jpn|日文|日语|zh|cn|chinese|中文)\s*/i)
    if (langMatch) {
      const word = langMatch[1].toLowerCase()
      lang = /^(en|english|英文)/i.test(word) || word === "英文" ? "en" : /^(jp|ja|jpn)/i.test(word) || /日/.test(word) ? "jp" : "zh"
      rest = rest.slice(langMatch[0].length)
    }
    const count = Math.min(20, Math.max(1, Number(rest.match(/\d+/)?.[0]) || 5))
    const bank = NAME_BANKS[lang] || NAME_BANKS.zh
    const names = []
    for (let i = 0; i < count; i += 1) {
      if (lang === "en") {
        names.push(`${bank.first[rollInt(bank.first.length) - 1]} ${bank.last[rollInt(bank.last.length) - 1]}`)
      } else if (lang === "jp") {
        names.push(`${bank.last[rollInt(bank.last.length) - 1]} ${bank.first[rollInt(bank.first.length) - 1]}`)
      } else {
        names.push(`${bank.last[rollInt(bank.last.length) - 1]}${bank.first[rollInt(bank.first.length) - 1]}`)
      }
    }
    return `随机姓名（${bank.label}）：${names.join("、")}`
  }

  // ── 旁观模式（sealdice .obon/.oboff）──
  isObserver(e = {}) {
    if (!e?.group_id) return false
    const group = this.readState().groups?.[String(e.group_id)]
    const userId = String(e?.user_id || e?.sender?.user_id || "")
    return Boolean(userId && (group?.observers || []).includes(userId))
  }

  async handleObserve(e, action = "") {
    const config = this.getConfig()
    if (!e?.group_id) return "旁观模式只能在群聊中使用。"
    const groupId = String(e.group_id)
    const userId = String(e.user_id || e.sender?.user_id || "")
    const name = this.getUserName(e)
    const state = this.readState(config)
    state.groups[groupId] ||= {}
    const group = state.groups[groupId]
    group.observers ||= []
    const text = String(action || "").trim().toLowerCase()
    if (/^(on|obon|进入|加入|旁观)$/.test(text)) {
      if (group.observers.includes(userId)) return `${name} 已经在旁观中了。`
      group.observers.push(userId)
      await this.writeState(state, config)
      return `${name} 已进入旁观模式。之后你的骰点命令会被静默，不再打扰跑团；用 .oboff 恢复。`
    }
    if (/^(off|oboff|exit|退出|取消|恢复)$/.test(text)) {
      if (!group.observers.includes(userId)) return `${name} 当前不在旁观模式。`
      group.observers = group.observers.filter(id => id !== userId)
      await this.writeState(state, config)
      return `${name} 已退出旁观模式，骰点恢复正常。`
    }
    if (/^(list|ls|名单|列表|查看)$/.test(text)) {
      if (!group.observers.length) return "当前群没有旁观者。"
      const names = group.observers.map(id => this.readState().users?.[id]?.nickname || id)
      return `旁观名单（${group.observers.length} 人）：${names.join("、")}`
    }
    if (/^(clr|clear|清空)$/.test(text)) {
      if (!this.canManageGroupDice(e)) return "只有主人、群主或管理员可以清空旁观名单。"
      group.observers = []
      await this.writeState(state, config)
      return "旁观名单已清空。"
    }
    return [
      "旁观模式：",
      ".obon - 进入旁观（我的骰点将被静默）",
      ".oboff - 退出旁观",
      ".ob list - 查看旁观名单",
      ".ob clr - 清空名单（管理员）"
    ].join("\n")
  }

  async handleInitiativeRoll(e, raw = "") {
    const name = this.getUserName(e)
    const bonus = Number(String(raw || "").match(/[+\-]?\d+/)?.[0] || 0)
    const roll = rollInt(20)
    const total = roll + bonus
    if (!e?.group_id) return `${name} 先攻：1D20[${roll}]${bonus >= 0 ? "+" : ""}${bonus}=${total}`
    const config = this.getConfig()
    const state = this.readState(config)
    const groupId = String(e.group_id)
    state.groups[groupId] ||= {}
    state.groups[groupId].initiative ||= []
    const item = { name, value: total, userId: String(e.user_id || "") }
    const index = state.groups[groupId].initiative.findIndex(old => old.userId && old.userId === item.userId)
    if (index >= 0) state.groups[groupId].initiative[index] = item
    else state.groups[groupId].initiative.push(item)
    await this.writeState(state, config)
    return `${name} 先攻：1D20[${roll}]${bonus >= 0 ? "+" : ""}${bonus}=${total}\n已写入当前群先攻列表。`
  }

  async handleInitiative(e, raw = "") {
    const config = this.getConfig()
    const state = this.readState(config)
    const groupId = String(e?.group_id || "private")
    state.groups[groupId] ||= {}
    state.groups[groupId].initiative ||= []
    const list = state.groups[groupId].initiative
    const text = String(raw || "").trim()
    if (!text || /^(list|列表|show)$/i.test(text)) {
      if (!list.length) return "当前先攻列表为空。"
      return `先攻列表：\n${list.sort((a, b) => b.value - a.value).map((item, i) => `${i + 1}. ${item.name} ${item.value}`).join("\n")}`
    }
    if (/^(clr|clear|清空)$/i.test(text)) {
      if (!this.canManageGroupDice(e)) return "只有主人、群主或管理员可以清空先攻列表。"
      state.groups[groupId].initiative = []
      state.groups[groupId].initiativeTurn = null
      await this.writeState(state, config)
      return "先攻列表已清空。"
    }
    if (/^(next|下一位|下一回合)$/i.test(text)) {
      if (!list.length) return "先攻列表为空，先用 .ri 掷先攻。"
      list.sort((a, b) => b.value - a.value)
      const turn = state.groups[groupId].initiativeTurn || {}
      const cursor = turn.name ? list.findIndex(item => item.name === turn.name) : -1
      let index = cursor + 1
      if (index >= list.length) index = 0
      const round = (Number(turn.round) || 0) + (cursor + 1 >= list.length || cursor < 0 ? 1 : 0)
      state.groups[groupId].initiativeTurn = { round, name: list[index].name }
      await this.writeState(state, config)
      const order = list.map((item, i) => `${i === index ? "▶ " : ""}${i + 1}. ${item.name} ${item.value}`).join("\n")
      return `先攻 第${round}轮：轮到 ${list[index].name}（先攻 ${list[index].value}）行动\n${order}`
    }
    const del = text.match(/^(del|rm|删除)\s+(.+)$/i)
    if (del) {
      if (!this.canManageGroupDice(e)) return "只有主人、群主或管理员可以删除先攻项。"
      state.groups[groupId].initiative = list.filter(item => item.name !== del[2].trim())
      await this.writeState(state, config)
      return `已删除先攻项：${del[2].trim()}`
    }
    const match = text.match(/^(.+?)\s+([+\-]?\d+)$/)
    if (!match) return "先攻命令：.ri [修正] / .init 名字 数值 / .init list / .init clear"
    const item = { name: match[1].trim(), value: Number(match[2]) }
    const existing = list.findIndex(old => old.name === item.name)
    if (existing >= 0) list[existing] = item
    else list.push(item)
    await this.writeState(state, config)
    return `已加入先攻：${item.name} ${item.value}`
  }

  handleRsr(e, raw = "") {
    const items = String(raw || "").split(/[,\s，]+/).map(item => item.trim()).filter(Boolean)
    if (!items.length) return "格式：.rsr 选项A 选项B 选项C"
    return `随机选择：${items[rollInt(items.length) - 1]}`
  }

  handleWw(e, raw = "") {
    const text = String(raw || "").trim()
    const count = Math.min(100, Math.max(1, Number(text.match(/\d+/)?.[0]) || 1))
    const target = Number(text.match(/(?:>=|难度|tn)\s*(\d+)/i)?.[1] || 8)
    const again = Number(text.match(/(?:again|爆骰|a)\s*(\d+)/i)?.[1] || 0)
    const queue = Array.from({ length: count }, () => true)
    const rolls = []
    while (queue.length) {
      queue.shift()
      if (rolls.length >= this.getConfig().maxDiceCount) return `WoD 骰池触发的总骰数超过 ${this.getConfig().maxDiceCount}，已停止，未给出不完整结算。`
      const value = rollInt(10)
      rolls.push(value)
      if (again >= 2 && again <= 10 && value >= again) queue.push(true)
    }
    const rawSuccess = rolls.filter(v => v >= target).length
    const ones = rolls.filter(v => v === 1).length
    const success = Math.max(0, rawSuccess - ones)
    const outcome = rawSuccess === 0 && ones > 0 ? "大失败" : success > 0 ? `${success} 成功` : "失败"
    return `WoD 骰池 ${count}D10 难度${target}${again ? `（${again}-again）` : ""}：[${rolls.join(", ")}] 成功 ${rawSuccess} - 1点抵消 ${ones} = ${success}；${outcome}`
  }

  handleDx(e, raw = "") {
    const text = String(raw || "").trim()
    const nums = text.match(/\d+/g)?.map(Number) || []
    const count = Math.min(100, Math.max(1, nums[0] || 1))
    const critical = Math.min(10, Math.max(2, nums[1] || 10))
    let pool = count
    let total = 0
    const rounds = []
    let diceUsed = 0
    while (true) {
      diceUsed += pool
      if (diceUsed > this.getConfig().maxDiceCount) return `DX 暴击链总骰数超过 ${this.getConfig().maxDiceCount}，已停止，未给出不完整达成值。`
      const rolls = Array.from({ length: pool }, () => rollInt(10))
      rounds.push(rolls)
      const criticals = rolls.filter(value => value >= critical).length
      if (!criticals) {
        total += Math.max(...rolls)
        break
      }
      total += 10
      pool = criticals
    }
    return `DX 检定 ${count}D10 C${critical}：${rounds.map((rolls, index) => `第${index + 1}轮[${rolls.join(",")}]`).join(" → ")}；达成值 ${total}`
  }

  handleEk(e, raw = "") {
    const config = this.getConfig()
    const expr = String(raw || "").trim() || "1d100"
    const result = this.rollExpression(expr, config)
    return `永恒幻梦：${result.expr}=${result.detail}=${result.total}`
  }

  handleEkgen(e, raw = "") {
    const attrs = ["体魄", "灵巧", "感知", "意志", "学识", "魅力"].map(name => `${name} ${rollInt(6) + rollInt(6) + 3}`)
    return `永恒幻梦角色属性：\n${attrs.join(" / ")}`
  }

  readLogLines(file) {
    if (!file || !fs.existsSync(file)) return []
    return fs.readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line) } catch { return null }
      })
      .filter(Boolean)
  }

  getLogStatus(e) {
    const config = this.getConfig()
    if (!e?.group_id) return "log 只能在群聊中使用。"
    const group = this.readState(config).groups?.[String(e.group_id)]
    const log = group?.log
    if (!log) return "当前群还没有 log。"
    const count = this.readLogLines(log.file).length
    const history = [...(group?.logs || [])]
      .filter(item => item?.file && item.file !== log.file)
      .slice(-5)
      .reverse()
    return [
      `log 状态：${log.active ? "记录中" : "已结束"}`,
      `标题：${log.title || "未命名"}`,
      `开始：${log.startedAt || "未知"}`,
      log.endedAt ? `结束：${log.endedAt}` : "",
      `消息数：${count}`,
      history.length ? `历史团录：\n${history.map((item, index) => `${index + 1}. ${item.title || "未命名"}（${item.startedAt || "时间未知"}）`).join("\n")}\n导出历史：.log export 序号` : ""
    ].filter(Boolean).join("\n")
  }

  resolveLogForExport(group = {}, raw = "") {
    const selector = String(raw || "").trim()
    const current = group.log?.file ? group.log : null
    const history = [...(group.logs || [])]
      .filter(item => item?.file && item.file !== current?.file)
      .reverse()
    if (!selector || /^(current|当前)$/i.test(selector)) return current
    if (/^\d+$/.test(selector)) return history[Number(selector) - 1] || null
    return [current, ...history].filter(Boolean).find(item => String(item.title || "") === selector) || null
  }

  async sendCompleteFile(e, file, options = {}) {
    const config = this.getConfig()
    const stat = fs.statSync(file)
    const maxMb = safeNumber(options.maxMb, config.logExportMaxMb, 1, 100)
    const maxBytes = maxMb * 1024 * 1024
    if (stat.size > maxBytes) throw new Error(`文件 ${Math.ceil(stat.size / 1024 / 1024)}MB，超过 ${maxMb}MB 的安全发送上限`)
    const name = path.basename(file)
    const errors = []
    const bot = e?.bot || globalThis.Bot
    if (e?.group_id && typeof bot?.sendApi === "function") {
      try {
        const encoded = `base64://${fs.readFileSync(file).toString("base64")}`
        const result = await bot.sendApi("upload_group_file", {
          group_id: Number(e.group_id),
          file: encoded,
          name
        })
        if (result?.status === "failed" || (result?.retcode !== undefined && Number(result.retcode) !== 0)) {
          throw new Error(result?.wording || result?.msg || `retcode=${result?.retcode}`)
        }
        return true
      } catch (error) {
        errors.push(sanitizeDiceCommandError(error))
      }
    }
    const target = e?.group || e?.friend
    if (typeof target?.sendFile === "function") {
      try {
        await target.sendFile(`file://${file}`, name)
        return true
      } catch (error) {
        errors.push(sanitizeDiceCommandError(error))
      }
    }
    throw new Error(errors.filter(Boolean).join("；") || "当前适配器没有可用的完整文件上传接口")
  }

  async sendLogFile(e, file, config = this.getConfig()) {
    return await this.sendCompleteFile(e, file, { maxMb: config.logExportMaxMb })
  }

  buildLogText(log, lines) {
    const header = [
      `# ${log.title || "COC Log"}`,
      `开始：${log.startedAt || ""}`,
      log.endedAt ? `结束：${log.endedAt}` : "",
      ""
    ].filter(line => line !== "").join("\n")
    const body = lines.map(item => {
      const time = item.at ? item.at.replace("T", " ").slice(0, 19) : ""
      return `[${time}] ${item.name || item.userId}(${item.userId}): ${item.content}`
    }).join("\n")
    return `${header}${body}\n`
  }

  buildLogHtml(log, lines) {
    const esc = value => String(value ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
    const rows = lines.map(item => {
      const time = item.at ? item.at.replace("T", " ").slice(0, 19) : ""
      return [
        `<div class="msg">`,
        `  <div class="meta"><span class="name">${esc(item.name || item.userId)}</span><span class="time">${esc(time)}</span></div>`,
        `  <div class="content">${esc(item.content)}</div>`,
        `</div>`
      ].join("\n")
    }).join("\n")
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(log.title || "COC Log")}</title>
<style>
  body { margin: 0; background: #16171f; color: #d7d9e0; font: 15px/1.7 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }
  .wrap { max-width: 760px; margin: 0 auto; padding: 24px 16px 48px; }
  header { border-bottom: 1px solid #2c2e3d; padding-bottom: 14px; margin-bottom: 18px; }
  h1 { margin: 0 0 6px; font-size: 20px; color: #f0f1f5; }
  .info { color: #8b8fa3; font-size: 13px; }
  .msg { background: #1f2130; border-radius: 10px; padding: 10px 14px; margin: 10px 0; }
  .meta { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; margin-bottom: 4px; }
  .name { color: #8ab4f8; font-weight: 600; }
  .time { color: #6b6f84; }
  .content { white-space: pre-wrap; word-break: break-word; }
  footer { margin-top: 22px; color: #565a6e; font-size: 12px; text-align: center; }
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>🎲 ${esc(log.title || "COC Log")}</h1>
  <div class="info">开始：${esc(log.startedAt || "未知")}${log.endedAt ? ` ｜ 结束：${esc(log.endedAt)}` : ""} ｜ 共 ${lines.length} 条记录</div>
</header>
${rows}
<footer>由跑团骰娘导出</footer>
</div>
</body>
</html>`
  }

  handleLogList(e) {
    if (!e?.group_id) return "log 只能在群聊中使用。"
    const group = this.readState(this.getConfig()).groups?.[String(e.group_id)] || {}
    const current = group.log?.file ? group.log : null
    const history = [...(group.logs || [])]
      .filter(item => item?.file && item.file !== current?.file)
      .reverse()
    const rows = []
    if (current) {
      const count = this.readLogLines(current.file).length
      rows.push(`▶ 当前：${current.title || "未命名"}（${current.active ? "记录中" : "已结束"}，${count} 条，导出：.log export）`)
    }
    history.slice(0, 10).forEach((item, index) => {
      const count = this.readLogLines(item.file).length
      rows.push(`${index + 1}. ${item.title || "未命名"}（已结束，${count} 条，导出：.log export ${index + 1}）`)
    })
    if (!rows.length) return "本群还没有任何团录。"
    const more = history.length > 10 ? `\n（仅显示最近 10 份，共 ${history.length} 份历史）` : ""
    return `本群团录：\n${rows.join("\n")}${more}`
  }

  async exportLog(e, raw = "") {
    const config = this.getConfig()
    if (!e?.group_id) return "log 只能在群聊中使用。"
    if (!this.canManageGroupDice(e)) return "只有主人、群主或管理员可以导出跑团 log。"
    const groupId = String(e.group_id)
    const group = this.readState(config).groups?.[groupId] || {}
    // 末尾可带导出格式：.log export [序号|团名] [html]
    const rawTokens = String(raw || "").trim().split(/\s+/).filter(Boolean)
    let wantsHtml = false
    let selector = String(raw || "").trim()
    if (rawTokens.length && /^(html|htm|网页版?)$/i.test(rawTokens[rawTokens.length - 1])) {
      wantsHtml = true
      rawTokens.pop()
      selector = rawTokens.join(" ")
    }
    const log = this.resolveLogForExport(group, selector)
    if (selector && !log) return `没有找到团录：${selector}。可先用 .log list 查看历史序号。`
    if (!log?.file) return "当前群还没有可导出的 log。"
    const lines = this.readLogLines(log.file)
    if (!lines.length) return "当前 log 还没有记录到消息。"
    const exportDir = path.join(this.getLogDir(groupId, config), "exports")
    ensureDir(exportDir)
    const safeTitle = String(log.title || "coc-log").replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 50)
    const outFile = path.join(exportDir, `${safeTitle}-${Date.now()}.${wantsHtml ? "html" : "txt"}`)
    fs.writeFileSync(outFile, wantsHtml ? this.buildLogHtml(log, lines) : this.buildLogText(log, lines), "utf8")
    try {
      await this.sendLogFile(e, outFile, config)
      // 文件本身就是导出结果；成功时不再补发一条普通聊天，避免用户
      // 把状态文字误认为导出的日志正文。
      return ""
    } catch (error) {
      this.logger?.warn?.(`[骰娘] log 文件发送失败: ${error.message}`)
      return `log 文本已经生成，但文件发送失败：${sanitizeDiceCommandError(error)}。没有把截断内容当作完整导出。`
    } finally {
      try { fs.rmSync(outFile, { force: true }) } catch {}
    }
  }

  getUserName(e) {
    const userId = String(e?.user_id || e?.sender?.user_id || "")
    const state = this.readState()
    const user = state.users?.[userId]
    return user?.nickname || e?.sender?.card || e?.sender?.nickname || userId || "调查员"
  }

  ensureUser(state, e) {
    const userId = String(e?.user_id || e?.sender?.user_id || "")
    if (!state.users[userId]) {
      state.users[userId] = {
        nickname: e?.sender?.card || e?.sender?.nickname || userId,
        activeCard: "默认",
        cards: { "默认": { name: e?.sender?.card || e?.sender?.nickname || "调查员", attrs: {}, skills: {} } }
      }
    }
    const user = state.users[userId]
    user.cards ||= {}
    user.activeCard ||= Object.keys(user.cards)[0] || "默认"
    if (!user.cards[user.activeCard]) user.cards[user.activeCard] = { name: user.nickname || "调查员", attrs: {}, skills: {} }
    if (typeof user.locked === "boolean") {
      for (const card of Object.values(user.cards)) {
        if (card && typeof card === "object" && card.locked === undefined) card.locked = user.locked
      }
      delete user.locked
    }
    return user
  }

  isCardLocked(card) {
    return card?.locked === true
  }

  lockedCardReply(card) {
    return `人物卡「${card?.name || "当前人物卡"}」已锁定；请先用 .pc unlock 解锁后再修改。`
  }

  getEventForUser(e, userId) {
    return {
      ...e,
      user_id: userId,
      sender: {
        ...(e?.sender || {}),
        user_id: userId,
        card: "",
        nickname: String(userId)
      }
    }
  }

  getMentionedUserIds(e) {
    return collectMentionTargetIds(e, e?.bot?.uin || globalThis.Bot?.uin)
  }

  getActiveCard(e, state = this.readState()) {
    const user = this.ensureUser(state, e)
    return user.cards[user.activeCard]
  }

  getTargetValue(skill, explicitValue, e) {
    if (Number.isFinite(Number(explicitValue))) return Number(explicitValue)
    const state = this.readState()
    const card = this.getActiveCard(e, state)
    const key = normalizeSkillName(skill)
    return Number(card.skills?.[key] ?? card.attrs?.[ATTR_ALIASES[key] || key])
  }

  getGroupRule(e, config = this.getConfig()) {
    const state = this.readState(config)
    return state.groups?.[String(e?.group_id || "private")]?.rule || config.defaultRule || "coc7"
  }

  normalizeCocRule(rule = "") {
    const text = String(rule || "").toLowerCase()
    if (/^[0-5]$/.test(text)) return text
    if (/coc7|默认|标准/.test(text)) return "0"
    if (/1\/5|五分之一|极难/.test(text)) return "0"
    if (/出1|大成功1|房规1|crit1/.test(text)) return "5"
    if (/不大失败|无大失败/.test(text)) return "nofumble"
    return "0"
  }

  isValidCocRule(rule = "") {
    const text = String(rule || "").trim().toLowerCase()
    return /^[0-5]$/.test(text) || /^(coc7|默认|标准|nofumble|不大失败|无大失败|crit1|大成功1|房规1)$/.test(text)
  }

  splitRounds(text = "") {
    const raw = String(text || "").trim()
    const prefix = raw.match(/^(\d+)\s*#\s*(.+)$/)
    if (prefix) return { rounds: Math.max(1, Number(prefix[1]) || 1), expr: prefix[2].trim() }
    const suffix = raw.match(/^(.+?)\s*#\s*(\d+)$/)
    if (suffix) return { rounds: Math.max(1, Number(suffix[2]) || 1), expr: suffix[1].trim() }
    return { rounds: 1, expr: raw }
  }

  rollExpression(expr = "1d100", config = this.getConfig(), random = secureDiceRandom) {
    return new DiceExpressionParser(expr || "1d100", config, random).parse()
  }

  rollD100(modifier = 0) {
    const ones = rollInt(10) - 1
    const tensBase = rollInt(10) - 1
    const tensList = [tensBase]
    const extra = Math.abs(Number(modifier) || 0)
    for (let i = 0; i < extra; i += 1) tensList.push(rollInt(10) - 1)
    const pickedTens = modifier > 0 ? Math.min(...tensList) : modifier < 0 ? Math.max(...tensList) : tensBase
    const value = pickedTens === 0 && ones === 0 ? 100 : pickedTens * 10 + ones
    const sign = modifier > 0 ? "奖励骰" : modifier < 0 ? "惩罚骰" : "1D100"
    const diceText = modifier === 0
      ? "1D100"
      : `${sign}[十位:${tensList.map(n => n * 10).join("/")},个位:${ones}]`
    return { value, diceText }
  }

  static get DIFFICULTY_PREFIXES() {
    return { "困难": 2, "困難": 2, "极难": 3, "極難": 3, "大成功": 4, "常规": 1, "常規": 1 }
  }

  /** 从检定参数里剥离难度前缀（.ra 困难侦查60 → {skill:侦查, difficulty:2}） */
  extractDifficultyPrefix(text = "") {
    const prefixes = this.constructor.DIFFICULTY_PREFIXES
    for (const prefix of ["大成功", "极难", "極難", "困难", "困難", "常规", "常規"]) {
      if (text.startsWith(prefix)) {
        return { difficulty: prefixes[prefix], rest: text.slice(prefix.length) }
      }
    }
    return { difficulty: 0, rest: text }
  }

  /**
   * sealdice ResultCheckBase 的忠实移植（dice/ext_coc7.go）。
   * 返回 { rank, criticalSuccessValue }；rank: 4大成功 3极难 2困难 1成功 -1失败 -2大失败
   * difficultyRequired: 0常规 2困难 3极难 4大成功（折算判定线用）
   */
  computeCocRank(d100, value, normalizedRule = "0", difficultyRequired = 0) {
    let criticalSuccessValue = 1
    let fumbleValue = 100
    let checkVal = value
    if (difficultyRequired === 2) checkVal = Math.floor(value / 2)
    else if (difficultyRequired === 3) checkVal = Math.floor(value / 5)
    else if (difficultyRequired === 4) checkVal = criticalSuccessValue

    let successRank = d100 <= checkVal ? 1 : -1

    switch (normalizedRule) {
      case "0":
        // 规则书：不满50出96-100大失败，满50出100大失败（以折算后判定值为准）
        if (checkVal < 50) fumbleValue = 96
        break
      case "1":
        if (value >= 50) criticalSuccessValue = 5
        if (value < 50) fumbleValue = 96
        break
      case "2":
        criticalSuccessValue = 5
        if (value < criticalSuccessValue) criticalSuccessValue = value
        fumbleValue = 96
        if (value >= fumbleValue) fumbleValue = Math.min(100, value + 1)
        break
      case "3":
        criticalSuccessValue = 5
        fumbleValue = 96
        break
      case "4":
        criticalSuccessValue = Math.min(5, Math.floor(value / 10))
        fumbleValue = Math.min(100, 96 + Math.floor(value / 10))
        break
      case "5":
        criticalSuccessValue = Math.min(2, Math.floor(value / 5))
        fumbleValue = value < 50 ? 96 : 99
        break
      default:
        break
    }

    if (successRank === 1 || d100 <= criticalSuccessValue) {
      if (d100 <= Math.floor(value / 2)) successRank = 2
      if (d100 <= Math.floor(value / 5)) successRank = 3
      if (d100 <= criticalSuccessValue) successRank = 4
    } else if (d100 >= fumbleValue) {
      successRank = -2
    }

    if (normalizedRule === "0" || normalizedRule === "1" || normalizedRule === "2") {
      // 为1必是大成功，即使判定线是0（40周年版 407页）
      if (d100 === 1) successRank = 4
    }
    if (d100 === 100 && normalizedRule === "0") successRank = -2
    if (normalizedRule === "3") {
      // 强行大成功或大失败
      if (d100 <= criticalSuccessValue) successRank = 4
      if (d100 >= fumbleValue) successRank = -2
    }
    return { rank: successRank, criticalSuccessValue }
  }

  judgeCoc(roll, target, rule = "coc7", difficultyRequired = 0) {
    const value = Number(target)
    if (!Number.isFinite(value) || value < 1) throw new Error("检定值必须是正数")
    const normalizedRule = this.normalizeCocRule(rule)
    const d100 = Number(roll)
    const noFumble = normalizedRule === "nofumble"
    const effectiveRule = noFumble ? "0" : normalizedRule
    const { rank } = this.computeCocRank(d100, value, effectiveRule, difficultyRequired)
    return this.levelTextFromRank((noFumble && rank === -2) ? -1 : rank)
  }

  judgeCocDetails(roll, target, rule = "coc7", difficultyRequired = 0) {
    const value = Number(target)
    if (!Number.isFinite(value) || value < 1) throw new Error("检定值必须是正数")
    const normalizedRule = this.normalizeCocRule(rule)
    const d100 = Number(roll)
    const noFumble = normalizedRule === "nofumble"
    const effectiveRule = noFumble ? "0" : normalizedRule
    const { rank } = this.computeCocRank(d100, value, effectiveRule, difficultyRequired)
    const displayRank = (noFumble && rank === -2) ? -1 : rank
    return { rank, displayRank, level: this.levelTextFromRank(displayRank) }
  }

  levelTextFromRank(rank) {
    const levels = this.getConfig().checkLevels || DEFAULT_CHECK_LEVELS
    if (rank === 4) return levels.critical || "大成功"
    if (rank === 3) return levels.extreme || "极难成功"
    if (rank === 2) return levels.hard || "困难成功"
    if (rank === 1) return levels.success || "成功"
    if (rank === -2) return levels.fumble || "大失败"
    return levels.fail || "失败"
  }

  handleRoll(e, raw = "") {
    const config = this.getConfig()
    if (!config.enabled) return "骰娘模块现在没开。"
    const { rounds, expr } = this.splitRounds(raw || "1d100")
    if (rounds > config.maxRounds) return `最多一次掷 ${config.maxRounds} 轮。`
    const name = this.getUserName(e)
    const results = []
    for (let i = 0; i < rounds; i += 1) {
      const result = this.rollExpression(expr || "1d100", config)
      results.push(renderTemplate(config.templates.roll, { name, ...result }))
    }
    return results.join("\n")
  }

  handleBonusPenaltyRoll(e, raw = "", modifier = 1) {
    const config = this.getConfig()
    if (!config.enabled) return "骰娘模块现在没开。"
    const { rounds } = this.splitRounds(raw || "1d100")
    if (rounds > config.maxRounds) return `最多一次掷 ${config.maxRounds} 轮。`
    const name = this.getUserName(e)
    const results = []
    for (let i = 0; i < rounds; i += 1) {
      const roll = this.rollD100(modifier)
      results.push(renderTemplate(config.templates.bonus, {
        name,
        kind: modifier > 0 ? "奖励骰" : "惩罚骰",
        diceText: roll.diceText,
        value: roll.value
      }))
    }
    return results.join("\n")
  }

  parseCheckArgs(raw = "") {
    let text = String(raw || "").trim()
    let difficulty = 0
    // 难度前缀：可能独立成词（.ra 困难 侦查 60）或紧贴技能（.ra 困难侦查60）
    const spaceSplit = text.split(/\s+/)
    const first = this.extractDifficultyPrefix(spaceSplit[0] || "")
    if (first.difficulty) {
      difficulty = first.difficulty
      if (first.rest) spaceSplit[0] = first.rest
      else spaceSplit.shift()
      text = spaceSplit.join(" ")
    } else {
      const compact = this.extractDifficultyPrefix(text)
      if (compact.difficulty && compact.rest && /[\u4e00-\u9fa5A-Za-z]/.test(compact.rest[0])) {
        difficulty = compact.difficulty
        text = compact.rest
      }
    }
    const parts = text.split(/\s+/).filter(Boolean)
    // sealdice 多轮前缀：3#技能 / 3# 技能 / #3 技能（.rab#3 的轮数由命令头解析，
    // 这里兜参数区写法，防止 N#/#N 混进技能名）
    let rounds = 0
    if (/^\d+#$/.test(parts[0] || "")) {
      rounds = Number(parts[0].slice(0, -1))
      parts.shift()
    } else if (/^#\d+$/.test(parts[0] || "")) {
      rounds = Number(parts[0].slice(1))
      parts.shift()
    } else if (parts[0]) {
      const lead = parts[0].match(/^(\d+)#(?=\S)/)
      if (lead) {
        rounds = Number(lead[1])
        parts[0] = parts[0].slice(lead[0].length)
      }
    }
    let modifier = 0
    let bonusLead = /^(b|奖励|奖励骰)(\d+)?$/i.exec(parts[0] || "")
    if (bonusLead) { modifier = Number(bonusLead[2] || 1); parts.shift() }
    else {
      const penaltyLead = /^(p|惩罚|惩罚骰)(\d+)?$/i.exec(parts[0] || "")
      if (penaltyLead) { modifier = -Number(penaltyLead[2] || 1); parts.shift() }
    }
    // 目标值取最后一个纯数字 token（sealdice 值在末尾；取第一个会被漏解析的
    // 轮数/数量劫持，例如「3 今天开团 60」曾被判成对 3 检定并丢弃真值）
    let valueIndex = -1
    for (let i = parts.length - 1; i >= 0; i -= 1) {
      if (/^-?\d+$/.test(parts[i])) { valueIndex = i; break }
    }
    if (valueIndex < 0) {
      const compact = parts.join(" ")
      const compactMatch = compact.match(/^(.+?)[\s:=：]*(-?\d+)$/)
      if (compactMatch) {
        return { skill: normalizeSkillName(compactMatch[1]), target: Number(compactMatch[2]), modifier, difficulty, rounds }
      }
      return { skill: compact || "检定", target: NaN, modifier, difficulty, rounds }
    }
    const target = Number(parts[valueIndex])
    const skill = parts.slice(0, valueIndex).join(" ") || "检定"
    return { skill, target, modifier, difficulty, rounds }
  }

  handleCheck(e, raw = "", options = {}) {
    const config = this.getConfig()
    if (!config.enabled) return "骰娘模块现在没开。"
    const targetUserId = options.targetUserId || this.getMentionedUserIds(e)[0]
    const cleanRaw = targetUserId ? stripCqMentions(raw) : raw
    const targetEvent = targetUserId ? this.getEventForUser(e, targetUserId) : e
    const parsed = this.parseCheckArgs(cleanRaw)
    const target = this.getTargetValue(parsed.skill, parsed.target, targetEvent)
    if (!Number.isFinite(target)) return `找不到「${parsed.skill}」的技能值。请写成：.ra ${parsed.skill} 60，或先用 .st 录入。`
    const modifier = options.modifier ?? parsed.modifier
    const difficulty = Number(options.difficulty ?? parsed.difficulty) || 0
    const maxRounds = safeNumber(config.maxRounds, 20, 1, 1000)
    const rounds = Math.max(1, Math.min(maxRounds, Number(options.rounds ?? parsed.rounds) || 1))
    const rule = this.getGroupRule(e, config)
    const skill = difficulty > 1 ? `${this.difficultyLabel(difficulty)}${parsed.skill}` : parsed.skill
    const renderOnce = () => {
      const roll = this.rollD100(modifier)
      const level = this.renderCheckLevel(roll.value, target, rule, difficulty)
      // 多轮时用基础单行模板，避免逐轮吐槽文案刷屏
      const template = rounds > 1
        ? (config.templates.check || DEFAULT_TEMPLATES.check)
        : pickCheckTemplate(config.templates, level, config.checkLevels)
      return renderTemplate(template, {
        name: this.getUserName(targetEvent),
        skill,
        target,
        roll: roll.value,
        diceText: roll.diceText,
        level,
        rule
      })
    }
    if (rounds > 1) return Array.from({ length: rounds }, renderOnce).join("\n")
    return renderOnce()
  }

  difficultyLabel(difficulty = 0) {
    return { 2: "困难", 3: "极难", 4: "大成功" }[difficulty] || ""
  }

  /** sealdice GetResultTextWithRequire 语义：难度检定显示"通过/未通过"，大成功/大失败作附加语 */
  renderCheckLevel(rollValue, target, rule, difficulty = 0) {
    if (difficulty > 1) {
      const normalizedRule = this.normalizeCocRule(rule)
      const { rank } = this.computeCocRank(rollValue, target, normalizedRule, difficulty)
      const pass = rank >= difficulty
      const extra = rank === 4 && rank > difficulty ? "（大成功）" : (!pass && rank === -2) ? "（大失败）" : ""
      return `${this.difficultyLabel(difficulty)}检定${pass ? "成功" : "失败"}${extra}`
    }
    return this.judgeCoc(rollValue, target, rule)
  }

  checkLevelRank(level = "") {
    const levels = this.getConfig().checkLevels || DEFAULT_CHECK_LEVELS
    if (level === (levels.critical || "大成功")) return 5
    if (level === (levels.extreme || "极难成功")) return 4
    if (level === (levels.hard || "困难成功")) return 3
    if (level === (levels.success || "成功")) return 2
    if (level === (levels.fail || "失败")) return 1
    if (level === (levels.fumble || "大失败")) return 0
    return -1
  }

  rollCheckObject(e, raw = "", options = {}) {
    const config = this.getConfig()
    const parsed = this.parseCheckArgs(raw)
    const target = this.getTargetValue(parsed.skill, parsed.target, e)
    if (!Number.isFinite(target)) throw new Error(`找不到「${parsed.skill}」的技能值`)
    const modifier = options.modifier ?? parsed.modifier
    const roll = this.rollD100(modifier)
    const rule = this.getGroupRule(e, config)
    const details = this.judgeCocDetails(roll.value, target, rule)
    return {
      name: this.getUserName(e),
      skill: parsed.skill,
      target,
      roll: roll.value,
      diceText: roll.diceText,
      level: details.level,
      rank: cocRankToCompareRank(details.displayRank)
    }
  }

  handleOpposed(e, raw = "") {
    const config = this.getConfig()
    if (!config.enabled) return "骰娘模块现在没开。"
    const text = String(raw || "").trim()
    const parts = text.split(/\s+(?:vs|VS|对抗)\s+/)
    let leftRaw = ""
    let rightRaw = ""
    let rightEvent = e
    const mentioned = this.getMentionedUserIds(e)
    if (parts.length >= 2) {
      leftRaw = parts[0]
      rightRaw = parts.slice(1).join(" vs ")
    } else if (mentioned.length) {
      leftRaw = stripCqMentions(text)
      rightRaw = leftRaw
      rightEvent = this.getEventForUser(e, mentioned[0])
    } else {
      return "格式：.rav 斗殴 60 vs 斗殴 50，或 .rav 斗殴 @对方"
    }
    try {
      const left = this.rollCheckObject(e, leftRaw)
      const right = this.rollCheckObject(rightEvent, rightRaw)
      // sealdice 语义：双方成功等级相同视为平局（其属性比较分支已被官方注释停用）
      let winner = "平手"
      if (left.rank !== right.rank) winner = left.rank > right.rank ? `${left.name} 胜出` : `${right.name} 胜出`
      const leftText = `${left.name}：${left.diceText}=${left.roll}/${left.target} ${left.level}`
      const rightText = `${right.name}：${right.diceText}=${right.roll}/${right.target} ${right.level}`
      return renderTemplate(config.templates.opposed, { left: leftText, right: rightText, winner })
    } catch (error) {
      return `对抗检定失败：${error.message}`
    }
  }

  async handleHiddenCheck(e, raw = "", options = {}) {
    const config = this.getConfig()
    if (!config.allowHiddenRoll) return "当前未开启暗骰。"
    const text = String(raw || "").trim()
    const normalizedText = normalizeDiceExpression(text)
    const isRollExpression = !text || /^(\d+#)?[0-9dklhmaxinop+\-*/%().]+(#\d+)?$/.test(normalizedText)
    const result = isRollExpression ? this.handleRoll(e, text || "1d100") : this.handleCheck(e, text, options)
    const publicText = renderTemplate(config.templates.hiddenPublic, { name: this.getUserName(e), result })
    const privateText = renderTemplate(config.templates.hiddenPrivate, { name: this.getUserName(e), result })
    try {
      const friend = globalThis.Bot?.pickFriend?.(e.user_id) || e.bot?.pickFriend?.(e.user_id)
      if (!friend?.sendMsg) throw new Error("无法取得私聊对象")
      await friend.sendMsg(privateText)
      return publicText
    } catch (error) {
      this.logger?.warn?.(`[骰娘] 暗骰私聊失败: ${error.message}`)
      return `${publicText}\n但私聊发送失败，请确认已添加好友或允许临时会话。`
    }
  }

  async handleSan(e, raw = "") {
    const config = this.getConfig()
    let text = String(raw || "").trim()
    // sealdice 关键字参数：--half 扣除减半；--cap=N 扣除上限
    let halfLoss = false
    let lossCap = 0
    text = text.replace(/--half\b\s*/gi, () => { halfLoss = true; return "" })
    text = text.replace(/--cap\s*=\s*(\d+)\s*/gi, (_, n) => { lossCap = Number(n); return "" })
    text = text.trim()
    const m = text.match(/^(\S+)\/(\S+)(?:\s+(\d+))?/)
    if (!m) return "格式：.sc 成功损失/失败损失 [当前SAN]，例如 .sc 1/1d6 60，可加 --half --cap=5"
    const target = this.getTargetValue("SAN", m[3], e)
    if (!Number.isFinite(target)) return "找不到当前 SAN。请写成：.sc 1/1d6 60，或先用 .st SAN=60"
    if (!m[3]) {
      const currentState = this.readState(config)
      const currentCard = this.getActiveCard(e, currentState)
      if (this.isCardLocked(currentCard)) return this.lockedCardReply(currentCard)
    }
    const roll = this.rollD100(0)
    const rule = this.getGroupRule(e, config)
    const details = this.judgeCocDetails(roll.value, target, rule)
    const level = details.level
    const lossExpr = details.displayRank > 0 ? m[1] : m[2]
    // sealdice：大失败时损失骰取最大值（BigFailDiceOn）
    const isBigFail = details.displayRank === -2
    const lossRandom = isBigFail ? () => 0.999999 : undefined
    let loss = this.rollExpression(lossExpr, config, lossRandom).total
    if (halfLoss) loss = Math.floor(loss / 2)
    if (lossCap > 0 && loss > lossCap) loss = lossCap
    let sanAfter = Math.max(0, target - loss)
    let insanity = loss >= 5 ? `；单次损失 >=5，建议进行 INT 检定判定临时疯狂` : ""
    if (!m[3]) {
      const state = this.readState(config)
      const card = this.getActiveCard(e, state)
      if (Number.isFinite(Number(card.attrs?.SAN))) {
        card.attrs.SAN = sanAfter
        card.sanLossLog ||= {}
        const day = this.getTodayKey(new Date(), config)
        const previous = card.sanLossLog[day]
        const previousLoss = Number(typeof previous === "object" ? previous.loss : previous) || 0
        const baseline = Number(typeof previous === "object" ? previous.baseline : NaN)
        const dayBaseline = Number.isFinite(baseline) ? baseline : target + previousLoss
        const dayLoss = previousLoss + loss
        card.sanLossLog[day] = { loss: dayLoss, baseline: dayBaseline }
        const indefiniteThreshold = Math.max(1, Math.floor(dayBaseline / 5))
        if (dayLoss >= indefiniteThreshold) {
          insanity += `；今日累计损失 ${dayLoss}，达到当日初始 SAN 的五分之一，建议进入不定疯狂判定`
        }
        await this.writeState(state, config)
      }
    }
    if (sanAfter <= 0) insanity += "；SAN 归零"
    return renderTemplate(config.templates.san, {
      name: this.getUserName(e),
      target,
      roll: roll.value,
      diceText: roll.diceText,
      level,
      loss,
      sanAfter,
      insanity
    })
  }

  async handleEn(e, raw = "") {
    const config = this.getConfig()
    const text = String(raw || "").trim()
    // 批量成长：.en 技能1 技能2 …（全部按人物卡数值结算，sealdice 语义）
    const tokens = text.split(/[\s,，]+/).filter(Boolean)
    const skillTokens = tokens.filter(token => !/^\d+$/.test(token))
    const numberTokens = tokens.filter(token => /^\d+$/.test(token))
    if (skillTokens.length >= 2) {
      if (numberTokens.length) return "批量成长按人物卡数值结算，不带数值；请写 .en 技能1 技能2，或逐个 .en 技能 数值。"
      const state = this.readState(config)
      const card = this.getActiveCard(e, state)
      if (this.isCardLocked(card)) return this.lockedCardReply(card)
      const lines = []
      let changed = false
      for (const token of skillTokens.slice(0, 20)) {
        const key = normalizeSkillName(token)
        const attr = ATTR_ALIASES[token] || ATTR_ALIASES[key]
        const storedValue = attr ? card.attrs?.[attr] : card.skills?.[key]
        const target = Number(storedValue)
        if (!Number.isFinite(target)) {
          lines.push(`${token}：找不到技能值，请先 .st ${token} 60`)
          continue
        }
        const roll = this.rollD100(0).value
        const success = roll > target
        const gain = success ? this.rollExpression("1d10", config).total : 0
        let result = "成长失败"
        if (success) {
          const after = target + gain
          if (attr) card.attrs[attr] = after
          else card.skills[key] = after
          changed = true
          result = `成长成功，增加 ${gain}（${target}→${after}，已写入人物卡）`
        }
        lines.push(renderTemplate(config.templates.en, {
          name: this.getUserName(e),
          skill: token,
          target,
          roll,
          result
        }))
      }
      if (changed) await this.writeState(state, config)
      return lines.join("\n")
    }
    const parsed = this.parseCheckArgs(raw)
    const state = this.readState(config)
    const card = this.getActiveCard(e, state)
    const key = normalizeSkillName(parsed.skill)
    const attr = ATTR_ALIASES[parsed.skill] || ATTR_ALIASES[key]
    const storedValue = attr ? card.attrs?.[attr] : card.skills?.[key]
    const usesCardValue = !Number.isFinite(Number(parsed.target))
    const target = usesCardValue ? Number(storedValue) : Number(parsed.target)
    if (!Number.isFinite(target)) return `找不到「${parsed.skill}」的技能值。请写成：.en ${parsed.skill} 60`
    if (usesCardValue && this.isCardLocked(card)) return this.lockedCardReply(card)
    const roll = this.rollD100(0).value
    const success = roll > target
    const gain = success ? this.rollExpression("1d10", config).total : 0
    let result = "成长失败"
    if (success && usesCardValue) {
      const after = Number(storedValue) + gain
      if (attr) card.attrs[attr] = after
      else card.skills[key] = after
      await this.writeState(state, config)
      result = `成长成功，增加 ${gain}（${target}→${after}，已写入人物卡）`
    } else if (success) {
      result = `成长成功，增加 ${gain}（使用临时技能值，未修改人物卡）`
    }
    return renderTemplate(config.templates.en, {
      name: this.getUserName(e),
      skill: parsed.skill,
      target,
      roll,
      result
    })
  }

  generateCoc() {
    const times5 = expr => this.rollExpression(expr, this.getConfig()).total * 5
    const attrs = {
      STR: times5("3d6"),
      CON: times5("3d6"),
      SIZ: times5("2d6+6"),
      DEX: times5("3d6"),
      APP: times5("3d6"),
      INT: times5("2d6+6"),
      POW: times5("3d6"),
      EDU: times5("2d6+6"),
      LUCK: times5("3d6")
    }
    attrs.SAN = attrs.POW
    attrs.HP = Math.floor((attrs.CON + attrs.SIZ) / 10)
    attrs.MP = Math.floor(attrs.POW / 5)
    return attrs
  }

  formatCocRow(attrs = {}, index = 0, options = {}) {
    const primaryTotal = COC_PRIMARY_ATTRS.reduce((sum, key) => sum + (Number(attrs[key]) || 0), 0)
    const luck = Number(attrs.LUCK) || 0
    const totalText = options.noLuck ? String(primaryTotal) : `${primaryTotal}/${primaryTotal + luck}`
    const entries = COC_DISPLAY_ATTRS
      .filter(key => !options.noLuck || key !== "LUCK")
      .map(key => `${COC_ATTR_LABELS[key] || key} ${attrs[key]}`)
      .join(" / ")
    return `${index > 0 ? `${index}. ` : ""}${entries} ｜ ${totalText}`
  }

  parseCocArgs(raw = "") {
    const text = normalizeDiceExpression(raw).replace(/#/g, "")
    const count = Math.min(this.getConfig().maxRounds, Math.max(1, Number(text.match(/\d+/)?.[0]) || 1))
    const noLuck = /不含运|不含幸运|无运|noluck|no_luck/.test(String(raw || "").toLowerCase())
    return { count, noLuck }
  }

  handleCoc(e, raw = "") {
    const config = this.getConfig()
    const { count, noLuck } = this.parseCocArgs(raw)
    const rows = []
    for (let i = 0; i < count; i += 1) {
      const attrs = this.generateCoc()
      rows.push(this.formatCocRow(attrs, count > 1 ? i + 1 : 0, { noLuck }))
    }
    const attributes = rows.join("\n")
    return renderTemplate(config.templates.coc, { name: this.getUserName(e), attributes })
  }

  handleJrrp(e) {
    const config = this.getConfig()
    const userId = String(e?.user_id || "")
    let hash = 2166136261
    for (const char of `${this.getTodayKey(new Date(), config)}:${userId}`) {
      hash ^= char.charCodeAt(0)
      hash = Math.imul(hash, 16777619)
    }
    const value = (hash >>> 0) % 100 + 1
    return renderTemplate(config.templates.jrrp, {
      name: this.getUserName(e),
      value,
      comment: pickJrrpComment(value, config.jrrpComments)
    })
  }

  handleDb(e, raw = "") {
    const config = this.getConfig()
    const text = String(raw || "").trim()
    const parts = text.match(/\d+/g)?.map(Number) || []
    let sum = 0
    if (parts.length >= 2) {
      sum = parts[0] + parts[1]
    } else {
      const state = this.readState(config)
      const card = this.getActiveCard(e, state)
      sum = (Number(card.attrs?.STR) || 0) + (Number(card.attrs?.SIZ) || 0)
    }
    if (!sum) return "格式：.db STR SIZ，或先用 .st STR=50 SIZ=60"
    let db = "-2", build = -2
    if (sum >= 65 && sum <= 84) { db = "-1"; build = -1 }
    else if (sum >= 85 && sum <= 124) { db = "0"; build = 0 }
    else if (sum >= 125 && sum <= 164) { db = "+1D4"; build = 1 }
    else if (sum >= 165 && sum <= 204) { db = "+1D6"; build = 2 }
    else if (sum >= 205) {
      const extra = Math.floor((sum - 205) / 80)
      db = `+${2 + extra}D6`
      build = 3 + extra
    }
    return renderTemplate(config.templates.db, { name: this.getUserName(e), sum, db, build })
  }

  async handleSt(e, raw = "") {
    const config = this.getConfig()
    const state = this.readState(config)
    const user = this.ensureUser(state, e)
    const card = user.cards[user.activeCard]
    const text = String(raw || "").trim()
    const groupId = String(e?.group_id || "private")
    const group = (state.groups[groupId] ||= {})
    if (!text) return this.renderCard(e, card, config, { groupFmt: group.stFmt })
    if (/^(show|查看|查询)$/i.test(text)) return this.renderCard(e, card, config, { groupFmt: group.stFmt })
    const fmtMatch = text.match(/^fmt\s*([\s\S]*)$/i)
    if (fmtMatch) {
      const arg = fmtMatch[1].trim()
      if (!arg) return `当前群人物卡模板：${group.stFmt || "（未设置）"}\n设置：.st fmt HP:{hp}/{hpmax} SAN:{san}\n模板里 {属性名} 会替换为对应数值；.st fmt clr 恢复默认（群管理可改）。`
      if (/^(clr|clear|清除|重置)$/i.test(arg)) {
        if (!this.canManageGroupDice(e)) return "只有主人、群主或管理员可以修改本群人物卡模板。"
        delete group.stFmt
        await this.writeState(state, config)
        return "人物卡模板已恢复默认展示。"
      }
      if (!this.canManageGroupDice(e)) return "只有主人、群主或管理员可以修改本群人物卡模板。"
      if (arg.length > 300) return "模板太长（上限 300 字符）。"
      group.stFmt = arg
      await this.writeState(state, config)
      return `人物卡模板已保存：${arg}\n.st show 将按此格式展示。`
    }
    if (this.isCardLocked(card)) return this.lockedCardReply(card)
    const clearMatch = text.match(/^(clr|clear|清空)(?:\s+(.+))?$/i)
    if (clearMatch) {
      const target = String(clearMatch[2] || "").trim()
      if (!target || /^(all|全部)$/i.test(target)) {
        card.attrs = {}
        card.skills = {}
        await this.writeState(state, config)
        return "当前人物卡已清空。"
      }
      const key = ATTR_ALIASES[target] || normalizeSkillName(target)
      delete card.attrs?.[key]
      delete card.skills?.[key]
      await this.writeState(state, config)
      return `已清空：${key}`
    }
    if (/^(showall|显示全部)$/i.test(text)) return this.renderCard(e, card, config, { showAll: true })
    const hideMatch = text.match(/^(hide|隐藏)\s+(.+)$/i)
    if (hideMatch) {
      const key = normalizeSkillName(hideMatch[2])
      const attrKey = ATTR_ALIASES[key] || key
      card.hiddenAttrs ||= []
      if (!card.hiddenAttrs.includes(attrKey)) card.hiddenAttrs.push(attrKey)
      await this.writeState(state, config)
      return `已隐藏 ${key}，用 .st showall 可查看全部`
    }
    if (/^(unhide|取消隐藏)\s+/i.test(text)) {
      const key = normalizeSkillName(text.replace(/^(unhide|取消隐藏)\s+/i, ""))
      const attrKey = ATTR_ALIASES[key] || key
      card.hiddenAttrs = (card.hiddenAttrs || []).filter(k => k !== attrKey)
      await this.writeState(state, config)
      return `已取消隐藏 ${key}`
    }
    const showMatch = text.match(/^(show|查看|查询)\s+(.+)$/i)
    if (showMatch) {
      const keyRaw = showMatch[2].trim()
      const key = normalizeSkillName(keyRaw)
      const attr = ATTR_ALIASES[keyRaw] || ATTR_ALIASES[key]
      const value = attr ? card.attrs?.[attr] : card.skills?.[key]
      return value === undefined ? `没有找到：${keyRaw}` : `${attr || key}=${value}`
    }
    const delMatch = text.match(/^(del|删除)\s+(.+)$/i)
    if (delMatch) {
      const keys = delMatch[2].split(/[,\s，]+/).filter(Boolean)
      const removed = []
      for (const keyRaw of keys) {
        const attr = ATTR_ALIASES[keyRaw]
        const key = attr || normalizeSkillName(keyRaw)
        if (attr && Object.prototype.hasOwnProperty.call(card.attrs || {}, attr)) {
          delete card.attrs[attr]
          removed.push(attr)
        } else if (Object.prototype.hasOwnProperty.call(card.skills || {}, key)) {
          delete card.skills[key]
          removed.push(key)
        }
      }
      if (!removed.length) return "没有找到要删除的字段。"
      await this.writeState(state, config)
      return `已删除：${removed.join("，")}`
    }
    const updates = []
    const compactExpressionTokens = text.split(/[,\s，]+/).filter(Boolean)
    for (const token of compactExpressionTokens) {
      const m = token.match(/^(.+?)([:=：])(.+)$/) || token.match(/^(.+?)([+\-])(.+)$/)
      if (!m || !/[dD+\-*/%()]/.test(m[3])) continue
      const keyRaw = m[1].trim()
      const operator = m[2]
      const expr = m[3].trim()
      const attr = ATTR_ALIASES[keyRaw]
      const normalizedKey = attr || normalizeSkillName(keyRaw)
      const current = attr ? Number(card.attrs?.[attr]) || 0 : Number(card.skills?.[normalizedKey]) || 0
      let delta
      try {
        delta = this.rollExpression(expr, config).total
      } catch {
        continue
      }
      const value = operator === "+" ? current + delta : operator === "-" ? current - delta : delta
      if (attr) card.attrs[attr] = value
      else card.skills[normalizedKey] = value
      updates.push([normalizedKey, value])
    }
    if (updates.length) {
      await this.writeState(state, config)
      return renderTemplate(config.templates.cardSaved, { name: this.getUserName(e), updates: formatUpdates(updates) })
    }
    const pairs = text.match(/[^,\s，]+(?:\s*[:=：]\s*|\s+)[+\-]?\d+|[^,\s，]+[+\-]\d+/g) || []
    const compactPairs = []
    // 紧凑中文格式「.st 敏捷0力量-1本能0生命6」(无分隔符):逐段"名+带符号数值"。
    // 必须先于 pairs 判定——贪婪的 [+-]\d+ 配对会把整串误切成"敏捷0力量=-1"这种垃圾键
    const isCompactCjkStats = !/[\s,，]/.test(text) && /[\u4e00-\u9fa5][+\-]?\d/.test(text) && !/[:=：]/.test(text)
    if (isCompactCjkStats) {
      const compactRe = /([A-Za-z\u4e00-\u9fa5_·•]+?)([+\-]?\d+)/g
      let match
      while ((match = compactRe.exec(text))) compactPairs.push(`${match[1]}=${match[2]}`)
    } else if (!pairs.length) {
      const compactRe = /([^\d\s,，:=：]+)(\d+)/g
      let match
      while ((match = compactRe.exec(text))) compactPairs.push(`${match[1]}=${match[2]}`)
    }
    for (const pair of (compactPairs.length ? compactPairs : pairs)) {
      const m = pair.match(/^(.+?)(?:\s*[:=：]\s*|\s+)([+\-]?\d+)$/) || pair.match(/^(.+?)([+\-]\d+)$/)
      if (!m) continue
      const keyRaw = m[1].trim()
      const rawValue = String(m[2])
      const attr = ATTR_ALIASES[keyRaw]
      const normalizedKey = attr || normalizeSkillName(keyRaw)
      const current = attr ? Number(card.attrs?.[attr]) || 0 : Number(card.skills?.[normalizedKey]) || 0
      const value = /^[+\-]/.test(rawValue) && !/[=:：]/.test(pair)
        ? current + Number(rawValue)
        : Number(rawValue)
      if (!Number.isFinite(value)) continue
      if (attr) card.attrs[attr] = value
      else card.skills[normalizedKey] = value
      updates.push([normalizedKey, value])
    }
    if (!updates.length) return "没有识别到属性或技能。格式：.st STR=50 侦查=60 或 .st 侦查 60"
    await this.writeState(state, config)
    return renderTemplate(config.templates.cardSaved, { name: this.getUserName(e), updates: formatUpdates(updates) })
  }

  renderCard(e, card, config = this.getConfig(), options = {}) {
    // 群级 .st fmt 模板：{属性名} 替换为对应数值（属性/技能均可引用）
    if (options.groupFmt && !options.showAll) {
      const lookup = {}
      for (const [key, value] of Object.entries({ ...(card.attrs || {}), ...(card.skills || {}) })) {
        lookup[String(key).toLowerCase()] = value
      }
      const expanded = String(options.groupFmt).replace(/\{([^{}\s]{1,40})\}/g, (_, key) => {
        const value = lookup[String(key).toLowerCase()]
        return value === undefined ? "-" : String(value)
      })
      return renderTemplate(config.templates.card, { name: this.getUserName(e), card: expanded })
    }
    const hidden = new Set(options.showAll ? [] : (card.hiddenAttrs || []))
    const attrs = Object.entries(card.attrs || {})
      .filter(([k]) => options.showAll || !hidden.has(k))
      .map(([k, v]) => `${k}:${v}`).join(" ")
    const skills = Object.entries(card.skills || {})
      .filter(([k]) => options.showAll || !hidden.has(k))
      .map(([k, v]) => `${k}:${v}`).join(" ")
    const cardText = [
      `角色：${card.name || this.getUserName(e)}`,
      `状态：${this.isCardLocked(card) ? "已锁定" : "可编辑"}`,
      attrs ? `属性：${attrs}` : "属性：暂无",
      skills ? `技能：${skills}` : "技能：暂无"
    ].join("\n")
    return renderTemplate(config.templates.card, { name: this.getUserName(e), card: cardText })
  }

  async handlePc(e, raw = "") {
    const config = this.getConfig()
    const state = this.readState(config)
    const user = this.ensureUser(state, e)
    const text = String(raw || "").trim()
    const [cmd, ...rest] = text.split(/\s+/)
    const name = rest.join(" ").trim()
    if (!cmd || /^(list|列表)$/i.test(cmd)) {
      const cards = Object.entries(user.cards).map(([cardName, card]) => `${cardName}${this.isCardLocked(card) ? "🔒" : ""}`)
      return `人物卡：${cards.join("，")}\n当前：${user.activeCard}`
    }
    if (/^(new|新增|创建|save|保存)$/i.test(cmd)) {
      if (!name) return "格式：.pc new 角色名"
      user.cards[name] = user.cards[name] || { name, attrs: {}, skills: {} }
      user.activeCard = name
      await this.writeState(state, config)
      return `已保存并切换人物卡：${name}${await this.syncAutoGroupCard(e, user.cards[name].name || name, state, config)}`
    }
    if (/^(use|切换|使用|load|载入)$/i.test(cmd)) {
      if (!user.cards[name]) return `没有找到人物卡：${name}`
      user.activeCard = name
      await this.writeState(state, config)
      return `已切换人物卡：${name}${await this.syncAutoGroupCard(e, user.cards[name].name || name, state, config)}`
    }
    if (/^(del|删除)$/i.test(cmd)) {
      if (!user.cards[name]) return `没有找到人物卡：${name}`
      if (this.isCardLocked(user.cards[name])) return this.lockedCardReply(user.cards[name])
      delete user.cards[name]
      user.activeCard = Object.keys(user.cards)[0] || "默认"
      if (!user.cards[user.activeCard]) user.cards[user.activeCard] = { name: user.nickname || "调查员", attrs: {}, skills: {} }
      await this.writeState(state, config)
      return `已删除人物卡：${name}`
    }
    if (/^(tag|标签)$/i.test(cmd)) {
      const card = user.cards[user.activeCard]
      if (this.isCardLocked(card)) return this.lockedCardReply(card)
      card.tags = name ? name.split(/[,\s，]+/).filter(Boolean) : []
      await this.writeState(state, config)
      return `当前人物卡标签：${card.tags.join("，") || "无"}`
    }
    if (/^(lock|锁定)$/i.test(cmd)) {
      user.cards[user.activeCard].locked = true
      await this.writeState(state, config)
      return "当前人物卡已锁定。"
    }
    if (/^(unlock|解锁)$/i.test(cmd)) {
      user.cards[user.activeCard].locked = false
      await this.writeState(state, config)
      return "当前人物卡已解锁。"
    }
    return "人物卡命令：.pc list / .pc new|save 名字 / .pc use|load 名字 / .pc del 名字 / .pc tag 标签 / .pc lock"
  }

  async handleNn(e, raw = "") {
    const config = this.getConfig()
    const name = String(raw || "").trim()
    if (!name) return "格式：.nn 昵称"
    const state = this.readState(config)
    const user = this.ensureUser(state, e)
    user.nickname = name.slice(0, 30)
    await this.writeState(state, config)
    return `骰娘昵称已设置为：${user.nickname}${await this.syncAutoGroupCard(e, user.nickname, state, config)}`
  }

  async handleSetCoc(e, raw = "") {
    const config = this.getConfig()
    const state = this.readState(config)
    const groupId = String(e?.group_id || "private")
    state.groups[groupId] ||= {}
    const text = String(raw || "").trim()
    if (!text) {
      return [
        `当前群规则：${state.groups[groupId].rule || config.defaultRule}（实际按 ${this.normalizeCocRule(state.groups[groupId].rule || config.defaultRule)} 生效）`,
        "支持 setcoc 0-5：",
        "0: 1大成功；技能<50 时 96-100 大失败，否则 100 大失败",
        "1: 技能>=50 时 1-5 大成功；大失败同 0",
        "2: 1-5 且不超过技能大成功；96-100 且超过技能大失败",
        "3: 1-5 大成功；96-100 大失败",
        "4: 1-5 且不超过技能大成功；100 大失败",
        "5: 1 大成功；100 大失败"
      ].join("\n")
    }
    if (!this.canManageGroupDice(e)) return "只有主人、群主或管理员可以修改当前群 COC 房规。"
    if (!this.isValidCocRule(text)) {
      return "规则不认识。请使用：.setcoc 0 / 1 / 2 / 3 / 4 / 5 / 无大失败"
    }
    state.groups[groupId].rule = this.normalizeCocRule(text)
    await this.writeState(state, config)
    return `已设置当前群 COC 规则：${state.groups[groupId].rule}`
  }

  handleInsanity(type = "ti") {
    const config = this.getConfig()
    const list = type === "li"
      ? (config.insanityTables?.indefinite || DEFAULT_INDEFINITE_INSANITY)
      : (config.insanityTables?.temp || DEFAULT_TEMP_INSANITY)
    if (!list.length) return "疯狂表是空的。"
    const idx = rollInt(list.length) - 1
    return renderTemplate(config.templates.insanity, {
      kind: type === "li" ? "总结疯狂" : "临时疯狂",
      index: idx + 1,
      text: list[idx]
    })
  }

  showHelp() {
    return [
      "COC 骰娘（发 .骰规则 查看规则包管理命令）：",
      ".r[表达式] - 普通掷骰，如 .r1d100 / .r 2d6+3 / .r 3#1d100 / .r2d10#3",
      "复杂表达式：支持多层括号、四则运算、取余和多个骰组，如 .r ((2d6+3)*2)%5、.r (1d8+1d4)*2",
      "进阶骰法：也支持取高/取低/丢高/丢低，如 .r 4d6kh3、.r 10d6dl2",
      ".bp[数量] / .pp[数量] - 奖励骰 / 惩罚骰掷骰",
      ".ra 技能 60 - COC 检定；.rb/.rp 或 .ra+1/.ra-1 为奖励/惩罚骰",
      ".rav A 60 vs B 50 - 对抗检定；也支持 .rav 斗殴 @对方",
      ".rh 技能 60 - 暗检定，结果私聊",
      ".sc 1/1d6 60 - SAN Check",
      ".en 技能 60 - 成长检定",
      ".coc7[数量] / .天命[数量] - 生成 COC7 属性，如 .coc5 / .天命5",
      ".st - 查看卡；.st STR=50 侦查=60 / .st san-1 - 录卡或增减",
      ".pc list/new/use/del/tag/lock - 人物卡管理",
      ".nn 昵称 - 设置骰娘显示名并同步QQ群名片（需 .sn on 开启同步）",
      ".sn on/off - 开/关自动群名片同步：把角色卡名/骰娘昵称同步为自己的QQ群名片",
      ".reply on/off - 管理员开启或关闭当前群骰娘回复",
      ".jrrp - 今日人品；.db [STR SIZ] - 伤害加值",
      ".ti / .li - 临时疯狂 / 总结疯狂",
      ".setcoc [规则] - 查看或设置当前群规则",
      ".dnd[数量] / .namednd[数量] - DND 属性与随机姓名",
      ".rc 敏捷 优势 +3 / .ri +3 / .init list - DND 检定与先攻",
      ".buff / .ss / .cast / .longrest / .ds - DND Buff、法术位、长休、死亡豁免",
      ".ww / .dx / .ek / .ekgen / .rsr - 其它规则基础骰与随机选择",
      ".find 关键词 - 搜索本地词条；.set d20 - 设置默认骰",
      ".draw 牌组 - 抽牌；.draw keys/list/search/desc/reload - 牌堆管理",
      ".骰规则帮助 - 固定点命令的 YAML 规则包、角色权限与团务系统",
      ".log new [标题] / .log on / .log off / .log status / .log export [历史序号] / .log end - 跑团记录与完整文件导出"
    ].join("\n")
  }
}

export const diceManager = new DiceManager()
