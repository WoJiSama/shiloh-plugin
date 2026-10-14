import type {RuleEvent,RuleMember,RuleActor,RuleState,RuleGroupState} from '../../../contracts/rulePack.js'
import crypto from "node:crypto"

const ROLE_LEVELS:Readonly<Record<string,number>> = Object.freeze({ player: 1, gm: 2, admin: 3, master: 4 })
const SELF_ALIASES = new Set(["self", "me", "我", "自己"])

function eventUserId(e:RuleEvent) {
  return String(e?.user_id || e?.sender?.user_id || "")
}

function memberDisplayName(member:RuleMember|undefined, fallback:unknown) {
  return String(member?.card || member?.nickname || fallback || "").trim()
}

const record=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'?value as Record<string,unknown>:{}
function member(value:unknown):RuleMember {const data=record(value),result:RuleMember={};for(const key of ['card','nickname','role'] as const){if(typeof data[key]==='string')result[key]=data[key]}return result}
function normalizeMemberMap(value:unknown):Map<string|number,RuleMember> {
 const entries:Iterable<[unknown,unknown]>=value instanceof Map?value:Object.entries(record(value))
 const result=new Map<string|number,RuleMember>()
 for(const [key,value]of entries)if(typeof key==='string'||typeof key==='number')result.set(key,member(value))
 return result
}

async function getMemberMap(e:RuleEvent) {
  try {
    return normalizeMemberMap(await e?.group?.getMemberMap?.())
  } catch {
    return new Map()
  }
}

export function ensureRuleGroupState(state:RuleState, groupId:unknown, packId:string):RuleGroupState {
 const gid=String(groupId||'');if(!gid)throw new Error('自定义团务只能在群聊中使用')
 state.groups||={};const group=state.groups[gid]||={};group.diceRuleSessions||={}
 const root=group.diceRuleSessions[packId]||={roles:{},npcs:{},group:{values:{}},session:{active:false,title:'',round:0,turn:0,phase:'idle',initiative:[],current:null},audit:[],privateDeliveries:[],sessions:[],campaigns:{},activeCampaignId:'',snapshots:[]}
 root.roles||={};root.npcs||={};root.group||={values:{}};root.group.values||={};root.session||={active:false,title:'',round:0,turn:0,phase:'idle',initiative:[],current:null};root.session.initiative||=[];root.audit||=[];root.privateDeliveries||=[];root.sessions||=[];root.campaigns||={};root.activeCampaignId||='';root.snapshots||=[]
 return root
}

export function getRulePermission(e:RuleEvent, ruleState:RuleGroupState) {
  if (e?.isMaster) return "master"
  if (["owner", "admin"].includes(e?.sender?.role||"")) return "admin"
  return ruleState?.roles?.[eventUserId(e)] === "gm" ? "gm" : "player"
}

export function requireRulePermission(e:RuleEvent, ruleState:RuleGroupState, required = "player") {
  const actual = getRulePermission(e, ruleState)
  if ((ROLE_LEVELS[actual] || 0) < (ROLE_LEVELS[required] || (ROLE_LEVELS.player||1))) {
    const labels:Record<string,string> = { player: "玩家", gm: "GM", admin: "群管理员", master: "主人" }
    throw new Error(`此操作需要${labels[required] || required}权限；你当前是${labels[actual] || actual}`)
  }
  return actual
}

export function actorStorageKey(actor:RuleActor) {
  return `${actor.kind}:${actor.id}`
}

export function selfActor(e:RuleEvent):RuleActor {
  const id = eventUserId(e)
  return {
    kind: "member",
    id,
    name: memberDisplayName(e?.sender, id),
    role: e?.sender?.role || "member",
    self: true
  }
}

function assertAllowed(actor:RuleActor, allowed:Set<string>) {
  const kind = actor.self ? "self" : actor.kind
  if (!allowed.has(kind)) throw new Error(`目标 ${actor.name || actor.id} 的类型 ${kind} 不在命令允许范围内`)
  return actor
}

async function resolveReplyActor(e:RuleEvent):Promise<RuleActor|null> {
  try {
    const reply = record(await e?.getReply?.())
    const id = String(reply?.user_id || record(reply?.sender).user_id || "")
    if (!id) return null
    if (id === eventUserId(e)) return selfActor(e)
    const members = await getMemberMap(e)
    const member = members.get(Number(id)) || members.get(String(id))
    if (!member) throw new Error("引用消息的发言者已不在当前群，不能作为团务目标")
    return { kind: "member", id, name: memberDisplayName(member, id), role: member?.role || "member", self: false }
  } catch {
    return null
  }
}

