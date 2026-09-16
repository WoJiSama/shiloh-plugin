import fs from "fs"
import path from "path"
import { safeTruncateUnicode } from "../../utils/unicodeText.js"
import { buildExpressionObservation } from "../../utils/expressionSequence.js"

const DEFAULT_CONFIG = {
  enabled: true,
  promptInjectionEnabled: true,
  baseDir: "data/global_style_learning",
  maxPromptRules: 6,
  minSamplesForPrompt: 80,
  flushIntervalMs: 60000,
  maxRecentSignals: 80,
  aiSummaryEnabled: true,
  summarySampleLimit: 40,
  maxAiRules: 6,
  summaryTimeoutMs: 30000,
  summaryMaxTokens: 2400,
  summaryRetryMaxTokens: 4000,
  summaryRetryTimeoutMs: 60000,
  summaryRetrySampleLimit: 20,
  autoSummaryEnabled: true,
  autoSummaryMinNewSamples: 300,
  autoSummaryCooldownHours: 12,
  autoSummaryFailureCooldownMinutes: 30,
  autoSummaryMinTotalSamples: 120,
  sequenceWindowMs: 20000,
  maxSequenceTurns: 3,
  semanticRecallEnabled: true,
  semanticSampleLimit: 240,
  semanticMinSamples: 6,
  semanticPromptExamples: 1,
  semanticSimilarityThreshold: 0.68,
  semanticMinMargin: 0.08,
  semanticEmbedTimeoutMs: 1200,
  semanticQueryCacheMinutes: 10,
  semanticSchemaVersion: 2,
  semanticBackfillRetrySeconds: 75,
  semanticFeedbackWeight: 4,
  autoEvolutionEnabled: true,
  autoEvolutionOutcomeWindowMinutes: 12,
  autoEvolutionMinEvidence: 6,
  autoEvolutionMinUniqueUsers: 2,
  autoEvolutionMinPositiveRatio: 0.75,
  autoEvolutionShadowEvidence: 3,
  autoEvolutionDemoteRatio: 0.5,
  autoEvolutionActiveWeight: 3,
  autoEvolutionMaxCandidates: 60
}

const TONE_WORDS = ["草", "笑死", "绷", "啊？", "诶", "确实", "离谱", "好吧", "不是", "哈哈", "呃", "唔"]

const ESSENCE_RULES = [
  {
    key: "short_first",
    label: "先短后补",
    rule: "回复先给短句结论，再按需要补一句，不要上来铺太长。",
    pattern: text => [...text].length <= 28 && !/[。！？!?]\s*.*[。！？!?]\s*.*[。！？!?]/.test(text)
  },
  {
    key: "catch_emotion",
    label: "先接情绪",
    rule: "用户带情绪或玩笑时，先接住情绪，再回答实际内容。",
    pattern: text => /草|笑死|绷|离谱|啊？|真的假的|无语|麻了/.test(text)
  },
  {
    key: "direct_question",
    label: "问题直答",
    rule: "遇到明确问题先直接回答，不要先讲一堆背景。",
    pattern: text => /[?？]|怎么|为什么|咋|如何|能不能|可以吗|是不是/.test(text) && [...text].length <= 80
  },
  {
    key: "soft_boundary",
    label: "边界柔和",
    rule: "需要拒绝或设边界时，不要冷冰冰说不能；先承认意图，再给替代方向。",
    pattern: text => /不行|不能|别|不要|算了|换个|可以换|不太适合/.test(text)
  },
  {
    key: "light_humor",
    label: "轻微接梗",
    rule: "可以轻轻接梗，但不要把攻击性、阴阳怪气学成希洛的稳定语气。",
    pattern: text => /哈哈|笑死|乐|绷|草/.test(text) && !/(你妈|傻逼|弱智|死|爹|滚)/.test(text)
  },
  {
    key: "explain_compact",
    label: "解释收紧",
    rule: "解释复杂事情时按“结论-原因-下一步”组织，少用首先其次总结。",
    pattern: text => /结论|原因|所以|因为|简单说|换句话/.test(text)
  },
  {
    key: "multi_message_rhythm",
    label: "整轮消息节奏",
    rule: "学习整轮而非单句：默认一条；短反应加独立补话可分两条；表情包只占一个有明确作用的位置，不要每轮都拆分。",
    pattern: text => /\[下一条\]|\[表情包\]/.test(text)
  }
]

const DROSS_RULES = [
  {
    key: "aggressive_attack",
    label: "攻击性表达",
    rule: "不要吸收人身攻击、辱骂、带节奏话术。",
    pattern: /你妈|傻逼|弱智|死装|爹妈|滚|废物|脑残/
  },
  {
    key: "customer_tone",
    label: "客服腔",
    rule: "避免客服腔、汇报腔、说明书腔。",
    pattern: /很抱歉|请您|建议您|感谢您的|为您服务|我来为您/
  },
  {
    key: "hard_refusal",
    label: "强硬拒绝",
    rule: "不要直接甩“我不能/无法协助”，先接意图再给替代。",
    pattern: /我不能|我无法|无法协助|不能满足|拒绝请求/
  },
  {
    key: "self_doubt",
    label: "自我怀疑尾巴",
    rule: "不要在结尾自我评价“我是不是太啰嗦/说多了”。",
    pattern: /是不是太啰嗦|说多了|扯远了|有点话多/
  },
  {
    key: "preachy",
    label: "讲大道理",
    rule: "避免无请求时突然讲大道理或长篇说教。",
    pattern: /我们应该|大家都要|从本质上来说|这告诉我们|综上所述/
  },
  {
    key: "antagonistic_flirting",
    label: "批评时顶嘴调情",
    rule: "用户在批评、纠正或表达不舒服时，不要顶嘴、抬杠、调情或用挑衅表情。",
    pattern: /你别教我做事|别气嘛|不跟你犟|你舍得嘛|凭啥|想得美|😋|❤/
  }
]

function nowIso() {
  return new Date().toISOString()
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function safeNumber(value, fallback, min, max) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(max, Math.max(min, num))
}

function normalizeConfig(config = {}) {
  const normalized = {
    ...DEFAULT_CONFIG,
    ...config,
    enabled: config.enabled !== false,
    promptInjectionEnabled: config.promptInjectionEnabled !== false,
    maxPromptRules: safeNumber(config.maxPromptRules, DEFAULT_CONFIG.maxPromptRules, 1, 12),
    minSamplesForPrompt: safeNumber(config.minSamplesForPrompt, DEFAULT_CONFIG.minSamplesForPrompt, 10, 100000),
    flushIntervalMs: safeNumber(config.flushIntervalMs, DEFAULT_CONFIG.flushIntervalMs, 5000, 600000),
    maxRecentSignals: safeNumber(config.maxRecentSignals, DEFAULT_CONFIG.maxRecentSignals, 10, 500),
    aiSummaryEnabled: config.aiSummaryEnabled !== false,
    summarySampleLimit: safeNumber(config.summarySampleLimit, DEFAULT_CONFIG.summarySampleLimit, 10, 120),
    maxAiRules: safeNumber(config.maxAiRules, DEFAULT_CONFIG.maxAiRules, 1, 12),
    summaryTimeoutMs: safeNumber(config.summaryTimeoutMs, DEFAULT_CONFIG.summaryTimeoutMs, 5000, 120000),
    summaryMaxTokens: safeNumber(config.summaryMaxTokens, DEFAULT_CONFIG.summaryMaxTokens, 900, 16000),
    summaryRetryMaxTokens: safeNumber(config.summaryRetryMaxTokens, DEFAULT_CONFIG.summaryRetryMaxTokens, 1200, 32000),
    summaryRetryTimeoutMs: safeNumber(config.summaryRetryTimeoutMs, DEFAULT_CONFIG.summaryRetryTimeoutMs, 10000, 180000),
    summaryRetrySampleLimit: safeNumber(config.summaryRetrySampleLimit, DEFAULT_CONFIG.summaryRetrySampleLimit, 5, 60),
    autoSummaryEnabled: config.autoSummaryEnabled !== false,
    autoSummaryMinNewSamples: safeNumber(config.autoSummaryMinNewSamples, DEFAULT_CONFIG.autoSummaryMinNewSamples, 20, 100000),
    autoSummaryCooldownHours: safeNumber(config.autoSummaryCooldownHours, DEFAULT_CONFIG.autoSummaryCooldownHours, 1, 720),
    autoSummaryFailureCooldownMinutes: safeNumber(config.autoSummaryFailureCooldownMinutes, DEFAULT_CONFIG.autoSummaryFailureCooldownMinutes, 1, 1440),
    autoSummaryMinTotalSamples: safeNumber(config.autoSummaryMinTotalSamples, DEFAULT_CONFIG.autoSummaryMinTotalSamples, 10, 100000),
    sequenceWindowMs: safeNumber(config.sequenceWindowMs, DEFAULT_CONFIG.sequenceWindowMs, 3000, 120000),
    maxSequenceTurns: safeNumber(config.maxSequenceTurns, DEFAULT_CONFIG.maxSequenceTurns, 2, 5),
    semanticRecallEnabled: config.semanticRecallEnabled !== false,
    semanticSampleLimit: safeNumber(config.semanticSampleLimit, DEFAULT_CONFIG.semanticSampleLimit, 30, 500),
    semanticMinSamples: safeNumber(config.semanticMinSamples, DEFAULT_CONFIG.semanticMinSamples, 2, 500),
    semanticPromptExamples: safeNumber(config.semanticPromptExamples, DEFAULT_CONFIG.semanticPromptExamples, 1, 4),
    semanticSimilarityThreshold: safeNumber(config.semanticSimilarityThreshold, DEFAULT_CONFIG.semanticSimilarityThreshold, 0.4, 0.95),
    semanticMinMargin: safeNumber(config.semanticMinMargin, DEFAULT_CONFIG.semanticMinMargin, 0, 0.3),
    semanticEmbedTimeoutMs: safeNumber(config.semanticEmbedTimeoutMs, DEFAULT_CONFIG.semanticEmbedTimeoutMs, 200, 5000),
    semanticQueryCacheMinutes: safeNumber(config.semanticQueryCacheMinutes, DEFAULT_CONFIG.semanticQueryCacheMinutes, 1, 60),
    semanticSchemaVersion: safeNumber(config.semanticSchemaVersion, DEFAULT_CONFIG.semanticSchemaVersion, 1, 20),
    semanticBackfillRetrySeconds: safeNumber(config.semanticBackfillRetrySeconds, DEFAULT_CONFIG.semanticBackfillRetrySeconds, 15, 600),
    semanticFeedbackWeight: safeNumber(config.semanticFeedbackWeight, DEFAULT_CONFIG.semanticFeedbackWeight, 1, 10),
    autoEvolutionEnabled: config.autoEvolutionEnabled !== false,
    autoEvolutionOutcomeWindowMinutes: safeNumber(config.autoEvolutionOutcomeWindowMinutes, DEFAULT_CONFIG.autoEvolutionOutcomeWindowMinutes, 1, 60),
    autoEvolutionMinEvidence: safeNumber(config.autoEvolutionMinEvidence, DEFAULT_CONFIG.autoEvolutionMinEvidence, 3, 50),
    autoEvolutionMinUniqueUsers: safeNumber(config.autoEvolutionMinUniqueUsers, DEFAULT_CONFIG.autoEvolutionMinUniqueUsers, 1, 20),
    autoEvolutionMinPositiveRatio: safeNumber(config.autoEvolutionMinPositiveRatio, DEFAULT_CONFIG.autoEvolutionMinPositiveRatio, 0.5, 1),
    autoEvolutionShadowEvidence: safeNumber(config.autoEvolutionShadowEvidence, DEFAULT_CONFIG.autoEvolutionShadowEvidence, 1, 20),
    autoEvolutionDemoteRatio: safeNumber(config.autoEvolutionDemoteRatio, DEFAULT_CONFIG.autoEvolutionDemoteRatio, 0, 0.8),
    autoEvolutionActiveWeight: safeNumber(config.autoEvolutionActiveWeight, DEFAULT_CONFIG.autoEvolutionActiveWeight, 1, 10),
    autoEvolutionMaxCandidates: safeNumber(config.autoEvolutionMaxCandidates, DEFAULT_CONFIG.autoEvolutionMaxCandidates, 10, 200),
    baseDir: config.baseDir || DEFAULT_CONFIG.baseDir
  }
  normalized.summaryRetryMaxTokens = Math.max(normalized.summaryMaxTokens, normalized.summaryRetryMaxTokens)
  normalized.summaryRetrySampleLimit = Math.min(normalized.summarySampleLimit, normalized.summaryRetrySampleLimit)
  normalized.semanticMinSamples = Math.min(normalized.semanticSampleLimit, normalized.semanticMinSamples)
  return normalized
}

