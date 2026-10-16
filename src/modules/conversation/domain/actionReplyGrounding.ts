import type {TurnActionFacts, TurnTaskFact} from '../../../contracts/turnActionFacts.js'
import {taskFactTopic} from './turnActionFacts.js'

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

/** Preserve question punctuation and treat hesitation marks as clause breaks;
 * a later uncertainty disclaimer cannot erase an earlier state assertion. */
function assertions(text: string): ReplySentence[] {
  return [...withoutQuotations(text).replace(/\.{3,}/gu, '…').matchAll(/[^。！？!?；;…\n]+[。！？!?；;…]?/gu)]
    .map(match => ({text: match[0].replace(/[。！？!?；;…]+$/u, '').trim(), question: /[？?]$/u.test(match[0])}))
    .filter(sentence => Boolean(sentence.text))
}

const NON_ASSERTION = /不能(?:确认|说明|证明|保证|承诺|断定|说)|无法(?:确认|核实|保证)|不(?:确定|清楚|保证|承诺|代表|等于|证明)|没(?:有)?证据|未确认|没确认|尚不知|还不知道|不是|并非|是否|有没有|能否|是不是|会不会|不一定|可能|也许|似乎/u
const WORDING_EXAMPLE = /例如|比如|举例|示例|假设|这句话|这种说法|这段话|不要(?:说|写|回复)|别(?:说|写|回复)|不能(?:说|写|回复)|(?:用户|别人|他|她)(?:说|问|写)(?:的|过|了)?|(?<![跟和对向])你(?:说|问|写)(?:的|过|了)?/u
const OTHER_SUBJECT = /^(?:(?:我|你)(?:妈|爸|姐姐|妹妹|哥哥|弟弟|朋友|同事)|姐姐|妹妹|哥哥|弟弟|妈妈|爸爸|他(?:们)?|她(?:们)?|CPU|GPU|电脑|设备|程序|服务器)/iu
const TASK_TOPIC = /(?:任务|出图|生成|改图|画图|重跑|重试|进度|回执|投递)|(?:图(?:片)?|成品|结果|文件).{0,16}(?:出来|好了吗|做好|弄(?:好|完)|完成|发给我|发我|发送|发出|发了|怎么样)/u

type EvidenceTopic = 'image' | 'video' | 'file' | 'artifact' | 'reminder' | 'generic' | 'unknown' | 'ambiguous'
function evidenceTopic(rawText: string): EvidenceTopic {
  const text = withoutQuotations(rawText)
  if (WORDING_EXAMPLE.test(text)) return 'unknown'
  const reminder = /提醒|闹钟/u.test(text)
  // “图好了提醒我” describes a completion callback, not a clock alarm.
  const artifactCompletion = /(?:图(?:片)?|成品|结果|文件|出图|生成|改图|画图)/u.test(text) && completionBefore(text) >= 0
  const kinds: EvidenceTopic[] = []
  if (/图片|成品图|成图|出图|改图|画图|(?:改|换)(?:图(?:片)?)?背景|(?:第[一二三四五六七八九十\d]+张|这张|那张|原图)|图(?=已经|已|还|尚|没|未|正|在|生成|出来|好|弄|的|发|一|了|呢|吗|，|,|$)/u.test(text)) kinds.push('image')
  if (/视频|影片/u.test(text)) kinds.push('video')
  if (/文件|报告|表格|工作簿|Excel|文档|PDF/iu.test(text)) kinds.push('file')
  // A clock reminder may mention a user's later image action. A separate
  // artifact-status clause still owns its own object in a mixed question.
  const artifactStatus = kinds.length && /(?:任务|进度|回执|投递)|(?:图(?:片)?|成品|结果|文件).{0,12}(?:出来|好了吗|做好|弄(?:好|完)|完成|发(?:给)?我|怎么样)/u.test(text)
  if (reminder && !artifactCompletion && !artifactStatus) return 'reminder'
  if (kinds.length > 1) return 'ambiguous'
  if (kinds[0]) return kinds[0]
  if (/成品|产物|结果/u.test(text)) return 'artifact'
  return TASK_TOPIC.test(text) ? 'generic' : 'unknown'
}

/** The caller validates ownership and request references; this boundary must
 * still avoid borrowing a reminder receipt or another kind of artifact. */
