import {adminRecord} from '../../../contracts/groupAdmin.js'
import type {ModerationConfig,ModerationContext,RuleContext,ModerationResult,CompoundRuleConfig} from '../../../contracts/groupAdmin.js'
import { safeTruncateUnicode } from "../../models/domain/unicodeText.js"
export const DEFAULT_GROUP_MODERATION_CONFIG:ModerationConfig = {
  enabled: false,
  enabledGroups: [],
  globalAdmins: [],
  groupAdmins: [],
  minActiveLevel: 5,
  inspectLowLevelOnly: true,
  publicReportEnabled: true,
  mentionConfiguredAdminsInGroup: true,
  forwardEvidenceToAdmins: true,
  evidenceMaxChars: 1200,
  modelReviewEnabled: false,
  modelThreshold: 0.55,
  adTemplateSimilarityThreshold: 0.58,
  adTemplateWeight: 0.55,
  adCorpusAutoCollect: true,
  ignoredBotIds: [],
  floodEnabled: true,
  floodMaxLevel: 5,
  floodWindowSeconds: 10,
  floodMaxMessages: 8,
  floodConfidence: 0.9,
  overlongMessage: {
    enabled: false,
    maxLength: 1500,
    forwardEnabled: true
  },
  burstMessage: {
    enabled: false,
    windowSeconds: 5,
    maxMessages: 6,
    muteSeconds: 30,
    forwardEnabled: true
  },
  adScan: {
    enabled: true
  },
  compoundRules: [],
  adTemplates: [
    "AI 培训公司 需要 软件工程师 线上培训讲课 要求 6年以上代码经验 前端 后端 晚上时间 在家即可上课 无需外出 保障收益 加创始人微信",
    "扫码进群 加群二维码 群聊邀请 长按识别二维码 进群领取福利",
    "推广加V 加微信 私聊领取 名额有限 免费带 兼职副业 日结佣金",
    "一念成仙 免@授权 全量申请 qm.qq.com 群跳转 联动关注活动",
    "B站关注 查阅详细 账号UID 参与代表同意使用 联动关注活动",
    "已匹配到本群老婆 结缘 扣除积分 选ta 一念成仙 免@授权",
    "合并转发聊天记录 广告引流 推广话术 加群 加微信 二维码"
  ],
  thresholds: {
    report: 0.7,
    recall: 0.85,
    mute: 0.9,
    kick: 0.97
  },
  actions: {
    recallEnabled: false,
    muteEnabled: false,
    kickEnabled: false,
    muteSeconds: 600
  },
  reportTemplate: "群管检测：命中规则{rules},置信度:{confidence}。{actionText}{evidenceText}"
}