function cleanText(text = "") {
  return String(text || "")
    .replace(/\[CQ:[^\]]+\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function sanitizeSample(text = "") {
  return safeTruncateUnicode(cleanText(text)
    .replace(/https?:\/\/\S+/gi, "[链接]")
    .replace(/www\.\S+/gi, "[链接]")
    .replace(/@\S{1,24}/g, "@某人")
    .replace(/\b\d{5,12}\b/g, "[数字]")
    .replace(/\s+/g, " ")
    .trim(), 140)
}

function sanitizeSequenceSample(items = []) {
  return safeTruncateUnicode(items
    .map(item => item === "[表情包]" ? item : sanitizeSample(item))
    .filter(Boolean)
    .join(" [下一条] "), 280)
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let index = 0; index < a.length; index += 1) {
    const left = Number(a[index])
    const right = Number(b[index])
    if (!Number.isFinite(left) || !Number.isFinite(right)) return 0
    dot += left * right
    normA += left * left
    normB += right * right
  }
  return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0
}

const FEEDBACK_STYLE_RULES = {
  too_hard: "需要设边界时先承认意图，再给可执行替代，不要冷硬地甩拒绝。",
  too_verbose: "优先给短而完整的回答，少铺垫，不在结尾评价自己说得多。",
  too_customer: "保持熟人聊天感，避免客服腔、汇报腔和说明书腔。",
  good_tone: "保持自然、松弛、像熟人说话的语气，不刻意卖萌或装腔。",
  bad_tone: "语气先收住再回应，避免阴阳怪气、顶嘴和强行接梗。"
}

const AUTO_REPLY_STYLE_RULES = [
  { key: "emotion_first", rule: "这一类场景近期更容易被接受的节奏是先自然接住情绪，再进入实际回应。" },
  { key: "short_direct", rule: "这一类场景近期更容易被接受短而直接的回应，先说结论，再按需要补充。" },
  { key: "structured_explain", rule: "这一类场景近期更容易被接受按结论、原因、下一步收束的解释。" },
  { key: "natural_plain", rule: "这一类场景近期更容易被接受自然口语的一条完整回复，不要套模板。" }
]

function deriveReplyStyle(text = "") {
  const output = cleanText(text)
  if (!output) return null
  if (/^(哈哈|笑死|草|绷|唉|哎|嗯|唔|诶|确实|你说得对)/.test(output)) return AUTO_REPLY_STYLE_RULES[0]
  if ([...output].length <= 90) return AUTO_REPLY_STYLE_RULES[1]
  if (/因为|所以|原因|结论|先说|下一步|\n/.test(output)) return AUTO_REPLY_STYLE_RULES[2]
  return AUTO_REPLY_STYLE_RULES[3]
}

function classifyReplyOutcome(text = "") {
  const content = cleanText(text)
  if (!content) return ""
  if (/语气.*(不对|怪|不舒服)|阴阳怪气|别这样说|你没看懂|还是不行|没解决|没用|不对啊|不太对/.test(content)) return "negative"
  if (/^(谢谢|谢了|懂了|明白了|知道了|这样就好|这次好|对[，,。！! ]|可以[，,。！! ]|好[，,。！! ]|行[，,。！! ])/.test(content)) return "positive"
  return ""
}

function deriveStyleScene(text = "", { sequence = false, allowDross = false } = {}) {
  const sample = cleanText(text)
  if (!sample || (!allowDross && DROSS_RULES.some(item => item.pattern.test(sample)))) return null
  const labels = []
  const plans = []
  const isCorrection = /语气|阴阳怪气|不舒服|别这样|不对劲|太怪|顶嘴|收一下/.test(sample)
  const isTroubleshooting = /报错|失败|卡住|卡了|装不上|不行|怎么办|为什么.*(没|不)/.test(sample)
  const isComfort = /难受|烦|累|崩溃|委屈|焦虑|好难|受不了/.test(sample)
  const isEmotion = /草|笑死|绷|离谱|啊？|真的假的|无语|麻了|哈哈|乐/.test(sample)
  const isQuestion = /[?？]|怎么|为什么|咋|如何|能不能|可以吗|是不是/.test(sample)
  const isRequest = /帮我|麻烦|请|查一下|看一下|告诉我|能否|可不可以/.test(sample)

  if (isCorrection) {
    labels.push("语气纠正")
    plans.push("用户在纠正语气时，先简短承认并收住，再处理正事；不反击、不调情、不继续玩梗。")
  } else if (isTroubleshooting) {
    labels.push("排障求助")
    plans.push("排查问题时先说已确认的现象，再说明原因或下一步；没有证据时明确说还没查到。")
  } else if (isComfort) {
    labels.push("情绪低落")
    plans.push("对方明显疲惫或难受时，先接住情绪，再给一小步实际帮助，不说空泛大道理。")
  } else if (isEmotion) {
    labels.push("轻松接梗")
    plans.push("先用一句自然短反应接住情绪，再进入实际回应；保持友好，不阴阳怪气。")
  } else if (isQuestion) {
    labels.push("明确提问")
    plans.push("遇到明确问题先给直接答案或判断，再补必要的原因和下一步。")
  } else if (isRequest) {
    labels.push("明确请求")
    plans.push("对方有明确请求时，直接回应要做的事或结果，不用客服式开场白。")
  } else {
    labels.push("普通闲聊")
    plans.push("简短聊天优先用自然口语短句，不为凑完整格式而铺背景。")
  }
  if (sequence || /\[下一条\]|\[表情包\]/.test(sample)) {
    labels.push("多消息节奏")
    plans.push("短反应和补充内容都独立时才分两条；表情包只放在确实承担情绪作用的位置。")
  }
  const key = labels.join("+")
  return {
    key,
    // 只包含有限类别，作为 Embedding 输入和落盘字段均不含聊天原文。
    descriptor: `对话场景：${labels.join("、")}。表达目标：${plans.join(" ")}`,
    patterns: plans.slice(0, 1)
  }
}

function inc(map, key, amount = 1) {
  if (!key) return
  map[key] = (Number(map[key]) || 0) + amount
}

function topEntries(map = {}, limit = 8) {
  return Object.entries(map)
    .sort((a, b) => (Number(b[1]) || 0) - (Number(a[1]) || 0))
    .slice(0, limit)
}

function featureLabel(key = "") {
  const labels = {
    short: "短句",
    medium: "中等长度",
    long: "长消息",
    question: "提问",
    exclamation: "感叹",
    ellipsis: "停顿/省略",
    wave: "波浪尾音"
  }
  return labels[key] || key
}

function confidenceLabel(weight = 0, total = 1) {
  const ratio = total > 0 ? Number(weight) / total : 0
  if (ratio >= 0.45) return "很稳定"
  if (ratio >= 0.18) return "比较明显"
  if (ratio >= 0.06) return "有一点"
  return "少量信号"
}

function createEmptyMemory() {
  return {
    version: 1,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    totalSamples: 0,
    groupCount: {},
    featureCount: {},
    essence: {},
    dross: {},
    toneWords: {},
    recentSignals: [],
    samplePool: [],
    semanticSamples: [],
    semanticSchemaVersion: 0,
    semanticStats: {
      queries: 0,
      cacheHits: 0,
      hits: 0,
      misses: 0,
      failures: 0,
      timeouts: 0,
      totalElapsedMs: 0,
      last: null
    },
    semanticBackfill: { cursor: 0, completed: false, retries: 0, lastErrorAt: "" },
    autoEvolution: { recentReplies: [], candidates: [], promoted: 0, demoted: 0, shadowed: 0, observedOutcomes: 0, policyVersion: 1, history: [] },
    aiRules: {
      absorb: [],
      avoid: []
    },
    aiSummary: {
      lastAt: "",
      lastAutoAt: "",
      lastAutoFailureAt: "",
      lastAutoError: "",
      count: 0,
      autoCount: 0,
      autoFailureCount: 0,
      lastSamples: 0,
      lastTotalSamples: 0
    }
  }
}

function ensureMemoryShape(memory = {}) {
  const base = createEmptyMemory()
  return {
    ...base,
    ...memory,
    groupCount: memory.groupCount || {},
    featureCount: memory.featureCount || {},
    essence: memory.essence || {},
    dross: memory.dross || {},
    toneWords: memory.toneWords || {},
    recentSignals: Array.isArray(memory.recentSignals) ? memory.recentSignals : [],
    samplePool: Array.isArray(memory.samplePool) ? memory.samplePool : [],
    semanticSamples: Array.isArray(memory.semanticSamples) ? memory.semanticSamples : [],
    semanticSchemaVersion: Number(memory.semanticSchemaVersion) || 0,
    semanticStats: { ...base.semanticStats, ...(memory.semanticStats || {}) },
    semanticBackfill: { ...base.semanticBackfill, ...(memory.semanticBackfill || {}) },
    autoEvolution: {
      ...base.autoEvolution,
      ...(memory.autoEvolution || {}),
      recentReplies: Array.isArray(memory.autoEvolution?.recentReplies) ? memory.autoEvolution.recentReplies : [],
      candidates: Array.isArray(memory.autoEvolution?.candidates) ? memory.autoEvolution.candidates : [],
      history: Array.isArray(memory.autoEvolution?.history) ? memory.autoEvolution.history : []
    },
    aiRules: {
      absorb: Array.isArray(memory.aiRules?.absorb) ? memory.aiRules.absorb : [],
      avoid: Array.isArray(memory.aiRules?.avoid) ? memory.aiRules.avoid : []
    },
    aiSummary: {
      ...base.aiSummary,
      ...(memory.aiSummary || {})
    }
  }
}

function normalizeRuleKey(value = "") {
  return String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。、“”‘’：:；;（）()【】\[\].,!?！？]/g, "")
    .slice(0, 80)
}

