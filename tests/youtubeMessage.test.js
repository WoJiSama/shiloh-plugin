import assert from "node:assert/strict"
import fs from "node:fs"
import { test } from "node:test"
import {
  clearYoutubeMetadataCache,
  enrichYoutubeShare,
  extractYoutubeShareFromText,
  formatYoutubeHistoryText,
  shouldAttachYoutubeVideo
} from "../utils/youtubeMessage.js"
import { buildYoutubeArchiveRelaySegments, cleanupYoutubeArchiveRelayFiles, downloadYoutubeArchiveVideo } from "../utils/youtubeMediaRelay.js"

test("recognizes trusted YouTube watch, short and Shorts links", () => {
  assert.equal(extractYoutubeShareFromText("https://youtu.be/AbC_123-xYz?t=4").video_id, "AbC_123-xYz")
  assert.equal(extractYoutubeShareFromText("https://www.youtube.com/shorts/AbC_123-xYz").page_url, "https://www.youtube.com/watch?v=AbC_123-xYz")
  assert.equal(extractYoutubeShareFromText("https://notyoutube.com/watch?v=AbC_123-xYz"), null)
})

test("normalizes yt-dlp metadata without persisting a playback URL", async () => {
  clearYoutubeMetadataCache()
  let metadataArgs = []
  const card = await enrichYoutubeShare(extractYoutubeShareFromText("https://youtu.be/meta123"), {
    proxyUrl: "http://127.0.0.1:7890",
    runCommand: async args => {
      metadataArgs = args
      return { stdout: JSON.stringify({ id: "meta123", title: "  title ", uploader: "channel", duration: 65, thumbnail: "https://img.example/cover.jpg", view_count: 12, like_count: 3, comment_count: 2, webpage_url: "https://www.youtube.com/watch?v=meta123" }) }
    }
  })
  assert.equal(card.metadata_status, "resolved")
  assert.equal(card.channel, "channel")
  assert.equal(card.duration, 65)
  assert.match(formatYoutubeHistoryText(card), /分享了《title》/)
  assert.match(formatYoutubeHistoryText(card), /播放:12/)
  assert.equal(shouldAttachYoutubeVideo(card), true)
  assert.equal(shouldAttachYoutubeVideo({ duration: 1801 }), false)
  assert.deepEqual(metadataArgs.slice(-3), ["--proxy", "http://127.0.0.1:7890", "https://www.youtube.com/watch?v=meta123"])
})

test("passes YouTube authorization through temporary files without exposing it in metadata argv", async () => {
  clearYoutubeMetadataCache()
  const secretCookie = "SID=metadata-cookie-secret"
  const secretToken = "metadata-po-token-secret"
  let cookiePath = ""
  let configPath = ""
  const card = await enrichYoutubeShare(extractYoutubeShareFromText("https://youtu.be/authmeta123"), {
    cookieHeader: secretCookie,
    poToken: secretToken,
    runCommand: async args => {
      assert.equal(args.includes(secretCookie), false)
      assert.equal(args.includes(secretToken), false)
      cookiePath = args[args.indexOf("--cookies") + 1]
      configPath = args[args.indexOf("--config-locations") + 1]
      assert.equal((await fs.promises.stat(cookiePath)).mode & 0o777, 0o600)
      assert.equal((await fs.promises.stat(configPath)).mode & 0o777, 0o600)
      assert.match(await fs.promises.readFile(cookiePath, "utf8"), /SID\tmetadata-cookie-secret/)
      assert.match(await fs.promises.readFile(configPath, "utf8"), /youtube:po_token=web\+metadata-po-token-secret/)
      return { stdout: JSON.stringify({ id: "authmeta123", title: "authorized", duration: 5 }) }
    }
  })
  assert.equal(card.metadata_status, "resolved")
  assert.equal(fs.existsSync(cookiePath), false)
  assert.equal(fs.existsSync(configPath), false)
})

