import { compactText } from './constants.js'

const FIRST_PERSON_POSSESSIVE = /(?:我的|我(?:在|群)?(?:里|中|里面)?的)/u

function normalizeKey(value = '') {
  return String(value || '').toLowerCase().replace(/[\s，,。；;：:！!？?、@"“”'']/g, '')
}

export function describeGroupKnowledgeEntry(entry = {}) {
  const subject = compactText(entry?.subject || '', 80) || '未命名群知识'
  if (entry?.kind === 'group_file') {
    return `“${subject}”对应群文件「${compactText(entry?.resource?.fileName || '', 180) || '未知文件'}」`
  }
  const targets = (Array.isArray(entry?.targets) ? entry.targets : [])
    .map(target => compactText(target?.displayName || target?.userId || '', 80))
    .filter(Boolean)
  return targets.length ? `“${subject}”指的是：${targets.join('、')}` : `“${subject}”`
}

// Retrieval can tolerate fuzzy overlap; deletion must match a stored name exactly.
export function findGroupKnowledgeDeletionCandidates(entries = [], { query = '', speakerQQ = '', createdBy = '' } = {}) {
  const rawQuery = compactText(query, 180)
  const normalizedQuery = normalizeKey(rawQuery)
  if (!normalizedQuery) return []
  const ownerScoped = FIRST_PERSON_POSSESSIVE.test(rawQuery)
  const requester = String(createdBy || '')
  return (Array.isArray(entries) ? entries : []).filter(entry => {
    if (!entry || entry.enabled === false) return false
    if (requester && String(entry.createdBy || '') !== requester) return false
    if (ownerScoped && String(entry.ownerQQ || '') !== String(speakerQQ || '')) return false
    const names = [entry.subject, ...(Array.isArray(entry.aliases) ? entry.aliases : []), entry.resource?.fileName]
      .map(normalizeKey).filter(Boolean)
    return names.some(name => name === normalizedQuery)
  })
}

function displayName(member = {}) {
  return compactText(member?.card || member?.nickname || member?.user_id || '', 80)
}

function membersFromMap(memberMap) {
  return memberMap?.values ? Array.from(memberMap.values()).filter(member => member?.user_id) : []
}

function normalizeFileAsset(asset = {}) {
  const fileName = compactText(asset?.fileName || asset?.name || '', 180)
  if (!fileName) return null
  return {
    fileName,
    fileId: compactText(asset?.fileId || '', 180),
    folderPath: compactText(asset?.folderPath || '', 240),
    origin: compactText(asset?.origin || 'message', 40)
  }
}

function parseJsonArray(raw = '') {
  const value = String(raw || '').trim()
  const match = value.match(/\[[\s\S]*\]/)
  try {
    const parsed = JSON.parse(match ? match[0] : value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function resolveDeclaredMemberTargets(targetNames, memberMap, botId = '') {
  const members = membersFromMap(memberMap)
  const targetIds = []
  for (const rawName of Array.isArray(targetNames) ? targetNames : []) {
    const name = compactText(rawName, 80)
    if (!name) continue
    const key = normalizeKey(name)
    const matches = members.filter(member => {
      const memberId = String(member.user_id || '')
      return memberId === name || normalizeKey(displayName(member)) === key
    })
    if (matches.length !== 1) return []
    const memberId = String(matches[0].user_id)
    if (!memberId || memberId === String(botId || '') || targetIds.includes(memberId)) continue
    targetIds.push(memberId)
  }
  return targetIds.map(userId => {
    const member = members.find(item => String(item.user_id) === userId)
    return { userId, displayName: displayName(member) || userId }
  })
}

function resolveDeclaredOwner(owner, context = {}) {
  const value = String(owner || '').toLowerCase()
  const ownerQQ = value === 'speaker'
    ? String(context.creatorQQ || '')
    : value === 'bot'
      ? String(context.botId || '')
      : /^\d+$/.test(value) ? value : ''
  if (!ownerQQ) return ''
  if (ownerQQ === String(context.creatorQQ || '') || ownerQQ === String(context.botId || '')) return ownerQQ
  return membersFromMap(context.memberMap).some(member => String(member.user_id) === ownerQQ) ? ownerQQ : ''
}

function resolveDeclaredFile(fileName, fileAssets = []) {
  const wanted = compactText(fileName, 180)
  if (!wanted) return null
  return fileAssets
    .map(normalizeFileAsset)
    .filter(Boolean)
    .find(asset => asset.fileName === wanted) || null
}

// The model decides whether this message is a deliberate long-term teaching
// request and splits it into atomic entries. Local code only verifies that a
// declared member/file exists in the current group before storing it.
export function parseSemanticGroupKnowledgeOutput(raw, context = {}) {
  return parseSemanticGroupMemoryOutput(raw, context).knowledgeEntries
}

export function parseSemanticGroupMemoryOutput(raw, context = {}) {
  const knowledgeEntries = []
  const workflowRules = []
  const aliasMappings = []
  const seen = new Set()
  for (const item of parseJsonArray(raw)) {
    if (!item || typeof item !== 'object') continue
    if (item.kind === 'alias') {
      const alias = compactText(item.alias || item.subject, 64)
      const targets = resolveDeclaredMemberTargets(item.targetNames, context.memberMap, context.botId)
      if (alias && targets.length === 1) aliasMappings.push({ alias, targetUserId: targets[0].userId, targetDisplay: targets[0].displayName })
      continue
    }
    if (item.kind === 'workflow') {
      const condition = compactText(item.condition, 120)
      const targets = resolveDeclaredMemberTargets(item.targetNames, context.memberMap, context.botId)
      const key = `workflow:${normalizeKey(condition)}:${targets.map(target => target.userId).join(',')}`
      if (!condition || !targets.length || seen.has(key)) continue
      seen.add(key)
      workflowRules.push({
        kind: 'mention_members',
        condition,
        conditionKey: normalizeKey(condition),
        targetUserIds: targets.map(target => target.userId),
        targets,
        sourceText: compactText(context.text, 300),
        sourceMessageId: String(context.sourceMessageId || ''),
        createdBy: String(context.creatorQQ || ''),
        at: Number(context.now) || Date.now(),
        enabled: true
      })
      continue
    }
    const entries = []
    const kind = ['member_definition', 'member_set', 'group_file'].includes(item.kind)
      ? item.kind
      : 'member_definition'
    const subject = compactText(item.subject, 80)
    if (!subject) continue
    const ownerQQ = resolveDeclaredOwner(item.owner, context)
    if (kind === 'group_file') {
      const resource = resolveDeclaredFile(item.resourceFileName || item.fileName, context.fileAssets)
      if (!resource) continue
      const entry = {
        kind,
        subject,
        subjectKey: normalizeKey(subject),
        aliases: ownerQQ ? [`我的${subject}`, subject] : [subject],
        ownerQQ,
        ownerDisplay: ownerQQ === String(context.creatorQQ || '') ? compactText(context.creatorDisplay, 80) : '',
        targetUserIds: [],
        targets: [],
        resource,
        sourceText: compactText(context.text, 300),
        createdBy: String(context.creatorQQ || ''),
        at: Number(context.now) || Date.now(),
        enabled: true,
        sourceMessageId: String(context.sourceMessageId || '')
      }
      const key = `${entry.kind}:${entry.ownerQQ}:${entry.subjectKey}:${entry.targetUserIds.join(',')}`
      if (!seen.has(key)) {
        seen.add(key)
        knowledgeEntries.push(entry)
      }
      continue
    }
    const targetNames = Array.isArray(item.targetNames)
      ? item.targetNames
      : [item.targetName || item.target].filter(Boolean)
    const targets = resolveDeclaredMemberTargets(targetNames, context.memberMap, context.botId)
    if (!targets.length) continue
    const entry = {
      kind: kind === 'member_set' || targets.length > 1 ? 'member_set' : 'member_definition',
      subject,
      subjectKey: normalizeKey(subject),
      aliases: ownerQQ ? [`我的${subject}`, subject] : [subject],
      ownerQQ,
      ownerDisplay: ownerQQ === String(context.creatorQQ || '') ? compactText(context.creatorDisplay, 80) : '',
      targetUserIds: targets.map(target => target.userId),
      targets,
      resource: null,
      sourceText: compactText(context.text, 300),
      createdBy: String(context.creatorQQ || ''),
      at: Number(context.now) || Date.now(),
      enabled: true,
      sourceMessageId: String(context.sourceMessageId || '')
    }
    const key = `${entry.kind}:${entry.ownerQQ}:${entry.subjectKey}:${entry.targetUserIds.join(',')}`
    if (!seen.has(key)) {
      seen.add(key)
      knowledgeEntries.push(entry)
    }
  }
  return { knowledgeEntries, workflowRules, aliasMappings }
}

function hasOwnerSpecificQuery(text = '') {
  return FIRST_PERSON_POSSESSIVE.test(String(text || ''))
}

function scoreEntry(entry, text, speakerQQ) {
  if (entry?.enabled === false) return -1
  if (hasOwnerSpecificQuery(text) && entry?.ownerQQ && String(entry.ownerQQ) !== String(speakerQQ || '')) return -1
  const query = normalizeKey(text)
  const names = [entry?.subject, ...(Array.isArray(entry?.aliases) ? entry.aliases : [])].map(normalizeKey).filter(Boolean)
  let score = 0
  for (const name of names) {
    if (query.includes(name)) score = Math.max(score, 100 + name.length)
    else {
      let overlap = 0
      for (const char of new Set(name)) if (query.includes(char)) overlap++
      score = Math.max(score, overlap / Math.max(1, new Set(name).size))
    }
  }
  if (entry?.ownerQQ && String(entry.ownerQQ) === String(speakerQQ || '') && hasOwnerSpecificQuery(text)) score += 80
  return score
}

export function selectRelevantGroupKnowledge(entries = [], { text = '', speakerQQ = '', limit = 8 } = {}) {
  return (Array.isArray(entries) ? entries : [])
    .map(entry => ({ entry, score: scoreEntry(entry, text, speakerQQ) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score || Number(b.entry.updatedAt || b.entry.at || 0) - Number(a.entry.updatedAt || a.entry.at || 0))
    .slice(0, Math.max(1, limit))
    .map(item => item.entry)
}

function targetText(entry = {}) {
  return (entry.targets || []).map(item => `${item.displayName || item.userId}(QQ:${item.userId})`).join('、')
}

export function formatGroupKnowledgePrompt(entries = [], { speakerQQ = '' } = {}) {
  if (!entries.length) return ''
  const lines = [
    '【已教会的群知识 - 可回答】',
    '以下是本群成员明确提供的稳定定义。当前问题与其相关时应直接准确回答，不要说没有记录，也不要编造文件内容、成员职责或下载链接。'
  ]
  for (const entry of entries) {
    if (entry.kind === 'group_file') {
      const owner = entry.ownerQQ && String(entry.ownerQQ) === String(speakerQQ || '') ? '当前发言者' : (entry.ownerQQ ? `QQ:${entry.ownerQQ}` : '群内成员')
      const file = entry.resource || {}
      lines.push(`- ${owner} 的“${entry.subject}”对应群文件「${file.fileName || '未知文件名'}」${file.folderPath ? `（路径：${file.folderPath}）` : ''}。`)
    } else {
      const owner = entry.ownerQQ && String(entry.ownerQQ) === String(speakerQQ || '') ? '当前发言者的' : (entry.ownerQQ ? `QQ:${entry.ownerQQ} 的` : '')
      lines.push(`- ${owner}“${entry.subject}”指的是：${targetText(entry)}。`)
    }
  }
  return lines.join('\n')
}

export function formatGroupKnowledgeTeachingPrompt(entries = []) {
  if (!entries.length) return ''
  return [
    '【当前消息群知识教学 - 最高优先级】',
    '用户刚明确教会了一条群内定义，已保存为可回答知识。自然确认记下即可，不要捏造文件内容或额外关系。',
    ...entries.map(entry => entry.kind === 'group_file'
      ? `- “${entry.subject}” = 群文件「${entry.resource?.fileName || ''}」`
      : `- “${entry.subject}” = ${targetText(entry)}`)
  ].join('\n')
}
