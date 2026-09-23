// 意图层核心：消息意图的模式常量与纯分类函数。
// 从 apps/test.js 原样迁出（P2 切片一），行为不变；P4 将在此之上重做统一意图入口。
import { hasExplicitImageGenerationRequest, hasExplicitImageEditAction, shouldTreatAsAvatarInspection } from "../../utils/imageTaskPolicy.js"
import { looksLikeVisualInspectionRequest, looksLikeImageVerificationRequest, looksLikeImageAuthenticityRequest } from "../../utils/imageRequestGuard.js"

// 终态工具：本轮调用后不再请求 LLM 续话（工具的执行结果本身即为最终输出）
const TERMINAL_TOOL_NAMES = new Set(['sendLocalEmojiTool', 'waitTool', 'bananaTool', 'googleImageEditTool', 'voiceTool', 'deltaForceTool', 'mentionAdminsTool', 'mentionMembersTool', 'torrentDownloadTool', 'pixivSearchTool', 'pixivDownloadTool'])

const BACKGROUND_TERMINAL_TOOL_NAMES = new Set(['bananaTool', 'googleImageEditTool', 'torrentDownloadTool'])

const PSEUDO_TOOL_MARKERS = [
  "tool", "tools", "tool_call", "toolcall", "function", "function_call", "functioncall", "func", "call", "voice", "audio", "tts", "image", "img",
  "video", "file", "send", "reply", "search", "google", "mcp", "banana", "reminder",
  "poke", "like", "music", "weather", "map", "draw", "generate", "edit",
  "工具", "工具调用", "函数", "函数调用", "调用", "语音", "音频", "图片", "图像", "视频", "文件", "发送",
  "回复", "搜索", "生图", "画图", "修图", "提醒", "戳", "点赞", "点歌", "天气", "地图"
]

const PSEUDO_TOOL_MARKER_SET = new Set(PSEUDO_TOOL_MARKERS.map(item => item.toLowerCase()))

const PSEUDO_TOOL_TEXT_KEYS = ["text", "content", "message", "reply", "spoken_text", "speech", "voice"]

// ─── 拟人化对话相关：本地预筛辅助常量与函数 ────────────────────────────
// 中文停用词（提取关键词时跳过这些）
const CHAT_STOPWORDS = new Set([
  "的", "了", "是", "也", "就", "都", "吧", "吗", "呢", "啊", "么", "哦", "呀", "嘛", "哈",
  "这", "那", "我", "你", "他", "她", "它", "我们", "你们", "他们",
  "觉得", "感觉", "可能", "应该", "不", "没", "有", "在", "和", "与", "或", "但", "而",
  "什么", "怎么", "怎样", "如何", "哪里", "哪个", "为什么", "因为", "所以",
  "一个", "一些", "这个", "那个", "这样", "那样", "这里", "那里",
  "可以", "不能", "需要", "想要", "知道", "听说", "看到"
])

// 反馈词（用户消息开头或主体如果是这些，认为是在回应 bot）
const FEEDBACK_WORDS = [
  "嗯", "对", "不对", "真的", "真的吗", "是吗", "是的", "确实", "对哦", "也是",
  "好的", "好吧", "可以", "可以的", "不可以", "不是", "没错", "没", "我也", "我觉得", "我感觉",
  "那", "那你", "那我", "你说", "你这", "你这么说",
  "啊？", "啊", "诶", "诶？", "哦", "哦？", "哈哈", "哈"
]

// 问句尾字（消息末尾包含这些算问句）
const QUESTION_TAIL_CHARS = ["?", "？", "吗", "呢", "啊", "么", "嘛"]

const DIRECT_BOT_PRONOUN_PATTERNS = [
  /(?:^|[\s，,。.!！?？~～])你(?:刚才|刚刚|前面|上一句|说|讲|回|回复|意思|怎么|为啥|为什么|是不是|能不能|可以|会不会|要不要|觉得|知道|认识|记得|是谁|叫啥|叫)/,
  /(?:^|[\s，,。.!！?？~～])你(?:呢|呀|啊|吗|嘛|么|？|\?)?$/
]

