export const LOCAL_EMOJI_TOOL_NAME = "sendLocalEmojiTool"

const REMOTE_EMOJI_SEARCH_PATTERNS = [
  /(?:网上|网络|在线|堆糖).{0,12}(?:搜|找|来|发|要)?.{0,8}(?:表情包|表情|梗图|反应图)/i
]

const EXPLICIT_EMOJI_REQUEST_PATTERNS = [
  /表情包|斗图/i,
  /(?:来|发|给|整|甩|丢|配|找|搜).{0,12}(?:表情|梗图|反应图)/i,
  /(?:表情|梗图|反应图).{0,8}(?:来一个|来一张|发一个|发一张|整一个|整一张|配一个|配一张)/i
]

const CASUAL_EMOJI_REACTION_PATTERNS = [
  /笑死|笑不活|绷不住|蚌埠住|太逗|会谢|绝了|真行啊|还真敢|离谱|无语|好怪|尴尬|社死|破防|认怂|装无辜|害羞|得意|救命|乐死|乐疯|哈哈哈+|哈哈+|嘿嘿嘿+|卧槽|我超|666|寄了|急了|典中典|好好好/i,
  /不是吧|真的假的|逆天|我服了|什么鬼|看傻|傻眼|看懵|懵了/i,
  /困死|累死|不想动|烦死|气死|裂开|崩溃|委屈死/i,
  /脚趾.{0,12}(?:三室一厅|抠地)|可怜巴巴|好耶|太好了|牛啊|哼[，,。！？!?~～\s]/i,
  /(?:^|[，,。！？!?~～\s])草(?:了|啊|死|率|$|[，,。！？!?~～\s])/i,
  /(?:^|[，,。！？!?~～\s])(?:摸摸|抱抱|贴贴)(?:我|你|他|她|一下|吧|嘛|呀|$|[，,。！？!?~～\s])/i,
  /(?:安慰一下我|哄哄我|哄我一下)/i,
  /(?:^|[，,。！!~～\s])啊[?？](?:$|[，,。！？!?~～\s])/i
]

// 这些短反应一张表情包就能完整表达。仅在已排除任务、提问和严肃内容后使用，
// 避免表情包成为对正式消息的机械前缀或尾缀。
const FORCED_REACTION_EMOJI_RULES = [
  {
    pattern: /笑死|笑不活|绷不住|蚌埠住|太逗|会谢|乐死|乐疯|哈哈+|嘿嘿+/i,
    tags: ["笑死", "吐槽"],
    useCases: ["接梗吐槽"]
  },
  {
    pattern: /离谱|无语|逆天|我服了|什么鬼|看傻|傻眼|看懵|懵了|卧槽|我超|典中典/i,
    tags: ["无语", "震惊", "吐槽"],
    useCases: ["无言以对", "看到离谱"]
  },
  {
    pattern: /尴尬|社死|脚趾.{0,12}(?:三室一厅|抠地)/i,
    tags: ["尴尬", "无奈"],
    useCases: ["场面尴尬"]
  },
  {
    pattern: /破防|委屈死|可怜巴巴|装无辜/i,
    tags: ["委屈", "破防", "无辜"],
    useCases: ["委屈诉苦", "装可怜"]
  },
  {
    pattern: /认怂|求饶|救命|寄了|急了/i,
    tags: ["认怂", "无奈"],
    useCases: ["认怂求饶"]
  },
  {
    pattern: /困死|累死|不想动|烦死|气死|裂开|崩溃|摆烂/i,
    tags: ["疲惫", "摆烂", "崩溃"],
    useCases: ["累到躺平"]
  },
  {
    pattern: /(?:^|[，,。！？!?~～\s])(?:摸摸|抱抱|贴贴)(?:我|你|他|她|一下|吧|嘛|呀|$|[，,。！？!?~～\s])|安慰一下我|哄哄我|哄我一下/i,
    tags: ["安慰", "委屈"],
    useCases: ["安慰对方", "接梗摸头"]
  },
  {
    pattern: /好耶|太好了|牛啊|666|得意|好好好/i,
    tags: ["开心", "得意"],
    useCases: ["分享快乐", "被人夸奖"]
  }
]

const SERIOUS_OR_OPERATIONAL_PATTERNS = [
  /```|https?:\/\/|www\.|(?:^|\s)(?:class|function|const|let|var|public|private|SELECT|INSERT|UPDATE|DELETE)\b/i,
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
    useCases: [...matched.useCases]
  }
}

export function filterToolsForEmojiExposure(tools = [], text = "") {
  if (!shouldExposeEmojiToolForMessage(text)) return null
  return (Array.isArray(tools) ? tools : []).filter(tool =>
    tool?.function?.name === LOCAL_EMOJI_TOOL_NAME
  )
}

export function getEmojiToolIntentPatterns() {
  return [
    ...EXPLICIT_EMOJI_REQUEST_PATTERNS,
    ...CASUAL_EMOJI_REACTION_PATTERNS
  ]
}
