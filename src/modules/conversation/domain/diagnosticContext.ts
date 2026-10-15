import type {DiagnosticContext, DiagnosticIncidentStatus, DiagnosticSignal, DiagnosticSource, DiagnosticSubject} from '../../../contracts/diagnosticContext.js'
import type {TurnEvidence} from '../../../contracts/turnInteraction.js'
import {safeTruncateUnicode} from '../../models/domain/unicodeText.js'

export interface DiagnosticHistoryMessage {
  role: 'user' | 'assistant'
  userId?: string
  text: string
  messageId?: string
  /** Milliseconds since epoch. Untimed history cannot establish current physical state. */
  at?: number
  /** Compatibility input: epoch milliseconds or an ISO timestamp with an explicit timezone. */
  time?: number | string
}
export interface DiagnosticContextInput {
  rawUserText: string
  speakerId?: string
  evidence?: TurnEvidence[]
  /** Caller supplies chronological messages from this conversation; roles remain mandatory. */
  history?: DiagnosticHistoryMessage[]
  now?: number
}

const TRANSIENT_FACT_FRESHNESS_MS = 5 * 60_000
const SOURCE_CLOCK_TOLERANCE_MS = 5000

function historyTimestamp(message: DiagnosticHistoryMessage): number | undefined {
  if (message.at !== undefined) return Number.isFinite(message.at) ? message.at : undefined
  if (typeof message.time === 'number') return Number.isFinite(message.time) ? message.time : undefined
  // Do not interpret timezone-less history using whichever timezone the server has.
  if (typeof message.time !== 'string' || !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:?\d{2})$/u.test(message.time)) return undefined
  const parsed = Date.parse(message.time)
  return Number.isFinite(parsed) ? parsed : undefined
}

const DEVICE = /电脑|台式机|主机|机箱|电源|插排|插座|主板|显卡|CPU|GPU|服务器|笔记本|风扇|水泵|散热器|机器|设备/iu
const DIAGNOSIS = /排查|故障|维修|检修|修好|散热|降温|温度|满载|℃|°C|开机|通电|断电|电源线|拔.{0,3}插头|怎么办|怎么处理|怎么检查|能继续用|能用了吗|能开吗|风扇|水泵/iu
const FIGURATIVE = /梗图|接.{0,2}梗|玩笑|比喻|吐槽|虚构|小说|台词|表情包|电子体香|赛博香水|笑得.{0,5}冒烟/u
const HYPOTHETICAL = /如果|假如|假设|要是|倘若|万一|假想|假定|若是/u
const REPORT_CORRECTION = /刚才.{0,5}(?:说错|误报|不是事实|只是(?:个)?(?:玩笑|梗|比喻))|(?:其实|原来).{0,5}(?:是(?:个)?(?:玩笑|梗|比喻)|并没有|根本没)|并没有真的/u
const SIGNAL_PATTERNS: [DiagnosticSignal, RegExp][] = [
  ['burning_odor', /焦糊(?:味)?|焦味|糊味|烧焦(?:味)?|焦臭|烧塑料味|烧橡胶味/gu],
  ['smoke', /冒烟|烟雾/gu],
  ['fire', /起火|着火|明火/gu],
  ['electrical_fault', /漏电|电火花|电气损坏|供电损坏|电路损坏/gu]
]
interface Observation {signal: DiagnosticSignal; status: DiagnosticIncidentStatus}
interface ParsedSource {source: DiagnosticSource; observations: Observation[]; correction: boolean; power?: DiagnosticContext['power']; cooled?: boolean; clearance: boolean}

/** Stored user messages can contain somebody else's quoted words. Keep only their own prose. */
function separateQuotedText(text: string): {text: string; unresolvedAttribution: boolean} {
  let ownText = ''
  let unresolvedAttribution = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (char !== '[') {ownText += char; continue}
    let end = index + 1
    let depth = 1
    for (; end < text.length && depth > 0; end++) {
      if (text[end] === '[') depth++
      else if (text[end] === ']') depth--
    }
    const bracket = text.slice(index, end)
    const knownQuote = /^\[(?:回复|引用|转发|合并转发)/u.test(bracket)
    if (!knownQuote) unresolvedAttribution = true
    // Unclosed or unfamiliar wrappers cannot establish physical prerequisites.
    if (depth !== 0) unresolvedAttribution = true
    ownText += '，'
    index = end - 1
  }
  const beforeQuotes = ownText
  ownText = ownText.replace(/“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|`[^`\n]*`/gu, '，')
  if (ownText !== beforeQuotes) unresolvedAttribution = true
  if (/[“”「」『』"`]|(?:你(?:刚才)?说|机器人(?:说|回复)|引用|转发|原文|原话|这句.{0,3}(?:说|是))/u.test(ownText)) unresolvedAttribution = true
  return {text: ownText.trim(), unresolvedAttribution}
}

