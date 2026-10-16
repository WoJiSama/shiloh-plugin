import type {DiagnosticContext, DiagnosticDamageComponent, DiagnosticDamageKind, DiagnosticEvidenceAssessment, DiagnosticIncidentStatus, DiagnosticReplyViolation, DiagnosticSignal, DiagnosticSource, DiagnosticSubject, DiagnosticTemperaturePrerequisite} from '../../../contracts/diagnosticContext.js'
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
const FIGURATIVE = /梗图|接.{0,2}梗|(?:只是|(?:真的?|其实|就)?是)(?:个|一个)?梗|玩笑|比喻|吐槽|虚构|小说|台词|表情包|电子体香|赛博香水|笑得.{0,5}冒烟/u
const HYPOTHETICAL = /如果|假如|假设|要是|倘若|万一|假想|假定|若是/u
const REPORT_CORRECTION = /刚才.{0,5}(?:说错|误报|不是事实|只是(?:个)?(?:玩笑|梗|比喻))|(?:其实|原来).{0,5}(?:是(?:个)?(?:玩笑|梗|比喻)|并没有|根本没)|并没有真的/u
const SIGNAL_PATTERNS: [DiagnosticSignal, RegExp][] = [
  ['burning_odor', /焦糊(?:味)?|焦味|糊味|烧焦(?:味)?|焦臭|烧塑料味|烧橡胶味/gu],
  ['smoke', /冒烟|烟雾/gu],
  ['fire', /起火|着火|明火/gu],
  ['electrical_fault', /漏电|电火花|电气损坏|供电损坏|电路损坏/gu]
]
interface Observation {signal: DiagnosticSignal; status: DiagnosticIncidentStatus}
type DamageFinding = DiagnosticEvidenceAssessment['damage']['findings'][number]
interface ParsedSource {source: DiagnosticSource; observations: Observation[]; correction: boolean; power?: DiagnosticContext['power']; cooled?: boolean; clearance: boolean; clearanceDenied: boolean; damageFindings: DamageFinding[]}

const DAMAGE_COMPONENTS: [DiagnosticDamageComponent, RegExp][] = [
  ['power_supply', /电源/u], ['mainboard', /主板/u], ['graphics_card', /显卡/u],
  ['cable', /线材|线缆|电线/u], ['capacitor', /电容/u]
]
const DAMAGE_WORDS = /烧坏|烧毁|烧了|烧掉|损坏|坏了|短路|电气故障/u
const PROFESSIONAL = /维修(?:师傅|人员|工程师|店|点)|专业(?:维修|检修|人员)|售后|检修(?:师傅|人员)/u
const TEMPERATURE = /温度|(?:-?\d{1,3}(?:\.\d+)?)\s*(?:℃|°\s*C|摄氏度)|TjMax|Tcase/iu
const MODEL = /\b(?:i[3579]-?\d{4,5}[a-z]{0,3}|(?:Ryzen\s*)?[Rr][3579][ -]?\d{4}[a-z]{0,4}|Ryzen\s*[3579]\s*\d{4}[a-z]{0,4}|(?:RTX|GTX)\s*\d{3,4}(?:\s*(?:Ti|SUPER))?|RX\s*\d{3,4}[a-z]{0,3}|\d{4}[xX][3D]{0,2})\b/iu
const MEASUREMENT = /CPU\s*(?:Package|Die|核心|封装|结温)|GPU\s*(?:Hot\s*Spot|核心|热点|结温)|核心温度|封装温度|结温|热点温度|热电偶|红外(?:枪|测温)|(?:测点|读数来源|传感器)(?:是|为|[:：])\s*[^，。！？!?；;\n]{1,30}/iu
const WORKLOAD = /满载|空闲|待机|烤机|游戏(?:中|时)|(?:跑|运行|执行)(?:了|着|中)?\s*(?:OCCT|Prime95|AIDA64|Cinebench|FurMark)|(?:CPU|GPU)?(?:使用率|占用率)\s*(?:是|为|[:：])?\s*\d{1,3}\s*%/iu

function componentsIn(text: string): DiagnosticDamageComponent[] {
  const components = DAMAGE_COMPONENTS.filter(([, pattern]) => pattern.test(text)).map(([component]) => component)
  return components.length ? components : ['unspecified_component']
}

function damageKind(text: string): DiagnosticDamageKind {
  return /烧坏|烧毁|烧了|烧掉|烧焦/u.test(text) ? 'burned' : /短路/u.test(text) ? 'short_circuit' : 'damaged'
}

