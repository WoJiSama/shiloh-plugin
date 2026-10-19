import type { SemanticMember } from '../../../contracts/toolExecution.js'

// Shared by candidate discovery and the legacy exposure signal. These identify
// a capability; the model still decides whether existing context answers it.
export const MEMBER_INFO_PATTERNS = [
  /(?:是谁|是誰|是哪位|谁来着|哪位群友|什么身份|啥身份|群名片|成员资料|成员信息|入群时间|什么时候(?:进|入)群|最后(?:一次)?发言)/u,
  /(?:查|看看|看下|看一下|给我看).{0,12}(?:他|她|这人|那人|名片|资料)/u,
  /(?:这人|那人|这位|那位|那哥们|这哥们).{0,8}(?:谁|什么人|啥人)/u,
  /(?:他|她|这位|那位|这人|那人|这个人|那个人|我).{0,16}(?:管理员|群主|头衔|昵称|名字|叫(?:什么|啥))/u
]
export const CHAT_HISTORY_PATTERNS = [
  /(?:聊天记录|群聊记录|历史消息|发言记录)/u,
  /(?:刚才|刚刚|之前|上次|昨天|前天|那天|上周|上星期|前面|最近).{0,20}(?:说(?:过|了|啥|什么|的)?|聊|讨论|发(?:过|了|啥|什么)|提(?:过|到|的)?|讲)/u,
  /(?:还记得|记不记得).{0,24}(?:说过|聊过|提过|讲过|约好|约定)/u,
  /(?:群友们?在讨论什么|最近在聊什么|刚才那句|上次那句)/u,
  /原话.{0,10}(?:翻|找|查)|(?:翻|找|查).{0,10}(?:原话|那句话)/u
]

export interface MemberContext {
  hasExcelContext?: boolean
  atQq?: (string | number)[] | undefined
  currentUserId?: string | number | null | undefined
  replyTargetUserId?: string | number | null | undefined
  memberMap?: Map<number, SemanticMember> | null | undefined
  rawText?: string | undefined
  botId?: string | number | undefined
}

const ID = /^[1-9]\d{0,19}$/u
const NO_ACTION = /(?:不要|不用|别|不必|无需).{0,10}(?:查|看|查询|搜索|获取)|(?:只是|是在).{0,8}(?:讨论|举例|转述)|(?:能不能|是否可以|支持不支持).{0,6}(?:查询|查名片|查成员)/u
const SELF_REFERENCE = /(?:我是谁|我叫(?:什么|啥)|我(?:的)?(?:群)?(?:名片|昵称|名字|资料|信息|身份|头衔|等级|入群)|我在(?:这个|本)?群(?:里|中)的(?:名片|昵称|资料|信息|身份|头衔|等级)|查(?:查|一下)?我(?:的|\b)|我什么时候(?:进|入)群|我(?:刚才|刚刚|上次|之前|以前|昨天|前天|那天|上周|最近).{0,8}(?:说|讲|聊|提|发))/u
// "其他" and "他人" are indefinite categories, not a reference to one member.
const PERSONAL_REFERENCE = /(?<![其吉利排无])(?:他|她)(?![人乡国用])|这人|那人|这个人|那个人|这位|那位|那哥们|这哥们|被回复|引用的|\bta\b/iu

export type MemberQueryTargetValidation =
  | {status: 'resolved'; userId: string; reason: string}
  | {status: 'lookup_by_name'; nickname: string; reason: string}
  | {status: 'unspecified'; reason: string}
  | {status: 'needs_clarification' | 'invalid_target'; message: string; reason: string; candidates?: string[]}

function normalizedId(id: unknown): string | null {
  if (typeof id !== 'string' && typeof id !== 'number') return null
  if (typeof id === 'number' && (!Number.isSafeInteger(id) || id <= 0)) return null
  const value = String(id).trim()
  return ID.test(value) ? value : null
}

function currentGroupHas(id: string, context: MemberContext) {
  return !context.memberMap || [...context.memberMap.entries()].some(([key, member]) => String(member.user_id ?? key) === id)
}

function clarify(reason: string, candidates?: string[]): MemberQueryTargetValidation {
  return {status: 'needs_clarification', reason, message: '当前查询对象没有唯一且可核实的指向，请明确@一位成员或提供QQ号。', ...(candidates ? {candidates} : {})}
}

function resolveIds(rawIds: unknown[], context: MemberContext, reason: string): MemberQueryTargetValidation | null {
  const supplied = rawIds.filter(id => String(id ?? '') !== String(context.botId ?? ''))
  if (!supplied.length) return null
  const ids = supplied.map(normalizedId)
  if (ids.some(id => !id)) return {status: 'invalid_target', reason: 'invalid_' + reason, message: '提供的成员QQ号无效，请明确查询对象。'}
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  if (unique.length !== 1) return clarify('multiple_' + reason, unique)
  const id = unique[0]!
  if (!currentGroupHas(id, context)) return clarify('member_not_in_current_group', unique)
  return {status: 'resolved', userId: id, reason}
}

