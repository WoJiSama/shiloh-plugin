import pLimit from 'p-limit'
export interface ConversationTool {function?:{name?:string};[key:string]:unknown}
export interface ConversationEvent {msg?:string;message?:unknown;group_id?:unknown;_groupContextAssets?:{media?:unknown[]}}
interface Ports {normalizeIntentText(text:string):string;isExplicitAdminCollectionMentionRequest(text:string):boolean;filterToolsForEmojiExposure(tools:ConversationTool[],text:string,options:{groupId:string;cooldownMs:number}):ConversationTool[]|null;isRealtimeInfoRequest(text:string):boolean;isExplicitSearchRequest(text:string):boolean;SEARCH_TOOL_NAMES:Set<string>;shouldExposeEmojiToolForMessage(text:string):boolean;isExplicitToolIntent(text:string):boolean}
export function createConversationUtils(ports:Ports) {
const {normalizeIntentText,isExplicitAdminCollectionMentionRequest,filterToolsForEmojiExposure,isRealtimeInfoRequest,isExplicitSearchRequest,SEARCH_TOOL_NAMES,shouldExposeEmojiToolForMessage,isExplicitToolIntent}=ports
// 会话编排共用小件:消息工具暴露过滤与并发限制器等纯函数,
// 从 apps/test.js 迁出以消除 chatTurn→test.js 的循环依赖。

function delay(ms:number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getOrCreateGroupLimiter(limitersMap:Map<string|number,{limiter:ReturnType<typeof pLimit>;concurrency:number}>, groupId:string|number, concurrency:number) {
  const entry = limitersMap.get(groupId)
  if (entry && entry.concurrency === concurrency) {
    return entry.limiter
  }
  const limiter = pLimit(concurrency)
  limitersMap.set(groupId, { limiter, concurrency })
  return limiter
}

function hasMediaNeedingTool(message:unknown = []) {
  return Array.isArray(message) && message.some(seg =>
    ["image", "video", "record", "voice", "file", "wallet"].includes((seg&&typeof seg==='object'?Reflect.get(seg,'type'):null))
  )
}

function shouldExposeToolsForMessage(e:ConversationEvent = {}, text = "") {
  const content = normalizeIntentText(text || e?.msg || "")
  if (hasMediaNeedingTool(e?.message)) return true
  if (e?._groupContextAssets?.media?.length) return true
  if (shouldExposeEmojiToolForMessage(content)) return true
  return isRealtimeInfoRequest(content) || isExplicitSearchRequest(content) || isExplicitToolIntent(content)
}

function filterToolsForMessageIntent(tools:ConversationTool[] = [], e:ConversationEvent = {}, text = "", { allowSearch = false, emojiCooldownMs = 120000 } = {}) {
  if (!Array.isArray(tools) || !tools.length) return []
  const content = normalizeIntentText(text || e?.msg || "")
  if (allowSearch) return tools.filter(tool => tool?.function?.name !== "mentionAdminsTool" || isExplicitAdminCollectionMentionRequest(content))
  if (!shouldExposeToolsForMessage(e, content)) return []

  // The all-admin tool is deliberately unavailable unless the user used
  // collection wording. A singular role request must go through exact member
  // targeting instead of allowing the model to broaden the audience.
  tools = tools.filter(tool =>
    tool?.function?.name !== "mentionAdminsTool" || isExplicitAdminCollectionMentionRequest(content)
  )

  const emojiOnlyTools = filterToolsForEmojiExposure(tools, content, {
    groupId: String(e?.group_id || ""),
    cooldownMs: emojiCooldownMs
  })
  if (emojiOnlyTools) return emojiOnlyTools

  if (allowSearch || isRealtimeInfoRequest(content) || isExplicitSearchRequest(content)) return tools

  return tools.filter(tool => {
    const name = tool?.function?.name
    return name && !SEARCH_TOOL_NAMES.has(name)
  })
}

function toolConfigHasName(toolNames:unknown, name:string) {
  return Array.isArray(toolNames) && toolNames.some(item => parseToolConfigEntry(item).name === name)
}

function parseToolConfigEntry(entry:unknown) {
  const raw = String(entry || "").trim()
  const match = raw.match(/^([A-Za-z_][A-Za-z0-9_-]*)(?:\(([^)]*)\))?$/)
  if (!match) return { name: raw, dedupe: false, marker: "" }
  return {
    name: match[1]!,
    dedupe: match[2] !== undefined,
    marker: match[2] || ""
  }
}
return {delay,getOrCreateGroupLimiter,filterToolsForMessageIntent,toolConfigHasName,parseToolConfigEntry}
}
