import assert from "node:assert/strict"
import { test } from "node:test"
import {
  clearXiaohongshuMetadataCache,
  extractXiaohongshuShareFromText,
  formatXiaohongshuHistoryLinks,
  formatXiaohongshuHistoryText,
  parseXiaohongshuInitialState,
  buildCardFromNoteState,
  normalizeXiaohongshuImageUrl,
  decodeXiaohongshuCardEntities,
  extractXiaohongshuVideo,
  extractXiaohongshuDescription,
  extractXiaohongshuGallery
} from "../utils/xiaohongshuMessage.js"

// 生产归档里的真实 QQ 分享卡片 raw_message(群 763694201, 2026-10-19):
// CQ 码内逗号被转义为 &#44;、& 转义为 &amp;,链接在 meta.news.jumpUrl 且带 xsec_token。
const REAL_QQ_CARD = `[CQ:json,data={"app":"com.tencent.tuwen.lua"&#44;"config":{"forward":1}&#44;"meta":{"news":{"desc":"#抽象  #搞笑  比片还…"&#44;"jumpUrl":"https://www.xiaohongshu.com/discovery/item/6ad4a9c200000000290162d4?app_platform=android&amp;xsec_source=app_share&amp;type=video&amp;xsec_token=CBk9hGfY20NW_N6sUu3oSQqfzTcCYGul4MCyGb-rdT6po%3D&amp;share_channel=qq"&#44;"preview":"https://qq.ugcimg.cn/v1/abc/nt54"&#44;"tag":"小红书"&#44;"title":"早期嘉豪借寿😡😡（原版"}}&#44;"view":"news"}]`

test("extracts the note from a real QQ share card with CQ entities", () => {
  const card = extractXiaohongshuShareFromText(REAL_QQ_CARD)
  assert.ok(card)
  assert.equal(card.type, "xiaohongshu")
  assert.equal(card.note_id, "6ad4a9c200000000290162d4")
  assert.equal(card.metadata_status, "identified")
  assert.match(card.page_url, /^https:\/\/www\.xiaohongshu\.com\/discovery\/item\/6ad4a9c200000000290162d4\?/)
  // 实体必须还原:&amp; → &,xsec_token 原样保留
  assert.match(card.page_url, /xsec_token=CBk9hGfY20NW_N6sUu3oSQqfzTcCYGul4MCyGb-rdT6po%3D/)
  assert.ok(card.page_url.includes("app_platform=android&xsec_source=app_share"))
  assert.equal(card.title, "早期嘉豪借寿😡😡（原版")
  assert.equal(card.xsec_token, "CBk9hGfY20NW_N6sUu3oSQqfzTcCYGul4MCyGb-rdT6po%3D")
  assert.equal(card.cover_url, "https://qq.ugcimg.cn/v1/abc/nt54")
})

test("extracts explore/discovery links with xsec_token from plain text", () => {
  const card = extractXiaohongshuShareFromText("看看这个 https://www.xiaohongshu.com/explore/651a2b3c000000000d0e0f10?xsec_token=ABcd%3D&xsec_source=app_share 哈哈")
  assert.ok(card)
  assert.equal(card.note_id, "651a2b3c000000000d0e0f10")
  assert.equal(card.xsec_token, "ABcd%3D")
  assert.equal(card.metadata_status, "identified")
})

test("extracts xhslink short links", () => {
  const card = extractXiaohongshuShareFromText("http://xhslink.com/aBC123 好活")
  assert.ok(card)
  assert.equal(card.type, "xiaohongshu")
  assert.equal(card.short_url, "https://xhslink.com/aBC123")
  assert.equal(card.note_id, "")
  assert.equal(card.metadata_status, "link")
})

test("ignores non-xiaohongshu content", () => {
  assert.equal(extractXiaohongshuShareFromText("https://www.bilibili.com/video/BV1xx411 例子"), null)
  assert.equal(extractXiaohongshuShareFromText("https://v.douyin.com/AbCdEf/"), null)
  assert.equal(extractXiaohongshuShareFromText("今天天气不错"), null)
  // 卡片但 tag 与链接都不是小红书 → 不误报
  assert.equal(extractXiaohongshuShareFromText(`[CQ:json,data={"meta":{"news":{"tag":"哔哩哔哩"&#44;"jumpUrl":"https://b23.tv/abc"}}}]`), null)
})

