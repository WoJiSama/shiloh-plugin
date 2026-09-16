import fs from "fs"
import path from "path"
import YAML from "yaml"
import { fileURLToPath } from "node:url"
import { secureDiceInt } from "../../utils/diceRandom.js"

// 牌堆系统：sealdice ext_deck.go 的 JS 移植（差异对照报告 差异7）。
// 支持社区 seal 格式（JSON/YAML：顶层键=牌组名，_ 前缀为元数据或隐藏牌组）。
// 抽取语义：{牌组}/{牌组} 嵌套不放回（单次命令内）、{%牌组} 放回、::N:: 权重、
// {player}/{self} 特殊变量、[牌组] 方括号嵌套、深度上限防死循环。

const DEPTH_LIMIT = 2000
const WEIGHT_PREFIX = /^::(\d+)::/

export class DeckManager {
  constructor({ decksDir = "", logger = globalThis.logger } = {}) {
    this.logger = logger
    this.decksDir = decksDir || this.resolveDefaultDecksDir()
    this.decks = []
    this.loadedAt = 0
    this.lastError = ""
  }

  resolveDefaultDecksDir() {
    const here = fileURLToPath(import.meta.url)
    return path.join(path.dirname(path.dirname(path.dirname(here))), "config", "decks")
  }

  /** 加载 decksDir 下全部 .json/.yaml/.yml 牌堆文件（幂等，返回牌堆数） */
  reload() {
    this.decks = []
    this.lastError = ""
    this.loadedAt = Date.now()
    if (!fs.existsSync(this.decksDir)) {
      fs.mkdirSync(this.decksDir, { recursive: true })
      return 0
    }
    for (const fileName of fs.readdirSync(this.decksDir).sort()) {
      if (!/\.(json|ya?ml)$/i.test(fileName)) continue
      const filePath = path.join(this.decksDir, fileName)
      try {
        const raw = fs.readFileSync(filePath, "utf-8").replace(/^\uFEFF/, "")
        const data = /\.json$/i.test(fileName) ? JSON.parse(raw) : YAML.parse(raw)
        const deck = this.normalizeDeck(data, fileName)
        if (deck) this.decks.push(deck)
      } catch (error) {
        this.lastError += `${fileName}: ${error?.message || error}; `
        this.logger?.warn?.(`[牌堆] 文件「${fileName}」解析失败: ${error?.message || error}`)
      }
    }
    return this.decks.length
  }

  /** seal 格式归一化：_ 前缀键为元数据/隐藏牌组 */
  normalizeDeck(data = {}, fileName = "") {
    const items = {}
    const command = {}
    let meta = { name: fileName.replace(/\.(json|ya?ml)$/i, ""), author: "", version: "", date: "" }
    for (const [key, value] of Object.entries(data || {})) {
      if (!Array.isArray(value)) continue
      if (key === "_name" || key === "_title") meta.name = String(value[0] ?? meta.name)
      else if (key === "_author") meta.author = String(value[0] ?? "")
      else if (key === "_version") meta.version = String(value[0] ?? "")
      else if (key === "_date") meta.date = String(value[0] ?? "")
      else {
        items[key] = value.map(String)
        command[key] = !key.startsWith("_")
      }
    }
    const visible = Object.keys(command).filter(k => command[k])
    if (!visible.length && !Object.keys(items).length) return null
    return { ...meta, fileName, items, command }
  }

  ensureLoaded() {
    if (!this.decks.length && !this.loadedAt) this.reload()
  }

  findDeck(deckName = "") {
    this.ensureLoaded()
    const target = String(deckName).trim()
    if (!target) return null
    return this.decks.find(deck => deck.items[target] && deck.command[target] !== false) || null
  }

  listDecks() {
    this.ensureLoaded()
    if (!this.decks.length) return `没有载入任何牌堆。把牌堆 json/yaml 放到 ${this.decksDir} 后发 .draw reload`
    return this.decks.map(deck => {
      const visible = Object.keys(deck.command).filter(k => deck.command[k])
      const meta = [deck.author ? `作者:${deck.author}` : "", deck.version ? `版本:${deck.version}` : ""].filter(Boolean).join(" ")
      return `- ${deck.name} ${meta} 牌组数量: ${visible.length}`.trim()
    }).join("\n")
  }

  listKeys(filter = "") {
    this.ensureLoaded()
    const keys = []
    for (const deck of this.decks) {
      for (const key of Object.keys(deck.command)) {
        if (deck.command[key] && key.includes(filter)) keys.push(key)
      }
    }
    if (!keys.length) return filter ? `没有包含「${filter}」的牌组` : "没有可用牌组"
    return `牌组关键字列表：\n${[...new Set(keys)].join("、")}`
  }

  searchDecks(keyword = "") {
    this.ensureLoaded()
    const hits = []
    for (const deck of this.decks) {
      for (const key of Object.keys(deck.command)) {
        if (deck.command[key] && key.toLowerCase().includes(String(keyword).toLowerCase())) {
          hits.push(`${deck.name}/${key}`)
        }
      }
    }
    return hits.length ? `找到 ${hits.length} 个：\n${hits.slice(0, 30).join("\n")}` : `未找到包含「${keyword}」的牌组`
  }

