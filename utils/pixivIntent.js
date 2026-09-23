/**
 * Pixiv 找图意图解析:把自然语言请求解析成 pixivSearchTool / pixivDownloadTool 的参数。
 * 纯函数,供 toolIntentManifests 的确定性快路调用。
 *
 * 边界(与相邻意图的区分):
 * - 画图/生图("帮我画一张猫")不是找图 → null
 * - 看图/识图("看看这张图")是对已有图片的分析 → null
 * - 表情包("来个表情包")走表情包工具 → null
 * - 磁链下载("下载 1,3" 或带 magnet)走磁链工具 → null
 */

// 动词按长度降序排列,避免"查"抢先吃掉"查一下"的前缀
const SEARCH_VERB_SOURCE = "(?:查一下|查查|搜索|搜一下|搜搜|查|搜|找一下|找找|找|寻一下|寻寻|寻|看看|看下|来点|来几张)"

// "查一下wlop的作品" -> 捕获 wlop(仅"的作品/画作"视为画师意图;"的插画/图"走关键词搜索)
const ARTIST_WORKS_PATTERN = new RegExp(
  `${SEARCH_VERB_SOURCE}\\s*([^，,。！!？?\\n]{1,40}?)\\s*的(?:作品|画作)`
)
// "搜搜初音未来的图" -> 捕获 初音未来
const KEYWORD_IMAGE_PATTERN = new RegExp(
  `${SEARCH_VERB_SOURCE}\\s*([^，,。！!？?\\n]{1,40}?)\\s*(?:的)?(?:插画|同人图|美图|立绘|图|作品)`
)
// "p站搜wlop" / "pixiv 搜 初音未来" / "先从 p 站那边翻翻看"(容忍 p 和 站之间的空格)
const PIXIV_SITE_PATTERN = new RegExp(
  `(?:p\\s*站|P\\s*站|pixiv|PIXIV|Pixiv)\\s*(?:上)?(?:搜索|搜一下|搜搜|搜|查一下|查查|查|找一下|找找|找|寻|看看|看下)?\\s*([^，,。！!？?\\n]{1,40})`
)

// 生成意图必须带量词("画一张猫"),避免误杀"画师"这类词
const GENERATION_GUARD = /(画图|生图|出图|修图|(?:画|绘制|生成|捏|搓|做)\s*(?:一|1)\s*(?:个|张|幅|组|点|些))/
const EMOJI_GUARD = /表情包|斗图|表情$/
const ANALYSIS_GUARD = /(这张|这个|这图|图里|图中|图片里|图片中|照片里|截图里).{0,10}(是什么|是啥|有啥|什么意思|怎么样|分析|识别|描述)/

const DOWNLOAD_INDEX_PATTERN = /(?:下载|下|搬运)\s*(?:第\s*)?(\d{1,2})\s*(?:张|个|幅|图)?(?:\s*$|\s*[。!！?？])/
const DOWNLOAD_ID_PATTERN = /(?:下载|下|搬运)\s*(?:id|ID|Id)?\s*(\d{5,12})\s*(?:\s*$|\s*[。!！?？])/
const TORRENT_MULTI_SELECTION_PATTERN = /(?:下载|下|选择|选)\s*(?:第\s*)?\d+(?:\s*(?:,|，|、)\s*(?:第\s*)?\d+)+/

// 排序意图:热门/人气(收藏数重排) > 最早 > 最新(默认)
const POPULAR_ORDER_PATTERN = /热门|人气|最受欢迎|最火|收藏最多|点赞最多|赞最多|最多收藏/
const OLDEST_ORDER_PATTERN = /最早|最旧|最老/

const LEADING_VERB_PATTERN = new RegExp(`^(?:帮我|给我|替我|麻烦|能不能|可以|想要|要|${SEARCH_VERB_SOURCE})\\s*`)

// "p站"出现在句尾补充说明里时("先从 p 站那边翻翻看~"),捕获到的是垃圾词
const SITE_JUNK_PATTERN = /^(?:那边|这里|一下|看看|看下|翻翻|找找|搜搜|查查|翻翻看)/

// 排序意图词不构成关键词本身("一些热门的初音未来" -> "初音未来");
// 单字排序词必须带"最"前缀,避免误杀"新版"这类正常词
const SORT_NOISE_PATTERN = /(?:一些|一点|几个|几组)|(?:热门|人气最高|最受欢迎|最火|收藏最多|点赞最多|赞最多|最新|最早|最旧)(?:的)?/g

// "跟翠月有关的图"类关系框架:只保留主体("翠月")
const RELATED_FRAME_PATTERN = /^(?:跟|和|与|关于)?\s*(.{1,30}?)\s*(?:有关|相关)$/

