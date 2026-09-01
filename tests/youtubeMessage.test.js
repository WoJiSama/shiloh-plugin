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