  descDeck(keyword = "") {
    this.ensureLoaded()
    const deck = this.decks.find(d => d.name.toLowerCase().includes(String(keyword).toLowerCase())) || this.findDeck(keyword)
    if (!deck) return "此关键字未找到牌堆"
    const visible = Object.keys(deck.command).filter(k => deck.command[k])
    return [
      `牌堆: ${deck.name}`,
      deck.author ? `作者: ${deck.author}` : "",
      deck.version ? `版本: ${deck.version}` : "",
      deck.date ? `时间: ${deck.date}` : "",
      `牌组数量: ${visible.length}`,
      `牌组: ${visible.join("/")}`
    ].filter(Boolean).join("\n")
  }

  /** 抽一张。ctx 为本次命令的执行上下文（不放回池挂在 ctx 上，命令结束即失效）。 */
  draw(deckName = "", ctx = {}) {
    this.ensureLoaded()
    const deck = this.findDeck(deckName)
    if (!deck) return { error: `牌组「${deckName}」不存在，可用 .draw keys 查看` }
    try {
      const text = this.executeDeck(deck, String(deckName).trim(), true, ctx, 0)
      return { text }
    } catch (error) {
      return { error: error?.message || String(error) }
    }
  }

  pickFromList(list = []) {
    const weighted = list.map(item => {
      const match = String(item).match(WEIGHT_PREFIX)
      return { weight: match ? Math.max(1, Number(match[1])) : 1, text: match ? String(item).slice(match[0].length) : String(item) }
    })
    const total = weighted.reduce((n, item) => n + item.weight, 0)
    let cursor = secureDiceInt(Math.max(1, total))
    for (const item of weighted) {
      cursor -= item.weight
      if (cursor <= 0) return item.text
    }
    return weighted[weighted.length - 1]?.text ?? ""
  }

  executeDeck(deck, deckName, useShufflePool, ctx, depth) {
    if (depth > DEPTH_LIMIT) throw new Error("抽取嵌套超出上限，疑似死循环")
    const group = deck.items[deckName] || []
    if (!group.length) throw new Error(`牌组「${deckName}」为空，请检查格式`)
    ctx.pools ||= {}
    let text
    if (useShufflePool) {
      const poolKey = `${deck.name}/${deckName}`
      if (!ctx.pools[poolKey] || !ctx.pools[poolKey].length) {
        // 按权重展开后洗牌（sealdice ShuffleRandomPool 语义）
        const expanded = []
        for (const item of group) {
          const match = String(item).match(WEIGHT_PREFIX)
          const weight = match ? Math.max(1, Number(match[1])) : 1
          const clean = match ? String(item).slice(match[0].length) : String(item)
          for (let i = 0; i < weight; i += 1) expanded.push(clean)
        }
        ctx.pools[poolKey] = expanded
      }
      const pool = ctx.pools[poolKey]
      const index = secureDiceInt(pool.length) - 1
      text = pool.splice(index, 1)[0]
    } else {
      text = this.pickFromList(group)
    }
    return this.formatDeckString(deck, String(text), ctx, depth + 1)
  }

  /** sealdice deckStringFormat 移植：{牌组}/{$牌组}=不放回 {%牌组}=放回 [牌组] 方括号嵌套 */
  formatDeckString(deck, input = "", ctx = {}, depth = 0) {
    let s = String(input)
    const braces = [...s.matchAll(/\{[$%]?[^{}]+\}/g)]
    for (let i = braces.length - 1; i >= 0; i -= 1) {
      const match = braces[i]
      const token = match[0]
      let replacement = ""
      if (token === "{player}") {
        replacement = ctx.playerName || "未知用户"
      } else if (token === "{self}") {
        replacement = ctx.selfName || "骰娘"
      } else {
        const sign = token[1]
        const name = token.slice(sign === "$" || sign === "%" ? 2 : 1, -1)
        if (!deck.items[name]) {
          replacement = `<%未知牌组-${name}%>`
        } else {
          try {
            replacement = this.executeDeck(deck, name, sign !== "%", ctx, depth)
          } catch (error) {
            replacement = `<%抽取错误-${name}%>`
          }
        }
      }
      s = s.slice(0, match.index) + replacement + s.slice(match.index + token.length)
    }
    // 方括号嵌套抽取（sealdice 在第二遍处理 [xxx]）
    const brackets = [...s.matchAll(/\[[^\[\]{$}]+\]/g)]
    for (let i = brackets.length - 1; i >= 0; i -= 1) {
      const match = brackets[i]
      const name = match[0].slice(1, -1)
      let replacement = `<%未知牌组-${name}%>`
      if (deck.items[name]) {
        try {
          replacement = this.executeDeck(deck, name, true, ctx, depth)
        } catch {
          replacement = `<%抽取错误-${name}%>`
        }
      }
      s = s.slice(0, match.index) + replacement + s.slice(match.index + match[0].length)
    }
    return s
  }
}

export const deckManager = new DeckManager()