const RULE_DEFINITIONS:{name:string;weight:number;test:(text:string,context:RuleContext)=>boolean}[] = [
  {
    name: "包含外链",
    weight: 0.22,
    test: text => /(https?:\/\/|www\.|qm\.qq\.com\/q\/|mqqapi:\/\/|t\.cn\/|u\.jd\.com|tb\.cn|m.tb.cn|dwz\.cn|url\.cn|bit\.ly|tinyurl\.com)/i.test(text)
  },
  {
    name: "包含群邀请",
    weight: 0.2,
    test: text => /(加群|群号|QQ群|qq\s*群|邀请.*群|进群|入群|群聊|群跳转|qm\.qq\.com).{0,24}(\d{6,12}|链接|二维码|福利|领取|申请|授权|https?:\/\/|qm\.qq\.com)/i.test(text)
      || /(https?:\/\/)?qm\.qq\.com\/q\//i.test(text)
  },
  {
    name: "疑似招募话术",
    weight: 0.2,
    test: text => /(招募|招人|收人|拉人|推广|地推|代理|兼职|日结|周结|躺赚|副业|宝妈|学生党|长期有效|免费带|带你赚|名额有限|私聊|加[我vV]|加微信|加v|加V|v我|V我|薇信|领取福利|关注.*活动|全量申请|免@授权)/i.test(text)
  },
  {
    name: "包含联系方式",
    weight: 0.16,
    test: text => /(微信|VX|vx|v信|薇信|企鹅|QQ|电话|手机号|联系|加v|加V|v我|V我).{0,16}([a-zA-Z][-_a-zA-Z0-9]{4,}|\d{6,12})/i.test(text)
      || /(?:加|私|滴|看)?[vV](?:x|信)?[:：\s-]*[a-zA-Z][-_a-zA-Z0-9]{4,}/i.test(text)
  },
  {
    name: "疑似违规交易",
    weight: 0.22,
    test: text => /(博彩|棋牌|投注|返钱|返利|佣金|包赔|色情|约炮|裸聊|外挂|脚本|代打|代练|黑号|洗钱|跑分|卖课|课程代理)/i.test(text)
  },
  {
    name: "疑似图片广告",
    weight: 0.16,
    test: (text, context) => Number(context.imageCount || 0) > 0 && (context.textLength <= 20 || /(二维码|扫码|长按|加群|进群|入群|加v|加V|微信|VX|vx)/i.test(text))
  },
  {
    name: "疑似二维码引流",
    weight: 0.22,
    test: (text, context) => /(二维码|扫码|长按识别|扫一扫|群二维码|加群码|进群码)/i.test(text)
      || (Number(context.imageCount || 0) > 0 && /(加群|进群|入群|加v|加V|微信|VX|vx|私聊|领取|福利)/i.test(text))
  },
  {
    name: "疑似授权推广",
    weight: 0.22,
    test: text => /(免@授权|全量申请|一念成仙|联动关注|B站关注|账号UID|点击.*关注按钮|选ta|本群老婆|结缘)/i.test(text)
  },
  {
    name: "低活跃合并转发",
    weight: 0.34,
    test: (_text, context) => Number(context.forwardCount || 0) > 0 && Number(context.memberLevel) <= Number(context.minActiveLevel)
  },
  {
    name: "频繁艾特",
    weight: 0.12,
    test: (_text, context) => Number(context.atCount || 0) >= 3
  }
]

function normalizeAdTemplateText(text = "") {
  return String(text || "")
    .toLowerCase()
    .replace(/\[cq:[^\]]+\]/gi, " ")
    .replace(/https?:\/\/\S+|www\.\S+/gi, " 链接 ")
    .replace(/(?:微信|vx|v信|薇信|qq|电话|手机号|联系)[:：\s-]*[a-z0-9_-]{4,}/gi, " 联系方式 ")
    .replace(/\d{5,}/g, " 数字 ")
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, "")
}

function buildCharNgrams(text = "", size = 2) {
  const normalized = normalizeAdTemplateText(text)
  if (!normalized) return new Set<string>()
  if (normalized.length <= size) return new Set([normalized])
  const grams = new Set<string>()
  for (let index = 0; index <= normalized.length - size; index++) {
    grams.add(normalized.slice(index, index + size))
  }
  return grams
}

function jaccardSimilarity(a:Set<string>, b:Set<string>) {
  if (!a.size || !b.size) return 0
  let intersection = 0
  for (const item of a) {
    if (b.has(item)) intersection++
  }
  return intersection / (a.size + b.size - intersection)
}

// 样本条目变多后每条消息都要对全库做 bigram Jaccard，按归一化文本缓存 gram 集合
const templateGramsCache = new Map<string,Set<string>>()
const TEMPLATE_GRAMS_CACHE_MAX = 2048

function getTemplateGrams(normalizedTemplate:string) {
  let grams = templateGramsCache.get(normalizedTemplate)
  if (!grams) {
    grams = buildCharNgrams(normalizedTemplate)
    if (templateGramsCache.size >= TEMPLATE_GRAMS_CACHE_MAX) templateGramsCache.clear()
    templateGramsCache.set(normalizedTemplate, grams)
  }
  return grams
}

