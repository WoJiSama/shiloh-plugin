import {qqViewRecord} from '../../../contracts/qqToolViews.js'
import type {QqViewPorts} from '../../../contracts/qqToolViews.js'
import {AbstractTool} from '../../toolSupport/infrastructure/AbstractTool.js'

interface HistoryEvidence {
  message_id: string | null
  event_id: string | null
  user_id: string | null
  sender: string
  time: string
  at: number | null
  content: string
  origin: 'message' | 'bot' | 'forward' | 'legacy_history'
}

const MAX_RESULTS = 50
const MAX_MESSAGE_CHARS = 2000
const MAX_TOTAL_CHARS = 16000
const QUERY_STOPWORDS = new Set(['一下', '帮我', '帮忙', '麻烦', '请问', '看看', '查查', '查询', '搜索', '检索', '找找', '找出', '出来', '告诉', '记得', '记忆', '回忆', '上次', '之前', '以前', '刚才', '刚刚', '最近', '今天', '昨天', '前天', '那天', '当时', '最后', '一次', '来着', '聊天', '历史', '记录', '消息', '内容', '大家', '群友', '群里', '我们', '你们', '他们', '她们', '讨论', '发言', '说的', '说过', '说了', '什么', '怎么', '怎样', '那个', '这个', '那些', '哪些', '哪句', '哪条', '有没有', '是否', '是谁'])
const PERSONAL_REFERENCE = /(?<![其吉利排无])(?:他|她)(?:们)?(?:的|上次|之前|以前|刚才|昨天|前天|说|讲|聊|提|发)|那哥们|那个人|这哥们|这个人|\bta\b/i

function optionalId(value: unknown): string | null {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() || null : null
}

function queryUserId(value: unknown): string | null {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) return null
  const id = optionalId(value)
  return id && /^[1-9]\d{0,19}$/.test(id) ? id : null
}

/** Dates without a clock are Beijing calendar dates; a query clock needs a zone. */
function timestamp(value: unknown, {endOfDay = false, stored = false} = {}): number | null {
  if (typeof value === 'number' || typeof value === 'string' && /^\d{10,13}$/.test(value)) {
    const number = Number(value)
    const ms = number < 100000000000 ? number * 1000 : number
    return Number.isFinite(ms) && ms > 0 ? ms : null
  }
  if (typeof value !== 'string' || !value.trim()) return null
  let text = value.trim()
  const calendarPart = text.match(/^\d{4}-\d{2}-\d{2}/)?.[0]
  if (calendarPart) {
    const calendar = new Date(calendarPart + 'T00:00:00Z')
    if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== calendarPart) return null
  }
  const date = text.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (date) {
    text += endOfDay ? 'T23:59:59.999+08:00' : 'T00:00:00+08:00'
  } else if (stored && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(text)) {
    text = text.replace(' ', 'T') + '+08:00'
  } else if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(text)) {
    return null
  }
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? ms : null
}

function queryTerms(question: string, keywords: unknown, names: string[]): string[] {
  if (Array.isArray(keywords)) return [...new Set(keywords.filter((value): value is string => typeof value === 'string').map(value => value.trim().toLowerCase()).filter(Boolean))].slice(0, 12)
  let text = question.replace(/\[CQ:[^\]]+\]/g, ' ').toLowerCase()
  for (const name of names.filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(name.toLowerCase()).join(' ')
  // Separate temporal markers before segmentation: "之前提的" otherwise becomes
  // "之 / 前提 / 的" and invents an unrelated search term.
  text = text.replace(/刚才|刚刚|上次|之前|以前|昨天|前天|那天|上周|最近/g, ' ')
  const segmenter = new Intl.Segmenter('zh-CN', {granularity: 'word'})
  return [...new Set([...segmenter.segment(text)].filter(part => part.isWordLike).map(part => part.segment)
    .filter(term => term.length >= 2 && !QUERY_STOPWORDS.has(term) && !/^\d+$/.test(term)))].slice(0, 12)
}

