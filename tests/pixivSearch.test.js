import assert from "node:assert/strict"
import { test } from "node:test"
import {
  normalizePixivSearchItem,
  resolvePixivArtistFromItems,
  resolvePixivDownloadTarget,
  savePixivSearchSession,
  loadPixivSearchSession,
  searchPixivArtworks,
  listPixivArtistRecentWorks
} from "../utils/pixivSearch.js"

const searchPayload = {
  error: false,
  body: {
    illustManga: {
      total: 459,
      data: [
        { id: "148221186", title: "Ice Princess", userName: "DoluDolu", userId: "111", pageCount: 7, xRestrict: 0, url: "https://i.pximg.net/c/250x250_a2/img-master/img/a.jpg" },
        { id: "147972681", title: "test", userName: "aeron", userId: "222", pageCount: 1, xRestrict: 0, url: "https://evil.example/x.jpg" },
        { id: "147399236", title: "Wlop style", userName: "WLOP", userId: "2188232", pageCount: 1, xRestrict: 1, url: "https://i.pximg.net/c/250x250_a2/img-master/img/b.jpg" },
        { id: "bad", title: "invalid", userName: "x", userId: "1", pageCount: 1, xRestrict: 0, url: "" },
        { id: "147399235", title: "Wlop works", userName: "WLOP", userId: "2188232", pageCount: 2, xRestrict: 0, url: "https://i.pximg.net/c/250x250_a2/img-master/img/c.jpg" }
      ]
    }
  }
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } })
}

test("normalizePixivSearchItem 过滤非法项并只信任 pximg 缩略图", () => {
  const items = searchPayload.body.illustManga.data.map(normalizePixivSearchItem).filter(Boolean)
  assert.equal(items.length, 4, "非法 id 与非法缩略图域名的项应保留但 thumbUrl 置空,仅 bad id 被过滤")
  const evil = items.find(item => item.id === "147972681")
  assert.equal(evil.thumbUrl, "", "非 pximg 域名不作为缩略图")
  const wlop = items.find(item => item.id === "147399235")
  assert.equal(wlop.userName, "WLOP")
  assert.equal(wlop.pageCount, 2)
})

test("searchPixivArtworks 走关键词接口并返回规范化结果", async () => {
  const calls = []
  const result = await searchPixivArtworks("wlop", {
    fetchImpl: async url => {
      calls.push(url)
      return jsonResponse(searchPayload)
    }
  })
  assert.equal(result.total, 459)
  assert.ok(result.items.length >= 3)
  assert.match(calls[0], /\/ajax\/search\/artworks\/wlop\?/)
  assert.match(calls[0], /mode=safe/)
})

test("resolvePixivArtistFromItems 按名字互相包含识别画师", () => {
  const items = searchPayload.body.illustManga.data.map(normalizePixivSearchItem).filter(Boolean)
  const artist = resolvePixivArtistFromItems(items, "wlop")
  assert.equal(artist.userId, "2188232")
  assert.equal(artist.userName, "WLOP")
  assert.equal(resolvePixivArtistFromItems(items, "不存在的画师"), null)
})

test("listPixivArtistRecentWorks 取画师最近作品并过滤失败详情", async () => {
  const urls = []
  const result = await listPixivArtistRecentWorks("2188232", {
    limit: 2,
    fetchImpl: async url => {
      urls.push(url)
      if (url.includes("/profile/all")) return jsonResponse({ error: false, body: { illusts: { "140403807": 1, "126649495": 1, "999999999": 1 } } })
      if (url.includes("999999999")) return jsonResponse({ error: true, message: "deleted" })
      return jsonResponse({ error: false, body: { id: url.match(/illust\/(\d+)/)[1], title: "作品" + url.match(/illust\/(\d+)/)[1], userName: "WLOP", userId: "2188232", pageCount: 1, xRestrict: 0, urls: { regular: "https://i.pximg.net/img-master/x.jpg" } } })
    }
  })
  assert.equal(result.userId, "2188232")
  assert.equal(result.items.length, 2, "取最近2个,其中1个详情失败被跳过")
  assert.deepEqual(urls.filter(url => url.includes("/profile/all")).length, 1)
})

