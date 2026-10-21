import assert from "node:assert/strict"
import fs from "fs"
import { Readable } from "stream"
import { test } from "node:test"
import { buildXiaohongshuRelaySegments, cleanupXiaohongshuRelayFiles } from "../utils/xiaohongshuMediaRelay.js"

const IMAGE_URL = "http://sns-webpic-qc.xhscdn.com/202610192230/sig/1040g2sg326fbqndbk4e05q0i05bji0mff371lb8!h5_1080jpg"

function mockImageFetch() {
  return async () => ({
    ok: true,
    headers: { get: name => name === "content-length" ? "6" : null },
    body: Readable.toWeb(Readable.from(Buffer.from("jpeg!!")))
  })
}

test("note images are downloaded as gallery image nodes", async () => {
  const previousFetch = globalThis.fetch
  try {
    globalThis.fetch = mockImageFetch()
    const result = await buildXiaohongshuRelaySegments(
      {type: "xiaohongshu", note_id: "64f0a1b2000000001c00ed1a", title: "咖啡地图", images: [IMAGE_URL, IMAGE_URL.replace("ff371lb8", "aa11bb22")], page_url: "https://www.xiaohongshu.com/explore/64f0a1b2000000001c00ed1a"},
      { segmentApi: { image: file => ({type: "image", file}) }, logger: { warn() {}, info() {} } }
    )
    assert.equal(result.imageNodes.length, 2)
    assert.equal(result.tempFiles.length, 2)
    for (const file of result.tempFiles) assert.ok(fs.existsSync(file))
    await cleanupXiaohongshuRelayFiles(result.tempFiles)
    for (const file of result.tempFiles) assert.ok(!fs.existsSync(file))
  } finally {
    globalThis.fetch = previousFetch
  }
})

