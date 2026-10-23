import assert from "node:assert/strict"
import { test } from "node:test"
import { MediaOutbox } from "../utils/messagePipeline/mediaOutbox.js"
import { RedisJobStore } from "../utils/messagePipeline/redisJobStore.js"
import { createFakeRedis } from "./helpers/fakeRedis.js"
import { extractFromDomPayload } from "../utils/xiaohongshuBrowserResolver.js"
import { extractXiaohongshuShareFromText } from "../utils/xiaohongshuMessage.js"

function dummyGateway() {
  return { sendGroupForward: async () => ({}), sendGroupText: async () => ({}) }
}

test("media outbox registers the xiaohongshu platform adapter", () => {
  const outbox = new MediaOutbox({ store: new RedisJobStore({ redis: createFakeRedis() }), gateway: dummyGateway() })
  const adapter = outbox.platformAdapter("xiaohongshu")
  assert.ok(adapter, "xiaohongshu adapter should exist")
  assert.equal(adapter.enabled, true)
  assert.deepEqual(adapter.resolvedStatuses, ["resolved"])
  assert.equal(adapter.stableId({type: "xiaohongshu", note_id: "64f0a1b2000000001c00ed1a"}), "64f0a1b2000000001c00ed1a")
  assert.equal(typeof adapter.enrich, "function")
  assert.equal(typeof adapter.build, "function")
})

test("xiaohongshu adapter can be disabled via relay config", () => {
  const outbox = new MediaOutbox({
    store: new RedisJobStore({ redis: createFakeRedis() }),
    gateway: dummyGateway(),
    xiaohongshuRelay: {enabled: false}
  })
  assert.equal(outbox.platformAdapter("xiaohongshu").enabled, false)
})

test("pipeline detection: QQ card raw_message is recognized as xiaohongshu media", () => {
  // findRawMedia 的最后一个环节调用本提取器;直接验证真实卡片能产出可入队的 media 卡
  const media = extractXiaohongshuShareFromText(`[CQ:json,data={"meta":{"news":{"tag":"小红书"&#44;"jumpUrl":"https://www.xiaohongshu.com/discovery/item/6ad4a9c200000000290162d4?xsec_token=T%3D"}}}]`)
  assert.equal(media.type, "xiaohongshu")
  const outbox = new MediaOutbox({ store: new RedisJobStore({ redis: createFakeRedis() }), gateway: dummyGateway() })
  assert.ok(outbox.platformAdapter(media.type)?.enabled)
})

// 浏览器兜底的 DOM 启发式(移动端页面结构):
// 首行昵称 + "关注" + "展开" + 正文,图片按图床域名过滤头像/UI
test("extracts title/author/description/images from mobile DOM payload", () => {
  const result = extractFromDomPayload({
    title: "早期嘉豪借寿😡😡（原版） - 小红书",
    bodyText: "Aurora🐾\n关注\n展开\n早期嘉豪借寿😡😡（原版） 比片还难找[色色R]看完不笑\n发弹幕\n1222\n678\n83\n83条精选评论\n查看更多",
    imageUrls: [
      "https://sns-avatar-qc.xhscdn.com/avatar/1040g2jo3239okmtr6u005q0i05bji0mfn1v2d0o?imageView2/2/w/120/format/jpg",
      "http://sns-webpic-qc.xhscdn.com/202610192230/sig/1040g2sg326fbqndbk4e05q0i05bji0mff371lb8!h5_1080jpg",
      "https://picasso-static.xiaohongshu.com/fe-platform/ui.png"
    ],
    ogImage: "",
    hasVideo: true,
    noteUrl: "https://www.xiaohongshu.com/discovery/item/6ad4a9c200000000290162d4"
  })
  assert.equal(result.title, "早期嘉豪借寿😡😡（原版）")
  assert.equal(result.author, "Aurora🐾")
  assert.match(result.description, /^早期嘉豪借寿/)
  assert.ok(!result.description.includes("发弹幕"))
  assert.equal(result.media_kind, "video")
  // 头像(avatar)与 UI 图被过滤,只剩笔记封面且已重建为无签名图床地址
  // 新语义:保留原始(签名)链接仅统一 https
  assert.deepEqual(result.images, ["https://sns-webpic-qc.xhscdn.com/202610192230/sig/1040g2sg326fbqndbk4e05q0i05bji0mff371lb8!h5_1080jpg"])
  assert.equal(result.cover_url, "https://sns-webpic-qc.xhscdn.com/202610192230/sig/1040g2sg326fbqndbk4e05q0i05bji0mff371lb8!h5_1080jpg")
})

test("DOM extraction tolerates imageless pages", () => {
  const result = extractFromDomPayload({title: "只有文字 - 小红书", bodyText: "作者A\n关注\n展开\n正文内容", imageUrls: [], ogImage: "", hasVideo: false, noteUrl: "https://www.xiaohongshu.com/explore/x"})
  assert.equal(result.title, "只有文字")
  assert.equal(result.author, "作者A")
  assert.equal(result.description, "正文内容")
  assert.deepEqual(result.images, [])
})
