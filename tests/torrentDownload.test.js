import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import {
  TorrentDownloadError,
  assertTorrentFitsArchive,
  assertTorrentWithinLimits,
  buildAriaDownloadArgs,
  buildAriaMetadataArgs,
  buildMetadataCacheUrls,
  buildZipArgs,
  addPublicTrackersToMagnet,
  extractValidBtihMagnetUri,
  formatTorrentDirectoryListing,
  formatTorrentSelectionListing,
  getTorrentInfoHash,
  normalizeTorrentDownloadConfig,
  parseMagnetUri,
  parseTorrentMetadata,
  selectTorrentFiles,
  verifyDownloadedFiles
} from "../utils/torrentDownload.js"
import { TorrentDownloadTool } from "../functions/functions_tools/TorrentDownloadTool.js"

const MAGNET = "magnet:?xt=urn:btih:AF4B684892182408E4AE9DF0C8FFE9E49CCBF171&dn=fixture"
const unavailableCacheFetch = async () => { throw new Error("metadata cache disabled in unit test") }

function singleFileTorrent(name = "safe.bin", size = 4) {
  const nameBuffer = Buffer.from(name)
  return Buffer.from(`d4:infod4:name${nameBuffer.length}:${name}6:lengthi${size}eee`)
}

function multiFileTorrent(pathParts = ["part.bin"], size = 4) {
  const name = "bundle"
  const parts = (Array.isArray(pathParts) ? pathParts : [pathParts])
    .map(part => `${Buffer.byteLength(part)}:${part}`)
    .join("")
  return Buffer.from(`d4:infod4:name${name.length}:${name}5:filesld6:lengthi${size}e4:pathl${parts}eeeee`)
}

function multiEntryTorrent(entries = []) {
  const encodedEntries = entries.map(({ name, size }) => {
    const encodedName = Buffer.byteLength(name)
    return `d6:lengthi${size}e4:pathl${encodedName}:${name}ee`
  }).join("")
  return Buffer.from(`d4:infod4:name6:bundle5:filesl${encodedEntries}eee`)
}

test("parses only valid BTIH magnet URIs", () => {
  assert.equal(parseMagnetUri(MAGNET).infoHash, "AF4B684892182408E4AE9DF0C8FFE9E49CCBF171")
  assert.throws(() => parseMagnetUri("https://example.com/file.torrent"), TorrentDownloadError)
  assert.throws(() => parseMagnetUri("magnet:?xt=urn:btih:not-a-hash"), /BTIH/)
})

test("adds public trackers for a second P2P discovery attempt without removing the hash", () => {
  const enriched = addPublicTrackersToMagnet(MAGNET, ["udp://tracker.example:1337/announce"])
  assert.match(enriched, /xt=urn%3Abtih%3AAF4B684892182408E4AE9DF0C8FFE9E49CCBF171/i)
  assert.match(enriched, /tr=udp%3A%2F%2Ftracker\.example%3A1337%2Fannounce/i)
})

test("builds HTTPS metadata cache URLs from the original info hash", () => {
  const urls = buildMetadataCacheUrls("AF4B684892182408E4AE9DF0C8FFE9E49CCBF171", [
    "https://cache.example/{infoHash}.torrent"
  ])
  assert.deepEqual(urls, ["https://cache.example/AF4B684892182408E4AE9DF0C8FFE9E49CCBF171.torrent"])
})

test("extracts only a valid BTIH magnet from a group message", () => {
  assert.equal(extractValidBtihMagnetUri(`给你这个 ${MAGNET} 看看`), MAGNET)
  assert.equal(extractValidBtihMagnetUri("magnet:?xt=urn:btih:not-a-hash"), "")
})

test("reads v1 torrent metadata and rejects unsafe paths", () => {
  const metadata = parseTorrentMetadata(singleFileTorrent("safe.bin", 12))
  assert.equal(metadata.totalBytes, 12)
  assert.equal(metadata.files[0].index, 1)
  assert.deepEqual(metadata.files[0].relativePath, ["safe.bin"])
  assert.throws(() => parseTorrentMetadata(multiFileTorrent("..", 12)), /不安全/)
})

