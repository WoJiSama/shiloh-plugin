import {decodeUmaPoints,emptyUmaRaceState} from './umaState.js'
import {DEFAULT_CONFIG,RACE_SIZE,RACE_STAGES,RACE_ACTIONS,PROFICIENCY_MAX,PROFICIENCY_SINGLE_ACTION_CAP,PROFICIENCY_TOTAL_RACE_CAP,PROFICIENCY_REPEAT_GAINS,PROFICIENCY_CHECK_GAINS,PROFICIENCY_LEVELS,ACTION_CHECKS,CHECK_GRADE_EFFECTS,STRATEGY_DEFAULT_ACTIONS,NPC_NAMES,NPC_UMA_PREFIXES,NPC_UMA_SUFFIXES,ATTRIBUTE_DEFS,ATTRIBUTE_TOTAL,ATTRIBUTE_MAX,ATTRIBUTE_MIN,RACE_BALANCE_THRESHOLD,RACE_BALANCE_RETAIN_RATE,RACE_BALANCE_MIN_SELF_RATE,TRACK_NUMERIC_PROFILES,TWIST_NUMERIC_MODIFIERS,SCENE_NUMERIC_MODIFIERS,CONDITION_NUMERIC_MODIFIERS,ATTRIBUTE_ALIASES,AFFIX_QUALITIES,AFFIX_REROLL_COSTS,AFFIX_DIRECTION_LABELS,ACTION_AFFIX_DIRECTIONS,AFFIX_POOL,TRAINING_TYPES,PERSONALITY_ATTRIBUTE_RULES,PERSONALITY_TRAITS,STRATEGIES,TRACKS,RACE_TWISTS,RACE_SCENES,RACE_CONDITIONS,CONDITION_EVENTS} from './umaConstants.js'
import fs from "fs"
import path from "path"
import YAML from "yaml"
import type {UmaEvent,UmaReport,UmaLogger,UmaConfig,UmaManagerPorts,UmaAffix,UmaTrait,UmaPet,UmaPlayerRecord,UmaPoints,UmaRunner,UmaRaceState,UmaRoom,UmaStage,UmaScene,UmaProfile,UmaCheck,UmaProficiencyEntry,UmaTrainingType,UmaRaceResult} from "../../../../contracts/uma.js"
const record=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'?value as Record<string,unknown>:{}
export function createUmaRaceManager(ports:UmaManagerPorts){
const sendSmartReply=ports.sendSmartReply

function nowIso() {
  return new Date().toISOString()
}

function ensureDir(dir:string) {
  fs.mkdirSync(dir, { recursive: true })
}

function safeNumber(value:unknown, fallback:number, min:number, max:number) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, num))
}

function escapeName(name:unknown) {
  return String(name || "群友").replace(/\s+/g, " ").trim().slice(0, 24) || "群友"
}

function pick<T>(array:readonly T[]):T {
  if(!array.length)throw new Error("空候选池");return array[Math.floor(Math.random() * array.length)]!
}

function randomBetween(min:number, max:number) {
  return min + Math.random() * (max - min)
}

function randomInt(min:number, max:number) {
  return Math.floor(randomBetween(min, max + 1))
}

function clampNumber(value:unknown, min:number, max:number) {
  return Math.min(max, Math.max(min, Number(value) || 0))
}

function formatDuration(seconds:number) {
  return `${Math.max(1, Math.round(seconds))} 秒`
}

