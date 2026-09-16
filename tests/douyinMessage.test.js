import assert from "node:assert/strict"
import { test } from "node:test"
import {
  clearDouyinMetadataCache,
  enrichDouyinShare,
  enrichDouyinMessageSegments,
  extractDouyinShareFromText,
  formatDouyinHistoryLinks,
  formatDouyinHistoryText
} from "../utils/douyinMessage.js"

const item = {
  aweme_id: "7661206883327471737",
  desc: "有路人 好尴尬…… #日系#dance#NIGHTDANCER 👓",
  author: { nickname: "Luffy乐菲^^", sec_uid: "sec-user" },
  duration: 16,
  statistics: { play_count: 0, digg_count: 1533257, comment_count: 7515, share_count: 96125, collect_count: 83917 },
  video: {
    play_addr: { url_list: ["https://aweme.example/playwm?ratio=720p"] },
    cover: { url_list: ["https://cover.example/cover.webp"] }
  }
}

function routerHtml(value = item) {
  return `<script>window._ROUTER_DATA = ${JSON.stringify({ loaderData: { "video_(id)/page": { videoInfoRes: { item_list: [value] } } } })}</script>`
}

test("extracts and enriches a Douyin text share from public router data", async () => {
  clearDouyinMetadataCache()
  const source = "复制打开抖音 https://v.douyin.com/EULdbQEydtc/ :6pm"
  const raw = extractDouyinShareFromText(source)
  assert.equal(raw?.type, "douyin")
  assert.equal(raw?.short_url, "https://v.douyin.com/EULdbQEydtc/")

  const segments = await enrichDouyinMessageSegments([{ type: "text", text: source }], "", {
    fetchImpl: async () => ({
      ok: true,
      url: "https://www.iesdouyin.com/share/video/7661206883327471737/?tracking=1",
      async text() { return routerHtml() }
    })
  })
  const card = segments.at(-1)
  assert.equal(card.type, "douyin")
  assert.equal(card.aweme_id, item.aweme_id)
  assert.equal(card.author, "Luffy乐菲^^")
  assert.equal(card.duration, 16)
  assert.equal(card.play_url, "https://aweme.example/playwm?ratio=720p")
  assert.deepEqual(card.stats, item.statistics)
  assert.match(formatDouyinHistoryText(card), /点赞:1533257/)
  assert.match(formatDouyinHistoryText(card), /\n数据：/)
  assert.match(formatDouyinHistoryLinks(card), /视频 URL:https:\/\/www\.iesdouyin\.com\/share\/video\/7661206883327471737\//)
})

test("does not create a Douyin card for unrelated text or failed public data", async () => {
  assert.equal(extractDouyinShareFromText("https://example.com/video"), null)
  const segments = await enrichDouyinMessageSegments([{ type: "text", text: "https://v.douyin.com/test/" }], "", {
    fetchImpl: async () => ({ ok: false, url: "https://www.iesdouyin.com/share/video/1/", async text() { return "" } })
  })
  assert.equal(segments.length, 2)
  assert.equal(segments[1].type, "douyin")
  assert.equal(segments[1].metadata_status, "link")
})

test("refreshes temporary Douyin playback resources after the short cache window", async () => {
  clearDouyinMetadataCache()
  let calls = 0
  const fetchImpl = async () => {
    calls += 1
    return {
      ok: true,
      url: "https://www.iesdouyin.com/share/video/7661206883327471737/",
      async text() {
        return routerHtml({
          ...item,
          video: { ...item.video, play_addr: { url_list: [`https://aweme.example/play-${calls}`] } }
        })
      }
    }
  }
  const source = extractDouyinShareFromText("https://v.douyin.com/EULdbQEydtc/")
  const first = await enrichDouyinShare(source, { fetchImpl, cacheTtlMs: 0 })
  const second = await enrichDouyinShare(source, { fetchImpl, cacheTtlMs: 0 })
  assert.equal(calls, 2)
  assert.notEqual(first.play_url, second.play_url)
})

test("分享页静态解析失败时走浏览器兜底并合并卡片字段", async () => {
  const calls = []
  const failingFetch = async () => ({ ok: false, url: "https://www.iesdouyin.com/share/video/1/", status: 403 })
  const browserResolver = async card => {
    calls.push(card)
    return {
      play_url: "https://v26.douyinvod.com/video/tos/cn/tos-cn-ve-15c001-alinc2/abc.mp4",
      cover_url: "https://p3.douyinpic.com/cover.jpg",
      title: "香蕉出轨了",
      author: "free1987hl",
      duration: 45000,
      aweme_id: "7461",
      final_url: "https://www.iesdouyin.com/share/video/7461/"
    }
  }
  const card = await enrichDouyinShare(
    { type: "douyin", short_url: "https://v.douyin.com/abc123/", page_url: "https://www.iesdouyin.com/share/video/7461/", aweme_id: "7461" },
    { fetchImpl: failingFetch, browserResolver, logger: null }
  )
  assert.equal(calls.length, 1)
  assert.equal(card.metadata_status, "resolved")
  assert.match(card.play_url, /\.mp4/)
  assert.equal(card.title, "香蕉出轨了")
  assert.equal(card.author, "free1987hl")
  assert.equal(card.duration, 45, "毫秒口径应折算成秒")
  assert.equal(card.page_url, "https://www.iesdouyin.com/share/video/7461/")
})

test("浏览器兜底也拿不到地址时保持 link 降级且不抛错", async () => {
  const failingFetch = async () => ({ ok: false, url: "https://www.iesdouyin.com/share/video/2/", status: 403 })
  const card = await enrichDouyinShare(
    { type: "douyin", short_url: "https://v.douyin.com/xyz/", aweme_id: "xyz" },
    { fetchImpl: failingFetch, browserResolver: async () => null, logger: null }
  )
  assert.equal(card.metadata_status, "link")
  assert.ok(!card.play_url)
})

test("extractPlayUrlFromJson 深找各版本 detail 响应结构", async () => {
  const { extractPlayUrlFromJson } = await import("../utils/douyinBrowserResolver.js")
  assert.equal(
    extractPlayUrlFromJson({ aweme_detail: { video: { play_addr: { url_list: ["https://a.douyinvod.com/x.mp4"] } } } }),
    "https://a.douyinvod.com/x.mp4"
  )
  assert.equal(
    extractPlayUrlFromJson({ item_list: [{ video: { playAddr: { url_list: [null, "https://b.douyinvod.com/y.mp4"] } } }] }),
    "https://b.douyinvod.com/y.mp4"
  )
  assert.equal(extractPlayUrlFromJson({ nothing: true }), "")
  assert.equal(extractPlayUrlFromJson(null), "")
})
