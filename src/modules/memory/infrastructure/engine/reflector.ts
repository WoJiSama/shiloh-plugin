// utils/memory/reflector.js
import { authorityRank, clamp, compactText } from './constants.js'
import {memoryRecord} from '../../../../contracts/memoryEngine.js'
import type {MemoryLlmConfig,MemoryLlmPorts,MemoryFact,MemoryEntity,MemoryId} from '../../../../contracts/memoryEngine.js'
import { makeFact,normalizePersonaSource,personaSourceKey } from './entityModel.js'
import { memStats } from './stats.js'
import {finiteTimestamp,memoryDate} from './temporalContext.js'

// 反思巩固器：把实体的零散 facts 交给 LLM 合并去冗余解矛盾（consolidateEntity），
// 并基于群 facts + 最近文本产出高层洞察（reflectGroup）。
// 全程对 LLM 失败静默降级；禁止改写 origin:'config' 的 fact。
// 风格对齐 extractor.js：ESM、纯函数优先、_callChat 可被测试覆写、宽松 JSON 解析。

const MAX_GROUP_INSIGHTS = 3
const GROUP_INSIGHT_CONFIDENCE = 0.6
const CHAT_TIMEOUT_MS = 8000

function extractJsonArray(text:unknown) {
  const raw = String(text || '')
  const match = raw.match(/\[[\s\S]*\]/)
  try {
    const parsed:unknown = JSON.parse(match ? match[0] : raw)
    return (Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : [])).map(memoryRecord)
  } catch { return [] }
}

function isActiveFact(fact:MemoryFact) {
  return Boolean(fact) && fact.superseded !== true
}

// origin:'config' 的 fact 不可被反思改写/删除。
function isConfigFact(fact:MemoryFact) {
  return Boolean(fact) && (fact.origin === 'config' || fact.authority === 'config')
}

// 被合并的多条 fact 中，取最高 authority 与最高 confidence 作为产出 fact 的属性。
function pickStrongest(facts:MemoryFact[]) {
  let authority = 'mention'
  let confidence = 0
  for (const fact of facts) {
    if (authorityRank(fact.authority) > authorityRank(authority)) authority = fact.authority
    const c = clamp(fact.confidence)
    if (c > confidence) confidence = c
  }
  // 反思禁止伪造 config 级权威。
  if (authority === 'config') authority = 'self'
  return { authority, confidence: confidence || 0.7 }
}

function mergeTags(facts:MemoryFact[]) {
  return [...new Set(facts.flatMap(f => (Array.isArray(f.tags) ? f.tags : [])))]
}

function mergeRefs(facts:MemoryFact[]) {
  return [...new Set(facts.flatMap(f => (Array.isArray(f.refs) ? f.refs : [])))]
}

function latestAt(facts:MemoryFact[]) {
  return facts.reduce((max, f) => Math.max(max, Number(f.at) || 0), 0)
}

function sourceIndices(value:unknown,count:number):number[] {
  if (!Array.isArray(value) || !value.length || !value.every(n => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= count)) return []
  return [...new Set(value.map(n => Number(n) - 1))]
}

function sameFactContext(sources:MemoryFact[]) {
  return new Set(sources.map(fact => fact.eventAt ?? null)).size === 1
    && new Set(sources.map(fact => JSON.stringify([personaSourceKey(fact.personaSource),fact.heardFrom || '']))).size === 1
}

function sourceMetadata(sources:MemoryFact[]) {
  const personaSource = normalizePersonaSource(sources[0]?.personaSource)
  return {eventAt:sources[0]?.eventAt,refs:mergeRefs(sources),...(personaSource ? {personaSource} : {}),...(sources[0]?.heardFrom ? {heardFrom:sources[0].heardFrom} : {})}
}