export async function resolveRuleActor(e:RuleEvent, raw:unknown, ruleState:RuleGroupState, allowedKinds:string[] = ["self"]) {
  const token = String(raw || "").trim()
  const allowed = new Set(allowedKinds?.length ? allowedKinds : ["self"])
  if (!token || SELF_ALIASES.has(token.toLowerCase())) return assertAllowed(selfActor(e), allowed)

  if (["reply", "回复"].includes(token.toLowerCase())) {
    const actor = await resolveReplyActor(e)
    if (!actor) throw new Error("引用消息中没有可识别的发言者")
    return assertAllowed(actor, allowed)
  }

  const cqId = token.match(/^\[CQ:at,[^\]]*qq=(\d+)[^\]]*\]$/i)?.[1]
  const mentionId = token.match(/^<@!?(\d+)>$/)?.[1]
  const qqId = token.match(/^(?:qq:)?(\d{5,20})$/i)?.[1]
  const memberId = cqId || mentionId || qqId
  if (memberId) {
    if (String(memberId) === eventUserId(e)) return assertAllowed(selfActor(e), allowed)
    const members = await getMemberMap(e)
    const member = members.get(Number(memberId)) || members.get(String(memberId))
    if (!member) throw new Error(`QQ ${memberId} 不在当前群，不能作为团务目标`)
    return assertAllowed({
      kind: "member",
      id: String(memberId),
      name: memberDisplayName(member, memberId),
      role: member?.role || "member",
      self: String(memberId) === eventUserId(e)
    }, allowed)
  }

  const npcToken = token.match(/^npc:(.+)$/i)?.[1] || token
  const npcEntry = Object.entries(ruleState?.npcs || {}).find(([id, npc]) => id === npcToken || npc?.name === npcToken)
  if (npcEntry) return assertAllowed({ kind: "npc", id: npcEntry[0], name: npcEntry[1].name || npcEntry[0], role: "npc", self: false }, allowed)

  const members = await getMemberMap(e)
  const matches = [...members.entries()].filter(([, member]) => [member?.card, member?.nickname].some(name => String(name || "").trim() === token))
  if (matches.length > 1) throw new Error(`群内有多个成员叫「${token}」，请改用 @ 或 qq:号码`)
  if (matches.length === 1) {
    const [id, member] = matches[0]!
    return assertAllowed({ kind: "member", id: String(id), name: memberDisplayName(member, id), role: member?.role || "member", self: String(id) === eventUserId(e) }, allowed)
  }
  throw new Error(`没有找到目标：${token}`)
}

export async function getRuleGmRecipients(e:RuleEvent, ruleState:RuleGroupState) {
  const members = await getMemberMap(e)
  const ids = new Set<string>()
  for (const [id, role] of Object.entries(ruleState?.roles || {})) {
    if (role !== "gm") continue
    if (members.has(Number(id)) || members.has(String(id))) ids.add(String(id))
  }
  for (const [id, member] of members) if (["owner", "admin"].includes(member?.role||"")) ids.add(String(id))
  if (["owner", "admin"].includes(e?.sender?.role||"")) ids.add(eventUserId(e))
  return [...ids].filter(Boolean)
}

export function createRuleRandom(externalRandom:(()=>number)|null = null) {
  if (typeof externalRandom === "function") return { seed: "external", random: externalRandom }
  const seed = crypto.randomBytes(16).toString("hex")
  let counter = 0
  return {
    seed,
    random: () => {
      const digest = crypto.createHash("sha256").update(`${seed}:${counter++}`).digest()
      return digest.readUInt32BE(0) / 0x100000000
    }
  }
}

export function newAuditId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(5).toString("hex")}`
}

export function sanitizeAuditValue(value:unknown, depth = 0):unknown {
  if (depth > 5) return "[depth-limit]"
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value
  if (Array.isArray(value)) return value.slice(0, 50).map(item => sanitizeAuditValue(item, depth + 1))
  if (!value || typeof value !== "object") return String(value)
  const result:Record<string,unknown> = {}
  for (const [key, item] of Object.entries(value).slice(0, 100)) result[key] = sanitizeAuditValue(item, depth + 1)
  return result
}

export function roleLabel(role:string) {
  const labels:Record<string,string>={player:"玩家",gm:"GM",admin:"群管理员",master:"主人"};return labels[role]||role
}