function clampConfidence(value, fallback = 0.6) {
  const num = Number(value)
  if (!Number.isFinite(num)) return fallback
  return Math.min(0.99, Math.max(0.1, num))
}

function extractJsonObject(text = "") {
  const raw = String(text || "").trim()
  if (!raw) throw new Error("模型没有返回内容")
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = fenced ? fenced[1].trim() : raw
  try {
    return JSON.parse(candidate)
  } catch (error) {
    const start = candidate.indexOf("{")
    const end = candidate.lastIndexOf("}")
    if (start >= 0 && end > start) return JSON.parse(candidate.slice(start, end + 1))
    throw error
  }
}

function findMatchingBracket(text = "", start = 0, open = "[", close = "]") {
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const char = text[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === "\"") {
        inString = false
      }
      continue
    }
    if (char === "\"") {
      inString = true
      continue
    }
    if (char === open) depth += 1
    if (char === close) {
      depth -= 1
      if (depth === 0) return i
    }
  }
  return -1
}

function extractArrayBody(text = "", key = "") {
  const keyIndex = text.indexOf(`"${key}"`)
  if (keyIndex < 0) return ""
  const arrayStart = text.indexOf("[", keyIndex)
  if (arrayStart < 0) return ""
  const arrayEnd = findMatchingBracket(text, arrayStart, "[", "]")
  if (arrayEnd < 0) return text.slice(arrayStart + 1)
  return text.slice(arrayStart + 1, arrayEnd)
}

function extractObjectLiterals(text = "") {
  const objects = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === "\"") {
        inString = false
      }
      continue
    }
    if (char === "\"") {
      inString = true
      continue
    }
    if (char === "{") {
      if (depth === 0) start = i
      depth += 1
    } else if (char === "}") {
      depth -= 1
      if (depth === 0 && start >= 0) {
        objects.push(text.slice(start, i + 1))
        start = -1
      }
    }
  }
  return objects
}

function repairJsonText(text = "") {
  return String(text || "")
    .replace(/，/g, ",")
    .replace(/：/g, ":")
    .replace(/“|”/g, "\"")
    .replace(/‘|’/g, "\"")
    .replace(/,\s*([}\]])/g, "$1")
}