const GROUP_ADDRESS_PATTERNS = [
  /(?:大家|各位|群友|兄弟们|姐妹们|你们|咱们|有人|有没有人|哪位|大佬).{0,18}(?:知道|认识|会|能|可以|看看|帮|觉得|推荐|有|在吗|吗|嘛|\?|？)/,
  /(?:谁知道|有人知道|有没有人知道|问一下|请问|求问|求助|有无).{0,30}/,
  /(?:这个|这|那个|那).{0,14}(?:是什么|是啥|啥|怎么回事|咋回事|有人知道|谁知道)/
]

const PREVIOUS_SPEAKER_REPLY_PATTERNS = [
  /^[？?]+$/,
  /^(你|妳|他|她|这|那|对|不对|不是|是啊|确实|笑死|草|绷|哈哈|那你|那他|那她|别|不要|可以|不行|行|嗯|啊|哦|所以|但是|可是)/
]

const REALTIME_INFO_PATTERNS = [
  /(天气|气温|温度|下雨|降雨|台风|空气质量|AQI|空气指数)/i,
  /(新闻|热搜|最新消息|刚刚发生|最近发生|实时|现在|当前|目前|今天|今日|明天|昨天).{0,24}(新闻|情况|怎么样|如何|发生|政策|规定|结果|价格|行情|汇率|股价|天气|赛程|比分|营业|开门|关门)/i,
  /(?:股价|股票|基金|币价|比特币|汇率|油价|金价|房价|票价)/i,
  /(?:查|搜|问|了解|关注)[^\n]{0,6}(?:行情|价格|报价)/i,
  /(?:行情|价格|报价)[^\n]{0,6}(?:怎么样|如何|多少|涨|跌)/i,
  /(赛程|比分|比赛结果|战绩|排名|积分榜|开奖|中奖号码)/i,
  /(营业|开门|关门|限行|航班|车次|路况|排队|库存|余票|票价)/i
]

const EXPLICIT_SEARCH_PATTERNS = [
  /(搜一下|搜索|查一下|查查|帮我查|帮我搜|联网查|网上查|百度一下|谷歌一下|找一下资料|最新的|最新版|最新版本|官网|链接|网址|网页|页面|repo|github)/i
]

const TOOL_INTENT_PATTERNS = [
  /(画图|生图|修图|改图|图片分析|看图|识图|视频分析|语音|点歌|音乐|提醒我|定时提醒|撤回|禁言|改名片|戳一下|点赞|送礼物|红包|思维导图|导图|生成图片|生成照片|生成照|生成语音|Excel|工作簿|工作表|sheet|tab页|单元格|\.xlsx\b|\.xlsm\b|磁链|磁力链接|magnet:\?|艾特|通知.*(?:人|一下)|喊.*(?:人|一下)|叫.*(?:人|一下)|(?<![笔字漫画动刻描油])(?:画|绘制|捏)(?:一|1)?(?:个|张|幅|只|位)[^，,。！!？?？\n]{1,80})/i
]

const IMAGE_GENERATION_PATTERNS = [
  /(画图|生图|生成图片|生成照片|生成照|生成一?张(?:图|照片|照)|生成一?个.*(?:图|照片|照)|画一?张|绘制|出图|做一?张.*(?:图|照片|照)|捏一?个.*(?:图|照片|照))/i,
  /(?:把|将|给|帮我|替我|麻烦|可以|能不能|能|想要|要|一会|待会|等下).{0,24}(?:这个|这段|这句|上面|刚才|刚刚|内容|描述|设定|场景|它)?.{0,16}(?:画出来|画成图|画成图片|出成图|生成出来)/i,
  /(?:画|绘制|生成).{0,16}(?:出来|成图|成图片|成一张图)/i,
  /(帮我|给我|替我|可以|能不能|能|想要|要).{0,12}(画|生成|绘制|做|捏).{0,140}(图|图片|照片|照|插画|壁纸|头像|封面|海报|表情包|logo|标志|立绘|角色|人物|少女|男孩|女孩|猫|猫咪|狗|狗狗|动物|风景|场景)/i,
  /(?:帮我|给我|替我|麻烦|可以|能不能|想要|要).{0,12}(?:画|生成|绘制|做|捏)(?:一|1)?(?:个|张|幅|只|位)?.{1,180}(?:的)?(?:图|图片|照片|照|插画|壁纸|头像|封面|海报|表情包|立绘)$/i,
  /(?:用|拿|以).{0,8}(?:图片|图|画面|画|插画).{0,16}(?:展示|呈现)(?:一下|出来|吧|呀|嘛|呢)?/i,
  /(?:图片|图|画面|插画).{0,10}(?:展示|呈现)(?:一下|出来|吧|呀|嘛|呢)?/i,
  /(画|绘制|生成).{0,8}(一|1)?(只|个|位|张|幅)?.{0,32}(猫|猫咪|狗|狗狗|动物|角色|人物|少女|男孩|女孩|头像|立绘|风景|场景|照片|照)/i
]

