// 并行分片下载:Range 支持时分片写入与原内容一致;不支持 Range 时单流回退;
// 大小上限与分片重试语义。
import { test } from "node:test"
import assert from "node:assert/strict"
import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { fetchDownloadToFile } from "../utils/parallelDownload.js"

function startServer({ supportRange = true, body }) {
  const server = http.createServer((request, response) => {
    const range = supportRange ? request.headers.range : null
    const match = range && range.match(/bytes=(\d+)-(\d*)/)
    if (match) {
      const start = Number(match[1])
      const end = Math.min(match[2] ? Number(match[2]) : body.length - 1, body.length - 1)
      response.writeHead(206, {
        "content-type": "application/octet-stream",
        "content-range": `bytes ${start}-${end}/${body.length}`,
        "content-length": String(end - start + 1)
      })
      response.end(body.subarray(start, end + 1))
      return
    }
    response.writeHead(200, { "content-type": "application/octet-stream", "content-length": String(body.length) })
    response.end(body)
  })
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${server.address().port}/file.bin` })))
}

async function withTempFile(run) {
  const filePath = path.join(os.tmpdir(), `pd-test-${crypto.randomUUID()}.bin`)
  try {
    return await run(filePath)
  } finally {
    await fs.promises.unlink(filePath).catch(() => {})
  }
}

test("支持 Range 的服务端:分片下载内容与原文完全一致", async () => {
  const body = crypto.randomBytes(20 * 1024 * 1024) // 20MB,触发分片(默认8MB一片)
  const { server, url } = await startServer({ supportRange: true, body })
  try {
    await withTempFile(async filePath => {
      await fetchDownloadToFile(url, filePath, { logger: null })
      const downloaded = await fs.promises.readFile(filePath)
      assert.equal(downloaded.length, body.length)
      assert.ok(downloaded.equals(body))
    })
  } finally {
    server.close()
  }
})

test("不支持 Range 的服务端:自动退回单流,内容一致", async () => {
  const body = crypto.randomBytes(3 * 1024 * 1024)
  const { server, url } = await startServer({ supportRange: false, body })
  try {
    await withTempFile(async filePath => {
      await fetchDownloadToFile(url, filePath, { logger: null })
      const downloaded = await fs.promises.readFile(filePath)
      assert.ok(downloaded.equals(body))
    })
  } finally {
    server.close()
  }
})

test("小文件直接单流,内容一致", async () => {
  const body = crypto.randomBytes(64 * 1024)
  const { server, url } = await startServer({ supportRange: true, body })
  try {
    await withTempFile(async filePath => {
      await fetchDownloadToFile(url, filePath, { chunkBytes: 1024 * 1024, logger: null })
      const downloaded = await fs.promises.readFile(filePath)
      assert.ok(downloaded.equals(body))
    })
  } finally {
    server.close()
  }
})

test("超过大小上限时抛错", async () => {
  const body = crypto.randomBytes(2 * 1024 * 1024)
  const { server, url } = await startServer({ supportRange: true, body })
  try {
    await withTempFile(async filePath => {
      await assert.rejects(
        () => fetchDownloadToFile(url, filePath, { maxBytes: 1024, logger: null }),
        /安全上限/
      )
    })
  } finally {
    server.close()
  }
})
