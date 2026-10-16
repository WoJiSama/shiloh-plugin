import {isDrawTaskStatusInquiry} from '../domain/messageIntent.js'
import {randomUUID} from 'node:crypto'
import type {ActionFactScope,ActionFactsEvent,ActionFactsQuery,TurnActionFacts,TurnTaskFact} from '../../../contracts/turnActionFacts.js'
type Id=string|number|null|undefined
export interface TaskStatus {groupId?:string;userId?:string;messageId?:string;status:string;toolName:string;error?:string;updatedAt?:number;requesterName?:string;detail?:string;scopeKey?:string;startedAt?:number;actionFacts?:TurnTaskFact}
export interface StatusInput {groupId?:Id;userId?:Id;messageId?:Id;status:string;toolName?:string;error?:unknown;requesterName?:string;detail?:string;scopeKey?:string;event?:ActionFactsEvent;actionFacts?:TurnTaskFact}
export interface Event extends ActionFactsEvent {message_type?:string;reply_id?:unknown;_quotedPromptContext?:{messageId?:unknown}}
export interface TaskStatusHost {TASK_STATUS_PREFIX:string;ACTIVE_TOOL_TASK_PREFIX:string;config:{groupChatMemoryDays?:number;longRunningToolStaleMinutes?:number};getTaskStatusCacheKey(groupId:Id,messageId:Id):string;getTaskStatusRedisKey(groupId:Id,messageId:Id):string;getActiveToolTaskCacheKey(groupId:Id,userId:Id,toolName:string):string;getActiveToolTaskRedisKey(groupId:Id,userId:Id,toolName:string):string;getTaskStatusTtlSeconds():number;getToolRunKey(groupId:Id,userId:Id,toolName:string):string;getRuntimeToolTaskStatus(groupId:Id,userId:Id,toolName:string):TaskStatus|null;getUserToolTaskStatus(groupId:Id,userId:Id,toolName:string):Promise<TaskStatus|null|undefined>;getCurrentUserToolTaskStatus(groupId:Id,userId:Id,toolName:string):Promise<TaskStatus|null|undefined>;getTurnActionFacts(e:ActionFactsEvent,query?:ActionFactsQuery):Promise<TurnActionFacts>;messageManager?:{getMessages(type:string|undefined,id:Id):Promise<{message_id?:unknown;sender?:{user_id?:Id}}[]>};buildReplySegment(messageId:Id):unknown;buildTaskStatusReplyMessage(status:TaskStatus,text:string):unknown;buildDrawTaskStatusReply(status:TaskStatus):string;sendObservedReply(e:Event,payload:unknown):Promise<unknown>}
function parseStatus(value:unknown):TaskStatus|null {if(!value||typeof value!=='object')return null;const r=value as Record<string,unknown>;if(typeof r.status!=='string'||typeof r.toolName!=='string')return null;const result:TaskStatus={status:r.status,toolName:r.toolName};for(const key of ['groupId','userId','messageId','error','requesterName','detail','scopeKey'] as const)if(typeof r[key]==='string')result[key]=r[key];for(const key of ['updatedAt','startedAt'] as const)if(typeof r[key]==='number'&&Number.isFinite(r[key]))result[key]=r[key];return result}
function errorMessage(e:unknown){return e instanceof Error?e.message:String(e)}
export function createTaskStatus(ports:{store():{set(key:string,value:string,options:{EX:number}):Promise<unknown>;get(key:string):Promise<unknown>;del(key:string):Promise<unknown>};logger:{warn(message:string):void;info(message:string):void};activeDedupeToolRuns:Map<string,{startedAt?:number;[key:string]:unknown}>;replySegment?(id:Id):unknown}) {
const {logger,activeDedupeToolRuns}=ports
// 工具任务状态:任务/绘图进度查询的 Redis 持久化与运行时缓存、状态回复文案。
// 从 apps/test.js 原样迁出(行为不变),this 依赖以 host 注入。

const TASK_STATUS_REDIS_TIMEOUT_MS = 2000
const runtimeId = randomUUID()
const factWrites = new Map<string,Promise<unknown>>()
const runtimeFacts = new Map<string,{fact:TurnTaskFact;expiresAt:number}>()
const MAX_FACT_REQUESTS = 12
const MAX_CACHE_ENTRIES = 512
interface ScopedFactRecord {version:1;scope:ActionFactScope;requestMessageId:string;updatedAt:number;expiresAt:number;tasks:{fact:TurnTaskFact;runtimeId:string}[]}
function record(value:unknown):Record<string,unknown>{return value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}}
function factScope(e:ActionFactsEvent):ActionFactScope {
  const botId=String(e.self_id||e.bot?.uin||''),userId=String(e.user_id||'')
  return {botId,userId,conversationId:e.group_id?`group:${e.group_id}`:userId?`private:${userId}`:''}
}
function validScope(scope:ActionFactScope){return Boolean(scope.botId&&scope.userId&&scope.conversationId)}
function sameScope(a:ActionFactScope,b:ActionFactScope){return a.botId===b.botId&&a.conversationId===b.conversationId&&a.userId===b.userId}
function factKey(host:TaskStatusHost,scope:ActionFactScope,messageId:string){return `${host.TASK_STATUS_PREFIX}v2:${[scope.botId,scope.conversationId,scope.userId,messageId].map(encodeURIComponent).join(':')}`}
function parseFact(value:unknown):TurnTaskFact|null {
  const r=record(value),delivery=record(r.delivery),followUp=record(r.followUp)
  if(typeof r.taskId!=='string'||!r.taskId||typeof r.requestMessageId!=='string'||!r.requestMessageId||typeof r.toolName!=='string'||!r.toolName||!['task_record','live_job'].includes(String(r.source))||typeof r.observedAt!=='number'||!Number.isFinite(r.observedAt)||!['queued','running','completed','failed','unknown'].includes(String(r.execution))||!['available','unavailable','unknown'].includes(String(r.result))||!['not_attempted','sent','failed','unknown'].includes(String(delivery.state)))return null
  if(delivery.state==='sent'&&(typeof delivery.messageId!=='string'||!delivery.messageId))return null
  if(!['none','unknown'].includes(String(followUp.state)))return null
  return {taskId:r.taskId,requestMessageId:r.requestMessageId,toolName:r.toolName,source:r.source as TurnTaskFact['source'],observedAt:r.observedAt,execution:r.execution as TurnTaskFact['execution'],result:r.result as TurnTaskFact['result'],delivery:{state:delivery.state as TurnTaskFact['delivery']['state'],...(delivery.state==='sent'?{messageId:String(delivery.messageId)}:{})},followUp:{state:followUp.state as 'none'|'unknown'}}
}
function parseScopedRecord(value:unknown,scope:ActionFactScope,messageId:string):ScopedFactRecord|null {
  const r=record(value),s=record(r.scope)
  if(r.version!==1||s.botId!==scope.botId||s.conversationId!==scope.conversationId||s.userId!==scope.userId||r.requestMessageId!==messageId||typeof r.updatedAt!=='number'||typeof r.expiresAt!=='number'||!Number.isFinite(r.expiresAt)||!Array.isArray(r.tasks))return null
  const tasks:ScopedFactRecord['tasks']=[]
  for(const row of r.tasks){const entry=record(row),fact=parseFact(entry.fact);if(!fact||fact.requestMessageId!==messageId||typeof entry.runtimeId!=='string')return null;tasks.push({fact,runtimeId:entry.runtimeId})}
  return {version:1,scope,requestMessageId:messageId,updatedAt:r.updatedAt,expiresAt:r.expiresAt,tasks}
}
async function readFactRecord(host:TaskStatusHost,scope:ActionFactScope,messageId:string) {
  const unavailable=Symbol('unavailable')
  const raw=await settleTaskStatusRedis(ports.store().get(factKey(host,scope,messageId)),unavailable,'读取动作事实')
  if(raw===unavailable)return {available:false,value:null}
  if(raw===null||raw===undefined||raw==='')return {available:true,value:null}
  if(typeof raw!=='string')return {available:false,value:null}
  try{const value=parseScopedRecord(JSON.parse(raw),scope,messageId);return {available:Boolean(value),value}}catch{return {available:false,value:null}}
}
async function saveActionFacts(host:TaskStatusHost,input:StatusInput) {
  if(!input.event||!input.actionFacts)return
  const scope=factScope(input.event),fact=parseFact(input.actionFacts),messageId=String(input.messageId||input.event.message_id||'')
  if(!validScope(scope)||!fact||fact.requestMessageId!==messageId)return
  const key=factKey(host,scope,messageId),previousWrite=factWrites.get(key)
  const runtimeKey=`${key}:${encodeURIComponent(fact.toolName)}`,known=runtimeFacts.get(runtimeKey)
  if(!known||known.expiresAt<=Date.now()||known.fact.source!=='live_job'||fact.source==='live_job'){
    if(runtimeFacts.size>=MAX_CACHE_ENTRIES)runtimeFacts.delete(runtimeFacts.keys().next().value||'')
    runtimeFacts.set(runtimeKey,{fact,expiresAt:Date.now()+Math.max(60,Math.min(86400,host.getTaskStatusTtlSeconds()))*1000})
  }
  const work=(async()=>{
    await previousWrite?.catch(()=>{})
    const read=await readFactRecord(host,scope,messageId),now=Date.now()
    // An unreadable record cannot be safely overwritten with less complete facts.
    if(!read.available)return
    const previous=read.value&&read.value.expiresAt>now?read.value:null
    const existing=previous?.tasks.find(entry=>entry.fact.toolName===fact.toolName)
    // The concrete image job owns its result/delivery state. A tool call returning
    // "queued" or a success string must not replace those lifecycle facts.
    if(existing?.fact.source==='live_job'&&fact.source==='task_record')return
    const tasks=(previous?.tasks||[]).filter(entry=>entry.fact.toolName!==fact.toolName)
    tasks.push({fact,runtimeId})
    const ttl=Math.max(60,Math.min(86400,host.getTaskStatusTtlSeconds()))
    const value:ScopedFactRecord={version:1,scope,requestMessageId:messageId,updatedAt:now,expiresAt:now+ttl*1000,tasks}
    await settleTaskStatusRedis(ports.store().set(key,JSON.stringify(value),{EX:ttl}),undefined,'写入动作事实')
  })()
  factWrites.set(key,work)
  try{await work}finally{if(factWrites.get(key)===work)factWrites.delete(key)}
}
async function getTurnActionFacts(host:TaskStatusHost,e:ActionFactsEvent,query:ActionFactsQuery={}):Promise<TurnActionFacts> {
  const scope=factScope(e),now=Date.now(),output:TurnActionFacts={scope,observedAt:now,lookup:validScope(scope)?'ok':'unavailable',tasks:[]}
  if(!validScope(scope))return output
  const reference=String(query.referenceMessageId||'').trim()
  const ids=[...new Set([...(reference?[reference]:[]),...(query.recentRequestMessageIds||[])])].filter(id=>typeof id==='string'&&Boolean(id)).slice(0,MAX_FACT_REQUESTS)
  const reads=await Promise.all(ids.map(async id=>({id,...await readFactRecord(host,scope,id)})))
  const activeTtl=Math.max(60000,(Number(host.config.longRunningToolStaleMinutes)||8)*60000)
  for(const read of reads){
    if(!read.available){output.lookup='unavailable';continue}
    if(!read.value||!sameScope(read.value.scope,scope)||read.value.expiresAt<=now)continue
    for(const {fact,runtimeId:owner} of read.value.tasks){
      if(reference&&fact.requestMessageId!==reference&&!(fact.delivery.state==='sent'&&fact.delivery.messageId===reference))continue
      if(fact.observedAt>now+5000)continue
      const active=['queued','running'].includes(fact.execution)
      const live=runtimeFacts.get(`${factKey(host,scope,read.id)}:${encodeURIComponent(fact.toolName)}`)
      const stale=active&&(owner!==runtimeId||now-fact.observedAt>activeTtl||!live||live.expiresAt<=now||live.fact.taskId!==fact.taskId||!['queued','running'].includes(live.fact.execution))
      output.tasks.push(stale?{...fact,execution:'unknown',followUp:{state:'unknown'}}:fact)
    }
  }
  output.tasks.sort((a,b)=>b.observedAt-a.observedAt)
  return output
}



