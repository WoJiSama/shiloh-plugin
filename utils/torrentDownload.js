import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"

export const MEBIBYTE = 1024 * 1024
export const MEGABYTE = 1000 * 1000
export const HARD_MAX_TOTAL_BYTES = 50 * MEGABYTE
export const HARD_MAX_SINGLE_FILE_BYTES = 50 * MEGABYTE
export const HARD_MAX_FILES = 3
export const HARD_MAX_METADATA_BYTES = 2 * MEBIBYTE
export const HARD_MAX_ARCHIVE_BYTES = 50 * MEGABYTE

const DEFAULT_PUBLIC_TRACKERS = [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.torrent.eu.org:451/announce"
]

const DEFAULT_METADATA_HTTP_SOURCES = [
  "https://itorrents.net/torrent/{infoHash}.torrent",
  "https://torrage.info/torrent.php?h={infoHash}"
]

// ZIP headers plus incompressible data can make an archive slightly larger than
// the raw payload. Reserve 1 MiB before downloading so delivery cannot exceed
// the same configured archive limit after work has already been done.
const ZIP_ARCHIVE_SIZE_RESERVE_BYTES = MEGABYTE

export class TorrentDownloadError extends Error {}

const MAGNET_URI_PATTERN = /magnet:\?[^\s<>'"，。；;]+/i

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(maximum, Math.max(minimum, Math.floor(number)))
}

function toBytesFromMb(value, fallbackMb, hardMaximumBytes) {
  const megabytes = boundedInteger(value, fallbackMb, 1, Math.floor(hardMaximumBytes / MEGABYTE))
  return Math.min(hardMaximumBytes, megabytes * MEGABYTE)
}

export function normalizeTorrentDownloadConfig(raw = {}) {
  const config = raw && typeof raw === "object" ? raw : {}
  const maxTotalBytes = toBytesFromMb(config.maxTotalMb, 50, HARD_MAX_TOTAL_BYTES)
  const maxArchiveBytes = toBytesFromMb(config.maxArchiveMb, 50, HARD_MAX_ARCHIVE_BYTES)
  const maxSingleFileBytes = Math.min(
    maxTotalBytes,
    toBytesFromMb(config.maxSingleFileMb, 50, HARD_MAX_SINGLE_FILE_BYTES)
  )
  return {
    enabled: config.enabled === true,
    aria2Binary: String(config.aria2Binary || "aria2c").trim() || "aria2c",
    zipBinary: String(config.zipBinary || "zip").trim() || "zip",
    downloadDir: String(config.downloadDir || "data/torrent_downloads").trim() || "data/torrent_downloads",
    maxTotalBytes,
    maxSingleFileBytes,
    maxArchiveBytes,
    maxFiles: boundedInteger(config.maxFiles, HARD_MAX_FILES, 1, HARD_MAX_FILES),
    maxMetadataBytes: toBytesFromMb(config.maxMetadataMb, 2, HARD_MAX_METADATA_BYTES),
    metadataDhtTimeoutMs: boundedInteger(config.metadataDhtTimeoutSeconds, 20, 10, 60) * 1000,
    metadataTrackerTimeoutMs: boundedInteger(
      config.metadataTrackerTimeoutSeconds ?? config.metadataTimeoutSeconds,
      45,
      10,
      120
    ) * 1000,
    publicTrackers: normalizePublicTrackers(config.publicTrackers),
    metadataHttpTimeoutMs: boundedInteger(config.metadataHttpTimeoutSeconds, 8, 3, 30) * 1000,
    metadataHttpSources: normalizeMetadataHttpSources(config.metadataHttpSources),
    selectionTtlSeconds: boundedInteger(config.selectionTtlSeconds, 1800, 60, 7200),
    downloadTimeoutMs: boundedInteger(config.downloadTimeoutSeconds, 900, 60, 900) * 1000,
    archiveTimeoutMs: boundedInteger(config.archiveTimeoutSeconds, 60, 10, 120) * 1000,
    minFreeBytes: boundedInteger(config.minFreeDiskMb, 512, 64, 4096) * MEBIBYTE,
    maxConcurrentJobs: 1
  }
}