function explicitlyNonDeviceTopic(text: string): boolean {
  return !DEVICE.test(text) && /这(?:碗|锅|盘|杯|道)|面条|饭菜|炒饭|面包|烤肉|咖啡|蛋糕|厨房|炉灶|燃气灶|火锅|香烟|烟花/u.test(text)
}

function hasFigurativeFrame(text: string): boolean {
  return FIGURATIVE.test(text.replace(/不是(?:在)?开玩笑|不开玩笑|没开玩笑|不是玩笑/gu, ''))
}

function ownSubject(speakerId?: string, another = false): DiagnosticSubject {
  return {kind: 'speaker_device', key: `speaker:${speakerId || 'current'}:${another ? 'another' : 'current'}`, label: another ? '当前用户的另一台设备' : '当前用户所说的设备', ...(speakerId ? {userId: speakerId} : {})}
}

function explicitSubject(text: string, speakerId?: string): DiagnosticSubject | undefined {
  const mentions: {index: number; subject: DiagnosticSubject}[] = []
  for (const match of text.matchAll(/(我朋友|朋友|同事|室友|群友|别人|小张|小王|他|她)(?:的|那台|这台)?(?:台式机|电脑|主机|机箱|电源|机器|设备|笔记本)/gu)) {
    mentions.push({index: match.index, subject: {kind: 'third_party_device', key: `third:${match[1]!.replace(/^我/u, '')}`, label: match[0]}})
  }
  for (const match of text.matchAll(/(?:我(?:的)?另(?:一)?台|另(?:一)?台)(?:电脑|主机|机器|设备|笔记本)/gu)) mentions.push({index: match.index, subject: ownSubject(speakerId, true)})
  for (const match of text.matchAll(/(?:我(?:的)?|我这台)(?:电脑|主机|机箱|电源|机器|设备|笔记本)/gu)) mentions.push({index: match.index, subject: ownSubject(speakerId)})
  return mentions.sort((a, b) => a.index - b.index).at(-1)?.subject
}

function subjectScopedText(source: Omit<DiagnosticSource, 'incidentStatus' | 'signals'>): string {
  let subject = source.subject
  const selected: string[] = []
  for (const clause of source.text.split(/[。！？!?；;\n，,]/u)) {
    let explicit = explicitSubject(clause, source.userId)
    // The "I" inside an attributed quote belongs to its quoted speaker.
    if ((source.origin === 'quote' || source.origin === 'forward') && explicit?.kind === 'speaker_device' && explicit.userId === source.userId) explicit = source.subject
    if (explicit) subject = explicit
    if (subject.key === source.subject.key && clause.trim()) selected.push(clause)
  }
  return selected.join('，')
}

function observations(text: string): Observation[] {
  const result: Observation[] = []
  for (const clause of text.split(/[。！？!?；;\n，,]|但是|不过|但/u)) {
    for (const [signal, pattern] of SIGNAL_PATTERNS) {
      for (const match of clause.matchAll(pattern)) {
        const prefix = clause.slice(Math.max(0, match.index - 18), match.index)
        const suffix = clause.slice(match.index + match[0].length, match.index + match[0].length + 14)
        const negated = /(?:没有|没(?:有|再)?|并无|无|未(?:见|闻到|出现)?|闻不到|看不到|不是|不曾|根本没)(?:真的|任何|明显|再|闻到|看到|出现|发生)?[的过了]?\s*$/u.test(prefix)
        const figurative = hasFigurativeFrame(clause) && !/(?:真的?|确实|实际|现在).{0,6}$/u.test(prefix)
        const hypothetical = HYPOTHETICAL.test(clause) || /(?:是否|有没有|会不会|会|可能(?:会)?|疑似)\s*$/u.test(prefix) || /^(?:了)?(?:吗|么|的话|怎么办才好)/u.test(suffix)
        const status: DiagnosticIncidentStatus = negated ? 'denied' : figurative ? 'figurative' : hypothetical ? 'unknown' : 'asserted'
        result.push({signal, status})
      }
    }
  }
  return result
}

