import {isDrawTaskStatusInquiry} from '../domain/messageIntent.js'
type Id=string|number|null|undefined
interface TaskStatus {groupId?:string;userId?:string;messageId?:string;status:string;toolName:string;error?:string;updatedAt?:number;requesterName?:string;detail?:string;scopeKey?:string;startedAt?:number}
interface StatusInput {groupId?:Id;userId?:Id;messageId?:Id;status:string;toolName?:string;error?:unknown;requesterName?:string;detail?:string;scopeKey?:string}
interface Event {group_id?:Id;user_id?:Id}
export interface TaskStatusHost {TASK_STATUS_PREFIX:string;ACTIVE_TOOL_TASK_PREFIX:string;config:{groupChatMemoryDays?:number};getTaskStatusCacheKey(groupId:Id,messageId:Id):string;getTaskStatusRedisKey(groupId:Id,messageId:Id):string;getActiveToolTaskCacheKey(groupId:Id,userId:Id,toolName:string):string;getActiveToolTaskRedisKey(groupId:Id,userId:Id,toolName:string):string;getTaskStatusTtlSeconds():number;getToolRunKey(groupId:Id,userId:Id,toolName:string):string;getRuntimeToolTaskStatus(groupId:Id,userId:Id,toolName:string):TaskStatus|null;getUserToolTaskStatus(groupId:Id,userId:Id,toolName:string):Promise<TaskStatus|null|undefined>;getCurrentUserToolTaskStatus(groupId:Id,userId:Id,toolName:string):Promise<TaskStatus|null|undefined>;buildReplySegment(messageId:Id):unknown;buildTaskStatusReplyMessage(status:TaskStatus,text:string):unknown;buildDrawTaskStatusReply(status:TaskStatus):string;sendObservedReply(e:Event,payload:unknown):Promise<unknown>}
function parseStatus(value:unknown):TaskStatus|null {if(!value||typeof value!=='object')return null;const r=value as Record<string,unknown>;if(typeof r.status!=='string'||typeof r.toolName!=='string')return null;const result:TaskStatus={status:r.status,toolName:r.toolName};for(const key of ['groupId','userId','messageId','error','requesterName','detail','scopeKey'] as const)if(typeof r[key]==='string')result[key]=r[key];for(const key of ['updatedAt','startedAt'] as const)if(typeof r[key]==='number'&&Number.isFinite(r[key]))result[key]=r[key];return result}
function errorMessage(e:unknown){return e instanceof Error?e.message:String(e)}
export function createTaskStatus(ports:{store():{set(key:string,value:string,options:{EX:number}):Promise<unknown>;get(key:string):Promise<unknown>;del(key:string):Promise<unknown>};logger:{warn(message:string):void;info(message:string):void};activeDedupeToolRuns:Map<string,{startedAt?:number;[key:string]:unknown}>;replySegment?(id:Id):unknown}) {
const {logger,activeDedupeToolRuns}=ports
// 工具任务状态:任务/绘图进度查询的 Redis 持久化与运行时缓存、状态回复文案。
// 从 apps/test.js 原样迁出(行为不变),this 依赖以 host 注入。

const TASK_STATUS_REDIS_TIMEOUT_MS = 2000



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

async function saveTaskStatus(host:TaskStatusHost, { groupId, userId, messageId, status, toolName = "", error = "" }:StatusInput) {
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
    if (taskStatusCache.has(cacheKey)) return taskStatusCache.get(cacheKey) || null

    const raw = await settleTaskStatusRedis(
      ports.store().get(host.getTaskStatusRedisKey(groupId, messageId)),
      null,
      "读取"
    )
    if (typeof raw !== "string" || !raw) return null
    try {
      const record = parseStatus(JSON.parse(raw))
      if(!record)return null
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
    if (activeUserToolTaskCache.has(key)) return activeUserToolTaskCache.get(key) || null

    try {
      const raw = await ports.store().get(host.getActiveToolTaskRedisKey(groupId, userId, toolName))
      if (typeof raw !== "string" || !raw) return null
      const record = parseStatus(JSON.parse(raw))
      if(!record)return null
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
      return "那张图还在改，结果还没回来。出来了我就直接发。"
    }
    return queued
      ? "这张已经在队列里，前面还有任务。轮到它就会继续画，成图会直接发。"
      : "这张还在生成，结果还没回来。成图会直接发。"
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
    const statuses = await Promise.all([
      host.getCurrentUserToolTaskStatus(e.group_id, e.user_id, "bananaTool"),
      host.getCurrentUserToolTaskStatus(e.group_id, e.user_id, "googleImageEditTool")
    ])
    const status = statuses.find(Boolean)
    if (!status) return false

    logger.info(`[活跃任务] 命中图片任务进度追问 group=${e.group_id} user=${e.user_id} tool=${status.toolName} status=${status.status}`)
    await host.sendObservedReply(e, host.buildTaskStatusReplyMessage(status, host.buildDrawTaskStatusReply(status)))
    return true
}

function formatTaskStatusForPrompt(host:TaskStatusHost, status:TaskStatus|null|undefined) {
    if (!status?.status) return ""
    if (status.status === "processing") {
      return "[历史处理标记: 这条历史消息已进入处理流程，禁止把它当作当前新任务重复处理]"
    }
    if (status.status === "tool_running") {
      return "[历史处理标记: 这条历史消息仍在后台处理，禁止重复处理；不要在回复中提到后台状态]"
    }
    if (status.status === "tool_success") {
      return "[历史处理标记: 这条历史消息已经处理完，禁止重复处理]"
    }
    if (status.status === "tool_failed") {
      return "[历史处理标记: 这条历史消息此前没有产生可用输出。除非当前用户明确要求重试，否则只把它当普通历史；不要提到后台、工具、模型、接口、报错或失败等内部状态]"
    }
    return ""
}

return {getTaskStatusCacheKey,getTaskStatusRedisKey,getActiveToolTaskCacheKey,getActiveToolTaskRedisKey,getTaskStatusTtlSeconds,saveTaskStatus,getTaskStatus,clearTaskStatus,updateUserToolTaskStatus,getUserToolTaskStatus,clearUserToolTaskStatus,getRuntimeToolTaskStatus,getCurrentUserToolTaskStatus,buildDrawTaskStatusReply,buildReplySegment,buildTaskStatusReplyMessage,handleActiveDrawStatusQuestion,formatTaskStatusForPrompt}
}