function normalizePublicTrackers(value) {
  const candidates = Array.isArray(value) && value.length ? value : DEFAULT_PUBLIC_TRACKERS
  return [...new Set(candidates
    .map(item => String(item || "").trim())
    .filter(item => /^(?:udp|https?):\/\//i.test(item)))]
    .slice(0, 12)
}

function normalizeMetadataHttpSources(value) {
  const candidates = Array.isArray(value) && value.length ? value : DEFAULT_METADATA_HTTP_SOURCES
  return [...new Set(candidates
    .map(item => String(item || "").trim())
    .filter(item => {
      try {
        return new URL(item).protocol === "https:" && item.includes("{infoHash}")
      } catch {
        return false
      }
    }))]
    .slice(0, 4)
}

function decodeBase32Hash(value = "") {
  const normalized = String(value || "").replace(/=+$/g, "").toUpperCase()
  if (!/^[A-Z2-7]{32}$/.test(normalized)) return ""
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  let bits = 0
  let buffer = 0
  const bytes = []
  for (const char of normalized) {
    buffer = (buffer << 5) | alphabet.indexOf(char)
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((buffer >> bits) & 0xff)
    }
  }
  return Buffer.from(bytes).toString("hex").toUpperCase()
}

export function parseMagnetUri(value = "") {
  const source = String(value || "").trim()
  if (!/^magnet:\?/i.test(source)) throw new TorrentDownloadError("只支持 magnet:?xt=urn:btih:... 格式的磁链")

  let url
  try {
    url = new URL(source)
  } catch {
    throw new TorrentDownloadError("磁链格式不正确")
  }
  if (url.protocol !== "magnet:") throw new TorrentDownloadError("只支持 magnet 磁链")

  const xt = url.searchParams.getAll("xt").find(item => /^urn:btih:/i.test(item)) || ""
  const rawHash = xt.replace(/^urn:btih:/i, "").trim()
  const infoHash = /^[a-f\d]{40}$/i.test(rawHash)
    ? rawHash.toUpperCase()
    : decodeBase32Hash(rawHash)
  if (!infoHash || !/^[A-F\d]{40}$/.test(infoHash)) {
    throw new TorrentDownloadError("磁链缺少有效的 BTIH 信息哈希")
  }

  return {
    magnet: source,
    infoHash,
    displayName: String(url.searchParams.get("dn") || "").trim().slice(0, 160),
    trackerCount: url.searchParams.getAll("tr").filter(Boolean).length
  }
}

export function extractValidBtihMagnetUri(value = "") {
  const magnet = String(value || "").match(MAGNET_URI_PATTERN)?.[0] || ""
  if (!magnet) return ""
  try {
    parseMagnetUri(magnet)
    return magnet
  } catch {
    return ""
  }
}

export function addPublicTrackersToMagnet(magnet, publicTrackers = DEFAULT_PUBLIC_TRACKERS) {
  const url = new URL(String(magnet || ""))
  const existing = new Set(url.searchParams.getAll("tr").map(item => item.trim()).filter(Boolean))
  for (const tracker of normalizePublicTrackers(publicTrackers)) {
    if (!existing.has(tracker)) url.searchParams.append("tr", tracker)
  }
  return url.toString()
}

export function buildMetadataCacheUrls(infoHash, sources = DEFAULT_METADATA_HTTP_SOURCES) {
  const normalizedHash = String(infoHash || "").toUpperCase()
  if (!/^[A-F\d]{40}$/.test(normalizedHash)) throw new TorrentDownloadError("BTIH 信息哈希无效")
  return normalizeMetadataHttpSources(sources).map(source => source.replaceAll("{infoHash}", normalizedHash))
}

function readBencodedString(input, offset) {
  const colon = input.indexOf(0x3a, offset)
  if (colon < 0) throw new TorrentDownloadError("种子元数据字符串长度缺失")
  const rawLength = input.subarray(offset, colon).toString("ascii")
  if (!/^(?:0|[1-9]\d*)$/.test(rawLength)) throw new TorrentDownloadError("种子元数据字符串长度无效")
  const length = Number(rawLength)
  const start = colon + 1
  const end = start + length
  if (!Number.isSafeInteger(length) || end > input.length) throw new TorrentDownloadError("种子元数据字符串不完整")
  return { bytes: input.subarray(start, end), end }
}

function skipBencodedValue(input, offset, depth = 0) {
  if (depth > 64 || offset >= input.length) throw new TorrentDownloadError("种子元数据格式无效")
  const token = input[offset]
  if (token === 0x69) {
    const end = input.indexOf(0x65, offset + 1)
    if (end < 0) throw new TorrentDownloadError("种子元数据整数格式不完整")
    return end + 1
  }
  if (token === 0x6c || token === 0x64) {
    let cursor = offset + 1
    while (input[cursor] !== 0x65) cursor = skipBencodedValue(input, cursor, depth + 1)
    return cursor + 1
  }
  if (token >= 0x30 && token <= 0x39) return readBencodedString(input, offset).end
  throw new TorrentDownloadError("种子元数据格式无效")
}

export function getTorrentInfoHash(source) {
  const input = Buffer.isBuffer(source) ? source : Buffer.from(source || "")
  if (input[0] !== 0x64) throw new TorrentDownloadError("种子元数据不是字典")
  let offset = 1
  while (input[offset] !== 0x65) {
    const key = readBencodedString(input, offset)
    const valueStart = key.end
    const valueEnd = skipBencodedValue(input, valueStart)
    if (key.bytes.toString("utf8") === "info") {
      if (input[valueStart] !== 0x64) throw new TorrentDownloadError("种子缺少 info 元数据")
      return createHash("sha1").update(input.subarray(valueStart, valueEnd)).digest("hex").toUpperCase()
    }
    offset = valueEnd
  }
  throw new TorrentDownloadError("种子缺少 info 元数据")
}

function bdecode(source, { maxDepth = 64, maxItems = 20_000 } = {}) {
  const input = Buffer.isBuffer(source) ? source : Buffer.from(source || "")
  let offset = 0
  let itemCount = 0

  const readByte = () => input[offset]
  const consume = () => input[offset++]

  const parse = depth => {
    if (depth > maxDepth) throw new TorrentDownloadError("种子元数据嵌套过深")
    if (++itemCount > maxItems) throw new TorrentDownloadError("种子元数据条目过多")
    const byte = readByte()
    if (byte === 0x69) {
      consume()
      const end = input.indexOf(0x65, offset)
      if (end < 0) throw new TorrentDownloadError("种子元数据整数格式不完整")
      const raw = input.subarray(offset, end).toString("ascii")
      offset = end + 1
      if (!/^-?(?:0|[1-9]\d*)$/.test(raw)) throw new TorrentDownloadError("种子元数据整数格式无效")
      const value = BigInt(raw)
      if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new TorrentDownloadError("种子元数据中的数值超出支持范围")
      return Number(value)
    }
    if (byte === 0x6c) {
      consume()
      const values = []
      while (readByte() !== 0x65) {
        if (offset >= input.length) throw new TorrentDownloadError("种子元数据列表不完整")
        values.push(parse(depth + 1))
      }
      consume()
      return values
    }
    if (byte === 0x64) {
      consume()
      const value = Object.create(null)
      while (readByte() !== 0x65) {
        if (offset >= input.length) throw new TorrentDownloadError("种子元数据字典不完整")
        const key = parse(depth + 1)
        if (!Buffer.isBuffer(key)) throw new TorrentDownloadError("种子元数据字典键无效")
        const keyText = key.toString("utf8")
        if (!keyText || Object.hasOwn(value, keyText)) throw new TorrentDownloadError("种子元数据字典键无效")
        value[keyText] = parse(depth + 1)
      }
      consume()
      return value
    }
    if (byte >= 0x30 && byte <= 0x39) {
      const colon = input.indexOf(0x3a, offset)
      if (colon < 0) throw new TorrentDownloadError("种子元数据字符串长度缺失")
      const rawLength = input.subarray(offset, colon).toString("ascii")
      if (!/^(?:0|[1-9]\d*)$/.test(rawLength)) throw new TorrentDownloadError("种子元数据字符串长度无效")
      const length = Number(rawLength)
      const start = colon + 1
      const end = start + length
      if (!Number.isSafeInteger(length) || end > input.length) throw new TorrentDownloadError("种子元数据字符串不完整")
      offset = end
      return input.subarray(start, end)
    }
    throw new TorrentDownloadError("种子元数据格式无效")
  }

  const result = parse(0)
  if (offset !== input.length) throw new TorrentDownloadError("种子元数据包含未解析内容")
  return result
}

function textValue(value, field) {
  if (!Buffer.isBuffer(value)) throw new TorrentDownloadError(`种子缺少有效的 ${field}`)
  const text = value.toString("utf8").normalize("NFC")
  if (!text || text.includes("\u0000")) throw new TorrentDownloadError(`种子中的 ${field} 无效`)
  return text
}

function safePathSegment(value, field = "文件路径") {
  const text = textValue(value, field)
  if (text === "." || text === ".." || text.includes("/") || text.includes("\\") || /[\u0000-\u001f\u007f]/.test(text) || text.length > 180) {
    throw new TorrentDownloadError(`种子中的 ${field} 不安全`)
  }
  return text
}

function fileLength(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TorrentDownloadError("种子中的文件大小无效")
  return value
}

export function parseTorrentMetadata(buffer) {
  const root = bdecode(buffer)
  const info = root?.info
  if (!info || typeof info !== "object" || Array.isArray(info)) throw new TorrentDownloadError("种子缺少 info 元数据")
  const name = safePathSegment(info.name, "文件名")
  const files = []
  if (info.length !== undefined) {
    files.push({ index: 1, relativePath: [name], size: fileLength(info.length) })
  } else if (Array.isArray(info.files)) {
    for (const item of info.files) {
      if (!item || typeof item !== "object" || !Array.isArray(item.path) || !item.path.length) {
        throw new TorrentDownloadError("种子中的文件列表无效")
      }
      files.push({
        index: files.length + 1,
        relativePath: [name, ...item.path.map(segment => safePathSegment(segment))],
        size: fileLength(item.length)
      })
    }
  } else {
    throw new TorrentDownloadError("该种子不是可解析的单文件或多文件 v1 种子")
  }
  if (!files.length) throw new TorrentDownloadError("种子没有可下载文件")

  let totalBytes = 0
  for (const file of files) {
    totalBytes += file.size
    if (!Number.isSafeInteger(totalBytes)) throw new TorrentDownloadError("种子总大小超出支持范围")
  }
  return { name, files, totalBytes }
}

export function fingerprintTorrentMetadata(source) {
  const input = Buffer.isBuffer(source) ? source : Buffer.from(source || "")
  if (!input.length) throw new TorrentDownloadError("没有拿到可校验的种子元数据")
  return createHash("sha256").update(input).digest("hex")
}

function normalizeTorrentFileIndexes(selection) {
  const values = Array.isArray(selection) ? selection : [selection]
  const indexes = []
  for (const value of values) {
    if (typeof value === "string" && /[,，、]/.test(value)) {
      indexes.push(...value.split(/[,，、]/).map(item => item.trim()))
      continue
    }
    indexes.push(value)
  }
  const normalized = indexes.map(value => {
    const text = String(value ?? "").trim().replace(/^第\s*/, "").replace(/(?:个|项|号)$/, "")
    if (!/^\d+$/.test(text)) throw new TorrentDownloadError("请选择文件清单中的编号，例如 下载 1,3")
    const index = Number(text)
    if (!Number.isSafeInteger(index) || index < 1) throw new TorrentDownloadError("文件编号无效")
    return index
  })
  return [...new Set(normalized)]
}

export function selectTorrentFiles(metadata, selection) {
  if (!metadata || !Array.isArray(metadata.files) || !metadata.files.length) {
    throw new TorrentDownloadError("没有可选择的种子文件")
  }
  const indexes = normalizeTorrentFileIndexes(selection)
  if (!indexes.length) throw new TorrentDownloadError("请至少选择一个文件")
  const byIndex = new Map(metadata.files.map((file, offset) => [Number(file.index) || offset + 1, file]))
  const files = indexes.map(index => {
    const file = byIndex.get(index)
    if (!file) throw new TorrentDownloadError(`文件编号 ${index} 不在当前磁链清单中`)
    return { ...file, index }
  })
  const totalBytes = files.reduce((total, file) => total + file.size, 0)
  if (!Number.isSafeInteger(totalBytes)) throw new TorrentDownloadError("所选文件总大小超出支持范围")
  return { ...metadata, files, totalBytes }
}

export function assertTorrentWithinLimits(metadata, config) {
  if (metadata.files.length > config.maxFiles) {
    throw new TorrentDownloadError(`该磁链包含 ${metadata.files.length} 个文件，当前上限是 ${config.maxFiles} 个`)
  }
  if (metadata.totalBytes > config.maxTotalBytes) {
    throw new TorrentDownloadError(`该磁链总大小为 ${formatBytes(metadata.totalBytes)}，超过 ${formatBytes(config.maxTotalBytes)} 的上限`)
  }
  const oversized = metadata.files.find(file => file.size > config.maxSingleFileBytes)
  if (oversized) {
    throw new TorrentDownloadError(`${oversized.relativePath.join("/")} 为 ${formatBytes(oversized.size)}，超过单文件 ${formatBytes(config.maxSingleFileBytes)} 上限`)
  }
  return metadata
}

export function assertTorrentFitsArchive(metadata, config) {
  const reservedBytes = Math.min(ZIP_ARCHIVE_SIZE_RESERVE_BYTES, Math.floor(config.maxArchiveBytes / 10))
  const allowedPayloadBytes = Math.max(0, config.maxArchiveBytes - reservedBytes)
  if (metadata.totalBytes > allowedPayloadBytes) {
    throw new TorrentDownloadError(`该磁链解压后为 ${formatBytes(metadata.totalBytes)}，压缩包上传上限是 ${formatBytes(config.maxArchiveBytes)}，不会开始下载`)
  }
  return metadata
}

export async function readTorrentMetadata(filePath, maxBytes = HARD_MAX_METADATA_BYTES) {
  const stat = await fs.promises.stat(filePath)
  if (!stat.isFile() || stat.size <= 0) throw new TorrentDownloadError("没有拿到可解析的种子元数据")
  if (stat.size > maxBytes) throw new TorrentDownloadError(`种子元数据超过 ${formatBytes(maxBytes)} 上限`)
  return parseTorrentMetadata(await fs.promises.readFile(filePath))
}

export async function findSavedTorrentFile(directory) {
  const entries = await fs.promises.readdir(directory, { withFileTypes: true })
  const candidates = entries
    .filter(entry => entry.isFile() && /\.torrent$/i.test(entry.name))
    .map(entry => path.join(directory, entry.name))
  if (!candidates.length) throw new TorrentDownloadError("磁链没有返回可保存的种子元数据")
  const stats = await Promise.all(candidates.map(async file => ({ file, stat: await fs.promises.stat(file) })))
  return stats.sort((left, right) => right.stat.mtimeMs - left.stat.mtimeMs)[0].file
}

export async function verifyDownloadedFiles(rootDir, metadata) {
  const root = path.resolve(rootDir)
  const files = []
  let totalBytes = 0
  for (const item of metadata.files) {
    const resolved = path.resolve(root, ...item.relativePath)
    if (!resolved.startsWith(`${root}${path.sep}`)) throw new TorrentDownloadError("下载文件路径越出临时目录")
    let current = root
    for (const segment of item.relativePath) {
      current = path.join(current, segment)
      const segmentStat = await fs.promises.lstat(current)
      if (segmentStat.isSymbolicLink()) throw new TorrentDownloadError("下载目录中出现符号链接，已停止发送")
    }
    const stat = await fs.promises.stat(resolved)
    if (!stat.isFile() || stat.size !== item.size) {
      throw new TorrentDownloadError(`下载文件不完整：${item.relativePath.join("/")}`)
    }
    totalBytes += stat.size
    files.push({ path: resolved, name: item.relativePath.at(-1), size: stat.size })
  }
  if (totalBytes !== metadata.totalBytes) throw new TorrentDownloadError("下载文件总大小与种子元数据不一致")
  return files
}

export async function verifyArchiveFile(filePath, maxBytes) {
  const stat = await fs.promises.lstat(filePath)
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size <= 0) {
    throw new TorrentDownloadError("压缩包没有正确生成")
  }
  if (stat.size > maxBytes) {
    throw new TorrentDownloadError(`压缩包为 ${formatBytes(stat.size)}，超过 ${formatBytes(maxBytes)} 的上传上限`)
  }
  return { path: filePath, size: stat.size }
}

export function formatTorrentDirectoryListing(metadata, { maxLength = 1_600 } = {}) {
  const lines = [
    "目录与文件清单",
    `根目录: ${metadata.name}/`,
    `文件: ${metadata.files.length} 个 | 解压后: ${formatBytes(metadata.totalBytes)}`
  ]
  for (const [index, file] of metadata.files.entries()) {
    const relative = file.relativePath.slice(1).join("/") || metadata.name
    lines.push(`${index === metadata.files.length - 1 ? "└─" : "├─"} ${relative} (${formatBytes(file.size)})`)
  }
  const text = lines.join("\n")
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(1, maxLength - 16))}\n...目录已截断`
}

export function formatTorrentSelectionListing(metadata, {
  selectableIndexes = [],
  unavailableReasons = new Map(),
  maxTotalBytes = 50 * MEGABYTE,
  maxLength = 1_600
} = {}) {
  const selectable = new Set((Array.isArray(selectableIndexes) ? selectableIndexes : [])
    .map(value => Number(value))
    .filter(value => Number.isSafeInteger(value) && value >= 1))
  const available = metadata.files
    .map((file, offset) => Number(file.index) || offset + 1)
    .filter(index => selectable.has(index))
  const lines = [
    "【磁链文件清单】",
    `根目录：${metadata.name}/`,
    `总大小：${formatBytes(metadata.totalBytes)}（整包超过 ${formatBytes(maxTotalBytes)}，不能整包下载）`,
    ""
  ]
  for (const [offset, file] of metadata.files.entries()) {
    const index = Number(file.index) || offset + 1
    const relative = file.relativePath.slice(1).join("/") || metadata.name
    const isSelectable = selectable.has(index)
    const reason = unavailableReasons instanceof Map ? unavailableReasons.get(index) : unavailableReasons?.[index]
    lines.push(
      `${index}｜${isSelectable ? "可下载" : "不可下载"}`,
      `  ${relative}`,
      `  大小：${formatBytes(file.size)}${isSelectable ? "" : `｜${reason || "超过当前下载限制"}`}`,
      ""
    )
  }
  if (available.length) {
    const example = available.slice(0, 2).join(",")
    lines.push(`可下载编号：${available.join("、")}`)
    lines.push(`回复“下载 ${example}”即可；只能填写标为“可下载”的编号。`)
  }
  const text = lines.join("\n")
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(1, maxLength - 16))}\n...清单已截断`
}