test("normalizes signed CDN urls to the stable image host", () => {
  assert.equal(
    normalizeXiaohongshuImageUrl("http://sns-webpic-qc.xhscdn.com/202610192230/0d0fdbade8f2accf63f91cda599e2157/1040g2sg326fbqndbk4e05q0i05bji0mff371lb8!h5_1080jpg"),
    "https://sns-img-qc.xhscdn.com/1040g2sg326fbqndbk4e05q0i05bji0mff371lb8"
  )
  assert.equal(
    normalizeXiaohongshuImageUrl("https://sns-img-qc.xhscdn.com/1040g2sg326fbqndbk4e05q0i05bji0mff371lb8"),
    "https://sns-img-qc.xhscdn.com/1040g2sg326fbqndbk4e05q0i05bji0mff371lb8"
  )
  // ci 包装地址先解内层再重建
  assert.equal(
    normalizeXiaohongshuImageUrl("https://ci.xiaohongshu.com/http%3A%2F%2Fsns-webpic-qc.xhscdn.com%2F202610192230%2F0d0fdbade8f2accf63f91cda599e2157%2F1040g2sg326fbqndbk4e05q0i05bji0mff371lb8"),
    "https://sns-img-qc.xhscdn.com/1040g2sg326fbqndbk4e05q0i05bji0mff371lb8"
  )
})

test("decodes CQ numeric entities before &amp;", () => {
  assert.equal(decodeXiaohongshuCardEntities("a&#44;b&amp;c"), "a,b&c")
})

test("parses __INITIAL_STATE__ note detail map", () => {
  const noteId = "64f0a1b2000000001c00ed1a"
  const html = `<html><script>window.__INITIAL_STATE__={"note":{"noteDetailMap":{"${noteId}":{"note":{"title":"咖啡地图","desc":"三家店推荐","type":"normal","user":{"nickname":"小柚"},"interactInfo":{"liked":"1.2万","collected":"356","commentCount":"42"},"imageList":[{"infoList":[{"url":"http://sns-webpic-qc.xhscdn.com/202610192230/aaa/1040g2sg326fbqndbk4e05q0i05bji0mff371lb8!h5_1080jpg"}],"urlDefault":"https://sns-img-qc.xhscdn.com/1040g2sg326fbqndbk4e05q0i05bji0mff371lb8"}]}}}}}</script></html>`
  const card = buildCardFromNoteState(
    {type:"xiaohongshu", note_id: noteId, page_url:`https://www.xiaohongshu.com/explore/${noteId}`},
    parseXiaohongshuInitialState(html),
    `https://www.xiaohongshu.com/explore/${noteId}`
  )
  assert.ok(card)
  assert.equal(card.title, "咖啡地图")
  assert.equal(card.description, "三家店推荐")
  assert.equal(card.author, "小柚")
  assert.equal(card.liked, 12000)
  assert.equal(card.collected, 356)
  assert.equal(card.comment_count, 42)
  assert.equal(card.media_kind, "image")
  assert.equal(card.metadata_status, "resolved")
  assert.deepEqual(card.images, ["https://sns-webpic-qc.xhscdn.com/202610192230/aaa/1040g2sg326fbqndbk4e05q0i05bji0mff371lb8!h5_1080jpg"], "infoList[0].url 原样保留")
})

test("state without note data returns null", () => {
  assert.equal(buildCardFromNoteState({type:"xiaohongshu"}, parseXiaohongshuInitialState(`<script>window.__INITIAL_STATE__={"global":{"appSettings":{}}}</script>`), ""), null)
  assert.deepEqual(parseXiaohongshuInitialState("<html>no state</html>"), {})
})