const COMIC_DRAW_PATTERN = /(连环画|漫画|四格|多格|分镜|组图|小剧场|一组)/i
const IMAGE_ANALYSIS_PATTERNS = [
  /(图|图片|照片|截图|表情|头像).{0,16}(是什么|是啥|有啥|有什么|啥意思|什么意思|怎么看|看得出|看出来|识别|分析|描述|讲讲|说说)/i,
  /(看看|看下|看一下|帮我看|帮我看看|告诉我|识别一下|分析一下|描述一下).{0,18}(图|图片|照片|截图|表情|头像|里面|里边|上面|内容)/i,
  /(图里|图中|图片里|图片中|照片里|截图里|这里面|这上面).{0,16}(是什么|是啥|有啥|有什么|谁|哪|啥意思|什么意思)/i
]

const IMAGE_EDIT_PATTERNS = [
  /(修图|改图|美化图片|图片美化|编辑图片|图片编辑|P图|p图|图生图|重绘|局部重绘|扩图|抠图|去水印|换背景|换衣服|换颜色|换发型|换脸|加滤镜|上色|变清晰|高清修复|无损放大)/i,
  /(?:把|将|给|帮我|替我|麻烦|可以|能不能|能|想要|要).{0,18}(?:这张|这个|图片|图|照片|截图|头像|它|猫|猫咪|人|角色|主体)?.{0,16}(?:加|加上|添加|放上|画上|换|换成|变成|改成|改为|改一下|改改|修|修一下|修修|美化|变美|变漂亮|变好看|弄好看|弄漂亮|优化|去掉|去除|删掉|删除|移除|擦掉|抹掉|保留|增强|修复|变清晰|放大|补全|扩展|扩成).{0,40}/i,
  /(?:这个|这张|图片|图|照片|截图|头像).{0,16}(?:改一下|改改|修一下|修修|美化|变美|变漂亮|变好看|弄好看|弄漂亮|优化|精修)/i,
  /(?:把|将|给|帮我|替我|麻烦|可以|能不能|能|想要|要).{0,48}(?:放到|放在|放上|摆到|摆在|坐到|坐在|站到|站在|贴到|贴在|塞到|塞进|加到|加进|放进).{0,32}(?:上|里|里面|图里|图片里|画面里|照片里|截图里|背景里|旁边|中间|前面|后面|左边|右边|椅子|桌子|沙发|床|地上|墙上)/i,
  /(?:翅膀|尾巴|耳朵|帽子|眼镜|衣服|背景|文字|水印|光效|滤镜|颜色|表情|姿势|发型).{0,12}(?:加上|添加|换成|改成|去掉|去除|删除|移除|变成)/i
]

const IMAGE_COMPOSITION_EDIT_PATTERNS = [
  /(?:把|将).{1,60}(?:放到|放在|放上|放进|摆到|摆在|摆上|坐到|坐在|站到|站在|贴到|贴在|塞到|塞进|加到|加进|放|摆|贴|塞).{0,36}/i,
  /(?:让|叫).{1,40}(?:坐到|坐在|站到|站在|躺到|躺在|趴到|趴在).{0,36}/i,
  /(?:给|帮我|替我).{0,20}(?:图里|图片里|画面里|照片里|截图里).{0,24}(?:加|放|摆|塞|贴).{1,40}/i
]