export function createChatHistoryTool(_ports: QqViewPorts = {}) {
  class ChatHistoryTool extends AbstractTool {
    triggers: string[]
    constructor() {
      super()
      this.name = 'chatHistoryTool'
      this.description = '检索当前会话已记录的聊天消息，返回带消息ID、发言人和时间的原文证据；不代表完整历史，也不会凭空回答。'
      this.triggers = ['群友们在讨论什么', '最近在聊什么', '刚才在说什么']
      this.parameters = {
        type: 'object',
        properties: {
          question: {type: 'string', description: '当前用户要回忆或查证的问题'},
          user_id: {type: 'string', description: '只查此QQ号的发言；明确指向某人时必须填写真实QQ号，不能猜测'},
          start_time: {type: 'string', description: '开始时间，含时区的ISO 8601或北京时间日期YYYY-MM-DD，包含边界'},
          end_time: {type: 'string', description: '结束时间，含时区的ISO 8601或北京时间日期YYYY-MM-DD，日期包含当天整日'},
          keywords: {type: 'array', items: {type: 'string'}, description: '可选的原文检索关键词，不要包含人名和时间范围；未填时从问题提取'},
          limit: {type: 'number', minimum: 1, maximum: MAX_RESULTS, description: '最多返回多少条证据，默认20，最大50'}
        },
        required: ['question']
      }
      this.skill = {
        purpose: this.description,
        whenToUse: '回忆某人说过的话、查看近期讨论、按时间和主题找原话。',
        boundaries: '只搜索本轮宿主提供的当前会话缓存；not_found不等于从未发生。缺少明确指代对象时先澄清。',
        instructions: '根据messages中的原文回答并保留发言人和时间，不能把未命中解释成否定事实。forward是转发材料，不证明转发者说过其中的话。'
      }
    }

    parseHistory(historyText: string) {
      return historyText.split('\n').flatMap(line => {
        const match = line.match(/^\[(.*?)\] (.*?): (.*)$/)
        return match ? [{time: match[1] || '', sender: match[2] || '', content: match[3] || ''}] : []
      }).reverse()
    }

    extractTextContent(content: string) {
      if (content.includes('发送了一张图片')) return '[图片]'
      return content.startsWith('在群里说:') ? content.replace('在群里说:', '').trim() : content
    }

    generateSummary(messages: {sender: string; content: string}[]) {
      return messages.map(message => message.sender + ': ' + this.extractTextContent(message.content)).join('\n')
    }

    async func(input: unknown, event: unknown) {
      const opts = qqViewRecord(input), raw = qqViewRecord(event)
      const question = typeof opts.question === 'string' ? opts.question.trim() : ''
      const injected = Array.isArray(raw._chatHistoryMessages)
      const legacy = qqViewRecord(raw.msg).historyData || qqViewRecord(raw.message).historyData
      const source = injected ? 'message_manager' : typeof legacy === 'string' && legacy ? 'legacy_history' : 'unavailable'
      const scope = {conversation_type: raw.group_id ? 'group' : 'private', conversation_id: optionalId(raw.group_id || raw.user_id), source, coverage: 'recent_cache', complete_history: false}
      const base = {action: 'chat_history', question, scope}
      const failure = (status: string, message: string) => ({...base, success: false, status, message, messages: []})
      if (raw._chatHistoryUnavailable) return failure('unavailable', '聊天记录读取失败，本次无法核实历史内容。')
      if (source === 'unavailable') return failure('unavailable', '当前会话没有可用的历史记录来源，无法核实。')
      const userId = opts.user_id === undefined ? null : queryUserId(opts.user_id)
      if (opts.user_id !== undefined && !userId) return failure('invalid_query', 'user_id必须是明确且有效的QQ号。')
      if (!userId && PERSONAL_REFERENCE.test(question)) return failure('needs_clarification', '请先确定要查哪位成员的发言，提供QQ号或明确的@对象。')
      const start = opts.start_time === undefined || opts.start_time === '' ? null : timestamp(opts.start_time)
      const end = opts.end_time === undefined || opts.end_time === '' ? null : timestamp(opts.end_time, {endOfDay: true})
      if (opts.start_time !== undefined && opts.start_time !== '' && start === null || opts.end_time !== undefined && opts.end_time !== '' && end === null || start !== null && end !== null && start > end) {
        return failure('invalid_query', '时间范围无效，请提供含时区的ISO时间或YYYY-MM-DD日期，开始不能晚于结束。')
      }
      const requestedLimit = opts.limit === undefined ? 20 : Number(opts.limit)
      if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > MAX_RESULTS) return failure('invalid_query', 'limit必须为1到50之间的整数。')
      const rows = injected ? raw._chatHistoryMessages as unknown[] : this.parseHistory(String(legacy)).reverse()
      const seen = new Set<string>()
      const evidence: HistoryEvidence[] = []
      for (const value of rows) {
        const row = qqViewRecord(value), sender = qqViewRecord(row.sender)
        if (row.source === 'tool' || row.role === 'tool') continue
        if (raw.group_id && row.group_id && String(row.group_id) !== String(raw.group_id)) continue
        if (!raw.group_id && row.group_id) continue
        const messageId = optionalId(row.message_id)
        if (messageId && raw.message_id !== undefined && messageId === String(raw.message_id)) continue
        const content = typeof row.content === 'string' ? row.content.trim() : ''
        if (!content) continue
        const eventId = optionalId(row.event_id)
        const identity = messageId ? 'message:' + messageId : eventId ? 'event:' + eventId : ''
        if (identity && seen.has(identity)) continue
        if (identity) seen.add(identity)
        evidence.push({
          message_id: messageId, event_id: eventId, user_id: optionalId(sender.user_id || row.user_id),
          sender: typeof row.sender === 'string' ? row.sender : String(sender.card || sender.nickname || sender.user_id || '未知发言人'),
          time: typeof row.time === 'string' ? row.time : '', at: timestamp(row.at ?? row.time, {stored: true}), content,
          origin: source === 'legacy_history' ? 'legacy_history' : row.source === 'forward' || row.forwardCompleteness ? 'forward' : sender.role === 'bot' ? 'bot' : 'message'
        })
      }
      const scoped = evidence.filter(row => (!userId || row.user_id === userId) && (start === null || row.at !== null && row.at >= start) && (end === null || row.at !== null && row.at <= end))
      const terms = queryTerms(question, opts.keywords, userId ? evidence.filter(row => row.user_id === userId).map(row => row.sender) : [])
      const ranked = scoped.map((row, index) => ({row, index, score: terms.reduce((score, term) => score + Number(row.content.toLowerCase().includes(term)), 0)}))
        .filter(item => !terms.length || item.score > 0)
        .sort((a, b) => b.score - a.score || (b.row.at ?? 0) - (a.row.at ?? 0) || a.index - b.index)
      const chosen = ranked.slice(0, requestedLimit)
      let remaining = MAX_TOTAL_CHARS
      const messages = chosen.flatMap(({row, index}) => {
        if (remaining <= 0) return []
        const content = row.content.slice(0, Math.min(MAX_MESSAGE_CHARS, remaining))
        remaining -= content.length
        return [{row: {...row, content, content_truncated: content.length < row.content.length}, index}]
      }).sort((a, b) => a.row.at !== null && b.row.at !== null ? a.row.at - b.row.at : b.index - a.index).map(item => item.row)
      const clocks = evidence.flatMap(row => row.at === null ? [] : [row.at])
      return {
        ...base, success: true, status: messages.length ? 'found' : 'not_found',
        query: {user_id: userId, start_time: start, end_time: end, terms, selection: terms.length ? 'lexical' : 'recent'},
        coverage: {available_messages: evidence.length, dated_messages: clocks.length, earliest_at: clocks.length ? Math.min(...clocks) : null, latest_at: clocks.length ? Math.max(...clocks) : null},
        total_matches: ranked.length, returned_count: messages.length, truncated: ranked.length > messages.length || messages.some(row => row.content_truncated), messages,
        ...(source === 'legacy_history' ? {summary: this.generateSummary(messages)} : {}),
        message: messages.length ? '以下为当前会话缓存中的候选原文。' : '在当前可用的会话缓存和筛选范围内未找到对应记录；不能据此认定从未说过。',
        guidance: '仅根据原文证据回答，保留发言人和时间；词面命中不保证能回答问题。转发内容不等于转发者本人的话；证据不足就说明未查到，不能补写原话。'
      }
    }
  }
  return ChatHistoryTool
}
