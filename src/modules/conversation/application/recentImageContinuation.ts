interface Segment {type?:string;url?:string;file?:string;data?:{url?:string;file?:string}}
interface ImageRecord {time?:number;timestamp?:number;sender?:{user_id?:string|number};user_id?:string|number;message?:Segment[]}
interface Group {getChatHistory?(start:number,limit:number):Promise<ImageRecord[]|null>}
interface Event {msg?:string;group?:Group;group_id?:string|number;user_id?:string|number;sender?:{user_id?:string|number};bot?:{uin?:string|number;pickGroup?(id:string|number):Group}}
interface Options {text?:string;botId?:string|number;userId?:string|number;maxAgeMs?:number;now?:number;limit?:number}
export function createRecentImageContinuation(fallbackBotId:()=>unknown) {
const CONTINUATION_PATTERN = /(?:再|继续|接着|然后|另外|还要|还想|顺便).{0,12}(?:加|加上|添加|放|放上|改|修改|换|替换|删|去掉|移除|修|调整|变成).{0,20}(?:刚才|刚刚|上一张|上张|那张|这张|图|成图)?|(?:把|将).{0,20}(?:刚才|刚刚|上一张|上张|那张|这张).{0,20}(?:改|加|换|删|修)|(?:刚才|刚刚|上一张|上张|那张|这张).{0,20}(?:再|继续|接着)?.{0,12}(?:改|加|换|删|修)/i

function isRecentImageContinuationRequest(text = "") {
  return CONTINUATION_PATTERN.test(String(text || "").replace(/\s+/g, " ").trim())
}

function getImageSource(segment:Segment = {}) {
  if (segment?.type !== "image") return ""
  return String(segment.url || segment.file || segment.data?.url || segment.data?.file || "").trim()
}

function getRecordTimestamp(record:ImageRecord = {}) {
  const value = Number(record.time || record.timestamp || 0)
  if (!value) return 0
  return value < 1e12 ? value * 1000 : value
}

async function resolveRecentBotImage(event:Event = {}, options:Options = {}) {
  const text = options.text ?? event?.msg ?? ""
  if (!isRecentImageContinuationRequest(text)) return null
  const group = event?.group || (event?.bot?.pickGroup && event?.group_id ? event.bot.pickGroup(event.group_id) : null)
  if (!group?.getChatHistory) return null

  const botId = String(options.botId || event?.bot?.uin || fallbackBotId() || "")
  const maxAgeMs = Number(options.maxAgeMs) || 15 * 60 * 1000
  const now = Number(options.now) || Date.now()
  const history = await group.getChatHistory(0, Number(options.limit) || 60)

  for (const record of [...(history || [])].reverse()) {
    const senderId = String(record?.sender?.user_id || record?.user_id || "")
    if (!botId || senderId !== botId) continue
    const timestamp = getRecordTimestamp(record)
    if (timestamp && now - timestamp > maxAgeMs) continue
    for (const segment of record?.message || []) {
      const image = getImageSource(segment)
      if (image) return { image, record }
    }
  }
  return null
}

/** 不带话术门槛的版本：扫描机器人最近发过的图片，用于判断画图回合是否真的出图了 */
async function findRecentBotImage(event:Event = {}, options:Options = {}) {
  const group = event?.group || (event?.bot?.pickGroup && event?.group_id ? event.bot.pickGroup(event.group_id) : null)
  if (!group?.getChatHistory) return null

  const botId = String(options.botId || event?.bot?.uin || fallbackBotId() || "")
  const maxAgeMs = Number(options.maxAgeMs) || 15 * 60 * 1000
  const now = Number(options.now) || Date.now()
  const history = await group.getChatHistory(0, Number(options.limit) || 60)

  for (const record of [...(history || [])].reverse()) {
    const senderId = String(record?.sender?.user_id || record?.user_id || "")
    if (!botId || senderId !== botId) continue
    const timestamp = getRecordTimestamp(record)
    if (timestamp && now - timestamp > maxAgeMs) continue
    for (const segment of record?.message || []) {
      const image = getImageSource(segment)
      if (image) return { image, record }
    }
  }
  return null
}

async function resolveRecentUserImage(event:Event = {}, options:Options = {}) {
  const group = event?.group || (event?.bot?.pickGroup && event?.group_id ? event.bot.pickGroup(event.group_id) : null)
  if (!group?.getChatHistory) return null

  const userId = String(options.userId || event?.user_id || event?.sender?.user_id || "")
  if (!userId) return null
  const maxAgeMs = Number(options.maxAgeMs) || 2 * 60 * 1000
  const now = Number(options.now) || Date.now()
  const history = await group.getChatHistory(0, Number(options.limit) || 30)

  for (const record of [...(history || [])].reverse()) {
    const senderId = String(record?.sender?.user_id || record?.user_id || "")
    if (senderId !== userId) continue
    const timestamp = getRecordTimestamp(record)
    if (timestamp && now - timestamp > maxAgeMs) continue
    for (const segment of record?.message || []) {
      const image = getImageSource(segment)
      if (image) return { image, record }
    }
  }
  return null
}

return {isRecentImageContinuationRequest,resolveRecentBotImage,findRecentBotImage,resolveRecentUserImage}
}