test("video notes fall back to the cover image only", async () => {
  const previousFetch = globalThis.fetch
  try {
    globalThis.fetch = mockImageFetch()
    const result = await buildXiaohongshuRelaySegments(
      {type: "xiaohongshu", note_id: "6ad4a9c200000000290162d4", media_kind: "video", cover_url: IMAGE_URL, images: [], page_url: "https://www.xiaohongshu.com/discovery/item/6ad4a9c200000000290162d4"},
      { segmentApi: { image: file => ({type: "image", file}) }, logger: { warn() {}, info() {} } }
    )
    assert.equal(result.imageNodes.length, 1)
    await cleanupXiaohongshuRelayFiles(result.tempFiles)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test("maxImages caps the gallery and mentions the remainder", async () => {
  const previousFetch = globalThis.fetch
  try {
    globalThis.fetch = mockImageFetch()
    const images = Array.from({length: 6}, (_, index) => `https://sns-img-qc.xhscdn.com/1040g2sg326fbqndbk4e05q0i05bji0mff371l${index}${index}`)
    const result = await buildXiaohongshuRelaySegments(
      {type: "xiaohongshu", note_id: "n1", images},
      { segmentApi: { image: file => ({type: "image", file}) }, logger: { warn() {}, info() {} }, xiaohongshuRelay: {maxImages: 3} }
    )
    assert.equal(result.imageNodes.length, 3)
    assert.ok(result.segments.some(part => String(part).includes("仅附前3张")))
    await cleanupXiaohongshuRelayFiles(result.tempFiles)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test("download failures degrade to a text note without crashing the relay", async () => {
  const previousFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => ({ok: false, headers: {get: () => null}, body: null})
    const result = await buildXiaohongshuRelaySegments(
      {type: "xiaohongshu", note_id: "n2", images: [IMAGE_URL], page_url: "https://www.xiaohongshu.com/explore/n2"},
      { segmentApi: { image: file => ({type: "image", file}) }, logger: { warn() {}, info() {} } }
    )
    assert.equal(result.imageNodes.length, 0)
    assert.ok(result.segments.some(part => String(part).includes("图片暂时获取失败")))
    await cleanupXiaohongshuRelayFiles(result.tempFiles)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test("video notes attach the downloaded video body", async () => {
  const previousFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: name => name === "content-length" ? "6" : null },
      body: Readable.toWeb(Readable.from(Buffer.from("mp4dat")))
    })
    const result = await buildXiaohongshuRelaySegments(
      {type: "xiaohongshu", note_id: "6ad4a9c200000000290162d4", media_kind: "video", duration: 42,
       play_url: "https://sns-video-v6.xhscdn.com/stream/1/110/259/h264.mp4?sign=a",
       cover_url: IMAGE_URL, images: [], page_url: "https://www.xiaohongshu.com/discovery/item/6ad4a9c200000000290162d4"},
      { segmentApi: { image: file => ({type: "image", file}), video: file => ({type: "video", file}) }, logger: { warn() {}, info() {} } }
    )
    assert.ok(result.segments.some(part => part?.type === "video"), "视频本体应作为 video segment")
    assert.equal(result.imageNodes.length, 0)
    assert.equal(result.tempFiles.length, 1)
    await cleanupXiaohongshuRelayFiles(result.tempFiles)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test("over-limit videos skip the body and fall back to the cover", async () => {
  const previousFetch = globalThis.fetch
  try {
    globalThis.fetch = mockImageFetch()
    const result = await buildXiaohongshuRelaySegments(
      {type: "xiaohongshu", note_id: "long1", media_kind: "video", duration: 99999,
       play_url: "https://sns-video-v6.xhscdn.com/stream/long.mp4?sign=a", cover_url: IMAGE_URL, images: []},
      { segmentApi: { image: file => ({type: "image", file}), video: file => ({type: "video", file}) }, logger: { warn() {}, info() {} }, xiaohongshuRelay: {maxVideoSeconds: 1800} }
    )
    assert.ok(!result.segments.some(part => part?.type === "video"))
    assert.ok(result.segments.some(part => String(part).includes("视频超过30分钟")))
    assert.equal(result.imageNodes.length, 1, "降级为封面图")
    await cleanupXiaohongshuRelayFiles(result.tempFiles)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test("failed video downloads degrade to the cover gallery", async () => {
  const previousFetch = globalThis.fetch
  let videoFailed = false
  try {
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("sns-video")) { videoFailed = true; return {ok: false, status: 403, headers: {get: () => null}, body: null} }
      return await mockImageFetch()()
    }
    const result = await buildXiaohongshuRelaySegments(
      {type: "xiaohongshu", note_id: "fail1", media_kind: "video", duration: 42,
       play_url: "https://sns-video-v6.xhscdn.com/stream/x.mp4?sign=a", cover_url: IMAGE_URL, images: []},
      { segmentApi: { image: file => ({type: "image", file}), video: file => ({type: "video", file}) }, logger: { warn() {}, info() {} } }
    )
    assert.ok(videoFailed, "应尝试过视频下载")
    assert.ok(!result.segments.some(part => part?.type === "video"))
    assert.ok(result.segments.some(part => String(part).includes("视频本体暂时获取失败")))
    assert.equal(result.imageNodes.length, 1)
    await cleanupXiaohongshuRelayFiles(result.tempFiles)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test("image notes with a live-photo clip never attach the video body", async () => {
  const previousFetch = globalThis.fetch
  try {
    globalThis.fetch = mockImageFetch()
    const result = await buildXiaohongshuRelaySegments(
      // 华为GT7 类笔记:type=normal 图文,页面里带 2 秒实况视频段
      {type: "xiaohongshu", note_id: "live1", media_kind: "image", duration: 2,
       play_url: "https://sns-video-v6.xhscdn.com/stream/live.mp4?sign=a",
       images: [IMAGE_URL, IMAGE_URL.replace("ff371lb8", "aa11bb22"), IMAGE_URL.replace("ff371lb8", "cc22dd33"), IMAGE_URL.replace("ff371lb8", "ee44ff55")]},
      { segmentApi: { image: file => ({type: "image", file}), video: file => ({type: "video", file}) }, logger: { warn() {}, info() {} } }
    )
    assert.ok(!result.segments.some(part => part?.type === "video"), "图文笔记不应发实况小视频")
    assert.equal(result.imageNodes.length, 4, "4 张图应全部保留")
    await cleanupXiaohongshuRelayFiles(result.tempFiles)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test("full description goes into its own text node", async () => {
  const result = await buildXiaohongshuRelaySegments(
    {type: "xiaohongshu", note_id: "desc1", media_kind: "image", description: "gt5银色真的百搭…怎么搭都好美 gt7继续冲银色！！搭什么颜色表带都好看 虽然很喜欢金色，但银色胜在百搭呀～ #华为gt7#", images: [IMAGE_URL]},
    { segmentApi: { image: file => ({type: "image", file}) }, logger: { warn() {}, info() {} } }
  )
  assert.equal(result.textNodes.length, 1)
  assert.match(result.textNodes[0], /^gt5银色真的百搭/)
  assert.match(result.textNodes[0], /#华为gt7#$/)
  await cleanupXiaohongshuRelayFiles(result.tempFiles)
})

test("cards without a description produce no text node", async () => {
  const result = await buildXiaohongshuRelaySegments(
    {type: "xiaohongshu", note_id: "nodesc", media_kind: "image", title: "只有标题", images: [IMAGE_URL]},
    { segmentApi: { image: file => ({type: "image", file}) }, logger: { warn() {}, info() {} } }
  )
  assert.equal(result.textNodes.length, 0)
  await cleanupXiaohongshuRelayFiles(result.tempFiles)
})

test("unresolved cards without any image keep the note link only", async () => {
  const result = await buildXiaohongshuRelaySegments(
    {type: "xiaohongshu", note_id: "n3", title: "只有文字", page_url: "https://www.xiaohongshu.com/explore/n3"},
    { segmentApi: { image: file => ({type: "image", file}) }, logger: { warn() {}, info() {} } }
  )
  assert.equal(result.imageNodes.length, 0)
  assert.ok(result.segments.some(part => String(part).includes("图片暂时获取失败")))
  await cleanupXiaohongshuRelayFiles(result.tempFiles)
})
