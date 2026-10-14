interface Store {get(key:string):Promise<unknown>;set(key:string,value:string,options:{EX:number}):Promise<unknown>}
interface Continuity {intent:string;route:string;tools:string[];lastReply:string;at:number}
interface Scope {redis?:Store|null;groupId?:string|number;userId?:string|number}
function parseRecord(value:unknown):Continuity|null {
 if(!value||typeof value!=='object')return null
 const r=value as Record<string,unknown>
 if(typeof r.at!=='number'||!Number.isFinite(r.at))return null
 return {intent:typeof r.intent==='string'?r.intent:'',route:typeof r.route==='string'?r.route:'',tools:Array.isArray(r.tools)?r.tools.filter((x):x is string=>typeof x==='string'):[],lastReply:typeof r.lastReply==='string'?r.lastReply:'',at:r.at}
}
const TURN_CONTINUITY_TTL_MS = 10 * 60 * 1000
const KEY_PREFIX = "blchat:turn_continuity:"
const memoryFallback = new Map<string,Continuity>()

function scopeKey(groupId:string|number = "", userId:string|number = "") {
  return `${KEY_PREFIX}${groupId}:${userId}`
}

function isRedisLike(store:Store|null) {
  return store && typeof store.get === "function" && typeof store.set === "function"
}

/**
 * 跨轮任务延续：handleTool 的会话是一次性的（轮末即销毁），上一轮工具做过什么、
 * 最后回了什么只能靠这里留下的有界摘要。目的：续聊不再反复认图、反复确认、
 * 忘记上一轮工具做到哪。优先 Redis（跨进程/重启），无 Redis 时退化为进程内 Map。
 */
export async function recordTurnContinuity({
  redis:client = null,
  groupId = "",
  userId = "",
  intent = "",
  route = "",
  tools = [],
  lastReply = "",
  at = Date.now()
}:Scope & {intent?:string;route?:string;tools?:unknown[];lastReply?:string;at?:number} = {}) {
  const record = {
    intent: String(intent || "").slice(0, 40),
    route: String(route || "").slice(0, 20),
    tools: (Array.isArray(tools) ? tools : []).map(item => String(item || "").slice(0, 60)).slice(0, 6),
    lastReply: String(lastReply || "").slice(0, 240),
    at
  }
  const key = scopeKey(groupId, userId)
  memoryFallback.set(key, record)
  const store = isRedisLike(client) ? client : null
  if (!store) return record
  try {
    await store.set(key, JSON.stringify(record), { EX: Math.ceil(TURN_CONTINUITY_TTL_MS / 1000) })
  } catch {
    // Redis 写失败不影响本轮回复，进程内记录仍然有效
  }
  return record
}

export async function loadTurnContinuity({ redis:client = null, groupId = "", userId = "" }:Scope = {}) {
  const key = scopeKey(groupId, userId)
  let record:Continuity|null = null
  const store = isRedisLike(client) ? client : null
  if (store) {
    try {
      const raw = await store.get(key)
      if (typeof raw === "string") record = parseRecord(JSON.parse(raw))
    } catch {
      record = null
    }
  }
  if (!record) record = memoryFallback.get(key) || null
  if (!record || Number.isFinite(record.at) !== true || Date.now() - Number(record.at) > TURN_CONTINUITY_TTL_MS) return null
  return record
}

export function buildTurnContinuityPrompt(record:Continuity|null = null) {
  if (!record) return ""
  const lines = ["【上一轮任务摘要】（同一用户 10 分钟内）"]
  if (record.intent) lines.push(`- 上一轮意图：${record.intent}${record.route ? `（${record.route}）` : ""}`)
  if (record.tools?.length) lines.push(`- 已用工具：${record.tools.join("、")}`)
  if (record.lastReply) lines.push(`- 你上一轮的回复（节选）：${record.lastReply}`)
  lines.push("用户接着说话时，先基于上一轮结果接续：已成功的工具不要重复执行，已失败的不要声称已完成；需要新信息再调用工具。")
  return lines.join("\n")
}
