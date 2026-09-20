import fs from "fs"
import path from "path"
import { isToneCorrectionMessage } from "../../utils/chatFailureReply.js"
import { safeTruncateUnicode } from "../../utils/unicodeText.js"

const DEFAULT_BAD_PATTERNS = [
  "我是不是太啰嗦",
  "是不是说多了",
  "好像有点啰嗦",
  "扯远了",
  "作为AI",
  "作为一个AI",
  "我是AI",
  "我是一个AI",
  "很抱歉",
  "抱歉，我不能",
  "我无法满足",
  "我不能满足",
  "我不能帮你",
  "无法协助"
]

const FEEDBACK_TAG_RULES = [
  { key: "too_hard", label: "拒绝太硬", pattern: /太硬|强硬|拒绝|不该拒绝|别拒绝|不要这样拒绝/ },
  { key: "too_verbose", label: "太啰嗦", pattern: /啰嗦|话多|太长|废话|太多|少说/ },
  { key: "too_customer", label: "客服腔", pattern: /客服|官方|模板|机器人|说明书|不自然/ },
  { key: "good_tone", label: "语气好", pattern: /不错|很好|挺好|语气好|这个好|这样好|喜欢/ },
  { key: "bad_tone", label: "语气不对", pattern: /语气不对|怪|别这样|不喜欢|不对劲|阴阳怪气/ }
]

const HARD_BOT_IDENTITY_DENIAL_RE = /(?:^|[，,。.!！?？；;\s])(?:(?:我)?(?:才|又|可|真)?(?:不是|不是什么)|我怎么可能是|谁是|哪是|哪有什么).{0,10}(?:机器人|AI|人工智能|bot)(?:啦|啊|呀|诶|哦|嘛|呢)?/gi
const HARD_HUMAN_IDENTITY_CLAIM_RE = /(?:我(?:可|就|当然)?是(?:个)?)?(?:活人|真人)(?:一个|一枚|本人)(?:啦|啊|呀|诶|哦|嘛|呢)?[😂🤣😅]*/g
const FIRST_PERSON_HUMAN_CLAIM_RE = /我(?:可|就|当然)?是(?:个)?(?:活人|真人)(?:啦|啊|呀|诶|哦|嘛|呢)?/g
// 模型可能从聊天历史里复读出旧版固定句式；被问身份时一并清掉，避免永远同一句
const CANNED_IDENTITY_MARKER_RE = /别给我扣(?:机器人)?帽子(?:…+|[。.!！]*)/g

export function looksLikeBotIdentityChallenge(text = "", { botNames = [] } = {}) {
  const content = String(text || "").replace(/\s+/g, " ").trim()
  if (!content) return false
  const escapedNames = (Array.isArray(botNames) ? botNames : [botNames])
    .map(name => String(name || "").trim())
    .filter(Boolean)
    .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  const target = ["你", "妳", "希洛", "小希", ...escapedNames].join("|")
  const identity = "机器人|AI|人工智能|bot"
  return new RegExp(`(?:${target}).{0,16}(?:像|是|是不是|不就是|不会是|难道是|怎么.{0,4}像).{0,10}(?:${identity})`, "i").test(content) ||
    new RegExp(`(?:${target}).{0,16}(?:不是|不像).{0,8}(?:真人|活人)`, "i").test(content) ||
    new RegExp(`(?:${identity}).{0,8}(?:味|感).{0,8}(?:重|浓|足)|(?:${target}).{0,12}(?:${identity})(?:味|感)`, "i").test(content)
}

// 整条回复删掉否认后只剩语气词时，轮换取一句"轻巧带过、不硬辩"的话。
// 轮换（而非固定单句）保证连续多次被问也不会重复。
export const IDENTITY_DEFLECTION_POOL = [
  "欸，怎么突然开始审我啦",
  "哈哈，被你这么一问我还真愣了一下",
  "你说是就是啦，聊天嘛",
  "打住打住，换个话题聊",
  "嗯？突然这么认真，搞得我怪紧张的",
  "这个问题先欠着，你猜猜看嘛"
]

let identityDeflectionCursor = 0

function nextIdentityDeflection() {
  const line = IDENTITY_DEFLECTION_POOL[identityDeflectionCursor]
  identityDeflectionCursor = (identityDeflectionCursor + 1) % IDENTITY_DEFLECTION_POOL.length
  return `${line}。`
}

