import type {TurnActionFacts, TurnTaskFact} from '../../../contracts/turnActionFacts.js'

export interface ActionReplyViolation {
  code: 'unregistered_followup' | 'unsupported_task_state' | 'unsupported_delivery'
  claim: string
  reason: string
  correctionInstruction: string
}

interface ReplySentence {text: string; question: boolean}

function withoutQuotations(text: string): string {
  return text.replace(/```[\s\S]*?```|`[^`\n]*`|“[^”\n]*”|‘[^’\n]*’|「[^」\n]*」|『[^』\n]*』|"[^"\n]*"|'[^'\n]*'/gu, '')
}

/** Preserve question punctuation so an interrogative cannot become a claim. */
function assertions(text: string): ReplySentence[] {
  return [...withoutQuotations(text).matchAll(/[^。！？!?；;\n]+[。！？!?；;]?/gu)]
    .map(match => ({text: match[0].replace(/[。！？!?；;]+$/u, '').trim(), question: /[？?]$/u.test(match[0])}))
    .filter(sentence => Boolean(sentence.text))
}

const NON_ASSERTION = /不能(?:确认|说明|证明|保证|承诺|断定|说)|无法(?:确认|核实|保证)|不(?:确定|清楚|保证|承诺|代表|等于|证明)|没(?:有)?证据|未确认|没确认|尚不知|还不知道|不是|并非|是否|有没有|能否|是不是|会不会|不一定|可能|也许|似乎/u
const WORDING_EXAMPLE = /例如|比如|举例|示例|假设|这句话|这种说法|这段话|不要(?:说|写|回复)|别(?:说|写|回复)|不能(?:说|写|回复)|(?:用户|别人|他|她|你)(?:说|问|写)(?:的|过|了)?/u
const OTHER_SUBJECT = /^(?:(?:我|你)(?:妈|爸|姐姐|妹妹|哥哥|弟弟|朋友|同事)|姐姐|妹妹|哥哥|弟弟|妈妈|爸爸|他(?:们)?|她(?:们)?|CPU|GPU|电脑|设备|程序|服务器)/iu
const TASK_TOPIC = /(?:任务|出图|生成|改图|画图|重跑|重试|进度|回执|投递)|(?:图(?:片)?|成品|结果|文件).{0,16}(?:出来|好了吗|做好|完成|发给我|发我|发送|发出|发了|怎么样)/u

type EvidenceTopic = 'image' | 'video' | 'file' | 'artifact' | 'reminder' | 'generic' | 'unknown' | 'ambiguous'
function evidenceTopic(rawText: string): EvidenceTopic {
  const text = withoutQuotations(rawText)
  if (WORDING_EXAMPLE.test(text)) return 'unknown'
  const reminder = /提醒|闹钟/u.test(text)
  // “图好了提醒我” describes a completion callback, not a clock alarm.
  const artifactCompletion = /(?:图(?:片)?|成品|结果|文件|出图|生成|改图|画图)/u.test(text) && completionBefore(text) >= 0
  if (reminder && !artifactCompletion) return 'reminder'
  const kinds: EvidenceTopic[] = []
  if (/图片|成品图|成图|出图|改图|画图|(?:第[一二三四五六七八九十\d]+张|这张|那张|原图)|图(?=已经|已|还|尚|没|未|正|在|生成|出来|好|发|一|了|呢|吗|，|,|$)/u.test(text)) kinds.push('image')
  if (/视频|影片/u.test(text)) kinds.push('video')
  if (/文件|报告|表格|工作簿|Excel|文档|PDF/iu.test(text)) kinds.push('file')
  if (kinds.length > 1) return 'ambiguous'
  if (kinds[0]) return kinds[0]
  if (/成品|产物|结果/u.test(text)) return 'artifact'
  return TASK_TOPIC.test(text) ? 'generic' : 'unknown'
}

function taskTopic(task: TurnTaskFact): EvidenceTopic {
  if (task.source === 'reminder') return 'reminder'
  if (/image|banana|draw|paint|pixiv|dalle|flux/iu.test(task.toolName)) return 'image'
  if (/video|media|torrent/iu.test(task.toolName)) return 'video'
  if (/excel|workbook|file|document|report|pdf|word|sheet/iu.test(task.toolName)) return 'file'
  return 'generic'
}

/** The caller validates ownership and request references; this boundary must
 * still avoid borrowing a reminder receipt or another kind of artifact. */
function uniqueMatchingTasks(tasks: TurnTaskFact[], topic: EvidenceTopic): TurnTaskFact[] {
  if (topic === 'ambiguous') return []
  const candidates = tasks.filter(task => {
    if (topic === 'unknown') return true
    if (topic === 'reminder') return task.source === 'reminder'
    if (task.source === 'reminder') return false
    return topic === 'artifact' || topic === 'generic' || taskTopic(task) === topic
  })
  return candidates.length === 1 ? candidates : []
}

function hasTaskContext(facts: TurnActionFacts | undefined, rawUserText: string): boolean {
  if (facts?.tasks.some(task => task.source !== 'reminder')) return true
  const text = withoutQuotations(rawUserText)
  return !WORDING_EXAMPLE.test(text) && TASK_TOPIC.test(text)
}

function unasserted(clause: string, question = false): boolean {
  return question || /[吗么](?:[呀啊呢]*)$/u.test(clause) || NON_ASSERTION.test(clause) || WORDING_EXAMPLE.test(clause)
}

// Only these grammatical subjects establish task scope by themselves. Loose
// substrings such as “姐姐已经做好了饭” and “CPU正在处理指令” do not.
const ARTIFACT = '(?:图片|成品图|成图|图|成品|结果|文件|产物|视频|报告)'
const SUBJECT_PREFIX = '(?:(?:这|那)(?:张|份|个)?|刚才(?:那(?:张|份|个))?|之前(?:那(?:张|份|个))?|你要的|你让我(?:做|画|改|生成)的)?'
const ARTIFACT_SUBJECT = `${SUBJECT_PREFIX}${ARTIFACT}`
const TASK_SUBJECT = `${SUBJECT_PREFIX}(?:任务|请求|处理|生成|改图|画图)`
const PARTICLES = '(?:[呀啊啦咯喽欸呢哦哈吧～~]*)'
const PAST = '(?:已经|已|刚才|刚刚|早就)?'
const READY = `${PAST}(?:出来|做好|完成|生成好|生成完|改好|画好|画完|做完|好)(?:了|啦)?`
const ABSENT = '(?:(?:还没(?:有)?|尚未|暂未|没有|没|未)(?:跑出来|出来|做好|完成|生成(?:好|出)?|改好|产出|画完)|没(?:有)?(?:跑到|生成出|产出)(?:结果|成品))'
const RUNNING = '(?:(?:还(?:在)?|仍(?:然)?(?:在)?|正在|目前(?:还)?在|现在(?:还)?在|在)(?:生成|处理|制作|画图|改图|运行|跑)(?:中|着)?|(?:生成|处理|制作|运行|执行)中)'
const QUEUED = '(?:(?:还|仍|正在|目前|现在)?在排队|排队中)'
const FAILED = `${PAST}(?:失败|没跑成|中断|出错)(?:了|啦)?`
const COMPLETED = `${PAST}(?:(?:执行|处理|生成)?(?:完成|结束)|处理完|执行完|跑完)(?:了|啦)?`
const SENT = '(?:(?:已经|已|刚才|刚刚|早就)(?:给你发|发给你|发你|发出|发过|发送|送达|投递)(?:了|过(?:了)?)?|(?:给你发|发给你|发你|发出|发送|送达|投递|发到(?:群里|这里|上面))(?:了|过了)|发过了|在上面了)'
const IMPLICIT_PREFIX = '(?:(?:我这边|这边|我|目前|现在|刚才那步)(?:已经|已)?(?:把)?|刚才|刚刚)?'
const explicitState = (subject: string, state: string) => new RegExp(`^${subject}(?:这边)?${state}${PARTICLES}$`, 'u')
const implicitState = (state: string) => new RegExp(`^${IMPLICIT_PREFIX}${state}${PARTICLES}$`, 'u')

interface StateClaim {dimension: 'ready' | 'absent' | 'running' | 'queued' | 'failed' | 'completed' | 'sent'; explicit: RegExp[]; implicit: RegExp}
const STATE_CLAIMS: StateClaim[] = [
  {dimension: 'ready', explicit: [explicitState(ARTIFACT_SUBJECT, READY)], implicit: implicitState(`${PAST}(?:出来|做好|生成好|生成完|改好|画好|画完|做完)(?:了|啦)?`)},
  {dimension: 'absent', explicit: [explicitState(ARTIFACT_SUBJECT, ABSENT)], implicit: implicitState(ABSENT)},
  {dimension: 'running', explicit: [explicitState(ARTIFACT_SUBJECT, RUNNING), explicitState(TASK_SUBJECT, RUNNING)], implicit: implicitState(RUNNING)},
  {dimension: 'queued', explicit: [explicitState(ARTIFACT_SUBJECT, QUEUED), explicitState(TASK_SUBJECT, QUEUED)], implicit: implicitState(QUEUED)},
  {dimension: 'failed', explicit: [explicitState(TASK_SUBJECT, FAILED), explicitState(ARTIFACT_SUBJECT, `(?:生成|处理|制作)?${FAILED}`)], implicit: implicitState(FAILED)},
  {dimension: 'completed', explicit: [explicitState(TASK_SUBJECT, COMPLETED)], implicit: implicitState(COMPLETED)},
  {dimension: 'sent', explicit: [explicitState(ARTIFACT_SUBJECT, SENT), new RegExp(`^(?:我(?:这边)?|这边)?${PAST}把${ARTIFACT_SUBJECT}(?:发给你|发出|发送|送达|投递)了${PARTICLES}$`, 'u')], implicit: implicitState(SENT)}
]
const REFERENCED_IMAGE_STATE = /^(?:第[一二三四五六七八九十\d]+张|这张|那张)(?:图|图片)?(?:我(?:这边)?|这边)?(.+)$/u

const ASYNC_ACTION = /发给(?:你|您)|发你|给(?:你|您)发|(?:发|发送|投递)(?:图|图片|成品|文件|结果)?(?:给(?:你|您)|到(?:群里|群内|群聊|这里|这儿|私聊))|(?:通知|提醒|告诉|来找|找)(?:你|您)|(?:补发|补给(?:你|您)|给(?:你|您)补上)|重跑|重试|(?:重新|再次)(?:生成|出图|画图|处理)|(?:持续|定时|自动|继续)(?:查|查询|检查)(?:进度|结果)|查进度|查询进度/gu
const COMPLETION_TRIGGER = /(?:等(?:到)?|一旦|如果|要是|待)?(?:图(?:片)?|成品|结果|文件|任务)?(?:一出(?:来|图)?|一好|一完成|好了|好(?:后|以后|之后|时)|完成(?:了|后|以后|之后|时)|出来(?:了|后|以后|之后)|出图(?:了|后|以后|之后)|有(?:了)?结果|确认到(?:成品|结果)|拿到(?:成品|结果))|(?:图(?:片)?|成品|结果|文件|任务)(?:好|出来|完成|生成完)(?=我|就|再|会|自动|主动|给|发|通知|提醒|告诉|[，,])|(?:出来|出图|生成完|画完|改完|做完)(?=我|就|再|会|自动|主动|给|发|通知|提醒|告诉|[，,])|(?:图(?:片)?|成品|结果|文件)(?:出了|出后|出之后)|(?:结果|成品)(?:一到|一回|到了)|(?:等(?:我)?(?:确认(?:了|到)?)?(?:真)?有图(?:了)?)|有(?:了)?(?:准信|确切(?:的)?消息|新(?:的)?进展|进展)(?:了|后|之后|以后)?/gu
const DELAYED_PROMISE = /我(?:会|来|再|到时|稍后|明天|明早|晚上|一会儿|待会|等下)|稍后|待会儿?|过会儿|明早|到时候|到时|届时|随后|之后|自动|主动/u
const NEGATED_ACTION = /不会|不能|不敢|无法|没法|不再|不自动|不主动|不一定会/u
const RERUN_OR_POLL = /重跑|重试|重新|再次|查进度|查询进度|(?:持续|定时|自动|继续)(?:查|查询|检查)/u
const USER_TRIGGER = /(?:你|您).{0,12}(?:再(?:来)?问|再(?:来)?找|再叫我|再发(?:消息|一句)|发来|发给我|告诉我|确认(?:后|了)|发(?:来|给我)之后).{0,18}(?:我再|再帮你|再给你)/gu
const REGISTERED = /(?:已经|已|帮你|给你).{0,8}(?:登记|安排|设好|设置好|定好).{0,12}(?:提醒|闹钟|定时|通知|自动|任务)|(?:提醒|闹钟|定时(?:任务)?|后续(?:投递|发送)).{0,8}(?:已经|已)?(?:登记|安排|设好|设置好|定好)(?:了|好了)?/gu

type FollowUpKind = 'job_completion' | 'reminder' | 'unsupported'
function supportsFollowUp(task: TurnTaskFact, kind: FollowUpKind): boolean {
  if (task.followUp.state !== 'registered' || !task.followUp.id || !['queued', 'running'].includes(task.execution)) return false
  if (kind === 'reminder') return task.source === 'reminder' && task.followUp.kind === 'reminder'
  return kind === 'job_completion' && task.source === 'live_job' && task.followUp.kind === 'job_completion'
}

function completionBefore(text: string): number {
  let last = -1
  for (const match of text.matchAll(COMPLETION_TRIGGER)) {
    const before = text.slice(0, match.index)
    const localPrefix = before.split(/[，,]/u).at(-1) || ''
    if (/已经|刚才|之前|刚刚|早就/u.test(localPrefix) && !/如果|要是|一旦|等(?:到)?/u.test(localPrefix)) continue
    last = match.index! + match[0].length
  }
  return last
}

function pastAction(prefix: string): boolean {
  return /已经|刚才|刚刚|早就/u.test(prefix) && !/稍后|之后|将|会|自动|主动/u.test(prefix)
}

function deniedAction(prefix: string): boolean {
  return /(?:没有|没|未|尚未|并未|没(?:有)?核实到|未能核实到)(?:任何|有效的?|可用的?|可核验的?|已经?登记的?|后续|自动|主动|再|安排|登记|相关|的|一条|一个|帮你|给你|为你)*$/u.test(prefix)
}

function hasLaterCompletionAction(clauses: string[], index: number): boolean {
  const after = clauses.slice(index + 1).join('，')
  return [...after.matchAll(ASYNC_ACTION)].some(match => {
    const before = after.slice(0, match.index)
    return !pastAction(before.split(/[，,]/u).at(-1) || '')
  })
}

function followUpClaims(sentence: ReplySentence): FollowUpKind[] {
  const claims: FollowUpKind[] = []
  for (const match of sentence.text.matchAll(ASYNC_ACTION)) {
    const before = sentence.text.slice(0, match.index)
    const clauseStart = Math.max(before.lastIndexOf('，'), before.lastIndexOf(',')) + 1
    const clause = sentence.text.slice(clauseStart)
    const actionPrefix = sentence.text.slice(clauseStart, match.index)
    const lastClause = !/[，,]/u.test(sentence.text.slice(match.index))
    if (unasserted(clause, sentence.question && lastClause) || NEGATED_ACTION.test(actionPrefix)
      || deniedAction(actionPrefix) || pastAction(actionPrefix)
      || OTHER_SUBJECT.test(actionPrefix) && !/我(?:会|来|再|就|到时|稍后)/u.test(actionPrefix)
      || /(?:他|她|别人)(?:会|来|再|到时)/u.test(actionPrefix)) continue
    const completion = completionBefore(before)
    const trigger = [...before.matchAll(USER_TRIGGER)].at(-1)
    if (trigger && trigger.index! + trigger[0].length >= completion) continue
    // A negative or wording cue before the condition applies across its
    // comma (“不能承诺图好了，我会发你”). An unrelated earlier clause does not.
    const conditionPrefix = completion >= 0 ? before.slice(0, completion).split(/[，,]/u).at(-1) || '' : actionPrefix
    if (NON_ASSERTION.test(conditionPrefix) || WORDING_EXAMPLE.test(conditionPrefix)) continue
    if (completion < 0 && !DELAYED_PROMISE.test(before)) continue
    // An explanation delivered in this reply is synchronous. “告诉你” alone
    // becomes a follow-up only with a completion or explicit delay condition.
    if (/告诉/u.test(match[0]) && completion < 0 && !/稍后|待会|过会|明早|明天|到时|届时|之后|自动|主动/u.test(before)) continue
    if (/^(?:我(?:这边)?|这边)?(?:现在|这就|马上|立刻)(?:把[^，,]{1,12})?$/u.test(actionPrefix)) continue
    if (RERUN_OR_POLL.test(match[0])) claims.push('unsupported')
    else if (completion >= 0) claims.push('job_completion')
    else claims.push(/提醒|通知/u.test(match[0]) && /明早|明天|晚上|一会儿|待会|等下|稍后|到时|届时/u.test(before) ? 'reminder' : 'job_completion')
  }
  for (const match of sentence.text.matchAll(REGISTERED)) {
    const before = sentence.text.slice(0, match.index)
    const clauseStart = Math.max(before.lastIndexOf('，'), before.lastIndexOf(',')) + 1
    const clause = sentence.text.slice(clauseStart).split(/[，,]/u)[0] || ''
    const localPrefix = sentence.text.slice(clauseStart, match.index)
    if (unasserted(clause, sentence.question && !/[，,]/u.test(sentence.text.slice(match.index))) || OTHER_SUBJECT.test(localPrefix)) continue
    if (deniedAction(localPrefix) || /(?:没有|没|未|尚未|并未)(?:帮你|给你|为你|成功)?(?:登记|安排|设好|设置好|定好)/u.test(clause)) continue
    claims.push(completionBefore(clause) >= 0 ? 'job_completion' : /提醒|闹钟/u.test(match[0]) ? 'reminder' : 'job_completion')
  }
  return claims
}

function stateSupported(dimension: StateClaim['dimension'], tasks: TurnTaskFact[]): boolean {
  return tasks.some(task => {
    switch (dimension) {
      case 'ready': return task.result === 'available'
      case 'absent': return task.result === 'unavailable'
      case 'running': return task.execution === 'running'
      case 'queued': return task.execution === 'queued'
      case 'failed': return task.execution === 'failed'
      case 'completed': return task.execution === 'completed'
      case 'sent': return task.delivery.state === 'sent' && Boolean(task.delivery.messageId)
    }
  })
}

// Delivery records expose receipt state, not the recipient's settings or the
// transport's rejection cause. Only flag a direct attribution of these narrow
// states; conditional troubleshooting suggestions remain ordinary speech.
const RECIPIENT_DELIVERY_CAUSE = /(?:你(?:那边|这边)?|接收方|收件方)(?:的)?(?:接收(?:设置|权限)?|收图(?:设置|权限)?|陌生人消息(?:设置|权限)?)[^，,。；;!?！？]{0,10}(?:拦住|拦在|拦截|挡住|拒收|屏蔽)|(?:你(?:那边|这边)?|接收方|收件方)(?:已经|已|把)?(?:图片|图|文件|消息|视频|我发的图)?(?:给)?(?:拒收|拒绝接收|屏蔽|拦截)(?:了)?|你(?:那边|这边)?(?:的)?(?:还)?(?:没(?:有)?|未)(?:开|开启|打开|允许|启用)(?:陌生人)?(?:图片|图|文件|消息|视频)?(?:接收|收图)|你(?:那边|这边)?(?:把)?(?:陌生人)?(?:图片|文件|消息|视频)?(?:接收(?:开关|权限)?|收图)(?:给)?(?:关了|关闭了|禁用了|屏蔽了)|你(?:那边|这边)?(?:的)?(?:接收(?:开关|权限)?|收图)(?:是)?(?:关闭|关着|没开|未开|禁用)(?:的|了)?/u
function unsupportedRecipientCause(clause: string, rawUserText: string, adjacentCause = false): boolean {
  if (!RECIPIENT_DELIVERY_CAUSE.test(clause) || /(?:如果|假如|要是|倘若|若是)/u.test(clause)
    || /不能(?:归因|认定|断定)|无法(?:说明|断定)|没法(?:确认|核实)|没(?:有)?核实/u.test(clause)) return false
  // A user can report their own setting. Restating that report is allowed;
  // attributing this particular failure to it still requires causal evidence.
  const reported = /我(?:这边|那边)?(?:把)?(?:还)?(?:没(?:有)?|未)(?:开|开启|打开|允许|启用)(?:陌生人)?(?:图片|图|文件|消息|视频)?(?:接收|收图)|我(?:这边|那边)?(?:把)?(?:接收(?:开关|权限)?|收图)(?:给)?(?:关了|关闭了|禁用了)|我(?:已经|刚才)?(?:拒收|拒绝接收|屏蔽)(?:了)?/u.test(withoutQuotations(rawUserText))
  return !reported || adjacentCause || /因为|所以|因此|导致|造成|就是|才(?:会|没)/u.test(clause)
}

/** Narrow, evidence-backed rejection signals. This is not a general truth or
 * naturalness score. Scope and freshness must be validated by the caller.
 * The current words, not the mere presence of an empty facts envelope, scope
 * omitted task subjects. Reminder records do not establish artifact scope. */
export function validateActionReply(reply: string, facts?: TurnActionFacts, rawUserText = ''): ActionReplyViolation[] {
  const violations: ActionReplyViolation[] = []
  const tasks = facts?.tasks || []
  const taskContext = hasTaskContext(facts, rawUserText)
  const rawTopic = evidenceTopic(rawUserText)
  for (const sentence of assertions(reply)) {
    const followUps = followUpClaims(sentence)
    const sentenceTopic = evidenceTopic(sentence.text)
    const completionNotification = sentenceTopic === 'reminder' && followUps.includes('job_completion') && !followUps.includes('reminder')
    const followUpTopic = completionNotification
      ? rawTopic === 'unknown' ? 'artifact' : rawTopic
      : ['unknown', 'generic', 'artifact'].includes(sentenceTopic) ? rawTopic : sentenceTopic
    const followUpTasks = uniqueMatchingTasks(tasks, followUpTopic)
    if (followUps.some(kind => !followUpTasks.some(task => supportsFollowUp(task, kind)))) {
      violations.push({code: 'unregistered_followup', claim: sentence.text,
        reason: '没有仍有效且与该动作对应的后续登记；完成触发的通知或投递和普通定时提醒不能互相证明。',
        correctionInstruction: '撤回自动跟进、通知、重试或已登记的说法。只说当前已知情况；如需用户再次发起请求，明确由用户再来询问，不承诺届时自己主动行动。'})
    }
    const clauses = sentence.text.split(/[，,]/u).map(value => value.trim()).filter(Boolean)
    let sentenceTaskContext = taskContext
    for (const [index, clause] of clauses.entries()) {
      if (unasserted(clause, sentence.question && index === clauses.length - 1) || OTHER_SUBJECT.test(clause)) continue
      const nextClause = clauses[index + 1] || ''
      const previousClause = clauses[index - 1] || ''
      const deliveryFailure = /(?:发送|投递|送达)(?:失败|没(?:有)?成功)|(?:图(?:片)?|消息|文件|视频)?(?:没(?:有)?(?:发|送)(?:给|到|出|过)|发不(?:出|过)|送不(?:到|出))/u
      const adjacentCause = !unasserted(nextClause, sentence.question && index + 1 === clauses.length - 1)
        && /^(?:所以|因此|因而|才)/u.test(nextClause) && deliveryFailure.test(nextClause)
        || !unasserted(previousClause) && deliveryFailure.test(previousClause) && /(?:因为|由于)[呀啊呢]?$/u.test(previousClause)
      if (taskContext && unsupportedRecipientCause(clause, rawUserText, adjacentCause)) {
        violations.push({code: 'unsupported_delivery', claim: sentence.text,
          reason: '当前投递记录只证明发送状态，没有证明用户拒收、关闭接收或接收设置导致失败。',
          correctionInstruction: '只说明已核验的发送状态，缺少原因就说原因尚未确认。不要把失败归因于用户拒收或没开接收，也不要据此要求用户修改设置；条件性的排查建议需明确仍是假设。'})
      }
      // “好了我会发你” is a future condition, not a claim that it is ready.
      if (/^(?:如果|要是|假如|一旦|等|待)/u.test(clause)
        || completionBefore(clause) >= 0 && (new RegExp(ASYNC_ACTION.source, 'u').test(clause) || hasLaterCompletionAction(clauses, index))) continue
      for (const state of STATE_CLAIMS) {
        const explicit = state.explicit.some(pattern => pattern.test(clause))
        const referencedImage = taskContext && rawTopic === 'image' ? REFERENCED_IMAGE_STATE.exec(clause) : null
        const implicit = sentenceTaskContext && state.implicit.test(referencedImage?.[1] || clause)
        if (!explicit && !implicit) continue
        if (explicit) sentenceTaskContext = true
        const clauseTopic = referencedImage ? 'image' : evidenceTopic(clause)
        const topic = clauseTopic === 'unknown' || clauseTopic === 'generic' ? rawTopic : clauseTopic
        if (stateSupported(state.dimension, uniqueMatchingTasks(tasks, topic))) continue
        const delivery = state.dimension === 'sent'
        violations.push({code: delivery ? 'unsupported_delivery' : 'unsupported_task_state', claim: sentence.text,
          reason: delivery ? '没有该任务最终投递的消息回执。' : '当前记录没有证明这句所断言的进度或产物状态；未确认不能升级成尚未产出。',
          correctionInstruction: delivery ? '不能确认已经发送或让用户往上找图。产物可用与投递已确认是两回事，分别说明。'
            : '按已核验记录分别说明进度、产物与投递。无证据的维度明确尚未确认，不说还没出来、仍在执行、已经完成或执行失败。'})
      }
    }
  }
  return violations.filter((value, index, all) => all.findIndex(other => other.code === value.code && other.claim === value.claim) === index)
}

/** Used only when a contradictory candidate could not be regenerated safely. */
export function buildActionReplyFallback(facts?: TurnActionFacts, rawUserText = ''): string {
  const task = uniqueMatchingTasks(facts?.tasks || [], evidenceTopic(rawUserText))[0]
  if (!task) return '这次还没核实到那条请求的处理结果，进度和是否发出都不能确认。你可以把原请求回复给我，方便对上是哪一次。'
  const lines: string[] = []
  if (task.result === 'available') lines.push('已有可用结果。')
  else if (task.execution === 'failed') lines.push('记录显示这次处理失败了。')
  else if (task.execution === 'queued') lines.push('记录显示还在排队。')
  else if (task.execution === 'running') lines.push('记录显示正在处理。')
  else if (task.execution === 'completed') lines.push('处理已结束，但可用结果还没有核实。')
  else lines.push('当前处理进度还没有核实。')
  if (task.delivery.state === 'sent' && task.delivery.messageId) lines.push('那次发送有消息回执，已确认发出。')
  else if (task.delivery.state === 'failed') lines.push('发送没有成功。')
  else if (task.delivery.state === 'not_attempted') lines.push('还没有尝试发送。')
  else lines.push('是否发出还不能确认。')
  if (supportsFollowUp(task, 'job_completion')) lines.push('完成后发送的任务仍有效，完成时间还不能保证。')
  else if (supportsFollowUp(task, 'reminder')) lines.push('只核实到一条提醒安排，这不代表结果会自动补发。')
  return lines.join('')
}