function cleanKeyword(value = "") {
  let text = String(value || "").replace(/\s+/g, " ").trim()
  if (!text) return ""
  text = text.replace(SORT_NOISE_PATTERN, " ").replace(/\s+/g, " ").trim()
  const framed = text.match(RELATED_FRAME_PATTERN)
  if (framed && framed[1].trim()) text = framed[1].trim()
  text = text.replace(/^(?:关于|跟|和|与)\s*/, "").trim()
  if (!text) return ""
  // 捕获组可能带上残留的引导动词("帮我找找猫"类句式),再剥一层
  const stripped = text.replace(LEADING_VERB_PATTERN, "").trim()
  const keyword = (stripped || text).slice(0, 60)
  return keyword || ""
}

/** 供工具的参数归一化复用:剥框架词/排序词后的纯搜索主体 */
export function normalizePixivKeyword(value = "") {
  return cleanKeyword(value)
}

/** 低模型可能用自然语言填写枚举(如 searchType:"插画"、orderBy:"相关度"),统一映射到合法值 */
export function normalizePixivSearchType(value = "") {
  return /画师|作者|artist/i.test(String(value || "")) ? "artist" : "artworks"
}

export function normalizePixivOrderBy(value = "") {
  const text = String(value || "")
  if (/人气|热门|最热|收藏|赞|popular/i.test(text)) return "popular"
  if (/最早|最旧|最老|oldest/i.test(text)) return "oldest"
  return "newest"
}

/** "查一下wlop的作品" -> {keyword:"wlop", searchType:"artist", order:"popular"};
 *  排序词缺省为 newest;不是找图请求返回 null */
export function parsePixivSearchRequest(text = "") {
  const content = String(text || "").trim()
  if (!content) return null
  if (GENERATION_GUARD.test(content) || EMOJI_GUARD.test(content) || ANALYSIS_GUARD.test(content)) return null
  if (/magnet:\?|磁链|磁力链接/.test(content)) return null
  const order = POPULAR_ORDER_PATTERN.test(content) ? "popular" : OLDEST_ORDER_PATTERN.test(content) ? "oldest" : "newest"

  // 显式的"动词+关键词+的图/的作品"句式优先;纯站点句式("p站搜XX")兜底
  const artistMatch = content.match(ARTIST_WORKS_PATTERN)
  if (artistMatch) {
    const keyword = cleanKeyword(artistMatch[1])
    if (keyword) return { keyword, searchType: "artist", order }
  }
  const keywordMatch = content.match(KEYWORD_IMAGE_PATTERN)
  if (keywordMatch) {
    const keyword = cleanKeyword(keywordMatch[1])
    if (keyword) return { keyword, searchType: "artworks", order }
  }
  const siteMatch = content.match(PIXIV_SITE_PATTERN)
  if (siteMatch) {
    const keyword = cleanKeyword(siteMatch[1])
    if (keyword && !SITE_JUNK_PATTERN.test(keyword)) {
      return { keyword, searchType: /的作品|画作/.test(content) ? "artist" : "artworks", order }
    }
  }
  return null
}

/** "下载 3" -> {target:"3"};"下载 126649495" -> {target:"126649495"};磁链/多选(归磁链工具)返回 null */
export function parsePixivDownloadRequest(text = "") {
  const content = String(text || "").trim()
  if (!content) return null
  if (TORRENT_MULTI_SELECTION_PATTERN.test(content)) return null
  if (/magnet:\?|磁链|磁力链接/.test(content)) return null
  const idMatch = content.match(DOWNLOAD_ID_PATTERN)
  if (idMatch) return { target: idMatch[1] }
  const indexMatch = content.match(DOWNLOAD_INDEX_PATTERN)
  if (indexMatch) return { target: indexMatch[1] }
  return null
}

// ── 工具清单(单一声明点):本文件是轻量模块,路由各层从这里取 Pixiv 的全部声明 ──