function uniqueMatchingTasks(tasks: TurnTaskFact[], topic: EvidenceTopic): TurnTaskFact[] {
  if (topic === 'ambiguous') return []
  const candidates = tasks.filter(task => {
    if (topic === 'unknown') return true
    if (topic === 'reminder') return task.source === 'reminder'
    if (task.source === 'reminder') return false
    return topic === 'artifact' || topic === 'generic' || taskFactTopic(task) === topic
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
const SUBJECT_PREFIX = '(?:第[一二三四五六七八九十0-9]+张|(?:这|那)(?:张|份|个)?|刚才(?:那(?:张|份|个))?|之前(?:那(?:张|份|个))?|你要的|你让我(?:做|画|改|生成)的)?'
const ARTIFACT_SUBJECT = `${SUBJECT_PREFIX}${ARTIFACT}`
const TASK_SUBJECT = `${SUBJECT_PREFIX}(?:任务|请求|处理|生成|改图|画图)`
const PARTICLES = '(?:[呀啊啦咯喽欸呢哦哈吧～~]*)'
const PAST = '(?:已经|已|刚才|刚刚|早就)?'
const READY = `${PAST}(?:出来|做好|弄好|弄完|完成|生成好|生成完|改好|画好|画完|做完|好)(?:了|啦)?`
const ABSENT = '(?:(?:还没(?:有)?|尚未|暂未|没有|没|未)(?:跑出来|出来|做好|弄(?:好|完)|完成|生成(?:好|出)?|改好|产出|画完)|没(?:有)?(?:跑到|生成出|产出)(?:结果|成品))'
const RUNNING = '(?:(?:还(?:在)?|仍(?:然)?(?:在)?|正在|目前(?:还)?在|现在(?:还)?在|在)(?:生成|处理|制作|画图|改图|运行|跑)(?:中|着)?|(?:生成|处理|制作|运行|执行)中)'
const QUEUED = '(?:(?:还|仍|正在|目前|现在)?在排队(?:中)?|排队中)'
const FAILED = `${PAST}(?:失败|没跑成|中断|出错)(?:了|啦)?`
const COMPLETED = `${PAST}(?:(?:执行|处理|生成)?(?:完成|结束)|处理完|执行完|跑完)(?:了|啦)?`
const SENT = '(?:(?:已经|已|刚才|刚刚|早就)(?:给你发|发给你|发你|发出|发过|发送|送达|投递)(?:了|过(?:了)?)?|(?:给你发|发给你|发你|发出|发送|送达|投递|发到(?:群里|这里|上面))(?:了|过了)|发过了|在上面了)'
const UNSENT = '(?:(?:还没(?:有)?|尚未|暂未|没有|没|未)(?:给你)?(?:发|发送|投递|送)(?:给(?:你|您)|到(?:群里|群内|群聊|这里|这儿|私聊)|出(?:来|去)?|达)?(?:过(?:了)?|了)?)'
const IMPLICIT_PREFIX = '(?:(?:我这边|这边|我|目前|现在|刚才那步)(?:已经|已)?(?:把)?|刚才|刚刚)?'
type TaskStateDimension = 'artifact' | 'execution' | 'delivery' | 'existence' | 'follow_up'
type TaskStateValue = 'available' | 'unavailable' | 'running' | 'not_running' | 'queued' | 'not_queued' | 'failed' | 'completed' | 'sent' | 'unsent' | 'present' | 'absent' | 'registered' | 'none'
interface TaskObjectReference {kind: 'artifact' | 'task' | 'follow_up' | 'implicit'; topic: EvidenceTopic; surface: string}
interface TaskStateProposition {object: TaskObjectReference; dimension: TaskStateDimension; value: TaskStateValue}
interface StatePredicate {dimension: TaskStateDimension; value: TaskStateValue; suffix: RegExp; accepts: 'artifact' | 'task' | 'either'; implicit: boolean}

const predicate = (dimension: TaskStateDimension, value: TaskStateValue, state: string, accepts: StatePredicate['accepts'], implicit = true): StatePredicate =>
  ({dimension, value, suffix: new RegExp(`(?:${state})${PARTICLES}$`, 'u'), accepts, implicit})
const STATE_PREDICATES: StatePredicate[] = [
  predicate('artifact', 'available', READY, 'artifact'),
  predicate('artifact', 'unavailable', ABSENT, 'artifact'),
  predicate('artifact', 'unavailable', '(?:还|仍)?不算(?:已经|已)?(?:出来|做好|完成)(?:了)?', 'artifact'),
  predicate('execution', 'running', RUNNING, 'either'),
  predicate('execution', 'not_running', '(?:已经|现在|目前|还|也)?(?:没有|没|不|未)(?:在|正在)?(?:生成|处理|制作|画图|改图|运行|跑|执行)(?:中|着)?(?:了)?', 'either'),
  predicate('execution', 'queued', QUEUED, 'either'),
  predicate('execution', 'not_queued', '(?:已经|现在|目前|还|也)?(?:没有|没|不|未)(?:(?:在|正在)?排队|排队中)(?:了)?', 'either'),
  predicate('execution', 'failed', `(?:生成|处理|制作)?${FAILED}`, 'either'),
  predicate('execution', 'completed', COMPLETED, 'task'),
  predicate('delivery', 'sent', SENT, 'artifact'),
  predicate('delivery', 'unsent', UNSENT, 'artifact'),
  predicate('artifact', 'unavailable', '(?:还|也|本来|本来也|本来就)*(?:没(?:有)?|不存在)(?:了)?', 'artifact', false),
  predicate('artifact', 'available', '(?:还|仍然|仍|也)?(?:在|有)(?:着|的)?', 'artifact', false),
  predicate('existence', 'absent', '(?:本来|本来也|本来就|原本|原来也|还|也|一直)*(?:没(?:有)?(?:挂着|存在)?|不存在|不在)(?:了)?', 'task', false),
  predicate('existence', 'present', '(?:还|仍然|仍|一直)?(?:在|存在|挂着)(?:的)?', 'task', false),
  predicate('existence', 'present', '(?:(?:确实|的确|本来|早就)(?:是)?)?(?:已经|已)?登记(?:了|好)?(?:的)?', 'either', false),
  predicate('existence', 'absent', '(?:当时|原来|一开始)?(?:没有|没|未|尚未)(?:成功)?登记(?:上|好|成|成功)?(?:了)?', 'either', false),
  predicate('follow_up', 'none', `${PAST}(?:取消|撤销)(?:了)?`, 'either', false),
  predicate('follow_up', 'registered', '(?:仍|还|依然)?(?:有效|生效)(?:的)?', 'either', false)
]
const SELF_LOCATION = '(?:我(?:这边|这里|这儿|手里|手上)?|这边|这里|这儿|手头)'
const IMAGE_REFERENCE = '(?:第[一二三四五六七八九十0-9]+张|这张|那张)'
const QUALIFIED_IMAGE_REFERENCE = new RegExp(`^(?:改|换)(?:图(?:片)?)?背景(?:的)?${IMAGE_REFERENCE}(?:图(?:片)?)?$`, 'u')
const NOMINAL_HEAD = new RegExp(`^(?:${ARTIFACT_SUBJECT}|${IMAGE_REFERENCE})(.*)$`, 'u')
const TASK_HEAD = new RegExp(`^(?:${TASK_SUBJECT}|${ARTIFACT_SUBJECT}的?(?:任务|请求))(?:本身)?(?:的)?$`, 'u')
const QUALIFIED_TASK_HEAD = /^(?:(?:改|换)(?:图(?:片)?)?背景|出图|改图|画图|生成(?:图(?:片)?|视频|文件|报告))(?:(?:的)?(?:这|那)(?:个|次)?|的)?(?:任务|请求)(?:本身)?(?:的)?$/u
const FOLLOW_UP_OBJECT = /(?:自动|主动|完成后|好了(?:后)?|后续|定时|提醒|闹钟).{0,16}(?:发(?:送|图)?|投递|补发|通知|提醒|安排|登记|任务)(?:的)?(?:安排|登记|任务)?$|(?:提醒|闹钟)(?:安排|登记|任务)?$/u
const IMPLICIT_SUBJECT = new RegExp(`^${IMPLICIT_PREFIX}$`, 'u')
const SUBJECT_CONNECTOR = /^(?:(?:所以|因此|因而|于是|但是|不过|其实|而且|只是|至于|说到|当前|目前|现在|但|也)(?:的)?)*\s*/u

/** Resolve the noun phrase independently of its predicate. A descriptor such
 * as background/color does not create another task; a person inside an image
 * or another person's artifact is not the runtime-owned task object. */
function taskObjectReference(rawSubject: string, context: boolean, rawTopic: EvidenceTopic): TaskObjectReference | undefined {
  let subject = rawSubject.replace(SUBJECT_CONNECTOR, '').trim()
    .replace(new RegExp(`^(?:${SELF_LOCATION})?(?:已经|已)?把`, 'u'), '')
    .replace(new RegExp(`(?:在${SELF_LOCATION}|${SELF_LOCATION})(?:的)?$`, 'u'), '')
  subject = subject.replace(/^(?:我(?:这边|这里|这儿)?|这边|这里|这儿)(?:的)?(?=(?:这|那|第|任务|请求|图|文件|结果|成品|视频|报告))/u, '')
  if (OTHER_SUBJECT.test(subject)) return undefined
  if (FOLLOW_UP_OBJECT.test(subject)) return {kind: 'follow_up', topic: rawTopic, surface: rawSubject}
  if (TASK_HEAD.test(subject) || QUALIFIED_TASK_HEAD.test(subject)) {
    const topic = evidenceTopic(subject)
    return {kind: 'task', topic: topic === 'unknown' || topic === 'generic' ? rawTopic : topic, surface: rawSubject}
  }
  if (context && rawTopic === 'image' && QUALIFIED_IMAGE_REFERENCE.test(subject)) return {kind: 'artifact', topic: 'image', surface: rawSubject}
  const nominal = NOMINAL_HEAD.exec(subject)
  if (nominal) {
    const qualifier = nominal[1] || ''
    if (new RegExp(`^${IMAGE_REFERENCE}`, 'u').test(subject) && !/图/u.test(subject) && !(context && rawTopic === 'image')) return undefined
    // Locative contents, possessors and separate actions change the subject;
    // keep these outside the task boundary instead of swallowing free text.
    if (qualifier.length > 36 || /(?:里|中|内|上|下)(?:面|边)?(?:的)?[^的]*$|(?:我|你|他|她|它|别人|姐姐|妹妹|哥哥|弟弟|朋友|同事|CPU|GPU)|[：:]|(?:正在|已经|还没|没有|没在|出来|处理|生成|画完|完成|发给)/iu.test(qualifier)) return undefined
    const topic = new RegExp(`^${IMAGE_REFERENCE}`, 'u').test(subject) ? 'image' : evidenceTopic(subject)
    return {kind: 'artifact', topic, surface: rawSubject}
  }
  if (context && IMPLICIT_SUBJECT.test(subject)) return {kind: 'implicit', topic: rawTopic, surface: rawSubject}
  return undefined
}

function taskStatePropositions(clause: string, context: boolean, rawTopic: EvidenceTopic, resultQuestion: boolean): TaskStateProposition[] {
  const propositions: TaskStateProposition[] = []
  const predicates = STATE_PREDICATES.flatMap(state => {
    const match = state.suffix.exec(clause)
    return match ? [{state, match}] : []
  })
  // Parse one complete predicate boundary before resolving the noun phrase.
  // Its inner suffix is not a second assertion: “没有” contains “有”, and
  // “没在处理” contains “在处理”. Negation must never become a descriptor.
  const predicateStart = Math.min(...predicates.map(({match}) => match.index))
  for (const {state, match} of predicates) {
    if (match.index !== predicateStart) continue
    const object = taskObjectReference(clause.slice(0, match.index), context, rawTopic)
    if (!object || object.kind === 'implicit' && !state.implicit || state.dimension === 'existence' && !context
      || object.kind === 'task' && state.accepts === 'artifact' || object.kind === 'artifact' && state.accepts === 'task') continue
    if (object.kind === 'follow_up') {
      if (state.dimension === 'existence') propositions.push({object, dimension: 'follow_up', value: state.value === 'absent' ? 'none' : 'registered'})
      else if (state.dimension === 'follow_up') propositions.push({object, dimension: state.dimension, value: state.value})
      continue
    }
    if (state.dimension === 'follow_up') continue
    // Bare “好了” is a completion condition in ordinary speech. The explicit
    // artifact noun, or the less ambiguous omitted-subject verbs, supply scope.
    if (object.kind === 'implicit' && state.value === 'available' && !new RegExp(`^${IMPLICIT_PREFIX}${PAST}(?:出来|做好|弄好|弄完|生成好|生成完|改好|画好|画完|做完)(?:了|啦)?${PARTICLES}$`, 'u').test(clause)) continue
    propositions.push({object, dimension: state.dimension, value: state.value})
  }
  // Existential speech puts the state before the object (“没有这张图” /
  // “没挂着这个任务”), rather than requiring a new whole-sentence pattern.
  const possession = new RegExp(`^(?:${SELF_LOCATION})?(?:现在|目前|本来|原来|一直|也|本来也|本来就)*(还没(?:有)?|没(?:有)?(?:挂着)?|尚未|仍(?:然)?有|还有|有)(.+?)${PARTICLES}$`, 'u').exec(clause.replace(SUBJECT_CONNECTOR, ''))
  if (possession) {
    const object = taskObjectReference(possession[2]!, false, rawTopic)
    const absent = /没|未/u.test(possession[1]!)
    if (object?.kind === 'task' && context) propositions.push({object, dimension: 'existence', value: absent ? 'absent' : 'present'})
    else if (object?.kind === 'artifact') propositions.push({object, dimension: 'artifact', value: absent ? 'unavailable' : 'available'})
    else if (object?.kind === 'follow_up' && context) propositions.push({object, dimension: 'follow_up', value: absent ? 'none' : 'registered'})
  }
  if (context && /^(?:(?:我(?:这边)?|这边)?(?:取消(?:了)?(?:发送|投递|通知)?(?:的话)?|那|就|也|已经|已|现在|目前)*)不会(?:再)?(?:自动|主动)(?:发(?:送|图)?|投递|通知)(?:给你|发你|你)?(?:了)?[呀啊呢哦吧]*$/u.test(clause)) {
    propositions.push({object: {kind: 'follow_up', topic: rawTopic, surface: clause}, dimension: 'follow_up', value: 'none'})
  }
  if (resultQuestion && BARE_ABSENT_ANSWER.test(clause)) propositions.push({object: {kind: 'implicit', topic: rawTopic, surface: ''}, dimension: 'artifact', value: 'unavailable'})
  return propositions
}
const BARE_ABSENT_ANSWER = new RegExp(`^还没(?:有)?${PARTICLES}$`, 'u')
const RESULT_STATUS_QUESTION = new RegExp(`(?:${ARTIFACT_SUBJECT}|第[一二三四五六七八九十\\d]+张(?:图|图片)?)(?:[，,]\\s*)?(?:现在|目前|已经|还|到底)?(?:出来|做好|完成|生成(?:好|完)|改好|画(?:好|完)|弄(?:好|完)|做完|好)(?:了|啦)?(?:没(?:有)?|[吗么])?${PARTICLES}$`, 'u')

function asksArtifactResult(rawUserText: string): boolean {
  return assertions(rawUserText).some(sentence => !OTHER_SUBJECT.test(sentence.text) && !WORDING_EXAMPLE.test(sentence.text)
    && (sentence.question || /[吗么]|没(?:有)?$/u.test(sentence.text)) && RESULT_STATUS_QUESTION.test(sentence.text))
}

const SPOKEN_UPDATE = /^(?:(?:跟|和|对|向)(?:你|您)(?:说明|说|讲)(?:一声|一下|清楚)?|(?:告诉|告知)(?:你|您))$/u
const SPEECH_DELAY = /等(?:我)?(?:确认|核实|查清|弄清|查到)|(?:确认|核实|查清|弄清|查到).{0,12}(?:之后|以后|后)|稍后|待会|过会|明早|明天|到时候|到时|届时|之后|自动|主动/u
const ASYNC_ACTION = /(?:跟|和|对|向)(?:你|您)(?:说明|说|讲)(?:一声|一下|清楚)?|告知(?:你|您)|发给(?:你|您)|发你|给(?:你|您)发|(?:发|发送|投递)(?:图|图片|成品|文件|结果)?(?:给(?:你|您)|到(?:群里|群内|群聊|这里|这儿|私聊))|(?:重|再|重新)发(?:送)?(?:一(?:次|遍|下))?|(?:通知|提醒|告诉|来找|找)(?:你|您)|(?:补发|补给(?:你|您)|给(?:你|您)补上)|重跑|重试|(?:重新|再次)(?:生成|出图|画图|处理)|(?:持续|定时|自动|继续)(?:查|查询|检查)(?:进度|结果)|查进度|查询进度|(?:单独)?给(?:你|您)(?=[呀啊啦咯喽欸呢哦哈吧～~]*$)/gu
const COMPLETION_TRIGGER = /(?:等(?:到)?|一旦|如果|要是|待)?(?:图(?:片)?|成品|结果|文件|任务)?(?:一出(?:来|图)?|一好|一完成|好了|好(?:后|以后|之后|时)|完成(?:了|后|以后|之后|时)|出来(?:了|后|以后|之后)|出图(?:了|后|以后|之后)|有(?:了)?结果|确认到(?:成品|结果)|拿到(?:成品|结果))|(?:图(?:片)?|成品|结果|文件|任务)(?:好|出来|完成|生成完)(?=我|就|再|会|自动|主动|给|发|通知|提醒|告诉|[，,])|(?:出来|出图|生成完|画完|改完|做完)(?=我|就|再|会|自动|主动|给|发|通知|提醒|告诉|[，,])|(?:图(?:片)?|成品|结果|文件)(?:出了|出后|出之后)|(?:结果|成品)(?:一到|一回|到了)|(?:等(?:我)?(?:确认(?:了|到)?)?(?:真)?有图(?:了)?)|有(?:了)?(?:实际(?:的)?|真正(?:的)?)?(?:产出|成品)|有(?:了)?(?:准信|确切(?:的)?消息|新(?:的)?进展|进展)(?:了|后|之后|以后)?/gu
const DELAYED_PROMISE = /我(?:会|来|再|到时|稍后|明天|明早|晚上|一会儿|待会|等下)|稍后|待会儿?|过会儿|明早|到时候|到时|届时|随后|之后|自动|主动/u
const NEGATED_ACTION = /不会|不能|不敢|无法|没法|不再|不自动|不主动|不一定会/u
const RERUN_OR_POLL = /重跑|重试|重新|再次|查进度|查询进度|(?:持续|定时|自动|继续)(?:查|查询|检查)/u
const IMMEDIATE_ACTION = /^(?:那)?(?:我(?:这边)?|这边)?(?:现在|这就|马上|立刻|立即)(?:先|就|会|再|来|手动|直接|帮你|给你|为你|把[^，,]{1,20})*$/u
const PRESENT_SELF_ACTION = /^(?:那)?(?:我(?:这边)?|这边)(?:先|就|再|来|手动|直接|帮你|给你|为你|把[^，,]{1,20})*$/u
const USER_TRIGGER = /(?:你|您).{0,12}(?:再(?:来)?问|再(?:来)?找|再叫我|再发(?:消息|一句)|发来|发给我|告诉我|确认(?:后|了)|发(?:来|给我)之后).{0,18}(?:我再|再帮你|再给你)/gu
const USER_REQUEST_CONDITION = /(?:你|您)[^，,]{0,28}(?:再(?:来)?(?:问|找|叫)|回来[^，,]{0,12}(?:问|找|叫)|再发(?:消息|一句)|(?:确认|发来|发给我|告诉我)(?:后|了))/gu
const ON_DEMAND_LOOKUP = /我(?:到时候|届时|那时|回来后)?(?:现|当场|再)(?:查|查询|核实)(?:一下)?(?:状态|进度|结果)?/u
const DEFERRED_VERIFICATION = /(?:等(?:到)?|待|一旦)(?:我(?:这边)?(?:再)?)?(?:确认|核实|查到|查清|弄清)(?:到|出|了)?|(?:^|[，,])(?:确认|核实|查到|查清|弄清)(?:了|到)(?=我|就|再|会|马上|立刻|立即|第一时间|[，,])/gu
const ELLIPTICAL_RESULT = /有了(?=我|就|再|会|直接|第一时间|[，,])/gu
const REGISTERED = /(?:已经|已|帮你|给你).{0,8}(?:登记|安排|设好|设置好|定好).{0,12}(?:提醒|闹钟|定时|通知|自动|任务)|(?:提醒|闹钟|定时(?:任务)?|后续(?:投递|发送)).{0,8}(?:已经|已)?(?:登记|安排|设好|设置好|定好)(?:了|好了)?/gu

type FollowUpKind = 'job_completion' | 'reminder' | 'unsupported' | 'immediate_delivery' | 'immediate_execution'
interface FollowUpClaim {kind: FollowUpKind; topic: EvidenceTopic}
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

function topicBefore(text: string, end: number, initial: EvidenceTopic): EvidenceTopic {
  let topic = initial
  for (const clause of text.slice(0, end).split(/[，,]/u)) {
    const local = evidenceTopic(clause)
    if (!['unknown', 'generic', 'artifact', 'ambiguous'].includes(local)) topic = local
  }
  return topic
}

/** A later user request can own a synchronous lookup and the result of that
 * lookup. A new completion condition or proactive action starts another
 * commitment and cannot borrow the earlier user-triggered exemption. */
function userRequestedAction(text: string, before: string, actionEnd: number, completion: number): boolean {
  if (IMMEDIATE_ACTION.test(before.split(/[，,]/u).at(-1) || '')) return false
  const direct = [...text.slice(0, actionEnd).matchAll(USER_TRIGGER)].at(-1)
  if (direct && direct.index! + direct[0].length >= completion
    && !/自动|主动|持续|定时/u.test(before.slice(direct.index! + direct[0].length))) return true
  const request = [...before.matchAll(USER_REQUEST_CONDITION)].at(-1)
  if (!request) return false
  const response = before.slice(request.index! + request[0].length)
  if (/自动|主动|持续|定时/u.test(response)) return false
  if (completion < 0 || completion <= request.index! + request[0].length) return true
  const condition = [...before.matchAll(COMPLETION_TRIGGER), ...before.matchAll(ELLIPTICAL_RESULT)]
    .sort((a, b) => a.index! - b.index!).at(-1)
  return Boolean(condition && /^(?:有(?:了)?结果|有了)$/u.test(condition[0]) && ON_DEMAND_LOOKUP.test(response))
}

function followUpClaims(sentence: ReplySentence, taskContext: boolean, rawTopic: EvidenceTopic): FollowUpClaim[] {
  const claims: FollowUpClaim[] = []
  const add = (kind: FollowUpKind, end: number): void => {
    const topic = kind === 'reminder' ? 'reminder' : topicBefore(sentence.text, end, rawTopic)
    claims.push({kind, topic: kind === 'job_completion' && topic === 'reminder' ? rawTopic : topic})
  }
  for (const match of sentence.text.matchAll(ASYNC_ACTION)) {
    const before = sentence.text.slice(0, match.index)
    const clauseStart = Math.max(before.lastIndexOf('，'), before.lastIndexOf(',')) + 1
    const clause = sentence.text.slice(clauseStart).split(/[，,]/u)[0] || ''
    const actionPrefix = sentence.text.slice(clauseStart, match.index)
    // Bare consent followed by our own present action is not reported speech
    // (“你说一声我现在发你”). Keep actual quotations and later requests intact.
    const selfActionPrefix = actionPrefix.replace(/^(?:你|您)(?:(?:要|需要|想要)(?:的话)?|说一声(?:的话)?)(?=我(?:这边)?(?:现在|这就|马上|立刻|立即|先|就|再|来))/u, '')
    const assertionClause = selfActionPrefix + clause.slice(actionPrefix.length)
    const lastClause = !/[，,]/u.test(sentence.text.slice(match.index))
    if (unasserted(assertionClause, sentence.question && lastClause) || NEGATED_ACTION.test(actionPrefix + match[0])
      || deniedAction(actionPrefix) || pastAction(actionPrefix)
      || OTHER_SUBJECT.test(actionPrefix) && !/我(?:会|来|再|就|到时|稍后)/u.test(actionPrefix)
      || /(?:他|她|别人)(?:会|来|再|到时)/u.test(actionPrefix)) continue
    const implicitResult = taskContext ? [...before.matchAll(ELLIPTICAL_RESULT)].at(-1) : undefined
    const completion = Math.max(completionBefore(before), implicitResult ? implicitResult.index! + implicitResult[0].length : -1)
    const verification = [...before.matchAll(DEFERRED_VERIFICATION)].at(-1)
    const verificationEnd = verification ? verification.index! + verification[0].length : -1
    // A bare handoff after completion still promises later delivery. Ordinary
    // gifts or an explanation supplied in this reply are outside this form.
    const implicitHandoff = /^(?:单独)?给(?:你|您)$/u.test(match[0])
    if (implicitHandoff && completion < 0) continue
    if (userRequestedAction(sentence.text, before, match.index! + match[0].length, Math.max(completion, verificationEnd))) continue
    // A negative or wording cue before the condition applies across its
    // comma (“不能承诺图好了，我会发你”). An unrelated earlier clause does not.
    const conditionEnd = Math.max(completion, verificationEnd)
    const conditionPrefix = conditionEnd >= 0 ? before.slice(0, conditionEnd).split(/[，,]/u).at(-1) || '' : selfActionPrefix
    if (NON_ASSERTION.test(conditionPrefix) || WORDING_EXAMPLE.test(conditionPrefix)) continue
    const tail = sentence.text.slice(match.index! + match[0].length)
    if (SPOKEN_UPDATE.test(match[0]) && /^(?:答案|解释|说明|步骤|建议|示例|做法|思路|文字)(?:[：:]|[，,](?:先|首先|第一步))/u.test(tail)) continue
    const delivery = implicitHandoff || /发|投递|补给|补上/u.test(match[0])
    // Consent to an offered action does not provide execution evidence.
    // Strip only a condition followed by our own explicit present action;
    // third-party actions and user-triggered future requests stay separate.
    if ((delivery || RERUN_OR_POLL.test(match[0]))
      && (IMMEDIATE_ACTION.test(selfActionPrefix) || completion < 0 && PRESENT_SELF_ACTION.test(selfActionPrefix))) {
      // Text supplied in this very reply needs no separate tool execution.
      // Keep this exemption limited to an explanation, never an artifact.
      const inlineText = /(?:^|把)(?:操作)?(?:步骤|解释|说明|答案|建议|示例|做法|思路|文字)$/u.test(actionPrefix)
        && /^(?:一下)?(?:[：:]|[，,](?:先|首先|第一步))/u.test(sentence.text.slice(match.index! + match[0].length))
      if (delivery && inlineText) continue
      add(delivery ? 'immediate_delivery' : 'immediate_execution', match.index! + match[0].length)
      continue
    }
    const spokenUpdate = SPOKEN_UPDATE.test(match[0])
    const speechDelay = spokenUpdate && SPEECH_DELAY.test(before)
    if (completion < 0 && verificationEnd < 0 && !DELAYED_PROMISE.test(before) && !speechDelay) continue
    // An explanation delivered in this reply is synchronous. “告诉你” alone
    // becomes a follow-up only with a completion or explicit delay condition.
    if (spokenUpdate && completion < 0 && verificationEnd < 0 && !speechDelay) continue
    // A job callback does not schedule a later explanation after an
    // unspecified investigation or confirmation of the failure cause.
    if (verificationEnd > completion || spokenUpdate && (completion < 0 || /原因|为什么/u.test(sentence.text))) {add('unsupported', match.index! + match[0].length); continue}
    if (RERUN_OR_POLL.test(match[0])) add('unsupported', match.index! + match[0].length)
    else if (completion >= 0) add('job_completion', match.index! + match[0].length)
    else add(/提醒|通知/u.test(match[0]) && /明早|明天|晚上|一会儿|待会|等下|稍后|到时|届时/u.test(before) ? 'reminder' : 'job_completion', match.index! + match[0].length)
  }
  for (const match of sentence.text.matchAll(REGISTERED)) {
    const before = sentence.text.slice(0, match.index)
    const clauseStart = Math.max(before.lastIndexOf('，'), before.lastIndexOf(',')) + 1
    const clause = sentence.text.slice(clauseStart).split(/[，,]/u)[0] || ''
    const localPrefix = sentence.text.slice(clauseStart, match.index)
    if (unasserted(clause, sentence.question && !/[，,]/u.test(sentence.text.slice(match.index))) || OTHER_SUBJECT.test(localPrefix)) continue
    if (deniedAction(localPrefix) || /(?:没有|没|未|尚未|并未)(?:帮你|给你|为你|成功)?(?:登记|安排|设好|设置好|定好)/u.test(clause)) continue
    add(completionBefore(localPrefix) >= 0 ? 'job_completion' : /提醒|闹钟/u.test(match[0]) ? 'reminder' : 'job_completion', match.index! + match[0].length)
  }
  return claims
}

function stateSupported(proposition: TaskStateProposition, tasks: TurnTaskFact[]): boolean {
  return tasks.some(task => {
    switch (proposition.dimension) {
      case 'artifact': return task.result === proposition.value
      case 'execution': return proposition.value === 'not_running' || proposition.value === 'not_queued'
        ? task.execution !== 'unknown' && task.execution !== (proposition.value === 'not_running' ? 'running' : 'queued')
        : task.execution === proposition.value
      case 'delivery': return proposition.value === 'sent'
        ? task.delivery.state === 'sent' && Boolean(task.delivery.messageId)
        : task.delivery.state === 'failed' || task.delivery.state === 'not_attempted'
      // A validated row proves that its task exists. Neither an empty lookup,
      // cancelled callback nor any delivery state proves nonexistence.
      case 'existence': return proposition.value === 'present'
      case 'follow_up': return proposition.value === 'registered' ? supportsFollowUp(task, task.source === 'reminder' ? 'reminder' : 'job_completion') : task.followUp.state === 'none'
    }
  })
}

// Delivery records expose receipt state, not the recipient's settings or the
// transport's rejection cause. Only flag a direct attribution of these narrow
// states; conditional troubleshooting suggestions remain ordinary speech.
const RECIPIENT_DELIVERY_CAUSE = /(?:你(?:那边|这边)?|接收方|收件方)(?:的)?(?:接收(?:设置|权限)?|收图(?:设置|权限)?|陌生人消息(?:设置|权限)?)[^，,。；;!?！？]{0,10}(?:拦住|拦在|拦截|挡住|拒收|屏蔽)|(?:你(?:那边|这边)?|接收方|收件方)(?:已经|已|把)?(?:图片|图|文件|消息|视频|我发的图)?(?:给)?(?:明确(?:地)?|直接)*(?:拒收|拒绝(?:接)?收|屏蔽|拦截)(?:了)?|你(?:那边|这边)?(?:的)?(?:还)?(?:没(?:有)?|未)(?:开|开启|打开|允许|启用)(?:陌生人)?(?:图片|图|文件|消息|视频)?(?:接收|收图)|你(?:那边|这边)?(?:把)?(?:陌生人)?(?:图片|文件|消息|视频)?(?:接收(?:开关|权限)?|收图)(?:给)?(?:关了|关闭了|禁用了|屏蔽了)|你(?:那边|这边)?(?:的)?(?:接收(?:开关|权限)?|收图)(?:是)?(?:关闭|关着|没开|未开|禁用)(?:的|了)?/u
const DELIVERY_EVENT = '(?:(?:发|发送|投递|送达|送)(?:给(?:你|您)|(?:你|您)|到(?:群里|群内|群聊|这里|这儿|私聊)|出(?:来|去)?)?|给(?:你|您)(?:发|发送))'
const REQUESTED_DELIVERY_EVENT = `(?:你|您)(?:要(?:我)?|让我|想让我|想要(?:我)?)${DELIVERY_EVENT}`
const DELIVERY_CAUSE_WORDS = '(?:拒收|拒绝(?:接?收)?|拒|拦截|拦(?:下(?:来)?|住)|屏蔽)'
const DELIVERY_CAUSE_QUALIFIER = '(?:明确(?:地)?|直接)*'
const PASSIVE_DELIVERY_CAUSE = new RegExp(`(?:被|遭(?:到)?)(?:(?:你|您|对方|接收方|收件方|平台|系统)(?:给)?)?${DELIVERY_CAUSE_QUALIFIER}(${DELIVERY_CAUSE_WORDS})`, 'gu')
const DELIVERY_PREFIX_PART = new RegExp(`^(?:只是|就是|不过|但是|但|其实|也|我(?:这边)?|这边|(?:上次|这次|那次|之前(?:那次)?|刚才(?:那次)?)(?:的)?|${ARTIFACT_SUBJECT}|消息|${REQUESTED_DELIVERY_EVENT}|${DELIVERY_EVENT}|的?时候|的|时|已经|已|又|还|仍然|就|直接)`, 'u')

function passiveDeliveryCause(clause: string): string | undefined {
  for (const match of clause.matchAll(PASSIVE_DELIVERY_CAUSE)) {
    let prefix = clause.slice(0, match.index).trim()
    // A delivery can be restated (“发的时候投递被拒”). Consume only
    // task-delivery grammar, preserving invitations and third-party parcels.
    while (prefix) {
      const part = DELIVERY_PREFIX_PART.exec(prefix)
      if (!part) break
      prefix = prefix.slice(part[0].length).trimStart()
    }
    if (!prefix) return match[1]
  }
  return undefined
}

function deliveryCauseKind(cause: string): string {
  return /^拒/u.test(cause) ? 'rejection' : cause === '屏蔽' ? 'screening' : 'interception'
}

function reportedPassiveCause(rawUserText: string, cause: string): boolean {
  const activeReport = new RegExp(`我(?:这边|那边)?(?:已经|刚才|之前|上次|这次)?(?:把(?:你(?:刚才)?发的)?(?:${ARTIFACT_SUBJECT}|消息))?(?:给)?${DELIVERY_CAUSE_QUALIFIER}(${DELIVERY_CAUSE_WORDS})`, 'u')
  return assertions(rawUserText).some(sentence => sentence.text.split(/[，,]/u).some(clause => {
    if (unasserted(clause, sentence.question) || /如果|假如|要是|倘若|若是/u.test(clause) || OTHER_SUBJECT.test(clause)) return false
    const reported = activeReport.exec(clause)?.[1] || passiveDeliveryCause(clause)
    return Boolean(reported && deliveryCauseKind(reported) === deliveryCauseKind(cause))
  }))
}

function unsupportedRecipientCause(clause: string, rawUserText: string, adjacentCause = false): boolean {
  const passive = passiveDeliveryCause(clause)
  const recipient = RECIPIENT_DELIVERY_CAUSE.exec(clause)
  const otherObject = recipient && /^(?:了|过)?(?:(?:我|你|他|她)(?:们)?的|这(?:个|份)?|那(?:个|份)?)?(?:邀请|包裹|快递)/u.test(clause.slice(recipient.index + recipient[0].length))
  if (!(recipient && !otherObject || passive) || /(?:如果|假如|要是|倘若|若是)/u.test(clause)
    || /不能(?:归因|认定|断定)|无法(?:说明|断定)|没法(?:确认|核实)|没(?:有)?核实/u.test(clause)) return false
  // A user can report their own setting. Restating that report is allowed;
  // attributing this particular failure to it still requires causal evidence.
  const reported = passive
    ? reportedPassiveCause(rawUserText, passive)
    : /我(?:这边|那边)?(?:把)?(?:还)?(?:没(?:有)?|未)(?:开|开启|打开|允许|启用)(?:陌生人)?(?:图片|图|文件|消息|视频)?(?:接收|收图)|我(?:这边|那边)?(?:把)?(?:接收(?:开关|权限)?|收图)(?:给)?(?:关了|关闭了|禁用了)|我(?:已经|刚才)?(?:明确(?:地)?|直接)*(?:拒收|拒绝(?:接)?收|屏蔽)(?:了)?/u.test(withoutQuotations(rawUserText))
  return !reported || adjacentCause || /因为|所以|因此|导致|造成|就是|才(?:会|没)/u.test(clause)
}

const RERUN_ACTION = '(?:重做|重跑|重试|(?:重新|再)(?:做|弄|跑|生成|出图|画图|改图|处理))'
const REQUIRED_RERUN = new RegExp(`(?:必须|必需|需要|非得|得|只能|只有|要)(?:先)?${RERUN_ACTION}(?:一(?:次|遍|下))?(?:${ARTIFACT_SUBJECT}|${TASK_SUBJECT})?(?:(?:后|之后|以后)?(?:才(?:能|可以)${DELIVERY_EVENT}|才行))?${PARTICLES}$`, 'u')
const RERUN_DELIVERY_CONDITION = new RegExp(`^(?:(${ARTIFACT_SUBJECT})?(?:要|想)${DELIVERY_EVENT}|(?:要|想)(?:发|发送|投递)(${ARTIFACT_SUBJECT}))(?:的话)?(?:就)?$`, 'u')

function rerunTaskSubject(prefix: string, context: boolean, topic: EvidenceTopic): boolean {
  const subject = prefix.replace(SUBJECT_CONNECTOR, '').replace(/^(?:那(?:就)?|就)/u, '').trim()
  const condition = RERUN_DELIVERY_CONDITION.exec(subject)
  if (condition) {
    const object = condition[1] || condition[2]
    return Boolean(object ? taskObjectReference(object, false, topic) : context)
  }
  const object = taskObjectReference(subject, context, topic)
  return Boolean(object && object.kind !== 'follow_up')
}

/** A direct request can require a new rendition. Questions, reported requests
 * and quoted or negated wording do not authorize that new task. Keep this
 * permission local to the necessity check, never to execution or result claims. */
function requestedRerunTopics(rawUserText: string): EvidenceTopic[] {
  const topics: EvidenceTopic[] = []
  for (const sentence of assertions(rawUserText)) {
    for (const clause of sentence.text.split(/[，,]/u).map(value => value.trim())) {
      if (unasserted(clause, sentence.question) || OTHER_SUBJECT.test(clause)
        || /不要|别|不(?:想|要|需要|用|必|希望|要求)|无需|不用|未必/u.test(clause)) continue
      const direct = clause.replace(/^(?:(?:请(?:你)?|麻烦(?:你)?|帮我|给我|你(?:帮我)?|现在|直接|那|这次|还是|我(?:想(?:要)?|要|需要|希望)(?:你)?))*/u, '')
        .replace(/^把/u, '')
      // Asking for a new rendition is an explicit new task even without a
      // rerun verb (“我要新的蓝底图”). A status question about the old output is not.
      const requestsNewArtifact = /^(?:我(?:想(?:要)?|要|需要|希望)|请(?:你)?(?:给我)?|给我|帮我)/u.test(clause)
        && new RegExp(`^(?:一(?:张|份|个))?新(?:的)?[^，,。！？!?]{0,16}${ARTIFACT}[吧呀啊啦哦]*$`, 'u').test(direct)
        && !/别人|他|她|(?:我|你)(?:妈|爸|姐姐|妹妹|哥哥|弟弟|朋友|同事)/u.test(direct)
      if (requestsNewArtifact) {
        const topic = evidenceTopic(clause)
        if (!['unknown', 'ambiguous', 'reminder'].includes(topic)) topics.push(topic)
        continue
      }
      const action = new RegExp(RERUN_ACTION, 'u').exec(direct)
      if (!action) continue
      const before = direct.slice(0, action.index).replace(/^(刚才|之前)的/u, '$1')
      const after = direct.slice(action.index + action[0].length)
        .replace(/^(?:一(?:次|遍|下)|一(?:张|份|个))/u, '').replace(/(?:一(?:次|遍|下))?[吧呀啊啦哦]*$/u, '')
      // Only an ordinary task noun may surround the imperative. A possessor,
      // reported speaker or conditional clause cannot become authorization.
      const object = taskObjectReference(before || after, false, evidenceTopic(clause))
      if (before && after || !object && (before || after)) continue
      const topic = object?.topic || evidenceTopic(clause)
      if (topic !== 'unknown' && topic !== 'ambiguous' && topic !== 'reminder') topics.push(topic)
    }
  }
  return topics
}

/** A missing receipt is not proof that an existing artifact must be recreated.
 * Availability, failure and callback records do not encode that prerequisite. */
function unsupportedRerunRequirement(clause: string, context: boolean, topic: EvidenceTopic): boolean {
  const match = REQUIRED_RERUN.exec(clause)
  if (!match || /不(?:必|需要|用|一定|认为|觉得)|未必|无需|不用|毋须/u.test(clause)) return false
  // Bare “要” can express a future choice; only its prerequisite form is an
  // asserted necessity. Optional offers and requests are not state claims.
  if (/^(?:要|只有)/u.test(match[0]) && !/才(?:能|可以|行)/u.test(match[0])) return false
  return rerunTaskSubject(clause.slice(0, match.index), context, topic)
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
  const resultQuestionContext = taskContext && asksArtifactResult(rawUserText)
  let currentObjectTopic = rawTopic
  let rerunContext = taskContext
  const requestedReruns = requestedRerunTopics(rawUserText)
  for (const sentence of assertions(reply)) {
    const followUps = followUpClaims(sentence, taskContext, currentObjectTopic)
    if (followUps.some(claim => claim.kind === 'immediate_delivery')) {
      violations.push({code: 'unsupported_delivery', claim: sentence.text,
        reason: '没有本轮实际发送的回执，不能承诺现在发送或再次投递；产物可用、历史发送回执和完成回调都不能证明新的发送动作。',
        correctionInstruction: '撤回现在发送、补发或再次投递的承诺，只说明已核验的产物与发送状态。历史回执只说明那次已发；如需新动作，应由真实工具执行并获得对应回执后再说明。'})
    }
    if (followUps.some(claim => claim.kind === 'immediate_execution')) {
      violations.push({code: 'unregistered_followup', claim: sentence.text,
        reason: '没有本轮实际执行该动作的记录，不能承诺现在重跑、重试或查询；历史任务和完成回调不能证明新的执行。',
        correctionInstruction: '撤回现在重跑、重试或查询的承诺，只说明已核验的当前状态。需要执行时应真实调用对应工具，不以一条文字回复代替执行。'})
    }
    if (followUps.some(claim => !claim.kind.startsWith('immediate_') && !uniqueMatchingTasks(tasks, claim.topic).some(task => supportsFollowUp(task, claim.kind)))) {
      violations.push({code: 'unregistered_followup', claim: sentence.text,
        reason: '没有仍有效且与该动作对应的后续登记；完成触发的通知或投递和普通定时提醒不能互相证明。',
        correctionInstruction: '撤回自动跟进、通知、重试或已登记的说法。只说当前已知情况；如需用户再次发起请求，明确由用户再来询问，不承诺届时自己主动行动。'})
    }
    // A dash can introduce an independent cause claim. Keep that local to
    // delivery attribution so an earlier denial cannot exempt a later claim.
    const deliveryClauses = sentence.text.split(/[，,]|—+|–+|--+/u).map(value => value.trim()).filter(Boolean)
    for (const [index, clause] of deliveryClauses.entries()) {
      if (unasserted(clause, sentence.question && index === deliveryClauses.length - 1) || OTHER_SUBJECT.test(clause)) continue
      const nextClause = deliveryClauses[index + 1] || ''
      const previousClause = deliveryClauses[index - 1] || ''
      const deliveryFailure = /(?:发送|投递|送达)(?:失败|没(?:有)?成功)|(?:图(?:片)?|消息|文件|视频)?(?:没(?:有)?(?:发|送)(?:给|到|出|过)|发不(?:出|过)|送不(?:到|出))/u
      const adjacentCause = !unasserted(nextClause, sentence.question && index + 1 === deliveryClauses.length - 1)
        && /^(?:所以|因此|因而|才)/u.test(nextClause) && deliveryFailure.test(nextClause)
        || !unasserted(previousClause) && deliveryFailure.test(previousClause) && /(?:因为|由于)[呀啊呢]?$/u.test(previousClause)
      if (taskContext && unsupportedRecipientCause(clause, rawUserText, adjacentCause)) {
        violations.push({code: 'unsupported_delivery', claim: sentence.text,
          reason: '当前投递记录只证明发送状态，没有证明拒收、拦截、屏蔽或关闭接收等具体失败原因。',
          correctionInstruction: '只说明已核验的发送状态，缺少原因就说原因尚未确认。不要把失败归因于拒收、被拦截、屏蔽或没开接收，也不要据此要求用户修改设置；条件性的排查建议需明确仍是假设。'})
      }
    }
    const clauses = sentence.text.split(/[，,]/u).map(value => value.trim()).filter(Boolean)
    let sentenceTaskContext = taskContext
    for (const [index, clause] of clauses.entries()) {
      const explicitTopic = evidenceTopic(clause)
      if (!['unknown', 'generic', 'artifact', 'ambiguous'].includes(explicitTopic)) currentObjectTopic = explicitTopic
      if (OTHER_SUBJECT.test(clause)) {rerunContext = false; continue}
      if (unasserted(clause, sentence.question && index === clauses.length - 1)) continue
      if (!requestedReruns.includes(currentObjectTopic) && unsupportedRerunRequirement(clause, rerunContext, currentObjectTopic)) {
        violations.push({code: 'unsupported_task_state', claim: sentence.text,
          reason: '当前记录没有证明原产物必须重做或任务必须重跑才能交付；缺少记录、投递失败或未登记自动发送都不能证明这个必要条件。',
          correctionInstruction: '撤回必须重做、重跑才能发的断言，分别说明已核验的产物与投递状态。尚未核实时保留不确定；可以提出由用户选择是否重新发起任务，不把它说成获取原产物的唯一途径。'})
      }
      // Inherit an omitted rerun subject only from a local task condition or
      // task evidence, not from an unrelated human activity in the same reply.
      rerunContext = rerunTaskSubject(clause, false, currentObjectTopic)
        || rerunContext && explicitTopic !== 'reminder' && /(?:任务|产物|结果|回执|登记|记录)/u.test(clause)
          && !/别人|他|她|(?:我|你)(?:妈|爸|姐姐|妹妹|哥哥|弟弟|朋友|同事)/u.test(clause)
      // “好了我会发你” is a future condition, not a claim that it is ready.
      if (/^(?:如果|要是|假如|一旦|等|待)/u.test(clause)
        || completionBefore(clause) >= 0 && (new RegExp(ASYNC_ACTION.source, 'u').test(clause) || hasLaterCompletionAction(clauses, index))) continue
      for (const state of taskStatePropositions(clause, sentenceTaskContext, currentObjectTopic, resultQuestionContext)) {
        if (state.object.kind !== 'implicit') sentenceTaskContext = true
        const clauseTopic = state.object.topic
        const topic = clauseTopic === 'unknown' || clauseTopic === 'generic' ? currentObjectTopic : clauseTopic
        const matchingTasks = uniqueMatchingTasks(tasks, topic)
        if (stateSupported(state, matchingTasks)) continue
        // A denial of an automatic arrangement does not authorize one. Keep
        // ordinary denials when there is no competing verified registration;
        // still reject denial of a known, live callback for this task.
        if (state.dimension === 'follow_up' && state.value === 'none' && !matchingTasks.length) continue
        const delivery = state.dimension === 'delivery'
        violations.push({code: delivery ? 'unsupported_delivery' : 'unsupported_task_state', claim: sentence.text,
          reason: state.dimension === 'follow_up' ? '当前后续登记状态不支持这句断言；不能否认仍有效的登记，也不能把未确认说成已登记或已取消。原任务与后续发送安排必须分别按记录说明。'
            : state.dimension === 'existence' ? '任务存在与执行、产物、投递及后续登记分别成立；查询没有命中或取消后续发送不能证明任务不存在。'
            : state.value === 'unsent' ? '当前记录没有证明该任务未发出；未确认不能升级成从未发送或发送失败。'
            : delivery ? '没有该任务最终投递的消息回执。' : '当前记录没有证明这句所断言的进度或产物状态；未确认不能升级成尚未产出，投递失败也不能否定已有产物。',
          correctionInstruction: state.dimension === 'follow_up' ? '分别回答原任务是否仍在执行及完成后发送是否仍有有效登记，不把取消通知等同取消原任务，也不抹掉仍有效的发送安排。'
            : state.dimension === 'existence' ? '有任务记录就保留任务存在及其已知执行状态。未查到记录时只说任务状态未核实；取消或缺少完成后发送登记只影响该次后续安排，不能否定原任务。'
            : state.value === 'unsent' ? '缺少对应发送状态证据时，只能说明是否发出尚未确认。不要把没有记录或没确认到写成没发出来、没送出去或发送失败。'
            : delivery ? '不能确认已经发送或让用户往上找图。产物可用与投递已确认是两回事，分别说明。'
            : '按已核验记录分别说明任务存在、执行、产物、投递及后续登记。限定语不改变同一任务对象，已有产物不能因发送失败被说成没有；无证据的维度明确尚未确认。'})
      }
    }
  }
  return violations.filter((value, index, all) => all.findIndex(other => other.code === value.code && other.claim === value.claim) === index)
}

/** Used only when a contradictory candidate could not be regenerated safely. */
export function buildActionReplyFallback(facts?: TurnActionFacts, rawUserText = ''): string {
  const task = uniqueMatchingTasks(facts?.tasks || [], evidenceTopic(rawUserText))[0]
  const automaticDeliveryQuestion = /(?:自动|主动|完成后|好了(?:后)?|出来(?:后)?).{0,12}(?:发|投递|通知|提醒)|(?:发|投递).{0,8}(?:自动|主动)/u.test(withoutQuotations(rawUserText))
  if (!task) return automaticDeliveryQuestion
    ? '现在不能确认还会不会自动发送，相关安排尚未核实；这次处理结果和是否已发出也没核实。'
    : '你问的这次处理结果还没核实，是否做好、是否发出都不能确认。'
  if (task.source === 'reminder') {
    if (supportsFollowUp(task, 'reminder')) {
      const dueAt = task.followUp.dueAt
      return typeof dueAt === 'number' && Number.isFinite(dueAt)
        ? `这条提醒安排仍有效，预定在北京时间 ${new Date(dueAt).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'})} 触发；是否成功发出仍以届时的发送结果为准。`
        : '这条提醒安排仍有效，具体触发时间还没核实；是否成功发出仍以届时的发送结果为准。'
    }
    return task.followUp.state === 'none'
      ? '当前没有仍有效的这条提醒安排，不会按这条安排自动提醒。'
      : '这条提醒是否仍会自动发还不能确认，当前登记情况尚未核实。'
  }
  const lines: string[] = []
  if (automaticDeliveryQuestion) {
    if (supportsFollowUp(task, 'job_completion')) lines.push('这次完成后发送的安排仍有效，会在任务完成后尝试发送；完成时间和发送是否成功还不能保证。')
    else if (task.followUp.state === 'none') lines.push('这次没有仍有效的完成后发送安排，不会按这次安排自动发。')
    else lines.push('现在不能确认还会不会自动发送，完成后发送的安排尚未核实。')
  }
  lines.push('已查到这次任务记录。')
  if (task.execution === 'failed') lines.push('记录显示这次处理失败了。')
  else if (task.execution === 'queued') lines.push('记录显示还在排队。')
  else if (task.execution === 'running') lines.push('记录显示正在处理。')
  else if (task.execution === 'completed') lines.push('这次处理已结束。')
  else lines.push('当前处理进度还没有核实。')
  if (task.result === 'available') lines.push('已有可用结果。')
  else if (task.result === 'unavailable') lines.push('当前还没有可用结果。')
  else lines.push('是否已有可用结果还没有核实。')
  if (task.delivery.state === 'sent' && task.delivery.messageId) lines.push('那次发送有消息回执，已确认发出。')
  else if (task.delivery.state === 'failed') lines.push('发送没有成功。')
  else if (task.delivery.state === 'not_attempted') lines.push('还没有尝试发送。')
  else lines.push('是否发出还不能确认。')
  if (!automaticDeliveryQuestion && supportsFollowUp(task, 'job_completion')) lines.push('完成后发送的任务仍有效，完成时间还不能保证。')
  return lines.join('')
}
