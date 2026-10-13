// QQ空间说说发布 API:挂在 Yunzai express /bl-chat/qzone,与命令管理页共用主令牌。
// 控制台"说说"页经 bl-console 后端转发调用;每个 bot 各自走 get_credentials 取
// qzone.qq.com 的 Cookie,互不串号。发布接口为 qzone 官方 emotion_cgi_publish_v6。

const MOUNT_PATH = "/bl-chat/qzone"
const CONTENT_MAX = 2000
let registered = false

// qzone g_tk = hash(p_skey),与 QQApi.getGtk 同算法
function computeGtk(pSkey = "") {
  let hash = 5381
  for (let index = 0; index < pSkey.length; index++) {
    hash += (hash << 5) + pSkey.charCodeAt(index)
  }
  return hash & 2147483647
}

function gtkFromCookieString(cookieString = "") {
  const raw = /(?:^|;\s*)p_skey=([^;]+)/.exec(String(cookieString || ""))?.[1] || ""
  if (!raw) return 0
  try {
    return computeGtk(decodeURIComponent(raw))
  } catch {
    return computeGtk(raw)
  }
}

export function listQzoneBots() {
  const bots = []
  for (const [qq, bot] of Object.entries(globalThis.Bot?.bots || {})) {
    bots.push({ qq: String(qq), nickname: bot?.nickname || String(qq) })
  }
  return bots
}

/**
 * 用指定 bot 的登录态发布一条文本说说。发布是各 bot 独立动作:
 * 失败抛错由调用方逐号收集,不中断其他号。
 */
export async function publishShuoshuo(bot, content = "") {
  const credentials = await bot.sendApi("get_credentials", { domain: "qzone.qq.com" })
  const cookies = String(credentials?.data?.cookies || "")
  if (!cookies) throw new Error("get_credentials 未返回 Cookie（可能需要重新登录）")
  let gtk = Number(credentials?.data?.token ?? credentials?.data?.csrf_token)
  if (!Number.isFinite(gtk) || gtk <= 0) gtk = gtkFromCookieString(cookies)
  if (!gtk) throw new Error("Cookie 中缺少 p_skey，无法计算 g_tk")
  const uin = String(bot.uin || "")
  const body = new URLSearchParams({
    syn_tweet_verson: "1",
    paramstr: "1",
    con: content,
    feedversion: "1",
    ver: "1",
    ugc_right: "1",
    to_sign: "1",
    hostuin: uin,
    code_version: "1",
    format: "json"
  })
  const response = await fetch(
    `https://user.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_publish_v6?g_tk=${gtk}`,
    {
      method: "POST",
      headers: {
        Cookie: cookies,
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: `https://user.qzone.qq.com/${uin}/infocenter`
      },
      body,
      signal: AbortSignal.timeout(15000)
    }
  )
  const payload = await response.json().catch(() => null)
  if (Number(payload?.code) !== 0) {
    throw new Error(`Qzone 接口返回 code=${payload?.code ?? "?"}${payload?.message ? `：${String(payload.message).slice(0, 120)}` : ""}`)
  }
  return { tid: payload?.tid || "" }
}

function checkToken(req, token = "") {
  const provided = String(req?.query?.token || req?.headers?.["x-commands-token"] || "")
  return Boolean(token) && provided === token
}

export function registerQzoneWebApp(expressApp, tokens = {}, logger = globalThis.logger) {
  if (!expressApp?.use || registered) return
  registered = true
  const token = String(tokens?.token || "")

  expressApp.use(MOUNT_PATH, (req, res, next) => {
    if (!checkToken(req, token)) return res.status(401).json({ error: "unauthorized" })
    if (req.path === "/api/bots" && req.method === "GET") {
      return res.json({ bots: listQzoneBots() })
    }
    if (req.path === "/api/publish" && req.method === "POST") {
      void (async () => {
        try {
          const botIds = Array.isArray(req.body?.botIds) ? req.body.botIds.map(String) : []
          const content = String(req.body?.content || "").trim()
          if (!content) return res.status(400).json({ error: "说说内容不能为空" })
          if (content.length > CONTENT_MAX) return res.status(400).json({ error: `说说内容超过${CONTENT_MAX}字` })
          if (!botIds.length) return res.status(400).json({ error: "未选择机器人" })
          const results = []
          for (const qq of botIds) {
            const bot = globalThis.Bot?.bots?.[qq]
            if (typeof bot?.sendApi !== "function") {
              results.push({ qq, ok: false, error: "bot 当前不可用" })
              continue
            }
            try {
              const published = await publishShuoshuo(bot, content)
              results.push({ qq, ok: true, tid: published.tid })
            } catch (error) {
              results.push({ qq, ok: false, error: String(error?.message || error).slice(0, 200) })
            }
          }
          logger?.info?.(`[说说发布] bots=${botIds.join(",")} ok=${results.filter(item => item.ok).length}/${results.length}`)
          res.json({ results })
        } catch (error) {
          logger?.warn?.(`[说说发布] 接口异常: ${error?.message || error}`)
          res.status(500).json({ error: String(error?.message || error).slice(0, 200) })
        }
      })()
      return
    }
    next()
  })
  logger?.info?.("[说说发布] /bl-chat/qzone API 已挂载（控制台\"说说\"页调用）")
}