test("selects only stable file indexes and keeps their total for limit checks", () => {
  const metadata = parseTorrentMetadata(multiEntryTorrent([
    { name: "one.bin", size: 3 },
    { name: "two.bin", size: 5 }
  ]))
  const selected = selectTorrentFiles(metadata, [2])
  assert.deepEqual(selected.files.map(file => file.index), [2])
  assert.equal(selected.totalBytes, 5)
  assert.throws(() => selectTorrentFiles(metadata, [3]), /不在当前磁链清单/)
})

test("renders a complete selection list with per-file size and selectable status", () => {
  const metadata = parseTorrentMetadata(multiEntryTorrent([
    { name: "small.txt", size: 91 },
    { name: "large.mkv", size: 2_000_000_000 }
  ]))
  const text = formatTorrentSelectionListing(metadata, {
    selectableIndexes: [1],
    unavailableReasons: new Map([[2, "超过单文件 50.0 MB 上限"]])
  })
  assert.match(text, /1｜可下载\n  small\.txt\n  大小：91 B/)
  assert.match(text, /2｜不可下载\n  large\.mkv\n  大小：2\.0 GB｜超过单文件 50\.0 MB 上限/)
  assert.match(text, /可下载编号：1/)
  assert.match(text, /只能填写标为“可下载”的编号/)
})

test("enforces total size, per-file size and file count before download", () => {
  const config = normalizeTorrentDownloadConfig({ maxTotalMb: 1, maxSingleFileMb: 1, maxFiles: 1 })
  assert.throws(() => assertTorrentWithinLimits(parseTorrentMetadata(singleFileTorrent("large.bin", 2 * 1024 * 1024)), config), /总大小/)
  const manyFiles = {
    totalBytes: 3,
    files: [
      { relativePath: ["a"], size: 1 },
      { relativePath: ["b"], size: 1 },
      { relativePath: ["c"], size: 1 }
    ]
  }
  assert.throws(() => assertTorrentWithinLimits(manyFiles, normalizeTorrentDownloadConfig({ maxFiles: 2 })), /文件/)
  assert.throws(() => assertTorrentWithinLimits(
    parseTorrentMetadata(singleFileTorrent("large.bin", 2 * 1024 * 1024)),
    normalizeTorrentDownloadConfig({ maxTotalMb: 100, maxSingleFileMb: 1 })
  ), /单文件/)
})

test("cannot raise the 50 MB hard cap through runtime configuration", () => {
  const config = normalizeTorrentDownloadConfig({
    maxTotalMb: 500,
    maxSingleFileMb: 500,
    maxArchiveMb: 500
  })
  assert.equal(config.maxTotalBytes, 50 * 1000 * 1000)
  assert.equal(config.maxSingleFileBytes, 50 * 1000 * 1000)
  assert.equal(config.maxArchiveBytes, 50 * 1000 * 1000)
})

test("stops before download when the resulting ZIP cannot fit the upload limit", () => {
  const metadata = parseTorrentMetadata(singleFileTorrent("large.bin", 2 * 1024 * 1024))
  assert.throws(
    () => assertTorrentFitsArchive(metadata, normalizeTorrentDownloadConfig({ maxTotalMb: 100, maxArchiveMb: 1 })),
    /压缩包上传上限.*不会开始下载/
  )
})

test("builds metadata-only and payload download commands without shell interpolation", () => {
  const metadataArgs = buildAriaMetadataArgs({ directory: "/tmp/meta", magnet: MAGNET })
  assert.ok(metadataArgs.includes("--bt-metadata-only=true"))
  assert.ok(metadataArgs.includes(MAGNET))
  const downloadArgs = buildAriaDownloadArgs({ directory: "/tmp/payload", torrentFile: "/tmp/meta/a.torrent" })
  assert.ok(downloadArgs.includes("--seed-time=0"))
  assert.equal(downloadArgs.at(-1), "/tmp/meta/a.torrent")
  assert.ok(buildAriaDownloadArgs({ directory: "/tmp/payload", torrentFile: "/tmp/meta/a.torrent", selectedFileIndexes: [1, 3] }).includes("--select-file=1,3"))
  assert.deepEqual(buildZipArgs({ archiveFile: "/tmp/archive.zip" }), ["-q", "-r", "/tmp/archive.zip", "."])
})

