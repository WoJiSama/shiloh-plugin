// 违禁词黑名单:命中后立即中断该群当前对话。
// 语义:
// - 入口:任一群消息命中违禁词 → 记一次"会话中断"标记,本条不回复(或回固定提示语),
//   并取消 smart 模式排队中的续话/延迟触发;
// - 中断:回合入口给事件打锚点(_forbiddenAnchorAt=当前中断时间戳),出站咽喉点
//   (sendSegmentedMessage/sendObservedReply)发现"中断发生晚于锚点"即丢弃后续发送——
//   进行中的模型调用/工具回合会跑完,但结果不再发出,群视角=对话被立刻掐断;
// - 出站兜底:机器人自己要说的话含违禁词时拦截该条并同样中断(blockOutput)。
// 未打锚点的事件(如普通指令回复)不受中断影响,不会被永久误杀。
const interruptedAtByGroup = new Map() // groupId -> 中断时间戳

// 词表编译缓存:配置热更新换 words 数组引用即自动失效
let compiledCache = null
let compiledSource = null

export function compileForbiddenWords(cfg = {}) {
  const words = Array.isArray(cfg?.words) ? cfg.words : []
  if (compiledCache && compiledSource === words) return compiledCache
  const plains = []
  const regexes = []
  for (const raw of words) {
    const text = String(raw ?? "").trim()
    if (!text) continue
    if (text.length > 2 && text.startsWith("/") && text.endsWith("/")) {
      try {
        const lastSlash = text.lastIndexOf("/")
        regexes.push({ source: text, re: new RegExp(text.slice(1, lastSlash), text.slice(lastSlash + 1).replace(/[^gimsuy]/g, "")) })
      } catch {
        globalThis.logger?.warn?.(`[违禁词] 正则无效,按普通词处理: ${text}`)
        plains.push(text.toLowerCase())
      }
    } else {
      plains.push(text.toLowerCase())
    }
  }
  compiledCache = { plains, regexes }
  compiledSource = words
  return compiledCache
}

// 命中返回命中词原文(用于日志),未命中返回 null;大小写不敏感
export function findForbiddenWord(text, cfg = {}) {
  if (cfg?.enabled === false) return null
  const haystack = String(text || "")
  if (!haystack) return null
  const { plains, regexes } = compileForbiddenWords(cfg)
  const lower = haystack.toLowerCase()
  for (const word of plains) {
    if (word && lower.includes(word)) return word
  }
  for (const { source, re } of regexes) {
    if (re.test(haystack)) return source
  }
  return null
}

// —— 会话中断状态 ——

export function markConversationInterrupted(groupId) {
  const key = String(groupId ?? "")
  if (!key) return 0
  // 单调递增:同毫秒内连续两次中断也要严格变大,锚点比较(at > anchor)才不会漏判
  const ts = Math.max(Date.now(), (interruptedAtByGroup.get(key) || 0) + 1)
  interruptedAtByGroup.set(key, ts)
  return ts
}

export function getConversationInterruptedAt(groupId) {
  return interruptedAtByGroup.get(String(groupId ?? "")) || 0
}

// 回合入口打锚点:只打一次,内部 handleTool 复用外层锚点,不因二次进入而复活已中断回合
export function anchorEventConversation(e) {
  if (!e || e._forbiddenAnchorAt !== undefined) return e
  e._forbiddenAnchorAt = getConversationInterruptedAt(e.group_id)
  return e
}

// 中断是否晚于该回合锚点:晚于 → 本回合作废;未打锚点的事件(指令回复等)不受影响
export function isConversationInterrupted(e = {}) {
  if (e?._forbiddenAnchorAt === undefined) return false
  const at = getConversationInterruptedAt(e?.group_id)
  return at > 0 && at > e._forbiddenAnchorAt
}

// —— 出站文本提取 ——

// reply 载荷可能是字符串、CQ 段数组或对象;只提取可判定的文本部分
export function extractReplyText(payload) {
  if (payload == null) return ""
  if (typeof payload === "string") return payload
  if (Array.isArray(payload)) {
    return payload
      .map(seg => (typeof seg === "string" ? seg : (seg?.type === "text" ? String(seg?.data || seg?.text || "") : "")))
      .filter(Boolean)
      .join(" ")
  }
  if (typeof payload === "object") {
    return String(payload?.text || payload?.content || "")
  }
  return ""
}
