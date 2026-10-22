import assert from "node:assert/strict"
import fs from "fs"
import { Readable } from "stream"
import { test } from "node:test"
import { buildBilibiliArchiveRelaySegments, cleanupBilibiliArchiveRelayFiles } from "../utils/bilibiliMediaRelay.js"
import { MediaArtifactStore } from "../utils/messagePipeline/mediaArtifactStore.js"

test("短视频搬运下载为本地文件并返回视频段", async () => {
  const previousFetch = globalThis.fetch
  try {
    globalThis.fetch = async url => {
      if (String(url).includes("x/player/playurl")) {
        return {
          ok: true,
          async json() {
            return { code: 0, data: { durl: [{ url: "https://video.example/low.mp4?temporary=1", length: 2000, size: 4 }] } }
          }
        }
      }
      return {
        ok: true,
        headers: { get: name => name === "content-length" ? "4" : null },
        body: Readable.toWeb(Readable.from(Buffer.from("test")))
      }
    }
    const result = await buildBilibiliArchiveRelaySegments({
      type: "bilibili",
      bvid: "BV1234567890",
      cid: 1,
      duration: 2
    }, {
      segmentApi: { video: file => ({ type: "video", file }) },
      logger: { warn() {} }
    })

    assert.ok(result.segments.some(part => part?.type === "video"))
    assert.equal(result.tempFiles.length, 1)
    assert.ok(fs.existsSync(result.tempFiles[0]))
    await cleanupBilibiliArchiveRelayFiles(result.tempFiles)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test("concurrent groups reuse one Bilibili MP4 download while keeping separate relay results", async () => {
  const previousFetch = globalThis.fetch
  const artifactStore = new MediaArtifactStore({ ttlMs: 60_000, maxEncodedBytes: 1024 })
  let playbackCalls = 0
  let downloadCalls = 0
  try {
    globalThis.fetch = async url => {
      if (String(url).includes("finger/spi")) {
        return { ok: true, async json() { return { code: 0, data: {} } } }
      }
      if (String(url).includes("x/player/playurl")) {
        playbackCalls += 1
        return {
          ok: true,
          async json() {
            return { code: 0, data: { durl: [{ url: "https://video.example/shared.mp4?token=temporary", size: 6 }] } }
          }
        }
      }
      downloadCalls += 1
      await new Promise(resolve => setTimeout(resolve, 10))
      return {
        ok: true,
        headers: { get: name => name === "content-length" ? "6" : null },
        body: Readable.toWeb(Readable.from(Buffer.from("shared")))
      }
    }
    const card = { type: "bilibili", bvid: "BVSHARED123", cid: 88, duration: 10 }
    const options = {
      artifactStore,
      segmentApi: { video: file => ({ type: "video", file }) },
      logger: { warn() {} }
    }
    const [left, right] = await Promise.all([
      buildBilibiliArchiveRelaySegments(card, options),
      buildBilibiliArchiveRelaySegments(card, options)
    ])
    assert.equal(playbackCalls, 1)
    assert.equal(downloadCalls, 1)
    assert.equal(left.segments.find(item => item?.type === "video").file, right.segments.find(item => item?.type === "video").file)
    assert.ok(!left.segments.some(item => typeof item === "string" && item.includes("视频本体暂时获取失败")))
    await Promise.all([...left.artifactLeases, ...right.artifactLeases].map(lease => lease.release()))
  } finally {
    await artifactStore.stop()
    globalThis.fetch = previousFetch
  }
})

test("Bangumi relay labels a preview clip without exposing an upstream URL", async () => {
  const previousFetch = globalThis.fetch
  try {
    globalThis.fetch = async url => {
      if (String(url).includes("pgc/player/web/playurl")) {
        return {
          ok: true,
          async json() {
            return {
              code: 0,
              message: "success",
              result: {
                is_preview: true,
                durl: [{ url: "https://video.example/preview.mp4?temporary=1", length: 360000, size: 4 }]
              }
            }
          }
        }
      }
      return {
        ok: true,
        headers: { get: name => name === "content-length" ? "4" : null },
        body: Readable.toWeb(Readable.from(Buffer.from("test")))
      }
    }
    const result = await buildBilibiliArchiveRelaySegments({
      type: "bilibili",
      ep_id: "1455179",
      cid: 917377008,
      duration: 721
    }, { segmentApi: { video: file => ({ type: "video", file }) }, logger: { warn() {} } })

    const text = result.segments.filter(item => typeof item === "string").join("")
    assert.match(text, /B站番剧仅提供约6:00试看，本体为试看片段/)
    assert.doesNotMatch(text, /temporary|https?:\/\//)
    assert.ok(result.segments.some(item => item?.type === "video"))
  } finally {
    globalThis.fetch = previousFetch
  }
})

test("explicit high-quality relay forwards authorization only to playback and media download", async () => {
  const previousFetch = globalThis.fetch
  const seen = []
  try {
    globalThis.fetch = async (url, options = {}) => {
      seen.push({ playback: String(url).includes("x/player/playurl"), cookie: options.headers?.Cookie || "" })
      if (String(url).includes("finger/spi")) {
        return { ok: true, async json() { return { code: 0, data: {} } } }
      }
      if (String(url).includes("x/player/playurl")) {
        assert.match(String(url), /[?&]qn=80(?:&|$)/)
        return { ok: true, async json() { return { code: 0, data: { quality: 80, durl: [{ url: "https://video.example/high.mp4?temporary=1", size: 4 }] } } } }
      }
      return {
        ok: true,
        headers: { get: name => name === "content-length" ? "4" : null },
        body: Readable.toWeb(Readable.from(Buffer.from("high")))
      }
    }
    const result = await buildBilibiliArchiveRelaySegments({ type: "bilibili", bvid: "BV1234567890", cid: 1, duration: 2 }, {
      quality: 80,
      authCookie: "opaque-auth",
      segmentApi: { video: file => ({ type: "video", file }) },
      logger: { warn() {} }
    })

    assert.ok(result.segments.some(part => part?.type === "video"))
    assert.equal(result.actualQuality, 80)
    // spi 指纹(空数据→无 buvid) + 授权 playurl + 视频下载,均只带授权 cookie
    assert.deepEqual(seen, [{ playback: false, cookie: "" }, { playback: true, cookie: "opaque-auth" }, { playback: false, cookie: "opaque-auth" }])
    await cleanupBilibiliArchiveRelayFiles(result.tempFiles)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test("automatic relay retries with the authorized account only after B站 returns a preview", async () => {
  const previousFetch = globalThis.fetch
  const playbackCookies = []
  try {
    globalThis.fetch = async (url, options = {}) => {
      if (String(url).includes("x/player/playurl")) {
        playbackCookies.push(options.headers?.Cookie || "")
        const authorized = Boolean(options.headers?.Cookie)
        return {
          ok: true,
          async json() {
            return {
              code: 0,
              data: authorized
                ? { quality: 6, durl: [{ url: "https://video.example/full.mp4?temporary=1", length: 600000, size: 4 }] }
                : { quality: 6, is_preview: true, durl: [{ url: "https://video.example/preview.mp4?temporary=1", length: 60000, size: 4 }] }
            }
          }
        }
      }
      assert.equal(options.headers?.Cookie, "opaque-auth")
      return {
        ok: true,
        headers: { get: name => name === "content-length" ? "4" : null },
        body: Readable.toWeb(Readable.from(Buffer.from("full")))
      }
    }
    const result = await buildBilibiliArchiveRelaySegments({ type: "bilibili", bvid: "BV1234567890", cid: 1, duration: 600 }, {
      autoAuthRetryCookie: "opaque-auth",
      segmentApi: { video: file => ({ type: "video", file }) },
      logger: { warn() {} }
    })

    assert.deepEqual(playbackCookies, ["", "opaque-auth"])
    assert.equal(result.usedAuthorizedRetry, true)
    assert.ok(result.segments.some(part => part?.type === "video"))
    await cleanupBilibiliArchiveRelayFiles(result.tempFiles)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test("ordinary automatic relay never includes an authorization cookie", async () => {
  const previousFetch = globalThis.fetch
  const seenCookies = []
  try {
    globalThis.fetch = async (url, options = {}) => {
      seenCookies.push(options.headers?.Cookie || "")
      if (String(url).includes("finger/spi")) {
        return { ok: true, async json() { return { code: 0, data: {} } } }
      }
      if (String(url).includes("x/player/playurl")) {
        return { ok: true, async json() { return { code: 0, data: { quality: 6, durl: [{ url: "https://video.example/ordinary.mp4?temporary=1", size: 4 }] } } } }
      }
      return {
        ok: true,
        headers: { get: name => name === "content-length" ? "4" : null },
        body: Readable.toWeb(Readable.from(Buffer.from("test")))
      }
    }
    const result = await buildBilibiliArchiveRelaySegments({ type: "bilibili", bvid: "BVORDINARY1", cid: 1, duration: 2 }, {
      autoAuthRetryCookie: "opaque-auth",
      segmentApi: { video: file => ({ type: "video", file }) },
      logger: { warn() {} }
    })

    // 三次请求 = spi 指纹(无 cookie) + playurl(匿名 buvid 为空) + 视频下载,均无授权 cookie
    assert.deepEqual(seenCookies, ["", "", ""])
    assert.equal(result.usedAuthorizedRetry, false)
    await cleanupBilibiliArchiveRelayFiles(result.tempFiles)
  } finally {
    globalThis.fetch = previousFetch
  }
})