function explicitNameMatches(text: string, context: MemberContext) {
  const content = text.toLocaleLowerCase()
  const spans: {id: string; start: number; end: number}[] = []
  for (const [key, member] of context.memberMap || []) {
    const id = normalizedId(member.user_id ?? key)
    if (!id) continue
    for (const name of [member.card, member.nickname]) {
      const normalized = String(name || '').trim().toLocaleLowerCase()
      if (normalized.length < 2) continue
      let start = content.indexOf(normalized)
      while (start !== -1) {
        spans.push({id, start, end: start + normalized.length})
        start = content.indexOf(normalized, start + normalized.length)
      }
    }
  }
  // "小明同学" identifies the longer exact name, not every member named 小明.
  return [...new Set(spans.filter(span => !spans.some(other => other.start <= span.start && other.end >= span.end && other.end - other.start > span.end - span.start)).map(span => span.id))]
}

function resolveMemberReference(text: string, context: MemberContext): MemberQueryTargetValidation {
  const rawText = context.rawText || text
  if (SELF_REFERENCE.test(text)) {
    const id = normalizedId(context.currentUserId)
    return id && currentGroupHas(id, context) ? {status: 'resolved', userId: id, reason: 'explicit_self'} : clarify('unavailable_sender')
  }
  // QQ adds an @ after the reply marker. It identifies the quoted speaker,
  // while a separate @ or name in the body can identify a different target.
  const replyPrefix = rawText.match(/^\s*\[CQ:reply[^\]]*\]\s*\[CQ:at[^\]]*(?:qq|user_id)=(\d+)[^\]]*\]/u)
  const body = replyPrefix ? rawText.slice(replyPrefix[0].length) : rawText
  const cqIds = [...body.matchAll(/\[CQ:at[^\]]*(?:qq|user_id)=([^,\]]+)/giu)].map(match => match[1])
  const eventMentions = (context.atQq || []).filter(id => !replyPrefix || String(id) !== replyPrefix[1] || cqIds.includes(String(id)))
  const mentions = resolveIds([...eventMentions, ...cqIds], context, 'mentions')
  if (mentions) return mentions
  const explicitIds = [...rawText.matchAll(/(?:qq(?:号)?[:：\s]*)([1-9]\d{0,19})(?!\d)/giu)].map(match => match[1])
  const nakedIds = [...text.matchAll(/(?:查(?:一下|查|询)?\s*|^\s*)([1-9]\d{4,19})(?=\s*(?:是(?:谁|哪位)|的?(?:名片|资料|信息|发言|聊天记录)))/gu)].map(match => match[1])
  const explicit = resolveIds([...explicitIds, ...nakedIds], context, 'explicit_ids')
  if (explicit) return explicit
  const names = explicitNameMatches(text, context)
  if (names.length > 1) return clarify('ambiguous_name', names)
  if (names.length === 1) return {status: 'resolved', userId: names[0]!, reason: 'explicit_name'}
  if (PERSONAL_REFERENCE.test(text)) {
    const reply = resolveIds(context.replyTargetUserId ? [context.replyTargetUserId] : [], context, 'reply_target')
    return reply || clarify('unresolved_reference')
  }
  return {status: 'unspecified', reason: 'no_member_reference'}
}

/** Resolve only identities grounded in this turn. Ambiguous names remain null. */
export function resolveExplicitMemberTarget(text: string, context: MemberContext = {}): string | null {
  const result = resolveMemberReference(text, context)
  return result.status === 'resolved' ? result.userId : null
}

/** Shared planner/executor boundary: membership alone cannot authorize a guessed target. */
export function validateMemberQueryTarget(text: string, params: Record<string, unknown> = {}, context: MemberContext = {}): MemberQueryTargetValidation {
  const result = resolveMemberReference(text, context)
  if (result.status !== 'unspecified') return result
  if (params.nickname !== undefined) {
    if (typeof params.nickname !== 'string' || !params.nickname.trim() || !text.toLocaleLowerCase().includes(params.nickname.trim().toLocaleLowerCase())) return clarify('ungrounded_nickname')
    const nickname = params.nickname.trim()
    if (!context.memberMap) return {status: 'lookup_by_name', nickname, reason: 'explicit_name_needs_lookup'}
    const namesOf = (member: SemanticMember) => [String(member.card || '').trim().toLocaleLowerCase(), String(member.nickname || '').trim().toLocaleLowerCase()]
    const entries = [...context.memberMap.entries()]
    const exact = entries.filter(([, member]) => namesOf(member).includes(nickname.toLocaleLowerCase()))
    const matches = exact.length ? exact : entries.filter(([, member]) => namesOf(member).some(name => name.includes(nickname.toLocaleLowerCase())))
    const ids = [...new Set(matches.map(([key, member]) => normalizedId(member.user_id ?? key)).filter((id): id is string => Boolean(id)))]
    return ids.length === 1 ? {status: 'resolved', userId: ids[0]!, reason: 'explicit_nickname'} : clarify(ids.length ? 'ambiguous_name' : 'member_not_found', ids)
  }
  if (params.user_id !== undefined) {
    if (!normalizedId(params.user_id)) return {status: 'invalid_target', reason: 'invalid_user_id', message: '提供的user_id不是有效QQ号，请明确查询对象。'}
    return clarify('ungrounded_user_id')
  }
  return result
}

export function resolveMemberInfoIntent(text: string, context: MemberContext = {}): Record<string, unknown> | null {
  if (!MEMBER_INFO_PATTERNS.some(pattern => pattern.test(text)) || NO_ACTION.test(text)) return null
  const userId = resolveExplicitMemberTarget(text, context)
  return userId ? { user_id: userId } : null
}

export function hasUnresolvedMemberReference(text: string, context: MemberContext = {}): boolean {
  const result = resolveMemberReference(text, context)
  return result.status === 'needs_clarification' || result.status === 'invalid_target'
}
