import type {PersonaSnapshot} from '../../../contracts/persona.js'
interface SmartOptions {kind?:string;thresholds?:Partial<{maxTextChars:number;maxLines:number;structuredRows:number;documentChars:number;documentLines:number}>;force?:boolean;quote?:boolean;forceText?:boolean;template?:string;nickname?:string;avatarUrl?:string}
interface SmartEvent {_personaSnapshot?:PersonaSnapshot;reply(output:unknown,quote?:boolean):Promise<unknown>}
interface CardPayload {text:string;template:string;nickname?:string;avatarUrl?:string}
export function createSmartReply(ports:{getTextImageTool():Promise<{execute(payload:CardPayload,event:SmartEvent):Promise<unknown>}>;warn(message:string):void}) {
const DEFAULT_THRESHOLDS = {
  maxTextChars: 600,
  maxLines: 8,
  structuredRows: 5,
  documentChars: 1800,
  documentLines: 25
}

const STRUCTURED_KINDS = new Set([
  "table",
  "ranking",
  "cocAttributes",
  "deltaForce",
  "umaRaceResult",
  "messageArchive",
  "knowledgeList",
  "diceLong"
])

const KIND_TEMPLATE_OVERRIDES:Record<string,string> = {}

function analyzeReplyText(text = "", options:SmartOptions = {}) {
  const source = String(text || "").trim()
  const lines = source ? source.split(/\r?\n/) : []
  const nonEmptyLines = lines.filter(line => line.trim())
  const structuredRows = nonEmptyLines.filter(line => (
    /^\s*(?:\d+\.|#\d+|[-*]\s+)/.test(line) ||
    /[｜|].+[｜|]/.test(line) ||
    /\s\/\s/.test(line) ||
    /：/.test(line)
  )).length
  const kind = String(options.kind || "")
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds || {}) }
  const forced = options.force === true
  const structuredKind = STRUCTURED_KINDS.has(kind)
  const shouldRender = forced ||
    source.length > thresholds.maxTextChars ||
    nonEmptyLines.length > thresholds.maxLines ||
    structuredRows >= thresholds.structuredRows ||
    (structuredKind && nonEmptyLines.length >= thresholds.structuredRows)
  const template = shouldRender ? (KIND_TEMPLATE_OVERRIDES[kind] || "document") : "chat"

  return {
    shouldRender,
    template,
    chars: source.length,
    lines: nonEmptyLines.length,
    structuredRows,
    kind
  }
}

async function sendSmartReply(e:SmartEvent, output:unknown, options:SmartOptions = {}) {
  if (output === undefined || output === null) return null
  if (Array.isArray(output) || typeof output !== "string") return await e.reply(output, options.quote)

  const text = output.trim()
  if (!text) return null
  // Some consumers (notably dice logs) need the actual outbound text. A
  // rendered card only reaches message listeners as an image segment.
  if (options.forceText === true) return await e.reply(text, options.quote)
  const analysis = analyzeReplyText(text, options)
  if (!analysis.shouldRender) return await e.reply(text, options.quote)

  let deliveryAttempted = false
  const personaSnapshot = e._personaSnapshot
  try {
    const tool = await ports.getTextImageTool()
    const template = options.template || analysis.template
    const payload:CardPayload = {
      text,
      template
    }
    if (template === "chat" && typeof options.nickname === "string" && options.nickname.trim()) payload.nickname = options.nickname
    if (template === "chat" && typeof options.avatarUrl === "string" && options.avatarUrl.trim()) payload.avatarUrl = options.avatarUrl
    const cardEvent:SmartEvent = Object.assign(Object.create(e), {_personaSnapshot:personaSnapshot,reply:async (output:unknown,quote?:boolean) => { deliveryAttempted = true; return e.reply(output, quote) }})
    const result = await tool.execute(payload, cardEvent)
    if (typeof result === "string" && result.trim().startsWith("error:")) {
      throw new Error(result)
    }
    return null
  } catch (error) {
    if (deliveryAttempted) { ports.warn("[SmartReply] 投递结果未知，停止自动重发"); return null }
    ports.warn(`[SmartReply] 长文本转图失败，回退文本发送: ${error instanceof Error ? error.message : String(error)}`)
    return await e.reply(text, options.quote)
  }
}

return {analyzeReplyText,sendSmartReply}
}