test("offers an over-limit multi-file torrent for selection and downloads only the chosen file", async () => {
  const dirName = path.join(os.tmpdir(), `torrent-tool-select-${randomUUID()}`)
  const torrent = multiEntryTorrent([
    { name: "one.bin", size: 4 },
    { name: "two.bin", size: 5 }
  ])
  const infoHash = getTorrentInfoHash(torrent)
  const magnet = `magnet:?xt=urn:btih:${infoHash}`
  const notices = []
  const sent = []
  const payloadArgs = []
  const tool = new TorrentDownloadTool({
    configProvider: () => normalizeTorrentDownloadConfig({
      enabled: true,
      downloadDir: dirName,
      maxFiles: 1,
      minFreeDiskMb: 64,
      metadataHttpSources: ["https://cache.example/{infoHash}.torrent"]
    }),
    cardRenderer: async () => { throw new Error("renderer unavailable in unit test") },
    fetchImpl: async () => ({ ok: true, headers: { get: () => null }, arrayBuffer: async () => torrent }),
    commandRunner: async (command, args) => {
      if (command === "zip") {
        await fs.promises.writeFile(args[2], Buffer.from("zip"))
        return
      }
      payloadArgs.push(args)
      const directory = args.find(item => item.startsWith("--dir=")).slice("--dir=".length)
      await fs.promises.mkdir(path.join(directory, "bundle"), { recursive: true })
      await fs.promises.writeFile(path.join(directory, "bundle", "two.bin"), Buffer.from("hello"))
    },
    fileSender: async (deliveryEvent, filePath, options) => {
      sent.push({ event: deliveryEvent, filePath, options })
      return { receipt: { retcode: 0 } }
    }
  })
  const event = {
    group_id: 100000000 + Math.floor(Math.random() * 1000000),
    user_id: 200000000 + Math.floor(Math.random() * 1000000),
    reply: async value => notices.push(value)
  }
  try {
    const initial = await tool.execute({ magnet }, event)
    assert.match(initial, /selection_required/)
    assert.deepEqual(notices.slice(0, 1), ["正在识别磁链"])
    assert.match(String(notices.at(-1)), /1｜可下载\n  one\.bin\n  大小：4 B/)
    assert.match(String(notices.at(-1)), /2｜可下载\n  two\.bin\n  大小：5 B/)

    const overSelection = await tool.execute({ selection: [1, 2] }, event)
    assert.match(overSelection, /当前上限是 1 个/)
    assert.equal(payloadArgs.length, 0)

    const selected = await tool.execute({ selection: [2] }, event)
    assert.match(selected, /"status":"success"/)
    assert.equal(payloadArgs.length, 1)
    assert.ok(payloadArgs[0].includes("--select-file=2"))
    assert.equal(sent.length, 1)
    assert.equal(sent[0].event.group_id, undefined)
    assert.equal(sent[0].event.user_id, event.user_id)
    assert.match(String(notices.at(-1)), /已私发给发起人/)
  } finally {
    await fs.promises.rm(dirName, { recursive: true, force: true })
  }
})