const activeUserToolTaskCache = new Map<string,TaskStatus>()

async function settleTaskStatusRedis<T,F>(promise:Promise<T>, fallback:F, label:string) {
  let timer:ReturnType<typeof setTimeout>|null = null
  const timeout = new Promise<F>(resolve => {
    timer = setTimeout(() => resolve(fallback), TASK_STATUS_REDIS_TIMEOUT_MS)
  })
  try {
    return await Promise.race([promise, timeout])
  } catch (error) {
    logger.warn(`[任务状态] ${label}失败：${errorMessage(error)}`)
    return fallback
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const taskStatusCache = new Map<string,TaskStatus>()
function getTaskStatusCacheKey(host:TaskStatusHost, groupId:Id, messageId:Id) {
    return `${groupId}:${messageId}`
}

function getTaskStatusRedisKey(host:TaskStatusHost, groupId:Id, messageId:Id) {
    return `${host.TASK_STATUS_PREFIX}${groupId}:${messageId}`
}

function getActiveToolTaskCacheKey(host:TaskStatusHost, groupId:Id, userId:Id, toolName:string) {
    return `${groupId}:${userId}:${toolName}`
}

function getActiveToolTaskRedisKey(host:TaskStatusHost, groupId:Id, userId:Id, toolName:string) {
    return `${host.ACTIVE_TOOL_TASK_PREFIX}${groupId}:${userId}:${toolName}`
}

function getTaskStatusTtlSeconds(host:TaskStatusHost) {
    return Math.max(60, Math.floor((host.config.groupChatMemoryDays || 1) * 24 * 60 * 60))
}

async function saveTaskStatus(host:TaskStatusHost, input:StatusInput) {
    await saveActionFacts(host,input)
    const { groupId, userId, messageId, status, toolName = "", error = "" }=input
    if (!groupId || !messageId || !status) return

    const record = {
      groupId: String(groupId),
      userId: userId ? String(userId) : "",
      messageId: String(messageId),
      status,
      toolName,
      error: error ? String(error).slice(0, 120) : "",
      updatedAt: Date.now()
    }
    const cacheKey = host.getTaskStatusCacheKey(groupId, messageId)
    if(taskStatusCache.size>=MAX_CACHE_ENTRIES)taskStatusCache.delete(taskStatusCache.keys().next().value||'')
    taskStatusCache.set(cacheKey, record)

    await settleTaskStatusRedis(
      ports.store().set(host.getTaskStatusRedisKey(groupId, messageId), JSON.stringify(record), {
        EX: host.getTaskStatusTtlSeconds()
      }),
      undefined,
      "写入"
    )
}

async function getTaskStatus(host:TaskStatusHost, groupId:Id, messageId:Id) {
    if (!groupId || !messageId) return null

    const cacheKey = host.getTaskStatusCacheKey(groupId, messageId)
    const cached=taskStatusCache.get(cacheKey)
    if(cached&&Date.now()-Number(cached.updatedAt||0)<host.getTaskStatusTtlSeconds()*1000)return cached
    taskStatusCache.delete(cacheKey)

    const raw = await settleTaskStatusRedis(
      ports.store().get(host.getTaskStatusRedisKey(groupId, messageId)),
      null,
      "读取"
    )
    if (typeof raw !== "string" || !raw) return null
    try {
      const record = parseStatus(JSON.parse(raw))
      if(!record)return null
      if(Date.now()-Number(record.updatedAt||0)>=host.getTaskStatusTtlSeconds()*1000)return null
      if(taskStatusCache.size>=MAX_CACHE_ENTRIES)taskStatusCache.delete(taskStatusCache.keys().next().value||'')
      taskStatusCache.set(cacheKey, record)
      return record
    } catch (error) {
      logger.warn(`[任务状态] 解析失败：${errorMessage(error)}`)
      return null
    }
}

async function clearTaskStatus(host:TaskStatusHost, groupId:Id, messageId:Id) {
    if (!groupId || !messageId) return
    taskStatusCache.delete(host.getTaskStatusCacheKey(groupId, messageId))
    await settleTaskStatusRedis(
      ports.store().del(host.getTaskStatusRedisKey(groupId, messageId)),
      undefined,
      "清理"
    )
}

async function updateUserToolTaskStatus(host:TaskStatusHost, { groupId, userId, messageId = "", toolName, status, requesterName = "", detail = "", scopeKey = "" }:StatusInput & {toolName:string}) {
    if (!groupId || !userId || !toolName || !status) return

    const key = host.getActiveToolTaskCacheKey(groupId, userId, toolName)
    const previous:Partial<TaskStatus> = activeUserToolTaskCache.get(key) || {}
    const record = {
      ...previous,
      groupId: String(groupId),
      userId: String(userId),
      messageId: messageId ? String(messageId) : String(previous.messageId || ""),
      toolName,
      status,
      requesterName: requesterName || previous.requesterName || "",
      detail: detail ? String(detail).slice(0, 160) : "",
      scopeKey: scopeKey || previous.scopeKey || "",
      startedAt: previous.startedAt || Date.now(),
      updatedAt: Date.now()
    }
    if(activeUserToolTaskCache.size>=MAX_CACHE_ENTRIES)activeUserToolTaskCache.delete(activeUserToolTaskCache.keys().next().value||'')
    activeUserToolTaskCache.set(key, record)

    try {
      await ports.store().set(host.getActiveToolTaskRedisKey(groupId, userId, toolName), JSON.stringify(record), {
        EX: host.getTaskStatusTtlSeconds()
      })
    } catch (error) {
      logger.warn(`[活跃任务] 写入失败：${errorMessage(error)}`)
    }
}

async function getUserToolTaskStatus(host:TaskStatusHost, groupId:Id, userId:Id, toolName:string) {
    if (!groupId || !userId || !toolName) return null

    const key = host.getActiveToolTaskCacheKey(groupId, userId, toolName)
    const cached=activeUserToolTaskCache.get(key)
    if(cached&&Date.now()-Number(cached.updatedAt||0)<host.getTaskStatusTtlSeconds()*1000)return cached
    activeUserToolTaskCache.delete(key)

    try {
      const raw = await ports.store().get(host.getActiveToolTaskRedisKey(groupId, userId, toolName))
      if (typeof raw !== "string" || !raw) return null
      const record = parseStatus(JSON.parse(raw))
      if(!record)return null
      if(Date.now()-Number(record.updatedAt||0)>=host.getTaskStatusTtlSeconds()*1000)return null
      if(activeUserToolTaskCache.size>=MAX_CACHE_ENTRIES)activeUserToolTaskCache.delete(activeUserToolTaskCache.keys().next().value||'')
      activeUserToolTaskCache.set(key, record)
      return record
    } catch (error) {
      logger.warn(`[活跃任务] 读取失败：${errorMessage(error)}`)
      return null
    }
}

async function clearUserToolTaskStatus(host:TaskStatusHost, { groupId, userId, toolName }:{groupId?:Id;userId?:Id;toolName:string}) {
    if (!groupId || !userId || !toolName) return
    const key = host.getActiveToolTaskCacheKey(groupId, userId, toolName)
    activeUserToolTaskCache.delete(key)

    try {
      await ports.store().del(host.getActiveToolTaskRedisKey(groupId, userId, toolName))
    } catch (error) {
      logger.warn(`[活跃任务] 清理失败：${errorMessage(error)}`)
    }
}

function getRuntimeToolTaskStatus(host:TaskStatusHost, groupId:Id, userId:Id, toolName:string) {
    const runtime = activeDedupeToolRuns.get(host.getToolRunKey(groupId, userId, toolName))
    if (!runtime) return null
    return {
      ...runtime,
      groupId: String(groupId),
      userId: String(userId),
      toolName,
      status: "running",
      updatedAt: Date.now()
    }
}

async function getCurrentUserToolTaskStatus(host:TaskStatusHost, groupId:Id, userId:Id, toolName:string) {
    const runtime = host.getRuntimeToolTaskStatus(groupId, userId, toolName)
    if (runtime) return runtime
    const stored = await host.getUserToolTaskStatus(groupId, userId, toolName)
    if (!stored || !["queued", "running"].includes(stored.status)) return null
    return stored
}

function buildDrawTaskStatusReply(host:TaskStatusHost, status:TaskStatus|null|undefined) {
    const queued = status?.status === "queued"
    const isEdit = status?.toolName === "googleImageEditTool"
    if (isEdit) {
      return "那张图还在改，结果还没回来。"
    }
    return queued
      ? "这张已经在队列里，还没开始生成。"
      : "这张还在生成，结果还没回来。"
}

function buildReplySegment(host:TaskStatusHost, messageId:Id) {
    if (!messageId) return null
    if (ports.replySegment) return ports.replySegment(messageId)
    return { type: "reply", id: String(messageId), data: { id: String(messageId) } }
}

function buildTaskStatusReplyMessage(host:TaskStatusHost, status:TaskStatus|null|undefined, text:string) {
    const replySegment = host.buildReplySegment(status?.messageId)
    return replySegment ? [replySegment, text] : text
}

async function handleActiveDrawStatusQuestion(host:TaskStatusHost, e:Event, text = "") {
    if (!isDrawTaskStatusInquiry(text)) return false
    const reference=String(e._quotedPromptContext?.messageId||e.reply_id||'')
    let ids:string[]=[]
    if(!reference&&host.messageManager){
      try{const history=await host.messageManager.getMessages(e.group_id?'group':'private',e.group_id||e.user_id);ids=history.filter(row=>String(row.sender?.user_id)===String(e.user_id)&&String(row.message_id)!==String(e.message_id)&&Boolean(row.message_id)).slice(0,MAX_FACT_REQUESTS).map(row=>String(row.message_id))}catch{return false}
    }
    const facts=await host.getTurnActionFacts(e,{...(reference?{referenceMessageId:reference}:{}),recentRequestMessageIds:ids})
    if(facts.lookup!=='ok')return false
    const status=facts.tasks.find(fact=>['bananaTool','googleImageEditTool'].includes(fact.toolName)&&['queued','running'].includes(fact.execution))
    if (!status) return false
    const reply=host.buildDrawTaskStatusReply({status:status.execution,toolName:status.toolName})
    logger.info(`[活跃任务] 命中图片任务进度追问 group=${e.group_id} user=${e.user_id} tool=${status.toolName} status=${status.execution}`)
    await host.sendObservedReply(e, host.buildTaskStatusReplyMessage({status:status.execution,toolName:status.toolName,messageId:status.requestMessageId},reply))
    return true
}

function formatTaskStatusForPrompt(host:TaskStatusHost, status:TaskStatus|null|undefined) {
    if (!status?.status) return ""
    if (status.status === "processing") {
      return "[历史处理标记: 这条历史消息已进入处理流程，禁止把它当作当前新任务重复处理]"
    }
    if (status.status === "tool_running") {
      return "[历史处理标记: 这条历史消息曾进入工具处理；该旧标记不证明当前仍在执行、已完成或已送达，禁止重复处理]"
    }
    if (status.status === "tool_success") {
      return "[历史处理标记: 这条历史消息的工具调用曾返回；该旧标记不证明产物可用或最终投递成功，禁止重复处理]"
    }
    if (status.status === "tool_failed") {
      return "[历史处理标记: 这条历史消息此前没有产生可用输出。除非当前用户明确要求重试，否则只把它当普通历史；不要提到后台、工具、模型、接口、报错或失败等内部状态]"
    }
    return ""
}

return {getTaskStatusCacheKey,getTaskStatusRedisKey,getActiveToolTaskCacheKey,getActiveToolTaskRedisKey,getTaskStatusTtlSeconds,saveTaskStatus,getTaskStatus,getTurnActionFacts,clearTaskStatus,updateUserToolTaskStatus,getUserToolTaskStatus,clearUserToolTaskStatus,getRuntimeToolTaskStatus,getCurrentUserToolTaskStatus,buildDrawTaskStatusReply,buildReplySegment,buildTaskStatusReplyMessage,handleActiveDrawStatusQuestion,formatTaskStatusForPrompt}
}