test("keeps a concrete metadata failure reason when yt-dlp times out", async () => {
  clearYoutubeMetadataCache()
  const card = await enrichYoutubeShare(extractYoutubeShareFromText("https://youtu.be/timeout123"), {
    runCommand: async () => { throw Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM" }) }
  })
  assert.equal(card.metadata_status, "unavailable")
  assert.equal(card.metadata_failure_reason, "YouTube 元数据请求超时")
})

test("outbox 预刷新与消息富化并发时只跑一次 yt-dlp", async () => {
  clearYoutubeMetadataCache()
  let runs = 0
  const options = {
    runCommand: async () => {
      runs += 1
      return { stdout: JSON.stringify({ id: "inflight123", title: "inflight", duration: 12 }) }
    }
  }
  const [prewarm, enriched] = await Promise.all([
    enrichYoutubeShare(extractYoutubeShareFromText("https://youtu.be/inflight123"), { ...options, cacheTtlMs: 0 }),
    enrichYoutubeShare(extractYoutubeShareFromText("https://youtu.be/inflight123"), options)
  ])
  assert.equal(runs, 1, "在途请求应合并,yt-dlp 只执行一次")
  assert.equal(prewarm.metadata_status, "resolved")
  assert.equal(enriched.metadata_status, "resolved")
  assert.equal(prewarm.video_id, "inflight123")
  assert.equal(enriched.video_id, "inflight123")
})

test("reports YouTube bot verification as a Cookie requirement instead of a member-only video", async () => {
  clearYoutubeMetadataCache()
  const botVerificationError = Object.assign(new Error("yt-dlp failed"), {
    stderr: "ERROR: [youtube] video: Sign in to confirm you’re not a bot. Use --cookies for the authentication."
  })
  const card = await enrichYoutubeShare(extractYoutubeShareFromText("https://youtu.be/botcheck123"), {
    runCommand: async () => { throw botVerificationError }
  })
  assert.equal(card.metadata_status, "unavailable")
  assert.equal(card.metadata_failure_reason, "YouTube 要求通过账号 Cookie 完成访问验证")
  assert.equal(formatYoutubeHistoryText(card), "视频信息未获取\n视频:botcheck123")
  assert.doesNotMatch(formatYoutubeHistoryText(card), /未命名视频|分享了/)

  const download = await downloadYoutubeArchiveVideo({ page_url: "https://www.youtube.com/watch?v=botcheck123" }, {
    runCommand: async () => { throw botVerificationError }
  })
  assert.equal(download.reason, "YouTube 要求通过账号 Cookie 完成访问验证")
})

test("YouTube relay only accepts an actual lowest single-file MP4", async () => {
  let outputPath = ""
  let downloadArgs = []
  const relay = await buildYoutubeArchiveRelaySegments({ type: "youtube", video_id: "relay123", duration: 10, page_url: "https://www.youtube.com/watch?v=relay123" }, {
    segmentApi: { video: file => ({ type: "video", file }), image: file => ({ type: "image", file }) },
    youtubeRelay: {
      proxyUrl: "http://127.0.0.1:7890",
      runCommand: async args => {
        downloadArgs = args
        outputPath = args[args.indexOf("-o") + 1].replace("%(ext)s", "mp4")
        await fs.promises.writeFile(outputPath, "mp4")
        return { stdout: "" }
      }
    }
  })
  assert.equal(relay.segments.some(item => item?.type === "video"), true)
  assert.equal(relay.tempFiles.length, 1)
  assert.deepEqual(downloadArgs.slice(-3), ["--proxy", "http://127.0.0.1:7890", "https://www.youtube.com/watch?v=relay123"])
  await cleanupYoutubeArchiveRelayFiles(relay.tempFiles)
  assert.equal(fs.existsSync(outputPath), false)
})

test("YouTube 封面下载为本地文件,不把 ytimg URL 透传给适配器", async () => {
  const coverBytes = Buffer.from("fake-jpeg-bytes")
  const relay = await buildYoutubeArchiveRelaySegments({
    type: "youtube", video_id: "cover123", duration: 10,
    cover_url: "https://i.ytimg.com/vi/cover123/hqdefault.jpg",
    page_url: "https://www.youtube.com/watch?v=cover123"
  }, {
    segmentApi: { video: file => ({ type: "video", file }), image: file => ({ type: "image", file }) },
    youtubeRelay: {
      fetchImpl: async url => {
        assert.match(url, /^https:\/\/i\.ytimg\.com\//)
        return { ok: true, body: new ReadableStream({ start(controller) { controller.enqueue(coverBytes); controller.close() } }) }
      }
    }
  })
  const image = relay.segments.find(item => item?.type === "image")
  assert.ok(image, "应有封面图节点")
  assert.doesNotMatch(String(image.file), /^https?:\/\//, "封面必须是本地文件")
  assert.ok(fs.existsSync(image.file), "封面文件应已落盘")
  await cleanupYoutubeArchiveRelayFiles(relay.tempFiles)
  assert.equal(fs.existsSync(image.file), false, "封面临时文件应被清理")
})

test("封面下载失败时跳过封面,不影响其余节点且不透传 URL", async () => {
  let outputPath = ""
  const relay = await buildYoutubeArchiveRelaySegments({
    type: "youtube", video_id: "nocover123", duration: 10,
    cover_url: "https://i.ytimg.com/vi/nocover123/hqdefault.jpg",
    page_url: "https://www.youtube.com/watch?v=nocover123"
  }, {
    segmentApi: { video: file => ({ type: "video", file }), image: file => ({ type: "image", file }) },
    youtubeRelay: {
      fetchImpl: async () => ({ ok: false, body: null }),
      runCommand: async args => {
        outputPath = args[args.indexOf("-o") + 1].replace("%(ext)s", "mp4")
        await fs.promises.writeFile(outputPath, "mp4")
        return { stdout: "" }
      }
    }
  })
  assert.equal(relay.segments.some(item => item?.type === "image"), false, "封面失败应直接跳过")
  assert.equal(relay.segments.some(item => String(item?.file || "").startsWith("https://i.ytimg.com")), false, "不得透传封面 URL")
  assert.equal(relay.segments.some(item => item?.type === "video"), true, "视频节点不受影响")
  await cleanupYoutubeArchiveRelayFiles(relay.tempFiles)
  assert.equal(fs.existsSync(outputPath), false)
})

test("passes YouTube authorization through temporary files without exposing it in download argv", async () => {
  const secretCookie = "SID=download-cookie-secret"
  const secretToken = "download-po-token-secret"
  let outputPath = ""
  let cookiePath = ""
  let configPath = ""
  const relay = await buildYoutubeArchiveRelaySegments({ type: "youtube", video_id: "authrelay123", duration: 10, page_url: "https://www.youtube.com/watch?v=authrelay123" }, {
    segmentApi: { video: file => ({ type: "video", file }) },
    youtubeRelay: {
      cookieHeader: secretCookie,
      poToken: secretToken,
      runCommand: async args => {
        assert.equal(args.includes(secretCookie), false)
        assert.equal(args.includes(secretToken), false)
        cookiePath = args[args.indexOf("--cookies") + 1]
        configPath = args[args.indexOf("--config-locations") + 1]
        assert.equal((await fs.promises.stat(cookiePath)).mode & 0o777, 0o600)
        assert.equal((await fs.promises.stat(configPath)).mode & 0o777, 0o600)
        assert.match(await fs.promises.readFile(cookiePath, "utf8"), /SID\tdownload-cookie-secret/)
        assert.match(await fs.promises.readFile(configPath, "utf8"), /youtube:po_token=web\+download-po-token-secret/)
        outputPath = args[args.indexOf("-o") + 1].replace("%(ext)s", "mp4")
        await fs.promises.writeFile(outputPath, "mp4")
        return { stdout: "" }
      }
    }
  })
  assert.equal(relay.segments.some(item => item?.type === "video"), true)
  assert.equal(fs.existsSync(cookiePath), false)
  assert.equal(fs.existsSync(configPath), false)
  await cleanupYoutubeArchiveRelayFiles(relay.tempFiles)
  assert.equal(fs.existsSync(outputPath), false)
})
