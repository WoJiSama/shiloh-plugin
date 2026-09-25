// 并行分片下载:B 站等 CDN 对单连接限速(~1MB/s),Range 分片并发可快一个
// 数量级(实测 4 并发拉 10MB 仅 120ms)。首个分片请求兼做能力探测:
// 206 = 支持 Range,余下分片并发拉取;200 = 不支持,该响应直接单流落盘。
// 任何路径下媒体请求至少 1 次、不多发探测请求。
import fs from "node:fs"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"

const DEFAULT_CHUNK_BYTES = 2 * 1024 * 1024
const DEFAULT_CONCURRENCY = 8
// 首片故意小:串行成本压到 ~0.25s,快速探明总量后其余分片全并发
const FIRST_CHUNK_BYTES = 256 * 1024

/**
 * 并行分片下载到文件。返回写入的文件路径;失败抛错(由调用方决定回退)。
 * - 分片内存占用 ≤ concurrency × chunkBytes(默认 6×8MB)
 * - 单个分片失败自动重试一次,再失败整体抛错
 */
export async function fetchDownloadToFile(url, filePath, {
  headers = {},
  concurrency = DEFAULT_CONCURRENCY,
  chunkBytes = DEFAULT_CHUNK_BYTES,
  maxBytes = 512 * 1024 * 1024,
  timeoutMs = 10 * 60 * 1000,
  logger = globalThis.logger
} = {}) {
  const target = String(url || "")
  if (!/^https?:\/\//i.test(target)) throw new Error("无效的下载地址")
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || 0))
  try {
    const size = Math.max(256 * 1024, Number(chunkBytes) || DEFAULT_CHUNK_BYTES)
    const first = await fetch(target, {
      headers: { ...headers, Range: `bytes=0-${FIRST_CHUNK_BYTES - 1}` },
      signal: controller.signal
    })
    if (!first.ok && first.status !== 206) throw new Error(`下载失败 HTTP ${first.status}`)
    if (!first.body) throw new Error("下载响应无内容")

    const total = Number(String(first.headers.get("content-range") || "").match(/\/(\d+)$/)?.[1] || 0)
    if (first.status === 206 && total > maxBytes) throw new Error(`文件超过${Math.round(maxBytes / 1048576)}MB安全上限`)
    if (first.status === 206 && total > FIRST_CHUNK_BYTES && total <= maxBytes) {
      const firstBuffer = Buffer.from(await first.arrayBuffer())
      await downloadRemainingRanges(target, filePath, {
        firstBuffer,
        total,
        headers,
        concurrency: Math.max(1, Math.min(Number(concurrency) || DEFAULT_CONCURRENCY, 16)),
        chunkBytes: size,
        maxBytes,
        signal: controller.signal,
        logger
      })
      logger?.info?.(`[并行下载] 分片完成 total=${total} bytes`)
      return filePath
    }

    // 不支持 Range / 小文件 / 超上限:当前响应直接单流落盘(不再发新请求)
    await writeSingleStream(first, filePath, { maxBytes })
    return filePath
  } finally {
    clearTimeout(timer)
  }
}

async function fetchRangeBuffer(url, start, end, headers, signal) {
  const response = await fetch(url, { headers: { ...headers, Range: `bytes=${start}-${end}` }, signal })
  if (!response.ok && response.status !== 206 || !response.body) throw new Error(`分片请求失败 HTTP ${response.status}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length !== end - start + 1) throw new Error(`分片大小不符 ${start}-${end}(期望${end - start + 1},实得${buffer.length})`)
  return buffer
}

async function downloadRemainingRanges(url, filePath, { firstBuffer, total, headers, concurrency, chunkBytes, maxBytes, signal, logger }) {
  if (total > maxBytes) throw new Error(`文件超过${Math.round(maxBytes / 1048576)}MB安全上限`)
  const ranges = []
  for (let offset = firstBuffer.length; offset < total; offset += chunkBytes) {
    ranges.push([offset, Math.min(offset + chunkBytes, total) - 1])
  }
  const fh = await fs.promises.open(filePath, "w")
  try {
    await fh.write(firstBuffer, 0, firstBuffer.length, 0)
    let next = 0
    let completed = 0
    const worker = async () => {
      while (next < ranges.length) {
        const index = next++
        const [start, end] = ranges[index]
        let buffer = null
        let lastError = null
        for (let attempt = 0; attempt < 2 && !buffer; attempt++) {
          try {
            buffer = await fetchRangeBuffer(url, start, end, headers, signal)
          } catch (error) {
            lastError = error
          }
        }
        if (!buffer) throw lastError || new Error(`分片下载失败 ${start}-${end}`)
        await fh.write(buffer, 0, buffer.length, start)
        completed++
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, ranges.length) }, worker))
    if (completed !== ranges.length) throw new Error("分片下载数量不符")
    await fh.sync?.().catch(() => {})
  } catch (error) {
    logger?.warn?.(`[并行下载] 分片失败: ${error.message}`)
    throw error
  } finally {
    await fh.close().catch(() => {})
  }
}

async function writeSingleStream(response, filePath, { maxBytes }) {
  const contentLength = Number(response.headers.get("content-length") || 0)
  if (contentLength > maxBytes) throw new Error(`文件超过${Math.round(maxBytes / 1048576)}MB安全上限`)
  let downloadedBytes = 0
  const limitStream = new Transform({
    transform(chunk, encoding, callback) {
      downloadedBytes += chunk.length
      if (downloadedBytes > maxBytes) {
        callback(new Error(`下载超过${Math.round(maxBytes / 1048576)}MB安全上限`))
        return
      }
      callback(null, chunk)
    }
  })
  await pipeline(Readable.fromWeb(response.body), limitStream, fs.createWriteStream(filePath))
}