function describeFact(fact:MemoryFact,index:number) {
  const eventAt = finiteTimestamp(fact.eventAt)
  const source = normalizePersonaSource(fact.personaSource)
  return `${index + 1}. ${fact.text} [事件日期：${eventAt !== undefined ? memoryDate(eventAt) : '未记录'}；来源：${source ? JSON.stringify(source) : fact.heardFrom || '未记录'}]`
}

const CONSOLIDATE_PROMPT = `你是长期记忆巩固器。给你某个用户的若干条零散事实（带编号），请合并语义重复、消解矛盾（保留更可信/更新的说法），输出更紧凑的事实列表。只输出 JSON 数组，不要解释。
每个元素字段：
- text: 合并后的简洁事实文本（中文）
- sources: 整数数组，引用被合并的原始事实编号（从 1 开始）
- tags: 可选标签数组
规则：
- 同一事实只保留一条；矛盾时保留更可信的一方并丢弃另一方。
- 只能合并来源与事件日期一致的事实；保留原有日期，不要把“明天”等相对日期重新解释成执行时的日期。
- 不要凭空发明事实；不要输出与输入无关的内容。
- 无需合并时可原样返回；无可保留内容时输出 []。`

const GROUP_REFLECT_PROMPT = `你是群聊记忆反思器。根据群内已沉淀的事实与最近的发言，提炼 0 到 3 条高层"洞察"（群体氛围/共识/反复出现的梗或话题/群规倾向）。只输出 JSON 数组，不要解释。
每个元素字段：
- text: 一句话洞察（中文，简洁）
- sources: 必填整数数组，引用“已有群事实”的编号（从 1 开始）；无可靠编号来源则不要产出洞察
- tags: 可选标签数组
规则：
- 最多 3 条；没有可靠洞察时输出 []。
- 不合并不同事件日期或不同人格来源；近期发言只辅助理解，不能代替有编号事实的证据，也不能把旧事件说成现在发生。
- 只做概括，不要复述单条事实，不要发明未出现的信息。`

export class Reflector {
 config:MemoryLlmConfig
 ports:MemoryLlmPorts
  constructor(config:MemoryLlmConfig = {},ports:MemoryLlmPorts) {
    this.config = config || {}
    this.ports=ports
  }

  canUse() {
    const c = this.config.memoryAiConfig || {}
    return Boolean(c.memoryAiUrl && c.memoryAiApikey)
  }

  // 可被测试覆写。与 extractor 同款 OpenAI 兼容调用。
  // 加 AbortSignal.timeout（§0.5）+ 调用计数/耗时打点（§0.3/P1-4）；
  // 失败只 inc fail + logger.warn 状态码，绝不记 prompt/fact 全文（隐私）。
  async _callChat(messages:{role:string;content:string}[], maxTokens = 800) {
    const c = this.config.memoryAiConfig || {}
    const startedAt = Date.now()
    try {
      const result = await this.ports.call({
        url: c.memoryAiUrl,
        apikey: c.memoryAiApikey,
        model: c.memoryAiModel || 'gpt-4o-mini',
        messages,
        temperature: 0.2,
        maxTokens: maxTokens,
        timeoutMs: CHAT_TIMEOUT_MS
      })
      if (!result.ok) throw new Error(result.error)
      memStats.inc('llm.reflect.call')
      memStats.observe('llm.reflect.ms', Date.now() - startedAt)
      return result.content || '[]'
    } catch (e) {
      memStats.inc('llm.reflect.fail')
      this.ports.logger?.warn?.(`[memory] reflect LLM 调用失败：${e instanceof Error?e.message:String(e)}`)
      throw e
    }
  }