test("磁链清单统一渲染成卡面图片发送", async () => {
  const dirName = path.join(os.tmpdir(), `torrent-tool-card-${randomUUID()}`)
  const torrent = multiEntryTorrent([
    { name: "one.bin", size: 4 },
    { name: "two.bin", size: 5 }
  ])
  const infoHash = getTorrentInfoHash(torrent)
  const magnet = `magnet:?xt=urn:btih:${infoHash}`
  const notices = []
  const rendered = []
  const tool = new TorrentDownloadTool({
    configProvider: () => normalizeTorrentDownloadConfig({
      enabled: true,
      downloadDir: dirName,
      maxFiles: 1,
      minFreeDiskMb: 64,
      metadataHttpSources: ["https://cache.example/{infoHash}.torrent"]
    }),
    fetchImpl: async () => ({ ok: true, headers: { get: () => null }, arrayBuffer: async () => torrent }),
    commandRunner: async () => {},
    fileSender: async () => ({ receipt: { retcode: 0 } }),
    cardRenderer: async data => {
      rendered.push(data)
      return "/tmp/fake-torrent-card.png"
    }
  })
  const originalSegment = globalThis.segment
  globalThis.segment = { image: file => ({ type: "image", file }) }
  try {
    const result = await tool.execute({ magnet }, {
      group_id: 100000000 + Math.floor(Math.random() * 1000000),
      user_id: 200000000 + Math.floor(Math.random() * 1000000),
      reply: async value => notices.push(value)
    })
    assert.match(result, /selection_required/)
    const imageNotice = notices.find(value => value?.type === "image")
    assert.ok(imageNotice, "应通过 segment.image 发送卡面")
    assert.equal(imageNotice.file, "file:///tmp/fake-torrent-card.png")
    assert.ok(!notices.some(value => String(value).includes("磁链文件清单")), "不应再回退发送文本清单")
    assert.equal(rendered.length, 1)
    assert.equal(rendered[0].rows.length, 2)
    assert.equal(rendered[0].selectableCount, 2)
  } finally {
    if (originalSegment === undefined) delete globalThis.segment
    else globalThis.segment = originalSegment
    await fs.promises.rm(dirName, { recursive: true, force: true })
  }
})

test("does not let another user consume a pending torrent file selection", async () => {
  const tool = new TorrentDownloadTool({ configProvider: () => normalizeTorrentDownloadConfig({ enabled: true }) })
  const result = await tool.execute({ selection: [1] }, {
    group_id: `group-${randomUUID()}`,
    user_id: `other-${randomUUID()}`,
    reply: async () => {}
  })
  assert.match(result, /没有待选择的磁链文件清单/)
})

