import vm from "node:vm"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "node:url"
import { secureDiceInt } from "../../utils/diceRandom.js"

// 海豹骰（sealdice）JS 扩展兼容运行时：第三种规则包导入格式。
// 在 node:vm 沙箱中执行社区脚本，提供 seal API 子集（ext/vars/format/replyToSender/
// getCtxProxyFirst/gameSystem 等），命令注册后交由规则包管理器统一启停与分发。
// 未实现的 API 安全降级：打日志 + 返回默认值，绝不让脚本崩掉宿主。

const SCRIPT_TIMEOUT_MS = 3000
const SOLVE_TIMEOUT_MS = 5000

function resolveDefaultStatePath() {
  const here = fileURLToPath(import.meta.url)
  return path.join(path.dirname(path.dirname(path.dirname(here))), "data", "dice_seal_ext_state.json")
}

export function looksLikeSealExtensionSource(source = "") {
  const text = String(source || "")
  if (/==UserScript==/.test(text) && /@diceRequireVer|seal\./.test(text)) return true
  return /seal\.ext\.(register|new)\b/.test(text)
}

export function extractUserScriptMeta(source = "") {
  const meta = {}
  const block = String(source || "").match(/==UserScript==([\s\S]*?)==\/UserScript==/)?.[1] || ""
  for (const line of block.split("\n")) {
    const match = line.match(/^\/\/\s*@(\w+)\s+(.+)$/)
    if (match) meta[match[1]] = match[2].trim()
  }
  return meta
}

/**
 * 创建一个海豹扩展运行时。
 * varsAdapter: { get(group,userId,name)->[value,exists], set(group,userId,name,value) }
 * replyAdapter: 异步发送函数 (targetEvent, text)=>Promise
 */
export class SealExtRuntime {
  constructor({ packId = "seal-ext", varsAdapter = null, replyAdapter = null, logger = globalThis.logger, statePath = "" } = {}) {
    this.packId = packId
    this.logger = logger
    this.varsAdapter = varsAdapter
    this.replyAdapter = replyAdapter
    this.statePath = statePath || resolveDefaultStatePath()
    this.storage = this.loadStorage()
    this.extensions = new Map()
    this.pendingReplies = []
    this.logs = []
    this.templateRegistry = []
    this.unsupportedCalls = []
  }

  loadStorage() {
    try {
      return JSON.parse(fs.readFileSync(this.statePath, "utf-8")) || {}
    } catch {
      return {}
    }
  }

