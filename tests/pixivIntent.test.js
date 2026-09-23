import assert from "node:assert/strict"
import { test } from "node:test"
import { parsePixivDownloadRequest, parsePixivSearchRequest } from "../utils/pixivIntent.js"
import { buildToolIntentDisclosure, resolveDeterministicToolIntent, selectToolIntentCandidates } from "../utils/toolIntentManifests.js"
import { hasRecentPixivSearch, savePixivSearchSession } from "../utils/pixivSearch.js"

const AVAILABLE = ["pixivSearchTool", "pixivDownloadTool", "torrentDownloadTool", "searchInformationTool"]

test("parsePixivSearchRequest 识别画师/关键词找图并抽取 keyword", () => {
  assert.deepEqual(parsePixivSearchRequest("查一下wlop的作品"), { keyword: "wlop", searchType: "artist", order: "newest" })
  assert.deepEqual(parsePixivSearchRequest("希洛 查查海琴烟的画作"), { keyword: "海琴烟", searchType: "artist", order: "newest" })
  assert.deepEqual(parsePixivSearchRequest("搜搜初音未来的图"), { keyword: "初音未来", searchType: "artworks", order: "newest" })
  assert.deepEqual(parsePixivSearchRequest("p站搜海琴烟"), { keyword: "海琴烟", searchType: "artworks", order: "newest" })
  assert.deepEqual(parsePixivSearchRequest("来点海琴烟的插画"), { keyword: "海琴烟", searchType: "artworks", order: "newest" })
})

test("排序意图:热门/人气 → popular,最早 → oldest", () => {
  const popular1 = parsePixivSearchRequest("搜一些热门的初音未来同人图")
  assert.equal(popular1.order, "popular")
  assert.equal(popular1.keyword, "初音未来", "排序噪声词应从 keyword 中剥离")
  assert.equal(parsePixivSearchRequest("找初音未来的图,要人气最高的").order, "popular")
  assert.equal(parsePixivSearchRequest("查海琴烟的图 要收藏最多的").order, "popular")
  assert.equal(parsePixivSearchRequest("搜最早的海琴烟同人图").order, "oldest")
  assert.equal(parsePixivSearchRequest("搜最新的海琴烟同人图").order, "newest")
  assert.equal(parsePixivSearchRequest("搜新版初音未来的图").keyword, "新版初音未来", "正常的「新版」不能被排序词规则误杀")
})

test("parsePixivSearchRequest 不吞画图/识图/表情包/磁链意图", () => {
  assert.equal(parsePixivSearchRequest("帮我画一张猫"), null)
  assert.equal(parsePixivSearchRequest("生成一张初音未来的图片"), null)
  assert.equal(parsePixivSearchRequest("看看这张图里是什么"), null)
  assert.equal(parsePixivSearchRequest("来个表情包"), null)
  assert.equal(parsePixivSearchRequest("下载 magnet:?xt=urn:btih:ABC"), null)
  assert.equal(parsePixivSearchRequest("今天天气怎么样"), null)
})

test("parsePixivDownloadRequest 识别序号与作品ID,多选/磁链让位给磁链工具", () => {
  assert.deepEqual(parsePixivDownloadRequest("下载 3"), { target: "3" })
  assert.deepEqual(parsePixivDownloadRequest("下第2张"), { target: "2" })
  assert.deepEqual(parsePixivDownloadRequest("下载 126649495"), { target: "126649495" })
  assert.deepEqual(parsePixivDownloadRequest("下载id 126649495"), { target: "126649495" })
  assert.equal(parsePixivDownloadRequest("下载 1,3"), null, "多选编号是磁链语义")
  assert.equal(parsePixivDownloadRequest("下载第1个和第3个"), null)
  assert.equal(parsePixivDownloadRequest("下载 magnet:?xt=urn:btih:ABC"), null)
})

test("找图意图命中候选,参数拆解交给语义规划器的低模型(不走正则确定性)", () => {
  assert.deepEqual(selectToolIntentCandidates("查一下wlop的作品", AVAILABLE), ["pixivSearchTool"])
  assert.equal(
    resolveDeterministicToolIntent("查一下wlop的作品", AVAILABLE),
    null,
    "搜索类关键词抽取措辞多变,不提供确定性解析,由低模型按披露规则拆解"
  )
  // 下载序号无歧义,保留确定性快路
  assert.deepEqual(
    resolveDeterministicToolIntent("下载 2", AVAILABLE, { hasPixivSearchSession: true }),
    { intent: "tool", toolName: "pixivDownloadTool", params: { target: "2" }, reason: "deterministic_manifest" }
  )
})

