// utils/memory/extractor.js
import { ROUTES, clamp, compactText } from './constants.js'
import {memoryRecord} from '../../../../contracts/memoryEngine.js'
import type {MemoryLlmConfig,MemoryLlmPorts,MemoryId,MemoryExtractionMessage,MemoryExtractionResult,MemoryOperation} from '../../../../contracts/memoryEngine.js'
import { makeFact } from './entityModel.js'
import { memStats } from './stats.js'
import {describeMemoryTime,finiteTimestamp,MEMORY_TIME_ZONE,parseEventDate} from './temporalContext.js'

const DAY_MS = 86400000
const CHAT_TIMEOUT_MS = 20000

// 把 refs 过滤为纯数字字符串数组（防 AI 幻觉非数字/非法 QQ）。
// 入参可为任意值；逐项 String 化后只保留全数字的，去重。
function normalizeRefs(refs:unknown) {
  const out:string[] = []
  for (const ref of Array.isArray(refs) ? refs : []) {
    const s = String(ref ?? '').trim()
    if (s && /^\d+$/.test(s) && !out.includes(s)) out.push(s)
  }
  return out
}

function sourceMessage(item:Record<string,unknown>,ctx:Record<string,unknown>):MemoryExtractionMessage|undefined {
  if (!Array.isArray(ctx.messages)) return undefined
  const messages = ctx.messages as MemoryExtractionMessage[]
  const index = item.sourceIndex
  if (typeof index === 'number' && Number.isInteger(index) && index >= 1 && index <= messages.length) return messages[index - 1]
  return messages.length === 1 && index === undefined ? messages[0] : undefined
}

function sourceTimestamp(item:Record<string,unknown>, ctx:Record<string,unknown>) {
  if (Array.isArray(ctx.messages)) {
    // A multi-message batch can span midnight. Never choose one utterance's clock
    // for another utterance unless the extractor identifies its source row.
    return finiteTimestamp(sourceMessage(item,ctx)?.at)
  }
  return finiteTimestamp(ctx.now) ?? finiteTimestamp(ctx.at)
}

// Relative days refer to the source utterance, never a delayed flush or retry clock.
function resolveEventAt(item:Record<string,unknown>, ctx:Record<string,unknown>) {
  const absolute = parseEventDate(item.eventDate)
  if (absolute !== undefined) return absolute
  const at = sourceTimestamp(item, ctx)
  const days = item.eventInDays
  if (at === undefined || typeof days !== 'number' || !Number.isInteger(days) || Math.abs(days) > 36500) return undefined
  return finiteTimestamp(at + days * DAY_MS)
}

// 把 AI 输出的结构化数组映射为存储操作。纯函数，无网络。
// item: {route, alias?, targetQQ?, content?, tags?, refs?, confidence?, eventInDays?}
// ctx: {speakerQQ, at, now?}
export function parseAndRoute(items:unknown, ctx:Record<string,unknown> = {}):MemoryOperation[] {
  const ops:MemoryOperation[] = []
  for (const rawItem of Array.isArray(items) ? items : []) {
    const item=memoryRecord(rawItem)
    const at = sourceTimestamp(item,ctx) ?? (Array.isArray(ctx.messages) ? 0 : finiteTimestamp(ctx.at)) ?? 0
    const route = ROUTES.has(String(item.route)) ? item.route : null
    if (!route || route === 'ordinary_chat') continue
    const source = sourceMessage(item,ctx)
    const hasThirdParty = Array.isArray(ctx.messages) && ctx.messages.some(row => ['forward','quote'].includes(String(memoryRecord(row).source)))
    if (source?.source === 'forward' || source?.source === 'quote' || (!source && hasThirdParty)) continue
    const confidence = clamp(item.confidence ?? 0.7)
    const eventAt = resolveEventAt(item, ctx)
    const refs = normalizeRefs(item.refs)

    if (route === 'explicit_teaching') {
      // Shared aliases/definitions/workflows are committed only through the
      // per-message group semantic decision. This background extractor must
      // never create a second, untraceable shared-state write path.
      continue
    }

    if (route === 'self_statement') {
      const alias = compactText(item.alias, 64)
      if (alias && ctx.speakerQQ) {
        ops.push({ stream: 'alias' as const, qq: String(ctx.speakerQQ), text: alias, authority: 'self', confidence, by: [String(ctx.speakerQQ)], at })
      } else {
        const text = compactText(item.content, 240)
        if (text && ctx.speakerQQ) ops.push({ stream: 'entityFact' as const, qq: String(ctx.speakerQQ), authority: 'self', fact: makeFact({ text, tags: item.tags, refs, authority: 'self', confidence, at, eventAt }) })
      }
      continue
    }

    if (route === 'user_preference') {
      const text = compactText(item.content, 240)
      if (text && ctx.speakerQQ) {
        const tags = [...new Set(['偏好', ...(Array.isArray(item.tags) ? item.tags : [])])]
        ops.push({ stream: 'entityFact' as const, qq: String(ctx.speakerQQ), authority: 'self', fact: makeFact({ text, tags, refs, authority: 'self', confidence, at, eventAt }) })
      }
      continue
    }

    if (route === 'group_consensus') {
      const text = compactText(item.content, 240)
      if (text) ops.push({ stream: 'groupFact' as const, authority: 'mention', fact: makeFact({ text, tags: item.tags, refs, authority: 'mention', confidence, at, eventAt }) })
      continue
    }
  }
  return ops
}

