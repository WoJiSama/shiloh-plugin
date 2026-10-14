import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
}

export async function withFileLock<T>(file: string, work: () => T | Promise<T>, { timeoutMs = 10000, staleMs = 30000 } = {}): Promise<T> {
  ensureDir(path.dirname(file))
  const startedAt = Date.now()
  const token = `${process.pid}:${startedAt}:${crypto.randomBytes(6).toString("hex")}`
  let handle: number | undefined
  while (handle === undefined) {
    try {
      handle = fs.openSync(file, "wx", 0o600)
      fs.writeFileSync(handle, token, "utf8")
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error
      try {
        const stat = fs.statSync(file)
        if (Date.now() - stat.mtimeMs > staleMs) fs.unlinkSync(file)
      } catch {}
      if (Date.now() - startedAt >= timeoutMs) throw new Error("状态正被另一个进程使用，请稍后重试")
      await new Promise(resolve => setTimeout(resolve, 20 + Math.floor(Math.random() * 30)))
    }
  }
  try {
    return await work()
  } finally {
    try { fs.closeSync(handle) } catch {}
    try {
      if (fs.readFileSync(file, "utf8") === token) fs.unlinkSync(file)
    } catch {}
  }
}