function isReportedPowerOff(text: string): boolean {
  return /(?:已经|已|刚刚|我刚|我已).{0,8}(?:拔(?:掉|下)?(?:了)?(?:电源(?:线)?|插头)|切断(?:了)?电源|断电)|(?:电源线|插头).{0,5}(?:已经)?拔(?:掉|下)?了|(?:我)?拔(?:掉|下)?了(?:电源(?:线)?|插头)|拔(?:掉|下)?(?:了)?(?:电源(?:线)?|插头)了|(?:已经断电|已断电|断电了)/u.test(text)
}

function isReportedPowerOn(text: string): boolean {
  return /(?:我|现在|目前).{0,7}(?:已经|又|重新)?(?:开机了|通电了|还开着|还插着电|在运行|在满载)|还没断电|(?:电源线|插头).{0,5}还插着/u.test(text)
}

function professionalClearance(text: string): boolean {
  if (HYPOTHETICAL.test(text) || /尚未|还没|未曾|没排除|未排除|不能确认|不确定|没法确认|吗|么(?:[，。]|$)|是否|是不是|有没有|能否|要不要|等(?:到)?(?:维修|检修|师傅|专业)|待.{0,5}(?:检修|排查|确认)|(?:确认|排除).{0,14}(?:之后|以后|再开机|再通电|才(?:能|可))/u.test(text)) return false
  return /维修(?:师傅|人员|工程师|店|点)|专业(?:维修|检修|人员)|售后|检修(?:师傅|人员)/u.test(text)
    && /检修(?:完|完成|结束)|检查(?:完|完成|结束)|维修(?:完|完成|结束)|修好了|换好了|已经.{0,5}(?:检修|检查|更换|修复)/u.test(text)
    && /(?:确认|确定).{0,12}(?:(?:没有|不存在|无)(?:电气|供电|电路)(?:损坏|故障|问题)|(?:可以|能够)(?:安全)?(?:通电|开机))|(?:已(?:经)?|明确).{0,3}排除.{0,5}(?:电气|供电|电路)(?:损坏|故障)|(?:电气|供电|电路)损坏.{0,4}已(?:经)?排除/u.test(text)
}

function parseSource(source: Omit<DiagnosticSource, 'incidentStatus' | 'signals'>): ParsedSource {
  const separated = separateQuotedText(source.text)
  const scopedText = subjectScopedText({...source, text: separated.text})
  const obs = observations(scopedText)
  const statuses = obs.map(item => item.status)
  const incidentStatus = statuses.includes('asserted') ? 'asserted' : statuses.includes('unknown') ? 'unknown' : statuses.includes('denied') ? 'denied' : statuses.includes('figurative') ? 'figurative' : 'unknown'
  // Advice, questions and hypothetical steps are not reports that those steps happened.
  const reportClauses = scopedText.split(/[。！？!?；;\n，,]/u).filter(clause => !HYPOTHETICAL.test(clause) && !/(?:建议|应该|应当|先去|请你|需要先|是不是|是否|要不要|能不能|该不该|吗|么|的话|之后|以后)/u.test(clause))
  let power: DiagnosticContext['power'] | undefined
  for (const clause of reportClauses) {
    if (/(?:没有|没|尚未|还没|未)(?:有)?(?:拔(?:掉|下)?(?:电源(?:线)?|插头)|断电|隔离电源)|(?:电源线|插头).{0,4}(?:没|没有|未|尚未)拔/u.test(clause)) power = 'unknown'
    else if (isReportedPowerOn(clause) || /(?:又|重新).{0,6}插(?:回|上).{0,5}(?:电源|插头)|(?:电源线|插头).{0,5}(?:又|重新)插(?:回|上)/u.test(clause)) power = 'on'
    else if (!separated.unresolvedAttribution && isReportedPowerOff(clause)) power = 'off'
  }
  const notCooled = reportClauses.some(clause => /(?:还没|没有|尚未|未)(?:完全)?(?:冷却|凉透)|(?:现在|仍然|还).{0,3}(?:烫|很热)/u.test(clause))
  const cooled = !separated.unresolvedAttribution && reportClauses.some(clause => /(?:已经|已|现在).{0,5}(?:完全)?(?:冷却|凉透)|(?:冷却|凉透)了/u.test(clause))
  const transientFactsFresh = source.origin === 'current' || source.transientFactsFresh === true
  // Old observations still establish an unresolved incident. They cannot prove
  // the plug or temperature remains in that old state now.
  if (!transientFactsFresh && power !== undefined) power = 'unknown'
  return {
    source: {...source, text: scopedText, incidentStatus, signals: [...new Set(obs.map(item => item.signal))]}, observations: obs,
    correction: REPORT_CORRECTION.test(scopedText), clearance: !separated.unresolvedAttribution && professionalClearance(scopedText),
    ...(power ? {power} : {}),
    ...(notCooled ? {cooled: false} : cooled ? {cooled: transientFactsFresh} : {})
  }
}