test("renders the downloaded directory listing for the first forward node", () => {
  const listing = formatTorrentDirectoryListing(parseTorrentMetadata(multiFileTorrent(["assets", "hero.png"])))
  assert.match(listing, /目录与文件清单/)
  assert.match(listing, /根目录: bundle\//)
  assert.match(listing, /assets\/hero\.png/)
})

test("downloads only after metadata passes limits and sends verified files", async () => {
  const dirName = path.join(os.tmpdir(), `torrent-tool-test-${randomUUID()}`)
  const torrent = singleFileTorrent()
  const magnet = `magnet:?xt=urn:btih:${getTorrentInfoHash(torrent)}`
  const notices = []
  const sent = []
  let calls = 0
  const tool = new TorrentDownloadTool({
    configProvider: () => normalizeTorrentDownloadConfig({ enabled: true, downloadDir: dirName, minFreeDiskMb: 64 }),
    commandRunner: async (_command, args) => {
      calls++
      if (_command === "zip") {
        await fs.promises.writeFile(args[2], Buffer.from("zip"))
        return
      }
      const directory = args.find(item => item.startsWith("--dir=")).slice("--dir=".length)
      if (args.includes(magnet)) {
        await fs.promises.writeFile(path.join(directory, "fixture.torrent"), torrent)
      } else {
        await fs.promises.writeFile(path.join(directory, "safe.bin"), Buffer.from("test"))
      }
    },
    fetchImpl: unavailableCacheFetch,
    fileSender: async (deliveryEvent, filePath, options) => {
      sent.push({ event: deliveryEvent, filePath, options })
      return { receipt: { retcode: 0 } }
    }
  })
  const event = {
    group_id: 9527,
    user_id: 9528,
    reply: async text => notices.push(text)
  }
  try {
    const result = await tool.execute({ magnet }, event)
    assert.match(result, /"status":"success"/)
    assert.equal(calls, 3)
    assert.equal(sent.length, 1)
    assert.match(sent[0].options.fileName, new RegExp(`^磁链内容-${getTorrentInfoHash(torrent).slice(0, 12)}\\.zip$`))
    assert.equal(sent[0].event.group_id, undefined)
    assert.equal(sent[0].event.user_id, 9528)
    assert.match(String(notices.at(-1)), /已私发给发起人/)
  } finally {
    await fs.promises.rm(dirName, { recursive: true, force: true })
  }
})

test("does not start payload download when metadata exceeds the configured limit", async () => {
  const dirName = path.join(os.tmpdir(), `torrent-tool-limit-${randomUUID()}`)
  const torrent = singleFileTorrent("large.bin", 2 * 1024 * 1024)
  const magnet = `magnet:?xt=urn:btih:${getTorrentInfoHash(torrent)}`
  let calls = 0
  const tool = new TorrentDownloadTool({
    configProvider: () => normalizeTorrentDownloadConfig({ enabled: true, downloadDir: dirName, maxTotalMb: 1 }),
    commandRunner: async (_command, args) => {
      calls++
      const directory = args.find(item => item.startsWith("--dir=")).slice("--dir=".length)
      await fs.promises.writeFile(path.join(directory, "oversized.torrent"), torrent)
    },
    fetchImpl: unavailableCacheFetch
  })
  try {
    const result = await tool.execute({ magnet }, { reply: async () => {} })
    assert.match(result, /^error:/)
    assert.match(result, /总大小/)
    assert.equal(calls, 1)
  } finally {
    await fs.promises.rm(dirName, { recursive: true, force: true })
  }
})

test("does not start payload download when the archive upload limit would be exceeded", async () => {
  const dirName = path.join(os.tmpdir(), `torrent-tool-archive-limit-${randomUUID()}`)
  const torrent = singleFileTorrent("large.bin", 2 * 1024 * 1024)
  const magnet = `magnet:?xt=urn:btih:${getTorrentInfoHash(torrent)}`
  let calls = 0
  const tool = new TorrentDownloadTool({
    configProvider: () => normalizeTorrentDownloadConfig({ enabled: true, downloadDir: dirName, maxTotalMb: 100, maxArchiveMb: 1 }),
    commandRunner: async (_command, args) => {
      calls++
      const directory = args.find(item => item.startsWith("--dir=")).slice("--dir=".length)
      await fs.promises.writeFile(path.join(directory, "oversized-for-zip.torrent"), torrent)
    },
    fetchImpl: unavailableCacheFetch
  })
  try {
    const result = await tool.execute({ magnet }, { reply: async () => {} })
    assert.match(result, /^error:/)
    assert.match(result, /压缩包上传上限/)
    assert.equal(calls, 1)
  } finally {
    await fs.promises.rm(dirName, { recursive: true, force: true })
  }
})

test("reports a missing aria2 binary without pretending the download started", async () => {
  const tool = new TorrentDownloadTool({
    configProvider: () => normalizeTorrentDownloadConfig({ enabled: true, downloadDir: path.join(os.tmpdir(), `torrent-tool-missing-${randomUUID()}`) }),
    commandRunner: async () => {
      const error = new Error("spawn aria2c ENOENT")
      error.code = "ENOENT"
      throw error
    },
    fetchImpl: unavailableCacheFetch
  })
  const result = await tool.execute({ magnet: MAGNET }, { reply: async () => {} })
  assert.match(result, /^error:/)
  assert.match(result, /没有安装 aria2c/)
})

test("retries metadata discovery through tracker-assisted P2P without claiming payload download started", async () => {
  const calls = []
  const notices = []
  const tool = new TorrentDownloadTool({
    configProvider: () => normalizeTorrentDownloadConfig({ enabled: true, downloadDir: path.join(os.tmpdir(), `torrent-tool-timeout-${randomUUID()}`) }),
    commandRunner: async (_command, args) => {
      calls.push(args)
      const error = new Error("timed out")
      error.code = "timeout"
      throw error
    },
    fetchImpl: async () => { throw new Error("cache unavailable") }
  })
  const result = await tool.execute({ magnet: MAGNET }, { reply: async text => notices.push(text) })
  assert.equal(calls.length, 2)
  assert.ok(calls[1].at(-1).includes("tr="))
  assert.deepEqual(notices, ["正在识别磁链"])
  assert.match(result, /DHT、补充 tracker 和种子元数据缓存/)
  assert.match(result, /内容下载没有开始/)
})

test("uses a verified HTTPS metadata cache before attempting P2P discovery", async () => {
  const torrent = singleFileTorrent()
  const infoHash = getTorrentInfoHash(torrent)
  const magnet = `magnet:?xt=urn:btih:${infoHash}`
  const sent = []
  let metadataAttempts = 0
  let cacheRequests = 0
  const tool = new TorrentDownloadTool({
    configProvider: () => normalizeTorrentDownloadConfig({
      enabled: true,
      downloadDir: path.join(os.tmpdir(), `torrent-tool-cache-${randomUUID()}`),
      metadataHttpSources: ["https://cache.example/{infoHash}.torrent"]
    }),
    commandRunner: async (command, args) => {
      if (args.includes("--bt-metadata-only=true")) {
        metadataAttempts++
        throw new Error("no peer")
      }
      if (command === "zip") {
        await fs.promises.writeFile(args[2], Buffer.from("zip"))
        return
      }
      const directory = args.find(item => item.startsWith("--dir=")).slice("--dir=".length)
      await fs.promises.writeFile(path.join(directory, "safe.bin"), Buffer.from("test"))
    },
    fetchImpl: async url => {
      cacheRequests++
      assert.match(url, new RegExp(infoHash))
      return { ok: true, headers: { get: () => null }, arrayBuffer: async () => torrent }
    },
    fileSender: async () => ({ receipt: { retcode: 0 } })
  })
  const event = { group: { makeForwardMsg: async () => ({ type: "forward" }) }, reply: async value => sent.push(value) }
  const result = await tool.execute({ magnet }, event)
  assert.match(result, /"status":"success"/)
  assert.equal(metadataAttempts, 0)
  assert.equal(cacheRequests, 1)
  assert.equal(sent[0], "正在识别磁链")
})

test("does not expose a tracker URL when both metadata discovery attempts fail", async () => {
  const tool = new TorrentDownloadTool({
    configProvider: () => normalizeTorrentDownloadConfig({ enabled: true, downloadDir: path.join(os.tmpdir(), `torrent-tool-redaction-${randomUUID()}`) }),
    commandRunner: async () => {
      throw new Error("tracker failed: https://tracker.example/announce?token=secret")
    },
    fetchImpl: async () => { throw new Error("cache failed") }
  })
  const result = await tool.execute({ magnet: MAGNET }, { reply: async () => {} })
  assert.match(result, /^error:/)
  assert.doesNotMatch(result, /tracker\.example|token=secret/)
})

test("refuses symbolic links in a completed payload", async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "torrent-tool-link-"))
  const outside = path.join(root, "outside.bin")
  const link = path.join(root, "safe.bin")
  try {
    await fs.promises.writeFile(outside, "test")
    await fs.promises.symlink(outside, link)
    await assert.rejects(
      verifyDownloadedFiles(root, parseTorrentMetadata(singleFileTorrent("safe.bin"))),
      /符号链接/
    )
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true })
  }
})

