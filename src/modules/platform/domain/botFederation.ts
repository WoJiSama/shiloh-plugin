interface FederationEvent {self_id?:unknown;bot?:{uin?:unknown};group_id?:unknown;message?:{type?:string;qq?:unknown;data?:{qq?:unknown}}[]}
export function createBotFederation(ports:{botId():unknown;now():number}) {
// bot 联邦:多账号同群共存的协调层。
// 职责:
//   1) 在线 bot 发现:每个收到事件的 self_id 打心跳(redis zset,10 分钟窗口);
//   2) 群责任选主:@ 优先,否则对(群号+在线bot列表)稳定哈希——
//      数据类行为(归档/统计/表情收集/媒体搬运/记忆提取/指令)每群只有责任 bot 执行,
//      被喊名/@ 的 AI 对话不受限(星彩在希洛主责的群里被喊星彩照样回);
//   3) 自家 bot 互判:来自自家其他账号的消息不算普通群友消息。
// 单 bot 部署下 onlineBots 恒为 1,所有判定退化为 true,零行为变化。
const ONLINE_WINDOW_MS = 10 * 60 * 1000
// 在线发现走进程内 Map:所有适配器共享同一个 Yunzai 进程,模块级状态即全局;
// 不依赖 globalThis.redis 的具体 API 形态(教训:Yunzai 的 redis 封装没有 zadd,
// 心跳抛异常炸掉了整个消息监听)。任何情况下绝不向上抛。
const onlineMap = new Map<string,number>()

function markBotOnline(selfId:unknown = "") {
  try {
    const qq = String(selfId || "").trim()
    if (!qq || !/^\d{4,12}$/.test(qq)) return
    onlineMap.set(qq, ports.now())
  } catch {}
}

async function onlineBotList() {
  const now = ports.now()
  for (const [qq, at] of onlineMap) {
    if (now - at > ONLINE_WINDOW_MS) onlineMap.delete(qq)
  }
  return [...onlineMap.keys()].sort()
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
async function isResponsibleBot({ groupId = "", selfId = "", atBotQqs = [], knownBots }: {groupId?:unknown;selfId?:unknown;atBotQqs?:unknown[];knownBots?:string[]}) {
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
async function isFederationSibling(selfId:unknown = "", userId:unknown = "") {
  const me = String(selfId || "").trim()
  const who = String(userId || "").trim()
  if (!who || who === me) return false
  const bots = await onlineBotList()
  return bots.includes(who) && bots.length > 1
}

// 指令守卫:多 bot 同群时指令类功能只由责任 bot 执行。
// 用法:插件指令方法开头 `if (!(await assertSoleResponsible(e))) return true`
async function assertSoleResponsible(e:FederationEvent = {}) {
  try {
    const me = String(e?.self_id || e?.bot?.uin || ports.botId() || "")
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

return {markBotOnline,onlineBotList,isResponsibleBot,isFederationSibling,assertSoleResponsible}
}