export const PIXIV_SEARCH_TOOL_MANIFEST = {
  name: "pixivSearchTool",
  terminal: true,
  description: "搜索 Pixiv 插画并发送带缩略图的结果卡面。群友说「找图/搜图/来张XX的图/找跟XX有关的图/查画师作品」想要插画或二次元作品时,优先用本工具而不是 bingImageSearchTool(必应适合找照片/截图/素材,P站适合插画作品)。用户回复「下载 序号」时改用 pixivDownloadTool。",
  skill: {
    name: "pixivSearchTool",
    purpose: "在 Pixiv 搜索插画并发送带缩略图与收藏数的结果列表卡面。",
    whenToUse: "用户想找插画/二次元图/某画师作品/某角色的同人图时。「跟XX有关的图」「来点XX的图」「查XX画师」都算。找照片、实拍、截图素材应改用 bingImageSearchTool。",
    boundaries: "不是画图(生图)、不是看图识图、不是表情包。磁链下载与本工具无关。",
    instructions: "keyword 只留搜索主体(角色名/画师名/标签),剥掉「跟…有关的图/查一下/来点/一些热门的」等框架词;searchType 只能 artworks 或 artist(看某画师本人作品时用 artist);orderBy 只能 newest/oldest/popular(热门/人气/收藏最多 → popular)。"
  },
  triggers: [
    /p\s*站|pixiv/i,
    /(?:查|搜|找|寻|看看|看下)[^，,。！!？?\n]{0,6}(?:的)?(?:插画|作品|画师|同人图|美图|图集)/i,
    /(?:来点|来几张)[^，,。！!？?\n]{0,12}(?:的)?(?:图|插画|作品|立绘)/i,
    /(?:搜|查|找)[^，,。！!？?\n]{0,14}(?:的)?(?:图|插画|立绘)/i
  ],
  disclosure: [
    "【pixivSearchTool 详细用法】",
    "用途：搜索 Pixiv 插画并发送带缩略图的结果列表卡面。",
    "与必应图搜的分工(重要)：用户要插画/二次元图/同人图/画师作品时必须选本工具;bingImageSearchTool 只用于照片/实拍/截图/素材类找图。",
    "调用边界：",
    "- 用户想找现成的插画/作品/某画师的作品时调用；不是画图(画/生成新图走生图工具)、不是看图识图。",
    "- 找表情包时不要调用(走表情包工具)。",
    "keyword 抽取规则(最重要,逐条检查):",
    "- keyword 只保留搜索主体本身:角色名/画师名/作品名/标签,例如 wlop、海琴烟、初音未来、翠月。",
    "- 去掉所有框架词:「查一下/搜搜/帮我找/来点/看看」等动词、「跟X有关的图」只留X、「关于X」只留X、「的图/的作品/的插画」后缀、「一些/热门的/人气最高的」等修饰。",
    "- “找一下跟翠月有关的图” -> keyword=翠月;“来几张热门的海琴烟” -> keyword=海琴烟;“搜搜初音未来的图” -> keyword=初音未来。",
    "- 用户原话里的角色叫法优先保留(翠月/海琴烟/中文名都可以,搜索端会自动翻译匹配)。",
    "searchType:必须填英文枚举 artworks(默认)或 artist(看某画师本人作品)。",
    "orderBy:必须填英文枚举 newest(默认)/oldest(最早)/popular(热门/人气/收藏最多)。",
    "等价例子：",
    "- “查一下wlop的作品” -> {\"keyword\":\"wlop\",\"searchType\":\"artist\"}",
    "- “找一下跟翠月有关的图” -> {\"keyword\":\"翠月\",\"searchType\":\"artworks\"}",
    "- “p站搜海琴烟” -> {\"keyword\":\"海琴烟\",\"searchType\":\"artworks\"}",
    "- “搜一些热门的初音未来同人图” -> {\"keyword\":\"初音未来 同人\",\"searchType\":\"artworks\",\"orderBy\":\"popular\"}",
    "搜索后引导用户:回复「下载 序号」(如 下载 1)或「下载 作品ID」即可搬运对应作品。"
  ].join("\n"),
  // 搜索类关键词措辞无穷多变,不提供确定性解析,统一交给语义规划器的低模型拆解
  deterministicResolver: null
}

export const PIXIV_DOWNLOAD_TOOL_MANIFEST = {
  name: "pixivDownloadTool",
  terminal: true,
  description: "下载并搬运一张 Pixiv 插画到群里。用户在搜索列表后回复「下载 3」「下载 126649495」「下个载 id=xxx」之类时调用。",
  skill: {
    name: "pixivDownloadTool",
    purpose: "下载并搬运一张 Pixiv 插画到群里。",
    whenToUse: "用户针对 Pixiv 搜索列表说「下载 N」「下载 作品ID」时。",
    boundaries: "磁链、BT、多选编号(下载 1,3)走磁链下载工具,与本工具无关。",
    instructions: "target 是搜索列表里的序号(如 3)或作品ID(纯数字);不要带「下载/id」等字样。"
  },
  triggers: [
    /(?:下载|下|搬运)\s*(?:第\s*)?\d{1,2}\s*(?:张|个|幅|图)?\s*(?:$|[。!！?？])/i,
    /(?:下载|下|搬运)\s*(?:id|ID|Id)?\s*\d{5,12}/i
  ],
  disclosure: [
    "【pixivDownloadTool 详细用法】",
    "用途：下载并搬运一张 Pixiv 插画到群里。",
    "调用边界：",
    "- 只在用户针对 Pixiv 搜索列表说「下载 N」「下载 作品ID」时调用。",
    "- 磁链、BT、多选编号(下载 1,3)走磁链下载工具,与本工具无关。",
    "参数规则：",
    "- target 是搜索列表里的序号(如 3)或作品ID(纯数字);不要带「下载/id」等字样。",
    "等价例子：",
    "- 搜索列表后“下载 2” -> {\"target\":\"2\"}",
    "- “下载 126649495” -> {\"target\":\"126649495\"}"
  ].join("\n"),
  deterministicResolver: parsePixivDownloadRequest
}