test("uses the actual current magnet instead of a model-supplied replacement", () => {
  const tool = new TorrentDownloadTool()
  const normalized = tool.normalizeParameters({ magnet: "magnet:?xt=urn:btih:0000000000000000000000000000000000000000" }, {
    userText: `帮我下载 ${MAGNET}`
  })
  assert.equal(normalized.magnet, MAGNET)
})

test("老中文种子的 GBK 文件名回退解码,不再是 U+FFFD 乱码", async () => {
  const { decodeTorrentTextBytes } = await import("../utils/torrentDownload.js")
  // "中文电影" 的 GBK 字节
  const gbkBytes = Buffer.from([0xD6, 0xD0, 0xCE, 0xC4, 0xB5, 0xE7, 0xD3, 0xB0])
  assert.equal(decodeTorrentTextBytes(gbkBytes), "中文电影")
  // 合法 UTF-8 不受影响
  assert.equal(decodeTorrentTextBytes(Buffer.from("新种子文件名")), "新种子文件名")
  assert.equal(decodeTorrentTextBytes(Buffer.from("ascii-name.mkv")), "ascii-name.mkv")
  // 两种都不是的极端字节退回有损 UTF-8(不抛错)
  assert.doesNotThrow(() => decodeTorrentTextBytes(Buffer.from([0xFF, 0xFE, 0xFF])))
})