test("extracts the preferred video stream from a hydrated mobile state", () => {
  // 移动端 state 的视频流路径随版本漂移,深找时按子树编码上下文排序
  const state = {
    note: {
      videoData: {
        media: {
          stream: {
            h265: [{master_url: "http://sns-video-v6.xhscdn.com/stream/1/110/520/hevc_520.mp4?sign=b", duration: 666}],
            h264: [{master_url: "http://sns-video-v6.xhscdn.com/stream/1/110/259/h264_259.mp4?sign=a", duration: 42}]
          }
        }
      }
    }
  }
  const video = extractXiaohongshuVideo(state)
  assert.equal(video.playUrl, "https://sns-video-v6.xhscdn.com/stream/1/110/259/h264_259.mp4?sign=a")
  assert.equal(video.codec, "h264")
  // 时长取最优流条目自己的值(秒口径)
  assert.equal(video.duration, 42)
})

test("extracts per-image live photos aligned with the gallery", () => {
  const image = (live, fileId) => ({
    livePhoto: live,
    stream: live ? {h264: [{masterUrl: `http://sns-video-qc.xhscdn.com/stream/${fileId}.mp4?sign=a`, backupUrls: [`http://sns-bak-v6.xhscdn.com/stream/${fileId}.mp4`]}]} : {},
    url: `http://sns-webpic-qc.xhscdn.com/202610192230/sig/${fileId}!h5_1080jpg`,
    infoList: [{url: `http://sns-webpic-qc.xhscdn.com/202610192230/sig/${fileId}!h5_1080jpg`}]
  })
  const state = {note: {detail: {imageList: [image(true, "1040g2sg0000000000000000000000aa1"), image(false, "1040g2sg0000000000000000000000aa2"), image(true, "1040g2sg0000000000000000000000aa3")]}}}
  const gallery = extractXiaohongshuGallery(state)
  assert.equal(gallery.length, 3)
  assert.equal(gallery[0].imageUrl, "https://sns-webpic-qc.xhscdn.com/202610192230/sig/1040g2sg0000000000000000000000aa1!h5_1080jpg", "原样保留签名链")
  assert.match(gallery[0].liveUrl, /sns-video-qc\.xhscdn\.com\/stream\/1040g2sg0000000000000000000000aa1\.mp4/)
  assert.equal(gallery[1].liveUrl, "", "非实况图为空串,保下标对齐")
  assert.equal(gallery[2].liveUrl.includes("aa3"), true)
  assert.deepEqual(extractXiaohongshuGallery({a: 1}), [])
})

test("video extraction tolerates states without streams", () => {
  assert.deepEqual(extractXiaohongshuVideo({global: {appSettings: {}}}), {playUrl: "", codec: "", duration: 0})
  assert.equal(extractXiaohongshuVideo(null).playUrl, "")
  // 秒口径不折算;毫秒兜底仅 >100s 量级
  const seconds = extractXiaohongshuVideo({stream: {h264: [{master_url: "https://sns-video.xhscdn.com/a.mp4", duration: 42}]}})
  assert.equal(seconds.duration, 42)
  const msFallback = extractXiaohongshuVideo({stream: {h264: [{master_url: "https://sns-video.xhscdn.com/a.mp4"}]}, duration: 250000})
  assert.equal(msFallback.duration, 250)
})

test("extracts the full description from a hydrated mobile state", () => {
  const state = {note: {detail: {desc: "gt5银色真的百搭…\ngt7继续冲银色！！\n#华为gt7[话题]#", extra: {desc: "短"}}}}
  const description = extractXiaohongshuDescription(state)
  assert.ok(description.startsWith("gt5银色真的百搭"))
  assert.ok(description.includes("#华为gt7[话题]#"), "话题标签应保留")
  assert.equal(extractXiaohongshuDescription({a: {b: {c: 1}}}), "")
})

test("share url type marks the media kind for live-photo disambiguation", () => {
  const normal = extractXiaohongshuShareFromText("https://www.xiaohongshu.com/discovery/item/6ad73457000000000c0093d5?xsec_token=T%3D&type=normal&xsec_source=app_share")
  assert.equal(normal.media_kind, "image")
  const video = extractXiaohongshuShareFromText("https://www.xiaohongshu.com/discovery/item/6ad4a9c200000000290162d4?xsec_token=T%3D&type=video&xsec_source=app_share")
  assert.equal(video.media_kind, "video")
  const unknown = extractXiaohongshuShareFromText("http://xhslink.com/aBC123")
  assert.equal(unknown.media_kind, undefined)
})