  saveStorage() {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true })
      fs.writeFileSync(this.statePath, JSON.stringify(this.storage, null, 2), "utf-8")
    } catch (error) {
      this.logger?.warn?.(`[海豹扩展] 存储写入失败: ${error?.message || error}`)
    }
  }

  noteUnsupported(api, fallback) {
    const note = `${api}（已降级${fallback ? `：${fallback}` : ""}）`
    if (!this.unsupportedCalls.includes(note)) this.unsupportedCalls.push(note)
    this.logger?.warn?.(`[海豹扩展] 未支持 API：${note}`)
  }

  buildVarsApi() {
    const readVar = (ctx, name) => {
      if (this.varsAdapter) {
        const [value, exists] = this.varsAdapter.get(ctx.group?.groupId, ctx.player?.userId, name)
        if (exists) return [Number(value) || 0, true]
      }
      const store = this.storage.__vars?.[`${ctx.group?.groupId || "private"}:${ctx.player?.userId}:${name}`]
      if (store !== undefined) return [Number(store) || 0, true]
      return [0, false]
    }
    const writeVar = (ctx, name, value) => {
      if (this.varsAdapter && this.varsAdapter.set(ctx.group?.groupId, ctx.player?.userId, name, value)) return
      this.storage.__vars ||= {}
      this.storage.__vars[`${ctx.group?.groupId || "private"}:${ctx.player?.userId}:${name}`] = value
      this.saveStorage()
    }
    const readStr = (ctx, name) => {
      const store = this.storage.__strvars?.[`${ctx.group?.groupId || "private"}:${ctx.player?.userId}:${name}`]
      return [store === undefined ? "" : String(store), store !== undefined]
    }
    return {
      intGet: (ctx, name) => readVar(ctx, name),
      intSet: (ctx, name, value) => writeVar(ctx, name, Math.trunc(Number(value) || 0)),
      strGet: (ctx, name) => readStr(ctx, name),
      strSet: (ctx, name, value) => {
        this.storage.__strvars ||= {}
        this.storage.__strvars[`${ctx.group?.groupId || "private"}:${ctx.player?.userId}:${name}`] = String(value)
        this.saveStorage()
      },
      getVar: (ctx, name) => readVar(ctx, name),
      setVar: (ctx, name, value) => writeVar(ctx, name, value)
    }
  }

  makeExtObject(name, author, version) {
    const runtime = this
    const ext = {
      name: String(name || "ext"),
      author: String(author || ""),
      version: String(version || "1.0.0"),
      cmdMap: {},
      storageSet: (key, value) => {
        runtime.storage[`${ext.name}:${key}`] = String(value ?? "")
        runtime.saveStorage()
      },
      storageGet: (key) => runtime.storage[`${ext.name}:${key}`] || ""
    }
    return ext
  }

  buildSealApi() {
    const runtime = this
    const extApi = {
      new: (name, author, version) => runtime.makeExtObject(name, author, version),
      find: (name) => runtime.extensions.get(String(name)) || null,
      register: (ext) => {
        if (!ext?.name) throw new Error("扩展缺少 name")
        runtime.extensions.set(ext.name, ext)
        return true
      },
      newCmdItemInfo: () => ({ name: "", help: "", solve: null, allowDelegate: false }),
      newCmdExecuteResult: (matched = true) => ({ matched: Boolean(matched), solved: true, showHelp: false }),
      registerStringInterceptor: () => {
        runtime.noteUnsupported("seal.ext.registerStringInterceptor", "返回空拦截器")
        return { before: () => "" }
      }
    }
    return {
      ext: extApi,
      vars: this.buildVarsApi(),
      replyToSender: (ctx, msg, text) => {
        runtime.pendingReplies.push({ target: msg?.__event || ctx?.__event || null, text: String(text ?? "") })
      },
      replyToChannel: (ctx, msg, text) => {
        runtime.noteUnsupported("seal.replyToChannel", "改用 replyToSender")
        runtime.pendingReplies.push({ target: msg?.__event || ctx?.__event || null, text: String(text ?? "") })
      },
      format: (ctx, text) => runtime.formatString(ctx, text),
      getCtxProxyFirst: (ctx, cmdArgs) => {
        const at = cmdArgs?.at?.[0]
        if (at?.userId && String(at.userId) !== String(ctx.player?.userId)) {
          return runtime.makeContext({ event: ctx.__event, userId: String(at.userId), name: at.name || String(at.userId), groupId: ctx.group?.groupId, isPrivate: false, proxied: true })
        }
        return ctx
      },
      applyPlayerGroupCardByTemplate: (ctx, template) => {
        try {
          runtime.applyGroupCardByTemplate(ctx, template)
        } catch (error) {
          runtime.logger?.debug?.(`[海豹扩展] 群名片更新失败: ${error?.message || error}`)
        }
      },
      gameSystem: {
        newTemplate: (json) => {
          try {
            const template = JSON.parse(json)
            runtime.templateRegistry.push(template)
            if (template.defaults) {
              for (const [name, value] of Object.entries(template.defaults)) {
                runtime.storage[`__tpl_default:${name}`] = value
              }
              runtime.saveStorage()
            }
          } catch {}
          return true
        },
        findTemplate: () => null
      },
      st: {},
      deck: {},
      cud: {},
      tsl: {},
      ban: {},
      censor: {}
    }
  }

  /**
   * 群名片模板应用：{$t玩家_RAW} 为玩家名，{变量} 走 vars（人物卡）。
   * 需要 bot.sendApi("set_group_card")；机器人无群管理权限时静默失败。
   */
  applyGroupCardByTemplate(ctx, template = "") {
    const event = ctx?.__event
    if (!event?.group_id) return false
    const bot = event?.bot || globalThis.Bot
    if (typeof bot?.sendApi !== "function") return false
    const rendered = String(template ?? "")
      .replace(/\{\$t玩家_RAW\}/g, () => ctx.player?.name || String(ctx.player?.userId || ""))
      .replace(/\{([^{}]+)\}/g, (raw, name) => {
        const [value, exists] = this.buildVarsApi().intGet(ctx, name)
        return exists ? String(value) : raw
      })
      .slice(0, 60)
    if (!rendered.trim()) return false
    const targetUser = String(ctx.player?.userId || "")
    Promise.resolve(bot.sendApi("set_group_card", {
      group_id: Number(event.group_id),
      user_id: Number(targetUser),
      card: rendered
    })).then(result => {
      if (!result || result.status === "failed" || (result.retcode !== undefined && Number(result.retcode) !== 0)) {
        this.logger?.debug?.(`[海豹扩展] 群名片未生效（可能缺少群管理权限）: ${result?.wording || result?.msg || "无回执"}`)
      }
    }).catch(error => {
      this.logger?.debug?.(`[海豹扩展] 群名片更新失败: ${error?.message || error}`)
    })
    return true
  }

  /** sealdice seal.format 子集：{dN} 掷骰、{$t玩家}、{变量名}（走 vars） */
  formatString(ctx, text = "") {
    return String(text ?? "").replace(/\{([^{}]+)\}/g, (raw, name) => {
      if (/^\$t玩家$/.test(name)) return ctx.player?.name || "玩家"
      if (/^\$t骰子名字$/.test(name)) return "骰娘"
      if (/^d\d+$/.test(name)) return String(secureDiceInt(Number(name.slice(1))))
      const [value, exists] = this.buildVarsApi().intGet(ctx, name)
      if (exists) return String(value)
      if (/^\d+$/.test(name)) return name
      return raw
    })
  }

  makeContext({ event, userId, name, groupId, isPrivate = false, proxied = false }) {
    return {
      __event: event || null,
      __proxied: proxied,
      isPrivate: Boolean(isPrivate),
      player: { userId: String(userId || ""), name: String(name || userId || "") },
      group: groupId ? { groupId: String(groupId) } : null,
      endTime: null,
      deckDepth: 0
    }
  }

  /** 沙箱执行脚本本体（注册期）。返回 { extensions, commands, logs, unsupported } */
  run(source = "") {
    const seal = this.buildSealApi()
    const sandboxConsole = {
      log: (...args) => {
        const line = args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ")
        this.logs.push(line)
        if (this.logs.length > 200) this.logs.shift()
      },
      warn: (...args) => {
        const line = args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ")
        this.logs.push("[warn] " + line)
      },
      error: (...args) => {
        const line = args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ")
        this.logs.push("[error] " + line)
      }
    }
    const context = vm.createContext({
      seal,
      console: sandboxConsole,
      Math, JSON, Date, RegExp, String, Number, Array, Object, Boolean, Map, Set, Promise, Symbol, BigInt,
      parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
      setTimeout: (fn, ms) => { this.noteUnsupported("setTimeout", "注册期不执行定时器") },
      setInterval: () => { this.noteUnsupported("setInterval", "不执行定时器") },
      clearTimeout: () => {}, clearInterval: () => {}
    }, { name: `seal-ext:${this.packId}` })
    vm.runInContext(String(source || ""), context, { timeout: SCRIPT_TIMEOUT_MS, displayErrors: true })

    const commands = []
    for (const ext of this.extensions.values()) {
      for (const [cmdName, cmd] of Object.entries(ext.cmdMap || {})) {
        if (typeof cmd?.solve === "function" && cmdName) {
          commands.push({ name: String(cmdName), help: String(cmd.help || ""), allowDelegate: Boolean(cmd.allowDelegate) })
        }
      }
    }
    return { extensions: [...this.extensions.keys()], commands, unsupported: [...this.unsupportedCalls] }
  }

  /** 分发一条命令。返回 { matched, solved, showHelp, replies } */
  dispatch(cmdName, { event, userId, userName, groupId, isPrivate, args = [], kwargs = [], at = [], rawArgs = "", command = "" } = {}) {
    const cmd = this.findCommand(cmdName)
    if (!cmd) return { matched: false, solved: false, showHelp: false, replies: [] }
    const ctx = this.makeContext({ event, userId, name: userName, groupId, isPrivate })
    const msg = { __event: event }
    const cmdArgs = { command: command || cmdName, args, kwargs, at, rawArgs }
    this.pendingReplies = []
    let result = { matched: true, solved: true, showHelp: false }
    try {
      const returned = cmd.solve(ctx, msg, cmdArgs)
      if (returned && typeof returned === "object") {
        result = {
          matched: returned.matched !== false,
          solved: returned.solved !== false,
          showHelp: Boolean(returned.showHelp)
        }
      }
    } catch (error) {
      this.logger?.warn?.(`[海豹扩展] ${this.packId}/${cmdName} 执行出错: ${error?.message || error}`)
      result = { matched: true, solved: true, showHelp: false, error: String(error?.message || error) }
    }
    const replies = this.pendingReplies.splice(0)
    return { ...result, replies }
  }

  findCommand(cmdName = "") {
    for (const ext of this.extensions.values()) {
      const cmd = ext.cmdMap?.[String(cmdName)]
      if (cmd && typeof cmd.solve === "function") return cmd
    }
    return null
  }

  listCommands() {
    const commands = []
    for (const ext of this.extensions.values()) {
      for (const [name, cmd] of Object.entries(ext.cmdMap || {})) {
        if (typeof cmd?.solve === "function") commands.push({ name, help: String(cmd.help || "") })
      }
    }
    return commands
  }

  compatibilityReport() {
    const unsupported = [...this.unsupportedCalls]
    return unsupported.length
      ? `兼容性提示：${unsupported.join("；")}`
      : "兼容性：全部 API 已支持"
  }
}
