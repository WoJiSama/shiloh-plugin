import type {SealOptions,SealContext,SealEvent,SealExtension,SealCommand,SealRule,SealDispatch,SealMention} from '../../../contracts/sealExtension.js';
import {pixivRecord as record} from '../../../contracts/pixiv.js';
import vm from "node:vm"
import {AsyncLocalStorage} from "node:async_hooks"
interface DispatchState {closed:boolean;tempVars:Map<string,unknown>;replies:{target:SealEvent|null;text:string}[];delegateText:string}
import fs from "fs"
import path from "path"



// 海豹骰（sealdice）JS 扩展兼容运行时：第三种规则包导入格式。
// 在 node:vm 沙箱中执行社区脚本，提供 seal API 子集（ext/vars/format/replyToSender/
// getCtxProxyFirst/gameSystem 等），命令注册后交由规则包管理器统一启停与分发。
// 未实现的 API 安全降级：打日志 + 返回默认值，绝不让脚本崩掉宿主。

const SCRIPT_TIMEOUT_MS = 3000
const SOLVE_TIMEOUT_MS = 5000

function resolveDefaultStatePath() {
  return path.join(process.cwd(), "plugins/shiloh-plugin/data/dice_seal_ext_state.json")
}

export function looksLikeSealExtensionSource(source = "") {
  const text = String(source || "")
  if (/==UserScript==/.test(text) && /@diceRequireVer|seal\./.test(text)) return true
  return /seal\.ext\.(register|new)\b/.test(text)
}

export function extractUserScriptMeta(source = "") {
  const meta:Record<string,string> = {}
  const block = String(source || "").match(/==UserScript==([\s\S]*?)==\/UserScript==/)?.[1] || ""
  for (const line of block.split("\n")) {
    const match = line.match(/^\/\/\s*@(\w+)\s+(.+)$/)
    if (match?.[1]&&match[2]) meta[match[1]] = match[2].trim()
  }
  return meta
}

/**
 * 创建一个海豹扩展运行时。
 * varsAdapter: { get(group,userId,name)->[value,exists], set(group,userId,name,value) }
 * replyAdapter: 异步发送函数 (targetEvent, text)=>Promise
 */
export class SealExtRuntime {
 packId:string;logger:SealOptions['logger'];varsAdapter:SealOptions['varsAdapter'];replyAdapter:SealOptions['replyAdapter'];statePath:string;storage:Record<string,unknown>;extensions:Map<string,SealExtension>;ruleRegistry:SealRule[];cardTemplateMemory:Map<string,string>;logs:string[];templateRegistry:Record<string,unknown>[];unsupportedCalls:string[];

  constructor({ packId = "seal-ext", varsAdapter = null, replyAdapter = null, logger, statePath = "" }:SealOptions = {}) {
    this.packId = packId
    this.logger = logger
    this.varsAdapter = varsAdapter
    this.replyAdapter = replyAdapter
    this.statePath = statePath || resolveDefaultStatePath()
    this.storage = this.loadStorage()
    this.extensions = new Map()
    this.pendingReplies = []
    // 规则键注册表:包声明的 .set 可用规则键(dh/daggerheart/匕首心等)
    this.ruleRegistry = []
    // 群名片模板记忆:groupId:userId -> 最近一次应用的模板原文。
    // .st 改属性后按记忆重渲染,让名片立刻反映新数值(不必等下一次 .dd)
    this.cardTemplateMemory = new Map(Object.entries(record(this.storage.__card_tpl)).filter((entry):entry is [string,string]=>typeof entry[1]==='string'))
    this.pendingDelegateText = ""
    this.logs = []
    this.templateRegistry = []
    this.unsupportedCalls = []
  }

  loadStorage() {
    try {
      return record(JSON.parse(fs.readFileSync(this.statePath, "utf-8")))
    } catch {
      return {}
    }
  }

