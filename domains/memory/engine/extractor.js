// utils/memory/extractor.js
import { ROUTES, clamp, compactText } from './constants.js'
import { makeFact } from './entityModel.js'
import { memStats } from './stats.js'

const DAY_MS = 86400000
const CHAT_TIMEOUT_MS = 20000

// 把 refs 过滤为纯数字字符串数组（防 AI 幻觉非数字/非法 QQ）。
// 入参可为任意值；逐项 String 化后只保留全数字的，去重。
function normalizeRefs(refs) {
  const out = []
  for (const ref of Array.isArray(refs) ? refs : []) {
    const s = String(ref ?? '').trim()
    if (s && /^\d+$/.test(s) && !out.includes(s)) out.push(s)
  }
  return out
}

// item.eventInDays（整数，相对今天的天数，未来正/过去负）+ ctx.now → eventAt(epoch ms)。
// 仅在 ctx.now 存在且 eventInDays 为有限数字时计算；否则返回 undefined（省略，
// 由 makeFact 归一为 null —— 注意不能传 null，makeFact 会把 Number(null)=0 当成有效 eventAt）。
function resolveEventAt(item, ctx) {
  const now = Number(ctx.now)
  const days = Number(item.eventInDays)
  if (!Number.isFinite(now) || !Number.isFinite(days)) return undefined
  return now + days * DAY_MS
}

// 把 AI 输出的结构化数组映射为存储操作。纯函数，无网络。
// item: {route, alias?, targetQQ?, content?, tags?, refs?, confidence?, eventInDays?}
// ctx: {speakerQQ, at, now?}
export function parseAndRoute(items, ctx = {}) {
  const ops = []
  const at = Number(ctx.at) || 0
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') continue
    const route = ROUTES.has(item.route) ? item.route : null
    if (!route || route === 'ordinary_chat') continue
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
        ops.push({ stream: 'alias', qq: String(ctx.speakerQQ), text: alias, authority: 'self', confidence, by: [String(ctx.speakerQQ)], at })
      } else {
        const text = compactText(item.content, 240)
        if (text && ctx.speakerQQ) ops.push({ stream: 'entityFact', qq: String(ctx.speakerQQ), authority: 'self', fact: makeFact({ text, tags: item.tags, refs, authority: 'self', confidence, at, eventAt }) })
      }
      continue
    }

    if (route === 'user_preference') {
      const text = compactText(item.content, 240)
      if (text && ctx.speakerQQ) {
        const tags = [...new Set(['偏好', ...(item.tags || [])])]
        ops.push({ stream: 'entityFact', qq: String(ctx.speakerQQ), authority: 'self', fact: makeFact({ text, tags, refs, authority: 'self', confidence, at, eventAt }) })
      }
      continue
    }

    if (route === 'group_consensus') {
      const text = compactText(item.content, 240)
      if (text) ops.push({ stream: 'groupFact', authority: 'mention', fact: makeFact({ text, tags: item.tags, refs, authority: 'mention', confidence, at, eventAt }) })
      continue
    }
  }
  return ops
}

function extractJsonArray(text) {
  const raw = String(text || '')
  const match = raw.match(/\[[\s\S]*\]/)
  try {
    const parsed = JSON.parse(match ? match[0] : raw)
    return Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : [])
  } catch { return [] }
}

const SYSTEM_PROMPT = `你是群聊长期记忆抽取器。对每条真实用户发言，分类并抽取结构化结果，只输出 JSON 数组，不要解释。
每个元素字段：
- route: explicit_teaching | self_statement | user_preference | group_consensus | ordinary_chat
- alias: 当 route 是 explicit_teaching/self_statement 且涉及"外号/称呼"时给出别名文本
- targetQQ: explicit_teaching 中"A 是 @某人"的某人 QQ（纯数字）
- content: self_statement(非别名)/user_preference/group_consensus 的事实文本
- tags: 可选轻量标签数组（如 职业/关系/群规/梗/偏好）
- refs: 该事实涉及的其他人 QQ 数组(纯数字),如"我和@QQ:123是同事"→refs:["123"];无则省略
- confidence: 0~1
- eventInDays: 时间相关事实可附（整数，相对今天的天数，未来为正、过去为负，如"下周考试"约 7、"昨天面试"为 -1）；无明确时间则省略
规则：
- 工具结果/系统提示/机器人回复/纯语气词 -> route=ordinary_chat（会被丢弃）。
- 只有"本人在说自己"才用 self_statement；指认他人用 explicit_teaching。提到他人(同事/朋友/对手等)时把其 QQ 填入 refs。
- group_consensus 涉及具体某些人时，同样把相关人的 QQ 填入 refs。
- 普通闲聊/临时请求 -> ordinary_chat。
- 无可抽取内容时输出 []。`

export class MemoryExtractor {
  constructor(config = {}) {
    this.config = config
  }

  canUse() {
    const c = this.config.memoryAiConfig || {}
    return Boolean(c.memoryAiUrl && c.memoryAiApikey)
  }

  // 可被测试覆写。加 AbortSignal.timeout（§0.5）+ 调用计数/耗时打点（§0.3/P1-4）；
  // 失败只 inc fail + logger.warn 状态码，绝不记 prompt/fact 全文（隐私）。
  async _callChat(messages, maxTokens = 800, { timeoutMs = CHAT_TIMEOUT_MS } = {}) {
    const c = this.config.memoryAiConfig || {}
    const startedAt = Date.now()
    const boundedTimeoutMs = Math.max(500, Math.min(CHAT_TIMEOUT_MS, Number(timeoutMs) || CHAT_TIMEOUT_MS))
    try {
      const res = await fetch(c.memoryAiUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${c.memoryAiApikey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: c.memoryAiModel || 'gpt-4o-mini', messages, temperature: 0.2, max_tokens: maxTokens }),
        signal: AbortSignal.timeout(boundedTimeoutMs)
      })
      if (!res.ok) throw new Error(`记忆 AI 请求失败：${res.status}`)
      const data = await res.json()
      memStats.inc('llm.extract.call')
      memStats.observe('llm.extract.ms', Date.now() - startedAt)
      return data?.choices?.[0]?.message?.content?.trim() || '[]'
    } catch (e) {
      memStats.inc('llm.extract.fail')
      globalThis.logger?.warn?.(`[memory] extract LLM 调用失败：${e?.message || e}`)
      throw e
    }
  }

  // 返回 parseAndRoute 的 ops 数组
  async extract({ groupId, speakerQQ, messages, existingHint = '', at }) {
    if (!this.canUse()) return []
    const chatText = (messages || []).map((m, i) => `${i + 1}. ${m.content}`).join('\n')
    const userPrompt = `群 ${groupId} 发言人 QQ ${speakerQQ} 的发言：\n${chatText}\n\n已有记忆参考：\n${existingHint || '无'}\n\n请输出 JSON 数组。`
    let content
    try {
      content = await this._callChat([
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ])
    } catch {
      return []
    }
    return parseAndRoute(extractJsonArray(content), { speakerQQ, at })
  }
}