const IMAGE_COMPOSITION_ACTION_PATTERNS = [
  /(?:放到|放在|放上|放进|放入|放|摆到|摆在|摆上|摆进|摆|坐到|坐在|站到|站在|贴到|贴在|贴上|贴进|贴|塞到|塞进|塞入|塞|加到|加进|加上|加入)/i
]

const IMAGE_COMPOSITION_TARGET_PATTERNS = [
  /(?:图里|图片里|画面里|照片里|截图里|背景里|上面|里面|旁边|中间|前面|后面|左边|右边|角落|椅子|桌子|沙发|床|地上|墙上|怀里|头上|手里|身边)/i
]

const GROUP_CONTEXT_PATTERNS = [
  /(群公告|公告|群规|群规则|入群规则|群主|管理员|管理|群管|群成员|成员|群名片|头衔|谁是|是谁|哪位|哪个人|哪个群友|这人是谁|那人是谁|禁言规则|发公告)/i
]

const SEARCH_TOOL_NAMES = new Set(['searchInformationTool', 'webParserTool', 'githubRepoTool'])

const TOOL_COMMITMENT_PATTERNS = [
  /(?:我|希洛)?(?:马上|现在|这就|等我|稍等|等一下|我来|我去|帮你|给你|让我|这就).{0,24}(?:画|生成|出图|改|修|处理|弄|编辑|看看|看一下|识别|分析|查|搜|找|搓|捏|整|做)/i,
  /(?:马上弄好|马上弄|马上画|马上改|马上处理|我来弄|我去弄|我来画|我去画|我来改|我去改|我来处理|我试试|我看看怎么|开始弄|开始画|开始改|等我一下|这就搓|这就捏|这就整|这就做|搓一个|捏一个|整一个|做一个)/i
]

const DRAW_TASK_STATUS_PATTERNS = [
  /(?:我的|我那张|刚才|刚刚|上一张|前面|之前).{0,12}(?:图|图片|画|出图).{0,18}(?:呢|好了没|好了吗|画好|生成好|出来|进度|到哪|还在|卡住|忘了|是不是忘)/i,
  /(?:图|图片|画|出图).{0,12}(?:呢|好了没|好了吗|画好|生成好|出来|进度|到哪|还在|卡住|是不是忘|忘了)/i,
  /(?:是不是|不会是|你是不是).{0,8}(?:忘了|忘记).{0,12}(?:我的|那张|刚才|图|画|图片)/i
]

const DRAW_CONTEXT_CONTINUATION_PATTERNS = [
  /(?:人物|角色|形象|造型|画面|构图|场景|背景|风格|表情|动作|姿势|细节).{0,18}(?:调整|改|修改|换|加|补|优化|重画|重新画|再画|继续)/i,
  /(?:调整|改|修改|换|加|补|优化|重画|重新画|再画|继续).{0,40}(?:人物|角色|形象|造型|画面|构图|场景|背景|风格|表情|动作|姿势|细节|这个|那张|刚才|刚刚|上一张)/i,
  /(?:全都要|都要|全部要|都加上|全加上|就按这个|就这样|按你说的|照你说的|继续画|接着画|那就画|画完整|重画一张|再来一张)/i
]

const SEMANTIC_TOOL_INTENTS = new Set(["chat", "image_generate", "image_edit", "image_analysis", "search"])

const SEMANTIC_TOOL_INTENT_MIN_CONFIDENCE = 0.7
const SEMANTIC_TOOL_INTENT_TIMEOUT_MS = 8000
const SEMANTIC_TOOL_HINT_PATTERN =
  /(画|绘制|生成|生图|出图|修图|改图|P图|p图|美化|去水印|换背景|看图|识图|分析|识别|看看|看一下|搜|查|找|天气|新闻|价格|汇率|比赛|最新|官网|链接|网址|三角洲|今日密码|每日密码|改枪码|改枪方案|利润排行|制造利润|特勤处|提醒|定时|禁言|改名片|戳|点赞|礼物|点歌|音乐|聊天记录|群成员|群友|导图|思维导图|Excel|工作簿|工作表|sheet|tab页|单元格|磁链|磁力链接|magnet:\?|\.xlsx\b|\.xlsm\b)/i