function hashString(text = "") {
  let hash = 2166136261
  for (const char of String(text)) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function seededRandom(seed:number) {
  let state = seed >>> 0
  return () => {
    state = Math.imul(state + 0x6D2B79F5, 0x85EBCA6B) >>> 0
    state ^= state >>> 13
    state = Math.imul(state, 0xC2B2AE35) >>> 0
    return ((state ^ (state >>> 16)) >>> 0) / 4294967296
  }
}

class UmaRaceManager {
 cwd:string;logger:UmaLogger|undefined;rooms:Map<string,UmaRoom>;lastRaceAt:Map<string,number>;writeChain:Promise<unknown>;
  constructor({ cwd = process.cwd(), logger }:{cwd?:string;logger?:UmaLogger} = {}) {
    this.cwd = cwd
    this.logger = logger
    this.rooms = new Map()
    this.lastRaceAt = new Map()
    this.writeChain = Promise.resolve()
  }

  getConfig():UmaConfig {
    const userPath = path.join(this.cwd, "plugins/shiloh-plugin/config/message.yaml")
    const defaultPath = path.join(this.cwd, "plugins/shiloh-plugin/config_default/message.yaml")
    const configPath = fs.existsSync(userPath) ? userPath : defaultPath
    let raw:Record<string,unknown> = {}
    try {
      raw = record(record(record(YAML.parse(fs.readFileSync(configPath, "utf8"))).pluginSettings).umaRace)
    } catch (error) {
      this.logger?.warn?.(`[赛马娘小游戏] 读取配置失败: ${error instanceof Error?error.message:String(error)}`)
    }
    return {
      ...DEFAULT_CONFIG,
      enabled:raw.enabled!==false,baseDir:typeof raw.baseDir==='string'?raw.baseDir:DEFAULT_CONFIG.baseDir,
      minPlayers: RACE_SIZE,
      maxPlayers: RACE_SIZE,
      lobbySeconds: safeNumber(raw.lobbySeconds, DEFAULT_CONFIG.lobbySeconds, 10, 300),
      raceStageSeconds: safeNumber(raw.raceStageSeconds, DEFAULT_CONFIG.raceStageSeconds, 10, 180),
      cooldownSeconds: safeNumber(raw.cooldownSeconds, DEFAULT_CONFIG.cooldownSeconds, 0, 3600),
      winPoints: safeNumber(raw.winPoints, DEFAULT_CONFIG.winPoints, 0, 100000),
      secondPoints: safeNumber(raw.secondPoints, DEFAULT_CONFIG.secondPoints, 0, 100000),
      thirdPoints: safeNumber(raw.thirdPoints, DEFAULT_CONFIG.thirdPoints, 0, 100000),
      participationPoints: safeNumber(raw.participationPoints, DEFAULT_CONFIG.participationPoints, 0, 100000),
      rankLimit: safeNumber(raw.rankLimit, DEFAULT_CONFIG.rankLimit, 3, 50)
    }
  }

  getDataDir(config = this.getConfig()) {
    return path.isAbsolute(config.baseDir)
      ? config.baseDir
      : path.join(this.cwd, "plugins/shiloh-plugin", config.baseDir)
  }

  getPointsPath(config = this.getConfig()) {
    return path.join(this.getDataDir(config), "points.json")
  }

  readPoints(config = this.getConfig()):UmaPoints {
    const file = this.getPointsPath(config)
    if (!fs.existsSync(file)) return { players: {} }
    try {
      const data:unknown = JSON.parse(fs.readFileSync(file, "utf8"))
      return decodeUmaPoints(data)
    } catch (error) {
      this.logger?.warn?.(`[赛马娘小游戏] 读取积分失败: ${error instanceof Error?error.message:String(error)}`)
      throw new Error("赛马积分文件损坏，已停止写入以保护已有积分")
    }
  }

  async writePoints(data:UmaPoints, config = this.getConfig()) {
    const task = this.writeChain.catch(()=>{}).then(async () => {
      const file = this.getPointsPath(config)
      ensureDir(path.dirname(file))
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8")
      fs.renameSync(tmp, file)
    })
    this.writeChain=task.catch(()=>{})
    return task
  }

  getUserId(e:UmaEvent) {
    return String(e?.user_id || e?.sender?.user_id || "")
  }

  getPlayerRecord(userId:unknown, config = this.getConfig()) {
    if (!userId) return null
    const data = this.readPoints(config)
    return data.players?.[String(userId)] || null
  }

  getPlayerUma(userId:unknown, config = this.getConfig()) {
    const record = this.getPlayerRecord(userId, config)
    return record?.uma && this.isValidAttributes(record.uma.attributes) ? record.uma : null
  }

  async ensurePlayerUmaTrait(userId:unknown, config = this.getConfig()) {
    if (!userId) return null
    const data = this.readPoints(config)
    const record = data.players?.[String(userId)]
    const uma = record?.uma
    if (!uma || !this.isValidAttributes(uma.attributes)) return null
    const previousKey = uma.trait?.key
    const trait = this.normalizeUmaTrait(uma)
    if (uma.trait?.key !== previousKey) {
      record.updatedAt = nowIso()
      data.players[String(userId)] = record
      await this.writePoints(data, config)
    }
    return { uma, trait }
  }

  isValidAttributes(attributes:Record<string,number> = {}) {
    return ATTRIBUTE_DEFS.every(def => Number.isFinite(Number(attributes[def.key])))
  }

  parseAdoptionInput(msg = "") {
    const text = String(msg || "")
      .replace(/^[.。]赛马娘\s*(重新领养|领养|创建|注册)\s*/u, "")
      .trim()
    if (!text) return null
    const [name = "", ...rest] = text.split(/\s+/)
    const personality = rest.join(" ").trim()
    return {
      name: escapeName(name).slice(0, 12),
      personality: personality.slice(0, 120)
    }
  }

  buildAttributeScores(personality = "") {
    const scores = Object.fromEntries(ATTRIBUTE_DEFS.map(def => [def.key, 1]))
    for (const rule of PERSONALITY_ATTRIBUTE_RULES) {
      if (!rule.pattern.test(personality)) continue
      for (const [key, value] of Object.entries(rule.add || {})) {
        scores[key] = (scores[key] || 1) + value
      }
    }
    return scores
  }

  generateAttributes(name = "", personality = "", total = ATTRIBUTE_TOTAL) {
    const targetTotal = this.normalizeAttributeTargetTotal(total)
    const base = Object.fromEntries(ATTRIBUTE_DEFS.map(def => [def.key, 4]))
    const extraPoints = targetTotal - ATTRIBUTE_DEFS.length * 4
    let remaining = extraPoints
    const scores = this.buildAttributeScores(`${name} ${personality}`)
    const totalScore = ATTRIBUTE_DEFS.reduce((sum, def) => sum + (scores[def.key] || 1), 0)
    const fractional = []

    for (const def of ATTRIBUTE_DEFS) {
      const exact = extraPoints * (scores[def.key] || 1) / totalScore
      const add = Math.floor(exact)
      base[def.key] = (base[def.key]||0)+add
      fractional.push({ key: def.key, rest: exact - add })
      remaining -= add
    }

    const random = seededRandom(hashString(`${name}|${personality}`))
    fractional.sort((a, b) => b.rest - a.rest || random() - 0.5)
    for (let index = 0; index < remaining; index++) {
      base[fractional[index % fractional.length]!.key] = (base[fractional[index % fractional.length]!.key]||0)+1
    }

    this.normalizeAttributeTotal(base, targetTotal)
    return base
  }

  inferPersonalityTrait(name = "", personality = "") {
    const text = `${name} ${personality}`
    return PERSONALITY_TRAITS.find(trait => trait.pattern.test(text)) || {
      key: "balanced",
      label: "均衡适应",
      fit: { normal: 3, steady: 1, conserve: 1, burst: 1, inside: 1 },
      tagFit: { adverse: 2, technical: 1, sprint: -1, cheering: -1 },
      description: "没有明显偏科，什么场景都能按自己的节奏跑。"
    }
  }

  normalizeUmaTrait(uma:Partial<UmaPet> = {}) {
    const trait = this.inferPersonalityTrait(uma.name, uma.personality)
    if (!uma.trait || uma.trait.key !== trait.key) {
      uma.trait = {
        key: trait.key,
        label: trait.label,
        description: trait.description
      }
    }
    return trait
  }

  normalizeAttributeTargetTotal(total:number) {
    const minTotal = ATTRIBUTE_DEFS.length * 4
    const value = Math.round(Number(total) || ATTRIBUTE_TOTAL)
    return Math.max(minTotal, value)
  }

  normalizeAttributeTotal(attributes:Record<string,number>, targetTotal = ATTRIBUTE_TOTAL) {
    targetTotal = this.normalizeAttributeTargetTotal(targetTotal)
    let total = this.sumAttributes(attributes)
    const order = [...ATTRIBUTE_DEFS].sort((a, b) => Number(attributes[b.key]) - Number(attributes[a.key]))
    while (total > targetTotal) {
      const target = order.find(def => (attributes[def.key]||0) > 1)
      if (!target) break
      attributes[target.key] = (attributes[target.key]||0)-1
      total--
    }
    let addIndex = 0
    while (total < targetTotal) {
      attributes[ATTRIBUTE_DEFS[addIndex % ATTRIBUTE_DEFS.length]!.key] = (attributes[ATTRIBUTE_DEFS[addIndex % ATTRIBUTE_DEFS.length]!.key]||0)+1
      addIndex++
      total++
    }
  }

  sumAttributes(attributes:Record<string,number> = {}) {
    return ATTRIBUTE_DEFS.reduce((sum, def) => sum + (Number(attributes[def.key]) || 0), 0)
  }

  scaleAttributesToTotal(attributes:Record<string,number> = {}, targetTotal = ATTRIBUTE_TOTAL) {
    const sourceTotal = this.sumAttributes(attributes)
    const normalizedTarget = this.normalizeAttributeTargetTotal(targetTotal)
    if (!sourceTotal) return this.generateAttributes("", "均衡", normalizedTarget)

    const scaled:Record<string,number> = {}
    const fractional = []
    let assigned = 0
    for (const def of ATTRIBUTE_DEFS) {
      const raw = Math.max(ATTRIBUTE_MIN, Number(attributes[def.key]) || ATTRIBUTE_MIN)
      const exact = raw * normalizedTarget / sourceTotal
      const value = Math.max(ATTRIBUTE_MIN, Math.min(ATTRIBUTE_MAX, Math.floor(exact)))
      scaled[def.key] = value
      assigned += value
      fractional.push({ key: def.key, rest: exact - Math.floor(exact) })
    }

    fractional.sort((a, b) => b.rest - a.rest)
    let index = 0
    while (assigned < normalizedTarget) {
      const key = fractional[index % fractional.length]!.key
      if ((scaled[key]||0) < ATTRIBUTE_MAX) {
        scaled[key] = (scaled[key]||0)+1
        assigned += 1
      }
      index += 1
      if (index > ATTRIBUTE_MAX * ATTRIBUTE_DEFS.length * 2) break
    }

    index = fractional.length - 1
    while (assigned > normalizedTarget) {
      const key = fractional[index % fractional.length]!.key
      if ((scaled[key]||0) > ATTRIBUTE_MIN) {
        scaled[key] = (scaled[key]||0)-1
        assigned -= 1
      }
      index = (index - 1 + fractional.length) % fractional.length
    }
    return scaled
  }

  getRaceBalancedTotal(total:number, minTotal:number) {
    const original = Number(total) || ATTRIBUTE_TOTAL
    const min = Number(minTotal) || original
    if (original <= min + RACE_BALANCE_THRESHOLD) return Math.round(original)
    const retainedAdvantage = min + (original - min) * RACE_BALANCE_RETAIN_RATE
    const selfFloor = original * RACE_BALANCE_MIN_SELF_RATE
    return Math.round(Math.max(retainedAdvantage, selfFloor))
  }

  prepareRacePlayers(players:UmaRunner[] = []) {
    const humans = players.filter(player => !player.isNpc && this.isValidAttributes(player.attributes))
    if (humans.length < 2) {
      return players.map(player => ({ ...player, attributes: { ...(player.attributes || {}) } }))
    }

    const totals = humans
      .map(player => this.sumAttributes(player.attributes))
      .filter(total => Number.isFinite(total) && total > 0)
    if (!totals.length) return players.map(player => ({ ...player, attributes: { ...(player.attributes || {}) } }))

    const minTotal = Math.min(...totals)
    const maxTotal = Math.max(...totals)
    const enabled = maxTotal - minTotal > RACE_BALANCE_THRESHOLD

    return players.map(player => {
      const attributes = this.isValidAttributes(player.attributes)
        ? { ...player.attributes }
        : this.generateAttributes(player.umaName || player.nickname, "均衡")
      const originalTotal = this.sumAttributes(attributes)
      if (!enabled || player.isNpc) {
        return {
          ...player,
          attributes,
          originalAttributes: { ...attributes },
          raceBalance: { enabled: false, originalTotal, effectiveTotal: originalTotal, minTotal }
        }
      }

      const effectiveTotal = this.getRaceBalancedTotal(originalTotal, minTotal)
      const balancedAttributes = effectiveTotal < originalTotal
        ? this.scaleAttributesToTotal(attributes, effectiveTotal)
        : attributes
      return {
        ...player,
        attributes: balancedAttributes,
        originalAttributes: { ...attributes },
        raceBalance: {
          enabled: effectiveTotal < originalTotal,
          originalTotal,
          effectiveTotal: this.sumAttributes(balancedAttributes),
          minTotal
        }
      }
    })
  }

  normalizeUmaAffix(value:unknown = {}):UmaAffix|null {
    const source=record(value)
    const rawValue = source?.affix || source?.titleAffix || source?.modifier || source?.title ||
      (source?.label || source?.quality || source?.rarity || source?.tier ? source : null)
    if (!rawValue) return null
    if (typeof rawValue === "string") {
      const label = rawValue.trim()
      return label ? { label, quality: "common" } : null
    }
    const raw=record(rawValue)
    const label = String(raw.label || raw.name || raw.title || "").trim()
    if (!label) return null
    const qualityRaw = String(raw.quality || raw.rarity || raw.tier || "common").trim().toLowerCase()
    const qualityMap:Record<string,string> = {
      broken: "broken",
      破损: "broken",
      flawed: "broken",
      bad: "broken",
      cursed: "cursed",
      curse: "cursed",
      诅咒: "cursed",
      normal: "common",
      common: "common",
      普通: "common",
      good: "good",
      excellent: "good",
      优秀: "good",
      rare: "rare",
      稀有: "rare",
      epic: "epic",
      史诗: "epic",
      shine: "shiny",
      shiny: "shiny",
      闪耀: "shiny",
      legendary: "shiny",
      传说: "shiny"
    }
    return {
      id: String(raw.id || ""),
      label,
      quality: qualityMap[qualityRaw] || "common",
      qualityLabel: String(raw.qualityLabel || AFFIX_QUALITIES[qualityMap[qualityRaw] || "common"]?.label || ""),
      tags: Array.isArray(raw.tags) ? raw.tags.filter((v):v is string=>typeof v==='string') : [],
      mechanic: String(raw.mechanic || ""),
      effect: Number.isFinite(Number(raw.effect)) ? Number(raw.effect) : AFFIX_QUALITIES[qualityMap[qualityRaw] || "common"]?.effect || 0,
      rolledAt: String(raw.rolledAt || "")
    }
  }

  getMaxedAttributeKeys(uma:Partial<UmaPet> = {}) {
    const attributes = uma.attributes || {}
    return ATTRIBUTE_DEFS
      .filter(def => Number(attributes[def.key]) >= ATTRIBUTE_MAX)
      .map(def => def.key)
  }

  formatAffix(affix:UmaAffix|null = null) {
    const normalized = this.normalizeUmaAffix(affix)
    if (!normalized) return "暂无"
    const quality = AFFIX_QUALITIES[normalized.quality] || AFFIX_QUALITIES.common!
    return `${quality.label}·${normalized.label}`
  }

  getAffixRerollCost(config = this.getConfig(), affix:UmaAffix|null = null) {
    const normalized = this.normalizeUmaAffix(affix)
    const qualityKey = normalized?.quality || "common"
    return Math.max(0, Number(AFFIX_REROLL_COSTS[qualityKey] ?? AFFIX_REROLL_COSTS.common) || 0)
  }

  formatAffixRerollCostTable(config = this.getConfig()) {
    return Object.keys(AFFIX_REROLL_COSTS)
      .map(key => `${AFFIX_QUALITIES[key]?.label || key}${this.getAffixRerollCost(config, { label: "示例", quality: key })}`)
      .join(" / ")
  }

  pickWeighted<T>(items:{value:T;weight:number}[] = []):T|null {
    const total = items.reduce((sum, item) => sum + Math.max(0, Number(item.weight) || 0), 0)
    if (total <= 0) return items[0]?.value || null
    let roll = Math.random() * total
    for (const item of items) {
      roll -= Math.max(0, Number(item.weight) || 0)
      if (roll <= 0) return item.value
    }
    return items[items.length - 1]?.value || null
  }

  rollAffixForUma(uma:Partial<UmaPet> = {}) {
    const maxed = new Set(this.getMaxedAttributeKeys(uma))
    const weighted = AFFIX_POOL.map(entry => {
      const quality = AFFIX_QUALITIES[entry.quality] || AFFIX_QUALITIES.common!
      const tags = Array.isArray(entry.tags) ? entry.tags : []
      const matched = tags.filter(tag => maxed.has(tag)).length
      const directionWeight = matched > 0 ? 7 + matched * 2 : tags.includes("universal") ? 3 : 1
      return { value: entry, weight: quality.weight * directionWeight }
    })
    const picked = this.pickWeighted(weighted) || AFFIX_POOL[0]!
    const quality = AFFIX_QUALITIES[picked.quality] || AFFIX_QUALITIES.common!
    return {
      id: picked.id,
      label: picked.label,
      quality: picked.quality,
      qualityLabel: quality.label,
      tags: [...(picked.tags || [])],
      mechanic: picked.mechanic || "",
      effect: quality.effect,
      rolledAt: nowIso()
    }
  }

  getAffixActionBonus(runner:Partial<UmaRunner> = {}, actionKey = "") {
    const affix = this.normalizeUmaAffix(runner.umaAffix || runner.affix || runner)
    if (!affix) return 0
    const quality = AFFIX_QUALITIES[affix.quality] || AFFIX_QUALITIES.common!
    const tags = Array.isArray(affix.tags) ? affix.tags : []
    const directions = ACTION_AFFIX_DIRECTIONS[actionKey] || []
    if (tags.includes("universal")) return Math.trunc(quality.effect / 2)
    return tags.some(tag => directions.includes(tag)) ? quality.effect : 0
  }

  formatAffixDirections(tags:string[] = []) {
    const labels = (Array.isArray(tags) ? tags : [])
      .map(tag => AFFIX_DIRECTION_LABELS[tag] || tag)
      .filter(Boolean)
    return labels.length ? labels.join("/") : "通用"
  }

  formatAffixEffect(affix:UmaAffix|null = null) {
    const normalized = this.normalizeUmaAffix(affix)
    if (!normalized) return "无效果"
    const quality = AFFIX_QUALITIES[normalized.quality] || AFFIX_QUALITIES.common!
    const effect = Number.isFinite(Number(normalized.effect)) ? Number(normalized.effect) : Number(quality.effect) || 0
    const directions = this.formatAffixDirections(normalized.tags)
    const mechanicText = normalized.mechanic ? `机制：${this.describeAffixMechanic(normalized.mechanic)}` : "机制：无"
    const numericText = normalized.tags?.includes?.("universal")
      ? `相关行动判定 +${Math.trunc(effect / 2)}`
      : `相关行动判定 ${effect >= 0 ? "+" : ""}${effect}`
    return `${directions}；${numericText}；${mechanicText}`
  }

  describeAffixMechanic(mechanic = "") {
    return {
      advantage_roll: "相关行动每场一次额外掷一个 D100，取较好结果。",
      reroll_fumble: "每场第一次大失败会重掷一次。",
      extra_push: "相关行动成功时每场一次额外推进一小段。",
      stamina_guard: "相关行动每场一次降低体力消耗。",
      finish_burst: "冲刺阶段相关行动成功时额外推进，但会多耗一点余力。",
      route_surge: "相关行动每场一次提高路线状态并小幅推进。",
      soften_failure: "相关行动每场一次把失败惩罚放轻。",
      downgrade_first_critical: "负面机制：每场第一次大成功会被压成困难成功。",
      bad_luck_echo: "负面机制：每场第一次失败会额外损失一点节奏。"
    }[mechanic] || "无"
  }

  affixMatchesAction(affix:UmaAffix|null = null, actionKey = "") {
    if (!affix) return false
    const tags = Array.isArray(affix.tags) ? affix.tags : []
    if (tags.includes("universal")) return true
    const directions = ACTION_AFFIX_DIRECTIONS[actionKey] || []
    return tags.some(tag => directions.includes(tag))
  }

  isAffixMechanicUsed(runner:Partial<UmaRunner> = {}, key = "") {
    return !!runner.race?.affixMechanicUsed?.[key]
  }

  markAffixMechanicUsed(runner:Partial<UmaRunner> = {}, key = "") {
    if (!runner.race) runner.race = emptyUmaRaceState()
    if (!runner.race.affixMechanicUsed || typeof runner.race.affixMechanicUsed !== "object") {
      runner.race.affixMechanicUsed = {}
    }
    runner.race.affixMechanicUsed[key] = true
  }

  gradeRaceRoll(roll:number, target:number, criticalLimit:number) {
    if (roll >= 96) return "fumble"
    if (roll <= criticalLimit) return "critical"
    if (roll <= Math.floor(target / 2)) return "hard"
    if (roll <= target) return "success"
    return "fail"
  }

  isBetterGrade(a:string, b:string) {
    const order:Record<string,number> = { critical: 5, hard: 4, success: 3, fail: 2, fumble: 1 }
    return (order[a] || 0) > (order[b] || 0)
  }

  showAffix(e:UmaEvent) {
    const userId = this.getUserId(e)
    if (!userId) return "没拿到你的 QQ 号。"
    const config = this.getConfig()
    const record = this.getPlayerRecord(userId, config)
    const uma = record?.uma
    if (!uma || !this.isValidAttributes(uma.attributes)) return "你还没有领养赛马娘。先用：.赛马娘 领养 名字 性格描述"
    const maxed = this.getMaxedAttributeKeys(uma)
    const affix = this.normalizeUmaAffix(uma)
    const rerollCost = this.getAffixRerollCost(config, affix)
    return [
      `${uma.name} 的词条：${this.formatAffix(affix)}`,
      affix ? `效果：${this.formatAffixEffect(affix)}` : "当前还没有词条。",
      `满属性方向：${maxed.map(key => ATTRIBUTE_DEFS.find(def => def.key === key)?.label || key).join(" / ") || "暂无"}`,
      `本次重铸消耗：${rerollCost} 积分`,
      `费用表：${this.formatAffixRerollCostTable(config)}`,
      maxed.length ? "满属性方向会提高对应词条出现概率。" : "暂无满属性方向，本次重铸按基础词条池随机。",
      "重铸：.赛马娘 重铸（立即覆盖旧词条，不能反悔）"
    ].join("\n")
  }

  async rerollAffix(e:UmaEvent) {
    const config = this.getConfig()
    if (!config.enabled) return "赛马娘小游戏现在没开。"
    const userId = this.getUserId(e)
    if (!userId) return "没拿到你的 QQ 号。"
    const data = this.readPoints(config)
    const record = data.players?.[userId]
    const uma = record?.uma
    if (!uma || !this.isValidAttributes(uma.attributes)) return "你还没有领养赛马娘。先用：.赛马娘 领养 名字 性格描述"
    const oldAffix = this.normalizeUmaAffix(uma)
    const cost = this.getAffixRerollCost(config, oldAffix)
    const points = Number(record.points) || 0
    if (points < cost) return `重铸需要 ${cost} 积分，你现在只有 ${points}。`

    const newAffix = this.rollAffixForUma(uma)
    record.points = points - cost
    uma.affix = newAffix
    record.uma = uma
    record.updatedAt = nowIso()
    data.players[userId] = record
    await this.writePoints(data, config)
    return [
      `${uma.name} 完成重铸。`,
      `消耗：${cost} 积分`,
      `旧词条：${this.formatAffix(oldAffix)}（${this.formatAffixEffect(oldAffix)}）`,
      `新词条：${this.formatAffix(newAffix)}（${this.formatAffixEffect(newAffix)}）`,
      `积分：${points} -> ${record.points}`,
      "这次结果已经生效，不能反悔。"
    ].join("\n")
  }

  showAffixPool() {
    const byQuality = Object.keys(AFFIX_QUALITIES).map(qualityKey => {
      const quality = AFFIX_QUALITIES[qualityKey]!
      const names = AFFIX_POOL
        .filter(item => item.quality === qualityKey)
        .map(item => item.label)
        .join("、")
      return `${quality.label}：${names}`
    })
    return [
      "赛马娘词条池：",
      "品级从低到高：诅咒 / 破损 / 普通 / 优秀 / 稀有 / 史诗 / 闪耀。",
      "诅咒和闪耀都是 1%；重铸会立即覆盖旧词条。",
      ...byQuality
    ].join("\n")
  }

  formatRaceRunnerName(runner:Partial<UmaRunner> = {}) {
    const name = runner.umaName || runner.nickname || "无名小马"
    const affix = this.normalizeUmaAffix(runner.umaAffix || runner.affix || runner)
    const affixText = affix?.label ? `[${affix.label}]` : ""
    return `${affixText}${name}${runner.isNpc ? "（NPC）" : ""}`
  }

  formatAttributes(attributes:Record<string,number> = {}) {
    return ATTRIBUTE_DEFS
      .map(def => `${def.label}${Number(attributes[def.key]) || 0}`)
      .join(" / ")
  }

  formatTrainingAttributes(attributes:Record<string,number> = {}) {
    return ATTRIBUTE_DEFS
      .map(def => `${def.label}${Number(attributes[def.key]) || 0}/${ATTRIBUTE_MAX}`)
      .join(" / ")
  }

  formatTopProficiency(proficiency:Record<string,number> = {}) {
    const normalized = this.normalizeProficiency(proficiency)
    const ranked = Object.entries(normalized)
      .filter(([, value]) => value > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([key, value]) => `${RACE_ACTIONS[key]?.label || key}${value}/${PROFICIENCY_MAX}(${this.getProficiencyLevel(value).label})`)
    return ranked.length ? ranked.join(" / ") : "暂无"
  }

  async adoptUma(e:UmaEvent, { overwrite = false } = {}) {
    const config = this.getConfig()
    if (!config.enabled) return "赛马娘小游戏现在没开。"
    const userId = this.getUserId(e)
    if (!userId) return "没拿到你的 QQ 号，领养失败。"
    const parsed = this.parseAdoptionInput(e?.msg)
    if (!parsed?.name) {
      return "格式：.赛马娘 领养 名字 性格描述\n例如：.赛马娘 领养 小春 温柔但不服输，关键时刻会拼一把"
    }
    if (!parsed.personality) {
      return "还需要写一点期待的性格描述，例如：温柔但不服输。"
    }

    const data = this.readPoints(config)
    const record:UmaPlayerRecord = data.players[userId] || {
      userId,
      nickname: this.getDisplayName(e),
      points: 0,
      wins: 0,
      races: 0,
      podiums: 0,
      updatedAt: nowIso()
    }
    if (record.uma && !overwrite) {
      return `你已经领养了「${record.uma.name}」。如果要重建，使用：.赛马娘 重新领养 名字 性格描述`
    }

    const uma:UmaPet = {
      name: parsed.name,
      personality: parsed.personality,
      attributes: this.generateAttributes(parsed.name, parsed.personality),
      proficiency: this.normalizeProficiency(),
      total: ATTRIBUTE_TOTAL,
      createdAt: nowIso()
    }
    this.normalizeUmaTrait(uma)
    record.nickname = this.getDisplayName(e)
    record.uma = uma
    record.updatedAt = nowIso()
    data.players[userId] = record
    await this.writePoints(data, config)

    return [
      `领养成功：${uma.name}`,
      `性格：${uma.personality}`,
      `特质：${uma.trait?.label||""} - ${uma.trait?.description||""}`,
      `六维：${this.formatAttributes(uma.attributes)}`,
      `初始总点数：${this.sumAttributes(uma.attributes)}`
    ].join("\n")
  }

  showUma(e:UmaEvent) {
    const userId = this.getUserId(e)
    if (!userId) return "没拿到你的 QQ 号。"
    const record = this.getPlayerRecord(userId)
    const uma = record?.uma
    if (!uma) return "你还没有领养赛马娘。格式：.赛马娘 领养 名字 性格描述"
    const trait = this.normalizeUmaTrait(uma)
    const affix = this.normalizeUmaAffix(uma)
    return [
      `你的赛马娘：${uma.name}`,
      `词条：${this.formatAffix(affix)}`,
      `词条效果：${this.formatAffixEffect(affix)}`,
      `性格：${uma.personality || "未记录"}`,
      `特质：${trait.label} - ${trait.description}`,
      `六维：${this.formatAttributes(uma.attributes)}`,
      `熟练度：${this.formatTopProficiency(uma.proficiency)}`,
      `当前总点数：${this.sumAttributes(uma.attributes)}`,
      `积分：${Number(record.points) || 0}，胜场：${Number(record.wins) || 0}，参赛：${Number(record.races) || 0}`
    ].join("\n")
  }

  parseTrainingInput(msg = "") {
    const text = String(msg || "")
      .replace(/^[.。]赛马娘\s*训练\s*/u, "")
      .trim()
    if (!text) return null
    const parts = text.split(/\s+/).filter(Boolean)
    return {
      type: this.resolveTrainingType(parts[0] || text),
      attribute: this.resolveAttribute(parts.slice(1).join(" ") || parts[1] || text),
      raw: text
    }
  }

  resolveTrainingType(text = "") {
    const normalized = String(text || "").trim()
    for (const [key, type] of Object.entries(TRAINING_TYPES)) {
      if (type.aliases.some(alias => normalized.includes(alias))) return { key, ...type }
    }
    return null
  }

  resolveAttribute(text = "") {
    const normalized = String(text || "").trim()
    for (const def of ATTRIBUTE_DEFS) {
      const aliases = ATTRIBUTE_ALIASES[def.key] || [def.label]
      if (aliases.some(alias => normalized.includes(alias))) return def
    }
    return null
  }

  getTrainingPity(record:UmaPlayerRecord|null, typeKey:string, attrKey:string) {
    return Number(record?.trainingPity?.[typeKey]?.[attrKey]) || 0
  }

  setTrainingPity(record:UmaPlayerRecord, typeKey:string, attrKey:string, value:number) {
    if (!record.trainingPity || typeof record.trainingPity !== "object") record.trainingPity = {}
    if (!record.trainingPity[typeKey] || typeof record.trainingPity[typeKey] !== "object") record.trainingPity[typeKey] = {}
    record.trainingPity[typeKey]![attrKey] = Math.max(0, Math.floor(Number(value) || 0))
  }

  getTrainingSuccessRate(type:UmaTrainingType, currentValue:unknown) {
    const value = Math.max(ATTRIBUTE_MIN, Number(currentValue) || ATTRIBUTE_MIN)
    return Math.max(type.minRate, type.baseRate - value * type.decay)
  }

  async trainUma(e:UmaEvent) {
    const config = this.getConfig()
    if (!config.enabled) return "赛马娘小游戏现在没开。"
    const userId = this.getUserId(e)
    if (!userId) return "没拿到你的 QQ 号，训练失败。"

    const parsed = this.parseTrainingInput(e?.msg)
    if (!parsed?.type || !parsed?.attribute) {
      return [
        "格式：.赛马娘 训练 基础 速度",
        "训练类型：基础 / 强化 / 赌狗",
        "属性：速度 / 耐力 / 爆发 / 稳定 / 判断 / 运气"
      ].join("\n")
    }

    const data = this.readPoints(config)
    const record = data.players?.[userId]
    const uma = record?.uma
    if (!uma || !this.isValidAttributes(uma.attributes)) {
      return "你还没有领养赛马娘。先用：.赛马娘 领养 名字 性格描述"
    }

    const currentPoints = Number(record.points) || 0
    if (currentPoints < parsed.type.cost) {
      return [
        `${uma.name} 当前属性：`,
        this.formatTrainingAttributes(uma.attributes),
        `总点数：${this.sumAttributes(uma.attributes)}`,
        `当前积分：${currentPoints}`,
        "",
        `${parsed.type.label}需要 ${parsed.type.cost} 积分，积分不够。`
      ].join("\n")
    }

    const beforeAttributes = { ...uma.attributes }
    const currentValue = Number(uma.attributes[parsed.attribute.key]) || ATTRIBUTE_MIN
    if (currentValue >= ATTRIBUTE_MAX) {
      return [
        `${uma.name} 当前属性：`,
        this.formatTrainingAttributes(uma.attributes),
        `总点数：${this.sumAttributes(uma.attributes)}`,
        `当前积分：${currentPoints}`,
        "",
        `${parsed.attribute.label}已经到上限 ${ATTRIBUTE_MAX}，这次不用训练。`
      ].join("\n")
    }
    if (parsed.type.maxTargetValue && currentValue > parsed.type.maxTargetValue) {
      return [
        `${uma.name} 当前属性：`,
        this.formatTrainingAttributes(uma.attributes),
        `总点数：${this.sumAttributes(uma.attributes)}`,
        `当前积分：${currentPoints}`,
        "",
        `${parsed.attribute.label}已经达到 ${currentValue}，基础训练不能继续提升这个属性。`,
        "可以改用：.赛马娘 训练 强化 [属性] 或 .赛马娘 训练 赌狗 [属性]"
      ].join("\n")
    }

    const successRate = this.getTrainingSuccessRate(parsed.type, currentValue)
    const pityBefore = this.getTrainingPity(record, parsed.type.key, parsed.attribute.key)
    const forcedByPity = pityBefore >= parsed.type.pity
    const success = forcedByPity || Math.random() < successRate
    const resultLines = []
    let actualGain = 0
    let penaltyLines = []

    record.points = currentPoints - parsed.type.cost
    if (success) {
      const gain = parsed.type.critGain && !forcedByPity && Math.random() < (parsed.type.critRate||0)
        ? parsed.type.critGain
        : parsed.type.gain
      const before = Number(uma.attributes[parsed.attribute.key]) || ATTRIBUTE_MIN
      const after = Math.min(ATTRIBUTE_MAX, before + gain)
      actualGain = after - before
      uma.attributes[parsed.attribute.key] = after
      this.setTrainingPity(record, parsed.type.key, parsed.attribute.key, 0)
      resultLines.push("结果：成功")
      resultLines.push(actualGain > 0
        ? `${parsed.attribute.label} +${actualGain}`
        : `${parsed.attribute.label} 已到上限 ${ATTRIBUTE_MAX}`)
    } else {
      this.setTrainingPity(record, parsed.type.key, parsed.attribute.key, pityBefore + 1)
      penaltyLines = this.applyTrainingPenalty(uma.attributes, parsed.attribute.key, parsed.type)
      resultLines.push("结果：失败")
      resultLines.push(penaltyLines.length ? penaltyLines.join("，") : "没有额外掉属性")
    }

    uma.total = this.sumAttributes(uma.attributes)
    record.nickname = this.getDisplayName(e)
    record.updatedAt = nowIso()
    data.players[userId] = record
    await this.writePoints(data, config)

    return [
      `${uma.name} 当前属性：`,
      this.formatTrainingAttributes(beforeAttributes),
      `训练前总点数：${this.sumAttributes(beforeAttributes)}`,
      `当前积分：${currentPoints}`,
      "",
      `训练：${parsed.type.label} - ${parsed.attribute.label}`,
      `消耗：${parsed.type.cost} 积分`,
      "",
      ...resultLines,
      "",
      "训练后：",
      this.formatTrainingAttributes(uma.attributes),
      `训练后总点数：${this.sumAttributes(uma.attributes)}`,
      `剩余积分：${record.points}`
    ].join("\n")
  }

  applyTrainingPenalty(attributes:Record<string,number>, targetKey:string, type:UmaTrainingType) {
    if (Math.random() >= type.failPenaltyChance) return []
    const keys = ATTRIBUTE_DEFS
      .map(def => def.key)
      .filter(key => key !== targetKey && (Number(attributes[key]) || ATTRIBUTE_MIN) > ATTRIBUTE_MIN)
    const lines = []
    const targetDef = ATTRIBUTE_DEFS.find(item => item.key === targetKey)
    if (type.failTargetPenaltyChance && Math.random() < type.failTargetPenaltyChance) {
      const before = Number(attributes[targetKey]) || ATTRIBUTE_MIN
      const after = Math.max(ATTRIBUTE_MIN, before - 1)
      attributes[targetKey] = after
      if (after < before) lines.push(`${targetDef?.label || targetKey} -1`)
    }
    for (let index = 0; index < type.failPenaltyCount && keys.length; index++) {
      const key = keys.splice(Math.floor(Math.random() * keys.length), 1)[0]!
      const def = ATTRIBUTE_DEFS.find(item => item.key === key)
      const before = Number(attributes[key]) || ATTRIBUTE_MIN
      const after = Math.max(ATTRIBUTE_MIN, before - 1)
      attributes[key] = after
      if (after < before) lines.push(`${def?.label || key} -1`)
    }
    return lines
  }

  showTrainingStatus(e:UmaEvent) {
    const userId = this.getUserId(e)
    if (!userId) return "没拿到你的 QQ 号。"
    const record = this.getPlayerRecord(userId)
    const uma = record?.uma
    if (!uma || !this.isValidAttributes(uma.attributes)) {
      return "你还没有领养赛马娘。先用：.赛马娘 领养 名字 性格描述"
    }
    return [
      "赛马娘训练：",
      `${uma.name} 当前属性：`,
      this.formatTrainingAttributes(uma.attributes),
      `总点数：${this.sumAttributes(uma.attributes)}`,
      `当前积分：${Number(record.points) || 0}`,
      "",
      "训练方式：",
      ".赛马娘 训练 基础 [属性] - 消耗 2 积分，单项 20 后不可用",
      ".赛马娘 训练 强化 [属性] - 消耗 5 积分，提升更多但有风险",
      ".赛马娘 训练 赌狗 [属性] - 消耗 8 积分，波动最大",
      "",
      "属性：速度 / 耐力 / 爆发 / 稳定 / 判断 / 运气",
      "满值：每项 50"
    ].join("\n")
  }

  async abandonUma(e:UmaEvent, { confirm = false } = {}) {
    const config = this.getConfig()
    if (!config.enabled) return "赛马娘小游戏现在没开。"
    const userId = this.getUserId(e)
    if (!userId) return "没拿到你的 QQ 号，弃养失败。"

    const data = this.readPoints(config)
    const record = data.players?.[userId]
    const uma = record?.uma
    if (!uma) return "你现在没有领养赛马娘。"
    if (!confirm) {
      return `确认要弃养「${uma.name}」吗？积分和历史战绩会保留，但这匹小马的六维档案会删除。\n确认请发：.赛马娘 弃养 确认`
    }

    delete record.uma
    record.nickname = this.getDisplayName(e)
    record.updatedAt = nowIso()
    data.players[userId] = record
    await this.writePoints(data, config)

    const removedFromRoom = this.removeUserFromActiveRoom(e, userId)
    return [
      `已弃养：${uma.name}`,
      "你的积分和历史战绩已保留。",
      removedFromRoom ? "你也已从当前赛马局报名列表中移除。" : ""
    ].filter(Boolean).join("\n")
  }

  removeUserFromActiveRoom(e:UmaEvent, userId:unknown) {
    if (!e?.group_id || !userId) return false
    const room = this.getRoom(String(e.group_id))
    if (!room?.participants?.has(String(userId))) return false
    room.participants.delete(String(userId))
    return true
  }

  getRoom(groupId:string) {
    return this.rooms.get(String(groupId || ""))
  }

  getDisplayName(e:UmaEvent) {
    return escapeName(e?.sender?.card || e?.sender?.nickname || e?.nickname || e?.user_id)
  }

  pickTrack() {
    return pick(TRACKS)
  }

  pickTwist() {
    return pick(RACE_TWISTS)
  }

  pickScene() {
    return pick(RACE_SCENES)
  }

  pickCondition() {
    return pick(RACE_CONDITIONS)
  }

  parseStrategy(input = "") {
    const text = String(input || "")
      .replace(/^[.。]赛马娘\s*(加入|参加|上马|报名)\s*/u, "")
      .trim()
    if (!text) return STRATEGIES.normal

    for (const strategy of Object.values(STRATEGIES)) {
      if (strategy.aliases.some(alias => text.includes(alias))) return strategy
    }
    return STRATEGIES.normal
  }

  formatStrategyTips() {
    return "策略：稳一点 / 拼一把 / 留体力 / 抢内道；不填就是正常跑"
  }

  formatTrack(track:UmaScene) {
    return `本局赛道：${track.name} - ${track.description}`
  }

  formatRaceSceneName(room:Partial<UmaRoom> = {}) {
    return [
      room.track?.name,
      room.condition?.name,
      room.twist?.name,
      room.scene?.name
    ].filter(Boolean).join(" + ")
  }

  formatOpeningAnnouncer(room:Partial<UmaRoom> = {}) {
    const track:Partial<UmaScene> = room.track || {}
    const condition:Partial<UmaScene> = room.condition || {}
    const twist:Partial<UmaScene> = room.twist || {}
    const scene:Partial<UmaScene> = room.scene || {}
    return [
      "各位训练员，看赛道！",
      "",
      `这局是「${track.name || "未知赛道"}」，${track.description || "胜负会在每一次选择里拉开。"}`,
      `今天场地「${condition.name || "维护良好"}」，${condition.broadcast || condition.description || "状态很稳，谁的节奏更完整，谁就更有机会。"}`,
      `临场变化是「${twist.name || "未知变化"}」，${twist.description || "比赛节奏可能随时改变。"}`,
      `赛况预警：「${scene.name || "未知事件"}」，${scene.description || "关键位置会很考验判断。"}`,
      "",
      "让我们拭目以待！"
    ].join("\n")
  }

  buildRaceProfile(track:Partial<UmaScene> = {}, twist:Partial<UmaScene> = {}, scene:Partial<UmaScene> = {}, condition:Partial<UmaScene> = {}):UmaProfile {
    const profileTable:Record<string,(typeof TRACK_NUMERIC_PROFILES)[keyof typeof TRACK_NUMERIC_PROFILES]> = TRACK_NUMERIC_PROFILES
    const conditionTable:Record<string,Record<string,number>> = CONDITION_NUMERIC_MODIFIERS
    const twistTable:Record<string,Record<string,number>> = TWIST_NUMERIC_MODIFIERS
    const sceneTable:Record<string,Record<string,number>> = SCENE_NUMERIC_MODIFIERS
    const base = profileTable[track.id||""] || TRACK_NUMERIC_PROFILES.short_sprint
    const conditionMod = conditionTable[condition.name||""] || {}
    const twistMod = twistTable[twist.name||""] || {}
    const sceneMod = sceneTable[scene.name||""] || {}
    const segments = [...base.segments]
    const slope = [...base.slope]
    const corner = base.corner.map(value =>
      clampNumber(value + Number(conditionMod.corner || 0) + Number(twistMod.corner || 0) + Number(sceneMod.corner || 0), 0, 0.8)
    )
    const profile = {
      distance: Number(base.distance) || segments.reduce((sum, value) => sum + value, 0),
      segments,
      friction: clampNumber(Number(base.friction) + Number(conditionMod.friction || 0) + Number(twistMod.friction || 0) + Number(sceneMod.friction || 0), 0.78, 1.5),
      slope,
      corner,
      staminaCostRate: clampNumber(Number(base.staminaCostRate) + Number(conditionMod.staminaCostRate || 0) + Number(twistMod.staminaCostRate || 0) + Number(sceneMod.staminaCostRate || 0), 0.72, 1.55),
      rhythmDifficulty: clampNumber(Number(base.rhythmDifficulty) + Number(conditionMod.rhythmDifficulty || 0) + Number(twistMod.rhythmDifficulty || 0) + Number(sceneMod.rhythmDifficulty || 0), 0.72, 1.6),
      routeDifficulty: clampNumber(Number(base.routeDifficulty) + Number(conditionMod.routeDifficulty || 0) + Number(twistMod.routeDifficulty || 0) + Number(sceneMod.routeDifficulty || 0), -8, 24),
      speedCarry: clampNumber(Number(base.speedCarry) + Number(conditionMod.speedCarry || 0) + Number(twistMod.speedCarry || 0) + Number(sceneMod.speedCarry || 0), 0.72, 1.32),
      startSpeedCarry: clampNumber(1 + Number(conditionMod.startSpeedCarry || 0) + Number(twistMod.startSpeedCarry || 0) + Number(sceneMod.startSpeedCarry || 0), 0.75, 1.2),
      finalSpeedCarry: clampNumber(1 + Number(conditionMod.finalSpeedCarry || 0) + Number(twistMod.finalSpeedCarry || 0) + Number(sceneMod.finalSpeedCarry || 0), 0.75, 1.25),
      finalRouteDifficulty: clampNumber(Number(conditionMod.finalRouteDifficulty || 0) + Number(twistMod.finalRouteDifficulty || 0) + Number(sceneMod.finalRouteDifficulty || 0), 0, 18),
      variance: clampNumber(Number(conditionMod.variance || 0) + Number(twistMod.variance || 0) + Number(sceneMod.variance || 0), 0, 12)
    }
    return profile
  }

  getStageEnvironment(room:UmaRoom, stage:UmaStage) {
    const profile = room.raceProfile || this.buildRaceProfile(room.track, room.twist, room.scene, room.condition)
    const stageIndex = Math.max(0, RACE_STAGES.findIndex(item => item.key === stage.key))
    const isStart = stage.key === "start"
    const isFinish = stage.key === "finish"
    return {
      profile,
      index: stageIndex,
      segmentDistance: Number(profile.segments[stageIndex]) || profile.distance / RACE_STAGES.length,
      slope: Number(profile.slope[stageIndex]) || 0,
      corner: Number(profile.corner[stageIndex]) || 0,
      friction: Number(profile.friction) || 1,
      staminaCostRate: Number(profile.staminaCostRate) || 1,
      rhythmDifficulty: Number(profile.rhythmDifficulty) || 1,
      routeDifficulty: (Number(profile.routeDifficulty) || 0) + (isFinish ? Number(profile.finalRouteDifficulty) || 0 : 0),
      speedCarry: (Number(profile.speedCarry) || 1) *
        (isStart ? Number(profile.startSpeedCarry) || 1 : 1) *
        (isFinish ? Number(profile.finalSpeedCarry) || 1 : 1),
      variance: Number(profile.variance) || 0
    }
  }

  async startRace(e:UmaEvent) {
    const config = this.getConfig()
    if (!config.enabled) return "赛马娘小游戏现在没开。"
    if (!e?.group_id) return "这个小游戏要在群里玩。"
    if (!this.getPlayerUma(this.getUserId(e), config)) {
      return "你还没有领养自己的赛马娘。先用：.赛马娘 领养 名字 性格描述"
    }

    const groupId = String(e.group_id)
    const existing = this.getRoom(groupId)
    if (existing) {
      if (existing.phase === "race") {
        return this.formatActiveRaceStatus(existing)
      }
      return [
        `这一局已经开了，当前 ${existing.participants.size} 人。`,
        this.formatTrack(existing.track),
        "想参加发：.赛马娘 加入 [策略]",
        this.formatStrategyTips()
      ].join("\n")
    }

    const lastAt = this.lastRaceAt.get(groupId) || 0
    const remain = config.cooldownSeconds - Math.floor((Date.now() - lastAt) / 1000)
    if (remain > 0) return `刚跑完一局，先歇 ${formatDuration(remain)} 再开。`

    const room:UmaRoom = {
      history:[],runners:[],twist:this.pickTwist(),scene:this.pickScene(),condition:this.pickCondition(),stageIndex:0,decisions:new Map(),
      groupId,
      starterId: String(e.user_id || e.sender?.user_id || ""),
      createdAt: Date.now(),
      phase: "lobby",
      track: this.pickTrack(),
      participants: new Map(),
      event: e,
      timer: null
    }
    this.rooms.set(groupId, room)
    await this.joinRace(e)
    const starter = room.participants.get(this.getUserId(e))
    const starterLine = starter
      ? `已自动报名：${starter.nickname}「${starter.umaName}」`
      : "已自动报名开局者"

    return [
      "赛马娘小游戏开局啦。",
      this.formatTrack(room.track),
      starterLine,
      `报名：.赛马娘 加入 [策略]`,
      this.formatStrategyTips(),
      `开跑：.赛马娘 开跑`,
      `人数：${room.participants.size}/${RACE_SIZE}，开跑不够 ${RACE_SIZE} 人会补 NPC`
    ].join("\n")
  }

  async joinRace(e:UmaEvent, strategyText = "") {
    const config = this.getConfig()
    if (!config.enabled) return "赛马娘小游戏现在没开。"
    if (!e?.group_id) return "这个小游戏要在群里玩。"

    const groupId = String(e.group_id)
    let room = this.getRoom(groupId)
    let createdByJoin = false
    const userId = String(e.user_id || e.sender?.user_id || "")
    if (!userId) return "没拿到你的 QQ 号，报名失败。"
    const owned = await this.ensurePlayerUmaTrait(userId, config)
    if (!owned?.uma) return "你还没有领养自己的赛马娘。先用：.赛马娘 领养 名字 性格描述"
    const { uma, trait } = owned

    if (!room) {
      const lastAt = this.lastRaceAt.get(groupId) || 0
      const remain = config.cooldownSeconds - Math.floor((Date.now() - lastAt) / 1000)
      if (remain > 0) return `刚跑完一局，先歇 ${formatDuration(remain)} 再开。`

      room = {
        history:[],runners:[],twist:this.pickTwist(),scene:this.pickScene(),condition:this.pickCondition(),stageIndex:0,decisions:new Map(),
        groupId,
        starterId: userId,
        createdAt: Date.now(),
        phase: "lobby",
        track: this.pickTrack(),
        participants: new Map(),
        event: e,
        timer: null
      }
      this.rooms.set(groupId, room)
      createdByJoin = true
    }

    if (room.phase === "race") {
      return [
        "这一局已经开跑了，不能再报名。",
        this.formatActiveRaceStatus(room)
      ].join("\n")
    }

    const elapsed = Math.floor((Date.now() - room.createdAt) / 1000)
    if (elapsed > config.lobbySeconds) {
      this.clearAutoStart(room)
      this.rooms.delete(groupId)
      const lastAt = this.lastRaceAt.get(groupId) || 0
      const remain = config.cooldownSeconds - Math.floor((Date.now() - lastAt) / 1000)
      if (remain > 0) return `上一局报名超时了，刚跑完一局，先歇 ${formatDuration(remain)} 再开。`

      room = {
        history:[],runners:[],twist:this.pickTwist(),scene:this.pickScene(),condition:this.pickCondition(),stageIndex:0,decisions:new Map(),
        groupId,
        starterId: userId,
        createdAt: Date.now(),
        phase: "lobby",
        track: this.pickTrack(),
        participants: new Map(),
        event: e,
        timer: null
      }
      this.rooms.set(groupId, room)
      createdByJoin = true
    }

    const strategy = this.parseStrategy(strategyText)
    if (room.participants.has(userId)) {
      const player = room.participants.get(userId)!
      player.strategyKey = this.getStrategyKey(strategy)
      player.strategyLabel = strategy.label
      room.createdAt = Date.now()
      room.event = e
      this.scheduleAutoStart(room, config)
      return `${this.getDisplayName(e)} 选择了${strategy.label}，已更新策略。`
    }
    if (room.participants.size >= config.maxPlayers) return "这局人满了，下一局再来。"

    room.participants.set(userId, {
      race:emptyUmaRaceState(),
      userId,
      nickname: this.getDisplayName(e),
      umaName: uma.name,
      umaAffix: this.normalizeUmaAffix(uma),
      attributes: uma.attributes,
      personality: uma.personality,
      proficiency: this.normalizeProficiency(uma.proficiency),
      traitKey: trait.key,
      traitLabel: trait.label,
      strategyKey: this.getStrategyKey(strategy),
      strategyLabel: strategy.label,
      joinedAt: Date.now()
    })
    room.createdAt = Date.now()
    room.event = e
    this.scheduleAutoStart(room, config)
    if (createdByJoin) {
      return [
        "赛马娘小游戏开局啦。",
        this.formatTrack(room.track),
        `报名成功：${this.getDisplayName(e)} 的「${uma.name}」`,
        `${this.getDisplayName(e)} 选择了${strategy.label}`,
        `报名：.赛马娘 加入 [策略]`,
        this.formatStrategyTips(),
        `开跑：.赛马娘 开跑`,
        `人数：${room.participants.size}/${RACE_SIZE}，开跑不够 ${RACE_SIZE} 人会补 NPC`
      ].join("\n")
    }
    return [
      `报名成功：${this.getDisplayName(e)} 的「${uma.name}」（${room.participants.size}/${config.maxPlayers}）`,
      `${this.getDisplayName(e)} 选择了${strategy.label}`
    ].join("\n")
  }

  scheduleAutoStart(room:UmaRoom, config = this.getConfig()) {
    if (!room) return
    this.clearAutoStart(room)
    const delayMs = Math.max(1, Number(config.lobbySeconds) || DEFAULT_CONFIG.lobbySeconds) * 1000
    room.timer = setTimeout(() => {
      this.autoStartRace(room.groupId).catch(error => {
        this.logger?.warn?.(`[赛马娘小游戏] 自动开赛失败: ${error instanceof Error?error.message:String(error)}`)
      })
    }, delayMs)
    room.timer.unref?.()
  }

  clearAutoStart(room:UmaRoom) {
    if (room?.timer) {
      clearTimeout(room.timer)
      room.timer = null
    }
  }

  scheduleStageAdvance(room:UmaRoom, config = this.getConfig()) {
    if (!room || room.phase !== "race") return
    this.clearStageTimer(room)
    const delayMs = Math.max(1, Number(config.raceStageSeconds) || DEFAULT_CONFIG.raceStageSeconds) * 1000
    room.stageTimer = setTimeout(() => {
      this.advanceRaceStage(room.groupId).catch(error => {
        this.logger?.warn?.(`[赛马娘小游戏] 阶段推进失败: ${error instanceof Error?error.message:String(error)}`)
      })
    }, delayMs)
    room.stageTimer.unref?.()
  }

  clearStageTimer(room:UmaRoom) {
    if (room?.stageTimer) {
      clearTimeout(room.stageTimer)
      room.stageTimer = null
    }
  }

  async autoStartRace(groupId:string) {
    const room = this.getRoom(groupId)
    if (!room) return
    const event = room.event
    if (!event?.reply) {
      this.rooms.delete(String(groupId || ""))
      return
    }
    if (!room.participants?.size) {
      this.clearAutoStart(room)
      this.rooms.delete(String(groupId || ""))
      await event.reply("报名时间到了，但没有参赛者，本局赛马取消。")
      return
    }
    const result = await this.runRace(event)
    if (typeof result === "string") await sendSmartReply(event, `报名时间到了，自动开赛。\n${result}`, { kind: "umaRaceResult" })
    else await event.reply(["报名时间到了，自动开赛。", ...(Array.isArray(result) ? result : [result])])
  }

  getStrategyKey(strategy:(typeof STRATEGIES)[keyof typeof STRATEGIES]) {
    for (const [key, value] of Object.entries(STRATEGIES)) {
      if (value === strategy) return key
    }
    return "normal"
  }

  cancelRace(e:UmaEvent) {
    if (!e?.group_id) return "这个小游戏要在群里玩。"
    const groupId = String(e.group_id)
    const room = this.getRoom(groupId)
    if (!room) return "现在没有赛马局。"
    const userId = String(e.user_id || e.sender?.user_id || "")
    if (!e.isMaster && userId !== room.starterId) return "只有开局的人或主人可以取消这一局。"
    this.clearAutoStart(room)
    this.clearStageTimer(room)
    this.rooms.delete(groupId)
    return "这局赛马已经取消。"
  }

  async runRace(e:UmaEvent) {
    const config = this.getConfig()
    if (!config.enabled) return "赛马娘小游戏现在没开。"
    if (!e?.group_id) return "这个小游戏要在群里玩。"

    const groupId = String(e.group_id)
    const room = this.getRoom(groupId)
    if (!room) return "现在没有赛马局。先发：.赛马娘 开始"
    if (room.phase === "race") return this.formatActiveRaceStatus(room)

    const players = this.prepareRacePlayers([...room.participants.values()])
    if (players.length < RACE_SIZE) {
      this.fillNpcPlayers(players, RACE_SIZE)
    }

    this.clearAutoStart(room)
    room.phase = "race"
    room.event = e
    room.startedAt = Date.now()
    room.stageIndex = 0
    room.condition = this.pickCondition()
    room.twist = this.pickTwist()
    room.scene = this.pickScene()
    room.raceProfile = this.buildRaceProfile(room.track, room.twist, room.scene, room.condition)
    room.decisions = new Map()
    room.history = []
    room.runners = this.initializeStageRunners(players, room.track, room.twist, room.scene, room.condition)
    this.lastRaceAt.set(groupId, Date.now())
    this.scheduleStageAdvance(room, config)

    const message = await this.renderRaceReportOrFallback(
      e,
      this.buildOpeningRaceReport(room),
      this.formatRaceStage(room, { opening: true, includeTips: false })
    )
    const withDecision = this.appendMessageText(message, this.formatRaceDecisionCopyText())
    return [this.formatOpeningAnnouncer(room), ...(Array.isArray(withDecision) ? withDecision : [withDecision])]
  }

  async raceDecision(e:UmaEvent) {
    if (!e?.group_id) return "这个小游戏要在群里玩。"
    const groupId = String(e.group_id)
    const room = this.getRoom(groupId)
    if (!room) return "现在没有赛马局。先发：.赛马娘 开始"
    if (room.phase !== "race") return "比赛还没开跑。开跑后每个阶段可以发：.赛马娘 决策 提速"

    const userId = this.getUserId(e)
    const runner = room.runners?.find(item => String(item.userId) === userId && !item.isNpc)
    if (!runner) return "你不在这一局里，不能下阶段决策。"

    const action = this.parseRaceAction(e?.msg)
    if (!action) {
      return [
        "没看懂这个决策。",
        this.formatRaceActionTips()
      ].join("\n")
    }

    const stage = RACE_STAGES[room.stageIndex] || RACE_STAGES[0]!
    if (!room.decisions) room.decisions = new Map()
    let stageDecisions = room.decisions.get(stage.key)
    if (!stageDecisions) {
      stageDecisions = new Map()
      room.decisions.set(stage.key, stageDecisions)
    }
    const previous = stageDecisions.get(userId)
    stageDecisions.set(userId, action.key)
    room.event = e

    if (this.areAllHumanPlayersDecided(room, stageDecisions)) {
      await this.advanceRaceStage(groupId)
      return ""
    }

    return previous && previous !== action.key
      ? `${runner.nickname} 把${stage.label}决策改成了：${action.label}`
      : `${runner.nickname} 的${stage.label}决策：${action.label}`
  }

  areAllHumanPlayersDecided(room:UmaRoom, stageDecisions:Map<string,string>) {
    const humans = (room.runners || []).filter(runner => !runner.isNpc)
    return humans.length > 0 && humans.every(runner => stageDecisions.has(String(runner.userId)))
  }

  parseRaceAction(msg = "") {
    const text = String(msg || "")
      .replace(/^[.。]赛马娘\s*(决策|选择|行动|策略)\s*/u, "")
      .trim()
    if (!text) return null
    for (const [key, action] of Object.entries(RACE_ACTIONS)) {
      if (action.aliases.some(alias => text.includes(alias))) return { key, ...action }
    }
    return null
  }

  formatRaceActionTips() {
    return [
      "可选决策：提速 / 减速 / 稳住 / 抢位 / 爆发 / 赌一把 / 跟跑 / 压节奏",
      "格式：.赛马娘 决策 提速，也可以用：.赛马娘 策略 提速"
    ].join("\n")
  }

  formatRaceDecisionCopyText() {
    return [
      "请使用：.赛马娘 决策 [行动]",
      "也可以用：.赛马娘 策略 [行动]",
      "行动：提速 / 减速 / 稳住 / 抢位 / 爆发 / 赌一把 / 跟跑 / 压节奏"
    ].join("\n")
  }

  initializeStageRunners(players:UmaRunner[], track:UmaScene, twist:UmaScene, scene:UmaScene, condition:Partial<UmaScene> = {}) {
    const strategyCounts = this.countStrategies(players)
    const raceProfile = this.buildRaceProfile(track, twist, scene, condition)
    const raceTags = this.getRaceTags(track, twist, scene, condition)
    return players.map(player => {
      const attributes = this.isValidAttributes(player.attributes)
        ? player.attributes
        : this.generateAttributes(player.umaName || player.nickname, "均衡")
      const strategyKey = player.strategyKey && Object.hasOwn(STRATEGIES,player.strategyKey) ? player.strategyKey : "normal"
      const strategy = Object.entries(STRATEGIES).find(([key])=>key===strategyKey)?.[1] || STRATEGIES.normal
      const trait:UmaTrait = this.getRaceTrait(player)
      const speed = this.rollAttributeValue(Number(attributes.speed))
      const staminaAttr = this.rollAttributeValue(Number(attributes.stamina))
      const power = this.rollAttributeValue(Number(attributes.power))
      const focus = this.rollAttributeValue(Number(attributes.focus))
      const wisdom = this.rollAttributeValue(Number(attributes.wisdom))
      const luck = this.rollAttributeValue(Number(attributes.luck), 50 + (trait.luckBonus || 0), 6)
      const conditionBonus = randomBetween(-7, 8)
      const fitBonus = Number(track.fit?.[strategyKey]) || 0
      const twistBonus = Number(twist.fit?.[strategyKey]) || 0
      const sceneBonus = Number(scene.fit?.[strategyKey]) || 0
      const traitTagBonus = this.getTraitTagBonus(trait, raceTags)
      const traitBonus = this.getTraitBonus(trait, strategyKey, raceTags)
      const strategyCrowdPenalty = this.getStrategyCrowdPenalty(strategyKey, strategyCounts, players.length)
      const basePosition = speed * 0.24 +
        staminaAttr * 0.15 +
        power * 0.15 +
        focus * 0.16 +
        wisdom * 0.14 +
        luck * 0.08 +
        fitBonus +
        twistBonus * 0.55 +
        sceneBonus * 0.55 +
        traitBonus +
        conditionBonus -
        strategyCrowdPenalty +
        randomBetween(-8, 9)
      const staminaMax = Math.min(145, 82 + Number(attributes.stamina || 0) * 2.35 + randomBetween(-4, 7))
      const rhythmMax = Math.min(135, 78 + Number(attributes.focus || 0) * 2.05 + randomBetween(-5, 7))
      const burstMax = Math.min(130, 58 + Number(attributes.power || 0) * 2.15 + randomBetween(-5, 7))
      const routeBase = Math.min(128, 58 + Number(attributes.wisdom || 0) * 2.25 + randomBetween(-6, 8))
      const baseVelocity = clampNumber(
        42 +
        (speed - 70) * 0.115 +
        (power - 70) * 0.035 +
        (focus - 70) * 0.018 +
        fitBonus * 0.18 +
        traitBonus * 0.12 -
        strategyCrowdPenalty * 0.2 +
        randomBetween(-3.5, 4.5),
        28,
        92
      )

      return {
        ...player,
        attributes,
        strategyKey,
        strategyLabel: strategy.label,
        traitKey: trait.key,
        traitLabel: trait.label,
        traitTagBonus,
        proficiency: this.normalizeProficiency(player.proficiency),
        raceTags: [...raceTags],
        race: {
          speed,
          staminaAttr,
          power,
          focus,
          wisdom,
          luck,
          position: basePosition,
          distance: Math.max(0, basePosition * 0.42 + randomBetween(-5, 5)),
          velocity: baseVelocity * raceProfile.speedCarry,
          maxVelocity: clampNumber(baseVelocity + 18 + (speed - 70) * 0.035, 46, 122),
          staminaMax,
          stamina: staminaMax,
          rhythmMax,
          rhythm: rhythmMax,
          burstMax,
          burstReserve: burstMax,
          route: routeBase,
          luckState: Math.min(120, 46 + Number(attributes.luck || 0) * 2.3 + randomBetween(-10, 11)),
          notes: [this.formatConditionEvent(player.nickname, conditionBonus)]
        }
      }
    })
  }

  async advanceRaceStage(groupId:string) {
    const room = this.getRoom(groupId)
    if (!room || room.phase !== "race") return
    if (room.advancing) return
    room.advancing = true
    this.clearStageTimer(room)
    try {
      const stage = RACE_STAGES[room.stageIndex] || RACE_STAGES[0]!
      const lines = this.resolveRaceStage(room, stage)
      room.history ||= []
      room.history.push({ stage: stage.key, lines })

      if (room.stageIndex >= RACE_STAGES.length - 1) {
        const finalMessage = await this.finishStagedRace(room)
        await room.event?.reply?.(finalMessage)
        return
      }

      const previousStage = stage
      room.stageIndex += 1
      room.advancing = false
      this.scheduleStageAdvance(room)
      const fallbackText = [
        `${stage.label}结束：`,
        ...lines,
        "",
        this.formatRaceStage(room, { includeTips: false })
      ].join("\n")
      const message = await this.renderRaceReportOrFallback(
        room.event,
        this.buildStageRaceReport(room, previousStage, lines),
        fallbackText
      )
      await room.event?.reply?.(this.appendMessageText(message, this.formatRaceDecisionCopyText()))
    } finally {
      if (this.getRoom(groupId) === room) room.advancing = false
    }
  }

  resolveRaceStage(room:UmaRoom, stage:UmaStage) {
    const rankedBefore = this.rankRunners(room.runners)
    const stageDecisions = room.decisions?.get(stage.key) || new Map()
    room.stageSnapshot = new Map(rankedBefore.map((runner, index) => [String(runner.userId), {
      rank: index + 1,
      userId: runner.userId,
      distance: Number(runner.race?.distance) || 0,
      velocity: Number(runner.race?.velocity) || 0
    }]))
    room.stageActionEffects = new Map()
    const lines = []
    for (const runner of rankedBefore) {
      const beforeRank = rankedBefore.findIndex(item => item.userId === runner.userId) + 1
      const manualAction = stageDecisions.get(String(runner.userId))
      const actionKey = runner.isNpc
        ? this.pickNpcStageAction(runner, beforeRank, stage, room)
        : (manualAction || this.getDefaultStageActionForStage(runner, stage, beforeRank, room))
      const action = RACE_ACTIONS[actionKey] ? { key: actionKey, ...RACE_ACTIONS[actionKey] } : { key: "steady", ...RACE_ACTIONS.steady }
      const result = this.applyRaceAction(runner, action, stage, beforeRank, room)
      if (!runner.isNpc && result.line) lines.push(result.line)
    }
    for (const runner of room.runners) {
      const race = runner.race
      if (Number(race.stamina) < 24) {
        race.velocity = Math.max(5, (Number(race.velocity) || 0) - randomBetween(4, 9))
        race.distance = Math.max(0, (Number(race.distance) || 0) - randomBetween(8, 18))
      }
      if (Number(race.rhythm) < 24) {
        race.velocity = Math.max(5, (Number(race.velocity) || 0) - randomBetween(3, 8))
        race.distance = Math.max(0, (Number(race.distance) || 0) - randomBetween(6, 16))
      }
      if (Number(race.stamina) > 82 && stage.key === "finish") race.distance += randomBetween(5, 14)
      race.position = Number(race.distance) || 0
    }
    room.stageSnapshot = null
    room.stageActionEffects = null
    return lines.length ? lines.slice(0, 5) : ["大家都按自己的节奏处理了这一段，队形还在继续变化。"]
  }

  applyRaceAction(runner:UmaRunner, action:{key:string;label?:string}, stage:UmaStage, beforeRank:number, room:UmaRoom) {
    const race = runner.race
    const check = this.rollRaceActionCheck(runner, action.key, stage, room)
    const effect = Object.entries(CHECK_GRADE_EFFECTS).find(([key])=>key===check.grade)?.[1] || CHECK_GRADE_EFFECTS.success
    const stageRate = this.getStageActionRate(action.key, stage.key, room.track?.id || "")
    const env = this.getStageEnvironment(room, stage)
    const attrPush = this.getActionAttributePush(runner, action.key)
    const crowdRisk = action.key === "inside" && beforeRank <= 4 ? randomBetween(0, 8) : 0
    const lowStaminaPenalty = race.stamina < 38 && ["speed_up", "burst", "gamble"].includes(action.key)
      ? randomBetween(5, 14)
      : 0
    const lowRhythmPenalty = race.rhythm < 38 && ["inside", "gamble", "burst"].includes(action.key)
      ? randomBetween(4, 12)
      : 0
    const stabilityGuard = Math.max(0, (race.focus - 70) * 0.018)
    const staminaGuard = Math.max(0, (race.staminaAttr - 70) * 0.018)
    const wisdomGuard = Math.max(0, (race.wisdom - 70) * 0.014)
    const resistedPenalty = (crowdRisk + lowStaminaPenalty + lowRhythmPenalty) * Math.max(0.35, 1 - stabilityGuard - staminaGuard - wisdomGuard)
    const beforeVelocity = Number(race.velocity) || 0
    const beforeStamina = Number(race.stamina) || 0
    let velocityDelta = attrPush * 0.34 * stageRate * effect.multiplier - resistedPenalty * 0.18
    let directDistanceDelta = attrPush * 1.2 * stageRate * effect.multiplier - resistedPenalty
    let note = ""
    const affixMechanicNotes = []

    if (action.key === "speed_up") {
      const speedLift = (randomBetween(7, 13) + attrPush * 0.16) * effect.multiplier
      velocityDelta += speedLift
      directDistanceDelta += speedLift * 0.62
      race.stamina -= this.adjustRaceCost(randomBetween(12, 20) * env.staminaCostRate * (1 + Math.max(0, env.slope) * 1.35), effect.staminaCost, race.staminaAttr)
      race.rhythm -= this.adjustRaceCost(randomBetween(3, 8) * env.rhythmDifficulty, effect.rhythmPenalty, race.focus)
      note = `${runner.nickname} 选择提速，${check.text}，${check.success ? ACTION_CHECKS.speed_up!.successText : ACTION_CHECKS.speed_up!.failText}。`
    } else if (action.key === "slow_down") {
      const brake = randomBetween(8, 15) * (check.success ? 0.8 : 1.15)
      velocityDelta -= brake
      directDistanceDelta -= randomBetween(7, 15) * (check.success ? 0.75 : 1.2)
      race.stamina += randomBetween(14, 24) * effect.stateBonus
      race.rhythm += randomBetween(8, 15) * effect.stateBonus
      note = `${runner.nickname} 主动减速，${check.text}，${check.success ? ACTION_CHECKS.slow_down!.successText : ACTION_CHECKS.slow_down!.failText}。`
    } else if (action.key === "steady") {
      race.rhythm += randomBetween(8, 15) * effect.stateBonus
      race.stamina -= this.adjustRaceCost(randomBetween(2, 6) * env.staminaCostRate, effect.staminaCost, race.staminaAttr)
      race.route += check.success ? randomBetween(2, 6) * effect.stateBonus : 0
      velocityDelta *= 0.78
      directDistanceDelta += check.success ? randomBetween(2, 7) * effect.stateBonus : 0
      note = `${runner.nickname} 稳住节奏，${check.text}，${check.success ? ACTION_CHECKS.steady!.successText : ACTION_CHECKS.steady!.failText}。`
    } else if (action.key === "inside") {
      const routeGain = check.success ? randomBetween(7, 15) * effect.stateBonus : randomBetween(-7, 1)
      race.route += routeGain
      race.rhythm -= this.adjustRaceCost((randomBetween(2, 7) + env.corner * 10 + env.routeDifficulty * 0.18) * env.rhythmDifficulty, effect.rhythmPenalty, race.focus)
      if (check.success) {
        directDistanceDelta += randomBetween(8, 18) * effect.stateBonus
        velocityDelta += randomBetween(2, 6) * effect.multiplier
      }
      if (!check.success || crowdRisk > 0) directDistanceDelta -= randomBetween(5, 13) * (check.success ? 0.55 : 1.1)
      note = `${runner.nickname} 选择抢位，${check.text}，${check.success ? ACTION_CHECKS.inside!.successText : ACTION_CHECKS.inside!.failText}。`
    } else if (action.key === "burst") {
      const burstLift = (randomBetween(16, 29) + attrPush * 0.2) * effect.multiplier
      velocityDelta += burstLift
      directDistanceDelta += burstLift * 0.82
      race.burstReserve -= this.adjustRaceCost(randomBetween(22, 36) * (1 + Math.max(0, env.slope) * 0.9), effect.staminaCost, race.power)
      race.stamina -= this.adjustRaceCost(randomBetween(18, 31) * env.staminaCostRate * (1 + Math.max(0, env.slope) * 1.2), effect.staminaCost, race.staminaAttr)
      race.rhythm -= this.adjustRaceCost(randomBetween(7, 14) * env.rhythmDifficulty, effect.rhythmPenalty, race.focus)
      if (Number(race.burstReserve) < 18) {
        directDistanceDelta -= randomBetween(9, 18)
        velocityDelta -= randomBetween(6, 13)
      }
      note = `${runner.nickname} 开始爆发，${check.text}，${check.success ? ACTION_CHECKS.burst!.successText : ACTION_CHECKS.burst!.failText}。`
    } else if (action.key === "gamble") {
      const luckEdge = Math.max(0, (Number(race.luck) - 90) * 0.22)
      const powerCeiling = Math.max(0, (Number(race.power) - 82) * 0.12)
      const speedCeiling = Math.max(0, (Number(race.speed) - 82) * 0.08)
      const ceilingBonus = luckEdge + powerCeiling + speedCeiling
      const gradeCeilingRate = check.grade === "critical" ? 1.42 : check.grade === "hard" ? 1.18 : 1
      const failGuard = Math.max(0.25, 1 - Math.max(0, Number(race.luck) - 90) * 0.003)
      const gamble = this.rollGambleActionEffect(check, ceilingBonus, effect, failGuard)
      directDistanceDelta += gamble.distance
      velocityDelta += gamble.velocity
      race.stamina += gamble.stamina
      race.rhythm += gamble.rhythm
      race.route += gamble.route
      race.luckState -= randomBetween(7, 18) * (check.success ? 0.85 : 1.25)
      race.rhythm -= this.adjustRaceCost(randomBetween(4, 12) * env.rhythmDifficulty, effect.rhythmPenalty, race.focus)
      note = `${runner.nickname} 赌了一把，${check.text}，${gamble.text}。`
    } else if (action.key === "follow") {
      race.rhythm += randomBetween(5, 12) * effect.stateBonus
      race.stamina -= this.adjustRaceCost(randomBetween(3, 7) * env.staminaCostRate, effect.staminaCost, race.staminaAttr)
      const chase = this.getFollowChaseEffect(runner, beforeRank, room, check, effect)
      const followDelta = chase.distance
      directDistanceDelta += followDelta
      velocityDelta += chase.velocity
      note = `${runner.nickname} 选择跟跑，${check.text}，${chase.text}。`
    } else if (action.key === "pace") {
      race.stamina += randomBetween(5, 12) * effect.stateBonus
      race.rhythm += randomBetween(4, 10) * effect.stateBonus
      velocityDelta -= stage.key === "finish" ? randomBetween(2, 7) : randomBetween(0, 3)
      directDistanceDelta += (stage.key === "finish" ? randomBetween(-8, 4) : randomBetween(-3, 8)) * (check.success ? 1 : 1.25)
      note = `${runner.nickname} 压住节奏，${check.text}，${check.success ? ACTION_CHECKS.pace!.successText : ACTION_CHECKS.pace!.failText}。`
    }

    const affix = this.normalizeUmaAffix(runner.umaAffix || runner.affix || runner)
    const mechanic = affix?.mechanic || ""
    const mechanicKey = `action:${mechanic}`
    const canUseActionMechanic = mechanic &&
      this.affixMatchesAction(affix, action.key) &&
      !this.isAffixMechanicUsed(runner, mechanicKey)
    if (canUseActionMechanic && check.success && mechanic === "extra_push") {
      const extra = randomBetween(10, 24)
      directDistanceDelta += extra
      this.markAffixMechanicUsed(runner, mechanicKey)
      affixMechanicNotes.push(`${affix?.label || ""}多顶出${Math.round(extra)}m`)
    } else if (canUseActionMechanic && mechanic === "stamina_guard") {
      const recover = randomBetween(7, 14)
      race.stamina += recover
      this.markAffixMechanicUsed(runner, mechanicKey)
      affixMechanicNotes.push(`${affix?.label || ""}让体力少掉了一截`)
    } else if (canUseActionMechanic && check.success && mechanic === "finish_burst" && stage.key === "finish") {
      const extra = randomBetween(14, 30)
      directDistanceDelta += extra
      race.burstReserve -= randomBetween(5, 11)
      this.markAffixMechanicUsed(runner, mechanicKey)
      affixMechanicNotes.push(`${affix?.label || ""}在终点前多冲了${Math.round(extra)}m`)
    } else if (canUseActionMechanic && check.success && mechanic === "route_surge") {
      const route = randomBetween(7, 14)
      race.route += route
      directDistanceDelta += randomBetween(5, 13)
      this.markAffixMechanicUsed(runner, mechanicKey)
      affixMechanicNotes.push(`${affix?.label || ""}把路线处理得更漂亮`)
    } else if (canUseActionMechanic && !check.success && mechanic === "soften_failure") {
      directDistanceDelta += randomBetween(8, 16)
      velocityDelta += randomBetween(2, 5)
      this.markAffixMechanicUsed(runner, mechanicKey)
      affixMechanicNotes.push(`${affix?.label || ""}把失败损失压低了`)
    } else if (canUseActionMechanic && !check.success && mechanic === "bad_luck_echo") {
      race.rhythm -= randomBetween(7, 14)
      directDistanceDelta -= randomBetween(5, 13)
      this.markAffixMechanicUsed(runner, mechanicKey)
      affixMechanicNotes.push(`${affix?.label || ""}让节奏又乱了一拍`)
    }
    if (affixMechanicNotes.length) note += ` ${affixMechanicNotes.join("；")}。`

    const catchup = this.getCatchupActionBonus(runner, action.key, beforeRank, room, check)
    if (catchup.distance || catchup.velocity) {
      directDistanceDelta += catchup.distance
      velocityDelta += catchup.velocity
      if (catchup.text) note += ` ${catchup.text}。`
    }

    if (runner.isNpc) {
      velocityDelta = this.scalePositiveRaceDelta(velocityDelta, 0.92)
      directDistanceDelta = this.scalePositiveRaceDelta(directDistanceDelta, 0.92)
    }

    const slopeVelocityDrag = Math.max(0, env.slope) * env.friction * 18
    const downhillBoost = Math.max(0, -env.slope) * 12
    const cornerDrag = env.corner * Math.max(0, 18 - (race.focus - 70) * 0.08 - (race.wisdom - 70) * 0.06)
    const velocityDecay = this.getStageVelocityDecay(race, action.key, env, check)
    race.velocity = clampNumber((Number(race.velocity) || 0) + velocityDelta + downhillBoost - slopeVelocityDrag - cornerDrag - velocityDecay, 8, Number(race.maxVelocity) || 118)

    const environmentalCost = (env.segmentDistance / 110) *
      env.friction *
      env.staminaCostRate *
      (1 + Math.max(0, env.slope) * 1.7 + env.corner * 0.35)
    const rhythmCost = (env.corner * 12 + Math.max(0, env.routeDifficulty) * 0.28 + Math.max(0, env.slope) * 7) * env.rhythmDifficulty
    race.stamina -= this.adjustRaceCost(environmentalCost, 1, race.staminaAttr)
    race.rhythm -= this.adjustRaceCost(rhythmCost, 1, race.focus)

    race.stamina = Math.max(0, Math.min(Number(race.staminaMax) || 145, race.stamina))
    race.rhythm = Math.max(0, Math.min(Number(race.rhythmMax) || 135, race.rhythm))
    race.burstReserve = Math.max(0, Math.min(Number(race.burstMax) || 130, race.burstReserve))
    race.route = Math.max(0, Math.min(130, race.route))
    race.luckState = Math.max(0, Math.min(125, race.luckState))

    const routeEfficiency = clampNumber(0.76 + race.route / 260 - env.corner * 0.18 - env.routeDifficulty / 180, 0.58, 1.18)
    const rhythmEfficiency = clampNumber(0.74 + race.rhythm / 310, 0.58, 1.14)
    const staminaEfficiency = race.stamina >= 42
      ? clampNumber(0.82 + race.stamina / 260, 0.78, 1.16)
      : clampNumber(0.56 + race.stamina / 120, 0.45, 0.9)
    const velocityEfficiency = clampNumber(0.72 + race.velocity / 170, 0.72, 1.42)
    const distanceDelta = Math.max(
      8,
      env.segmentDistance * velocityEfficiency * routeEfficiency * rhythmEfficiency * staminaEfficiency +
        directDistanceDelta +
        randomBetween(-6 - env.variance, 7 + env.variance)
    )
    race.distance = Math.max(0, (Number(race.distance) || 0) + distanceDelta)
    race.position = race.distance
    race.lastDelta = {
      distance: distanceDelta,
      velocityBefore: beforeVelocity,
      velocityAfter: race.velocity,
      staminaDelta: race.stamina - beforeStamina,
      velocityDelta: race.velocity - beforeVelocity,
      velocityDecay
    }
    race.lastCheck = check
    race.lastActionKey = action.key
    room.stageActionEffects?.set?.(String(runner.userId), {
      actionKey: action.key,
      velocityBefore: beforeVelocity,
      velocityAfter: race.velocity,
      velocityDelta: race.velocity - beforeVelocity,
      distanceDelta
    })
    this.recordActionProficiencyUse(runner, action.key, check)
    const numericText = this.formatActionNumericDelta(race.lastDelta)
    race.notes = [note, numericText, this.describeRunnerState(runner)].filter(Boolean)
    return { line: `${note} ${numericText} ${this.describeRunnerState(runner)}`.trim() }
  }

  formatActionNumericDelta(delta:Record<string,number> = {}) {
    const from = Math.round(Number(delta.velocityBefore) || 0)
    const to = Math.round(Number(delta.velocityAfter) || 0)
    const staminaDelta = Math.round(Number(delta.staminaDelta) || 0)
    const staminaText = staminaDelta >= 0 ? `+${staminaDelta}` : `${staminaDelta}`
    const distance = Math.round(Number(delta.distance) || 0)
    return `速度 ${from}->${to}，体力 ${staminaText}，推进 ${distance}m。`
  }

  scalePositiveRaceDelta(value:number, rate = 1) {
    const amount = Number(value) || 0
    if (amount <= 0) return amount
    return amount * Number(rate || 1)
  }

  getStageVelocityDecay(race:Partial<UmaRaceState> = {}, actionKey = "", env:Partial<ReturnType<UmaRaceManager["getStageEnvironment"]>> = {}, check:Partial<UmaCheck> = {}) {
    const base = randomBetween(4.5, 8.5) *
      (Number(env.friction) || 1) *
      (1 + Math.max(0, Number(env.slope) || 0) * 1.2 + (Number(env.corner) || 0) * 0.28)
    const focusGuard = Math.max(0, (Number(race.focus) - 70) * 0.018)
    const staminaGuard = Math.max(0, (Number(race.staminaAttr) - 70) * 0.012)
    const actionRates:Record<string,number> = {
      steady: check.success ? 0.28 : 0.45,
      pace: check.success ? 0.42 : 0.58,
      slow_down: 0.88,
      follow: check.success ? 0.55 : 0.76,
      inside: check.success ? 0.62 : 0.86,
      speed_up: 0.82,
      burst: 1.05,
      gamble: check.success ? 0.7 : 1.08
    }
    const rate = actionRates[actionKey] || 0.75
    return Math.max(1.2, base * rate * Math.max(0.58, 1 - focusGuard - staminaGuard))
  }

  rollGambleActionEffect(check:Partial<UmaCheck> = {}, ceilingBonus = 0, effect = CHECK_GRADE_EFFECTS.success, failGuard = 1) {
    if (!check.success) {
      const loss = randomBetween(12, 26) * Math.max(0.7, Math.abs(effect.multiplier || 1)) * failGuard
      const stumble = randomBetween(4, 10) * failGuard
      const failText = check.grade === "fumble"
        ? "大失败，机会没抓住，反而被挤出了节奏"
        : "没接住机会，身位和节奏都亏了一截"
      return {
        distance: -loss,
        velocity: -stumble,
        stamina: -randomBetween(3, 9) * failGuard,
        rhythm: -randomBetween(6, 14) * failGuard,
        route: -randomBetween(1, 6) * failGuard,
        text: failText
      }
    }

    const gradeRate = check.grade === "critical" ? 1.42 : check.grade === "hard" ? 1.18 : 1
    const roll = Math.random()
    const base = (randomBetween(12, 32) + ceilingBonus) * (effect.stateBonus || 1) * gradeRate
    if (check.grade === "critical") {
      return {
        distance: base + randomBetween(22, 42),
        velocity: randomBetween(12, 24) + ceilingBonus * 0.28,
        stamina: -randomBetween(4, 10),
        rhythm: randomBetween(0, 5),
        route: randomBetween(6, 14),
        text: "大成功，像是突然踩中了奇迹路线，整段队形都被她撕开了"
      }
    }
    if (roll < 0.34) {
      return {
        distance: base + randomBetween(8, 18),
        velocity: base * 0.3,
        stamina: -randomBetween(2, 6),
        rhythm: -randomBetween(2, 7),
        route: randomBetween(1, 5),
        text: "突然抓到空档，一口气把距离吃了回来"
      }
    }
    if (roll < 0.67) {
      return {
        distance: base * 0.78,
        velocity: randomBetween(8, 18) + ceilingBonus * 0.22,
        stamina: -randomBetween(6, 13),
        rhythm: -randomBetween(3, 8),
        route: 0,
        text: "速度一下子顶上去，场面被她搅乱了"
      }
    }
    return {
      distance: base * 0.62,
      velocity: randomBetween(3, 9),
      stamina: randomBetween(2, 8),
      rhythm: randomBetween(1, 6),
      route: randomBetween(3, 8),
      text: "不仅没乱，还顺手把路线和气息都接住了"
    }
  }

  getFollowChaseEffect(runner:Partial<UmaRunner> = {}, beforeRank = 1, room:Partial<UmaRoom> = {}, check:Partial<UmaCheck> = {}, effect = CHECK_GRADE_EFFECTS.success) {
    const snapshot = room.stageSnapshot
    if (!snapshot || beforeRank <= 1) {
      const distance = check.success ? randomBetween(2, 8) * (effect.stateBonus || 1) : randomBetween(-5, 2)
      return {
        distance,
        velocity: distance * 0.12,
        text: check.success ? "前面没有可借的影子，只是把自己的节奏贴稳了" : ACTION_CHECKS.follow!.failText
      }
    }
    const front = [...snapshot.values()].find(item => item.rank === beforeRank - 1)
    const self = snapshot.get(String(runner.userId))
    const frontEffect = front ? room.stageActionEffects?.get?.(String(front.userId)) : null
    const gap = Math.max(0, (Number(front?.distance) || 0) - (Number(self?.distance) || 0))
    const frontVelocityGain = Math.max(0, Number(frontEffect?.velocityDelta) || 0)
    const frontPulledDistance = Math.max(0, Number(frontEffect?.distanceDelta) || 0)
    const successRate = check.success ? 1 : 0.42
    const gapCut = Math.min(26, gap * randomBetween(0.18, 0.38))
    const draft = check.success
      ? gap <= 72
        ? randomBetween(7, 15)
        : gap <= 150
          ? randomBetween(4, 10)
          : randomBetween(0, 5)
      : 0
    const tow = (frontVelocityGain * randomBetween(0.65, 1.15) + frontPulledDistance * 0.045) * successRate
    const distance = (beforeRank > 4 ? randomBetween(5, 12) : randomBetween(1, 7)) * successRate + gapCut * successRate + tow + draft
    const velocity = (frontVelocityGain * randomBetween(0.22, 0.42) + distance * 0.08) * successRate
    return {
      distance,
      velocity,
      text: check.success
        ? `咬住前一名的节奏，差距被缩短了${Math.round(Math.max(0, distance))}m`
        : ACTION_CHECKS.follow!.failText
    }
  }

  getCatchupActionBonus(runner:Partial<UmaRunner> = {}, actionKey = "", beforeRank = 1, room:Partial<UmaRoom> = {}, check:Partial<UmaCheck> = {}) {
    if (beforeRank <= 3 || !["follow", "gamble", "burst"].includes(actionKey)) {
      return { distance: 0, velocity: 0, text: "" }
    }
    const context = this.getRaceGapContext(runner, room)
    if (context.leaderGap < 90 && context.previousGap < 48) return { distance: 0, velocity: 0, text: "" }
    const successRate = check.success ? 1 : 0.35
    const pressure = clampNumber(context.leaderGap / 180, 0.35, 1.35)
    const actionRate = actionKey === "follow" ? 1.05 : actionKey === "gamble" ? 1.18 : 0.92
    const distance = randomBetween(5, 16) * pressure * actionRate * successRate
    const velocity = randomBetween(1, 5) * pressure * actionRate * successRate
    if (distance <= 1) return { distance: 0, velocity: 0, text: "" }
    const text = actionKey === "follow"
      ? "后排借到前方队列的风，追回了一小段"
      : actionKey === "gamble"
        ? "落后位置反而给了她放手一搏的空间"
        : "后排开始强行追速，差距被压回一点"
    return { distance, velocity, text }
  }

  getRaceGapContext(runner:Partial<UmaRunner> = {}, room:Partial<UmaRoom> = {}) {
    const snapshot = room.stageSnapshot
    const self = snapshot?.get?.(String(runner.userId))
    if (!snapshot || !self) return { previousGap: 0, leaderGap: 0, rank: 1 }
    const entries = [...snapshot.values()].sort((a, b) => a.rank - b.rank)
    const leader = entries[0] || self
    const previous = entries.find(item => item.rank === self.rank - 1) || self
    return {
      rank: self.rank,
      previousGap: Math.max(0, (Number(previous.distance) || 0) - (Number(self.distance) || 0)),
      leaderGap: Math.max(0, (Number(leader.distance) || 0) - (Number(self.distance) || 0))
    }
  }

  adjustRaceCost(value:number, rate = 1, guardAttribute = 70) {
    const guard = Math.max(0, (Number(guardAttribute) - 70) * 0.004)
    return Number(value) * Number(rate || 1) * Math.max(0.68, 1 - guard)
  }

  rollRaceActionCheck(runner:UmaRunner, actionKey:string, stage:UmaStage, room:UmaRoom) {
    const race = runner.race
    const config = ACTION_CHECKS[actionKey] || ACTION_CHECKS.steady!
    const primary = Number(record(race)[config.primary]) || 70
    const secondary = Number(record(race)[config.secondary]) || 70
    const state = Number(record(race)[config.state]) || 70
    const stageBonus = Number(config.scene?.[stage.key]) || 0
    const trackBonus = Number(config.track?.[room.track?.id || ""]) || 0
    const twistBonus = Number(room.twist?.fit?.[runner.strategyKey]) * 0.18 || 0
    const sceneBonus = Number(room.scene?.fit?.[runner.strategyKey]) * 0.18 || 0
    const traitTagBonus = clampNumber(Number(runner.traitTagBonus) || 0, -3, 4) * 0.55
    const proficiencyBonus = this.getActionProficiencyBonus(runner, actionKey)
    const affixBonus = this.getAffixActionBonus(runner, actionKey)
    const supportBonus = this.getActionCheckSupportBonus(runner, actionKey)
    const staminaPenalty = race.stamina < 35 && ["speed_up", "burst", "gamble"].includes(actionKey) ? -8 : 0
    const rhythmPenalty = race.rhythm < 35 && ["inside", "burst", "gamble"].includes(actionKey) ? -7 : 0
    const luckCritBonus = Math.max(0, (Number(race.luck) - 75) * 0.015)
    const target = Math.round(clampNumber(
      44 +
      (primary - 70) * 0.23 +
      (secondary - 70) * 0.13 +
      (state - 70) * (config.stateWeight || 0.08) +
      stageBonus +
      trackBonus +
      twistBonus +
      sceneBonus +
      traitTagBonus +
      proficiencyBonus +
      affixBonus +
      supportBonus +
      staminaPenalty +
      rhythmPenalty,
      25,
      88
    ))
    const affix = this.normalizeUmaAffix(runner.umaAffix || runner.affix || runner)
    const mechanic = affix?.mechanic || ""
    const mechanicKey = `check:${mechanic}`
    const canUseMechanic = mechanic && this.affixMatchesAction(affix, actionKey) && !this.isAffixMechanicUsed(runner, mechanicKey)
    const roll = randomInt(1, 100)
    const criticalLimit = Math.min(8, 5 + Math.floor(luckCritBonus))
    let finalRoll = roll
    let grade = this.gradeRaceRoll(roll, target, criticalLimit)
    const notes = []
    if (canUseMechanic && mechanic === "advantage_roll") {
      const extraRoll = randomInt(1, 100)
      const extraGrade = this.gradeRaceRoll(extraRoll, target, criticalLimit)
      if (this.isBetterGrade(extraGrade, grade) || (extraGrade === grade && extraRoll < finalRoll)) {
        finalRoll = extraRoll
        grade = extraGrade
      }
      this.markAffixMechanicUsed(runner, mechanicKey)
      notes.push(`${affix?.label || ""}额外掷骰 ${roll}/${extraRoll}，取${finalRoll}`)
    } else if (canUseMechanic && mechanic === "reroll_fumble" && grade === "fumble") {
      const extraRoll = randomInt(1, 100)
      finalRoll = extraRoll
      grade = this.gradeRaceRoll(extraRoll, target, criticalLimit)
      this.markAffixMechanicUsed(runner, mechanicKey)
      notes.push(`${affix?.label || ""}改写大失败，重掷为${extraRoll}`)
    } else if (canUseMechanic && mechanic === "downgrade_first_critical" && grade === "critical") {
      grade = "hard"
      this.markAffixMechanicUsed(runner, mechanicKey)
      notes.push(`${affix?.label || ""}压住了大成功`)
    }
    const label = Object.entries(CHECK_GRADE_EFFECTS).find(([key])=>key===grade)?.[1].label || "失败"
    return {
      roll: finalRoll,
      rawRoll: roll,
      target,
      grade,
      label,
      affixNotes: notes,
      success: ["critical", "hard", "success"].includes(grade),
      text: `D100=${finalRoll}/${target}，${label}${notes.length ? `（${notes.join("；")}）` : ""}`
    }
  }

  getActionCheckSupportBonus(runner:UmaRunner, actionKey:string) {
    const race:Partial<UmaRaceState> = runner.race || {}
    const profiles:Record<string,Record<string,number>> = {
      speed_up: { power: 0.05, focus: 0.03, wisdom: 0.02, luck: 0.018, staminaAttr: 0.016 },
      slow_down: { wisdom: 0.04, luck: 0.018, speed: 0.016, power: 0.012 },
      steady: { staminaAttr: 0.035, wisdom: 0.034, luck: 0.018, speed: 0.012, power: 0.01 },
      inside: { speed: 0.04, luck: 0.028, staminaAttr: 0.018, power: 0.014 },
      burst: { speed: 0.06, staminaAttr: 0.028, focus: 0.024, luck: 0.026, wisdom: 0.014 },
      gamble: { power: 0.06, speed: 0.045, wisdom: 0.034, focus: 0.026, staminaAttr: 0.018 },
      follow: { speed: 0.032, staminaAttr: 0.028, luck: 0.02, power: 0.012 },
      pace: { focus: 0.044, wisdom: 0.032, power: 0.018, luck: 0.016, speed: 0.012 }
    }
    const profile = profiles[actionKey] || {}
    const bonus = Object.entries(profile).reduce((sum, [key, weight]) => {
      return sum + ((Number(record(race)[key]) || 70) - 70) * Number(weight)
    }, 0)
    return clampNumber(bonus, -5, 7)
  }

  getActionAttributePush(runner:UmaRunner, actionKey:string) {
    const race = runner.race
    const attr:Record<string,number> = {
      speed_up: race.speed * 0.082 + race.staminaAttr * 0.024 + race.power * 0.026 + race.focus * 0.018 + race.wisdom * 0.012 + race.luck * 0.01,
      slow_down: race.staminaAttr * 0.046 + race.focus * 0.038 + race.wisdom * 0.02 + race.luck * 0.01 + race.speed * 0.008,
      steady: race.focus * 0.064 + race.wisdom * 0.032 + race.staminaAttr * 0.018 + race.luck * 0.012 + race.speed * 0.008,
      inside: race.wisdom * 0.064 + race.focus * 0.036 + race.speed * 0.018 + race.luck * 0.014 + race.staminaAttr * 0.01,
      burst: race.power * 0.086 + race.speed * 0.044 + race.staminaAttr * 0.018 + race.focus * 0.014 + race.luck * 0.014,
      gamble: race.luck * 0.092 + race.power * 0.038 + race.speed * 0.024 + race.wisdom * 0.018 + race.focus * 0.014 + race.staminaAttr * 0.01,
      follow: race.wisdom * 0.048 + race.focus * 0.042 + race.speed * 0.018 + race.staminaAttr * 0.018 + race.luck * 0.012,
      pace: race.staminaAttr * 0.052 + race.focus * 0.034 + race.wisdom * 0.022 + race.power * 0.012 + race.luck * 0.01
    }
    return (Number(attr[actionKey]) || 0) + this.getSignatureAttributePush(runner, actionKey)
  }

  getSignatureAttributePush(runner:UmaRunner, actionKey:string) {
    const race:Partial<UmaRaceState> = runner.race || {}
    const values:[string,number][] = [
      ["speed", Number(race.speed) || 70],
      ["stamina", Number(race.staminaAttr) || 70],
      ["power", Number(race.power) || 70],
      ["focus", Number(race.focus) || 70],
      ["wisdom", Number(race.wisdom) || 70],
      ["luck", Number(race.luck) || 70]
    ]
    values.sort((a, b) => b[1] - a[1])
    const [key, value] = values[0] || ["focus", 70]
    if (value < 118) return 0
    const relevance:Record<string,Record<string,number>> = {
      speed: { speed_up: 1, burst: 0.68, inside: 0.42, follow: 0.34, gamble: 0.34, steady: 0.2, pace: 0.16, slow_down: 0.1 },
      stamina: { pace: 1, slow_down: 0.82, steady: 0.58, follow: 0.38, speed_up: 0.26, burst: 0.24, gamble: 0.18, inside: 0.16 },
      power: { burst: 1, speed_up: 0.58, gamble: 0.48, follow: 0.34, inside: 0.26, steady: 0.18, pace: 0.18, slow_down: 0.12 },
      focus: { steady: 1, follow: 0.72, pace: 0.62, inside: 0.48, slow_down: 0.38, speed_up: 0.22, burst: 0.2, gamble: 0.2 },
      wisdom: { inside: 1, follow: 0.76, steady: 0.58, slow_down: 0.42, gamble: 0.36, pace: 0.34, speed_up: 0.18, burst: 0.16 },
      luck: { gamble: 1, burst: 0.44, speed_up: 0.36, inside: 0.34, follow: 0.3, steady: 0.24, pace: 0.2, slow_down: 0.16 }
    }
    const rate = relevance[key]?.[actionKey] || 0.15
    return clampNumber((value - 118) * 0.045 * rate, 0, 7)
  }

  getStageActionRate(actionKey:string, stageKey:string, trackId:string) {
    const table:Record<string,Record<string,number>> = {
      start: { speed_up: 1.15, inside: 1.18, steady: 1.08, burst: 0.92, slow_down: 0.72, pace: 0.9 },
      mid: { slow_down: 1.15, follow: 1.15, pace: 1.18, inside: 1.08, speed_up: 0.95, burst: 0.86 },
      finish: { burst: 1.28, speed_up: 1.16, gamble: 1.18, follow: 0.9, pace: 0.78, slow_down: 0.65 }
    }
    let rate = table[stageKey]?.[actionKey] || 1
    if (trackId === "short_sprint" && ["speed_up", "burst"].includes(actionKey)) rate += 0.08
    if (trackId === "endurance" && ["pace", "slow_down", "follow"].includes(actionKey)) rate += 0.08
    if (trackId === "many_corners" && ["inside", "steady"].includes(actionKey)) rate += 0.08
    if (trackId === "rain_mud" && ["steady", "pace"].includes(actionKey)) rate += 0.08
    return rate
  }

  getDefaultStageAction(runner:UmaRunner) {
    return this.getDefaultStageActionForStage(runner, { key: "mid" })
  }

  getAttributeSpecialty(attributes:Record<string,number> = {}) {
    const ranked = ATTRIBUTE_DEFS
      .map(def => ({ key: def.key, value: Number(attributes[def.key]) || 0 }))
      .sort((a, b) => b.value - a.value)
    const top = ranked[0] || { key: "focus", value: 0 }
    const second = ranked[1] || { value: 0 }
    return {
      key: top.key,
      value: top.value,
      gap: top.value - second.value,
      isClear: top.value >= 28 && top.value - second.value >= 8
    }
  }

  getSpecialtyAction(runner:Partial<UmaRunner> = {}, stage:Partial<UmaStage> = {}) {
    const specialty = this.getAttributeSpecialty(runner.attributes || {})
    if (!specialty.isClear) return null
    const stageKey = stage?.key || "mid"
    const table:Record<string,Record<string,string>> = {
      speed: { start: "speed_up", mid: "speed_up", finish: "speed_up" },
      stamina: { start: "steady", mid: "pace", finish: "pace" },
      power: { start: "speed_up", mid: "follow", finish: "burst" },
      focus: { start: "steady", mid: "steady", finish: "follow" },
      wisdom: { start: "inside", mid: "follow", finish: "inside" },
      luck: { start: "gamble", mid: "gamble", finish: "gamble" }
    }
    return table[specialty.key]?.[stageKey] || null
  }

  getDefaultStageActionForStage(runner:Partial<UmaRunner> = {}, stage:Partial<UmaStage> = {}, beforeRank:number|null = null, room:UmaRoom|null = null) {
    const dynamic = this.getDynamicStageAction(runner, stage, beforeRank, room)
    if (dynamic) return dynamic
    const strategyKey = runner.strategyKey || "normal"
    const specialtyAction = this.getSpecialtyAction(runner, stage)
    if (specialtyAction && ["normal", "burst", "conserve"].includes(strategyKey)) {
      if (strategyKey === "burst" && stage?.key === "finish") return specialtyAction === "gamble" ? "gamble" : "burst"
      if (strategyKey === "conserve" && stage?.key !== "start") return specialtyAction === "gamble" ? "gamble" : "pace"
      return specialtyAction
    }
    return STRATEGY_DEFAULT_ACTIONS[strategyKey] || "steady"
  }

  getDynamicStageAction(runner:Partial<UmaRunner> = {}, stage:Partial<UmaStage> = {}, beforeRank:number|null = null, room:UmaRoom|null = null) {
    const race:Partial<UmaRaceState> = runner.race || {}
    const rank = Number(beforeRank) || 1
    const stageKey = stage?.key || "mid"
    const gap = room ? this.getRaceGapContext(runner, room) : { previousGap: 0, leaderGap: 0, rank }
    const specialty = this.getAttributeSpecialty(runner.attributes || {})

    if (Number(race.stamina) < 22) return stageKey === "finish" ? "slow_down" : "pace"
    if (Number(race.rhythm) < 24) return rank <= 3 ? "steady" : "follow"
    if (Number(race.burstReserve) < 22 && ["burst", "gamble"].includes(this.getSpecialtyAction(runner, stage) || "")) {
      return stageKey === "finish" ? "speed_up" : "steady"
    }

    if (rank >= 5 || gap.leaderGap >= 120 || gap.previousGap >= 72) {
      if (stageKey === "finish") {
        if (specialty.key === "luck" && Number(race.luckState) > 28) return "gamble"
        if (Number(race.burstReserve) > 38 || specialty.key === "power") return "burst"
        return "speed_up"
      }
      if (stageKey === "mid") {
        if (gap.previousGap <= 150) return "follow"
        if (specialty.key === "luck" && Number(race.luckState) > 36) return "gamble"
        return "speed_up"
      }
      return specialty.key === "wisdom" ? "inside" : "speed_up"
    }

    if (rank <= 3 && stageKey === "finish") {
      if (Number(race.stamina) > 55 && Number(race.burstReserve) > 45 && specialty.key === "power") return "burst"
      if (Number(race.rhythm) < 42) return "steady"
    }

    return null
  }

  pickNpcStageAction(runner:UmaRunner, beforeRank:number, stage:UmaStage, room:UmaRoom|null = null) {
    const race = runner.race
    if (Number(race.stamina) < 32) return pick(["slow_down", "pace", "steady"])
    if (Number(race.rhythm) < 32) return pick(["steady", "follow", "slow_down"])
    const dynamic = this.getDynamicStageAction(runner, stage, beforeRank, room)
    if (dynamic) return dynamic
    if (stage.key === "finish") return beforeRank <= 3 ? pick(["speed_up", "burst", "steady"]) : pick(["burst", "gamble", "speed_up"])
    if (stage.key === "mid") return beforeRank <= 3 ? pick(["follow", "pace", "steady"]) : pick(["inside", "speed_up", "follow"])
    return this.getDefaultStageActionForStage(runner, stage)
  }

  rankRunners(runners:UmaRunner[] = []) {
    return [...runners].sort((a, b) =>
      (b.race?.distance || b.race?.position || 0) - (a.race?.distance || a.race?.position || 0) ||
      (b.race?.velocity || 0) - (a.race?.velocity || 0)
    )
  }

  formatRaceStage(room:UmaRoom, { opening = false, includeTips = true } = {}) {
    const stage = RACE_STAGES[room.stageIndex] || RACE_STAGES[0]!
    const stageCount = `${room.stageIndex + 1}/${RACE_STAGES.length}`
    const lines = [
      opening ? "比赛开跑。" : `${stage.label}开始。`,
      this.formatTrack(room.track),
      `场地状态：${room.condition?.name || "维护良好"} - ${room.condition?.description || "赛道状态稳定。"}`,
      `复合场景：${this.formatRaceSceneName(room)}`,
      `当前阶段：${stage.label}（${stageCount}）- ${stage.prompt}`,
      room.stageIndex === 0 ? `临场变化：${room.twist.name} - ${room.twist.description}` : `赛况事件：${room.scene.name} - ${room.scene.description}`,
      "",
      "当前队形：",
      ...this.formatStageRanking(room.runners),
      ""
    ]
    if (includeTips) lines.push(this.formatRaceActionTips())
    return lines.join("\n").trim()
  }

  formatActiveRaceStatus(room:UmaRoom) {
    const stage = RACE_STAGES[room.stageIndex] || RACE_STAGES[0]!
    return [
      `这一局已经开跑了，当前是${stage.label}。`,
      `复合场景：${this.formatRaceSceneName(room)}`,
      "当前队形：",
      ...this.formatStageRanking(room.runners || []),
      "",
      this.formatRaceActionTips()
    ].join("\n")
  }

  formatStageRanking(runners:UmaRunner[] = []) {
    return this.rankRunners(runners).slice(0, RACE_SIZE).map((runner, index) =>
      `${index + 1}. ${this.formatRunnerName(runner)}｜${this.describeRunnerState(runner)}`
    )
  }

  describeRunnerState(runner:UmaRunner) {
    const race = runner?.race || {}
    const breath = race.stamina >= 86
      ? "呼吸很稳"
      : race.stamina >= 62
        ? "已经轻微喘气"
        : race.stamina >= 36
          ? "气息明显乱了"
          : "像是快被体力拖住了"
    const rhythm = race.rhythm >= 86
      ? "步点很干净"
      : race.rhythm >= 62
        ? "节奏还压得住"
        : race.rhythm >= 36
          ? "步伐有点散"
          : "节奏被拉得很碎"
    const route = race.route >= 82
      ? "贴着舒服路线"
      : race.route >= 55
        ? "还在找空档"
        : "有点被堵在外侧"
    const burst = race.burstReserve >= 78
      ? "还藏着冲刺劲"
      : race.burstReserve >= 42
        ? "余力还够再顶一下"
        : "爆发余力不多"
    return `${breath}，${rhythm}，${route}，${burst}`
  }

  async renderRaceReportOrFallback(e:UmaEvent, report:UmaReport, fallbackText:string) {
    try {
      // 懒加载渲染器:它静态依赖 Yunzai 运行时的 lib/puppeteer,非 Yunzai 环境
      // (单测/独立工具)下加载失败会落到这里的文本兜底,而不是让整个模块崩掉
      if(!ports.renderReport)throw new Error("渲染器不可用")
      const image = await ports.renderReport(e, report)
      if (!image) throw new Error("empty render result")
      return image
    } catch (error) {
      this.logger?.warn?.(`[赛马娘小游戏] 渲染比赛报告失败: ${error instanceof Error?error.message:String(error)}`)
      return fallbackText
    }
  }

  appendMessageText(message:unknown, text:string) {
    if (!text) return message
    if (typeof message === "string") return [message, `\n${text}`]
    if (Array.isArray(message)) return [...message, `\n${text}`]
    return [message, `\n${text}`]
  }

  buildStageRaceReport(room:UmaRoom, previousStage:UmaStage, lines:string[] = []) {
    const currentStage = RACE_STAGES[room.stageIndex] || RACE_STAGES[0]!
    return {
      type: "stage",
      title: `${previousStage.label}结束`,
      subtitle: `进入${currentStage.label}：${currentStage.prompt}`,
      scene: [room.track.name, room.condition?.name, room.twist.name, room.scene.name].filter(Boolean).join(" / "),
      generatedAt: this.formatReportTime(),
      prompt: "当前队形已更新，下一段可以调整跑法。",
      ranking: this.buildRaceReportRanking(room.runners),
      highlights: lines.slice(0, 5)
    }
  }

  buildOpeningRaceReport(room:UmaRoom) {
    const currentStage = RACE_STAGES[room.stageIndex] || RACE_STAGES[0]!
    return {
      type: "stage",
      title: "比赛开跑",
      subtitle: `${currentStage.label}：${currentStage.prompt}`,
      scene: [room.track.name, room.condition?.name, room.twist.name, room.scene.name].filter(Boolean).join(" / "),
      generatedAt: this.formatReportTime(),
      prompt: `复合场景：${this.formatRaceSceneName(room)}。${currentStage.prompt}`,
      ranking: this.buildRaceReportRanking(room.runners),
      highlights: [
        this.formatTrack(room.track).replace(/^本局赛道：/, "赛道："),
        `场地状态：${room.condition?.name || "维护良好"} - ${room.condition?.description || "赛道状态稳定。"}`,
        `复合场景：${this.formatRaceSceneName(room)}`,
        `临场变化：${room.twist.name} - ${room.twist.description}`
      ]
    }
  }

  buildFinalRaceReport(result:UmaRaceResult, awardLines:string[] = []) {
    return {
      type: "final",
      title: "赛马结果出炉",
      subtitle: this.formatTrack(result.track).replace(/^本局赛道：/, ""),
      scene: [result.track.name, result.condition?.name, result.twist.name, result.scene.name].filter(Boolean).join(" / "),
      generatedAt: this.formatReportTime(),
      prompt: "前三名获得全群互通积分，其余真实玩家获得参与奖。",
      ranking: this.buildRaceReportRanking(result.ranking),
      highlights: (result.highlights || []).slice(0, 5),
      awards: awardLines.length ? awardLines : ["本局无人获得积分"],
      proficiencyGains: result.proficiencyGains || []
    }
  }

  buildRaceReportRanking(runners:UmaRunner[] = []) {
    const ranked = this.rankRunners(runners).slice(0, RACE_SIZE)
    return ranked.map((runner, index) => {
      const distance = Number(runner.race?.distance ?? runner.race?.position) || 0
      const previous = index > 0 ? ranked[index - 1] : null
      const previousDistance = previous ? Number(previous.race?.distance ?? previous.race?.position) || 0 : distance
      const gapToPrevious = Math.max(0, previousDistance - distance)
      return {
        rank: index + 1,
        name: runner.umaName || runner.nickname || "无名小马",
        affix: this.normalizeUmaAffix(runner.umaAffix || runner.affix || runner),
        isNpc: !!runner.isNpc,
        gapToPrevious,
        gapText: this.formatRaceGapText(gapToPrevious, index),
        meta: [runner.traitLabel ? `特质：${runner.traitLabel}` : "", this.formatTraitAffinity(runner)].filter(Boolean).join("｜"),
        strategy: runner.strategyLabel || "正常跑",
        state: this.describeRunnerState(runner)
      }
    })
  }

  formatRaceGapText(gapToPrevious = 0, index = 0) {
    if (index === 0) return "领先"
    const meters = Math.max(0, Number(gapToPrevious) || 0)
    if (meters < 3) return "贴身"
    const bodyLengths = meters / 6
    if (bodyLengths >= 15) return "被拉开很远"
    if (bodyLengths >= 8) return `差 ${bodyLengths.toFixed(0)} 身位`
    return `差 ${bodyLengths.toFixed(1)} 身位`
  }

  formatReportTime() {
    return new Date().toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour12: false,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    })
  }

  async finishStagedRace(room:UmaRoom) {
    this.clearStageTimer(room)
    const ranking = this.rankRunners(room.runners)
    this.rooms.delete(String(room.groupId || ""))
    const config = this.getConfig()
    const awardLines = await this.applyAwards(ranking, this.getAwards(config), config)
    const proficiencyGains = await this.applyProficiencyGains(ranking, config)
    const result = {
      ranking,
      track: room.track,
      condition: room.condition,
      twist: room.twist,
      scene: room.scene,
      proficiencyGains,
      highlights: [
        ...this.buildRaceReviewLines(ranking),
        ...(room.history || []).flatMap(item => item.lines).slice(-5),
        pick(room.track.events || ["比赛结束"]).replace("{name}", ranking[0]?.nickname || "前排")
      ].slice(0, 5)
    }
    return await this.renderRaceReportOrFallback(
      room.event,
      this.buildFinalRaceReport(result, awardLines),
      [
        this.formatRaceResult(result, awardLines),
        this.formatProficiencyGainLines(proficiencyGains)
      ].filter(Boolean).join("\n\n")
    )
  }

  fillNpcPlayers(players:UmaRunner[], minPlayers:number) {
    const need = Math.max(0, Number(minPlayers) - players.length)
    const usedNames = new Set(players.map(player => player.nickname))
    const usedUmaNames = new Set(players.map(player => player.umaName || player.nickname))
    const baseTotal = this.getNpcBaseAttributeTotal(players)
    for (let index = 0; index < need; index++) {
      const name = this.pickNpcName(usedNames)
      const umaName = this.pickNpcUmaName(usedUmaNames)
      const personality = pick(["稳重可靠", "活泼开朗", "不服输", "聪明冷静", "耐心坚韧", "幸运自由"])
      const total = this.pickNpcAttributeTotal(baseTotal)
      usedNames.add(name)
      usedUmaNames.add(umaName)
      players.push({
        userId: `npc:${Date.now()}:${index}`,
        nickname: name,
        umaName,
        umaAffix: this.normalizeUmaAffix({}),
        attributes: this.generateAttributes(umaName, personality, total),
        personality,
        traitKey: this.inferPersonalityTrait(umaName, personality).key,
        traitLabel: this.inferPersonalityTrait(umaName, personality).label,
        strategyKey: pick(["normal", "steady", "burst", "conserve", "inside"]),
        isNpc: true,
        joinedAt: Date.now(),
        race:emptyUmaRaceState()
      })
    }
  }

  pickNpcName(usedNames:Set<string>) {
    const available = NPC_NAMES.filter(name => !usedNames.has(name))
    return available.length ? pick(available) : `临时选手${usedNames.size + 1}`
  }

  pickNpcUmaName(usedNames:Set<string>) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const name = `${pick(NPC_UMA_PREFIXES)}${pick(NPC_UMA_SUFFIXES)}`
      if (!usedNames.has(name)) return name
    }
    return `临时赛马娘${usedNames.size + 1}`
  }

  getNpcBaseAttributeTotal(players:UmaRunner[] = []) {
    const humans = players.filter(player => !player.isNpc && this.isValidAttributes(player.attributes))
    const totals = humans
      .map(player => this.sumAttributes(player.attributes))
      .filter(total => Number.isFinite(total) && total > 0)
    if (!totals.length) return ATTRIBUTE_TOTAL
    const average = totals.reduce((sum, total) => sum + total, 0) / totals.length
    const factor = humans.length <= 1 ? 0.82 : humans.length === 2 ? 0.88 : humans.length === 3 ? 0.94 : 1
    return average * factor
  }

  pickNpcAttributeTotal(baseTotal = ATTRIBUTE_TOTAL) {
    const min = Math.max(ATTRIBUTE_DEFS.length * 4, Math.floor(baseTotal * 0.9))
    const max = Math.max(min, Math.ceil(baseTotal * 1.1))
    return Math.floor(randomBetween(min, max + 1))
  }

  simulateRace(players:UmaRunner[], track = pick(TRACKS), twist = pick(RACE_TWISTS), scene = pick(RACE_SCENES), condition = pick(RACE_CONDITIONS)) {
    players = this.prepareRacePlayers(players)
    const room:UmaRoom = {
      starterId:"",createdAt:Date.now(),participants:new Map(),event:{},timer:null,
      groupId: "simulate",
      phase: "race",
      track,
      condition,
      twist,
      scene,
      raceProfile: this.buildRaceProfile(track, twist, scene, condition),
      stageIndex: 0,
      decisions: new Map(),
      history: [],
      runners: this.initializeStageRunners(players, track, twist, scene, condition)
    }
    for (const stage of RACE_STAGES) {
      room.stageIndex = RACE_STAGES.findIndex(item => item.key === stage.key)
      const lines = this.resolveRaceStage(room, stage)
      room.history ||= []
      room.history!.push({ stage: stage.key, lines })
    }
    const ranking = this.rankRunners(room.runners)
    const highlights = [
      ...(room.history || []).flatMap(item => item.lines).slice(-5),
      pick(track.events).replace("{name}", ranking[0]?.nickname || "前排")
    ].slice(0, 5)
    return { ranking, highlights, track, condition, twist, scene }
  }

  countStrategies(players:UmaRunner[]) {
    const counts = new Map<string,number>()
    for (const player of players) {
      const key = player.strategyKey && Object.hasOwn(STRATEGIES,player.strategyKey) ? player.strategyKey : "normal"
      counts.set(key, (counts.get(key) || 0) + 1)
    }
    return counts
  }

  getRaceTrait(player:Partial<UmaRunner> & {personality?:string} = {}) {
    return PERSONALITY_TRAITS.find(trait => trait.key === player.traitKey) ||
      this.inferPersonalityTrait(player.umaName || player.nickname || "", player.personality || "")
  }

  normalizeProficiency(proficiency:Record<string,number> = {}) {
    const normalized:Record<string,number> = {}
    for (const key of Object.keys(RACE_ACTIONS)) {
      normalized[key] = clampNumber(proficiency?.[key], 0, PROFICIENCY_MAX)
    }
    return normalized
  }

  getProficiencyLevel(value = 0) {
    const amount = clampNumber(value, 0, PROFICIENCY_MAX)
    return PROFICIENCY_LEVELS.find(level => amount >= level.min) || PROFICIENCY_LEVELS[PROFICIENCY_LEVELS.length - 1]!
  }

  getProficiencyProgress(value = 0) {
    const amount = clampNumber(value, 0, PROFICIENCY_MAX)
    const ascending = [...PROFICIENCY_LEVELS].sort((a, b) => a.min - b.min)
    let currentIndex = 0
    for (let i = 0; i < ascending.length; i++) {
      if (amount >= ascending[i]!.min) currentIndex = i
    }
    const current = ascending[currentIndex] || ascending[0]
    const next = ascending[currentIndex + 1] || null
    const target = next ? next.min : PROFICIENCY_MAX
    const base = current?.min || 0
    const span = Math.max(1, target - base)
    const progress = next
      ? clampNumber((amount - base) / span, 0, 1)
      : clampNumber(amount / PROFICIENCY_MAX, 0, 1)
    return {
      value: amount,
      level: current?.label || "生疏",
      levelIndex: currentIndex + 1,
      nextLevel: next?.label || "满值",
      target,
      need: next ? Math.max(0, target - amount) : Math.max(0, PROFICIENCY_MAX - amount),
      percent: Math.round(progress * 100)
    }
  }

  getActionProficiencyBonus(runner:Partial<UmaRunner> = {}, actionKey = "") {
    const value = Number(runner.proficiency?.[actionKey]) || 0
    return this.getProficiencyLevel(value).bonus || 0
  }

  recordActionProficiencyUse(runner:{isNpc?:boolean;race?:{actionUses?:{actionKey:string;grade:string}[]}} = {}, actionKey = "", check:Partial<UmaCheck> = {}) {
    if (!runner || runner.isNpc || !RACE_ACTIONS[actionKey]) return
    if (!runner.race) runner.race = {}
    if (!Array.isArray(runner.race.actionUses)) runner.race.actionUses = []
    runner.race.actionUses.push({
      actionKey,
      grade: check.grade || "fail"
    })
  }

  calculateProficiencyGains(runner:{race?:{actionUses?:{actionKey:string;grade:string}[]}} = {}) {
    const uses = Array.isArray(runner.race?.actionUses) ? runner.race.actionUses : []
    const actionCounts = new Map<string,number>()
    const rawGains = new Map<string,number>()
    for (const use of uses) {
      if (!RACE_ACTIONS[use.actionKey]) continue
      const count = actionCounts.get(use.actionKey) || 0
      actionCounts.set(use.actionKey, count + 1)
      const base = PROFICIENCY_REPEAT_GAINS[Math.min(count, PROFICIENCY_REPEAT_GAINS.length - 1)] || 0
      const checkGains:Readonly<Record<string,number>> = PROFICIENCY_CHECK_GAINS
      const checkGain = checkGains[use.grade] || 0
      rawGains.set(use.actionKey, (rawGains.get(use.actionKey) || 0) + base + checkGain)
    }

    const capped = [...rawGains.entries()]
      .map(([actionKey, gain]) => ({
        actionKey,
        gain: Math.min(PROFICIENCY_SINGLE_ACTION_CAP, gain)
      }))
      .filter(item => item.gain > 0)
      .sort((a, b) => b.gain - a.gain)

    let remaining = PROFICIENCY_TOTAL_RACE_CAP
    const result = []
    for (const item of capped) {
      if (remaining <= 0) break
      const gain = Math.min(item.gain, remaining)
      if (gain > 0) result.push({ actionKey: item.actionKey, gain })
      remaining -= gain
    }
    return result
  }

  getRaceTags(track:Partial<UmaScene> = {}, twist:Partial<UmaScene> = {}, scene:Partial<UmaScene> = {}, condition:Partial<UmaScene> = {}) {
    return new Set([
      ...(Array.isArray(track.tags) ? track.tags : []),
      ...(Array.isArray(condition.tags) ? condition.tags : []),
      ...(Array.isArray(twist.tags) ? twist.tags : []),
      ...(Array.isArray(scene.tags) ? scene.tags : [])
    ].filter(Boolean))
  }

  getTraitTagBonus(trait:Partial<UmaTrait> = {}, raceTags:Set<string> = new Set()) {
    let bonus = 0
    for (const tag of raceTags) {
      bonus += Number(trait.tagFit?.[tag]) || 0
    }
    return clampNumber(bonus, -4, 5)
  }

  getTraitBonus(trait:UmaTrait, strategyKey:string, raceTags:Set<string> = new Set()) {
    return (Number(trait?.fit?.[strategyKey]) || 0) + this.getTraitTagBonus(trait, raceTags)
  }

  formatTraitAffinity(runner:Partial<UmaRunner> = {}) {
    const bonus = Number(runner.traitTagBonus) || 0
    if (bonus >= 2) return "适性：契合"
    if (bonus <= -2) return "适性：吃力"
    return "适性：普通"
  }

  rollAttributeValue(attribute:number, base = 48, scale = 5) {
    return base + (Number(attribute) || 0) * scale + randomBetween(0, 18)
  }

  getStrategyCrowdPenalty(strategyKey:string, strategyCounts:Map<string,number>, totalPlayers:number) {
    const count = strategyCounts.get(strategyKey) || 0
    if (count <= 1 || totalPlayers <= 2) return 0
    const crowdedRatio = count / totalPlayers
    if (crowdedRatio < 0.45) return 0
    return randomBetween(2, Math.min(14, 2 + (count - 1) * 4))
  }

  buildRunnerEvent(name:string, strategy:{label:string;event:string}, track:UmaScene, twist:UmaScene, scene:UmaScene, details:Record<string,number|string> = {}) {
    if (Number(details.riskPenalty || 0) > 0) {
      return `${name} 选择${strategy.label}，但这次有点用力过猛，节奏被打乱了一段。`
    }
    if (Number(details.insideCrowdPenalty || 0) > 0) {
      return `${name} 选择抢内道，可这局人太多，刚进弯道就被堵了一下。`
    }
    if (Number(details.strategyCrowdPenalty || 0) > 0) {
      return `${name} 也选了${strategy.label}，但同策略的人太多，节奏互相挤在一起。`
    }
    if (Number(details.twistBonus || 0) >= 6) {
      return String(record(twist).event || "{name} 抓住了临场变化。").replace("{name}", name)
    }
    if (Number(details.twistBonus || 0) <= -6) {
      return `${name} 选择${strategy.label}，但临场变化是${twist.name}，这次有点被克到了。`
    }
    if (Number(details.sceneBonus || 0) >= 6) {
      return String(record(scene).event || "{name} 抓住了赛况变化。").replace("{name}", name)
    }
    if (Number(details.sceneBonus || 0) <= -6) {
      return `${name} 选择${strategy.label}，但赛况是${scene.name}，这次处理起来很别扭。`
    }
    if (Number(details.traitBonus || 0) >= 7) {
      return `${name} 的${details.traitLabel || "性格"}刚好适合这一局，跑法明显更顺。`
    }
    if (Math.abs(Number(details.conditionBonus || 0)) >= 4) {
      return this.formatConditionEvent(name, Number(details.conditionBonus || 0))
    }
    if (Number(details.fitBonus || 0) >= 8) {
      return `${name} 选择${strategy.label}，刚好很适合${track.name}，优势越跑越明显。`
    }
    if (Number(details.fitBonus || 0) <= -7) {
      return `${name} 选择${strategy.label}，但和${track.name}不太合拍，中段有点吃亏。`
    }
    return strategy.event.replace("{name}", name)
  }

  formatConditionEvent(name:string, conditionBonus:number) {
    const item = CONDITION_EVENTS.find(event => conditionBonus >= event.min) || CONDITION_EVENTS[CONDITION_EVENTS.length - 1]!
    return item.text.replace("{name}", name)
  }

  buildRaceHighlights(runners:UmaRunner[], track:UmaScene, twist:UmaScene, scene:UmaScene) {
    const top = runners.slice(0, Math.min(4, runners.length))
    const highlightSet = new Set<string>()
    highlightSet.add(`临场变化：${twist.name} - ${twist.description}`)
    highlightSet.add(`赛况事件：${scene.name} - ${scene.description}`)
    highlightSet.add(pick(track.events?.length ? track.events : ["{name} 保持向前。"]).replace("{name}", top[0]?.nickname || "前排"))
    for (const runner of top) {
      if (record(runner).event) highlightSet.add(String(record(runner).event))
      if (highlightSet.size >= 5) break
    }
    return [...highlightSet].slice(0, 5)
  }

  getAwards(config:UmaConfig) {
    return [config.winPoints, config.secondPoints, config.thirdPoints]
  }

  async applyProficiencyGains(ranking:UmaRunner[] = [], config = this.getConfig()) {
    const data = this.readPoints(config)
    const results = []
    for (const runner of ranking) {
      if (runner.isNpc) continue
      const gains = this.calculateProficiencyGains(runner)
      if (!gains.length) continue
      const record = data.players?.[runner.userId]
      if (!record?.uma) continue
      const proficiency = this.normalizeProficiency(record.uma.proficiency)
      const displayed = []
      for (const item of gains) {
        const before = Number(proficiency[item.actionKey]) || 0
        const after = Math.min(PROFICIENCY_MAX, before + item.gain)
        proficiency[item.actionKey] = after
        if (after > before) {
          displayed.push({
            actionKey: item.actionKey,
            label: RACE_ACTIONS[item.actionKey]?.label || item.actionKey,
            gain: after - before,
            before,
            after,
            progress: this.getProficiencyProgress(after)
          })
        }
      }
      if (!displayed.length) continue
      record.uma.proficiency = proficiency
      record.updatedAt = nowIso()
      data.players[runner.userId] = record
      results.push({
        userId: runner.userId,
        nickname: runner.nickname,
        umaName: runner.umaName || runner.nickname,
        gains: displayed.slice(0, 3)
      })
    }
    if (results.length) await this.writePoints(data, config)
    return results
  }

  formatProficiencyGainLines(entries:UmaProficiencyEntry[] = []) {
    if (!entries.length) return ""
    const lines = entries.map(entry => {
      const gains = (entry.gains || [])
        .map(item => `${item.label} +${item.gain}（${item.progress?.level || "生疏"} ${item.after}/${item.progress?.target || PROFICIENCY_MAX}）`)
        .join("，")
      return `${entry.umaName || entry.nickname}：${gains}`
    })
    return ["熟练度提升：", ...lines].join("\n")
  }

  async applyAwards(ranking:UmaRunner[], awards:number[], config:UmaConfig) {
    const data = this.readPoints(config)
    const lines:string[] = []
    ranking.forEach((runner, index) => {
      const points = awards[index] || 0
      const participationPoints = Number(config.participationPoints) || 0
      if (runner.isNpc) {
        if (points > 0) lines.push(`${index + 1}. ${runner.nickname} 是NPC，不计入积分`)
        return
      }
      const record = data.players[runner.userId] || {
        userId: runner.userId,
        nickname: runner.nickname,
        points: 0,
        wins: 0,
        races: 0,
        podiums: 0,
        updatedAt: nowIso()
      }
      record.nickname = runner.nickname
      record.races = (Number(record.races) || 0) + 1
      if (index === 0) record.wins = (Number(record.wins) || 0) + 1
      if (index <= 2) record.podiums = (Number(record.podiums) || 0) + 1
      if (points > 0) {
        record.points = (Number(record.points) || 0) + points
        lines.push(`${index + 1}. ${runner.nickname} +${points}`)
      } else if (participationPoints > 0) {
        record.points = (Number(record.points) || 0) + participationPoints
        lines.push(`${index + 1}. ${runner.nickname} 参与奖 +${participationPoints}`)
      } else {
        record.points = Number(record.points) || 0
      }
      record.updatedAt = nowIso()
      data.players[runner.userId] = record
    })
    await this.writePoints(data, config)
    return lines
  }

  formatRaceResult(result:UmaRaceResult, awardLines:string[]) {
    const rankingLines = result.ranking.slice(0, 8).map((runner, index) =>
      `${index + 1}. ${this.formatRaceRunnerName(runner)}（${runner.strategyLabel || "正常跑"}）`
    )
    return [
      "赛马结果出炉：",
      this.formatTrack(result.track),
      `场地状态：${result.condition?.name || "维护良好"} - ${result.condition?.description || "赛道状态稳定。"}`,
      `复合场景：${[result.track.name, result.condition?.name, result.twist.name, result.scene.name].filter(Boolean).join(" + ")}`,
      ...result.highlights.map(line => `- ${line}`),
      "",
      "名次：",
      ...rankingLines,
      "",
      awardLines.length ? `积分：\n${awardLines.join("\n")}` : "积分：本局无人获得积分"
    ].join("\n")
  }

  buildRaceReviewLines(ranking:UmaRunner[] = []) {
    const lines:string[] = []
    const top = ranking[0]
    if (top) {
      const action = RACE_ACTIONS[top.race?.lastActionKey||""]?.label || top.strategyLabel || "跑法"
      const distance = Math.round(Number(top.race?.lastDelta?.distance) || 0)
      lines.push(`本局关键点：${top.umaName || top.nickname} 最后一段用「${action}」稳住优势，推进约 ${distance}m。`)
    }

    const comeback = ranking
      .filter(runner => runner !== top)
      .map(runner => ({
        runner,
        delta: Number(runner.race?.lastDelta?.distance) || 0,
        action: runner.race?.lastActionKey || ""
      }))
      .sort((a, b) => b.delta - a.delta)[0]
    if (comeback?.runner && comeback.delta >= 280) {
      lines.push(`${comeback.runner.umaName || comeback.runner.nickname} 末段追回得很凶，但前面积累的差距还没完全抹平。`)
    }

    const tired = ranking.find(runner => (Number(runner.race?.stamina) || 0) < 32 || (Number(runner.race?.rhythm) || 0) < 32)
    if (tired) {
      lines.push(`${tired.umaName || tired.nickname} 后段状态被拖住，体力或节奏成了主要问题。`)
    }

    return lines.slice(0, 3)
  }

  formatRunnerName(runner:UmaRunner) {
    return this.formatRaceRunnerName(runner)
  }

  showScore(e:UmaEvent) {
    const userId = String(e?.user_id || e?.sender?.user_id || "")
    if (!userId) return "没拿到你的 QQ 号。"
    const data = this.readPoints()
    const record = data.players[userId]
    if (!record) return "你还没有赛马积分。"
    return [
      `${record.nickname || userId} 的赛马积分：${Number(record.points) || 0}`,
      `胜场：${Number(record.wins) || 0}，参赛：${Number(record.races) || 0}，前三：${Number(record.podiums) || 0}`
    ].join("\n")
  }

  parseScoreAdjustInput(msg = "") {
    const text = String(msg || "")
      .replace(/^[.。]赛马娘\s*(加积分|改积分|调整积分)\s*/u, "")
      .trim()
    const qq = text.match(/\b\d{5,12}\b/)?.[0]
    const numberMatches = [...text.matchAll(/[+-]?\d+/g)].map(match => match[0])
    const amountText = numberMatches.find(value => value !== qq)
    const amount = Number(amountText)
    if (!qq || !Number.isFinite(amount)) return null
    return { userId: qq, amount }
  }

  async adjustScore(e:UmaEvent) {
    if (!e?.isMaster) return "只有主人可以调整赛马娘积分。"
    const parsed = this.parseScoreAdjustInput(e?.msg)
    if (!parsed) {
      return [
        "格式：.赛马娘 加积分 QQ 分数",
        "例：.赛马娘 加积分 123456789 10",
        "扣分也可以用负数：.赛马娘 加积分 123456789 -5"
      ].join("\n")
    }

    const config = this.getConfig()
    const data = this.readPoints(config)
    const existing = data.players?.[parsed.userId]
    const before = Number(existing?.points) || 0
    const after = before + parsed.amount
    const record = existing || {
      userId: parsed.userId,
      nickname: parsed.userId,
      points: 0,
      wins: 0,
      races: 0,
      podiums: 0,
      updatedAt: nowIso()
    }

    record.points = after
    record.updatedAt = nowIso()
    data.players[parsed.userId] = record
    await this.writePoints(data, config)

    return [
      "赛马娘积分已调整。",
      `QQ：${parsed.userId}`,
      `变动：${parsed.amount >= 0 ? "+" : ""}${parsed.amount}`,
      `积分：${before} -> ${after}`
    ].join("\n")
  }

  showRank(limit:unknown) {
    const config = this.getConfig()
    const finalLimit = safeNumber(limit, config.rankLimit, 3, 50)
    const data = this.readPoints(config)
    const ranking = Object.values(data.players || {})
      .sort((a, b) => (Number(b.points) || 0) - (Number(a.points) || 0) || (Number(b.wins) || 0) - (Number(a.wins) || 0))
      .slice(0, finalLimit)

    if (!ranking.length) return "现在还没有赛马积分排行。"
    return [
      "赛马积分排行：",
      ...ranking.map((item, index) =>
        `${index + 1}. ${item.nickname || item.userId}：${Number(item.points) || 0} 分 / ${Number(item.wins) || 0} 胜`
      )
    ].join("\n")
  }

  showHelp() {
    return [
      "赛马娘小游戏：",
      ".赛马娘 领养 名字 性格描述 - 创建自己的赛马娘",
      ".赛马娘 我的赛马娘 - 查看六维属性",
      ".赛马娘 弃养 - 删除当前小马档案，保留积分",
      ".赛马娘 训练 - 进入训练页面",
      ".赛马娘 词条 - 查看当前词条",
      ".赛马娘 重铸 - 消耗积分立即重铸词条，不能反悔",
      ".赛马娘 词条池 - 查看所有词条品级",
      ".赛马娘 开始 - 开一局",
      ".赛马娘 加入 [策略] - 报名，可选策略",
      "策略：稳一点 / 拼一把 / 留体力 / 抢内道；不填就是正常跑",
      ".赛马娘 开跑 - 开始三段比赛",
      ".赛马娘 决策 [行动] - 每个阶段调整一次跑法，也可用 .赛马娘 策略 [行动]",
      "行动：提速 / 减速 / 稳住 / 抢位 / 爆发 / 赌一把 / 跟跑 / 压节奏",
      ".赛马娘 积分 - 查看自己的全群互通积分",
      ".赛马娘 排行 - 查看全局排行"
    ].join("\n")
  }
}

return {UmaRaceManager}
}