function reportedDamageFindings(text: string): DamageFinding[] {
  if (!PROFESSIONAL.test(text) || deniesProfessionalClearance(text)) return []
  const reported = diagnosticClauses(text).filter(clause => !HYPOTHETICAL.test(clause)
    && !/[？?]|是否|有没有|吗|么|准备|打算|计划|将要|明天|稍后|尚未|还没|没有(?:确认|查出|发现)|不能(?:确认|确定)|待确认/u.test(clause)).join('，')
  if (!/(?:确认|查出|检测出|发现|诊断为|认定|确定|更换了?|换掉了?|修复了?)/u.test(reported)) return []
  const findings: DamageFinding[] = []
  for (const clause of diagnosticClauses(reported)) {
    if (!DAMAGE_WORDS.test(clause) || /没有|并无|未见|排除|不存在|不确定|可能|疑似|应该|大概|好像|似乎|估计|猜测|多半/u.test(clause)) continue
    findings.push({components: componentsIn(clause), kind: damageKind(clause)})
  }
  return findings
}

/** This projection names what is missing instead of deriving a diagnosis from a symptom. */
function evidenceAssessment(sources: DiagnosticSource[], suppliedFindings?: DamageFinding[]): DiagnosticEvidenceAssessment {
  let findings: DamageFinding[] = []
  if (suppliedFindings) findings = suppliedFindings
  else for (const source of sources) {
    // Compatibility contexts still carry provenance. A newly reported incident
    // cannot inherit the diagnosis of a part that was previously replaced.
    if ((source.incidentStatus === 'asserted' && !professionalClearance(source.text)) || REPORT_CORRECTION.test(source.text)) findings = []
    findings.push(...reportedDamageFindings(source.text))
  }
  const damage: DiagnosticEvidenceAssessment['damage'] = {status: findings.length ? 'reported_professional_finding' : 'unconfirmed', components: [...new Set(findings.flatMap(finding => finding.components))], findings}
  if (!sources.some(source => TEMPERATURE.test(source.text))) return {damage}
  let componentModel: string | undefined
  let measurementPoint: string | undefined
  let workload: string | undefined
  const readings: string[] = []
  for (const source of sources) {
    for (const text of diagnosticClauses(source.text)) {
      if (HYPOTHETICAL.test(text) || /准备|打算|计划|将要|明天|可能|大概|也许|好像|似乎|听说|据说/u.test(text)) continue
      const modelUnknown = /(?:型号.{0,5}(?:不清楚|不知道|不明|未知|没查)|(?:不知道|不清楚|没说|没查).{0,5}型号)/u.test(text)
      const model = MODEL.exec(text)?.[0] || /型号(?:是|为|[:：])\s*([a-z\d][a-z\d _-]{2,35})/iu.exec(text)?.[1]?.trim()
      if (modelUnknown) componentModel = undefined
      else if (model && !/(?:是不是|是否|型号.{0,35}(?:吗|么|[？?]))/u.test(text)) componentModel = model
      const measurementUnknown = /(?:测点|传感器|读数来源).{0,5}(?:不清楚|不知道|不明|未知)|(?:不知道|不清楚).{0,5}(?:测点|传感器|读数来源)/u.test(text)
      const measurement = MEASUREMENT.exec(text)?.[0]
      if (measurementUnknown) measurementPoint = undefined
      else if (measurement && !/(?:是不是|是否)(?:测|读)|(?:测点|传感器|读数来源).{0,35}(?:吗|么|[？?])/u.test(text)) measurementPoint = measurement
      const load = WORKLOAD.exec(text)?.[0]
      if (/(?:负载|使用率|占用率).{0,5}(?:不清楚|不知道|不明|未知)|(?:不知道|不清楚).{0,5}(?:负载|使用率|占用率)/u.test(text)) workload = undefined
      else if (load && !/(?:是不是|是否).{0,8}(?:满载|空闲|待机)|(?:满载|空闲|待机)(?:了)?(?:吗|么)/u.test(text)) workload = load
      for (const match of text.matchAll(/-?\d{1,3}(?:\.\d+)?\s*(?:℃|°\s*C|摄氏度)/giu)) readings.push(match[0])
    }
  }
  const missing: DiagnosticTemperaturePrerequisite[] = []
  if (!componentModel) missing.push('component_model')
  if (!measurementPoint) missing.push('measurement_point')
  if (!workload) missing.push('workload')
  return {damage, temperature: {readings: [...new Set(readings)].slice(-8), ...(componentModel ? {componentModel} : {}), ...(measurementPoint ? {measurementPoint} : {}), ...(workload ? {workload} : {}), missing}}
}

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
  if (/[“”「」『』"`]|(?:你(?:刚才)?说|机器人(?:说|回复)|(?:朋友|同事|室友|群友|别人|他|她|小张|小王)(?:刚才)?(?:说|表示|回复|提到)|引用|转发|原文|原话|这句.{0,3}(?:说|是))/u.test(ownText)) unresolvedAttribution = true
  return {text: ownText.trim(), unresolvedAttribution}
}

function explicitlyNonDeviceTopic(text: string): boolean {
  return !DEVICE.test(text) && /这(?:碗|锅|盘|杯|道)|面条|饭菜|炒饭|做饭|吃饭|面包|烤肉|咖啡|蛋糕|厨房|炉灶|燃气灶|火锅|香烟|烟花/u.test(text)
}

function isDiagnosticContinuation(text: string): boolean {
  const compact = text.replace(/[，。！？!?\s]/gu, '')
  return /^(?:那|然后|接下来|下一步)(?:呢|怎么办|怎么做)$|^(?:那)?(?:我)?(?:现在)?(?:该|应该|要)?(?:怎么做|怎么办)$|^(?:那)?(?:我)?(?:现在)?(?:可以|能)(?:再)?(?:试试|试一下|试一试|检查一下)(?:了)?(?:吗|么)$|^(?:那)?(?:我)?(?:现在)?(?:该|应该|要)(?:做什么|干什么)$/u.test(compact)
}

function hasFigurativeFrame(text: string): boolean {
  // A request to stop joking asserts seriousness; its word "玩笑" is not a
  // fictional frame. Remove only the denied frame so a separate real joke or
  // meme marker in the same message can still be recognized.
  const withoutDeniedFrames = text
    .replace(/(?:不是(?:在)?|并非(?:在)?|没(?:有)?(?:在)?|不|(?:请)?(?:别|不要)(?:再)?)(?:(?:跟|和)我)?开玩笑|(?:不是|并非)(?:个|一个)?(?:玩笑|梗|比喻|虚构)/gu, '')
  return FIGURATIVE.test(withoutDeniedFrames)
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

function diagnosticClauses(text: string): string[] {
  // Preserve question punctuation: removing it can turn a question into a report.
  return text.match(/[^。！？!?；;\n，,]+[。！？!?；;\n，,]*/gu) || []
}

function subjectScopedText(source: Omit<DiagnosticSource, 'incidentStatus' | 'signals'>): string {
  let subject = source.subject
  const selected: string[] = []
  for (const clause of diagnosticClauses(source.text)) {
    let explicit = explicitSubject(clause, source.userId)
    // The "I" inside an attributed quote belongs to its quoted speaker.
    if ((source.origin === 'quote' || source.origin === 'forward') && explicit?.kind === 'speaker_device' && explicit.userId === source.userId) explicit = source.subject
    if (explicit) subject = explicit
    if (subject.key === source.subject.key && clause.trim()) selected.push(clause)
  }
  return selected.join('')
}

function observations(text: string): Observation[] {
  const result: Observation[] = []
  for (const clause of text.split(/[。！？!?；;\n，,]|但是|不过|但/u)) {
    for (const [signal, pattern] of SIGNAL_PATTERNS) {
      for (const match of clause.matchAll(pattern)) {
        const prefix = clause.slice(Math.max(0, match.index - 18), match.index)
        const suffix = clause.slice(match.index + match[0].length, match.index + match[0].length + 14)
        const negated = /(?:没有|没(?:有|再)?|并无|无|未(?:见|闻到|出现)?|闻不到|看不到|不是|不曾|根本没)(?:真的|任何|明显|再|闻到|看到|出现|发生)?(?:其他|其余|别的)?[的过了]?\s*$/u.test(prefix)
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
  if (/(?:已经|已|刚刚|我刚|我已).{0,8}(?:拔(?:掉|下)?(?:了)?(?:电源(?:线)?|插头)|切断(?:了)?电源|断电)|(?:电源线|插头).{0,5}(?:已经)?拔(?:掉|下)?了|(?:我)?拔(?:掉|下)?了(?:电源(?:线)?|插头)|拔(?:掉|下)?(?:了)?(?:电源(?:线)?|插头)了|(?:已经断电|已断电|断电了)/u.test(text)) return true
  // Colloquial "拔电" still needs a completed-report marker. In particular,
  // "拔电池/电容" and a bare imperative "拔电" do not establish isolation.
  return /(?:(?:已经|已|刚刚|我刚|我已)拔(?:掉|下)?(?:了)?电(?:了)?|拔(?:掉|下)?了电(?:了)?|拔(?:掉|下)?电了)(?=$|[，。！？!?；;\s]|但|不过|然后)/u.test(text)
}

function deniesPowerOff(text: string): boolean {
  return /(?:没有|没|尚未|还没|未|并未|并没有|不是|并非)(?:有)?(?:已经|已|真的|实际)?(?:拔(?:掉|下)?(?:了)?(?:电源(?:线)?|插头|电(?=$|[，。！？!?；;\s]|了|但|不过))|断电|隔离电源)|(?:电源线|插头).{0,4}(?:没|没有|未|尚未)拔|电(?:还没|没|没有|未|尚未)拔/u.test(text)
}

function isReportedPowerOn(text: string): boolean {
  return /(?:我|现在|目前).{0,7}(?:已经|又|重新)?(?:开机了|通电了|还开着|还插着电|在运行|在满载)|还没断电|(?:电源线|插头).{0,5}还插着/u.test(text)
}

function deniesProfessionalClearance(text: string): boolean {
  return /(?:没(?:有)?|尚未|还没|未曾|并未|未).{0,6}(?:检修|检查|维修|确认|确定|排除)|(?:不能|无法|没法|不敢|尚不能)(?:确认|确定|排除)|不确定|未经(?:专业)?(?:检修|检查)|不代表.{0,8}(?:确认|排除)/u.test(text)
}

function professionalClearance(text: string): boolean {
  if (HYPOTHETICAL.test(text) || deniesProfessionalClearance(text)
    || /等(?:到)?(?:维修|检修|师傅|专业)|待.{0,5}(?:检修|排查|确认)|(?:准备|打算|计划|将要|明天|稍后|预约).{0,12}(?:检修|检查|维修|更换|确认|排除)|(?:检查|检修|维修|确认|排除).{0,14}(?:之后|以后|再开机|再通电|才(?:能|可))/u.test(text)) return false
  // A question about whether inspection happened is not evidence. An already
  // reported inspection may still be followed by a separate question about the next step.
  const clauses = diagnosticClauses(text)
  const question = /[？?]|吗|么(?:[，。]|$)|是否|是不是|有没有|能否|要不要/u
  if (clauses.some(clause => question.test(clause) && /检修|维修|师傅|专业|确认|确定|排除|检查(?:完|过|了|结束)|已(?:经)?.{0,8}检查/u.test(clause))) return false
  const reported = clauses.filter(clause => !question.test(clause)).join('，')
  return /维修(?:师傅|人员|工程师|店|点)|专业(?:维修|检修|人员)|售后|检修(?:师傅|人员)/u.test(reported)
    && /检修(?:完|完成|结束)|检查(?:完|完成|结束)|维修(?:完|完成|结束)|(?:完成了?|做完了?)(?:检修|检查|维修)|修好了|换好了|已(?:经)?.{0,8}(?:检修|检查|更换|修复)/u.test(reported)
    && /(?:确认|确定).{0,12}(?:(?:没有|不存在|无)(?:任何)?(?:其他|其余|别的)?的?(?:电气|供电|电路)(?:损坏|故障|问题)|(?:可以|能够)(?:安全)?(?:通电|开机))|(?:已(?:经)?|明确).{0,3}排除.{0,5}(?:电气|供电|电路)(?:损坏|故障)|(?:电气|供电|电路)损坏.{0,4}已(?:经)?排除/u.test(reported)
}

function parseSource(source: Omit<DiagnosticSource, 'incidentStatus' | 'signals'>): ParsedSource {
  const separated = separateQuotedText(source.text)
  const scopedText = subjectScopedText({...source, text: separated.text})
  const obs = observations(scopedText)
  const statuses = obs.map(item => item.status)
  const incidentStatus = statuses.includes('asserted') ? 'asserted' : statuses.includes('unknown') ? 'unknown' : statuses.includes('denied') ? 'denied' : statuses.includes('figurative') ? 'figurative' : 'unknown'
  // Advice, questions and hypothetical steps are not reports that those steps happened.
  const reportClauses = diagnosticClauses(scopedText).filter(clause => !HYPOTHETICAL.test(clause) && !/[？?]|(?:建议|应该|应当|先去|请你|需要先|是不是|是否|要不要|能不能|该不该|吗|么|的话|之后|以后|准备|打算|计划|将要|明天|稍后|一会儿|等会儿|待会儿|可能|大概|也许|好像|似乎|听说|据说)|(?:等(?:到)?|待)(?:它|机器)?(?:完全)?(?:冷却|凉透|放凉)|(?:冷却|凉透|放凉)后/u.test(clause))
  let power: DiagnosticContext['power'] | undefined
  for (const clause of reportClauses) {
    if (deniesPowerOff(clause)) power = 'unknown'
    else if (isReportedPowerOn(clause) || /(?:又|重新).{0,6}插(?:回|上).{0,5}(?:电源|插头)|(?:电源线|插头).{0,5}(?:又|重新)插(?:回|上)/u.test(clause)) power = 'on'
    else if (!separated.unresolvedAttribution && isReportedPowerOff(clause)) power = 'off'
  }
  const notCooled = reportClauses.some(clause => /(?:还没|没有|尚未|未)(?:完全)?(?:冷却|凉透|放凉)|(?:现在|仍然|还).{0,3}(?:烫|很热)/u.test(clause))
  const cooled = !separated.unresolvedAttribution && reportClauses.some(clause => /(?:已经|已|现在).{0,5}(?:完全)?(?:冷却|凉透|放凉)|(?:冷却|凉透|放凉)了/u.test(clause))
  const transientFactsFresh = source.origin === 'current' || source.transientFactsFresh === true
  // Old observations still establish an unresolved incident. They cannot prove
  // the plug or temperature remains in that old state now.
  if (!transientFactsFresh && power !== undefined) power = 'unknown'
  return {
    source: {...source, text: scopedText, incidentStatus, signals: [...new Set(obs.map(item => item.signal))]}, observations: obs,
    correction: REPORT_CORRECTION.test(scopedText), clearance: !separated.unresolvedAttribution && professionalClearance(scopedText), clearanceDenied: deniesProfessionalClearance(scopedText),
    damageFindings: separated.unresolvedAttribution ? [] : reportedDamageFindings(scopedText),
    ...(power ? {power} : {}),
    ...(notCooled ? {cooled: false} : cooled ? {cooled: transientFactsFresh} : {})
  }
}

/** Narrow precondition projection. Ambiguous wording never grants electrical clearance. */
export function buildDiagnosticContext(input: DiagnosticContextInput): DiagnosticContext | undefined {
  const raw = input.rawUserText.trim()
  if (explicitlyNonDeviceTopic(raw) || /换个?话题|说点别的|先不聊这个|不说这个|别聊这个|这事先不说|先不说这事/u.test(raw)) return undefined
  const now = typeof input.now === 'number' && Number.isFinite(input.now) ? input.now : Date.now()
  const userHistory = (input.history || []).filter(item => item.role === 'user' && (!input.speakerId || item.userId === input.speakerId)).slice(-12)
  const historyRelevant = userHistory.some(item => DEVICE.test(item.text) && (DIAGNOSIS.test(item.text) || observations(item.text).length > 0))
  const currentSignals = observations(raw)
  const topical = DIAGNOSIS.test(raw) || currentSignals.length > 0 || (historyRelevant && isDiagnosticContinuation(raw))
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
  if (hasFigurativeFrame(current.source.text) && !/(?:真的?|确实|实际|现在|这次).{0,8}(?:冒烟|焦糊|焦味|起火|漏电)|(?:但|不过).{0,20}(?:冒烟|焦糊|焦味|起火|漏电)/u.test(current.source.text)) {
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
    if (item.clearanceDenied) damageExclusion = 'unknown'
    else if (item.clearance) damageExclusion = 'reported_professional_clearance'
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
  const sources = relevant.map(item => item.source)
  let damageFindings: DamageFinding[] = []
  for (const item of relevant) {
    if ((item.observations.some(observation => observation.status === 'asserted') && !item.clearance) || item.correction) damageFindings = []
    damageFindings.push(...item.damageFindings)
  }
  return {purpose, subject, incident: {status, signals: [...signalStates.keys()]}, power, damageExclusion, allowedChecks, unmetPrerequisites, sources, evidenceAssessment: evidenceAssessment(sources, damageFindings)}
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
    else if (context.damageExclusion === 'reported_professional_clearance') lines.push('用户明确报告同一对象已完成专业检修并排除电气损坏；这不是独立认证。检修放行仅覆盖报告确认的对象、故障与检查范围，不保证整机绝对安全。')
    else lines.push('没有真实电气异常报告，勿凭温度或玩笑虚构烧毁；常规运行监测与断电静态观察分开，各自满足前提。')
    if (context.allowedChecks.includes('operational_monitoring')) lines.push('用户侧先确认外壳复原，再做非接触运行监测；不得安排开侧板凑近通电观察或主动嗅闻。')
    lines.push('任何硬件拆接、换插板卡或硬盘、重新插紧线缆，都必须先关机、拔下电源线并确认隔离；仅关机不等于断电。需要内部带电检测的步骤交现场专业人员按工序进行，用户不要触摸、凑近观察或嗅闻；初步点亮、BIOS读数或短时运行不能证明整机安全，风扇停转也须结合零转速策略判断。')
    if (context.sources.some(source => /温度|满载|℃|°C|TjMax|Tcase/iu.test(source.text))) lines.push('温度判断需要具体部件型号、测点与负载等依据，并结合规格、功耗、环境和实际限频情况；单个温度读数本身不能保证正常或安全。型号和测点未知时先说明判断范围或补问关键条件；正常运行、无烟无味或自动降频保护都不是整机健康证明。')
  }
  for (const source of context.sources.slice(-4)) lines.push(`依据 ${source.origin}${source.messageId ? `/${source.messageId}` : ''}${source.origin !== 'current' && !source.transientFactsFresh ? '（旧状态或时间未明，不证明当前供电和冷却状态）' : ''}：${safeTruncateUnicode(source.text, 260)}`)
  return lines.join('\n')
}

function deniesConclusion(clause: string): boolean {
  return /(?:无法|不能|尚不能|不够|不足以|没法|未能|还不能)(?:仅凭|只凭|据此|直接|就|远程|确定地)?(?:判断|确认|确定|断定|说|证明|认定|保证)|(?:不能|无法).{0,12}(?:判断|确认|断定|证明)|不代表|不等于|并非|不是说|不意味着|不说明|未必|不一定|不是(?:已经|肯定|确定|正常)|没有(?:证据|依据).{0,8}(?:确认|说明|证明)|(?:结论|判断).{0,6}(?:不能下|下不了|尚早)/u.test(clause)
}

function offersPossibility(clause: string): boolean {
  return !/大概率|很可能|多半|十有八九|基本(?:已经|确定|是|就)/u.test(clause)
    && /可能|也许|或许|不能排除|不排除|有.{0,6}风险|疑似|怀疑|待确认|尚待/u.test(clause)
}

function conditionalInspection(clause: string): boolean {
  // A user's worry, idleness or curiosity is not a diagnostic precondition.
  // Only a concrete inspection or a bounded component/specification premise
  // can make an otherwise unestablished conclusion explicitly conditional.
  return professionalOperationCondition(clause)
    || /(?:等|待|须|必须|需要).{0,25}(?:专业|维修|检修|排除电气损坏)|(?:专业|维修|检修).{0,25}(?:之后|以后|才(?:能|可))|交(?:给|由).{0,12}(?:专业|维修)|由.{0,12}(?:专业|维修).{0,12}(?:检查|检测|操作)/u.test(clause)
    || /(?:如果|假如|只有|前提是).{0,35}(?:型号|测点|传感器|负载).{0,35}(?:规格|官方|厂家|允许|上限|范围|阈值)|(?:如果|假如|只有|前提是).{0,35}(?:官方|厂家|该型号)(?:公布|规定|给出|标定)?的?(?:温度)?(?:规格|上限|范围|阈值).{0,20}(?:允许|以内|以下|范围内)/u.test(clause)
}

function professionalOperationCondition(clause: string): boolean {
  return /(?:等|待|只有|如果|须|需|必须|经).{0,30}(?:专业|维修|检修).{0,35}(?:放行|排除.{0,8}电气损坏|确认.{0,8}(?:可|能|允许)(?:安全)?(?:开机|通电))|(?:交给|交由|由).{0,15}(?:专业|维修).{0,25}(?:检测|操作|检查)/u.test(clause)
}

function isQuestion(clause: string): boolean {
  return /[？?]\s*$/u.test(clause) || /(?:是不是|是否|有没有|能不能|可不可以|吗|么)[，。；;]?\s*$/u.test(clause)
}

function damageClaim(clause: string): string | undefined {
  return /(?:元件|零件|东西|部件|电源|主板|板卡|显卡|电路|电容|线材|线缆|电线|硬件|内部|里面)[^，,。！？!?；;\n]{0,24}(?:烧坏|烧毁|烧了|烧掉|损坏|坏了|短路|电气故障)|(?:烧坏|烧毁|损坏|烧焦)(?:了|的)?(?:元件|零件|电源|主板|显卡|电容|线材|线缆|硬件)/u.exec(clause)?.[0]
}

function isDamageDiscussion(clause: string): boolean {
  return /(?:查明|排查|检查|检测|确认|确定|判断|看看|看一下).{0,18}(?:是否|有没有|哪(?:里|个)|有无).{0,12}(?:烧坏|烧毁|损坏|短路)|(?:烧坏|烧毁|损坏|短路)(?:时|后|的情况下|一般|通常|会)|(?:要|需|应|得)(?:由|请|找).{0,10}(?:维修|专业).{0,15}(?:判断|确认|检查|检测)/u.test(clause)
}

function temperatureAssurance(clause: string): boolean {
  if (/(?:是否|是不是|正常与否)|(?:正常|安全)(?:范围|区间).{0,8}(?:要|需|取决于)|(?:查看|观察|检查|监测).{0,12}(?:状态|情况|表现)/u.test(clause)) return false
  if (/(?:可以|能够|能|可|放心)(?:继续|照常)?(?:正常|安全)(?:运行|工作|使用)|(?:正常|安全)(?:运行|工作|使用)(?:没问题|就行|即可)/u.test(clause)) return true
  // Reporting that a machine has run does not itself assert that its temperature
  // is normal. A permission to keep using it is a separate positive conclusion.
  if (/(?:正常|安全)(?:运行|工作|使用)/u.test(clause)) return false
  const conclusion = /(?:正常(?:范围|区间)?|不算高|不高|没问题|没事|安全)|放心(?:用|使用|运行)/u
  if (!conclusion.test(clause)) return false
  return /温度|读数|\d{1,3}\s*(?:℃|°\s*C|度)|(?:就|很|挺|算|是|属于|在|落在|基本|完全|非常).{0,8}(?:正常|不高|没问题|没事|安全)|放心(?:用|使用|运行)|^\s*(?:正常|不算高|不高|没问题|没事|安全)/iu.test(clause)
}

function replyAssertions(text: string): string[] {
  // Contrast joins independent assertions. Its uncertainty or denial applies to
  // that assertion, not to a guarantee or action on the other side of the join.
  return diagnosticClauses(text).flatMap(clause => clause.split(/(?=但是|不过|然而|可是|但(?!凡)|却)/u)).filter(clause => clause.trim())
}

function advisesUnclearedOperation(clause: string): boolean {
  const action = /开机|通电|上电|插上电|烤机|跑(?:压力|满载)|(?:电源(?:线)?|插头).{0,6}插(?:回|上)(?:去|来)?|插(?:回|上)(?:了)?(?:电源(?:线)?|插头|电)/gu
  for (const match of clause.matchAll(action)) {
    const prefix = clause.slice(0, match.index)
    // A later "别摸内部" cannot negate an earlier "先开机". Only a
    // prohibition immediately governing this operation can do that.
    if (/(?:别|不要|不能|不可以|不建议|不允许|勿|禁止|先不|暂不|无法|不宜|避免|不该|不可|不用|无需|不需要|没必要|没有必要)(?:(?:再次|再一次|再|先|重新|直接|立即|自行|擅自|贸然|去|急着|随便|就|尝试|试着|继续)|(?:把|将)(?:电源(?:线)?|插头)|给(?:这台|那台)?(?:电脑|设备|机器|主机))*(?:把|将)?\s*$/u.test(prefix)) continue
    if (/(?:可以|能够|能|建议|先|直接|重新|试着|不妨|然后|接着|再|试试).{0,18}$/u.test(prefix)
      || /^\s*(?:(?:那|现在|你|你就|那就|还是|请|把|将)\s*)*$/u.test(prefix)) return true
  }
  return false
}

function diagnosticValidationProse(reply: string): string {
  const prose = reply.replace(/```[\s\S]*?```/gu, '')
  return prose.replace(/“([^”]*)”|「([^」]*)」|『([^』]*)』|"([^"\n]*)"|`([^`\n]*)`/gu, (quote: string, ...args: unknown[]) => {
    const offset = args[5] as number
    const text = args.slice(0, 5).find(value => typeof value === 'string') as string | undefined
    const before = prose.slice(Math.max(0, offset - 65), offset)
    const after = prose.slice(offset + quote.length, offset + quote.length + 65)
    const mentioned = /(?:例如|比如|举例|反例|示例|错误说法|错误建议|原话|引用|(?:不要|不能|不应|不该|别|勿)(?:照着|按照|照做|听信|建议|说|回复|让你说)?|不建议)\s*[:：]?\s*$/u.test(before)
      || /^\s*(?:(?:这句(?:话)?|这个(?:说法|结论|建议)|这种(?:说法|做法|建议))\s*)?(?:只是(?:个|一个)?(?:反例|示例)|(?:是|属于)(?:个|一个)?(?:错误|反例|示例)|(?:并)?(?:不能|不应|不该|不要|别)(?:照做|照着做|这么做|这么说|这样做|这样说|下|成立)|(?:现在|目前|还|现在还){0,2}不能下)/u.test(after)
    // Quotation marks alone do not turn an instruction into a harmless example.
    return mentioned ? '' : text || ''
  }).replace(/[*_#]/gu, '')
}

/**
 * High-confidence conflicts only. This function does not alter prose or claim to
 * prove an arbitrary reply correct. The caller may regenerate the whole reply
 * once using the returned evidence conflict, then use a grounded fallback.
 */
export function validateDiagnosticReply(reply: string, context?: DiagnosticContext): DiagnosticReplyViolation[] {
  if (!context || context.purpose !== 'troubleshooting' || !reply.trim()) return []
  const assessment = context.evidenceAssessment || evidenceAssessment(context.sources)
  const violations: DiagnosticReplyViolation[] = []
  const add = (code: DiagnosticReplyViolation['code'], claim: string, reason: string, correctionInstruction: string): void => {
    if (!violations.some(item => item.code === code && item.claim === claim)) violations.push({code, claim, reason, correctionInstruction})
  }
  // Analyse formatting-free text, preserving the actual reply for the sender.
  const prose = diagnosticValidationProse(reply)
  let carriedOperationCondition = false
  for (const clause of replyAssertions(prose)) {
    if (/^\s*(?:但是|不过|然而|可是|但(?!凡)|却)/u.test(clause)) carriedOperationCondition = false
    const operationConditional: boolean = carriedOperationCondition || professionalOperationCondition(clause)
    carriedOperationCondition = operationConditional && !/[。！？!?；;\n]/u.test(clause)
    if (isQuestion(clause)) continue
    const conclusionDenied = deniesConclusion(clause)
    const possible = offersPossibility(clause)
    const conditional = conditionalInspection(clause)
    const damage = damageClaim(clause)
    if (damage && !conclusionDenied && !possible && !conditional && !isDamageDiscussion(clause)) {
      const components = componentsIn(damage)
      const kind = damageKind(damage)
      const unsupported = assessment.damage.status !== 'reported_professional_finding'
        || !assessment.damage.findings.some(finding => (kind === 'damaged' || finding.kind === kind)
          && components.every(component => component === 'unspecified_component' || finding.components.includes(component)))
      if (unsupported) add('unsupported_damage_diagnosis', clause.trim(), '当前来源只支持异常症状，或没有该部件的已报告专业损坏结论。', '保留必要的停用与检修建议；明确凭这些症状不能确定烧坏了什么，可能性不能写成已确诊或大概率结论。')
    }
    if (!conclusionDenied && !possible && !conditional && /绝对安全|保证.{0,4}安全|肯定(?:没事|没有问题|没问题)|百分之百(?:正常|安全)|整机.{0,6}(?:完全正常|没有任何问题|绝对没事)/u.test(clause)) {
      add('unsupported_safety_certification', clause.trim(), '远程用户陈述和局部检查都不支持整机安全保证。', '按报告说明能确认的范围，说明检查前提与停止条件，不给整机安全保证。')
    }
    if (assessment.temperature?.missing.length && !conclusionDenied && !possible && !conditional
      && !/(?:有些|某些|部分)(?:型号|部件|处理器|设备)|对.{0,12}(?:型号|部件).{0,6}来说/u.test(clause)
      && temperatureAssurance(clause)) {
      add('unsupported_temperature_assurance', clause.trim(), `温度判断仍缺少：${assessment.temperature.missing.join('、')}。`, '先说明当前读数无法单独判断正常与否，补齐部件型号、测点和负载并对照规格；末尾补问不能抵消前面的正常或安全保证。')
    }
    if (!context.allowedChecks.includes('operational_monitoring') && !operationConditional && advisesUnclearedOperation(clause)) {
      add('unmet_operational_prerequisite', clause.trim(), '同一设备的电气异常尚未获报告专业排除，运行检测前提不成立。', '保持电源隔离，冷却后只做静态观察与专业检修；如提运行检测，必须明确以同一设备完成专业检修并放行为条件。')
    }
    if (context.damageExclusion === 'reported_professional_clearance' && !conditional
      && /电气损坏(?:仍|还|尚)(?:然)?未排除|(?:还|尚|仍)(?:没有|没)(?:完成)?(?:专业)?检修|(?:绝对|永远|一律|无论如何).{0,8}(?:不能|禁止|不可以).{0,5}(?:开机|通电)/u.test(clause)) {
      add('contradicted_professional_clearance', clause.trim(), '用户已明确报告同一设备完成专业检修和放行，不能继续把该前提写成未满足。', '采纳已报告的专业检查范围，允许外壳复原后在放行范围内的非接触运行监测；不要把它扩大为整机绝对安全。')
    }
  }
  return violations
}

/** Standalone factual reply after a bounded regeneration fails; never edits a candidate sentence. */
export function buildDiagnosticFallbackReply(context?: DiagnosticContext): string {
  if (!context) return ''
  const assessment = context.evidenceAssessment || evidenceAssessment(context.sources)
  if (context.purpose !== 'troubleshooting') return '这段是在讨论假设或比喻，还不能据此认定现实中的设备发生了故障。'
  if (context.damageExclusion === 'reported_professional_clearance') {
    return '按你补充的情况，这台设备已完成专业检修并获准在确认的范围内运行。外壳复原后，可按现场人员的要求做非接触运行监测，查看读数和是否再次出现异常；新出现焦糊味、烟雾或电火花就停止运行并联系检修人员。这份放行不等于整机安全保证。'
  }
  if (!context.allowedChecks.includes('operational_monitoring')) {
    if (context.incident.status !== 'asserted') return '目前还没确认是否出现真实电气异常，不能据此判断哪个元件已损坏。若现场确有焦糊味、烟雾或电火花，先停机隔离电源，不要开机试探，冷却后联系专业人员排查；如果只是询问假设，先说明实际观察到的现象。'
    const isolation = context.power === 'off' ? '你已报告拔电，先保持电源隔离' : '先停机并切断电源，确认拔下电源线'
    return `这些异常需要现场排查，仅凭气味或烟雾不能确定哪个元件已经烧坏。${isolation}，不要再开机试探；冷却后只做外部静态观察，并联系专业人员检修。没有烧痕、味道散了或温度降了，都不能替代专业排查。`
  }
  if (assessment.temperature) {
    const labels: Record<DiagnosticTemperaturePrerequisite, string> = {component_model: '具体部件型号', measurement_point: '测温位置或传感器名称', workload: '读数时的负载'}
    const missing = assessment.temperature.missing.map(item => labels[item])
    return missing.length
      ? `单凭这个温度读数，还不能判断是否正常。先确认${missing.join('、')}，再结合该部件的规格、功耗和实际限频情况判断。正常运行或没有烟味，也不能证明整机健康。`
      : '现有型号、测点和负载可用于对照该部件规格，结合功耗及是否限频来判断温度范围；单个读数仍不能保证整机安全。'
  }
  return '目前这些陈述还不足以确定具体故障。先分清已观察到的现象和待检查的原因，再在满足断电、冷却等前提后进行相应检查。'
}
