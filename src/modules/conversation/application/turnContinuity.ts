import type {PersonaIdentity} from '../../../contracts/persona.js'

interface Store {get(key:string):Promise<unknown>;set(key:string,value:string,options:{EX:number}):Promise<unknown>}
export interface Continuity {intent:string;route:string;tools:string[];lastReply:string;at:number;botId?:string;persona?:PersonaIdentity}
interface Scope {redis?:Store|null;groupId?:string|number;userId?:string|number;botId?:string|number;persona?:PersonaIdentity}

function parsePersona(value: unknown): PersonaIdentity | null {
  if (!value || typeof value !== 'object') return null
  const identity = value as Record<string, unknown>
  if (typeof identity.personaId !== 'string' || !identity.personaId.trim()
    || typeof identity.personaVersion !== 'string' || !identity.personaVersion.trim()
    || typeof identity.personaName !== 'string') return null
  return {personaId: identity.personaId, personaVersion: identity.personaVersion, personaName: identity.personaName}
}

function parseRecord(value:unknown):Continuity|null {
 if(!value||typeof value!=='object')return null
 const r=value as Record<string,unknown>
 if(typeof r.at!=='number'||!Number.isFinite(r.at))return null
 const persona = r.persona === undefined ? undefined : parsePersona(r.persona)
 if(persona === null)return null
 return {intent:typeof r.intent==='string'?r.intent:'',route:typeof r.route==='string'?r.route:'',tools:Array.isArray(r.tools)?r.tools.filter((x):x is string=>typeof x==='string'):[],lastReply:typeof r.lastReply==='string'?r.lastReply:'',at:r.at,...(typeof r.botId==='string'?{botId:r.botId}:{}),...(persona ? {persona} : {})}
}
const TURN_CONTINUITY_TTL_MS = 10 * 60 * 1000
const KEY_PREFIX = "blchat:turn_continuity:"
const PERSONA_KEY_PREFIX = "blchat:turn_continuity_v2:"
const memoryFallback = new Map<string,Continuity>()

function scopeKey(groupId:string|number = "", userId:string|number = "", botId?:string|number, persona?:PersonaIdentity) {
  // A separate namespace prevents legacy writers from overwriting scoped records.
  // Tuple encoding keeps separators in group/user/persona identifiers unambiguous.
  if (persona) return `${PERSONA_KEY_PREFIX}${JSON.stringify([String(groupId), String(userId), botId === undefined ? null : String(botId), persona.personaId, persona.personaVersion])}`
  return `${KEY_PREFIX}${groupId}:${userId}${botId === undefined ? "" : `:${String(botId)}`}`
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
  botId,
  persona,
  intent = "",
  route = "",
  tools = [],
  lastReply = "",
  at = Date.now()
}:Scope & {intent?:string;route?:string;tools?:unknown[];lastReply?:string;at?:number} = {}) {
  const identity = persona === undefined ? undefined : parsePersona(persona)
  if (identity === null) throw new TypeError('Turn continuity requires a valid persona identity and version')
  const record = {
    intent: String(intent || "").slice(0, 40),
    route: String(route || "").slice(0, 20),
    tools: (Array.isArray(tools) ? tools : []).map(item => String(item || "").slice(0, 60)).slice(0, 6),
    lastReply: String(lastReply || "").slice(0, 240),
    at,
    ...(botId === undefined ? {} : { botId: String(botId) }),
    ...(identity ? {persona: identity} : {})
  }
  const key = scopeKey(groupId, userId, botId, identity)
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

export async function loadTurnContinuity({ redis:client = null, groupId = "", userId = "", botId, persona }:Scope = {}) {
  const identity = persona === undefined ? undefined : parsePersona(persona)
  if (identity === null) return null
  const key = scopeKey(groupId, userId, botId, identity)
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
  // A persona-scoped turn never borrows legacy speech or another revision's stance.
  // Legacy callers likewise cannot interpret scoped records as their own history.
  if (record?.botId !== (botId === undefined ? undefined : String(botId))) return null
  if (identity
    ? record?.persona?.personaId !== identity.personaId || record.persona.personaVersion !== identity.personaVersion
    : record?.persona !== undefined) return null
  if (!record || Number.isFinite(record.at) !== true || Date.now() - Number(record.at) > TURN_CONTINUITY_TTL_MS) return null
  return record
}

export function buildTurnContinuityPrompt(record:Continuity|null = null) {
  if (!record) return ""
  const lines = ["【上一轮任务摘要】（同一用户 10 分钟内）"]
  if (record.intent) lines.push(`- 上一轮意图：${record.intent}${record.route ? `（${record.route}）` : ""}`)
  if (record.tools?.length) lines.push(`- 已用工具：${record.tools.join("、")}`)
  else lines.push('- 执行证据：此摘要没有可确认的工具结果。上一轮接下任务或表示会处理不等于当前正在运行、已成功或已失败。')
  if (record.lastReply) lines.push(`- 你上一轮的回复（节选）：${record.lastReply}`)
  lines.push("用户接着说话时，先基于上一轮结果接续：已成功的工具不要重复执行，已失败的不要声称已完成；需要新信息再调用工具。发言记录不独立证明进度，缺结果时说明尚未确认，不补运行状态、失败原因或完成时间。")
  return lines.join("\n")
}