export function formatBytes(bytes = 0) {
  const value = Math.max(0, Number(bytes) || 0)
  if (value < 1024) return `${value} B`
  if (value < MEGABYTE) return `${(value / 1000).toFixed(1)} kB`
  if (value >= 1000 * MEGABYTE) return `${(value / (1000 * MEGABYTE)).toFixed(1)} GB`
  return `${(value / MEGABYTE).toFixed(1)} MB`
}

export function buildAriaMetadataArgs({ directory, magnet }) {
  return [
    "--bt-metadata-only=true",
    "--bt-save-metadata=true",
    "--seed-time=0",
    "--enable-dht=true",
    "--enable-dht6=false",
    "--file-allocation=none",
    "--summary-interval=0",
    "--console-log-level=warn",
    "--download-result=hide",
    `--dir=${directory}`,
    magnet
  ]
}

export function buildAriaDownloadArgs({ directory, torrentFile, selectedFileIndexes = [] }) {
  const selected = [...new Set((Array.isArray(selectedFileIndexes) ? selectedFileIndexes : [selectedFileIndexes])
    .map(value => Number(value))
    .filter(value => Number.isSafeInteger(value) && value >= 1))]
  return [
    "--seed-time=0",
    "--file-allocation=none",
    "--auto-file-renaming=false",
    "--allow-overwrite=false",
    "--continue=true",
    "--summary-interval=0",
    "--console-log-level=warn",
    "--download-result=hide",
    `--dir=${directory}`,
    ...(selected.length ? [`--select-file=${selected.join(",")}`] : []),
    torrentFile
  ]
}

export function buildZipArgs({ archiveFile, files = [] }) {
  const selected = (Array.isArray(files) ? files : [])
    .map(file => Array.isArray(file?.relativePath) ? file.relativePath.join("/") : String(file || ""))
    .filter(Boolean)
  return selected.length ? ["-q", "-r", archiveFile, ...selected] : ["-q", "-r", archiveFile, "."]
}
