import fs from "node:fs"
import os from "node:os"
import path from "node:path"

function cookieJarText(cookieHeader = "") {
  const header = String(cookieHeader || "").replace(/^\s*cookie\s*:\s*/i, "").trim()
  if (!header || /[\r\n]/.test(header)) return ""
  const cookies = header.split(";").map(part => {
    const index = part.indexOf("=")
    if (index <= 0) return null
    const name = part.slice(0, index).trim()
    const value = part.slice(index + 1).trim()
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\t\r\n]/.test(value)) return null
    return `${name}\t${value}`
  }).filter(Boolean)
  if (!cookies.length) return ""
  return ["# Netscape HTTP Cookie File", ...cookies.map(cookie => `.youtube.com\tTRUE\t/\tTRUE\t0\t${cookie}`), ""].join("\n")
}

function poTokenText(poToken = "") {
  const token = String(poToken || "").trim()
  if (!token || /[\s\r\n]/.test(token)) return ""
  return `--extractor-args\nyoutube:po_token=web+${token}\n`
}

/**
 * Pass YouTube authorization to yt-dlp through owner-only temporary files.
 * Never add the credential values to argv because process listings may expose it.
 */
export async function withYoutubeYtDlpAuth({ cookieHeader, poToken } = {}, run) {
  const cookieText = cookieJarText(cookieHeader)
  const tokenText = poTokenText(poToken)
  if (!cookieText && !tokenText) return await run([])

  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "bl-chat-plugin-youtube-auth-"))
  try {
    await fs.promises.chmod(directory, 0o700)
    const args = []
    if (cookieText) {
      const cookiePath = path.join(directory, "cookies.txt")
      await fs.promises.writeFile(cookiePath, cookieText, { mode: 0o600 })
      await fs.promises.chmod(cookiePath, 0o600)
      args.push("--cookies", cookiePath)
    }
    if (tokenText) {
      const configPath = path.join(directory, "yt-dlp.conf")
      await fs.promises.writeFile(configPath, tokenText, { mode: 0o600 })
      await fs.promises.chmod(configPath, 0o600)
      args.push("--config-locations", configPath)
    }
    return await run(args)
  } finally {
    await fs.promises.rm(directory, { recursive: true, force: true }).catch(() => {})
  }
}