const CASUAL_BOT_GREETING_PATTERNS = [
  /(?:在吗|在不在|还好吗|还好嘛|还好不|你还好吗|你还好嘛|你没事吧|醒醒|理我|出来|冒泡|人呢|去哪了|干嘛呢|咋了|怎么了)/i
]

function isPseudoToolMarker(marker = "") {
  const normalized = String(marker || "")
    .trim()
    .replace(/tool$/i, "")
    .replace(/工具$/, "")
    .toLowerCase()
  return PSEUDO_TOOL_MARKER_SET.has(normalized) || PSEUDO_TOOL_MARKER_SET.has(`${normalized}tool`)
}

/**
 * 从一段文本提取关键词（给 R2 关键词命中识别用）。
 * 简单实现：按中英标点切分，取长度 ≥2 的非停用词词块，去重，最多 maxCount 个。
 */
function extractChatKeywords(text, maxCount = 5) {
  if (!text || typeof text !== "string") return []
  // 去除 CQ 码、@ 字段等噪声
  const cleaned = text
    .replace(/\[CQ:[^\]]+\]/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
  // 按非中英文数字字符切分
  const tokens = cleaned.split(/[^一-龥A-Za-z0-9]+/).filter(Boolean)
  const seen = new Set()
  const result = []
  for (const tok of tokens) {
    const t = tok.trim()
    if (t.length < 2) continue
    if (CHAT_STOPWORDS.has(t)) continue
    // 对中文长词额外拆分 2-3 字滑动窗口（避免长句一个 token 没法匹配）
    if (/^[一-龥]+$/.test(t) && t.length >= 4) {
      // 取 2-gram 前缀作为辅助关键词
      for (let i = 0; i <= t.length - 2 && result.length < maxCount; i++) {
        const gram = t.slice(i, i + 2)
        if (CHAT_STOPWORDS.has(gram)) continue
        if (seen.has(gram)) continue
        seen.add(gram)
        result.push(gram)
      }
    } else {
      if (seen.has(t)) continue
      seen.add(t)
      result.push(t)
    }
    if (result.length >= maxCount) break
  }
  return result.slice(0, maxCount)
}

/**
 * 判断消息是否是问句（含 ? / ？ 或末尾 5 字含问句尾字，或"爱不爱/好不好"这类正反问）
 */
const A_NOT_A_QUESTION_RE = /([\u4e00-\u9fa5]{1,2})(?:不|没)\1/

function isQuestionMessage(text) {
  if (!text || typeof text !== "string") return false
  if (/[?？]/.test(text)) return true
  // 正反问（爱不爱/好不好/是不是）。"对不起"里的"对不对"子串不是问句，单独排除。
  if (A_NOT_A_QUESTION_RE.test(text) && !/对不起/.test(text)) return true
  const tail = text.slice(-5)
  for (const ch of QUESTION_TAIL_CHARS) {
    if (tail.includes(ch)) return true
  }
  return false
}

/**
 * 判断消息是否以反馈词开头或主体由反馈词构成
 */
function isFeedbackMessage(text) {
  if (!text || typeof text !== "string") return false
  const t = text.trim()
  if (!t) return false
  // 整条就是反馈词
  if (FEEDBACK_WORDS.includes(t)) return true
  // 开头是反馈词（后接标点或空格）
  for (const w of FEEDBACK_WORDS) {
    if (t.startsWith(w)) {
      const next = t.charAt(w.length)
      if (!next || /[\s,，。.!！?？~～]/.test(next)) return true
    }
  }
  return false
}

