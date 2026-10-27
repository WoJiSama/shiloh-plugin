import {
  buildExpressionObservation,
  buildExpressionSequenceSample,
  classifyExpressionRhythm
} from "../domain/expressionSequence.js"

import type { ExpressionObservation, ExpressionMetadata } from '../domain/expressionSequence.js'
interface Style { situation: string; expressions: string[]; count?: number }
interface Rhythm { situation: string; layout: string; rule: string; count?: number }
interface Sequence { at: number; layout: string; sample: string }
interface ExpressionData { words: Record<string, number>; patterns: string[]; emojis: Record<string, number>; messageCount: number; styleExpressions: Style[]; rhythmPatterns: Record<string, number>; rhythmStyles: Rhythm[]; sequenceSamples: Sequence[]; lastAiLearnTime: number; lastUpdate: number }
interface Config { minWordFrequency?: number; maxWords?: number; blockedWords?: string[]; aiLearningEnabled?: boolean; aiLearningMessageThreshold?: number; memoryAiConfig?: { memoryAiUrl?: string; memoryAiModel?: string; memoryAiApikey?: string } | null; sequenceWindowMs?: number; maxSequenceTurns?: number; maxSequenceSamples?: number }
export interface ExpressionPorts { store: { get(key: string): Promise<string | null>; set(key: string, value: string, options: { EX: number }): Promise<unknown> }; logger: { error(message: string): void; info(message: string): void }; fetch: typeof fetch }
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function numericMap(value: unknown): Record<string, number> { return Object.fromEntries(Object.entries(object(value)).filter((entry): entry is [string,number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]))) }
function rows(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map(object) : [] }
function styles(value: unknown): Style[] { return rows(value).filter(item => typeof item.situation === 'string' && Array.isArray(item.expressions) && item.expressions.every(entry => typeof entry === 'string')).map(item => ({ situation: String(item.situation), expressions: (item.expressions as string[]), count: Number(item.count) || 0 })) }
function rhythms(value: unknown): Rhythm[] { return rows(value).filter(item => typeof item.situation === 'string' && typeof item.layout === 'string' && typeof item.rule === 'string').map(item => ({ situation: String(item.situation), layout: String(item.layout), rule: String(item.rule), count: Number(item.count) || 0 })) }
const DEFAULT_RHYTHM_PATTERNS = Object.freeze({
  single: 0,
  twoBeat: 0,
  multiBeat: 0,
  emojiOnly: 0,
  textEmoji: 0,
  emojiText: 0,
  textEmojiText: 0,
  mixedTwoBeat: 0,
  mixedMultiBeat: 0
})

const RHYTHM_LAYOUTS = new Set(Object.keys(DEFAULT_RHYTHM_PATTERNS))

function emptyExpressions(): ExpressionData {
  return {
    words: {},
    patterns: [],
    emojis: {},
    messageCount: 0,
    styleExpressions: [],
    rhythmPatterns: { ...DEFAULT_RHYTHM_PATTERNS },
    rhythmStyles: [],
    sequenceSamples: [],
    lastAiLearnTime: 0,
    lastUpdate: Date.now()
  }
}

export function normalizeExpressionData(value: unknown = {}): ExpressionData {
  const base = emptyExpressions()
  const raw = object(value)
  return {
    ...base,
    messageCount: Number(raw.messageCount) || 0,
    lastAiLearnTime: Number(raw.lastAiLearnTime) || 0,
    lastUpdate: Number(raw.lastUpdate) || Date.now(),
    words: numericMap(raw.words),
    patterns: Array.isArray(raw.patterns) ? raw.patterns.filter((item): item is string => typeof item === "string") : [],
    emojis: numericMap(raw.emojis),
    styleExpressions: styles(raw.styleExpressions),
    rhythmPatterns: {
      ...DEFAULT_RHYTHM_PATTERNS,
      ...numericMap(raw.rhythmPatterns)
    },
    rhythmStyles: rhythms(raw.rhythmStyles),
    sequenceSamples: rows(raw.sequenceSamples).filter(item => typeof item.sample === 'string' && typeof item.layout === 'string').map(item => ({ sample: String(item.sample), layout: String(item.layout), at: Number(item.at) || 0 }))
  }
}