/** Narrow precondition projection. Ambiguous wording never grants electrical clearance. */
export function buildDiagnosticContext(input: DiagnosticContextInput): DiagnosticContext | undefined {
  const raw = input.rawUserText.trim()
  if (explicitlyNonDeviceTopic(raw)) return undefined
  const now = typeof input.now === 'number' && Number.isFinite(input.now) ? input.now : Date.now()
  const userHistory = (input.history || []).filter(item => item.role === 'user' && (!input.speakerId || item.userId === input.speakerId)).slice(-12)
  const historyRelevant = userHistory.some(item => DEVICE.test(item.text) && (DIAGNOSIS.test(item.text) || observations(item.text).length > 0))
  const currentSignals = observations(raw)
  const topical = DIAGNOSIS.test(raw) || currentSignals.length > 0 || (historyRelevant && /^(?:那|然后|接下来)(?:呢|怎么办)[？?。!！\s]*$/u.test(raw))
  if (!topical) return undefined
  if (!DIAGNOSIS.test(raw) && currentSignals.length === 0 && !historyRelevant) return undefined

  let inherited = ownSubject(input.speakerId)
  const parsed: ParsedSource[] = []
  for (const item of userHistory) {
    if (!DEVICE.test(item.text) && !DIAGNOSIS.test(item.text) && observations(item.text).length === 0) continue
    inherited = explicitSubject(item.text, input.speakerId) || inherited
    const at = historyTimestamp(item)
    const transientFactsFresh = at !== undefined && at <= now + SOURCE_CLOCK_TOLERANCE_MS && now - at <= TRANSIENT_FACT_FRESHNESS_MS
    parsed.push(parseSource({origin: 'history', text: safeTruncateUnicode(item.text, 1200), subject: inherited, transientFactsFresh, ...(at !== undefined ? {at} : {}), ...(item.userId ? {userId: item.userId} : {}), ...(item.messageId ? {messageId: item.messageId} : {})}))
  }

  const currentExplicitSubject = explicitSubject(raw, input.speakerId)
  const refersToQuote = /引用|转发|朋友|同事|室友|群友|他|她|这段|这句|上面/u.test(raw)
  const attributableQuotes = (input.evidence || []).filter(item => (item.origin === 'quote' || item.origin === 'forward') && item.state === 'readable' && item.kind === 'text' && item.text && item.speaker?.userId)
  let quoteSubject: DiagnosticSubject | undefined
  if (refersToQuote && !currentExplicitSubject) {
    for (const item of attributableQuotes) {
      const userId = item.speaker!.userId!
      quoteSubject = userId === input.speakerId ? inherited : {kind: 'third_party_device', key: `quote:${userId}`, label: `${item.speaker?.name || userId}所说的设备`, userId}
      parsed.push(parseSource({origin: item.origin as 'quote' | 'forward', text: safeTruncateUnicode(item.text!, 1200), subject: quoteSubject, userId, transientFactsFresh: false, ...(item.messageId ? {messageId: item.messageId} : {})}))
    }
  }
  const subject = currentExplicitSubject || quoteSubject || inherited
  const current = parseSource({origin: 'current', text: safeTruncateUnicode(raw, 1600), subject, at: now, transientFactsFresh: true, ...(input.speakerId ? {userId: input.speakerId} : {})})
  // An explicitly fictional frame covers quoted words as well, unless the user reports a new real incident.
  if (hasFigurativeFrame(raw) && !/(?:真的?|确实|实际|现在|这次).{0,8}(?:冒烟|焦糊|焦味|起火|漏电)|(?:但|不过).{0,20}(?:冒烟|焦糊|焦味|起火|漏电)/u.test(raw)) {
    current.observations = current.observations.map(item => ({...item, status: 'figurative'}))
    current.source.incidentStatus = 'figurative'
  }
  parsed.push(current)

  const relevant = parsed.filter(item => item.source.subject.key === subject.key)
  const signalStates = new Map<DiagnosticSignal, DiagnosticIncidentStatus>()
  let power: DiagnosticContext['power'] = 'unknown'
  let cooled = false
  let damageExclusion: DiagnosticContext['damageExclusion'] = 'unknown'
  for (const item of relevant) {
    for (const obs of item.observations) {
      const previous = signalStates.get(obs.signal)
      if (previous !== 'asserted' || obs.status === 'asserted' || item.correction) signalStates.set(obs.signal, obs.status)
      if (obs.status === 'asserted' && (item.source.origin === 'current' || !item.clearance)) {damageExclusion = 'unknown'; cooled = false}
    }
    if (item.power) {power = item.power; if (power === 'on') cooled = false}
    if (item.cooled !== undefined) cooled = item.cooled
    if (item.clearance) damageExclusion = 'reported_professional_clearance'
  }
  const states = [...signalStates.values()]
  const status: DiagnosticIncidentStatus = states.includes('asserted') ? 'asserted' : states.includes('unknown') ? 'unknown' : states.includes('denied') ? 'denied' : states.includes('figurative') ? 'figurative' : 'unknown'
  const purpose: DiagnosticContext['purpose'] = status === 'figurative' ? 'figurative' : HYPOTHETICAL.test(raw) && !historyRelevant ? 'discussion' : 'troubleshooting'
  const unresolvedIncident = (status === 'asserted' || (status === 'unknown' && signalStates.size > 0)) && damageExclusion !== 'reported_professional_clearance'
  const allowedChecks: DiagnosticContext['allowedChecks'] = purpose !== 'troubleshooting' ? [] : unresolvedIncident ? ['static_observation'] : ['static_observation', 'operational_monitoring']
  const unmetPrerequisites: DiagnosticContext['unmetPrerequisites'] = []
  if (purpose === 'troubleshooting') {
    if (power !== 'off') unmetPrerequisites.push('power_isolated')
    if (!cooled) unmetPrerequisites.push('cooled')
    if (unresolvedIncident) unmetPrerequisites.push('electrical_damage_excluded')
  }
  return {purpose, subject, incident: {status, signals: [...signalStates.keys()]}, power, damageExclusion, allowedChecks, unmetPrerequisites, sources: relevant.map(item => item.source)}
}