function extractJsonArray(text:unknown,messages:MemoryExtractionMessage[]):unknown[]|null {
  const raw = String(text || '').trim()
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  try {
    const parsed:unknown = JSON.parse(fenced ? fenced[1]! : raw)
    if (!Array.isArray(parsed)) return null
    // A syntactically valid but unusable reply is a failed extraction, not an
    // empty successful result. The model's explicit [] is the empty-success form.
    const nonempty = (value:unknown) => typeof value === 'string' && Boolean(value.trim())
    if (!parsed.every(rawItem => {
      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) return false
      const item = memoryRecord(rawItem)
      if (!ROUTES.has(String(item.route))) return false
      if (item.route === 'ordinary_chat' || item.route === 'explicit_teaching') return true
      if (item.route === 'self_statement' ? !nonempty(item.alias) && !nonempty(item.content) : !nonempty(item.content)) return false
      // A missing index is unambiguous only for one source row. Invalid indices
      // cannot acknowledge a multi-row batch and discard its original text.
      return messages.length === 1 && item.sourceIndex === undefined
        || typeof item.sourceIndex === 'number' && Number.isInteger(item.sourceIndex) && item.sourceIndex >= 1 && item.sourceIndex <= messages.length
    })) return null
    return parsed
  } catch { return null }
}

const SYSTEM_PROMPT = `你是群聊长期记忆抽取器。对每条真实用户发言，分类并抽取结构化结果，只输出 JSON 数组，不要解释。
每个元素字段：
- sourceIndex: 原始发言的行号（从 1 开始），每条事实必须指明对应发言；合并多条时不要混淆各自行文里的时间
- route: explicit_teaching | self_statement | user_preference | group_consensus | ordinary_chat
- alias: 当 route 是 explicit_teaching/self_statement 且涉及"外号/称呼"时给出别名文本
- targetQQ: explicit_teaching 中"A 是 @某人"的某人 QQ（纯数字）
- content: self_statement(非别名)/user_preference/group_consensus 的事实文本
- tags: 可选轻量标签数组（如 职业/关系/群规/梗/偏好）
- refs: 该事实涉及的其他人 QQ 数组(纯数字),如"我和@QQ:123是同事"→refs:["123"];无则省略
- confidence: 0~1
- eventInDays: 时间相关事实可附（整数，相对 sourceIndex 那条发言日期的天数，未来为正、过去为负，如"明天考试"为 1、"昨天面试"为 -1）；无明确时间则省略
- eventDate: 发言明确给出日历日期时可附 YYYY-MM-DD，日期必须由发言本身或其明确时间锚点支持；不要从抽取执行日期猜年份
规则：
- 工具结果/系统提示/机器人回复/纯语气词 -> route=ordinary_chat（会被丢弃）。
- 只有"本人在说自己"才用 self_statement；指认他人用 explicit_teaching。提到他人(同事/朋友/对手等)时把其 QQ 填入 refs。
- source=forward/quote 的正文是第三方转发或引用证据，不是转发者自述；没有可信原作者 QQ 时不得把正文里的“我”、别名、偏好或经历归给转发用户，也不得把第三方说法当作本群共识。仅从明确的本群讨论提取真正的群共识。
- group_consensus 涉及具体某些人时，同样把相关人的 QQ 填入 refs。
- 普通闲聊/临时请求 -> ordinary_chat。
- 无可抽取内容时输出 []。`