test("GBK 种子元数据端到端解析出正常文件名", async () => {
  const { parseTorrentMetadata } = await import("../utils/torrentDownload.js")
  // Buffer 不支持 gbk 编码方向,这里用硬编码的 GBK 字节(py: "星球大战…".encode("gbk"))
  const nameGbk = Buffer.from("d0c7c7f2b4f3d5bd342d4456445269702d4d4b56", "hex")
  const fileGbk = Buffer.from("d0c7c7f2b4f3d5bdd5fdb4ab2d4456445269702d4d4b562dd3a2d3efd6d0d7d62e4d4b56", "hex")
  const bencode = Buffer.concat([
    Buffer.from("d4:infod4:name"),
    Buffer.from(`${nameGbk.length}:`),
    nameGbk,
    Buffer.from("5:filesl"),
    Buffer.from(`d4:pathl${fileGbk.length}:`),
    fileGbk,
    Buffer.from("e6:lengthi2048000000eee"),
    Buffer.from("ee")
  ])
  const metadata = parseTorrentMetadata(bencode)
  assert.equal(metadata.name, "星球大战4-DVDRip-MKV")
  assert.equal(metadata.files[0].relativePath.at(-1), "星球大战正传-DVDRip-MKV-英语中字.MKV")
  assert.ok(!metadata.name.includes("\uFFFD"))
})

test("磁链清单卡面数据：行徽章、截断与可下载摘要", async () => {
  const { buildTorrentListCardData } = await import("../utils/torrentListCard.js")
  const metadata = {
    name: "钢铁侠",
    totalBytes: 40_600_000_000,
    files: Array.from({ length: 30 }, (_, i) => ({
      index: i + 1,
      relativePath: ["钢铁侠", `file-${i + 1}.mkv`],
      size: i % 2 ? 40_000 : 500_000_000
    }))
  }
  const selectableIndexes = metadata.files.filter(f => f.size < 50_000_000).map(f => f.index)
  const data = buildTorrentListCardData(metadata, { selectableIndexes, maxRows: 24 })

  assert.equal(data.fileCount, 30)
  assert.equal(data.rows.length, 24)
  assert.equal(data.hiddenCount, 6)
  assert.equal(data.rows[0].selectable, false, "500MB 文件不可下载")
  assert.match(data.rows[0].reason, /超过/)
  assert.equal(data.rows[1].selectable, true)
  assert.equal(data.rows[1].reason, "")
  assert.ok(data.availablePreview.includes("2"))
  assert.ok(data.total.includes("GB"))
  assert.equal(data.selectableCount, 15)
})

test("卡面数据:短清单不截断,无 reason 时不生成说明行", async () => {
  const { buildTorrentListCardData } = await import("../utils/torrentListCard.js")
  const data = buildTorrentListCardData({
    name: "小种子",
    totalBytes: 1024,
    files: [{ index: 1, relativePath: ["小种子", "a.txt"], size: 1024 }]
  }, { selectableIndexes: [1] })
  assert.equal(data.rows.length, 1)
  assert.equal(data.hiddenCount, 0)
  assert.equal(data.rows[0].selectable, true)
})
