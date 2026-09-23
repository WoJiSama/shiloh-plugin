import assert from "node:assert/strict"
import { test } from "node:test"
import { parsePixivDownloadRequest, parsePixivSearchRequest } from "../utils/pixivIntent.js"
import { buildToolIntentDisclosure, resolveDeterministicToolIntent, selectToolIntentCandidates } from "../utils/toolIntentManifests.js"
import { hasRecentPixivSearch, savePixivSearchSession } from "../utils/pixivSearch.js"

const AVAILABLE = ["pixivSearchTool", "pixivDownloadTool", "torrentDownloadTool", "searchInformationTool"]

test("parsePixivSearchRequest 识别画师/关键词找图并抽取 keyword", () => {
  assert.deepEqual(parsePixivSearchRequest("查一下wlop的作品"), { keyword: "wlop", searchType: "artist" })
  assert.deepEqual(parsePixivSearchRequest("希洛 查查海琴烟的画作"), { keyword: "海琴烟", searchType: "artist" })
  assert.deepEqual(parsePixivSearchRequest("搜搜初音未来的图"), { keyword: "初音未来", searchType: "artworks" })
  assert.deepEqual(parsePixivSearchRequest("p站搜海琴烟"), { keyword: "海琴烟", searchType: "artworks" })
  assert.deepEqual(parsePixivSearchRequest("来点海琴烟的插画"), { keyword: "海琴烟", searchType: "artworks" })
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

test("找图意图命中 pixivSearchTool 并可确定性解析参数", () => {
  assert.deepEqual(selectToolIntentCandidates("查一下wlop的作品", AVAILABLE), ["pixivSearchTool"])
  assert.deepEqual(
    resolveDeterministicToolIntent("查一下wlop的作品", AVAILABLE),
    { intent: "tool", toolName: "pixivSearchTool", params: { keyword: "wlop", searchType: "artist" }, reason: "deterministic_manifest" }
  )
  assert.deepEqual(
    resolveDeterministicToolIntent("搜搜初音未来的图", AVAILABLE).params,
    { keyword: "初音未来", searchType: "artworks" }
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
