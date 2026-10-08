// bot 联邦:多账号同群共存的协调层。
// 职责:
//   1) 在线 bot 发现:每个收到事件的 self_id 打心跳(redis zset,10 分钟窗口);
//   2) 群责任选主:@ 优先,否则对(群号+在线bot列表)稳定哈希——
//      数据类行为(归档/统计/表情收集/媒体搬运/记忆提取/指令)每群只有责任 bot 执行,
//      被喊名/@ 的 AI 对话不受限(星彩在希洛主责的群里被喊星彩照样回);
//   3) 自家 bot 互判:来自自家其他账号的消息不算普通群友消息。
// 单 bot 部署下 onlineBots 恒为 1,所有判定退化为 true,零行为变化。
const ONLINE_KEY = "shiloh:bots:online"
const ONLINE_WINDOW_MS = 10 * 60 * 1000
let onlineCache = { at: 0, list: [] }

function getRedis() {
  return globalThis.redis
}

export function markBotOnline(selfId = "") {
  const qq = String(selfId || "").trim()
  if (!qq || !/^\d{4,12}$/.test(qq)) return
  const store = getRedis()
  if (!store) {
    if (!onlineCache.localSet) onlineCache.localSet = new Set()
    onlineCache.localSet.add(qq)
    onlineCache.at = Date.now()
    return
  }
  store.zadd(ONLINE_KEY, Date.now(), qq).catch(() => {})
}

export async function onlineBotList() {
  const now = Date.now()
  if (now - onlineCache.at < 30000 && onlineCache.list.length) return onlineCache.list
  const store = getRedis()
  let list = []
  if (store) {
    try {
      const members = await store.zrangebyscore(ONLINE_KEY, now - ONLINE_WINDOW_MS, "+inf")
      list = (members || []).map(s => String(s).trim()).filter(qq => /^\d{4,12}$/.test(qq))
      await store.zremrangebyscore(ONLINE_KEY, "-inf", now - ONLINE_WINDOW_MS * 3).catch(() => {})
    } catch {}
  }
  if (onlineCache.localSet) {
    for (const qq of onlineCache.localSet) if (!list.includes(qq)) list.push(qq)
  }
  list = [...new Set(list)].sort()
  onlineCache = { at: now, list, localSet: onlineCache.localSet }
  return list
}

// 稳定字符串哈希(FNV-1a):同输入恒同输出,保证每群选主稳定
function stableHash(text = "") {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

/**
 * 该事件的责任判定。
 * @param {object} params
 * @param {string} params.groupId 群号(空=私聊,私聊恒由收到事件的 bot 负责)
 * @param {string} params.selfId 当前处理事件的 bot QQ
 * @param {string[]} params.atBotQqs 消息里 @ 的自家 bot QQ 列表(可为空)
 * @param {string[]} [params.knownBots] 已知在线 bot(不传则现查,建议调用方先查好复用)
 */
export async function isResponsibleBot({ groupId = "", selfId = "", atBotQqs = [], knownBots }) {
  const me = String(selfId || "").trim()
  if (!me) return true
  if (!groupId) return true // 私聊:谁收到谁负责
  const ats = (atBotQqs || []).map(q => String(q).trim()).filter(Boolean)
  if (ats.length) return ats.includes(me) // @了谁谁负责(包括@别人→自己让位)
  const bots = knownBots || await onlineBotList()
  if (!bots.length || bots.length <= 1) return true
  if (!bots.includes(me)) return true // 未登记的账号(如刚上线):保守放行
  const leader = bots[stableHash(`${groupId}:${bots.join(",")}`) % bots.length]
  return leader === me
}

/** 判断 userId 是否自家其他在线 bot(其消息不作为普通群友消息处理) */
export async function isFederationSibling(selfId = "", userId = "") {
  const me = String(selfId || "").trim()
  const who = String(userId || "").trim()
  if (!who || who === me) return false
  const bots = await onlineBotList()
  return bots.includes(who) && bots.length > 1
}

// 指令守卫:多 bot 同群时指令类功能只由责任 bot 执行。
// 用法:插件指令方法开头 `if (!(await assertSoleResponsible(e))) return true`
export async function assertSoleResponsible(e = {}) {
  try {
    const me = String(e?.self_id || e?.bot?.uin || globalThis.Bot?.uin || "")
    if (!me) return true
    const groupId = String(e?.group_id || "")
    if (!groupId) return true
    const bots = await onlineBotList()
    if (bots.length <= 1) return true
    const atBotQqs = []
    for (const segment of Array.isArray(e?.message) ? e.message : []) {
      if (segment?.type !== "at") continue
      const qq = String(segment?.qq ?? segment?.data?.qq ?? "").trim()
      if (qq && bots.includes(qq)) atBotQqs.push(qq)
    }
    return await isResponsibleBot({ groupId, selfId: me, atBotQqs, knownBots: bots })
  } catch {
    return true
  }
}