export function buildDiagnosticContextPrompt(context?: DiagnosticContext): string {
  if (!context) return ''
  const statusLabels: Record<DiagnosticIncidentStatus, string> = {asserted: '用户有真实异常报告', denied: '明确否认这些异常', figurative: '比喻或虚构素材', unknown: '未确认真实电气异常'}
  const lines = ['【本轮排障前提】', `对象：${context.subject.label}。${statusLabels[context.incident.status]}；来源是用户陈述，不是远程检验结论。`, `供电隔离：${context.power === 'off' ? '用户已报告拔线或隔离' : context.power === 'on' ? '用户报告仍连接或运行' : '未确认；提出断电建议不代表已经断电'}。`]
  if (context.purpose !== 'troubleshooting') {
    lines.push('当前是在讨论假设或表达比喻，没有据此要求操作真实设备。按当前问题回应，不把素材中的异常变成说话人的现实事故。')
  } else {
    if (context.allowedChecks.includes('static_observation')) lines.push('静态观察以实际停机、隔离电源并冷却为前提；它不能验证风扇、水泵正在运行。尚缺前提须作为先后条件说明，不得写成已执行。')
    if (context.unmetPrerequisites.includes('electrical_damage_excluded')) lines.push('电气损坏仍未排除：本轮只可安排隔离、冷却后的静态观察及专业检修，运行检测的前提尚不成立。没有烧痕、气味散去或温度下降均不是专业排除电气损坏的证据。')
    else if (context.damageExclusion === 'reported_professional_clearance') lines.push('用户明确报告同一对象已完成专业检修并排除电气损坏；这不是独立认证。仅在报告确认的范围、外壳复原且不接触带电或运动部件的条件下描述运行监测。')
    else lines.push('没有真实电气异常报告，勿凭温度或玩笑虚构烧毁；常规运行监测与断电静态观察分开，各自满足前提。')
  }
  for (const source of context.sources.slice(-4)) lines.push(`依据 ${source.origin}${source.messageId ? `/${source.messageId}` : ''}${source.origin !== 'current' && !source.transientFactsFresh ? '（旧状态或时间未明，不证明当前供电和冷却状态）' : ''}：${safeTruncateUnicode(source.text, 260)}`)
  return lines.join('\n')
}