export function findAdTemplateMatch(text = "", config = DEFAULT_GROUP_MODERATION_CONFIG, extraTemplates:string[] = []) {
  const source = normalizeAdTemplateText(text)
  if (source.length < 12) return null
  const sourceGrams = buildCharNgrams(source)
  const threshold = normalizeNumber(config.adTemplateSimilarityThreshold, DEFAULT_GROUP_MODERATION_CONFIG.adTemplateSimilarityThreshold, 0, 1)
  const candidates = [
    ...normalizeStringList(config.adTemplates).map(template => ({ template, origin: "seed" })),
    ...normalizeStringList(extraTemplates).map(template => ({ template, origin: "corpus" }))
  ]
  const seen = new Set<string>()
  let best = null
  for (const candidate of candidates) {
    const normalizedTemplate = normalizeAdTemplateText(candidate.template)
    if (normalizedTemplate.length < 12) continue
    if (seen.has(normalizedTemplate)) continue
    seen.add(normalizedTemplate)
    const templateGrams = getTemplateGrams(normalizedTemplate)
    const similarity = jaccardSimilarity(sourceGrams, templateGrams)
    const contains = source.includes(normalizedTemplate) || normalizedTemplate.includes(source)
    const score = contains ? Math.max(similarity, 0.96) : similarity
    if (!best || score > best.score) {
      best = { score, template: String(candidate.template).slice(0, 80), origin: candidate.origin }
    }
  }
  return best && best.score >= threshold ? best : null
}

export function normalizeStringList(value:unknown) {
  if (!Array.isArray(value)) return []
  return value.map(item => String(item).trim()).filter(Boolean)
}

function normalizeNumber(value:unknown, fallback:number, min:number, max:number) {
  const number = Number(value)
  const normalized = Number.isFinite(number) ? number : fallback
  return Math.min(max, Math.max(min, normalized))
}

function normalizeGroupAdmins(value:unknown) {
  if (!Array.isArray(value)) return []
  return value
    .map(value => {
      const item=adminRecord(value)
      const groupId = String(item.groupId ?? item.group_id ?? item.group ?? "").trim()
      const admins = normalizeStringList(item.admins ?? item.users ?? item.userIds)
      if (!groupId || !admins.length) return null
      return { groupId, admins }
    })
    .filter(item => item !== null)
}

