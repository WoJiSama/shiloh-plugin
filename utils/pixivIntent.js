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
