export const LOCAL_EMOJI_TOOL_NAME = "sendLocalEmojiTool"

const REMOTE_EMOJI_SEARCH_PATTERNS = [
  /(?:网上|网络|在线|堆糖).{0,12}(?:搜|找|来|发|要)?.{0,8}(?:表情包|表情|梗图|反应图)/i
]

const EXPLICIT_EMOJI_REQUEST_PATTERNS = [
  /表情包|斗图/i,
  /(?:来|发|给|整|甩|丢|配|找|搜).{0,12}(?:表情|梗图|反应图)/i,
  /(?:表情|梗图|反应图).{0,8}(?:来一个|来一张|发一个|发一张|整一个|整一张|配一个|配一张)/i
]

// 表情反应单一规则源：每条规则 = 识别正则 + 可选的强制 tags/useCases + 配文池。
// 带 tags 的规则命中时走强制路径（模型无参与）；replies 是强制路的配文池，
// 发送时按概率抽样（pickForcedReplyLayout），不加模型调用；
// 不带 tags 的规则只参与 exposure 分类。
// CASUAL_EMOJI_REACTION_PATTERNS 与 FORCED_REACTION_EMOJI_RULES 均由此派生，
// 不再手工维护两份必须同步的词表（此前同一批情绪词写了两遍，已经漂移过）。
export const EMOJI_REACTION_RULES = [
  {
    pattern: /笑死|笑不活|绷不住|蚌埠住|太逗|会谢|乐死|乐疯|哈哈+|嘿嘿+/i,
    tags: ["笑死", "吐槽"],
    useCases: ["接梗吐槽"],
    replies: ["哈哈哈哈哈", "笑死我了", "这也太逗了"]
  },
  {
    pattern: /离谱|无语|逆天|我服了|什么鬼|看傻|傻眼|看懵|懵了|卧槽|我超|典中典/i,
    tags: ["无语", "震惊", "吐槽"],
    useCases: ["无言以对", "看到离谱"],
    replies: ["不是吧", "这什么操作", "我直接看傻"]
  },
  {
    pattern: /尴尬|社死|脚趾.{0,12}(?:三室一厅|抠地)/i,
    tags: ["尴尬", "无奈"],
    useCases: ["场面尴尬"],
    replies: ["救命，尴尬住了", "脚趾已抠地", "这也太尬了"]
  },
  {
    pattern: /破防|委屈死|可怜巴巴|装无辜/i,
    tags: ["委屈", "破防", "无辜"],
    useCases: ["委屈诉苦", "装可怜"],
    replies: ["呜呜", "我好委屈", "可怜一下我吧"]
  },
  {
    pattern: /认怂|求饶|救命|寄了|急了/i,
    tags: ["认怂", "无奈"],
    useCases: ["认怂求饶"],
    replies: ["我认怂还不行吗", "饶了我吧", "行行行"]
  },
  {
    pattern: /困死|累死|不想动|烦死|气死|裂开|崩溃|摆烂/i,
    tags: ["疲惫", "摆烂", "崩溃"],
    useCases: ["累到躺平"],
    replies: ["累麻了", "不想动了", "让我躺会儿"]
  },
  {
    pattern: /(?:^|[，,。！？!?~～\s])(?:摸摸|抱抱|贴贴)(?:我|你|他|她|一下|吧|嘛|呀|$|[，,。！？!?~～\s])|安慰一下我|哄哄我|哄我一下/i,
    tags: ["安慰", "委屈"],
    useCases: ["安慰对方", "接梗摸头"],
    replies: ["摸摸", "抱一下", "来，安慰你"]
  },
  {
    pattern: /好耶|太好了|牛啊|666|得意|好好好/i,
    tags: ["开心", "得意"],
    useCases: ["分享快乐", "被人夸奖"],
    replies: ["好耶！", "牛的", "太棒了"]
  },
  // 以下只参与识别，不触发强制路径
  { pattern: /绝了|真行啊|还真敢|好怪|害羞|不是吧|真的假的|哼[，,。！？!?~～\s]/i },
  { pattern: /(?:^|[，,。！？!?~～\s])草(?:了|啊|死|率|$|[，,。！？!?~～\s])/i },
  { pattern: /(?:^|[，,。！!~～\s])啊[?？](?:$|[，,。！？!?~～\s])/i }
]

const CASUAL_EMOJI_REACTION_PATTERNS = EMOJI_REACTION_RULES.map(rule => rule.pattern)
const FORCED_REACTION_EMOJI_RULES = EMOJI_REACTION_RULES.filter(rule => Array.isArray(rule.tags) && rule.tags.length)