export function normalizeGroupModerationConfig(input:unknown = {}):ModerationConfig {
  const raw=adminRecord(input)
  const thresholds = { ...DEFAULT_GROUP_MODERATION_CONFIG.thresholds, ...adminRecord(raw.thresholds) }
  const actions = { ...DEFAULT_GROUP_MODERATION_CONFIG.actions, ...adminRecord(raw.actions) }
  const config = {
    ...DEFAULT_GROUP_MODERATION_CONFIG,
    ...(raw || {}),
    thresholds,
    actions
  }

  for(const key of ['enabled','inspectLowLevelOnly','publicReportEnabled','forwardEvidenceToAdmins','modelReviewEnabled'] as const)config[key]=typeof raw[key]==='boolean'?raw[key]:DEFAULT_GROUP_MODERATION_CONFIG[key]
  config.reportTemplate=typeof raw.reportTemplate==='string'?raw.reportTemplate:DEFAULT_GROUP_MODERATION_CONFIG.reportTemplate
  const rawActions=adminRecord(raw.actions)
  for(const key of ['recallEnabled','muteEnabled','kickEnabled'] as const)config.actions[key]=typeof rawActions[key]==='boolean'?rawActions[key]:DEFAULT_GROUP_MODERATION_CONFIG.actions[key]
  config.enabledGroups = normalizeStringList(config.enabledGroups)
  config.globalAdmins = normalizeStringList(config.globalAdmins)
  config.groupAdmins = normalizeGroupAdmins(config.groupAdmins)
  config.mentionConfiguredAdminsInGroup = config.mentionConfiguredAdminsInGroup !== false
  config.minActiveLevel = normalizeNumber(config.minActiveLevel, DEFAULT_GROUP_MODERATION_CONFIG.minActiveLevel, 0, 100)
  config.evidenceMaxChars = Math.floor(normalizeNumber(config.evidenceMaxChars, DEFAULT_GROUP_MODERATION_CONFIG.evidenceMaxChars, 200, 5000))
  config.modelThreshold = normalizeNumber(config.modelThreshold, DEFAULT_GROUP_MODERATION_CONFIG.modelThreshold, 0, 1)
  config.adTemplateSimilarityThreshold = normalizeNumber(config.adTemplateSimilarityThreshold, DEFAULT_GROUP_MODERATION_CONFIG.adTemplateSimilarityThreshold, 0, 1)
  config.adTemplateWeight = normalizeNumber(config.adTemplateWeight, DEFAULT_GROUP_MODERATION_CONFIG.adTemplateWeight, 0, 1)
  config.adCorpusAutoCollect = config.adCorpusAutoCollect !== false
  config.ignoredBotIds = normalizeStringList(config.ignoredBotIds)
  config.floodEnabled = config.floodEnabled !== false
  config.floodMaxLevel = Math.floor(normalizeNumber(config.floodMaxLevel, DEFAULT_GROUP_MODERATION_CONFIG.floodMaxLevel, 0, 100))
  config.floodWindowSeconds = Math.floor(normalizeNumber(config.floodWindowSeconds, DEFAULT_GROUP_MODERATION_CONFIG.floodWindowSeconds, 3, 600))
  config.floodMaxMessages = Math.floor(normalizeNumber(config.floodMaxMessages, DEFAULT_GROUP_MODERATION_CONFIG.floodMaxMessages, 3, 100))
  config.floodConfidence = normalizeNumber(config.floodConfidence, DEFAULT_GROUP_MODERATION_CONFIG.floodConfidence, 0, 1)
  const rawOverlong = adminRecord(raw.overlongMessage)
  config.overlongMessage = {
    enabled: rawOverlong.enabled === true,
    maxLength: Math.floor(normalizeNumber(rawOverlong.maxLength, DEFAULT_GROUP_MODERATION_CONFIG.overlongMessage.maxLength, 100, 20000)),
    forwardEnabled: rawOverlong.forwardEnabled !== false
  }
  const rawBurst = adminRecord(raw.burstMessage)
  config.burstMessage = {
    enabled: rawBurst.enabled === true,
    windowSeconds: Math.floor(normalizeNumber(rawBurst.windowSeconds, DEFAULT_GROUP_MODERATION_CONFIG.burstMessage.windowSeconds, 2, 600)),
    maxMessages: Math.floor(normalizeNumber(rawBurst.maxMessages, DEFAULT_GROUP_MODERATION_CONFIG.burstMessage.maxMessages, 3, 100)),
    muteSeconds: Math.floor(normalizeNumber(rawBurst.muteSeconds, DEFAULT_GROUP_MODERATION_CONFIG.burstMessage.muteSeconds, 0, 2592000)),
    forwardEnabled: rawBurst.forwardEnabled !== false
  }
  // 广告/刷屏检测默认开启；显式 false 才关闭（关闭后只保留超长/连发折叠）
  config.adScan = { enabled: adminRecord(raw.adScan).enabled !== false }
  config.compoundRules = normalizeCompoundRules(raw.compoundRules)
  config.adTemplates = normalizeStringList(config.adTemplates)
  config.thresholds.report = normalizeNumber(config.thresholds.report, 0.7, 0, 1)
  config.thresholds.recall = normalizeNumber(config.thresholds.recall, 0.85, 0, 1)
  config.thresholds.mute = normalizeNumber(config.thresholds.mute, 0.9, 0, 1)
  config.thresholds.kick = normalizeNumber(config.thresholds.kick, 0.97, 0, 1)
  config.actions.muteSeconds = Math.floor(normalizeNumber(config.actions.muteSeconds, 600, 60, 2592000))
  return config
}