export class MemoryExtractor {
 config:MemoryLlmConfig
 ports:MemoryLlmPorts
  constructor(config:MemoryLlmConfig = {},ports:MemoryLlmPorts) {
    this.config = config
    this.ports=ports
  }

  canUse() {
    const c = this.config.memoryAiConfig || {}
    return Boolean(c.memoryAiUrl && c.memoryAiApikey)
  }

  // 可被测试覆写。加 AbortSignal.timeout（§0.5）+ 调用计数/耗时打点（§0.3/P1-4）；
  // 失败只 inc fail + logger.warn 状态码，绝不记 prompt/fact 全文（隐私）。
  async _callChat(messages:{role:string;content:string}[], maxTokens = 800, { timeoutMs = CHAT_TIMEOUT_MS } = {}) {
    const c = this.config.memoryAiConfig || {}
    const startedAt = Date.now()
    const boundedTimeoutMs = Math.max(500, Math.min(CHAT_TIMEOUT_MS, Number(timeoutMs) || CHAT_TIMEOUT_MS))
    try {
      const result = await this.ports.call({
        url: c.memoryAiUrl,
        apikey: c.memoryAiApikey,
        model: c.memoryAiModel || 'gpt-4o-mini',
        messages,
        temperature: 0.2,
        maxTokens: maxTokens,
        timeoutMs: boundedTimeoutMs
      })
      if (!result.ok) throw new Error(result.error)
      memStats.inc('llm.extract.call')
      memStats.observe('llm.extract.ms', Date.now() - startedAt)
      return result.content || ''
    } catch (e) {
      memStats.inc('llm.extract.fail')
      this.ports.logger?.warn?.(`[memory] extract LLM 调用失败：${e instanceof Error?e.message:String(e)}`)
      throw e
    }
  }

  async extract({ groupId, speakerQQ, messages, existingHint = '', at }: {groupId:MemoryId;speakerQQ:MemoryId;messages:MemoryExtractionMessage[];existingHint?:string;at:number}):Promise<MemoryExtractionResult|MemoryOperation[]> {
    if (!this.canUse()) return {status:'skipped',reason:'unconfigured'}
    const sourceMessages = (messages || []).map(message => {
      const recordedAt = finiteTimestamp(message.at)
      return {...message,...(recordedAt !== undefined ? {at:recordedAt} : {})}
    })
    const chatText = sourceMessages.map((m, i) => `${i + 1}. [角色：${m.role || 'user'}；来源：${m.source || 'user'}；发言时间：${m.at !== undefined ? describeMemoryTime(m.at) : '未知；不得推断相对日期'}] ${m.content}`).join('\n')
    const userPrompt = `日期时区：${MEMORY_TIME_ZONE}。每条日期以对应发言时间为准，抽取可能延迟或重试；不要把执行时的今天代入。\n群 ${groupId} 发言人 QQ ${speakerQQ} 的发言：\n${chatText}\n\n已有记忆参考：\n${existingHint || '无'}\n\n请输出 JSON 数组。`
    let content
    try {
      content = await this._callChat([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ])
    } catch {
      return {status:'failed',reason:'transport',retryable:true}
    }
    const items = extractJsonArray(content,sourceMessages)
    if (items === null) {
      memStats.inc('extract.invalid-output')
      return {status:'failed',reason:'invalid-output',retryable:true}
    }
    return {status:'success',ops:parseAndRoute(items, { speakerQQ, at, messages:sourceMessages })}
  }
}