function normalizeAiLearningResult(value: unknown) {
 const raw = object(value)
 return { expressions: styles(Array.isArray(value) ? value : raw.expressions), rhythms: rhythms(raw.rhythms) }
}

function parseAiJson(content = ""): unknown {
  const raw = String(content || "").trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    const objectStart = raw.indexOf("{")
    const objectEnd = raw.lastIndexOf("}")
    if (objectStart >= 0 && objectEnd > objectStart) {
      try { return JSON.parse(raw.slice(objectStart, objectEnd + 1)) } catch {}
    }
    const arrayStart = raw.indexOf("[")
    const arrayEnd = raw.lastIndexOf("]")
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      return JSON.parse(raw.slice(arrayStart, arrayEnd + 1))
    }
    throw new Error("AI 表达学习结果不是有效 JSON")
  }
}

function rhythmLabel(layout = "") {
  const labels: Record<string, string> = {
    single: "完整单条",
    twoBeat: "短反应→独立补话",
    multiBeat: "连续多条文字",
    emojiOnly: "纯表情包",
    textEmoji: "文字→表情包",
    emojiText: "表情包→补话",
    textEmojiText: "短反应→表情包→补话",
    mixedTwoBeat: "两段混合回复",
    mixedMultiBeat: "多段混合回复"
  }; return labels[layout] || layout
}

/**
 * 学习群友的说话风格和整轮回复节奏。
 */