  saveStorage() {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true })
      fs.writeFileSync(this.statePath, JSON.stringify(this.storage, null, 2), "utf-8")
    } catch (error) {
      this.logger?.warn?.(`[海豹扩展] 存储写入失败: ${error instanceof Error?error.message:String(error)}`)
    }
  }

  /** 已实现的 seal API 面(静态审计对照用);值为降级说明则标记为部分支持 */
  static get SUPPORTED_SEAL_APIS():Record<string,boolean|string> {
    return {
      "seal.ext.new": true, "seal.ext.find": true, "seal.ext.register": true,
      "seal.ext.newCmdItemInfo": true, "seal.ext.newCmdExecuteResult": true,
      "seal.ext.registerStringInterceptor": "返回空拦截器,不真正拦截",
      "seal.replyToSender": true, "seal.replyToChannel": "降级为 replyToSender",
      "seal.format": true, "seal.getCtxProxyFirst": true,
      "seal.applyPlayerGroupCardByTemplate": true,
      "seal.vars.intGet": true, "seal.vars.intSet": true,
      "seal.vars.strGet": true, "seal.vars.strSet": true,
      "seal.vars.getVar": true, "seal.vars.setVar": true,
      "seal.gameSystem.newTemplate": true, "seal.gameSystem.findTemplate": "恒返回 null",
      "seal.setRule": true,
      "seal.deck": "桩:不支持牌堆操作",
      "seal.cud": "桩:不支持自定义指令",
      "seal.tsl": "桩:不支持翻译",
      "seal.ban": "桩:不支持封禁",
      "seal.censor": "桩:不支持敏感词"
    }
  }

  /** 静态审计:从源码提取 seal.* 调用并按实现面分类 */
  auditApiUsage(source = "") {
    const used = new Set<string>()
    for (const match of String(source || "").matchAll(/seal\.([a-zA-Z]+(?:\.[a-zA-Z]+)?)/g)) {
      used.add(`seal.${match[1]}`)
    }
    // 两段式调用(seal.deck.draw)按一段式前缀(seal.deck)归并到桩分类,
    // 但明确声明的两段式(如 vars.intGet)保持精确匹配
    const surface = SealExtRuntime.SUPPORTED_SEAL_APIS
    for (const api of [...used]) {
      if (surface[api] !== undefined) continue
      const parts = api.split(".")
      if (parts.length === 3) {
        const prefix = parts.slice(0, 2).join(".")
        if (surface[prefix] !== undefined) used.delete(api), used.add(prefix)
      }
    }
    const supported = []
    const degraded = []
    const missing = []
    for (const api of [...used].sort()) {
      const status = SealExtRuntime.SUPPORTED_SEAL_APIS[api]
      if (status === true) supported.push(api)
      else if (typeof status === "string") degraded.push(`${api}(${status})`)
      else missing.push(api)
    }
    return { supported, degraded, missing, total: used.size }
  }

  noteUnsupported(api:string, fallback:string) {
    const note = `${api}（已降级${fallback ? `：${fallback}` : ""}）`
    if (!this.unsupportedCalls.includes(note)) this.unsupportedCalls.push(note)
    this.logger?.warn?.(`[海豹扩展] 未支持 API：${note}`)
  }

  // 海豹 vars 四层作用域: $t临时(每次dispatch重置) / $m个人全局(跨群) /
  // $g群变量(按群) / 无前缀=当前群+玩家的绑定人物卡。
  // 作用域键各异,互不污染。
  private readonly dispatchScope = new AsyncLocalStorage<DispatchState>()
  private readonly idleState:DispatchState = {closed:false,tempVars:new Map(),replies:[],delegateText:''}
  private get dispatchState(){return this.dispatchScope.getStore() || this.idleState}
  get tempVars(){return this.dispatchState.tempVars}
  get pendingReplies(){return this.dispatchState.replies}
  set pendingReplies(value:{target:SealEvent|null;text:string}[]){this.dispatchState.replies=value}
  get pendingDelegateText(){return this.dispatchState.delegateText}
  set pendingDelegateText(value:string){this.dispatchState.delegateText=value}

  scopeOf(name:string) {
    if (name.startsWith("$t")) return "temp"
    if (name.startsWith("$m")) return "personal"
    if (name.startsWith("$g")) return "group"
    return "card"
  }

  scopeKey(ctx:SealContext, name:string) {
    const s = this.scopeOf(name)
    const groupId = ctx.group?.groupId || "private"
    const userId = ctx.player?.userId || ""
    const bare = name.replace(/^\$[tmg]/, "")
    if (s === "temp") return `__t:${groupId}:${userId}:${bare}`
    if (s === "personal") return `__m:${userId}:${bare}`
    if (s === "group") return `__g:${groupId}:${bare}`
    return `__c:${groupId}:${userId}:${bare}`
  }

  buildVarsApi() {
    const readScoped = (ctx:SealContext, name:string, isStr = false):[string|number,boolean] => {
      const key = this.scopeKey(ctx, name)
      const scope = this.scopeOf(name)
      if (scope === "temp") {
        const store = this.tempVars.get(key)
        if (store !== undefined) return isStr ? [String(store), true] : [Number(store) || 0, true]
        return isStr ? ["", false] : [0, false]
      }
      const store = record(this.storage.__scoped)[key]
      if (store !== undefined) return isStr ? [String(store), true] : [Number(store) || 0, true]
      // 无前缀且卡作用域:走 varsAdapter(人物卡)
      if (scope === "card" && this.varsAdapter) {
        const [value, exists] = this.varsAdapter.get(ctx.group?.groupId, ctx.player?.userId, name)
        if (exists) {
          // M7 海豹语义:intGet 仅当值类型为数值才 exists=true(字符串值≠0)
          if (!isStr && typeof value === "string" && !/^-?\d+$/.test(value)) return [0, false]
          return isStr ? [String(value), true] : [Number(value) || 0, true]
        }
      }
      return isStr ? ["", false] : [0, false]
    }
    const writeScoped = (ctx:SealContext, name:string, value:unknown) => {
      if (this.dispatchState.closed) return
      const key = this.scopeKey(ctx, name)
      const scope = this.scopeOf(name)
      if (scope === "temp") {
        this.tempVars.set(key, value)
        return
      }
      // 无前缀且卡作用域:写回 varsAdapter(人物卡)
      if (scope === "card" && this.varsAdapter) {
        this.varsAdapter.set(ctx.group?.groupId, ctx.player?.userId, name, value)
        return
      }
      const scoped=record(this.storage.__scoped);this.storage.__scoped=scoped;scoped[key] = value
      this.saveStorage()
    }
    return {
      intGet: (ctx:SealContext, name:string) => readScoped(ctx, name, false),
      intSet: (ctx:SealContext, name:string, value:unknown) => writeScoped(ctx, name, Math.trunc(Number(value) || 0)),
      strGet: (ctx:SealContext, name:string) => readScoped(ctx, name, true),
      strSet: (ctx:SealContext, name:string, value:unknown) => writeScoped(ctx, name, String(value)),
      getVar: (ctx:SealContext, name:string) => readScoped(ctx, name, false),
      setVar: (ctx:SealContext, name:string, value:unknown) => writeScoped(ctx, name, value)
    }
  }

  makeExtObject(name:unknown, author:unknown, version:unknown):SealExtension {
    const runtime = this
    const ext:SealExtension = {
      name: String(name || "ext"),
      author: String(author || ""),
      version: String(version || "1.0.0"),
      cmdMap: {},
      storageSet: (key:string, value:unknown) => {
        runtime.storage[`${ext.name}:${key}`] = String(value ?? "")
        runtime.saveStorage()
      },
      storageGet: (key:string) => runtime.storage[`${ext.name}:${key}`] || ""
    }
    return ext
  }

  buildSealApi() {
    const runtime = this
    const extApi = {
      new: (name:unknown, author:unknown, version:unknown) => runtime.makeExtObject(name, author, version),
      find: (name:unknown) => runtime.extensions.get(String(name)) || null,
      register: (ext:SealExtension) => {
        if (!ext?.name) throw new Error("扩展缺少 name")
        runtime.extensions.set(ext.name, ext)
        return true
      },
      newCmdItemInfo: ():SealCommand => ({ name: "", help: "", solve: null, allowDelegate: false }),
      // 海豹语义:首参是 solved(非 matched),matched 恒 true
      newCmdExecuteResult: (solved = true) => ({ matched: true, solved: Boolean(solved), showHelp: false }),
      registerStringInterceptor: () => {
        runtime.noteUnsupported("seal.ext.registerStringInterceptor", "返回空拦截器")
        return { before: () => "" }
      }
    }
    return {
      ext: extApi,
      vars: this.buildVarsApi(),
      replyToSender: (ctx:SealContext,msg:{__event?:SealEvent},text:unknown) => {
        if (runtime.dispatchState.closed) return
        const prefix = runtime.pendingReplies.length === 0 ? (runtime.pendingDelegateText || "") : ""
        runtime.pendingReplies.push({ target: msg?.__event || ctx?.__event || null, text: prefix + String(text ?? "") })
      },
      replyToChannel: (ctx:SealContext,msg:{__event?:SealEvent},text:unknown) => {
        if (runtime.dispatchState.closed) return
        runtime.noteUnsupported("seal.replyToChannel", "改用 replyToSender")
        runtime.pendingReplies.push({ target: msg?.__event || ctx?.__event || null, text: String(text ?? "") })
      },
      format: (ctx:SealContext, text:string) => runtime.formatString(ctx, text),
      getCtxProxyFirst: (ctx:SealContext, cmdArgs:{at?:SealMention[]}) => {
        // 海豹语义:取第一个非发送者且非 bot 的 @目标
        const botId = String(ctx?.__event?.bot?.uin || "" || "")
        for (const at of (Array.isArray(cmdArgs?.at) ? cmdArgs.at : [])) {
          const atId = String(at?.userId || "")
          if (!atId) continue
          if (atId === String(ctx.player?.userId)) continue
          if (botId && atId === botId) continue
          return runtime.makeContext({ event: ctx.__event, userId: atId, name: at.name || String(atId), groupId: ctx.group?.groupId, isPrivate: false, proxied: true })
        }
        return ctx
      },
      applyPlayerGroupCardByTemplate: (ctx:SealContext, template:string) => {
        try {
          runtime.applyGroupCardByTemplate(ctx, template)
        } catch (error) {
          runtime.logger?.debug?.(`[海豹扩展] 群名片更新失败: ${error instanceof Error?error.message:String(error)}`)
        }
      },
      gameSystem: {
        newTemplate: (json:string) => {
          try {
            const template = record(JSON.parse(json))
            runtime.templateRegistry.push(template)
            if (template.defaults) {
              for (const [name, value] of Object.entries(record(template.defaults))) {
                runtime.storage[`__tpl_default:${name}`] = value
              }
              runtime.saveStorage()
            }
            // 收割模板 JSON 的 setConfig:海豹包以 {setConfig:{keys,enableTip,
            // diceSides}} 声明 .set 契约(如 daggerheart 的 dh/匕首心),
            // 平台 .set 命令据此识别规则键,无需改包
            const setConfig = record(template.setConfig || template.setRule)
            if (setConfig && Array.isArray(setConfig.keys) && setConfig.keys.length) {
              runtime.ruleRegistry.push({
                keys: setConfig.keys.map(String),
                enableTip: String(setConfig.enableTip || ""),
                diceSides: Number(setConfig.diceSides) || 0,
                templateName: String(template?.name || "")
              })
            }
          } catch {}
          return true
        },
        findTemplate: () => null
      },
      // setRule:海豹的规则切换注册(.set <key>)。包在模板 JSON 的
      // setRule/keys 字段声明可用规则键;平台 .set 命令据此识别并回调
      setRule: (input:unknown) => {
        try {
          const rule=record(input);
          const entry = {
            keys: Array.isArray(rule?.keys) ? rule.keys.map(String) : [],
            enableTip: String(rule?.enableTip || ""),
            relatedExt: Array.isArray(rule?.relatedExt) ? rule.relatedExt.map(String) : [],
            templateName: rule?.templateName ? String(rule.templateName) : ""
          }
          if (entry.keys.length) runtime.ruleRegistry.push(entry)
        } catch {}
        return true
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
  applyGroupCardByTemplate(ctx:SealContext, template = "") {
    const event = ctx?.__event
    if (!event?.group_id) return false
    const memoryKey = `${event.group_id}:${ctx.player?.userId || ""}`
    if (memoryKey.endsWith(":")) return false
    // M8 海豹语义:模板记忆持久化到 storage(重启不丢)
    const templateStr = String(template || "")
    this.cardTemplateMemory.set(memoryKey, templateStr)
    const templates=record(this.storage.__card_tpl);this.storage.__card_tpl=templates;templates[memoryKey] = templateStr
    this.saveStorage()
    const bot = event?.bot
    if (typeof bot?.sendApi !== "function") return false
    const rendered = String(template ?? "")
      .replace(/\{\$t玩家_RAW\}/g, () => ctx.player?.name || String(ctx.player?.userId || ""))
      .replace(/\{([^{}]+)\}/g, (raw, name) => {
        const [value, exists] = this.buildVarsApi().intGet(ctx, name)
        return exists ? String(value) : raw
      })
    // M8 海豹语义:QQ 名片≥60字报错不应用,不静默截断
    if (rendered.length >= 60) {
      this.logger?.warn?.(`[海豹扩展] 名片渲染超长(${rendered.length}字),不应用`)
      return false
    }
    if (!rendered.trim()) return false
    const targetUser = String(ctx.player?.userId || "")
    Promise.resolve(bot.sendApi("set_group_card", {
      group_id: Number(event.group_id),
      user_id: Number(targetUser),
      card: rendered
    })).then(result => {
      if (!result || record(result).status === "failed" || (record(result).retcode !== undefined && Number(record(result).retcode) !== 0)) {
        this.logger?.debug?.(`[海豹扩展] 群名片未生效（可能缺少群管理权限）: ${record(result).wording || record(result).msg || "无回执"}`)
      }
    }).catch(error => {
      this.logger?.debug?.(`[海豹扩展] 群名片更新失败: ${error instanceof Error?error.message:String(error)}`)
    })
    return true
  }

  /** 按记忆中的模板重渲染群名片(.st 后刷新用);无记忆返回 false */
  refreshCardFromMemory(event:SealEvent, userId = "") {
    const key = `${event?.group_id || ""}:${String(userId || "")}`
    const template = this.cardTemplateMemory.get(key)
    if (!template) return false
    const ctx = this.makeContext({ event, userId, name: "", groupId: event?.group_id })
    return this.applyGroupCardByTemplate(ctx, template)
  }

  /** sealdice seal.format:{...} 整块求值(骰表达式/算术/变量),外保留原文 */
  formatString(ctx:SealContext, text = "") {
    const vars = this.buildVarsApi()
    return String(text ?? "").replace(/\{([^{}]+)\}/g, (raw, name) => {
      if (/^\$t玩家(_RAW)?$/.test(name)) return ctx.player?.name || "玩家"
      if (/^\$t骰子(名字|昵称)$/.test(name)) return "骰娘"
      if (/^\$tQQ昵称$/.test(name)) return ctx.player?.name || "玩家"
      // 尝试变量替换
      const [value, exists] = vars.intGet(ctx, name)
      if (exists) return String(value)
      const [strValue, strExists] = vars.strGet(ctx, name)
      if (strExists && strValue) return String(strValue)
      // 尝试骰表达式/算术求值
      if (/[dD+\-*/()%\d\s]/.test(name) && /\d/.test(name)) {
        try {
          const result = this.evalDiceExpression(ctx, name, vars)
          if (result !== null) return String(result)
        } catch {}
      }
      if (/^\d+$/.test(name)) return name
      return raw
    })
  }

  /** 求值 {...} 内的骰表达式:先替换变量为数值,再按骰语法求值 */
  evalDiceExpression(ctx:SealContext, expr = "", vars:ReturnType<SealExtRuntime["buildVarsApi"]>|null = null) {
    if (!vars) vars = this.buildVarsApi()
    // 替换变量名为数值
    let resolved = String(expr)
    resolved = resolved.replace(/[\u4e00-\u9fa5A-Za-z_][\u4e00-\u9fa5A-Za-z_0-9]*/g, name => {
      if (/^[dD]$/.test(name)) return name
      const [value, exists] = vars.intGet(ctx, name)
      return exists ? String(value) : name
    })
    // 含未解析的变量名则放弃
    if (/[\u4e00-\u9fa5]/.test(resolved.replace(/\s/g, ""))) return null
    // 求值:处理 NdM 骰语法
    let total = 0
    let hasDice = false
    const diceOnly = resolved.replace(/(\d*)d(\d+)(kh\d+|kl\d+)?/gi, (_, count, sides, keep) => {
      hasDice = true
      const n = Math.min(Number(count) || 1, 100)
      const s = Math.min(Number(sides), 1000)
      let rolls = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * s))
      if (keep) {
        const k = Math.min(Number(keep.replace(/[a-z]/gi, "")) || 1, n)
        rolls = keep.startsWith("kh") ? rolls.sort((a, b) => b - a).slice(0, k) : rolls.sort((a, b) => a - b).slice(0, k)
      }
      total += rolls.reduce((sum, v) => sum + v, 0)
      return String(rolls.reduce((sum, v) => sum + v, 0))
    })
    // 纯算术部分
    if (!hasDice) {
      if (!/^[\d+\-*/()\s.]+$/.test(diceOnly)) return null
      try {
        const safe = diceOnly.replace(/\d+\.\d+/g, m => String(Number(m)))
        if (!/^[\d+\-*/()\s]+$/.test(safe)) return null
        // eslint-disable-next-line no-new-func
        total = Function(`"use strict";return (${safe})`)()
        if (!Number.isFinite(total)) return null
      } catch { return null }
    } else {
      // 骰表达式已替换为数值,再做算术
      const afterDice = diceOnly.replace(/(\d+)/g, "$1")
      if (/^[\d+\-*/()\s]+$/.test(afterDice)) {
        try {
          // eslint-disable-next-line no-new-func
          total = Function(`"use strict";return (${afterDice})`)()
          if (!Number.isFinite(total)) return null
        } catch {}
      }
    }
    return total
  }

  makeContext({ event, userId, name, groupId, isPrivate = false, proxied = false }:{event?:SealEvent|null|undefined;userId?:string|number|undefined;name?:string|undefined;groupId?:string|number|undefined;isPrivate?:boolean|undefined;proxied?:boolean}):SealContext {
    const uid = String(userId || "")
    return {
      __event: event || null,
      __proxied: proxied,
      isPrivate: Boolean(isPrivate),
      player: {
        userId: uid,
        // 玩家名优先取 .nn 设置的骰娘昵称(海豹语义),而非调用方硬传的 sender 名
        name: String(this.resolvePlayerName?.(uid) || name || uid || ""),
        lastCommandTime: Date.now(),
        autoSetNameTemplate: ""
      },
      group: groupId ? {
        groupId: String(groupId),
        groupName: String(event?.group_name || event?.sender?.group_name || ""),
        active: true,
        cocRuleIndex: 0,
        logOn: false,
        logCurName: "",
        enteredTime: Date.now(),
        showGroupWelcome: false,
        groupWelcomeMessage: ""
      } : null,
      endTime: null,
      deckDepth: 0,
      isCurGroupBotOn: true,
      privilegeLevel: 0,
      commandHideFlag: false,
      delegateText: "",
      notice: (title:string, body = "") => {
        this.noteUnsupported( "ctx.notice", "通知已忽略")
        return true
      }
    }
  }

  /** 默认按 userId 直返;由 manager 注入 resolver 后走 .nn 昵称 */
  resolvePlayerName(userId:string) {
    return ""
  }

  /** 沙箱执行脚本本体（注册期）。返回 { extensions, commands, logs, unsupported } */
  run(source = "") {
    const seal = this.buildSealApi()
    const sandboxConsole = {
      log: (...args:unknown[]) => {
        const line = args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ")
        this.logs.push(line)
        if (this.logs.length > 200) this.logs.shift()
      },
      warn: (...args:unknown[]) => {
        const line = args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ")
        this.logs.push("[warn] " + line)
      },
      error: (...args:unknown[]) => {
        const line = args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ")
        this.logs.push("[error] " + line)
      }
    }
    const context = vm.createContext({
      seal,
      console: sandboxConsole,
      Math, JSON, Date, RegExp, String, Number, Array, Object, Boolean, Map, Set, Promise, Symbol, BigInt,
      parseInt, parseFloat, isNaN, isFinite, encodeURIComponent, decodeURIComponent,
      setTimeout: (fn:unknown, ms:unknown) => { this.noteUnsupported("setTimeout", "注册期不执行定时器") },
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
  async dispatch(cmdName:string, options:SealDispatch = {}) {
    const state:DispatchState={closed:false,tempVars:new Map(),replies:[],delegateText:''}
    return this.dispatchScope.run(state, async()=>{
      try{return await this.executeDispatch(cmdName,options)}finally{state.closed=true}
    })
  }
  private async executeDispatch(cmdName:string, { event, userId, userName, groupId, isPrivate, args = [], kwargs = [], at = [], rawArgs = "", command = "" }:SealDispatch = {}) {
    const cmd = this.findCommand(cmdName)
    if (!cmd) return { matched: false, solved: false, showHelp: false, replies: [] }
    // <命令> help 预拦截:有意平台扩展(海豹不预拦截,但社区包普遍不自行处理
    // help,预拦截是保障帮助可达性的实用方案)。solve 返回 showHelp=true 也走此路。
    const firstArg = String(args[0] || "").toLowerCase()
    if (firstArg === "help" || firstArg === "帮助" || firstArg === "-h" || firstArg === "--help") {
      return { matched: true, solved: true, showHelp: true, replies: [] }
    }
    const ctx = this.makeContext({ event, userId, name: userName, groupId, isPrivate })
    const msg = { __event: event }
    const cmdArgs = this.buildCmdArgs({ command: command || cmdName, args, kwargs, at, rawArgs, userId })
    this.tempVars.clear()
    // 海豹代骰:命令 allowDelegate 且有非 bot 的 @目标时,首条回复自动加"由X代骰"前缀
    let delegateText = ""
    if (cmd.allowDelegate) {
      const botId = String(event?.bot?.uin || "" || "")
      const proxyAt = (Array.isArray(at) ? at : []).find(item => {
        const atId = String(item?.userId || "")
        return atId && atId !== String(userId) && (!botId || atId !== botId)
      })
      if (proxyAt) {
        const proxyName = this.resolvePlayerName?.(proxyAt.userId) || proxyAt.name || proxyAt.userId
        delegateText = `由${ctx.player?.name || "未知"}代骰：\n`
      }
    }
    this.pendingDelegateText = delegateText
    let result:{matched:boolean;solved:boolean;showHelp:boolean;error?:string} = { matched: true, solved: false, showHelp: false }
    try {
      const solveContext=vm.createContext({solve:cmd.solve,ctx,msg,cmdArgs});
      let returned:unknown = vm.runInContext('solve(ctx,msg,cmdArgs)',solveContext,{timeout:SOLVE_TIMEOUT_MS})
      // 异步 solve:等待 Promise 完成(海豹语义)
      if (returned && typeof record(returned).then === "function") {
        let timer:ReturnType<typeof setTimeout>|undefined;
        try{returned=await Promise.race([returned,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('solve 超时')),SOLVE_TIMEOUT_MS)})])}finally{if(timer)clearTimeout(timer)}
      }
      // 海豹语义:返回空/undefined → 未处理(solved=false,继续尝试其他扩展);
      // 返回对象 → 按 Solved 字段消费
      if (returned && typeof returned === "object") {
        result = {
          matched: true,
          solved: record(returned).solved !== false && record(returned).Solved !== false,
          showHelp: Boolean(record(returned).showHelp)
        }
      }
      // 返回 false → 显式"未处理"
      if (returned === false) result = { matched: false, solved: false, showHelp: false }

    } catch (error) {
      this.logger?.warn?.(`[海豹扩展] ${this.packId}/${cmdName} 执行出错: ${error instanceof Error?error.message:String(error)}`)
      result = { matched: true, solved: false, showHelp: false, error: String(error instanceof Error?error.message:String(error)) }
    }
    const replies = this.pendingReplies.splice(0)
    return { ...result, replies }
  }

  /** 构建海豹语义的 cmdArgs:带方法套件 + kwargs 解析 */
  buildCmdArgs({ command = "", args = [], kwargs = [], at = [], rawArgs = "", userId = "" }:SealDispatch = {}) {
    // 解析 --key=value 到 kwargs;过滤出干净 args
    const parsedKwargs:{name:string;valueExists:boolean;value:string;asBool:boolean}[] = []
    const cleanArgs:string[] = []
    for (const arg of (Array.isArray(args) ? args : [])) {
      const text = String(arg || "")
      const kw = text.match(/^--([^=]+)(?:=(.+))?$/)
      if (kw) {
        parsedKwargs.push({
          name: kw[1] || "",
          valueExists: kw[2] !== undefined,
          value: kw[2] !== undefined ? kw[2] : "",
          asBool: kw[2] === undefined ? true : (kw[2] === "true" || kw[2] === "1")
        })
      } else {
        cleanArgs.push(text)
      }
    }
    const cmdArgs = {
      command: String(command),
      args: cleanArgs,
      kwargs: parsedKwargs,
      at: Array.isArray(at) ? at : [],
      rawArgs: String(rawArgs),
      // 海豹方法套件
      getArgN: (n = 1) => cleanArgs[n - 1] ?? "",
      getRestArgsFrom: (n = 1) => cleanArgs.slice(n - 1).join(" "),
      getKwarg: (name = "") => parsedKwargs.find(kw => kw.name === name) || null,
      isArgEqual: (n = 1, value = "") => String(cleanArgs[n - 1] || "").toLowerCase() === String(value).toLowerCase(),
      eatPrefixWith: (prefix = "") => {
        const first = String(cleanArgs[0] || "")
        return first.toLowerCase().startsWith(String(prefix).toLowerCase()) ? first.slice(prefix.length) : null
      },
      chopPrefixToArgsWith: (prefix = "") => {
        const first = String(cleanArgs[0] || "")
        if (first.toLowerCase().startsWith(String(prefix).toLowerCase())) {
          const rest = first.slice(prefix.length)
          return [rest, ...cleanArgs.slice(1)]
        }
        return cleanArgs
      },
      amIBeMentioned: () => (Array.isArray(at) ? at : []).some(item => String(item?.userId || "") === String(userId || "")),
      amIBeMentionedFirst: () => String((Array.isArray(at) ? at : [])[0]?.userId || "") === String(userId || ""),
      cleanArgs: cleanArgs.join(" "),
      specialExecuteTimes: 1,
      rawText: String(rawArgs)
    }
    return cmdArgs
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