const SERIOUS_OR_OPERATIONAL_PATTERNS = [
  /```|https?:\/\/|www\.|(?:^|\s)(?:class|function|const|let|var|public|private|SELECT|INSERT|UPDATE|DELETE)\b/i,
  // 画图请求不能被降级成表情包闲聊，即使整句没有一个"图"字（如"画一个星野"）
  /(?<![笔字漫画动刻描油])(?:画|绘制|捏)(?:一|1)?(?:个|张|幅|只|位)[^，,。！!？?？\n]{1,80}/i,
  /(?:怎么|如何|为什么|原因|解决|修复|排查|分析|解释|检查|确认|帮我|请问|能不能).{0,32}(?:报错|错误|异常|故障|代码|编程|接口|API|配置|日志|服务器|数据库|部署|依赖|版本|测试|需求|方案|文档|作业|考试|合同|法律|医疗|财务)/i,
  /(?:报错|错误|异常|故障|代码|编程|接口|API|配置|日志|服务器|数据库|部署|依赖|版本|测试|需求|方案|文档|作业|考试|合同|法律|医疗|财务).{0,32}(?:怎么|如何|为什么|原因|解决|修复|排查|分析|解释|检查|确认|帮我|请问|能不能)/i,
  /(?:查一下|搜索|搜一下|最新|新闻|天气|价格|汇率|禁言|解禁|改名片|群名片.{0,8}(?:改|换)|(?:改|换).{0,8}群名片|群公告|撤回|提醒我|定时|点歌|来首|点赞|点.{0,4}赞|QQ赞|戳一戳|戳一下|语音|念出来|读出来|三角洲|思维导图|脑图|Excel|工作簿|工作表|sheet|tab页|单元格|\.xlsx\b|\.xlsm\b|长图|转成图片|生成图片版|发成图|做成图|代码.{0,8}图片|Markdown.{0,8}图片|送礼物|画图|生图|生成.{0,12}(?:图|图片)|画.{0,12}(?:图|图片)|修图|改图|看图|识图)/i,
  /^(?:怎么|如何|为什么|请问|能不能告诉我)|(?:怎么办|有什么建议|给点建议|有什么方法|应该怎么)/i,
  /怎么(?:道歉|安慰|处理|回复|回答|解决|选择|决定)/i,
  /(?:该不该|要不要|是否|是不是|你觉得|你认为|你怎么看|怎么评价|怎么回复|怎么回答|求建议)/i,
  /(?:失恋|分手了|被裁员|被辞退|被开除|去世|离世|死亡|喘不上气|呼吸困难|去医院|住院|自杀|不想活|伤害自己|报警|被骗|欠债)/i,
  /(?:严肃|认真|正式|技术讨论|故障处理|工作汇报|总结报告)/i
]

export function normalizeEmojiIntentText(text = "") {
  return String(text || "")
    .replace(/\[CQ:[^\]]+\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function matchesAny(content, patterns) {
  return patterns.some(pattern => pattern.test(content))
}

// 直接个人提问:用户在问 bot 本人的状态/在不在(在干嘛/在吗/睡了没…)。
// 这类消息不允许被"只发一张表情包"打发——提示词层有引导,终态跳过层有硬守卫。
const DIRECT_PERSONAL_QUESTION_RE = /(?:在吗|在么|在不在|在干嘛|在干啥|干嘛呢|干啥呢|在做什么|做什么呢|在忙|忙不忙|忙吗|吃饭了?没|吃过?了?没|睡了?没|睡了吗|还好吗|怎么样啦|过得怎么样|爱不爱我|喜不喜欢我|想不想我|想我了吗|爱我吗|喜欢我吗|你有多爱我|夸夸我|夸我|你夸|表扬我|夸我两句|说句好听的|说点好听的|彩虹屁)/
const DIRECT_PERSONAL_QUESTION_EXCLUDE_RE = /(?:你们|大家|群里|他们|她们|他|她|它|那位|老师|老板)/

export function looksLikeDirectPersonalQuestion(text = "") {
  const content = normalizeEmojiIntentText(text)
  if (!content || content.length > 40) return false
  if (DIRECT_PERSONAL_QUESTION_EXCLUDE_RE.test(content)) return false
  return DIRECT_PERSONAL_QUESTION_RE.test(content)
}

// 一轮里 sendLocalEmojiTool 最多实际执行 maxPerTurn 次：
// 模型偶尔一轮并行发两个表情调用导致连甩两张表情刷屏，这里在代码层硬性兜底。
// 返回与 toolNames 等长的数组：true=本次调用跳过（用提示结果代替执行）。
export function resolveEmojiTurnSkips(toolNames = [], alreadySent = 0, maxPerTurn = 1) {
  let sent = Number(alreadySent) || 0
  const max = Math.max(1, Number(maxPerTurn) || 1)
  return toolNames.map(name => {
    if (name !== "sendLocalEmojiTool") return false
    if (sent < max) {
      sent++
      return false
    }
    return true
  })
}

export function classifyEmojiToolExposure(text = "") {
  const content = normalizeEmojiIntentText(text)
  if (!content) return "none"
  if (matchesAny(content, REMOTE_EMOJI_SEARCH_PATTERNS)) return "none"
  if (matchesAny(content, EXPLICIT_EMOJI_REQUEST_PATTERNS)) return "explicit"
  if (Array.from(content).length > 100) return "none"
  if (matchesAny(content, SERIOUS_OR_OPERATIONAL_PATTERNS)) return "none"
  if (matchesAny(content, CASUAL_EMOJI_REACTION_PATTERNS)) return "casual_reaction"
  // 表情是日常对话的回复形态。短闲聊里把工具交给主模型，由它决定文字、纯表情或混合回复。
  if (Array.from(content).length <= 60) return "casual_conversation"
  return "none"
}

export function shouldExposeEmojiToolForMessage(text = "") {
  return classifyEmojiToolExposure(text) !== "none"
}

export function resolveForcedReactionEmoji(text = "") {
  const content = normalizeEmojiIntentText(text)
  if (classifyEmojiToolExposure(content) !== "casual_reaction") return null
  const matched = FORCED_REACTION_EMOJI_RULES.find(rule => rule.pattern.test(content))
  if (!matched) return null
  return {
    tags: [...matched.tags],
    useCases: [...matched.useCases],
    replies: [...(matched.replies || [])]
  }
}

/**
 * 强制路配文采样：textRate 概率带一句配文（从规则配文池抽），其余纯图。
 * 不加模型调用——强制路的快不能牺牲；同一随机数决定"是否配文"与"选哪句"，可注入 rng 供测试。
 */
export function pickForcedReplyLayout({ replies = [], textRate = 0.4, random = Math.random } = {}) {
  const pool = (Array.isArray(replies) ? replies : [])
    .map(item => String(item || "").trim())
    .filter(Boolean)
  const rate = Math.max(0, Math.min(0.8, Number(textRate) || 0))
  const draw = typeof random === "function" ? random() : Math.random()
  if (!pool.length || draw >= rate) return { leadText: "", layout: "emoji" }
  const index = Math.min(pool.length - 1, Math.floor((draw / rate) * pool.length))
  return { leadText: pool[index], layout: "text_emoji" }
}

/**
 * 布局自适应：该群观察到的裸表情占比越高，强制路配文概率越低。
 * 样本不足（<20）或统计缺失时用配置默认值；结果夹在 [0.15, 0.6] 防止极端化。
 */
export function adaptForcedReplyTextRate(stats = null, defaultRate = 0.4) {
  const rate = Math.max(0, Math.min(0.8, Number(defaultRate) || 0))
  if (!stats || !Number.isFinite(Number(stats.samples)) || Number(stats.samples) < 20) return rate
  const emojiOnlyShare = Math.max(0, Math.min(1, Number(stats.emojiOnlyShare)))
  if (!Number.isFinite(emojiOnlyShare)) return rate
  return Math.max(0.15, Math.min(0.6, 1 - emojiOnlyShare))
}

export function filterToolsForEmojiExposure(tools = [], text = "", { groupId = "", cooldownMs = 120000 } = {}) {
  if (!shouldExposeEmojiToolForMessage(text)) return null
  if (suppressEmojiByCooldown(text, groupId, cooldownMs)) return []
  return (Array.isArray(tools) ? tools : []).filter(tool =>
    tool?.function?.name === LOCAL_EMOJI_TOOL_NAME
  )
}

const emojiCooldownUntil = new Map()

/** emoji-only 回复发送后开启冷却（ms，0 关闭）。explicit 请求不受冷却影响。 */
export function recordEmojiOnlySend(groupId = "", cooldownMs = 120000) {
  const ms = Math.max(0, Number(cooldownMs) || 0)
  const key = String(groupId || "")
  if (!key || !ms) return
  emojiCooldownUntil.set(key, Date.now() + ms)
}

export function emojiCooldownActive(groupId = "") {
  const until = emojiCooldownUntil.get(String(groupId || ""))
  if (!until) return false
  if (Date.now() >= until) {
    emojiCooldownUntil.delete(String(groupId || ""))
    return false
  }
  return true
}

export function resetEmojiCooldownForTests() {
  emojiCooldownUntil.clear()
}

/** 冷却期间抑制 casual 暴露/强制反应；explicit 请求永远可用 */
export function suppressEmojiByCooldown(text = "", groupId = "", cooldownMs = 120000) {
  if (!emojiCooldownActive(groupId)) return false
  const kind = classifyEmojiToolExposure(text)
  if (kind === "explicit") return false
  void cooldownMs
  return true
}

export function getEmojiToolIntentPatterns() {
  return [
    ...EXPLICIT_EMOJI_REQUEST_PATTERNS,
    ...CASUAL_EMOJI_REACTION_PATTERNS
  ]
}
