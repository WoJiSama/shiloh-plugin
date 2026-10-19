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

test("unresolved cards without any image keep the note link only", async () => {
  const result = await buildXiaohongshuRelaySegments(
    {type: "xiaohongshu", note_id: "n3", title: "只有文字", page_url: "https://www.xiaohongshu.com/explore/n3"},
    { segmentApi: { image: file => ({type: "image", file}) }, logger: { warn() {}, info() {} } }
  )
  assert.equal(result.imageNodes.length, 0)
  assert.ok(result.segments.some(part => String(part).includes("图片暂时获取失败")))
  await cleanupXiaohongshuRelayFiles(result.tempFiles)
})