test("「下载 N」按会话与数字形态在 Pixiv 和磁链之间消歧", () => {
  const session = { group_id: 123, user_id: 1 }
  assert.equal(hasRecentPixivSearch(session), false)
  // 无 Pixiv 会话:短序号维持磁链语义
  assert.deepEqual(selectToolIntentCandidates("下载 2", AVAILABLE, { hasPixivSearchSession: false }), ["torrentDownloadTool"])
  // 建立会话后:短序号归 Pixiv
  savePixivSearchSession(session, { keyword: "wlop", items: [{ id: "1", title: "t" }] }, { redis: null })
  assert.equal(hasRecentPixivSearch(session), true, "同步会话检查应命中本地会话")
  assert.deepEqual(selectToolIntentCandidates("下载 2", AVAILABLE, { hasPixivSearchSession: true }), ["pixivDownloadTool"])
  assert.deepEqual(resolveDeterministicToolIntent("下载 2", AVAILABLE, { hasPixivSearchSession: true }).params, { target: "2" })
  // 5位以上数字像作品ID,即使无会话也倾向 Pixiv
  assert.deepEqual(
    selectToolIntentCandidates("下载 126649495", AVAILABLE, { hasPixivSearchSession: false }),
    ["pixivDownloadTool"]
  )
  // 多选编号永远是磁链
  assert.deepEqual(
    selectToolIntentCandidates("下载 1,3", AVAILABLE, { hasPixivSearchSession: true }),
    ["torrentDownloadTool"]
  )
  // 磁链永远归磁链工具
  assert.deepEqual(
    selectToolIntentCandidates("帮我下载 magnet:?xt=urn:btih:AF4B684892182408E4AE9DF0C8FFE9E49CCBF171", AVAILABLE, { hasPixivSearchSession: true }),
    ["torrentDownloadTool"]
  )
})

test("搜索/下载工具都有披露说明", () => {
  assert.match(buildToolIntentDisclosure(["pixivSearchTool"]), /pixivSearchTool 详细用法/)
  assert.match(buildToolIntentDisclosure(["pixivDownloadTool"]), /pixivDownloadTool 详细用法/)
})

test("普通聊天不误触发 Pixiv 工具", () => {
  assert.deepEqual(selectToolIntentCandidates("今天中午吃什么", AVAILABLE), [])
  assert.deepEqual(selectToolIntentCandidates("帮我画一张猫", AVAILABLE).includes("pixivSearchTool"), false)
})

test("Pixiv 两个工具是终态工具:卡面/图片即回复,不进入 LLM 续轮", async () => {
  const { TERMINAL_TOOL_NAMES } = await import("../core/intent/messageIntent.js")
  assert.equal(TERMINAL_TOOL_NAMES.has("pixivSearchTool"), true, "搜索卡面发出后不应再让模型续轮(否则会二次调用工具)")
  assert.equal(TERMINAL_TOOL_NAMES.has("pixivDownloadTool"), true)
})

test("Redis 会话 TTL 写入:对象形式 PX 优先,不支持时回退 pExpire", async () => {
  const e = { group_id: 424242 }
  // 主路径:客户端支持 SET 的对象参数(node-redis v4 / ioredis v5)
  const setOptions = []
  const fakeRedis = { set: async (key, value, options) => { if (options) setOptions.push(options.PX) } }
  await savePixivSearchSession(e, { keyword: "wlop", items: [{ id: "1", title: "t" }] }, { redis: fakeRedis })
  assert.equal(setOptions.length, 1, "应以对象形式写入 PX")
  assert.ok(setOptions[0] > 290_000 && setOptions[0] <= 300_000, "TTL 应接近 5 分钟")

  // 回退路径:对象参数抛错(老客户端),用驼峰 pExpire 单独设置
  const expireCalls = []
  const legacyRedis = {
    set: async (key, value, options) => { if (options) throw new TypeError("options not supported") },
    pExpire: async (key, ms) => { expireCalls.push([key, ms]) }
  }
  await savePixivSearchSession(e, { keyword: "wlop", items: [{ id: "1", title: "t" }] }, { redis: legacyRedis })
  assert.equal(expireCalls.length, 1, "回退路径应调用 pExpire")
  assert.ok(expireCalls[0][1] > 290_000 && expireCalls[0][1] <= 300_000)
})

test("工具参数归一化:低模型的自然语言枚举值映射到合法值", async () => {
  const { normalizePixivSearchType, normalizePixivOrderBy, normalizePixivKeyword } = await import("../utils/pixivIntent.js")
  assert.equal(normalizePixivSearchType("插画"), "artworks")
  assert.equal(normalizePixivSearchType("图片"), "artworks")
  assert.equal(normalizePixivSearchType("画师"), "artist")
  assert.equal(normalizePixivSearchType("作者"), "artist")
  assert.equal(normalizePixivSearchType("artworks"), "artworks")
  assert.equal(normalizePixivOrderBy("相关度"), "newest")
  assert.equal(normalizePixivOrderBy("人气最高"), "popular")
  assert.equal(normalizePixivOrderBy("收藏最多"), "popular")
  assert.equal(normalizePixivOrderBy("最早"), "oldest")
  assert.equal(normalizePixivKeyword("跟翠月有关"), "翠月", "关键词框架词应被剥离")

  const { PixivSearchTool } = await import("../functions/functions_tools/PixivSearchTool.js")
  const tool = new PixivSearchTool()
  const normalized = tool.normalizeParameters({ keyword: "跟翠月有关", searchType: "插画", orderBy: "相关度" })
  assert.deepEqual(normalized, { keyword: "翠月", searchType: "artworks", orderBy: "newest" })
  const validation = tool.validateParameters(normalized)
  assert.equal(validation, true, "归一化后必须通过参数校验")
})
