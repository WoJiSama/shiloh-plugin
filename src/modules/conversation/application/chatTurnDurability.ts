function decodeSender(value:unknown):import('../../../contracts/chatEvent.js').ChatMember {const raw=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};const sender:import('../../../contracts/chatEvent.js').ChatMember={};if(typeof raw.user_id==='string'||typeof raw.user_id==='number')sender.user_id=raw.user_id;for(const key of ['card','nickname','role','title'] as const)if(typeof raw[key]==='string')sender[key]=raw[key];return sender}
interface Envelope {msg?:string;raw_message?:string;message?:unknown[];sender?:import('../../../contracts/chatEvent.js').ChatMember;user_id?:string|number|undefined;group_id?:string|number|undefined;message_id?:string|number|undefined;time?:number;self_id?:string|number;triggerContext?:{mode?:string}|null;turnStartedAt?:number}
interface Event extends Omit<Envelope,'message_id'> {message_id?:unknown;bot?:{uin?:string|number};_triggerContext?:{mode?:string};_replyClaimed?:boolean}
interface Store {set(key:string,value:string,options:{EX:number;NX?:boolean}):Promise<unknown>;get(key:string):Promise<unknown>;del(key:string):Promise<unknown>;scanIterator?(options:{MATCH:string}):AsyncIterable<unknown>}
interface Logger {warn?(message:string):void;info?(message:string):void;error?(message:string):void}
interface Config {enabled?:boolean;staleSeconds?:number;recoverDelayMs?:number;ttlSeconds?:number}
interface HostBot {uin?:string|number;pickGroup(id:string|number):{sendMsg(payload:unknown,quote?:boolean):Promise<unknown>}|null}
function errorMessage(error:unknown){return error instanceof Error?error.message:String(error)}
function parseEnvelope(value:unknown):Envelope|null {
 if(!value||typeof value!=='object')return null
 const r=value as Record<string,unknown>
 if(typeof r.group_id!=='string' && typeof r.group_id!=='number')return null
 const id=(v:unknown)=>typeof v==='string'||typeof v==='number'?v:undefined
 const trigger=r.triggerContext && typeof r.triggerContext==='object'?r.triggerContext as Record<string,unknown>:{}
 return {msg:typeof r.msg==='string'?r.msg:'',raw_message:typeof r.raw_message==='string'?r.raw_message:'',message:Array.isArray(r.message)?r.message:[],sender:decodeSender(r.sender),user_id:id(r.user_id),group_id:r.group_id,message_id:id(r.message_id),time:typeof r.time==='number'?r.time:0,self_id:id(r.self_id)||'',triggerContext:{mode:typeof trigger.mode==='string'?trigger.mode:''},turnStartedAt:typeof r.turnStartedAt==='number'?r.turnStartedAt:0}
}
export function createChatTurnDurabilityModule(ports:{getBot(selfId?:string|number):HostBot|null|undefined;getRedis():Store|null|undefined;logger?:Logger}) {
// 聊天回合持久化（P1 高可用）：
// 重启/崩溃时进行中的 AI 回合不再静默丢失——回合开始落 Redis 记录、回复发出即置幂等标记、
// 启动后按时效补跑未完成回合。与图片任务/媒体 outbox 的持久化互补，收口在 handleTool 与
// sendSegmentedMessage 两个单点。所有 Redis 操作失败一律放行（fail-open），绝不阻塞聊天。

const TURN_PREFIX = "ytbot:chat_turn:"
const REPLIED_PREFIX = "ytbot:chat_turn_replied:"
const DEFAULT_TTL_SECONDS = 600
const DEFAULT_STALE_SECONDS = 150
const DEFAULT_RECOVER_DELAY_MS = 30000

function fallbackHash(value = "") {
  let hash = 2166136261
  for (const ch of String(value)) {
    hash ^= ch.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function buildChatTurnKey(e:Event = {}) {
  const groupId = String(e?.group_id || "")
  if (!groupId) return ""
  const messageId = String(e?.message_id || "").trim()
  if (messageId && messageId !== "-1") return `${groupId}:${messageId}`
  const seed = `${e?.user_id || ""}|${typeof e?.msg === "string" ? e.msg : JSON.stringify(e?.message || "")}|${Number(e?.time) || 0}`
  return `${groupId}:h${fallbackHash(seed)}`
}

/** 只保留可 JSON 序列化的入站信封字段，供重启后重建事件 */
function serializeChatTurnEnvelope(e:Event = {}):Envelope {
  const message = Array.isArray(e?.message) ? e.message : [{ type: "text", data: { text: String(e?.msg || "") } }]
  return {
    msg: typeof e?.msg === "string" ? e.msg : String(e?.raw_message || ""),
    raw_message: String(e?.raw_message || e?.msg || ""),
    message,
    sender: e?.sender && typeof e.sender === "object" ? { ...e.sender } : { user_id: e?.user_id },
    user_id: e?.user_id,
    group_id: e?.group_id,
    message_id: typeof e?.message_id==='string'||typeof e?.message_id==='number'?e.message_id:undefined,
    time: Number(e?.time) || Math.floor(Date.now() / 1000),
    self_id: e?.self_id || e?.bot?.uin || "",
    triggerContext: e?._triggerContext || null
  }
}

function rebuildChatTurnEvent(envelope:Event = {}) {
  const bot = ports.getBot(envelope.self_id)
  const groupId = Number(envelope.group_id) || envelope.group_id
  if (!bot || typeof bot.pickGroup !== "function" || !groupId) return null
  const group = bot.pickGroup(groupId)
  if (!group || typeof group.sendMsg !== "function") return null
  const e = {
    ...envelope,
    message_type: "group",
    isGroup: true,
    isMaster: false,
    bot,
    group,
    _turnRecovery: true,
    ...(envelope.triggerContext ? {_triggerContext:envelope.triggerContext} : {}),
    reply: async (payload:unknown, quote?:boolean) => await group.sendMsg(payload, quote),
    runtime: undefined
  }

  return e
}

function createChatTurnDurability({ redis:redisSource = ports.getRedis, logger = ports.logger, getConfig }: {redis?:Store|(()=>Store|null|undefined);logger?:Logger;getConfig?:()=>Config} = {}) {
  let redisWarned = false
  const logWarn = (message:string) => {
    if (redisWarned) return
    redisWarned = true
    logger?.warn?.(`[回合持久化] ${message}（后续静默，功能自动降级为不持久化）`)
  }
  const options = () => {
    const raw = typeof getConfig === "function" ? (getConfig() || {}) : {}
    return {
      enabled: raw.enabled !== false,
      staleSeconds: Number(raw.staleSeconds) > 0 ? Number(raw.staleSeconds) : DEFAULT_STALE_SECONDS,
      recoverDelayMs: Number(raw.recoverDelayMs) >= 0 ? Number(raw.recoverDelayMs) : DEFAULT_RECOVER_DELAY_MS,
      ttlSeconds: Number(raw.ttlSeconds) > 0 ? Number(raw.ttlSeconds) : DEFAULT_TTL_SECONDS
    }
  }
  const client = () => {
    const instance = typeof redisSource === "function" ? redisSource() : redisSource
    return instance && typeof instance.set === "function" ? instance : null
  }

  /** 回合开始：写 pending 记录（媒体自动交付事件有独立 outbox 幂等，不重复纳入） */
  async function beginTurn(e:Event = {}) {
    const opts = options()
    if (!opts.enabled || !e?.group_id) return false
    if (e?._triggerContext?.mode === "auto_media") return false
    const key = buildChatTurnKey(e)
    if (!key) return false
    try {
      const envelope = serializeChatTurnEnvelope(e)
      envelope.turnStartedAt = Date.now()
      await client()?.set(`${TURN_PREFIX}${key}`, JSON.stringify(envelope), { EX: opts.ttlSeconds })
      return true
    } catch (error) {
      logWarn(`回合落盘失败: ${errorMessage(error)}`)
      return false
    }
  }

  /** 回合结束（无论是否发出回复）：删除 pending 记录 */
  async function completeTurn(e:Event = {}) {
    const key = buildChatTurnKey(e)
    if (!key || !options().enabled) return
    try {
      await client()?.del(`${TURN_PREFIX}${key}`)
    } catch (error) {
      logWarn(`回合清理失败: ${errorMessage(error)}`)
    }
  }

  /**
   * 出站幂等：本回合第一次真正发消息前认领；认领失败说明另一份执行已经发过，
   * 跳过发送防止重复回复。同一进程内后续分段发送放行（e._replyClaimed）。
   */
  async function claimReply(e:Event = {}) {
    if (!options().enabled) return { claimed: true }
    if (e?._replyClaimed) return { claimed: true }
    const key = buildChatTurnKey(e)
    if (!key) return { claimed: true }
    try {
      const result = await client()?.set(`${REPLIED_PREFIX}${key}`, "1", { NX: true, EX: options().ttlSeconds })
      if (result === null || result === false) return { claimed: false, key }
      e._replyClaimed = true
      return { claimed: true, key }
    } catch (error) {
      logWarn(`回复认领失败: ${errorMessage(error)}`)
      return { claimed: true }
    }
  }

  async function isReplied(key:string) {
    try {
      return Boolean(await client()?.get(`${REPLIED_PREFIX}${key}`))
    } catch {
      return false
    }
  }

  /** 启动恢复：补跑未完成且未回复、仍在时效内的回合；过期/已回复的清理掉 */
  async function recoverPending({ redispatch, now = Date.now() }: {redispatch?:(envelope:Envelope)=>Promise<unknown>;now?:number} = {}) {
    const opts = options()
    const counts = { redispatched: 0, stale: 0, replied: 0, invalid: 0 }
    if (typeof redispatch !== "function") return counts
    const instance = client()
    if (!instance || typeof instance.scanIterator !== "function") return counts
    try {
      const keys = []
      for await (const key of instance.scanIterator({ MATCH: `${TURN_PREFIX}*` })) keys.push(String(key))
      for (const fullKey of keys) {
        let envelope:Envelope|null = null
        try {
          const raw=await instance.get(fullKey)
          envelope = typeof raw === "string" ? parseEnvelope(JSON.parse(raw)) : null
        } catch { envelope = null }
        if (!envelope?.group_id) {
          counts.invalid += 1
          await instance.del(fullKey).catch(() => {})
          continue
        }
        const shortKey = fullKey.slice(TURN_PREFIX.length)
        if (await isReplied(shortKey)) {
          counts.replied += 1
          await instance.del(fullKey).catch(() => {})
          continue
        }
        const age = now - Number(envelope.turnStartedAt || 0)
        if (!Number.isFinite(age) || age > opts.staleSeconds * 1000) {
          counts.stale += 1
          logger?.info?.(`[回合持久化] 丢弃过期回合 group=${envelope.group_id} age=${Math.round(age / 1000)}s`)
          await instance.del(fullKey).catch(() => {})
          continue
        }
        counts.redispatched += 1
        await instance.del(fullKey).catch(() => {})
        try {
          await redispatch(envelope)
        } catch (error) {
          logger?.error?.(`[回合持久化] 补跑失败 group=${envelope.group_id}: ${errorMessage(error)}`)
        }
      }
      if (counts.redispatched || counts.stale || counts.replied || counts.invalid) {
        logger?.info?.(`[回合持久化] 启动恢复完成: 补跑 ${counts.redispatched}、过期丢弃 ${counts.stale}、已回复跳过 ${counts.replied}、无效 ${counts.invalid}`)
      }
      return counts
    } catch (error) {
      logWarn(`启动恢复失败: ${errorMessage(error)}`)
      return counts
    }
  }

  /** 停机前排空用：当前未完成回合数 */
  async function pendingTurnCount() {
    try {
      const instance = client()
      if (!instance || typeof instance.scanIterator !== "function") return 0
      let count = 0
      for await (const key of instance.scanIterator({ MATCH: `${TURN_PREFIX}*` })) {
        if (String(key).startsWith(TURN_PREFIX)) count += 1
      }
      return count
    } catch {
      return 0
    }
  }

  return { beginTurn, completeTurn, claimReply, recoverPending, pendingTurnCount, options }
}

return {buildChatTurnKey,serializeChatTurnEnvelope,rebuildChatTurnEvent,createChatTurnDurability}
}