test("formats history text and links", () => {
  const card = {
    type: "xiaohongshu", note_id: "64f0a1b2000000001c00ed1a", title: "咖啡地图", author: "小柚",
    description: "三家店推荐", liked: 12000, collected: 356, comment_count: 42,
    images: ["https://sns-img-qc.xhscdn.com/a"], cover_url: "https://sns-img-qc.xhscdn.com/a",
    page_url: "https://www.xiaohongshu.com/explore/64f0a1b2000000001c00ed1a", media_kind: "image"
  }
  const text = formatXiaohongshuHistoryText(card)
  assert.match(text, /分享了小红书笔记《咖啡地图》/)
  assert.match(text, /作者:小柚/)
  assert.match(text, /点赞:12000/)
  assert.match(text, /图片:1张/)
  assert.ok(!text.includes("简介"), "简介已移到独立转发节点,不再放头部")
  assert.match(formatXiaohongshuHistoryLinks(card), /笔记 URL:https:\/\/www\.xiaohongshu\.com/)
})

test("enrich falls back to the browser resolver when the static page has no note data", async () => {
  clearXiaohongshuMetadataCache()
  const {createXiaohongshuMessage} = await import("../dist/backend/modules/media/infrastructure/xiaohongshuMessage.js")
  const runtime = createXiaohongshuMessage({
    browserResolver: async card => ({
      ...card,
      title: "浏览器标题", author: "作者A", description: "浏览器正文",
      images: ["http://sns-webpic-qc.xhscdn.com/202610192230/sig/1040g2sg326fbqndbk4e05q0i05bji0mff371lb8!h5_1080jpg"],
      cover_url: "", media_kind: "video", note_id: "6ad4a9c200000000290162d4", final_url: "https://www.xiaohongshu.com/discovery/item/6ad4a9c200000000290162d4"
    })
  })
  const previousFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => ({ok: true, url: "https://www.xiaohongshu.com/discovery/item/6ad4a9c200000000290162d4", text: async () => "<script>window.__INITIAL_STATE__={}</script>"})
    const card = await runtime.enrichXiaohongshuShare({
      type: "xiaohongshu", note_id: "6ad4a9c200000000290162d4",
      page_url: "https://www.xiaohongshu.com/discovery/item/6ad4a9c200000000290162d4?xsec_token=X"
    }, {fetchImpl: globalThis.fetch})
    assert.equal(card.metadata_status, "resolved")
    assert.equal(card.title, "浏览器标题")
    assert.equal(card.author, "作者A")
    assert.equal(card.media_kind, "video")
    assert.deepEqual(card.images, ["https://sns-webpic-qc.xhscdn.com/202610192230/sig/1040g2sg326fbqndbk4e05q0i05bji0mff371lb8!h5_1080jpg"])
  } finally {
    globalThis.fetch = previousFetch
  }
  clearXiaohongshuMetadataCache()
})

test("enrich keeps card metadata when static parse and browser both fail", async () => {
  clearXiaohongshuMetadataCache()
  const {createXiaohongshuMessage} = await import("../dist/backend/modules/media/infrastructure/xiaohongshuMessage.js")
  const runtime = createXiaohongshuMessage({browserResolver: async () => null})
  const previousFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => ({ok: false, url: "https://www.xiaohongshu.com/discovery/item/x"})
    const card = await runtime.enrichXiaohongshuShare({
      type: "xiaohongshu", note_id: "6ad4a9c200000000290162d4", title: "卡片标题", metadata_status: "identified",
      page_url: "https://www.xiaohongshu.com/discovery/item/6ad4a9c200000000290162d4?xsec_token=X"
    }, {fetchImpl: globalThis.fetch})
    assert.equal(card.metadata_status, "identified")
    assert.equal(card.title, "卡片标题")
  } finally {
    globalThis.fetch = previousFetch
  }
  clearXiaohongshuMetadataCache()
})