  // entity.facts（排除 origin:'config'）交 LLM 合并去冗余，产出标 origin:'reflection' 的紧凑列表。
  // 返回 { facts, changed }。config fact 原样保留；LLM 失败/未配置 -> changed:false 原样返回。
  async consolidateEntity(entity:MemoryEntity) {
    const allFacts = Array.isArray(entity?.facts) ? entity.facts : []
    const configFacts = allFacts.filter(isConfigFact)
    const reflectable = allFacts.filter(f => isActiveFact(f) && !isConfigFact(f))

    if (!this.canUse() || reflectable.length === 0) {
      return { facts: allFacts, changed: false }
    }

    const listing = reflectable.map(describeFact).join('\n')
    const userPrompt = `用户的零散事实：\n${listing}\n\n请输出合并后的 JSON 数组。`

    let content
    try {
      content = await this._callChat([
        { role: 'system', content: CONSOLIDATE_PROMPT },
        { role: 'user', content: userPrompt }
      ])
    } catch {
      return { facts: allFacts, changed: false }
    }

    const items = extractJsonArray(content)
    const merged = []
    const covered = new Set<number>()
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      const text = compactText(item.text, 240)
      if (!text) continue
      const sourceIdx = sourceIndices(item.sources,reflectable.length)
      if (!sourceIdx.length) continue
      const sources = sourceIdx.map(i => reflectable[i]!)
      // A merged fact must not erase a schedule or turn several observers into
      // one persona's experience. Keep the original facts when metadata differs.
      if (!sameFactContext(sources)) continue
      const { authority, confidence } = pickStrongest(sources)
      const tags = [...new Set([...(Array.isArray(item.tags) ? item.tags : []), ...mergeTags(sources)])]
      merged.push(makeFact({
        text,
        tags,
        authority,
        confidence,
        at: latestAt(sources),
        ...sourceMetadata(sources),
        origin: 'reflection'
      }))
      for (const index of sourceIdx) covered.add(index)
    }

    if (merged.length === 0) {
      return { facts: allFacts, changed: false }
    }

    // config fact 永不动；其余被合并产物替换。
    return { facts: [...configFacts,...reflectable.filter((_fact,index) => !covered.has(index)),...merged], changed: true }
  }

  // 基于群 facts + 最近文本产出 0-3 条洞察 fact。失败/未配置 -> insights:[]。
  async reflectGroup({ groupId, facts, recentTexts }: {groupId?:MemoryId;facts?:MemoryFact[];recentTexts?:unknown[]} = {}) {
    if (!this.canUse()) return { insights: [] }

    const activeFacts = (Array.isArray(facts) ? facts : []).filter(isActiveFact)
    if (!activeFacts.length) return {insights:[]}
    const factListing = activeFacts.map(describeFact).join('\n') || '无'
    const textListing = (Array.isArray(recentTexts) ? recentTexts : [])
      .map((t, i) => `${i + 1}. ${compactText(t, 200)}`)
      .filter(line => line.replace(/^\d+\.\s*$/, '') !== '')
      .join('\n') || '无'
    const userPrompt = `群 ${groupId ?? ''} 已有群事实：\n${factListing}\n\n最近发言：\n${textListing}\n\n请输出洞察 JSON 数组。`

    let content
    try {
      content = await this._callChat([
        { role: 'system', content: GROUP_REFLECT_PROMPT },
        { role: 'user', content: userPrompt }
      ])
    } catch {
      return { insights: [] }
    }

    const insights = []
    for (const item of extractJsonArray(content)) {
      if (!item || typeof item !== 'object') continue
      const text = compactText(item.text, 240)
      if (!text) continue
      const indexes = sourceIndices(item.sources,activeFacts.length)
      if (!indexes.length) continue
      const sources = indexes.map(index => activeFacts[index]!)
      if (!sameFactContext(sources)) continue
      const tags = [...new Set(['洞察', ...(Array.isArray(item.tags) ? item.tags : []),...mergeTags(sources)])]
      insights.push(makeFact({
        text,
        tags,
        authority: 'mention',
        confidence: GROUP_INSIGHT_CONFIDENCE,
        at: latestAt(sources),
        ...sourceMetadata(sources),
        origin: 'reflection'
      }))
      if (insights.length >= MAX_GROUP_INSIGHTS) break
    }

    return { insights }
  }
}