export function clamp01(value:unknown) {
  return Math.min(1, Math.max(0, Number(value) || 0))
}

// 复合规则：连发 + 单条最长/总字数等条件全部满足才触发；每群最多 5 条，评估时最新的（列表末尾）优先
export const COMPOUND_RULES_LIMIT = 5
export function normalizeCompoundRules(value:unknown):CompoundRuleConfig[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, COMPOUND_RULES_LIMIT).map((item, index) => {
    const raw = adminRecord(item)
    return {
      name: safeTruncateUnicode(String(raw.name || `规则${index + 1}`).trim(), 20) || `规则${index + 1}`,
      enabled: raw.enabled === true,
      burstCount: Math.floor(normalizeNumber(raw.burstCount, 5, 2, 100)),
      windowSeconds: Math.floor(normalizeNumber(raw.windowSeconds, 5, 2, 600)),
      maxLength: Math.floor(normalizeNumber(raw.maxLength, 0, 0, 20000)),
      totalLength: Math.floor(normalizeNumber(raw.totalLength, 0, 0, 50000)),
      recall: raw.recall !== false,
      forward: raw.forward !== false,
      muteSeconds: Math.floor(normalizeNumber(raw.muteSeconds, 0, 0, 2592000))
    }
  })
}

export function formatActionName(action:string) {
  const map:Record<string,string> = {
    report: "提醒",
    recall: "撤回",
    mute: "禁言",
    kick: "踢出"
  }
  return map[action] || action
}

export function buildModerationReport(result:ModerationResult, config = DEFAULT_GROUP_MODERATION_CONFIG) {
  const rules = `[${(result.rules || []).map(rule => JSON.stringify(String(rule))).join(", ")}]`
  const confidence = clamp01(result.confidence).toFixed(2)
  const actionText = result.action && result.action !== "report"
    ? `处理动作:${formatActionName(result.action)}。`
    : ""
  const evidenceText = result.evidenceForwarded ? "证据已转发到群管理员私聊" : ""
  const template = config.reportTemplate || DEFAULT_GROUP_MODERATION_CONFIG.reportTemplate
  return template
    .replaceAll("{rules}", rules)
    .replaceAll("{confidence}", confidence)
    .replaceAll("{action}", result.action || "report")
    .replaceAll("{actionText}", actionText)
    .replaceAll("{evidenceText}", evidenceText)
    .trim()
}

export function analyzeModerationRules({ text = "", memberLevel, imageCount = 0, atCount = 0, forwardCount = 0 }:ModerationContext = {}, config = DEFAULT_GROUP_MODERATION_CONFIG, { extraTemplates = [] }:{extraTemplates?:string[]} = {}) {
  const rules = []
  let confidence = 0
  const levelNumber = Number(memberLevel)
  if (Number.isFinite(levelNumber) && levelNumber <= Number(config.minActiveLevel)) {
    rules.push("低活跃等级")
    confidence += 0.24
  }

  const context = {
    imageCount,
    atCount,
    forwardCount,
    memberLevel: levelNumber,
    minActiveLevel: config.minActiveLevel,
    textLength: String(text || "").trim().length
  }

  for (const rule of RULE_DEFINITIONS) {
    if (rule.test(String(text || ""), context)) {
      rules.push(rule.name)
      confidence += rule.weight
    }
  }

  const templateMatch = findAdTemplateMatch(text, config, extraTemplates)
  if (templateMatch) {
    rules.push(templateMatch.origin === "corpus" ? "命中广告样本库" : "命中广告模板")
    confidence += config.adTemplateWeight
  }

  if (rules.includes("低活跃等级") && rules.length >= 3) confidence += 0.12
  if (rules.includes("低活跃等级") && rules.includes("低活跃合并转发")) confidence += 0.12
  if (rules.includes("包含外链") && rules.includes("疑似招募话术")) confidence += 0.1
  return {
    rules: [...new Set(rules)],
    confidence: clamp01(confidence)
  }
}