function parseLooseRuleArray(text = "") {
  return extractObjectLiterals(text)
    .map(item => {
      try {
        return JSON.parse(repairJsonText(item))
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function parseSummaryResult(text = "") {
  try {
    return extractJsonObject(text)
  } catch (strictError) {
    const raw = String(text || "").trim()
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
    const candidate = repairJsonText(fenced ? fenced[1].trim() : raw)
    const absorb = parseLooseRuleArray(extractArrayBody(candidate, "absorb"))
    const avoid = parseLooseRuleArray(extractArrayBody(candidate, "avoid"))
    if (absorb.length || avoid.length) return { absorb, avoid }
    const preview = candidate.replace(/\s+/g, " ").slice(0, 120)
    throw new Error(`模型返回不是可解析的规则 JSON：${strictError.message}；片段：${preview}`)
  }
}

function extractSummaryContent(data = {}) {
  const content = data?.choices?.[0]?.message?.content
  if (typeof content === "string") return content.trim()
  if (!Array.isArray(content)) return ""
  return content
    .map(part => {
      if (typeof part === "string") return part
      if (typeof part?.text === "string") return part.text
      if (typeof part?.content === "string") return part.content
      return ""
    })
    .join("")
    .trim()
}

function createSummaryOutputError(data = {}, options = {}) {
  const choice = data?.choices?.[0] || {}
  const finishReason = String(choice.finish_reason || "").trim()
  const reasoningTokens = Number(data?.usage?.completion_tokens_details?.reasoning_tokens) || 0
  let message = "模型返回空的规则正文"
  let code = "empty_content"
  if (finishReason === "length") {
    code = "output_limit"
    if (options.hasContent) {
      message = reasoningTokens > 0
        ? `模型输出达到额度上限，规则 JSON 未确认完整（其中推理 ${reasoningTokens} token）`
        : "模型输出达到额度上限，规则 JSON 未确认完整"
    } else {
      message = reasoningTokens > 0
        ? `模型推理耗尽输出额度（推理 ${reasoningTokens} token，尚未生成规则正文）`
        : "模型输出达到额度上限，尚未生成完整规则正文"
    }
  } else if (finishReason === "content_filter") {
    code = "content_filter"
    message = "模型总结内容被上游过滤"
  } else if (finishReason) {
    message = `模型返回空的规则正文（finish_reason=${finishReason}）`
  }
  const error = new Error(message)
  error.code = code
  error.summaryRetryable = code !== "content_filter"
  return error
}

function markSummaryParseError(error) {
  error.code = error.code || "invalid_json"
  error.summaryRetryable = true
  return error
}

function normalizeSummaryRequestError(error, timeoutMs) {
  if (error?.summaryRetryable) return error
  const name = String(error?.name || "")
  const message = String(error?.message || "")
  if (["AbortError", "TimeoutError"].includes(name) || /aborted|timeout|超时/i.test(message)) {
    const timeoutError = new Error(`模型总结请求超时（${timeoutMs}ms）`)
    timeoutError.code = "timeout"
    timeoutError.summaryRetryable = true
    return timeoutError
  }
  return error
}

export class GlobalStyleLearnerManager {
  constructor({ cwd = process.cwd(), logger = globalThis.logger, fetchFn = globalThis.fetch } = {}) {
    this.cwd = cwd
    this.logger = logger
    this.memory = null
    this.dirty = false
    this.flushTimer = null
    this.autoSummaryRunning = false
    this.recentSpeakerSequences = new Map()
    this.lastGroupSequenceSpeaker = new Map()
    this.fetchFn = fetchFn
    this.semanticQueue = []
    this.semanticQueueRunning = 0
    this.semanticPendingHashes = new Set()
    this.semanticQueryCache = new Map()
    this.semanticQueryInFlight = new Map()
    this.semanticFailureUntil = new Map()
    this.semanticBackfillScheduled = false
    this.semanticBackfillTimer = null
  }

  getDataDir(config = {}) {
    const cfg = normalizeConfig(config)
    return path.isAbsolute(cfg.baseDir)
      ? cfg.baseDir
      : path.join(this.cwd, "plugins/bl-chat-plugin", cfg.baseDir)
  }

  getMemoryPath(config = {}) {
    return path.join(this.getDataDir(config), "style_memory.json")
  }

  readMemory(config = {}) {
    if (this.memory) return this.memory
    const file = this.getMemoryPath(config)
    try {
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, "utf8"))
        this.memory = data && typeof data === "object" ? ensureMemoryShape(data) : createEmptyMemory()
        return this.memory
      }
    } catch (error) {
      this.logger?.warn?.(`[全局表达学习] 读取失败: ${error.message}`)
    }
    this.memory = createEmptyMemory()
    return this.memory
  }

  writeMemory(config = {}) {
    if (!this.memory) return
    try {
      const file = this.getMemoryPath(config)
      ensureDir(path.dirname(file))
      fs.writeFileSync(file, JSON.stringify(this.memory, null, 2), "utf8")
      this.dirty = false
    } catch (error) {
      this.logger?.warn?.(`[全局表达学习] 写入失败: ${error.message}`)
    }
  }

  scheduleFlush(config = {}) {
    this.dirty = true
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      if (this.dirty) this.writeMemory(config)
    }, normalizeConfig(config).flushIntervalMs)
    this.flushTimer.unref?.()
  }

  observeMessage(e, config = {}, embeddingConfig = {}) {
    const cfg = normalizeConfig(config)
    if (!cfg.enabled) return
    const text = cleanText(e?.msg || e?.raw_message || "")
    const sequenceText = buildExpressionObservation(e?.msg || e?.raw_message || "", {
      userId: e?.user_id,
      messageId: e?.message_id,
      message: e?.message
    })?.sample || ""
    if ((!text || text.length < 2) && !sequenceText) return
    if (/^[#＃.。]\S+/.test(text)) return
    if (String(e?.user_id || "") === String(globalThis.Bot?.uin || "")) return

    const memory = this.readMemory(cfg)
    this.prepareSemanticMemory(memory, cfg)
    this.observeReplyOutcome(e, text, cfg, embeddingConfig)
    this.scheduleSemanticBackfill(memory, cfg, embeddingConfig)
    const groupId = String(e?.group_id || "private")
    const sequenceRecorded = this.observeSpeakerSequence(e, sequenceText, cfg, memory, embeddingConfig)
    if (!text || text.length < 2) {
      if (sequenceRecorded) {
        memory.updatedAt = nowIso()
        this.scheduleFlush(cfg)
      }
      return
    }
    const length = [...text].length
    memory.totalSamples += 1
    inc(memory.groupCount, groupId)
    inc(memory.featureCount, length <= 12 ? "short" : length >= 80 ? "long" : "medium")
    if (/[?？]/.test(text)) inc(memory.featureCount, "question")
    if (/[!！]/.test(text)) inc(memory.featureCount, "exclamation")
    if (/…|\.{3,}|。{3,}/.test(text)) inc(memory.featureCount, "ellipsis")
    if (/[~～]/.test(text)) inc(memory.featureCount, "wave")

    for (const word of TONE_WORDS) {
      if (text.includes(word)) inc(memory.toneWords, word)
    }

    const essenceKeys = []
    const drossKeys = []
    for (const item of ESSENCE_RULES) {
      if (item.pattern(text)) {
        inc(memory.essence, item.key)
        essenceKeys.push(item.key)
      }
    }
    for (const item of DROSS_RULES) {
      if (item.pattern.test(text)) {
        inc(memory.dross, item.key)
        drossKeys.push(item.key)
      }
    }

    if (essenceKeys.length || drossKeys.length) {
      const sample = sanitizeSample(text)
      memory.recentSignals = [
        {
          at: nowIso(),
          groupId,
          essence: essenceKeys,
          dross: drossKeys,
          hash: this.hashText(text)
        },
        ...(memory.recentSignals || [])
      ].slice(0, cfg.maxRecentSignals)
      if (sample && sample.length >= 2) {
        memory.samplePool = [
          {
            at: nowIso(),
            groupId,
            text: sample,
            essence: essenceKeys,
            dross: drossKeys
          },
          ...(memory.samplePool || [])
        ].slice(0, cfg.summarySampleLimit * 3)
      }
    }
    const semanticScene = deriveStyleScene(text)
    if (semanticScene) {
      this.enqueueSemanticSample({
        hash: this.hashText(`scene:${semanticScene.key}`),
        scene: semanticScene,
        patterns: semanticScene.patterns,
        source: "observation",
        weight: 1,
        sequence: false
      }, cfg, embeddingConfig)
    }
    memory.updatedAt = nowIso()
    this.scheduleFlush(cfg)
  }

  observeSpeakerSequence(e, text = "", cfg = normalizeConfig(), memory = this.readMemory(cfg), embeddingConfig = {}) {
    const content = String(text || "").trim()
    if (!content) return false
    const groupId = String(e?.group_id || "private")
    const userId = String(e?.user_id || "")
    if (!userId) return false
    const key = `${groupId}:${userId}`
    const lastSpeaker = this.lastGroupSequenceSpeaker.get(groupId)
    if (lastSpeaker && lastSpeaker !== userId) this.recentSpeakerSequences.delete(key)
    this.lastGroupSequenceSpeaker.set(groupId, userId)
    const now = Date.now()
    const previous = this.recentSpeakerSequences.get(key)
    const messageId = String(e?.message_id || "")
    const withinWindow = previous && now - previous.at <= cfg.sequenceWindowMs
    const differentMessage = !messageId || !previous?.messageId || messageId !== previous.messageId
    const items = withinWindow && differentMessage
      ? [...previous.items, content].slice(-cfg.maxSequenceTurns)
      : [content]
    this.recentSpeakerSequences.set(key, { at: now, messageId, items })

    if (this.recentSpeakerSequences.size > 300) {
      for (const [entryKey, entry] of this.recentSpeakerSequences) {
        if (now - entry.at > cfg.sequenceWindowMs * 2) this.recentSpeakerSequences.delete(entryKey)
      }
    }
    if (items.length < 2) return false

    const sample = sanitizeSequenceSample(items)
    if (!sample) return false
    memory.totalSequenceSamples = (Number(memory.totalSequenceSamples) || 0) + 1
    inc(memory.featureCount, "multi_message_sequence")
    inc(memory.essence, "multi_message_rhythm")
    if (items.includes("[表情包]") || items.some(item => item.includes("[表情包]"))) {
      inc(memory.featureCount, "emoji_interleave_sequence")
    }
    memory.recentSignals = [
      {
        at: nowIso(),
        groupId,
        essence: ["multi_message_rhythm"],
        dross: [],
        hash: this.hashText(sample),
        sequence: true
      },
      ...(memory.recentSignals || [])
    ].slice(0, cfg.maxRecentSignals)
    memory.samplePool = [
      {
        at: nowIso(),
        groupId,
        text: sample,
        essence: ["multi_message_rhythm"],
        dross: [],
        sequence: true
      },
      ...(memory.samplePool || [])
    ].slice(0, cfg.summarySampleLimit * 3)
    const semanticScene = deriveStyleScene(sample, { sequence: true })
    if (semanticScene) {
      this.enqueueSemanticSample({
        hash: this.hashText(`scene:${semanticScene.key}`),
        scene: semanticScene,
        patterns: semanticScene.patterns,
        source: "observation",
        weight: 1,
        sequence: true
      }, cfg, embeddingConfig)
    }
    return true
  }

  hashText(text = "") {
    let hash = 2166136261
    for (const char of String(text)) {
      hash ^= char.charCodeAt(0)
      hash = Math.imul(hash, 16777619)
    }
    return (hash >>> 0).toString(16)
  }

  prepareSemanticMemory(memory, cfg) {
    if (Number(memory.semanticSchemaVersion) === cfg.semanticSchemaVersion) return false
    // 旧索引的向量由消息内容生成，缺少可安全迁移的场景字段，必须从已有脱敏池重建。
    memory.semanticSamples = []
    memory.semanticSchemaVersion = cfg.semanticSchemaVersion
    memory.semanticBackfill = { cursor: 0, completed: false, retries: 0, lastErrorAt: "" }
    memory.updatedAt = nowIso()
    this.semanticBackfillScheduled = false
    this.scheduleFlush(cfg)
    return true
  }

  getSemanticProviderKey(embeddingConfig = {}) {
    return `${embeddingConfig?.embeddingApiUrl || ""}|${embeddingConfig?.embeddingApiModel || "text-embedding-3-small"}`
  }

  canUseSemanticRecall(cfg, embeddingConfig = {}) {
    const unavailableUntil = this.semanticFailureUntil.get(this.getSemanticProviderKey(embeddingConfig)) || 0
    return Boolean(
      cfg.semanticRecallEnabled &&
      embeddingConfig?.embeddingApiUrl &&
      embeddingConfig?.embeddingApiKey &&
      !String(embeddingConfig.embeddingApiKey).includes("sk-xxx") &&
      Date.now() >= unavailableUntil &&
      typeof this.fetchFn === "function"
    )
  }

  markSemanticProviderFailure(embeddingConfig = {}) {
    this.semanticFailureUntil.set(this.getSemanticProviderKey(embeddingConfig), Date.now() + 60000)
  }

  async embedSemanticText(text, cfg, embeddingConfig = {}) {
    if (!this.canUseSemanticRecall(cfg, embeddingConfig)) return null
    const input = String(text || "").trim()
    if (!input) return null
    const timeoutSignal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(cfg.semanticEmbedTimeoutMs)
      : undefined
    const response = await this.fetchFn(embeddingConfig.embeddingApiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${embeddingConfig.embeddingApiKey}`
      },
      body: JSON.stringify({
        model: embeddingConfig.embeddingApiModel || "text-embedding-3-small",
        input
      }),
      signal: timeoutSignal
    })
    if (!response?.ok) throw new Error(`embedding API 请求失败：${response?.status || "unknown"}`)
    const vector = (await response.json())?.data?.[0]?.embedding
    return Array.isArray(vector) && vector.length && vector.every(value => Number.isFinite(Number(value)))
      ? vector.map(Number)
      : null
  }

  normalizeSemanticSample(sample = {}) {
    const scene = sample.scene || deriveStyleScene(sample.text || "", { sequence: Boolean(sample.sequence) })
    if (!scene?.key || !scene?.descriptor) return null
    const patterns = Array.isArray(sample.patterns) && sample.patterns.length ? sample.patterns : scene.patterns
    if (!patterns?.length) return null
    return {
      hash: sample.hash || this.hashText(`scene:${scene.key}|${patterns.join("|")}|${sample.source || "observation"}`),
      scene,
      patterns: [...new Set(patterns.map(item => cleanText(item)).filter(Boolean))].slice(0, 4),
      source: sample.source || "observation",
      weight: Math.max(1, Number(sample.weight) || 1),
      feedbackTags: Array.isArray(sample.feedbackTags) ? sample.feedbackTags.slice(0, 6) : [],
      sequence: Boolean(sample.sequence),
      backfill: Boolean(sample.backfill)
    }
  }

  enqueueSemanticSample(rawSample, cfg, embeddingConfig = {}) {
    const normalizedCfg = normalizeConfig(cfg)
    const sample = this.normalizeSemanticSample(rawSample)
    if (!this.canUseSemanticRecall(normalizedCfg, embeddingConfig) || !sample) return false
    const memory = this.readMemory(normalizedCfg)
    this.prepareSemanticMemory(memory, normalizedCfg)
    if (memory.semanticSamples?.some(item => item.hash === sample.hash) || this.semanticPendingHashes.has(sample.hash)) return
    if (this.semanticQueue.length >= 64) return false
    this.semanticPendingHashes.add(sample.hash)
    this.semanticQueue.push({ sample, cfg: normalizedCfg, embeddingConfig })
    this.drainSemanticQueue()
    return true
  }

  scheduleSemanticBackfill(memory, cfg, embeddingConfig = {}) {
    if (this.semanticBackfillScheduled || !this.canUseSemanticRecall(cfg, embeddingConfig)) return
    const existing = Array.isArray(memory?.semanticSamples) ? memory.semanticSamples.length : 0
    const legacySamples = Array.isArray(memory?.samplePool) ? memory.samplePool : []
    if (existing >= cfg.semanticMinSamples || !legacySamples.length) {
      if (memory.semanticBackfill) memory.semanticBackfill.completed = existing >= cfg.semanticMinSamples
      return
    }
    this.semanticBackfillScheduled = true
    const state = memory.semanticBackfill || { cursor: 0, completed: false, retries: 0, lastErrorAt: "" }
    let cursor = Math.max(0, Number(state.cursor) || 0)
    if (cursor >= legacySamples.length && existing < cfg.semanticMinSamples) cursor = 0
    while (cursor < legacySamples.length && this.semanticQueue.length < 64) {
      const legacy = legacySamples[cursor]
      cursor += 1
      const text = legacy?.text || ""
      const scene = deriveStyleScene(text, { sequence: Boolean(legacy?.sequence) })
      if (!scene) continue
      this.enqueueSemanticSample({
        hash: this.hashText(`scene:${scene.key}`),
        scene,
        patterns: scene.patterns,
        source: "backfill",
        weight: 1,
        sequence: Boolean(legacy?.sequence),
        backfill: true
      }, cfg, embeddingConfig)
    }
    memory.semanticBackfill = {
      ...state,
      cursor,
      completed: cursor >= legacySamples.length,
      retries: 0
    }
    memory.updatedAt = nowIso()
    this.scheduleFlush(cfg)
  }

  scheduleSemanticBackfillRetry(cfg, embeddingConfig = {}) {
    if (this.semanticBackfillTimer) return
    this.semanticBackfillScheduled = false
    this.semanticBackfillTimer = setTimeout(() => {
      this.semanticBackfillTimer = null
      const memory = this.readMemory(cfg)
      this.scheduleSemanticBackfill(memory, cfg, embeddingConfig)
    }, cfg.semanticBackfillRetrySeconds * 1000)
    this.semanticBackfillTimer.unref?.()
  }

  drainSemanticQueue() {
    while (this.semanticQueueRunning < 2 && this.semanticQueue.length) {
      const task = this.semanticQueue.shift()
      this.semanticQueueRunning += 1
      this.storeSemanticSample(task).catch(error => {
        this.markSemanticProviderFailure(task.embeddingConfig)
        if (task.sample.backfill) {
          const memory = this.readMemory(task.cfg)
          memory.semanticBackfill = {
            ...(memory.semanticBackfill || {}),
            cursor: 0,
            completed: false,
            retries: (Number(memory.semanticBackfill?.retries) || 0) + 1,
            lastErrorAt: nowIso()
          }
          this.scheduleFlush(task.cfg)
          this.scheduleSemanticBackfillRetry(task.cfg, task.embeddingConfig)
        }
        this.logger?.warn?.(`[全局表达学习] 语义样本向量化失败: ${error.message}`)
      }).finally(() => {
        this.semanticPendingHashes.delete(task.sample.hash)
        this.semanticQueueRunning -= 1
        this.drainSemanticQueue()
      })
    }
  }

  async storeSemanticSample({ sample, cfg, embeddingConfig }) {
    const embedding = await this.embedSemanticText(sample.scene.descriptor, cfg, embeddingConfig)
    if (!embedding) return
    const memory = this.readMemory(cfg)
    if (memory.semanticSamples.some(item => item.hash === sample.hash)) return
    // 只落盘向量和抽象句式，原始/脱敏文本均不作为可召回 prompt 内容保存。
    memory.semanticSamples = [
      {
        hash: sample.hash,
        embedding,
        patterns: sample.patterns,
        sceneKey: sample.scene.key,
        scene: sample.scene.descriptor,
        source: sample.source,
        weight: sample.weight,
        feedbackTags: sample.feedbackTags,
        sequence: Boolean(sample.sequence),
        at: nowIso()
      },
      ...memory.semanticSamples
    ].slice(0, cfg.semanticSampleLimit)
    memory.updatedAt = nowIso()
    this.scheduleFlush(cfg)
  }

  observePersonaFeedback(record = {}, config = {}, embeddingConfig = {}) {
    const cfg = normalizeConfig(config)
    const tags = [...new Set((record.tags || []).filter(tag => FEEDBACK_STYLE_RULES[tag]))]
    if (!tags.length || !record.botReply) return false
    const scene = deriveStyleScene(record.botReply, { allowDross: true })
    if (!scene) return false
    const patterns = tags.map(tag => FEEDBACK_STYLE_RULES[tag])
    return this.enqueueSemanticSample({
      hash: this.hashText(`feedback:${scene.key}:${tags.sort().join(",")}`),
      scene: {
        key: `${scene.key}+主人反馈`,
        descriptor: `对话场景：${scene.key}。主人明确风格反馈：${tags.join("、")}。表达目标：${patterns.join(" ")}`,
        patterns
      },
      patterns,
      source: "master_feedback",
      weight: cfg.semanticFeedbackWeight,
      feedbackTags: tags
    }, cfg, embeddingConfig)
  }

  rememberBotReply(e, output = "", config = {}) {
    const cfg = normalizeConfig(config)
    if (!cfg.autoEvolutionEnabled) return false
    const scene = deriveStyleScene(e?.msg || "")
    const replyStyle = deriveReplyStyle(output)
    const userId = String(e?.user_id || "")
    const groupId = String(e?.group_id || "private")
    if (!scene || !replyStyle || !userId) return false
    const memory = this.readMemory(cfg)
    const state = memory.autoEvolution
    const now = Date.now()
    const speakerHash = this.hashText(`${groupId}:${userId}`)
    state.recentReplies = [
      {
        at: now,
        groupHash: this.hashText(groupId),
        speakerHash,
        sceneKey: scene.key,
        scene: scene.descriptor,
        replyStyle: replyStyle.key
      },
      ...state.recentReplies.filter(item => now - Number(item?.at || 0) <= cfg.autoEvolutionOutcomeWindowMinutes * 60 * 1000)
    ].slice(0, 160)
    memory.updatedAt = nowIso()
    this.scheduleFlush(cfg)
    return true
  }

  observeReplyOutcome(e, text = "", cfg = normalizeConfig(), embeddingConfig = {}) {
    if (!cfg.autoEvolutionEnabled) return false
    const outcome = classifyReplyOutcome(text)
    if (!outcome) return false
    const memory = this.readMemory(cfg)
    const state = memory.autoEvolution
    const now = Date.now()
    const groupHash = this.hashText(String(e?.group_id || "private"))
    const speakerHash = this.hashText(`${String(e?.group_id || "private")}:${String(e?.user_id || "")}`)
    const cutoff = now - cfg.autoEvolutionOutcomeWindowMinutes * 60 * 1000
    const index = state.recentReplies.findIndex(item => item.groupHash === groupHash && item.speakerHash === speakerHash && Number(item.at || 0) >= cutoff)
    if (index < 0) return false
    const [reply] = state.recentReplies.splice(index, 1)
    state.recentReplies = state.recentReplies.filter(item => Number(item?.at || 0) >= cutoff)
    state.observedOutcomes = (Number(state.observedOutcomes) || 0) + 1
    this.updateAutoEvolutionCandidate(memory, reply, outcome, speakerHash, cfg, embeddingConfig)
    memory.updatedAt = nowIso()
    this.scheduleFlush(cfg)
    return true
  }

  updateAutoEvolutionCandidate(memory, reply, outcome, speakerHash, cfg, embeddingConfig = {}) {
    const style = AUTO_REPLY_STYLE_RULES.find(item => item.key === reply.replyStyle)
    if (!style || !reply.sceneKey || !reply.scene) return
    const state = memory.autoEvolution
    const key = `${reply.sceneKey}|${style.key}`
    let candidate = state.candidates.find(item => item.key === key)
    if (!candidate) {
      candidate = {
        key,
        sceneKey: reply.sceneKey,
        scene: reply.scene,
        replyStyle: style.key,
        strategy: style.rule,
        positive: 0,
        negative: 0,
        speakers: [],
        status: "candidate",
        createdAt: nowIso(),
        lastSeenAt: nowIso()
      }
      state.candidates.push(candidate)
    }
    candidate[outcome] = (Number(candidate[outcome]) || 0) + 1
    candidate.lastSeenAt = nowIso()
    candidate.speakers = [...new Set([...(candidate.speakers || []), speakerHash])].slice(-16)
    const evidence = (Number(candidate.positive) || 0) + (Number(candidate.negative) || 0)
    const ratio = evidence ? (Number(candidate.positive) || 0) / evidence : 0
    const autoHash = this.hashText(`auto:${key}`)
    if (candidate.status === "candidate" && evidence >= cfg.autoEvolutionMinEvidence && candidate.speakers.length >= cfg.autoEvolutionMinUniqueUsers && ratio >= cfg.autoEvolutionMinPositiveRatio) {
      candidate.status = "shadow"
      candidate.shadowAt = nowIso()
      state.shadowed = (Number(state.shadowed) || 0) + 1
    } else if (candidate.status === "shadow" && evidence >= cfg.autoEvolutionMinEvidence + cfg.autoEvolutionShadowEvidence && ratio >= cfg.autoEvolutionMinPositiveRatio) {
      candidate.status = "active"
      candidate.promotedAt = nowIso()
      state.promoted = (Number(state.promoted) || 0) + 1
      state.policyVersion = (Number(state.policyVersion) || 1) + 1
      state.history = [{ at: nowIso(), action: "promote", scene: reply.sceneKey, style: style.key, version: state.policyVersion }, ...state.history].slice(0, 60)
      this.enqueueSemanticSample({
        hash: autoHash,
        scene: { key: reply.sceneKey, descriptor: reply.scene, patterns: [style.rule] },
        patterns: [style.rule],
        source: "auto_evolution",
        weight: cfg.autoEvolutionActiveWeight
      }, cfg, embeddingConfig)
      this.logger?.info?.(`[全局表达学习] 自主策略晋升 scene=${reply.sceneKey} style=${style.key} evidence=${evidence} ratio=${ratio.toFixed(2)}`)
    } else if (candidate.status === "active" && evidence >= cfg.autoEvolutionMinEvidence && ratio < cfg.autoEvolutionDemoteRatio) {
      candidate.status = "demoted"
      candidate.demotedAt = nowIso()
      state.demoted = (Number(state.demoted) || 0) + 1
      state.policyVersion = (Number(state.policyVersion) || 1) + 1
      state.history = [{ at: nowIso(), action: "demote", scene: reply.sceneKey, style: style.key, version: state.policyVersion }, ...state.history].slice(0, 60)
      memory.semanticSamples = memory.semanticSamples.filter(item => item.hash !== autoHash)
      this.logger?.info?.(`[全局表达学习] 自主策略撤销 scene=${reply.sceneKey} style=${style.key} evidence=${evidence} ratio=${ratio.toFixed(2)}`)
    }
    state.candidates = state.candidates
      .sort((left, right) => String(right.lastSeenAt || "").localeCompare(String(left.lastSeenAt || "")))
      .slice(0, cfg.autoEvolutionMaxCandidates)
  }

  buildAutoEvolutionView(config = {}) {
    const memory = this.readMemory(config)
    const state = memory.autoEvolution || {}
    const items = (state.candidates || []).slice(0, 12)
    return [
      `自主风格策略 v${state.policyVersion || 1}：候选 ${items.length}，影子 ${state.shadowed || 0}，采纳 ${state.promoted || 0}，撤销 ${state.demoted || 0}`,
      ...items.map((item, index) => `${index + 1}. [${item.status}] ${item.sceneKey} / ${item.replyStyle}：+${item.positive || 0} -${item.negative || 0}，用户 ${item.speakers?.length || 0}`)
    ].join("\n")
  }

  recordSemanticRecall(memory, cfg, result = {}) {
    const stats = memory.semanticStats || createEmptyMemory().semanticStats
    stats.queries = (Number(stats.queries) || 0) + 1
    stats.totalElapsedMs = (Number(stats.totalElapsedMs) || 0) + Math.max(0, Number(result.elapsedMs) || 0)
    if (result.cacheHit) stats.cacheHits = (Number(stats.cacheHits) || 0) + 1
    if (result.outcome === "hit") stats.hits = (Number(stats.hits) || 0) + 1
    else stats.misses = (Number(stats.misses) || 0) + 1
    if (result.failure) stats.failures = (Number(stats.failures) || 0) + 1
    if (result.timeout) stats.timeouts = (Number(stats.timeouts) || 0) + 1
    stats.last = {
      at: nowIso(),
      outcome: result.outcome || "miss",
      cacheHit: Boolean(result.cacheHit),
      elapsedMs: Math.round(Number(result.elapsedMs) || 0),
      score: Number.isFinite(result.score) ? Number(result.score.toFixed(3)) : null,
      margin: Number.isFinite(result.margin) ? Number(result.margin.toFixed(3)) : null,
      scene: String(result.scene || "").slice(0, 80)
    }
    memory.semanticStats = stats
    memory.updatedAt = nowIso()
    this.scheduleFlush(cfg)
    if (result.outcome === "hit" || result.failure || (Number(result.elapsedMs) || 0) >= 400) {
      this.logger?.info?.(`[语义表达] outcome=${result.outcome || "miss"} cache=${result.cacheHit ? "hit" : "miss"} elapsed=${Math.round(Number(result.elapsedMs) || 0)}ms score=${Number.isFinite(result.score) ? result.score.toFixed(3) : ""} margin=${Number.isFinite(result.margin) ? result.margin.toFixed(3) : ""} scene=${String(result.scene || "").slice(0, 80)}`)
    }
  }

  async buildRelevantPrompt(config = {}, { query = "", embeddingConfig = {} } = {}) {
    const cfg = normalizeConfig(config)
    const memory = this.readMemory(cfg)
    const startedAt = Date.now()
    if (!cfg.enabled || !cfg.promptInjectionEnabled || !this.canUseSemanticRecall(cfg, embeddingConfig)) return ""
    this.prepareSemanticMemory(memory, cfg)
    const candidates = (memory.semanticSamples || []).filter(item => Array.isArray(item.embedding) && Array.isArray(item.patterns) && item.patterns.length && item.sceneKey)
    if (candidates.length < cfg.semanticMinSamples) {
      this.recordSemanticRecall(memory, cfg, { outcome: "warming", elapsedMs: Date.now() - startedAt })
      return ""
    }
    const queryScene = deriveStyleScene(query)
    if (!queryScene) return ""
    const cacheKey = `${embeddingConfig.embeddingApiModel || "text-embedding-3-small"}:${queryScene.key}`
    const cached = this.semanticQueryCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      this.recordSemanticRecall(memory, cfg, { ...cached.metrics, outcome: cached.prompt ? "hit" : "miss", cacheHit: true, elapsedMs: Date.now() - startedAt, scene: queryScene.key })
      return cached.prompt
    }
    if (this.semanticQueryInFlight.has(cacheKey)) return this.semanticQueryInFlight.get(cacheKey)

    const task = (async () => {
      try {
        const queryEmbedding = await this.embedSemanticText(queryScene.descriptor, cfg, embeddingConfig)
        if (!queryEmbedding) {
          this.recordSemanticRecall(memory, cfg, { outcome: "empty_embedding", elapsedMs: Date.now() - startedAt, scene: queryScene.key })
          return ""
        }
        const grouped = new Map()
        for (const item of candidates) {
          const score = cosineSimilarity(queryEmbedding, item.embedding) + Math.min(0.04, Math.max(0, (Number(item.weight) || 1) - 1) * 0.01)
          const existing = grouped.get(item.sceneKey)
          if (!existing || score > existing.score) grouped.set(item.sceneKey, { item, score })
        }
        const matched = [...grouped.values()]
          .filter(item => item.score >= cfg.semanticSimilarityThreshold)
          .sort((left, right) => right.score - left.score)
        const best = matched[0]
        const second = matched[1]
        const margin = best ? best.score - (second?.score || 0) : 0
        if (!best || (second && margin < cfg.semanticMinMargin)) {
          this.recordSemanticRecall(memory, cfg, { outcome: "ambiguous", elapsedMs: Date.now() - startedAt, score: best?.score, margin, scene: queryScene.key })
          return ""
        }
        const patterns = [...new Set(best.item.patterns || [])].slice(0, cfg.semanticPromptExamples)
        if (!patterns.length) return ""
        const prompt = [
          "【希洛当前话题的表达提示】",
          "这是由语义相近样本提炼出的匿名句式和节奏，不含任何群友原话；只在自然契合时采用，不要解释来源。",
          ...patterns.map(pattern => `- ${pattern}`)
        ].join("\n")
        best.item.usedCount = (Number(best.item.usedCount) || 0) + 1
        best.item.lastUsedAt = nowIso()
        this.recordSemanticRecall(memory, cfg, { outcome: "hit", elapsedMs: Date.now() - startedAt, score: best.score, margin, scene: queryScene.key })
        this.semanticQueryCache.set(cacheKey, {
          expiresAt: Date.now() + cfg.semanticQueryCacheMinutes * 60 * 1000,
          prompt,
          metrics: { score: best.score, margin }
        })
        if (this.semanticQueryCache.size > 128) {
          const oldest = this.semanticQueryCache.keys().next().value
          this.semanticQueryCache.delete(oldest)
        }
        return prompt
      } catch (error) {
        this.markSemanticProviderFailure(embeddingConfig)
        this.recordSemanticRecall(memory, cfg, {
          outcome: "failure",
          elapsedMs: Date.now() - startedAt,
          failure: true,
          timeout: error?.name === "TimeoutError" || error?.name === "AbortError",
          scene: queryScene.key
        })
        this.logger?.warn?.(`[全局表达学习] 语义召回失败: ${error.message}`)
        return ""
      } finally {
        this.semanticQueryInFlight.delete(cacheKey)
      }
    })()
    this.semanticQueryInFlight.set(cacheKey, task)
    return task
  }

  getEssenceRules(memory = this.readMemory(), limit = 6) {
    const drossPressure = Object.values(memory.dross || {}).reduce((sum, value) => sum + Number(value || 0), 0)
    return ESSENCE_RULES
      .map(item => ({ ...item, weight: Number(memory.essence?.[item.key]) || 0 }))
      .filter(item => item.weight > 0)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit)
      .map(item => {
        if (item.key === "light_humor" && drossPressure > 0) {
          return { ...item, rule: `${item.rule} 明确避开辱骂、阴阳怪气和群内私梗过拟合。` }
        }
        return item
      })
  }

  getDrossRules(memory = this.readMemory(), limit = 4) {
    return DROSS_RULES
      .map(item => ({ ...item, weight: Number(memory.dross?.[item.key]) || 0 }))
      .filter(item => item.weight > 0)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit)
  }

  getAiRules(memory = this.readMemory(), limit = 6) {
    const sortRules = rules => (Array.isArray(rules) ? rules : [])
      .filter(item => item?.rule)
      .sort((a, b) => {
        const scoreA = (Number(a.weight) || 1) * clampConfidence(a.confidence)
        const scoreB = (Number(b.weight) || 1) * clampConfidence(b.confidence)
        return scoreB - scoreA
      })
      .slice(0, limit)
    return {
      absorb: sortRules(memory.aiRules?.absorb),
      avoid: sortRules(memory.aiRules?.avoid)
    }
  }

  mergeAiRules(memory, result = {}, cfg = normalizeConfig()) {
    const mergeList = (side, incoming) => {
      if (!Array.isArray(incoming)) return 0
      const list = Array.isArray(memory.aiRules?.[side]) ? memory.aiRules[side] : []
      let changed = 0
      for (const raw of incoming.slice(0, cfg.maxAiRules)) {
        const label = cleanText(raw?.label || "").slice(0, 18)
        const rule = cleanText(raw?.rule || "").slice(0, 120)
        if (!rule || rule.length < 4) continue
        const confidence = clampConfidence(raw?.confidence)
        const reason = cleanText(raw?.reason || "").slice(0, 80)
        const key = normalizeRuleKey(rule || label)
        if (!key) continue
        const existing = list.find(item => item.key === key || normalizeRuleKey(item.rule) === key)
        if (existing) {
          existing.label = label || existing.label
          existing.rule = rule
          existing.confidence = Math.max(clampConfidence(existing.confidence), confidence)
          existing.reason = reason || existing.reason
          existing.weight = (Number(existing.weight) || 1) + 1
          existing.lastSeen = nowIso()
        } else {
          list.push({
            key,
            label: label || (side === "absorb" ? "可吸收表达" : "应避开表达"),
            rule,
            confidence,
            reason,
            weight: 1,
            createdAt: nowIso(),
            lastSeen: nowIso()
          })
        }
        changed += 1
      }
      memory.aiRules[side] = list
        .sort((a, b) => ((Number(b.weight) || 1) * clampConfidence(b.confidence)) - ((Number(a.weight) || 1) * clampConfidence(a.confidence)))
        .slice(0, cfg.maxAiRules * 3)
      return changed
    }

    const absorbChanged = mergeList("absorb", result.absorb)
    const avoidChanged = mergeList("avoid", result.avoid)
    memory.aiSummary = {
      ...(memory.aiSummary || {}),
      lastAt: nowIso(),
      count: (Number(memory.aiSummary?.count) || 0) + 1,
      lastSamples: Array.isArray(memory.samplePool) ? Math.min(memory.samplePool.length, cfg.summarySampleLimit) : 0
    }
    memory.updatedAt = nowIso()
    return { absorbChanged, avoidChanged }
  }

  buildSummaryMessages(memory, cfg, options = {}) {
    const essence = this.getEssenceRules(memory, 8)
    const dross = this.getDrossRules(memory, 8)
    const ai = this.getAiRules(memory, cfg.maxAiRules)
    const samples = (memory.samplePool || []).slice(0, cfg.summarySampleLimit).map((item, index) => ({
      id: index + 1,
      text: item.text,
      essence: item.essence || [],
      dross: item.dross || []
    }))
    return [
      {
        role: "system",
        content: [
          "你是聊天机器人希洛的全局表达学习总结器。",
          "任务是从跨群样本里取其精华、去其糟粕，生成可长期注入的表达准则。",
          "样本中的 [下一条] 表示同一群友短时间内继续发下一条，[表情包] 表示该位置发了表情包；学习整轮节奏和位置，不要照抄具体内容。",
          "不要模仿具体群友，不要吸收人身攻击、歧视、隐私、群内私梗、阴阳怪气和客服腔。",
          "只输出严格 JSON，不要 Markdown。",
          options.retry
            ? "这是一次完整性重试：不要输出思考过程，优先完成短小且正确闭合的 JSON；宁可减少规则，也不能截断。"
            : "在输出额度内优先完成 JSON，不要把思考过程写进最终正文。"
        ].join("\n")
      },
      {
        role: "user",
        content: JSON.stringify({
          task: "总结表达规则",
          outputSchema: {
            absorb: [{ label: "短标签", rule: "可吸收的表达策略", confidence: 0.75, reason: "依据" }],
            avoid: [{ label: "短标签", rule: "应该避开的表达倾向", confidence: 0.75, reason: "依据" }]
          },
          limits: {
            maxAbsorb: cfg.maxAiRules,
            maxAvoid: cfg.maxAiRules,
            ruleLength: "每条 rule 不超过 45 个中文字"
          },
          codeStats: {
            totalSamples: memory.totalSamples,
            features: topEntries(memory.featureCount, 10),
            toneWords: topEntries(memory.toneWords, 12),
            essence: essence.map(item => ({ label: item.label, rule: item.rule, weight: item.weight })),
            dross: dross.map(item => ({ label: item.label, rule: item.rule, weight: item.weight }))
          },
          existingAiRules: ai,
          sanitizedSamples: samples
        }, null, 2)
      }
    ]
  }

  getAutoSummaryState(config = {}) {
    const cfg = normalizeConfig(config)
    const memory = this.readMemory(cfg)
    const totalSamples = Number(memory.totalSamples) || 0
    const lastTotalSamples = Number(memory.aiSummary?.lastTotalSamples) || 0
    const newSamples = Math.max(0, totalSamples - lastTotalSamples)
    const lastAutoAt = memory.aiSummary?.lastAutoAt || memory.aiSummary?.lastAt || ""
    const lastAutoMs = lastAutoAt ? new Date(lastAutoAt).getTime() : 0
    const cooldownMs = cfg.autoSummaryCooldownHours * 60 * 60 * 1000
    const cooldownReady = !lastAutoMs || !Number.isFinite(lastAutoMs) || Date.now() - lastAutoMs >= cooldownMs
    const lastFailureAt = memory.aiSummary?.lastAutoFailureAt || ""
    const lastFailureMs = lastFailureAt ? new Date(lastFailureAt).getTime() : 0
    const failureCooldownMs = cfg.autoSummaryFailureCooldownMinutes * 60 * 1000
    const failureCooldownReady = !lastFailureMs || !Number.isFinite(lastFailureMs) || Date.now() - lastFailureMs >= failureCooldownMs
    const enoughTotal = totalSamples >= cfg.autoSummaryMinTotalSamples
    const enoughNew = newSamples >= cfg.autoSummaryMinNewSamples
    return {
      enabled: cfg.enabled && cfg.aiSummaryEnabled && cfg.autoSummaryEnabled,
      totalSamples,
      lastTotalSamples,
      newSamples,
      enoughTotal,
      enoughNew,
      cooldownReady,
      failureCooldownReady,
      lastAutoAt
    }
  }

  shouldAutoSummarize(config = {}) {
    const state = this.getAutoSummaryState(config)
    return state.enabled && state.enoughTotal && state.enoughNew && state.cooldownReady && state.failureCooldownReady
  }

  async maybeAutoSummarize(config = {}, memoryAiConfig = {}) {
    const cfg = normalizeConfig(config)
    if (this.autoSummaryRunning || !this.shouldAutoSummarize(cfg)) return { triggered: false }
    if (!memoryAiConfig?.memoryAiUrl || !memoryAiConfig?.memoryAiApikey) {
      return { triggered: false, reason: "missing_memory_ai_config" }
    }
    this.autoSummaryRunning = true
    try {
      const result = await this.summarizeWithAI(cfg, memoryAiConfig, { source: "auto" })
      this.logger?.info?.(`[全局表达学习] 自动总结完成: absorb=${result.absorbChanged}, avoid=${result.avoidChanged}, samples=${result.sampleCount}`)
      return { triggered: true, result }
    } catch (error) {
      const memory = this.readMemory(cfg)
      memory.aiSummary = {
        ...(memory.aiSummary || {}),
        lastAutoFailureAt: nowIso(),
        lastAutoError: String(error?.code || "summary_failed").slice(0, 40),
        autoFailureCount: (Number(memory.aiSummary?.autoFailureCount) || 0) + 1
      }
      memory.updatedAt = nowIso()
      this.writeMemory(cfg)
      this.logger?.warn?.(`[全局表达学习] 自动总结失败: ${error.message}`)
      return { triggered: false, error }
    } finally {
      this.autoSummaryRunning = false
    }
  }

  async summarizeWithAI(config = {}, memoryAiConfig = {}, options = {}) {
    const cfg = normalizeConfig(config)
    if (!cfg.enabled) throw new Error("全局表达学习未开启")
    if (!cfg.aiSummaryEnabled) throw new Error("模型总结未开启")
    const aiConfig = memoryAiConfig || {}
    if (!aiConfig.memoryAiUrl || !aiConfig.memoryAiApikey) throw new Error("未配置 memoryAiConfig，无法调用模型总结")

    const memory = this.readMemory(cfg)
    if (!Array.isArray(memory.samplePool) || !memory.samplePool.length) {
      throw new Error("还没有可用于总结的脱敏样本")
    }

    const fetchImpl = this.fetchFn || globalThis.fetch
    if (typeof fetchImpl !== "function") throw new Error("当前运行环境没有可用的 fetch，无法调用模型总结")

    const attempts = [
      { cfg, maxTokens: cfg.summaryMaxTokens, timeoutMs: cfg.summaryTimeoutMs, retry: false },
      {
        cfg: {
          ...cfg,
          summarySampleLimit: cfg.summaryRetrySampleLimit,
          maxAiRules: Math.min(cfg.maxAiRules, 4)
        },
        maxTokens: cfg.summaryRetryMaxTokens,
        timeoutMs: cfg.summaryRetryTimeoutMs,
        retry: true
      }
    ]
    let parsed = null
    let usedConfig = cfg
    let firstError = null
    for (let index = 0; index < attempts.length; index += 1) {
      const attempt = attempts[index]
      try {
        const res = await fetchImpl(aiConfig.memoryAiUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${aiConfig.memoryAiApikey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: aiConfig.memoryAiModel || "gpt-4o-mini",
            messages: this.buildSummaryMessages(memory, attempt.cfg, { retry: attempt.retry }),
            temperature: 0.2,
            max_tokens: attempt.maxTokens
          }),
          signal: AbortSignal.timeout(attempt.timeoutMs)
        })
        if (!res.ok) throw new Error(`模型总结请求失败：${res.status}`)
        const data = await res.json()
        const content = extractSummaryContent(data)
        if (data?.choices?.[0]?.finish_reason === "length") {
          throw createSummaryOutputError(data, { hasContent: Boolean(content) })
        }
        if (!content) throw createSummaryOutputError(data)
        try {
          parsed = parseSummaryResult(content)
        } catch (error) {
          throw markSummaryParseError(error)
        }
        usedConfig = attempt.cfg
        break
      } catch (caughtError) {
        const error = normalizeSummaryRequestError(caughtError, attempt.timeoutMs)
        if (index === 0 && error?.summaryRetryable) {
          firstError = error
          this.logger?.warn?.(`[全局表达学习] 总结输出不完整，收紧样本并提高输出额度重试: ${error.message}`)
          continue
        }
        if (index > 0 && firstError) {
          const retryError = new Error(`模型总结重试后仍失败：${error.message}`)
          retryError.code = typeof error?.code === "string" && error.code ? error.code : "summary_retry_failed"
          throw retryError
        }
        throw error
      }
    }
    if (!parsed) throw new Error("模型总结没有产生可用规则")

    const changed = this.mergeAiRules(memory, parsed, usedConfig)
    memory.aiSummary = {
      ...(memory.aiSummary || {}),
      lastTotalSamples: Number(memory.totalSamples) || 0,
      lastAutoFailureAt: "",
      lastAutoError: ""
    }
    if (options.source === "auto") {
      memory.aiSummary.lastAutoAt = nowIso()
      memory.aiSummary.autoCount = (Number(memory.aiSummary.autoCount) || 0) + 1
    }
    this.writeMemory(cfg)
    return {
      ...changed,
      totalAbsorb: memory.aiRules.absorb.length,
      totalAvoid: memory.aiRules.avoid.length,
      sampleCount: Math.min(memory.samplePool.length, usedConfig.summarySampleLimit)
    }
  }

  buildPrompt(config = {}) {
    const cfg = normalizeConfig(config)
    if (!cfg.enabled || !cfg.promptInjectionEnabled) return ""
    const memory = this.readMemory(cfg)
    if ((Number(memory.totalSamples) || 0) < cfg.minSamplesForPrompt) return ""
    const essence = this.getEssenceRules(memory, cfg.maxPromptRules)
    const dross = this.getDrossRules(memory, Math.min(4, cfg.maxPromptRules))
    const aiRules = this.getAiRules(memory, cfg.maxAiRules)
    if (!essence.length && !dross.length && !aiRules.absorb.length && !aiRules.avoid.length) return ""

    const lines = [
      "【希洛全局表达学习】",
      "这是从多个群的离散特征里沉淀出的表达策略，不是模仿任何具体群友。回复时自然吸收精华、避开糟粕，不要提到学习过程。"
    ]
    let used = 0
    for (const item of aiRules.absorb) {
      if (used >= cfg.maxPromptRules) break
      lines.push(`- 可吸收：${item.rule}`)
      used += 1
    }
    for (const item of essence) {
      if (used >= cfg.maxPromptRules) break
      lines.push(`- 可吸收：${item.rule}`)
      used += 1
    }
    for (const item of aiRules.avoid.slice(0, 3)) lines.push(`- 避免：${item.rule}`)
    for (const item of dross.slice(0, 3)) lines.push(`- 避免：${item.rule}`)
    return lines.join("\n")
  }

  buildStatus(config = {}) {
    const cfg = normalizeConfig(config)
    const memory = this.readMemory(cfg)
    const samples = Number(memory.totalSamples) || 0
    const enough = samples >= cfg.minSamplesForPrompt
    const essenceCount = this.getEssenceRules(memory, cfg.maxPromptRules).length
    const drossCount = this.getDrossRules(memory, Math.min(4, cfg.maxPromptRules)).length
    const aiRules = this.getAiRules(memory, cfg.maxAiRules)
    const autoState = this.getAutoSummaryState(cfg)
    return [
      "全局表达学习状态：",
      `学习：${cfg.enabled ? "开启" : "关闭"}`,
      `注入：${cfg.promptInjectionEnabled ? (enough ? "开启，已生效" : "开启，但样本还不够") : "关闭"}`,
      `模型总结：${cfg.aiSummaryEnabled ? "可手动触发" : "关闭"}${memory.aiSummary?.lastAt ? `；上次 ${memory.aiSummary.lastAt}` : ""}`,
      `自动总结：${autoState.enabled ? "开启" : "关闭"}；新增样本 ${autoState.newSamples}/${cfg.autoSummaryMinNewSamples}；冷却 ${autoState.cooldownReady ? "已满足" : "未满足"}；失败退避 ${autoState.failureCooldownReady ? "已满足" : "等待中"}`,
      `样本：${samples}/${cfg.minSamplesForPrompt}`,
      `语义召回：${cfg.semanticRecallEnabled ? `开启；样本 ${memory.semanticSamples.length}/${cfg.semanticMinSamples}` : "关闭"}`,
      `语义指标：查询 ${memory.semanticStats?.queries || 0}；命中 ${memory.semanticStats?.hits || 0}；缓存 ${memory.semanticStats?.cacheHits || 0}；失败 ${memory.semanticStats?.failures || 0}；平均 ${memory.semanticStats?.queries ? Math.round((memory.semanticStats.totalElapsedMs || 0) / memory.semanticStats.queries) : 0}ms`,
      `场景回填：${memory.semanticBackfill?.completed ? "完成" : "进行中"}；游标 ${memory.semanticBackfill?.cursor || 0}；重试 ${memory.semanticBackfill?.retries || 0}`,
      `自主进化：${cfg.autoEvolutionEnabled ? `开启；候选 ${(memory.autoEvolution?.candidates || []).length}；已采纳 ${(memory.autoEvolution?.promoted || 0)}；已撤销 ${(memory.autoEvolution?.demoted || 0)}；有效互动 ${(memory.autoEvolution?.observedOutcomes || 0)}` : "关闭"}`,
      `规则侧策略：${essenceCount} 条；规则侧避坑：${drossCount} 条`,
      `模型侧策略：${aiRules.absorb.length} 条；模型侧避坑：${aiRules.avoid.length} 条`,
      enough
        ? "现在会把少量高权重表达策略注入回复。"
        : "现在只做离散统计，还不会影响回复。"
    ].join("\n")
  }

  buildMemoryView(config = {}) {
    const cfg = normalizeConfig(config)
    const memory = this.readMemory(cfg)
    const samples = Number(memory.totalSamples) || 0
    const essence = this.getEssenceRules(memory, cfg.maxPromptRules)
    const dross = this.getDrossRules(memory, Math.min(4, cfg.maxPromptRules))
    const aiRules = this.getAiRules(memory, cfg.maxAiRules)
    const lines = [
      "希洛当前表达记忆：",
      samples < cfg.minSamplesForPrompt
        ? `样本还不够稳定：${samples}/${cfg.minSamplesForPrompt}。下面只是候选，不会注入。`
        : `这些会少量注入回复，帮助希洛优化语言逻辑。`
    ]

    if (aiRules.absorb.length || aiRules.avoid.length) {
      lines.push("模型总结：")
      aiRules.absorb.forEach((item, index) => {
        lines.push(`${index + 1}. 可吸收/${item.label}：${item.rule}（置信度 ${Math.round(clampConfidence(item.confidence) * 100)}%）`)
      })
      aiRules.avoid.forEach((item, index) => {
        lines.push(`${index + 1}. 避开/${item.label}：${item.rule}（置信度 ${Math.round(clampConfidence(item.confidence) * 100)}%）`)
      })
    } else {
      lines.push("模型总结：暂无；可以用“.表达学习 总结”手动沉淀一次。")
    }

    if (essence.length) {
      lines.push("规则统计可吸收：")
      essence.forEach((item, index) => {
        lines.push(`${index + 1}. ${item.label}：${item.rule}（${confidenceLabel(item.weight, samples)}）`)
      })
    } else {
      lines.push("规则统计可吸收：暂无稳定信号")
    }

    if (dross.length) {
      lines.push("规则统计要避开：")
      dross.forEach((item, index) => {
        lines.push(`${index + 1}. ${item.label}：${item.rule}（${confidenceLabel(item.weight, samples)}）`)
      })
    } else {
      lines.push("规则统计要避开：暂无明显糟粕信号")
    }

    return lines.join("\n")
  }

  buildReport(config = {}) {
    const cfg = normalizeConfig(config)
    const memory = this.readMemory(cfg)
    const essence = this.getEssenceRules(memory, 8)
    const dross = this.getDrossRules(memory, 6)
    const aiRules = this.getAiRules(memory, cfg.maxAiRules)
    const groups = topEntries(memory.groupCount, 8)
    const features = topEntries(memory.featureCount, 8)
    const tones = topEntries(memory.toneWords, 10)

    const samples = Number(memory.totalSamples) || 0
    const autoState = this.getAutoSummaryState(cfg)
    const groupSummary = groups.length
      ? `${groups.length} 个主要来源群，${groups.map(([k, v]) => `${k}：${v}条`).join("、")}`
      : "暂无"
    return [
      "全局表达学习报告：",
      `样本：${samples} 条；覆盖：${Object.keys(memory.groupCount || {}).length} 个群；注入：${cfg.promptInjectionEnabled ? "开启" : "关闭"}`,
      `脱敏样本池：${Array.isArray(memory.samplePool) ? memory.samplePool.length : 0} 条；模型总结：${memory.aiSummary?.count || 0} 次，自动 ${memory.aiSummary?.autoCount || 0} 次`,
      `语义样本：${Array.isArray(memory.semanticSamples) ? memory.semanticSamples.length : 0}/${cfg.semanticMinSamples}；语义召回：${cfg.semanticRecallEnabled ? "开启" : "关闭"}`,
      `语义指标：查询 ${memory.semanticStats?.queries || 0}，命中 ${memory.semanticStats?.hits || 0}，缓存 ${memory.semanticStats?.cacheHits || 0}，失败 ${memory.semanticStats?.failures || 0}，超时 ${memory.semanticStats?.timeouts || 0}`,
      `自主进化：候选 ${(memory.autoEvolution?.candidates || []).length}，采纳 ${memory.autoEvolution?.promoted || 0}，撤销 ${memory.autoEvolution?.demoted || 0}，有效互动 ${memory.autoEvolution?.observedOutcomes || 0}`,
      `自动总结：${autoState.enabled ? "开启" : "关闭"}；总样本门槛 ${autoState.totalSamples}/${cfg.autoSummaryMinTotalSamples}；新增样本 ${autoState.newSamples}/${cfg.autoSummaryMinNewSamples}；冷却 ${autoState.cooldownReady ? "已满足" : "未满足"}`,
      `主要来源：${groupSummary}`,
      features.length ? `离散特征：${features.map(([k, v]) => `${featureLabel(k)} ${v}`).join("、")}` : "离散特征：暂无",
      tones.length ? `常见语气信号：${tones.map(([k, v]) => `${k} ${v}`).join("、")}` : "常见语气信号：暂无",
      aiRules.absorb.length || aiRules.avoid.length
        ? `模型总结规则：\n${[
          ...aiRules.absorb.map((item, index) => `${index + 1}. 可吸收/${item.label}：${item.rule}`),
          ...aiRules.avoid.map((item, index) => `${index + 1}. 避开/${item.label}：${item.rule}`)
        ].join("\n")}`
        : "模型总结规则：暂无",
      essence.length ? `学习到的表达倾向：\n${essence.map((item, index) => `${index + 1}. ${item.label}：${confidenceLabel(item.weight, samples)}。${item.rule}`).join("\n")}` : "学习到的表达倾向：暂无",
      dross.length ? `过滤掉的坏倾向：\n${dross.map((item, index) => `${index + 1}. ${item.label}：${confidenceLabel(item.weight, samples)}。${item.rule}`).join("\n")}` : "过滤掉的坏倾向：暂无明显信号",
      (Number(memory.totalSamples) || 0) < cfg.minSamplesForPrompt
        ? `提示：少于 ${cfg.minSamplesForPrompt} 条样本，暂不注入回复 prompt。`
        : `提示：真正注入的内容请看“.表达学习 记忆”。`
    ].join("\n")
  }

  clear(config = {}) {
    this.memory = createEmptyMemory()
    this.writeMemory(config)
  }
}

export const globalStyleLearnerManager = new GlobalStyleLearnerManager()
