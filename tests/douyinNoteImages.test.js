// 抖音图文(图集)搬运:note 页面解析的图片抽取、relay 的图集节点构造。
// 需求:图集图片作为独立节点放进同一条合并转发,不外发单条消息。
import assert from "node:assert/strict"
import fs from "fs"
import { Readable } from "stream"
import { test } from "node:test"
import { extractNoteImagesFromJson } from "../utils/douyinBrowserResolver.js"
import { buildDouyinArchiveRelaySegments, cleanupDouyinArchiveRelayFiles } from "../utils/douyinMediaRelay.js"

test("extractNoteImagesFromJson 从 detail 响应深挖图集 url 列表并去重", () => {
  const json = {
    status_code: 0,
    aweme_detail: {
      aweme_id: "7651971027728274617",
      desc: "开局就被堵门口啊",
      images: [
        { url_list: ["https://p3.douyinpic.com/img1.webp", "https://p9.douyinpic.com/img1.jpeg"] },
        { url_list: ["https://p3.douyinpic.com/img2.webp"] },
        { url_list: [] },
        { url_list: ["not-a-url"] }
      ]
    }
  }
  const images = extractNoteImagesFromJson(json)
  assert.deepEqual(images, [
    "https://p3.douyinpic.com/img1.webp",
    "https://p3.douyinpic.com/img2.webp"
  ])
})

test("extractNoteImagesFromJson 只取作品节点自己的 images,推荐流/贴纸/评论区杂图不收", () => {
  const json = {
    status_code: 0,
    aweme_detail: {
      aweme_id: "7651971027728274617",
      desc: "两图图文",
      images: [
        { url_list: ["https://p3.douyinpic.com/real-1.webp"] },
        { url_list: ["https://p3.douyinpic.com/real-2.webp"] }
      ]
    },
    // 页面同帧加载的杂项数据:也带 images 数组,但不是作品本体
    stickers: { images: [{ url_list: ["https://p3.douyinpic.com/sticker.webp"] }] },
    comments: [{ aweme_id: "", images: [{ url_list: ["https://p3.douyinpic.com/comment.webp"] }] }],
    related_feed: [
      { aweme_id: "1111111111111111111", video: {}, images: [] },
      { aweme_id: "2222222222222222222", images: [{ url_list: ["https://p3.douyinpic.com/related-note.webp"] }] }
    ],
    bottom_bar: { images: [{ url_list: ["https://p3.douyinpic.com/ui-icon.webp"] }] }
  }
  // 推荐流里的另一条图文(有 aweme_id + images)在遍历顺序上位于作品之后,
  // 深找以作品节点(aweme_detail 在前)为准
  const images = extractNoteImagesFromJson(json)
  assert.deepEqual(images, [
    "https://p3.douyinpic.com/real-1.webp",
    "https://p3.douyinpic.com/real-2.webp"
  ])
})

test("extractNoteImagesFromJson 视频响应(无 images)返回空数组", () => {
  assert.deepEqual(extractNoteImagesFromJson({ aweme_detail: { aweme_id: "1234567890123", video: { play_addr: { url_list: ["https://x/example.mp4"] } } } }), [])
  assert.deepEqual(extractNoteImagesFromJson(null), [])
})

function fakeImageFetch() {
  return async () => ({
    ok: true,
    headers: { get: name => name === "content-length" ? "8" : null },
    body: Readable.toWeb(Readable.from(Buffer.from("imagedata")))
  })
}

test("图文作品:每张图一个转发节点,不再内联封面,下载文件登记 tempFiles", async () => {
  const previousFetch = globalThis.fetch
  try {
    globalThis.fetch = fakeImageFetch()
    const result = await buildDouyinArchiveRelaySegments({
      type: "douyin",
      aweme_id: "7651971027728274617",
      title: "带水老师图文",
      duration: 0,
      media_kind: "note",
      cover_url: "https://p3.douyinpic.com/cover.webp",
      images: [
        "https://p3.douyinpic.com/img1.webp",
        "https://p3.douyinpic.com/img2.webp",
        "https://p3.douyinpic.com/img3.webp"
      ]
    }, {
      segmentApi: {
        image: file => ({ type: "image", data: { file } }),
        video: file => ({ type: "video", data: { file } })
      },
      logger: { warn() {}, info() {} }
    })

    assert.equal(result.imageNodes.length, 3)
    assert.ok(result.imageNodes.every(node => node?.type === "image"))
    // 图集就绪后封面不单独内联(第一张图即封面)
    assert.ok(!result.segments.some(seg => seg?.type === "image"))
    assert.equal(result.tempFiles.length, 3)
    for (const file of result.tempFiles) assert.ok(fs.existsSync(file))
    await cleanupDouyinArchiveRelayFiles(result.tempFiles)
    for (const file of result.tempFiles) assert.ok(!fs.existsSync(file))
  } finally {
    globalThis.fetch = previousFetch
  }
})

test("图集超过20张截断并附说明,节点仍并入同一条合并转发", async () => {
  const previousFetch = globalThis.fetch
  try {
    globalThis.fetch = fakeImageFetch()
    const images = Array.from({ length: 25 }, (_, index) => `https://p3.douyinpic.com/${index}.webp`)
    const result = await buildDouyinArchiveRelaySegments({
      type: "douyin",
      aweme_id: "2",
      duration: 0,
      media_kind: "note",
      images
    }, {
      segmentApi: { image: file => ({ type: "image", data: { file } }) },
      logger: { warn() {}, info() {} }
    })

    assert.equal(result.imageNodes.length, 20)
    assert.ok(result.segments.some(seg => String(seg).includes("图集共25张，仅附前20张")))
    await cleanupDouyinArchiveRelayFiles(result.tempFiles)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test("图集全部下载失败时保留说明,不产生节点", async () => {
  const previousFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => ({ ok: false, headers: { get: () => null } })
    const result = await buildDouyinArchiveRelaySegments({
      type: "douyin",
      aweme_id: "3",
      duration: 0,
      images: ["https://p3.douyinpic.com/img1.webp"]
    }, {
      segmentApi: { image: file => ({ type: "image", data: { file } }) },
      logger: { warn() {}, info() {} }
    })

    assert.equal(result.imageNodes.length, 0)
    assert.ok(result.segments.some(seg => String(seg).includes("图集图片暂时获取失败")))
  } finally {
    globalThis.fetch = previousFetch
  }
})

test("视频作品行为不变:时长有效时走视频路径,无图集节点", async () => {
  const previousFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => ({
      ok: true,
      headers: { get: name => name === "content-length" ? "6" : null },
      body: Readable.toWeb(Readable.from(Buffer.from("video!!")))
    })
    const result = await buildDouyinArchiveRelaySegments({
      type: "douyin",
      aweme_id: "7688295441674675850",
      duration: 120,
      play_url: "https://v.example/video.mp4",
      cover_url: "https://p3.douyinpic.com/cover.webp"
    }, {
      segmentApi: {
        image: file => ({ type: "image", data: { file } }),
        video: file => ({ type: "video", data: { file } })
      },
      logger: { warn() {}, info() {} }
    })

    assert.ok(result.segments.some(seg => seg?.type === "video"))
    assert.ok(result.segments.some(seg => seg?.type === "image"), "视频封面仍内联")
    assert.equal(result.imageNodes.length, 0)
    await cleanupDouyinArchiveRelayFiles(result.tempFiles)
  } finally {
    globalThis.fetch = previousFetch
  }
})
