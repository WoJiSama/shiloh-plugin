import { compactText } from './constants.js'

const TEACHING_PATTERN = /(?:^|[，,。；;\s])(?:请|麻烦)?(?:你|希洛)?\s*(?:记住|记一下|记着|记得|记好|记下来)?[，,\s]*(?:如果|要是|当|遇到)([\s\S]{1,120}?)(?:的时候|时)?\s*(?:，|,|。|；|;|\s)+(?:就|请|记得)?\s*(?:要|得|需要|可以)?\s*(?:找|通知|艾特|@|喊)\s*([\s\S]{1,180})$/i
const EXECUTION_PATTERN = /(?:帮(?:我|忙)?|麻烦|请|可以|能不能|能否|替我)?[^\n]{0,40}(?:艾特|通知|喊(?:一下|人)?|叫(?:一下|人)?)/i

function normalizeText(value = '', maxLength = 240) {
  return compactText(value, maxLength)
}

function workflowKey(value = '') {
  return String(value || '').toLowerCase().replace(/[\s，,。；;：:！!？?、@]/g, '')
}

function displayName(member = {}) {
  return String(member.card || member.nickname || member.user_id || '').trim()
}

function membersFromMap(memberMap) {
  if (!memberMap?.values) return []
  return Array.from(memberMap.values()).filter(member => member?.user_id)
}

function mentionIdsFromSegments(segments = []) {
  const ids = []
  for (const segment of Array.isArray(segments) ? segments : []) {
    if (segment?.type !== 'at') continue
    const value = segment?.qq ?? segment?.user_id ?? segment?.data?.qq ?? segment?.data?.user_id
    const id = String(value || '').trim()
    if (/^\d+$/.test(id) && !ids.includes(id)) ids.push(id)
  }
  return ids
}

function resolveTargets(targetText, memberMap, segments, excludedUserId = '') {
  const members = membersFromMap(memberMap)
  const byId = new Map(members.map(member => [String(member.user_id), member]))
  const ids = mentionIdsFromSegments(segments).filter(id => id !== String(excludedUserId || ''))
  const text = String(targetText || '')

  for (const match of text.matchAll(/(?:@QQ:|QQ[:：]?|@)(\d{5,12})/gi)) {
    const id = String(match[1])
    if (byId.has(id) && !ids.includes(id)) ids.push(id)
  }

  // Plain names are accepted only when they unambiguously identify a current member.
  const normalized = text.toLowerCase()
  const named = members
    .map(member => ({ member, name: displayName(member) }))
    .filter(item => item.name.length >= 2 && normalized.includes(item.name.toLowerCase()))
    .sort((a, b) => b.name.length - a.name.length)
  for (const item of named) {
    const id = String(item.member.user_id)
    if (!ids.includes(id)) ids.push(id)
  }

  return ids.map(userId => {
    const member = byId.get(userId)
    return { userId, displayName: displayName(member) || userId }
  })
}

export function extractExplicitGroupWorkflowRules({ text = '', messageSegments = [], memberMap, creatorQQ = '', botId = '', now = Date.now() } = {}) {
  const normalized = String(text || '')
    .replace(/\[CQ:at,[^\]]*(?:qq|user_id|id|uin)=(\d+)[^\]]*\]/g, ' @QQ:$1 ')
    .replace(/\s+/g, ' ')
    .trim()
  const match = normalized.match(TEACHING_PATTERN)
  if (!match) return []

  const condition = normalizeText(match[1], 120)
  const targetText = normalizeText(match[2].replace(/[。！!？?].*$/u, ''), 180)
  const targets = resolveTargets(targetText, memberMap, messageSegments, botId)
  if (!condition || !targets.length) return []

  return [{
    kind: 'mention_members',
    condition,
    conditionKey: workflowKey(condition),
    targetUserIds: targets.map(item => item.userId),
    targets,
    sourceText: normalizeText(normalized, 300),
    createdBy: String(creatorQQ || ''),
    at: Number(now) || Date.now(),
    enabled: true
  }]
}

export function isExplicitGroupWorkflowExecutionRequest(text = '') {
  return EXECUTION_PATTERN.test(String(text || '')) && !TEACHING_PATTERN.test(String(text || ''))
}

function relevanceScore(rule, text) {
  const query = workflowKey(text)
  const condition = workflowKey(rule?.condition)
  if (!query || !condition) return 0
  if (query.includes(condition) || condition.includes(query)) return 100 + Math.min(query.length, condition.length)
  let overlap = 0
  for (const char of new Set(condition)) if (query.includes(char)) overlap++
  return overlap / Math.max(1, new Set(condition).size)
}

export function selectRelevantGroupWorkflowRules(rules = [], text = '', limit = 12) {
  return (Array.isArray(rules) ? rules : [])
    .filter(rule => rule?.enabled !== false && rule?.kind === 'mention_members' && Array.isArray(rule.targetUserIds) && rule.targetUserIds.length)
    .map(rule => ({ rule, score: relevanceScore(rule, text) }))
    .sort((a, b) => b.score - a.score || Number(b.rule.updatedAt || b.rule.at || 0) - Number(a.rule.updatedAt || a.rule.at || 0))
    .slice(0, Math.max(1, limit))
    .map(item => item.rule)
}

export function formatGroupWorkflowExecutionPrompt(rules = [], text = '') {
  if (!isExplicitGroupWorkflowExecutionRequest(text) || !rules.length) return ''
  const lines = [
    '【已教会的群工作流 - 可执行】',
    '以下是本群成员明确教会你的通知规则，不是普通长期记忆。当前用户正在明确要求通知、艾特或喊人时，先按语义匹配条件；匹配后必须用 mentionMembersTool，并把规则给出的 targetUserIds 原样填入 targets。',
    '不要因为当前消息没有再次写出姓名就否认已知规则；但只讨论事件、没有明确执行请求时绝不主动艾特。'
  ]
  for (const rule of rules) {
    const members = (rule.targets || []).map(item => `${item.displayName || item.userId}(QQ:${item.userId})`).join('、')
    lines.push(`- [${rule.id}] 条件：${rule.condition}；动作：通知 ${members}；targets=${JSON.stringify(rule.targetUserIds)}`)
  }
  return lines.join('\n')
}

export function formatGroupWorkflowTeachingPrompt(rules = []) {
  if (!rules.length) return ''
  return [
    '【当前消息群工作流教学 - 最高优先级】',
    '用户刚明确教会了一条群内通知约定，已保存为可执行规则。自然确认已记下规则即可；当前是在教学，不要立刻艾特这些成员。',
    ...rules.map(rule => `- 条件：${rule.condition}；通知对象：${(rule.targets || []).map(item => item.displayName || item.userId).join('、')}`)
  ].join('\n')
}