function isLikelyFollowupMessage(text = "") {
  const msg = String(text || "").replace(/\[CQ:[^\]]+\]/g, " ").trim()
  if (!msg) return false
  if (isQuestionMessage(msg)) return true
  return /(?:谁|誰|什么|啥|哪(?:个|位|里|裏)|怎么|怎样|咋|为什么|为啥|多少|几|能不能|可不可以|要不要|是不是|还记得|记得|刚才|刚刚|前面|上一句|推荐|告诉|讲讲|说说|解释|评价|分析|帮我|给我|那你|那就|所以)/.test(msg)
}

function isCasualBotGreeting(text = "") {
  const content = normalizeIntentText(text)
  if (!content) return false
  return CASUAL_BOT_GREETING_PATTERNS.some(pattern => pattern.test(content))
}

function shouldUseCompactHistory({ text = "", images = [], videos = [], quotedText = "" } = {}) {
  const content = normalizeIntentText(text)
  if (!content || content.length > 80 || images.length || videos.length || quotedText) return false
  if (isRealtimeInfoRequest(content) || isExplicitSearchRequest(content) || isExplicitToolIntent(content)) return false
  return !/(?:他|她|它|这个|那个|上面|下面|前面|刚才|刚刚|之前|前一条|这张|那张|这段|引用|转发|回复)/u.test(content)
}

function looksDirectedAtBotByPronoun(text = "") {
  const msg = String(text || "").trim()
  if (!msg || !/[你妳]/.test(msg)) return false
  return DIRECT_BOT_PRONOUN_PATTERNS.some(pattern => pattern.test(msg))
}

function looksGroupAddressed(text = "") {
  const msg = String(text || "").trim()
  if (!msg) return false
  return GROUP_ADDRESS_PATTERNS.some(pattern => pattern.test(msg))
}

