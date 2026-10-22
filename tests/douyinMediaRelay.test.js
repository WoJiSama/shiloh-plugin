import assert from "node:assert/strict"
import fs from "fs"
import { Readable } from "stream"
import { test } from "node:test"
import { buildDouyinArchiveRelaySegments, cleanupDouyinArchiveRelayFiles } from "../utils/douyinMediaRelay.js"

test("short Douyin videos attach cover and a local video segment", async () => {
  const previousFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => ({
      ok: true,
      headers: { get: name => name === "content-length" ? "4" : null },
      body: Readable.toWeb(Readable.from(Buffer.from("mp4!")))
    })
    const result = await buildDouyinArchiveRelaySegments({
      type: "douyin", aweme_id: "123", duration: 16,
      page_url: "https://www.iesdouyin.com/share/video/123/",
      cover_url: "https://cover.example/cover.webp", play_url: "https://video.example/play"
    }, { segmentApi: { image: url => ({ type: "image", url }), video: file => ({ type: "video", file }) }, logger: { warn() {} } })
    assert.ok(result.segments.some(part => part?.type === "image"))
    assert.ok(result.segments.some(part => part?.type === "video"))
    assert.equal(result.tempFiles.length, 1)
    assert.ok(fs.existsSync(result.tempFiles[0]))
    await cleanupDouyinArchiveRelayFiles(result.tempFiles)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test("long Douyin videos never download a body", async () => {
  const previousFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => { throw new Error("long video must not download") }
    const result = await buildDouyinArchiveRelaySegments({ type: "douyin", duration: 1801, cover_url: "https://cover.example/cover.webp" }, {
      segmentApi: { image: url => ({ type: "image", url }), video: file => ({ type: "video", file }) }
    })
    assert.equal(result.tempFiles.length, 0)
    assert.ok(result.segments.some(part => typeof part === "string" && part.includes("超过30分钟")))
    assert.ok(!result.segments.some(part => part?.type === "video"))
  } finally {
    globalThis.fetch = previousFetch
  }
})

test("图文作品带背景音乐:图集之后追加合成的配乐视频", async () => {
  const fs = await import("node:fs")
  const os = await import("node:os")
  const path = await import("node:path")
  const previousFetch = globalThis.fetch
  const ffmpegCalls = []
  const ffprobeCalls = []
  try {
    globalThis.fetch = async (url) => {
      const text = String(url)
      if (text.includes("ies-music") || /\.mp3/.test(text)) {
        return { ok: true, headers: { get: () => null }, body: Readable.toWeb(Readable.from(Buffer.from("mp3data"))) }
      }
      return { ok: true, headers: { get: name => name === "content-length" ? "5" : null }, body: Readable.toWeb(Readable.from(Buffer.from("jpeg!"))) }
    }
    const { createDouyinMediaRelay } = await import("../dist/backend/modules/media/infrastructure/douyinMediaRelay.js")
    const relay = createDouyinMediaRelay({
      segmentApi: { image: file => ({type: "image", file}), video: file => ({type: "video", file}) },
      logger: { warn() {}, info() {} },
      shouldAttachDouyinVideo: () => false,
      runner: async (command, args) => {
        if (command === "ffprobe") { ffprobeCalls.push(args); return "7.0\n" }
        ffmpegCalls.push(args)
        const target = args[args.length - 1]
        fs.writeFileSync(target, Buffer.from("mp4slideshow"))
        return ""
      }
    })
    const result = await relay.buildDouyinArchiveRelaySegments({
      type: "douyin", aweme_id: "456", media_kind: "note",
      images: ["https://p3.douyinpic.com/img1.webp", "https://p3.douyinpic.com/img2.webp"],
      music_url: "https://sf3-cdn-tos.douyinstatic.com/obj/ies-music/bg.mp3",
      page_url: "https://www.iesdouyin.com/share/note/456/"
    }, {})
    assert.equal(result.imageNodes.length, 2, "图集先就绪")
    const videoSegments = result.segments.filter(part => part?.type === "video")
    assert.equal(videoSegments.length, 1, "配乐视频追加为 video segment")
    assert.ok(ffmpegCalls.length === 1, "ffmpeg 合成一次")
    const filterArg = ffmpegCalls[0][ffmpegCalls[0].indexOf("-filter_complex") + 1]
    assert.ok(filterArg.includes("concat=n=2"), "两图拼接")
    assert.ok(filterArg.includes("scale=720:1280"), "统一竖版画布")
    assert.ok(ffprobeCalls.length === 1, "ffprobe 探测音频时长")
    await relay.cleanupDouyinArchiveRelayFiles(result.tempFiles)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test("无音乐或音乐下载失败时图集照常,不合成", async () => {
  const previousFetch = globalThis.fetch
  let composerRuns = 0
  try {
    globalThis.fetch = async () => ({ ok: true, headers: { get: name => name === "content-length" ? "5" : null }, body: Readable.toWeb(Readable.from(Buffer.from("jpeg!"))) })
    const { createDouyinMediaRelay } = await import("../dist/backend/modules/media/infrastructure/douyinMediaRelay.js")
    const relay = createDouyinMediaRelay({
      segmentApi: { image: file => ({type: "image", file}) },
      logger: { warn() {}, info() {} },
      shouldAttachDouyinVideo: () => false,
      runner: async () => { composerRuns++; return "" }
    })
    const result = await relay.buildDouyinArchiveRelaySegments({
      type: "douyin", aweme_id: "789", images: ["https://p3.douyinpic.com/img1.webp"]
    }, {})
    assert.equal(result.imageNodes.length, 1)
    assert.equal(result.segments.filter(part => part?.type === "video").length, 0)
    assert.equal(composerRuns, 0, "无音乐不触发 ffmpeg")
    await relay.cleanupDouyinArchiveRelayFiles(result.tempFiles)
  } finally {
    globalThis.fetch = previousFetch
  }
})