const LEAD_NOISE_RE = /^[，,。.!！?？；;、~～\s…😂🤣😅😋❤]+/u

function isFillerOnlyText(text = "") {
  const stripped = String(text || "")
    .replace(/(?:哈+|嘻+|嘿+|呵+|嗯+|哼+|啊+|呀+|哦+|噢+|额+|呃+|欸+|诶+|emm+)+/gi, "")
    .replace(/[，,。.!！?？；;、~～\s…😂🤣😅😋❤]+/gu, "")
  return stripped.length < 2
}

function softenIdentityDenial(text = "", context = {}) {
  let output = String(text || "")
  if (!looksLikeBotIdentityChallenge(context.userText, context)) return output
  if (!HARD_BOT_IDENTITY_DENIAL_RE.test(output) &&
    !HARD_HUMAN_IDENTITY_CLAIM_RE.test(output) &&
    !FIRST_PERSON_HUMAN_CLAIM_RE.test(output) &&
    !CANNED_IDENTITY_MARKER_RE.test(output)) return output

  HARD_BOT_IDENTITY_DENIAL_RE.lastIndex = 0
  HARD_HUMAN_IDENTITY_CLAIM_RE.lastIndex = 0
  FIRST_PERSON_HUMAN_CLAIM_RE.lastIndex = 0
  CANNED_IDENTITY_MARKER_RE.lastIndex = 0
  output = output
    // 只删"硬否认/活人宣称/旧固定句"片段，其余自然内容原样保留——
    // 回复的多样性来自模型本身，而不是这里再塞一句固定话术
    .replace(HARD_BOT_IDENTITY_DENIAL_RE, " ")
    .replace(HARD_HUMAN_IDENTITY_CLAIM_RE, " ")
    .replace(FIRST_PERSON_HUMAN_CLAIM_RE, " ")
    .replace(CANNED_IDENTITY_MARKER_RE, " ")
    .replace(/([，,、;；])[，,、;；\s]*([。.!！?？…])/g, "$2")
    .replace(/[，,、;；]{2,}/g, "，")
    .replace(/[ \t]{2,}/g, " ")
    .replace(LEAD_NOISE_RE, "")
    .replace(/[，,、;；~～\s]+$/g, "")
    .trim()

  if (output && !isFillerOnlyText(output)) return output
  return nextIdentityDeflection()
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function nowIso() {
  return new Date().toISOString()
}

function compactText(text = "", max = 900) {
  return safeTruncateUnicode(String(text || "").replace(/\s+/g, " ").trim(), max)
}

function deescalateToneCorrection(text = "", context = {}) {
  if (!isToneCorrectionMessage(context.userText)) return String(text || "")

  const cleaned = String(text || "")
    .replace(/[😋❤♥💗💕💞😘🥰]+/gu, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
  const sincerelyAcknowledges = /(?:你说得对|你说的对|确实|刚才).{0,30}(?:不对|过了|不舒服|顶着|收一下|改|注意)/.test(cleaned) ||
    /(?:我收一下|我改|我注意|不该这样|听着确实不舒服)/.test(cleaned)
  const keepsProvoking = /(?:你别教我做事|别气嘛|不跟你犟|你舍得嘛|凭啥|想得美|自己来|我又不是你保姆|你少来|嘿嘿|嘴快|急什么|开不起玩笑)/.test(cleaned)

  if (sincerelyAcknowledges && !keepsProvoking) return cleaned
  return "你说得对，刚才那几句有点顶着你说了，听着确实不舒服。我收一下。"
}

function removeUnpromptedIntimacy(text = "") {
  return String(text || "")
    // 只吞昵称后的行内空白，保留换行——\s 会把空行吞成空格，
    // 连 markdown 表格/多段文本的行结构都会被压扁
    .replace(/(?:宝宝|宝贝|亲爱的|老婆|老公|哥哥|妹妹)[，,、 \t]*/g, "你")
    .replace(/(?:欸|嗯嗯?|诶)[，,、 \t]*别突然这么叫呀[，,、 \t]*/g, "叫我希洛就好。")
    .replace(/(?:我)?有点不好意思(?:啦|欸)?[。！？!?…]*/g, "谢谢。")
    .replace(/[ \t]{2,}/g, " ")
    .trim()
}

function normalizeConfig(config = {}) {
  return {
    enabled: config.enabled !== false,
    rewriteHardRefusal: config.rewriteHardRefusal !== false,
    stripSelfDoubt: config.stripSelfDoubt !== false,
    stripCustomerTone: config.stripCustomerTone !== false,
    avoidUnpromptedIntimacy: config.avoidUnpromptedIntimacy !== false,
    maxPromptItems: Math.max(0, Math.min(8, Number(config.maxPromptItems) || 4)),
    badPatterns: Array.isArray(config.badPatterns) && config.badPatterns.length
      ? config.badPatterns
      : DEFAULT_BAD_PATTERNS
  }
}

export class PersonaFeedbackManager {
  constructor({ cwd = process.cwd(), logger = globalThis.logger } = {}) {
    this.cwd = cwd
    this.logger = logger
    this.lastReplies = new Map()
    this.lastFeedback = new Map()
  }

  getDataDir() {
    return path.join(this.cwd, "plugins/shiloh-plugin/data/persona_feedback")
  }

  getFeedbackPath() {
    return path.join(this.getDataDir(), "feedback.jsonl")
  }

  getSummaryPath() {
    return path.join(this.getDataDir(), "summary.json")
  }

  rememberBotReply(e, output = "") {
    const groupId = String(e?.group_id || "private")
    const key = this.getConversationKey(e)
    const record = {
      groupId,
      userId: String(e?.user_id || ""),
      messageId: e?.message_id ? String(e.message_id) : "",
      text: compactText(output, 1600),
      at: Date.now()
    }
    this.lastReplies.set(key, record)
    if (groupId !== "private") this.lastReplies.set(`group:${groupId}`, record)
  }

  getConversationKey(e) {
    return `${String(e?.group_id || "private")}:${String(e?.user_id || "")}`
  }

  getRecentBotReply(e) {
    const direct = this.lastReplies.get(this.getConversationKey(e))
    if (direct) return direct
    const groupId = String(e?.group_id || "private")
    return this.lastReplies.get(`group:${groupId}`) || null
  }

  classifyFeedback(text = "") {
    const content = String(text || "")
    const tags = FEEDBACK_TAG_RULES
      .filter(rule => rule.pattern.test(content))
      .map(rule => ({ key: rule.key, label: rule.label }))
    return tags.length ? tags : [{ key: "note", label: "其他反馈" }]
  }

  parseFeedbackText(msg = "") {
    return String(msg || "")
      .replace(/^[#＃.。]\s*希洛反馈\s*/u, "")
      .trim()
  }

  async recordFeedback(e, msg = "") {
    if (!e?.isMaster) return "只有主人可以记录希洛反馈。"
    const feedback = this.parseFeedbackText(msg)
    if (!feedback) return "格式：.希洛反馈 太硬了 / 太啰嗦 / 这个语气好"

    const reply = this.getRecentBotReply(e)
    const tags = this.classifyFeedback(feedback)
    const record = {
      at: nowIso(),
      groupId: e?.group_id ? String(e.group_id) : "",
      userId: e?.user_id ? String(e.user_id) : "",
      feedback,
      tags: tags.map(tag => tag.key),
      tagLabels: tags.map(tag => tag.label),
      botReply: reply?.text || "",
      botMessageId: reply?.messageId || "",
      sourceMessageId: e?.message_id ? String(e.message_id) : ""
    }

    ensureDir(this.getDataDir())
    fs.appendFileSync(this.getFeedbackPath(), `${JSON.stringify(record)}\n`, "utf8")
    this.updateSummary(tags, feedback)
    this.lastFeedback.set(this.getConversationKey(e), record)
    return `记下来了：${tags.map(tag => tag.label).join("、")}`
  }

  getLatestFeedback(e) {
    return this.lastFeedback.get(this.getConversationKey(e)) || null
  }

  readSummary() {
    try {
      const file = this.getSummaryPath()
      if (!fs.existsSync(file)) return { tags: {}, recent: [] }
      const data = JSON.parse(fs.readFileSync(file, "utf8"))
      return data && typeof data === "object" ? { tags: data.tags || {}, recent: data.recent || [] } : { tags: {}, recent: [] }
    } catch (error) {
      this.logger?.warn?.(`[希洛反馈] 读取摘要失败: ${error.message}`)
      return { tags: {}, recent: [] }
    }
  }

  updateSummary(tags = [], feedback = "") {
    const summary = this.readSummary()
    for (const tag of tags) {
      const item = summary.tags[tag.key] || { key: tag.key, label: tag.label, count: 0 }
      item.label = tag.label
      item.count = (Number(item.count) || 0) + 1
      summary.tags[tag.key] = item
    }
    summary.recent = [
      { at: nowIso(), feedback: compactText(feedback, 160), tags: tags.map(tag => tag.key) },
      ...(summary.recent || [])
    ].slice(0, 30)
    ensureDir(this.getDataDir())
    fs.writeFileSync(this.getSummaryPath(), JSON.stringify(summary, null, 2), "utf8")
  }

  buildFeedbackPrompt(config = {}) {
    const guard = normalizeConfig(config)
    if (!guard.enabled || guard.maxPromptItems <= 0) return ""
    const summary = this.readSummary()
    const sorted = Object.values(summary.tags || {})
      .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
      .slice(0, guard.maxPromptItems)
    if (!sorted.length) return ""

    const lines = [
      "【希洛近期微雕反馈】",
      "这些是主人对希洛回复风格的长期修正，回复时自然遵守，不要提到这些规则本身。"
    ]
    for (const item of sorted) {
      if (item.key === "too_hard") lines.push(`- ${item.label}：拒绝时别冷冰冰，不要直接甩“不能/无法”；先接住意图，再给替代做法。`)
      else if (item.key === "too_verbose") lines.push(`- ${item.label}：少铺垫，能短就短，别在结尾自我评价啰嗦。`)
      else if (item.key === "too_customer") lines.push(`- ${item.label}：不要客服腔、汇报腔、说明书腔，像熟人自然说。`)
      else if (item.key === "good_tone") lines.push(`- ${item.label}：保持最近被认可的自然、熟人感表达。`)
      else if (item.key === "bad_tone") lines.push(`- ${item.label}：语气要更贴近希洛，不要突然生硬或阴阳怪气。`)
      else lines.push(`- ${item.label}：参考主人最近反馈，优先自然和有用。`)
    }
    return lines.join("\n")
  }

  guardReply(text = "", config = {}, context = {}) {
    const guard = normalizeConfig(config)
    if (!guard.enabled) return String(text || "")
    let output = String(text || "").trim()
    if (!output) return ""

    if (guard.stripSelfDoubt) {
      output = output
        .replace(/(?:唔|呜|嗯|诶|欸|啊|呃|哎呀?|嘛|那个)?[，,、\s]*(?:我)?(?:是不是|好像|感觉)?(?:说(?:得|的)?有点多了|说多了|讲多了|说太多了|有点啰嗦|太啰嗦了?|有点话多|太话多了?|扯远了|跑题了)[。！？!?~～…\s]*/g, "")
        .trim()
    }

    if (guard.stripCustomerTone) {
      output = output
        .replace(/作为(?:一个)?(?:AI|人工智能|机器人|助手)[，,、\s]*/gi, "")
        .replace(/很抱歉[，,、\s]*/g, "")
        .replace(/抱歉[，,、\s]*/g, "")
        .replace(/请您/g, "你")
        .replace(/建议您/g, "可以")
        .replace(/希望(?:以上|这些|这).*?(?:帮到你|有帮助)[。.!！]*/g, "")
        .trim()
    }

    output = softenIdentityDenial(output, context)
    output = deescalateToneCorrection(output, context)
    if (guard.avoidUnpromptedIntimacy) output = removeUnpromptedIntimacy(output)

    if (guard.rewriteHardRefusal) {
      output = output
        .replace(/我(?:不能|无法|不可以|没办法)(?:帮你|为你|替你)?(?:直接)?(?:完成|提供|满足|处理|执行|做)?(?:这个|这件事|该请求|你的请求)?[。.!！]?/g, "这个我不太适合直接这样做。")
        .replace(/(?:无法|不能)协助(?:你)?(?:完成|处理)?(?:这个|这件事|该请求)?[。.!！]?/g, "这个我不太适合直接这样做。")
        .replace(/我(?:必须|需要)拒绝(?:这个|该请求|你的请求)?[。.!！]?/g, "这个我不太适合直接这样做。")
        .replace(/这个我不太适合直接这样做。\s*这个我不太适合直接这样做。/g, "这个我不太适合直接这样做。")
        .trim()
    }

    for (const pattern of guard.badPatterns) {
      const needle = String(pattern || "").trim()
      if (!needle) continue
      if (output.includes(needle)) {
        output = output.split(needle).join("")
      }
    }

    return output.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim()
  }
}

export const personaFeedbackManager = new PersonaFeedbackManager()