function normalizeIntentText(text = "") {
  return String(text || "")
    .replace(/\[CQ:[^\]]+\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function matchesAnyPattern(text = "", patterns = []) {
  const content = normalizeIntentText(text)
  return patterns.some(pattern => pattern.test(content))
}

function isRealtimeInfoRequest(text = "") {
  return matchesAnyPattern(text, REALTIME_INFO_PATTERNS)
}

function isExplicitSearchRequest(text = "") {
  return matchesAnyPattern(text, EXPLICIT_SEARCH_PATTERNS)
}

function isExplicitToolIntent(text = "") {
  return matchesAnyPattern(text, TOOL_INTENT_PATTERNS)
}

function isImageGenerationRequest(text = "") {
  const content = normalizeIntentText(text)
  if (/(修图|改图|图片分析|看图|识图|分析图片|识别图片)/i.test(content)) return false
  if (/(?:头像|名字|昵称).{0,12}(?:说|讲|发|伪装|冒充|任何话)|(?:任何人|别人|群友).{0,12}头像.{0,12}(?:说|讲|发|伪装|冒充)/i.test(content) &&
    !/(?:帮我|给我|替我|麻烦|请|想要|要|画图|生图|出图|生成|画|绘制|捏|做一?张)/i.test(content)) {
    return false
  }
  return hasExplicitImageGenerationRequest(content) || matchesAnyPattern(content, IMAGE_GENERATION_PATTERNS)
}

function isImageAnalysisRequest(text = "") {
  const content = normalizeIntentText(text)
  if (isImageGenerationRequest(content)) return false
  if (isImageCompositionEditRequest(content)) return false
  if (looksLikeVisualInspectionRequest(content)) return true
  if (looksLikeImageVerificationRequest(content)) return true
  return matchesAnyPattern(content, IMAGE_ANALYSIS_PATTERNS)
}

function isAvatarInspectionRequest(text = "") {
  const content = normalizeIntentText(text)
  if (!shouldTreatAsAvatarInspection(content)) return false
  if (isImageGenerationRequest(content) || isImageCompositionEditRequest(content)) return false
  return true
}

function getImageVerificationMode(text = "") {
  return looksLikeImageAuthenticityRequest(text) ? "image_authenticity" : "content_claim"
}

function isImageEditRequest(text = "") {
  const content = normalizeIntentText(text)
  return hasExplicitImageEditAction(content) || matchesAnyPattern(content, IMAGE_EDIT_PATTERNS)
}

function isImageCompositionEditRequest(text = "") {
  const content = normalizeIntentText(text)
  if (!content) return false
  if (isImageEditRequest(content)) return true
  if (matchesAnyPattern(content, IMAGE_COMPOSITION_EDIT_PATTERNS)) return true

  const hasTaskSubject = /(?:把|将|让|叫|给|帮我|替我|麻烦|可以|能不能|能不能帮我)/i.test(content)
  if (!hasTaskSubject) return false
  return matchesAnyPattern(content, IMAGE_COMPOSITION_ACTION_PATTERNS) &&
    matchesAnyPattern(content, IMAGE_COMPOSITION_TARGET_PATTERNS)
}

function hasToolCommitmentText(text = "") {
  const content = normalizeIntentText(text)
  if (!content) return false
  return TOOL_COMMITMENT_PATTERNS.some(pattern => pattern.test(content))
}

function isDrawTaskStatusInquiry(text = "") {
  const content = normalizeIntentText(text)
  if (!content) return false
  return DRAW_TASK_STATUS_PATTERNS.some(pattern => pattern.test(content))
}

function isDrawContextContinuationRequest(text = "") {
  const content = normalizeIntentText(text)
  if (!content) return false
  if (isImageGenerationRequest(content) || isImageEditRequest(content)) return false
  return DRAW_CONTEXT_CONTINUATION_PATTERNS.some(pattern => pattern.test(content))
}

function shouldInjectGroupContext(text = "") {
  return matchesAnyPattern(text, GROUP_CONTEXT_PATTERNS)
}
export {
  TERMINAL_TOOL_NAMES,
  BACKGROUND_TERMINAL_TOOL_NAMES,
  PSEUDO_TOOL_MARKERS,
  PSEUDO_TOOL_MARKER_SET,
  PSEUDO_TOOL_TEXT_KEYS,
  CHAT_STOPWORDS,
  FEEDBACK_WORDS,
  QUESTION_TAIL_CHARS,
  DIRECT_BOT_PRONOUN_PATTERNS,
  GROUP_ADDRESS_PATTERNS,
  PREVIOUS_SPEAKER_REPLY_PATTERNS,
  REALTIME_INFO_PATTERNS,
  EXPLICIT_SEARCH_PATTERNS,
  TOOL_INTENT_PATTERNS,
  IMAGE_GENERATION_PATTERNS,
  COMIC_DRAW_PATTERN,
  IMAGE_ANALYSIS_PATTERNS,
  IMAGE_EDIT_PATTERNS,
  IMAGE_COMPOSITION_EDIT_PATTERNS,
  IMAGE_COMPOSITION_ACTION_PATTERNS,
  IMAGE_COMPOSITION_TARGET_PATTERNS,
  GROUP_CONTEXT_PATTERNS,
  SEARCH_TOOL_NAMES,
  TOOL_COMMITMENT_PATTERNS,
  DRAW_TASK_STATUS_PATTERNS,
  DRAW_CONTEXT_CONTINUATION_PATTERNS,
  SEMANTIC_TOOL_INTENTS,
  SEMANTIC_TOOL_INTENT_MIN_CONFIDENCE,
  SEMANTIC_TOOL_INTENT_TIMEOUT_MS,
  SEMANTIC_TOOL_HINT_PATTERN,
  CASUAL_BOT_GREETING_PATTERNS,
  isPseudoToolMarker,
  extractChatKeywords,
  isQuestionMessage,
  isFeedbackMessage,
  isLikelyFollowupMessage,
  isCasualBotGreeting,
  shouldUseCompactHistory,
  looksDirectedAtBotByPronoun,
  looksGroupAddressed,
  normalizeIntentText,
  matchesAnyPattern,
  isRealtimeInfoRequest,
  isExplicitSearchRequest,
  isExplicitToolIntent,
  isImageGenerationRequest,
  isImageAnalysisRequest,
  isAvatarInspectionRequest,
  getImageVerificationMode,
  isImageEditRequest,
  isImageCompositionEditRequest,
  hasToolCommitmentText,
  isDrawTaskStatusInquiry,
  isDrawContextContinuationRequest,
  shouldInjectGroupContext
}
