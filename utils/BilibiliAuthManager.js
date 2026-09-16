import fs from "node:fs"
import path from "node:path"
import QRCode from "qrcode"

const GENERATE_URL = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate"
const POLL_URL = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll"

export class BilibiliAuthManager {
  constructor({ file = path.join(process.cwd(), "plugins/shiloh-plugin/config/bilibili-auth.json"), fetchImpl = globalThis.fetch, logger = globalThis.logger } = {}) {
    this.file = file
    this.fetch = fetchImpl
    this.logger = logger
    this.pending = null
  }

  status() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, "utf8"))
      return { authorized: Boolean(data?.cookie), updatedAt: data?.updatedAt || 0 }
    } catch { return { authorized: false, updatedAt: 0 } }
  }

  cookie() {
    try { return String(JSON.parse(fs.readFileSync(this.file, "utf8"))?.cookie || "") } catch { return "" }
  }

  canUseHighQuality({ isMaster = false, groupId = "", userId = "", whitelist = {} } = {}) {
    if (isMaster) return true
    return (whitelist?.[String(groupId)] || []).map(String).includes(String(userId))
  }

  async start() {
    if (this.pending) throw new Error("已有等待扫码的B站登录会话")
    const payload = await this.fetch(GENERATE_URL).then(res => res.json())
    const key = payload?.data?.qrcode_key
    const url = payload?.data?.url
    if (payload?.code !== 0 || !key || !url) throw new Error(payload?.message || "B站未返回登录二维码")
    const png = await QRCode.toBuffer(url, { type: "png", margin: 2, width: 480 })
    const expiresAt = Date.now() + 170_000
    this.pending = { key, expiresAt }
    return { image: `base64://${png.toString("base64")}`, expiresAt }
  }

  async poll() {
    const pending = this.pending
    if (!pending) return { state: "idle" }
    if (Date.now() >= pending.expiresAt) { this.pending = null; return { state: "expired" } }
    const payload = await this.fetch(`${POLL_URL}?qrcode_key=${encodeURIComponent(pending.key)}`).then(res => res.json())
    const code = Number(payload?.data?.code)
    if (code === 0) {
      const url = new URL(payload.data.url)
      const cookie = ["SESSDATA", "bili_jct", "DedeUserID"].map(name => url.searchParams.get(name) ? `${name}=${url.searchParams.get(name)}` : "").filter(Boolean).join("; ")
      if (!cookie) throw new Error("B站登录成功但未返回授权凭据")
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify({ cookie, updatedAt: Date.now() }), { mode: 0o600 })
      fs.chmodSync(this.file, 0o600)
      this.pending = null
      return { state: "success" }
    }
    if (code === 86038) { this.pending = null; return { state: "expired" } }
    return { state: "waiting" }
  }

  logout() { this.pending = null; fs.rmSync(this.file, { force: true }); return { state: "logged_out" } }
}