test("搜索会话按群保存与回查,过期不可用", async () => {
  const e = { group_id: 12345 }
  await savePixivSearchSession(e, {
    keyword: "wlop",
    mode: "artworks",
    total: 459,
    items: searchPayload.body.illustManga.data.map(normalizePixivSearchItem).filter(Boolean)
  }, { redis: null })
  const loaded = await loadPixivSearchSession(e, { redis: null })
  assert.equal(loaded.keyword, "wlop")
  assert.equal(loaded.items.length, 4)

  // 超过 5 分钟 TTL 即失效
  await savePixivSearchSession(e, { ...loaded, items: loaded.items }, { redis: null, savedAt: Date.now() - 6 * 60 * 1000 })
  assert.equal(await loadPixivSearchSession(e, { redis: null }), null, "6 分钟前的会话应已过期")
  assert.equal(await loadPixivSearchSession({ group_id: 99999 }, { redis: null }), null)
})

test("新搜索覆盖旧会话,单槽只保留最近一次", async () => {
  const e = { group_id: 777 }
  await savePixivSearchSession(e, { keyword: "旧关键词", items: [{ id: "1", title: "旧" }] }, { redis: null })
  await savePixivSearchSession(e, { keyword: "新关键词", items: [{ id: "2", title: "新" }] }, { redis: null })
  const loaded = await loadPixivSearchSession(e, { redis: null })
  assert.equal(loaded.keyword, "新关键词")
  assert.equal(loaded.items.length, 1)
  assert.equal(loaded.items[0].title, "新")
})

test("下载成功后续期:5 分钟窗口从当前时刻重新起算", async () => {
  const e = { group_id: 888 }
  const { touchPixivSearchSession } = await import("../utils/pixivSearch.js")
  // 已过 4 分钟的会话仍在有效期内
  await savePixivSearchSession(e, { keyword: "wlop", items: [{ id: "1", title: "t" }] }, { redis: null, savedAt: Date.now() - 4 * 60 * 1000 })
  const nearExpiry = await loadPixivSearchSession(e, { redis: null })
  assert.ok(nearExpiry, "4 分钟前的会话仍在有效期内")
  const oldSavedAt = nearExpiry.savedAt
  const touched = await touchPixivSearchSession(e, { redis: null })
  assert.ok(touched, "续期应返回会话")
  assert.ok(touched.savedAt > oldSavedAt, "续期后 savedAt 应更新为当前时刻")
  assert.equal(touched.keyword, "wlop")
})

test("resolvePixivDownloadTarget 支持序号、#序号和直接作品ID", async () => {
  const session = {
    keyword: "wlop",
    items: [
      { id: "148221186", title: "Ice Princess", userName: "DoluDolu", pageCount: 7, xRestrict: 0 },
      { id: "147399235", title: "Wlop works", userName: "WLOP", pageCount: 2, xRestrict: 0 }
    ]
  }
  assert.equal(resolvePixivDownloadTarget("2", session).id, "147399235")
  assert.equal(resolvePixivDownloadTarget("#1", session).id, "148221186")
  assert.equal(resolvePixivDownloadTarget("126649495", session).id, "126649495")
  assert.equal(resolvePixivDownloadTarget("9", session).id, "")
  assert.equal(resolvePixivDownloadTarget("abc", session).id, "")
  assert.equal(resolvePixivDownloadTarget("3", null).id, "")
})

test("popular 排序:无 Cookie 降级为近期重排,有 Cookie 走原生 popular_d", async () => {
  const urls = []
  const fetchImpl = async url => {
    urls.push(url)
    const id = url.match(/illust\/(\d+)/)?.[1]
    if (url.includes("/profile/all")) return jsonResponse({ error: false, body: { illusts: {} } })
    if (id) return jsonResponse({ error: false, body: { id, bookmarkCount: Number(id) % 100 } })
    return jsonResponse({ error: false, body: { illustManga: { total: 3, data: [
      { id: "101", title: "a", userName: "u", userId: "1", pageCount: 1, xRestrict: 0, url: "https://i.pximg.net/a.jpg" },
      { id: "250", title: "b", userName: "u", userId: "1", pageCount: 1, xRestrict: 0, url: "https://i.pximg.net/b.jpg" },
      { id: "180", title: "c", userName: "u", userId: "1", pageCount: 1, xRestrict: 0, url: "https://i.pximg.net/c.jpg" }
    ] } } })
  }
  const anon = await searchPixivArtworks("wlop", { order: "popular", fetchImpl })
  assert.equal(anon.orderSource, "rerank", "无 Cookie 应回退近期重排")
  assert.deepEqual(anon.items.map(i => i.id), ["180", "250", "101"], "按收藏数重排(80>50>1)")
  urls.length = 0
  const authed = await searchPixivArtworks("wlop", { order: "popular", fetchImpl, cookieHeader: "PHPSESSID=xxx" })
  assert.equal(authed.orderSource, "native", "有 Cookie 走原生排序")
  assert.match(urls[0], /order=popular_d/, "请求应带原生 popular_d")
})