export function createExpressionLearnerClass(ports: ExpressionPorts) {
class ExpressionLearner {
 REDIS_PREFIX: string; config: Required<Config>; commonWords: Set<string>; sensitiveWords: Set<string>;
 messageCounters = new Map<string, number>(); pendingMessages = new Map<string, string[]>(); messageBuffers = new Map<string, ExpressionObservation[]>(); pendingSequences = new Map<string, Sequence[]>(); speakerSequences = new Map<string, { at: number; messageId: string; items: ExpressionObservation[] }>(); lastGroupSpeaker = new Map<string, string>(); updateQueues = new Map<string, Promise<void>>();
  constructor(config: Config = {}) {
    this.REDIS_PREFIX = "ytbot:expression:"
    this.config = {
      minWordFrequency: config.minWordFrequency || 3,
      maxWords: config.maxWords || 50,
      blockedWords: config.blockedWords || [],
      aiLearningEnabled: config.aiLearningEnabled !== false,
      aiLearningMessageThreshold: config.aiLearningMessageThreshold || 50,
      memoryAiConfig: config.memoryAiConfig || null,
      sequenceWindowMs: config.sequenceWindowMs || 20000,
      maxSequenceTurns: config.maxSequenceTurns || 3,
      maxSequenceSamples: config.maxSequenceSamples || 30
    }

    this.commonWords = new Set([
      "的", "是", "了", "在", "我", "你", "他", "她", "它", "们",
      "有", "和", "与", "这", "那", "就", "也", "都", "而", "及",
      "着", "或", "一个", "没有", "不是", "什么", "怎么", "为什么",
      "可以", "能", "会", "要", "想", "去", "来", "到", "从", "把",
      "被", "让", "给", "对", "说", "看", "做", "用", "很", "太",
      "吗", "呢", "吧", "啊", "哦", "嗯", "呀", "哈", "嘿", "哎",
      "好", "行", "对", "是的", "不", "没", "别", "请", "谢谢",
      "qq", "member", "admin", "owner", "id",
      "消息", "群身份", "在群里", "群里说", "回复了", "艾特了",
      "发送了", "一张图片", "张图片", "表情", "发送了表情"
    ])
    this.sensitiveWords = new Set(this.config.blockedWords)
  }

  getRedisKey(groupId: string) {
    return `${this.REDIS_PREFIX}${groupId}`
  }

  async getGroupExpressions(groupId: string) {
    try {
      const data = await ports.store.get(this.getRedisKey(groupId))
      return data ? normalizeExpressionData(JSON.parse(data)) : emptyExpressions()
    } catch (error) {
      ports.logger.error(`[表达学习] 获取表达特征失败: ${error}`)
      return emptyExpressions()
    }
  }

  async saveGroupExpressions(groupId: string, expressions: ExpressionData) {
    try {
      const normalized = normalizeExpressionData(expressions)
      normalized.lastUpdate = Date.now()
      await ports.store.set(this.getRedisKey(groupId), JSON.stringify(normalized), { EX: 30 * 24 * 60 * 60 })
    } catch (error) {
      ports.logger.error(`[表达学习] 保存表达特征失败: ${error}`)
    }
  }

  extractWords(content: string) {
    if (!content || typeof content !== "string") return []
    let text = content.replace(/https?:\/\/[^\s]+/g, "").replace(/@[^\s]+/g, "").replace(/\[CQ:[^\]]+\]/g, "")
    const words = [
      ...(text.match(/[\u4e00-\u9fa5]{2,6}/g) || []),
      ...(text.match(/[a-zA-Z]{2,10}/gi) || []).map(word => word.toLowerCase()),
      ...(text.match(/[a-zA-Z0-9]{2,6}/gi) || []).map(word => word.toLowerCase())
    ]
    return words.filter(word => !this.commonWords.has(word) && !this.sensitiveWords.has(word) && !/^\d+$/.test(word) && word.length >= 2)
  }

  extractEmojis(content: string) {
    if (!content) return []
    return content.match(/[\u{1F300}-\u{1F9FF}]|[\u{2600}-\u{26FF}]|[\u{2700}-\u{27BF}]/gu) || []
  }

  extractPatterns(content: string) {
    if (!content) return []
    const patterns = []
    if (content.includes("...")) patterns.push("...")
    if (/吧$/.test(content)) patterns.push("...吧")
    if (/啊$/.test(content)) patterns.push("...啊")
    if (/呢$/.test(content)) patterns.push("...呢")
    if (/哈哈+/.test(content)) patterns.push("哈哈")
    if (/笑死/.test(content)) patterns.push("笑死")
    if (/啊这/.test(content)) patterns.push("啊这")
    if (/无语/.test(content)) patterns.push("无语")
    if (/绝了/.test(content)) patterns.push("绝了")
    if (/真的假的/.test(content)) patterns.push("真的假的")
    if (/确实/.test(content)) patterns.push("确实")
    if (/属于是/.test(content)) patterns.push("属于是")
    return patterns
  }

  updateGroupExpressions(groupId: string|number, content: string, metadata: ExpressionMetadata = {}) {
    const key = String(groupId || "")
    if (!key) return Promise.resolve()
    return this.enqueueGroupUpdate(key, () => this._updateGroupExpressions(key, content, metadata))
  }

  enqueueGroupUpdate(groupId: string, operation: () => Promise<void>) {
    const key = String(groupId || "")
    const previous = this.updateQueues.get(key) || Promise.resolve()
    const task = previous.catch(() => {}).then(operation)
    const tracked = task.finally(() => {
      if (this.updateQueues.get(key) === tracked) this.updateQueues.delete(key)
    })
    this.updateQueues.set(key, tracked)
    return tracked
  }

  observeSpeakerSequence(groupId: string, observation: ExpressionObservation) {
    if (!observation?.userId) return null
    const lastSpeaker = this.lastGroupSpeaker.get(groupId)
    const key = `${groupId}:${observation.userId}`
    if (lastSpeaker && lastSpeaker !== observation.userId) this.speakerSequences.delete(key)
    this.lastGroupSpeaker.set(groupId, observation.userId)

    const previous = this.speakerSequences.get(key)
    const withinWindow = previous && observation.at - previous.at <= Number(this.config.sequenceWindowMs || 20000)
    const differentMessage = !observation.messageId || !previous?.messageId || observation.messageId !== previous.messageId
    const items = withinWindow && differentMessage
      ? [...previous.items, observation].slice(-Math.max(2, Number(this.config.maxSequenceTurns) || 3))
      : [observation]
    this.speakerSequences.set(key, { at: observation.at, messageId: observation.messageId, items })
    if (items.length < 2) return null
    return {
      at: observation.at,
      layout: classifyExpressionRhythm(items),
      sample: buildExpressionSequenceSample(items)
    }
  }

  async _updateGroupExpressions(groupId: string, content: string, metadata: ExpressionMetadata) {
    try {
      const observation = buildExpressionObservation(content, metadata)
      if (!observation) return
      const nextCounter = (this.messageCounters.get(groupId) || 0) + 1
      this.messageCounters.set(groupId, nextCounter)

      const buffer = this.messageBuffers.get(groupId) || []
      buffer.push(observation)
      this.messageBuffers.set(groupId, buffer.slice(-50))

      const sequence = this.observeSpeakerSequence(groupId, observation)
      if (sequence) {
        const sequences = this.pendingSequences.get(groupId) || []
        sequences.push(sequence)
        this.pendingSequences.set(groupId, sequences)
      }

      if (this.config.aiLearningEnabled) {
        const pending = this.pendingMessages.get(groupId) || []
        pending.push(observation.sample)
        if (sequence?.sample) pending.push(sequence.sample)
        this.pendingMessages.set(groupId, pending.slice(-Math.max(1, Number(this.config.aiLearningMessageThreshold) || 50)))
      }

      if (nextCounter % 5 === 0 || sequence) await this.flushGroupObservations(groupId)

      if (this.config.aiLearningEnabled && this.config.memoryAiConfig) {
        const pending = this.pendingMessages.get(groupId) || []
        if (pending.length >= Number(this.config.aiLearningMessageThreshold || 50)) {
          this.pendingMessages.set(groupId, [])
          this.learnStyleWithAI(groupId, [...pending]).catch(error => {
            ports.logger.error(`[ExpressionLearner] AI 风格学习失败: ${error}`)
          })
        }
      }
    } catch (error) {
      ports.logger.error(`[ExpressionLearner] 更新群表达习惯失败: ${error}`)
    }
  }

  async flushGroupObservations(groupId: string) {
    const buffer = this.messageBuffers.get(groupId) || []
    const sequences = this.pendingSequences.get(groupId) || []
    if (!buffer.length && !sequences.length) return
    this.messageBuffers.set(groupId, [])
    this.pendingSequences.set(groupId, [])

    const expressions = await this.getGroupExpressions(groupId)
    expressions.messageCount = (Number(expressions.messageCount) || 0) + buffer.length
    for (const observation of buffer) {
      expressions.rhythmPatterns.single = (expressions.rhythmPatterns.single || 0) + 1
      if (observation.hasEmojiPack && !observation.text) expressions.rhythmPatterns.emojiOnly = (expressions.rhythmPatterns.emojiOnly || 0) + 1
      for (const word of this.extractWords(observation.text)) expressions.words[word] = (expressions.words[word] || 0) + 1
      for (const emoji of this.extractEmojis(observation.text)) expressions.emojis[emoji] = (expressions.emojis[emoji] || 0) + 1
      for (const pattern of this.extractPatterns(observation.text)) {
        if (!expressions.patterns.includes(pattern)) expressions.patterns.push(pattern)
      }
    }
    for (const sequence of sequences) {
      if (RHYTHM_LAYOUTS.has(sequence.layout)) expressions.rhythmPatterns[sequence.layout] = (expressions.rhythmPatterns[sequence.layout] || 0) + 1
      expressions.sequenceSamples = [
        { at: sequence.at, layout: sequence.layout, sample: sequence.sample },
        ...expressions.sequenceSamples.filter(item => item?.sample !== sequence.sample)
      ].slice(0, Math.max(5, Number(this.config.maxSequenceSamples) || 30))
    }

    if (Object.keys(expressions.words).length > this.config.maxWords * 2) {
      expressions.words = Object.fromEntries(Object.entries(expressions.words)
        .sort((a, b) => b[1] - a[1]).slice(0, this.config.maxWords))
    }
    if (Object.keys(expressions.emojis).length > 20) {
      expressions.emojis = Object.fromEntries(Object.entries(expressions.emojis)
        .sort((a, b) => b[1] - a[1]).slice(0, 20))
    }
    await this.saveGroupExpressions(groupId, expressions)
  }

  /**
   * 群级表情布局统计：裸表情 vs 带文字的占比，供发送编排自适应
   * （观察到的节奏驱动行为：某群习惯纯图，强制反应就少配文）。
   */
  async getGroupEmojiLayoutStats(groupId: string) {
    try {
      const expressions = await this.getGroupExpressions(groupId)
      const rhythm = expressions?.rhythmPatterns || {}
      const emojiOnly = Number(rhythm.emojiOnly) || 0
      const withText = (Number(rhythm.textEmoji) || 0) +
        (Number(rhythm.emojiText) || 0) +
        (Number(rhythm.textEmojiText) || 0)
      const samples = emojiOnly + withText
      if (!samples) return null
      return { samples, emojiOnlyShare: emojiOnly / samples, emojiOnly, withText }
    } catch {
      return null
    }
  }

  async learnStyleWithAI(groupId: string, messages: (string | ExpressionObservation)[]) {
    const { memoryAiUrl, memoryAiModel, memoryAiApikey } = this.config.memoryAiConfig || {}
    if (!memoryAiUrl || !memoryAiApikey) return
    try {
      const messageSample = messages
        .map(item => typeof item === "string" ? item : item?.sample)
        .filter(item => item && item.length > 1 && item.length < 400)
        .slice(-100)
        .join("\n")
      if (!messageSample) return

      const response = await ports.fetch(memoryAiUrl, {
        method: "POST",
        headers: { Authorization: `Bearer ${memoryAiApikey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: memoryAiModel || "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `分析群聊样本，分别提取特色表达和整轮消息节奏。\n\n样本中的 [下一条] 表示同一人短时间内继续发送下一条，[表情包] 表示该位置使用表情包。学习单条/多条以及表情包的位置和作用，不要照抄样本内容。\n\n只输出严格 JSON：\n{"expressions":[{"situation":"表示赞叹","expressions":["绝绝子"]}],"rhythms":[{"situation":"轻松接梗","layout":"textEmojiText","rule":"先短反应，表情承担情绪，最后才补独立信息"}]}\n\nlayout 只能是 single、twoBeat、multiBeat、emojiOnly、textEmoji、emojiText、textEmojiText、mixedTwoBeat、mixedMultiBeat。\n最多 5 个表达场景和 4 个节奏规则。没有规律的字段返回空数组。默认完整单条，不要因为出现多消息样本就总结成每次都拆分；技术、严肃、事实查询优先完整文字。只提取真实规律，不学习辱骂、阴阳怪气和客服腔。`
            },
            { role: "user", content: `群聊消息样本：\n${messageSample}` }
          ],
          temperature: 0.3,
          max_tokens: 700
        })
      })
      if (!response.ok) {
        ports.logger.error(`[表达学习] AI 请求失败: ${response.status}`)
        return
      }
      const data = object(await response.json())
      const parsed = normalizeAiLearningResult(parseAiJson(String(object(object(Array.isArray(data.choices) ? data.choices[0] : null).message).content || "")))
      if (!parsed.expressions.length && !parsed.rhythms.length) return
      await this.enqueueGroupUpdate(groupId, async () => {
        const expressions = await this.getGroupExpressions(groupId)
        this.mergeStyleExpressions(expressions, parsed.expressions)
        this.mergeRhythmStyles(expressions, parsed.rhythms)
        expressions.lastAiLearnTime = Date.now()
        await this.saveGroupExpressions(groupId, expressions)
      })
      ports.logger.info(`[表达学习] 群${groupId} AI 学习完成，表达${parsed.expressions.length}个，节奏${parsed.rhythms.length}个`)
    } catch (error) {
      ports.logger.error(`[表达学习] AI 学习失败: ${error}`)
    }
  }

  mergeStyleExpressions(expressions: ExpressionData, results: Style[] = []) {
    const existing = expressions.styleExpressions || []
    for (const item of results) {
      if (!item?.situation || !Array.isArray(item.expressions) || !item.expressions.length) continue
      const found = existing.find(style => style.situation === item.situation)
      if (found) {
        found.expressions = [...new Set([...(found.expressions || []), ...item.expressions])].slice(0, 6)
        found.count = (Number(found.count) || 0) + 1
      } else {
        existing.push({ situation: String(item.situation).slice(0, 20), expressions: item.expressions.slice(0, 6), count: 1 })
      }
    }
    expressions.styleExpressions = existing.sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 10)
  }

  mergeRhythmStyles(expressions: ExpressionData, results: Rhythm[] = []) {
    const existing = expressions.rhythmStyles || []
    for (const item of results) {
      const layout = String(item?.layout || "")
      const situation = String(item?.situation || "").trim().slice(0, 20)
      const rule = String(item?.rule || "").trim().slice(0, 100)
      if (!RHYTHM_LAYOUTS.has(layout) || !situation || !rule) continue
      const found = existing.find(style => style.situation === situation && style.layout === layout)
      if (found) {
        found.rule = rule
        found.count = (Number(found.count) || 0) + 1
      } else {
        existing.push({ situation, layout, rule, count: 1 })
      }
    }
    expressions.rhythmStyles = existing.sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, 10)
  }

  formatExpressionPrompt(input: unknown) {
    const expressions = normalizeExpressionData(input)
    const prompts = []
    if (expressions.styleExpressions.length) {
      const lines = expressions.styleExpressions.slice(0, 5)
        .map(style => `- ${style.situation}时，群友常说${(style.expressions || []).map(item => `"${item}"`).join("、")}`)
      prompts.push(`【群聊表达风格】\n${lines.join("\n")}`)
    } else {
      const words = Object.entries(expressions.words).filter(([, count]) => count >= this.config.minWordFrequency)
        .sort((a, b) => b[1] - a[1]).slice(0, 10).map(([word]) => word)
      if (words.length) prompts.push(`【群里常用词】${words.join("、")}`)
      if (expressions.patterns.length) prompts.push(`【常见句式】${expressions.patterns.slice(0, 5).join("、")}`)
    }

    const learnedRhythms = expressions.rhythmStyles.slice(0, 4)
      .map(style => `- ${style.situation}可用“${rhythmLabel(style.layout)}”：${style.rule}`)
    const observedLayouts = Object.entries(expressions.rhythmPatterns)
      .filter(([layout, count]) => layout !== "single" && Number(count) > 0)
      .sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 3)
      .map(([layout]) => rhythmLabel(layout))
    if (learnedRhythms.length || observedLayouts.length) {
      prompts.push([
        "【整轮回复节奏】",
        "- 表情包也是对话形态之一；按语境在纯文字、纯表情包、文字与表情包混合中选择，不必每次配文字。",
        "- 默认用一条完整自然的话。只有短反应与后续信息彼此独立时才分两条；表情包必须占完整语义位置，不能插进未完成句子。",
        "- 严肃、技术、事实查询优先完整单条；不要因为学到多条样本就每轮拆分或刷屏。",
        ...(observedLayouts.length ? [`- 群内观察到的整轮形态包括：${observedLayouts.join("、")}；只在当前语境确实匹配时参考。`] : []),
        ...learnedRhythms
      ].join("\n"))
    }

    const topEmojis = Object.entries(expressions.emojis).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([emoji]) => emoji)
    if (topEmojis.length) prompts.push(`【常用表情】${topEmojis.join("")}`)
    if (prompts.length) prompts.push("适当吸收这些表达习惯，但不要照抄、堆砌或过拟合单个群友")
    return prompts.join("\n")
  }

  /** 控制台风设学习视图：原始数据（常用词/句式/场景表达/节奏计数），不改学习状态 */
  async getGroupExpressionsSnapshot(groupId: string) {
    const expressions = normalizeExpressionData(await this.getGroupExpressions(groupId))
    const words = Object.entries(expressions.words)
      .filter(([, count]) => Number(count) >= this.config.minWordFrequency)
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .slice(0, 15)
      .map(([word, count]) => ({ word, count: Number(count) }))
    return {
      words,
      patterns: (expressions.patterns || []).slice(0, 8),
      styleExpressions: (expressions.styleExpressions || []).slice(0, 6).map(style => ({ situation: style.situation, expressions: (style.expressions || []).slice(0, 5) })),
      rhythmPatterns: Object.entries(expressions.rhythmPatterns || {}).map(([layout, count]) => ({ layout, count: Number(count) })),
    }
  }

  async getExpressionPromptForGroup(groupId: string) {
    return this.formatExpressionPrompt(await this.getGroupExpressions(groupId))
  }

  addBlockedWords(words: string[]) {
    for (const word of words) this.sensitiveWords.add(word)
  }
}

return ExpressionLearner
}
