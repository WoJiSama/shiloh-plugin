import type {ActionFactsEvent, ActionFactScope, ActionFactsQuery, TurnActionFacts, TurnTaskFact} from '../../../contracts/turnActionFacts.js'

export function actionFactScope(event: ActionFactsEvent): ActionFactScope {
  const userId = String(event.user_id ?? '')
  return {botId: String(event.self_id ?? event.bot?.uin ?? ''), conversationId: event.group_id ? `group:${event.group_id}` : `private:${userId}`, userId}
}

export function unknownTurnActionFacts(event: ActionFactsEvent, now = Date.now()): TurnActionFacts {
  return {scope: actionFactScope(event), observedAt: now, lookup: 'unavailable', tasks: []}
}

/** Fail closed at the prompt boundary, including optional host implementations. */
export function validateTurnActionFacts(value: TurnActionFacts | undefined, event: ActionFactsEvent, now = Date.now(), query?: ActionFactsQuery): TurnActionFacts {
  const scope = actionFactScope(event)
  if (!scope.botId || !scope.userId || !value || !['ok', 'unavailable'].includes(value.lookup)
    || !value.scope || value.scope.botId !== scope.botId || value.scope.conversationId !== scope.conversationId || value.scope.userId !== scope.userId
    || !Number.isFinite(value.observedAt) || value.observedAt > now + 5000 || now - value.observedAt > 60_000 || !Array.isArray(value.tasks)) {
    return unknownTurnActionFacts(event, now)
  }
  const tasks: TurnTaskFact[] = []
  const reference = String(query?.referenceMessageId ?? '').trim()
  const requested = new Set(query?.recentRequestMessageIds || [])
  for (const fact of value.tasks.slice(0, 8)) {
    if (!fact || !fact.taskId || !fact.requestMessageId || !['task_record', 'live_job', 'reminder'].includes(fact.source)
      || !Number.isFinite(fact.observedAt) || fact.observedAt > now + 5000 || now - fact.observedAt > 24 * 60 * 60_000
      || !['queued', 'running', 'completed', 'failed', 'unknown'].includes(fact.execution)
      || !['available', 'unavailable', 'unknown'].includes(fact.result)
      || !fact.delivery || !['not_attempted', 'sent', 'failed', 'unknown'].includes(fact.delivery.state)
      || !fact.followUp || !['registered', 'none', 'unknown'].includes(fact.followUp.state)) continue
    // Even an optional host must not answer an explicit old request with a
    // different request's success or callback in the same bot/group/user scope.
    if (query && (reference
      ? fact.requestMessageId !== reference && !(fact.delivery.state === 'sent' && fact.delivery.messageId === reference)
      : !requested.has(fact.requestMessageId))) continue
    const fresh = now - fact.observedAt <= 15 * 60_000
    const execution = !fresh && (fact.execution === 'queued' || fact.execution === 'running') ? 'unknown' : fact.execution
    const delivery = fact.delivery.state === 'sent' && !String(fact.delivery.messageId ?? '').trim()
      ? {state: 'unknown' as const} : {...fact.delivery}
    const registered = fact.followUp.state === 'registered'
      && Boolean(fact.followUp.id) && fresh && (execution === 'queued' || execution === 'running')
      && ((fact.source === 'reminder' && fact.followUp.kind === 'reminder' && Number.isFinite(fact.followUp.dueAt) && fact.followUp.dueAt! > now)
        || (fact.source === 'live_job' && fact.followUp.kind === 'job_completion'))
    const followUp = fact.followUp.state === 'registered' && !registered ? {state: 'unknown' as const} : {...fact.followUp}
    tasks.push({...fact, execution, delivery, followUp})
  }
  return {scope, observedAt: value.observedAt, lookup: value.lookup, tasks}
}

const executionLabels: Record<TurnTaskFact['execution'], string> = {queued: '已登记排队', running: '记录为执行中', completed: '执行已结束', failed: '执行失败', unknown: '执行进度未确认'}
const resultLabels: Record<TurnTaskFact['result'], string> = {available: '已有产物', unavailable: '没有可用产物', unknown: '产物未确认'}
const deliveryLabels: Record<TurnTaskFact['delivery']['state'], string> = {not_attempted: '尚未尝试投递', sent: '有消息回执确认送达', failed: '投递失败，具体原因未确认', unknown: '投递结果未确认'}

export function taskFactTopic(task: TurnTaskFact): 'image' | 'video' | 'file' | 'reminder' | 'generic' {
  if (task.source === 'reminder') return 'reminder'
  if (/image|banana|draw|paint|pixiv|dalle|flux/iu.test(task.toolName)) return 'image'
  if (/video|media|torrent/iu.test(task.toolName)) return 'video'
  if (/excel|workbook|file|document|report|pdf|word|sheet/iu.test(task.toolName)) return 'file'
  return 'generic'
}
const taskTypeLabels = {image: '图片处理', video: '视频处理', file: '文件处理', reminder: '定时提醒', generic: '工具处理'}

export function buildTurnActionFactsPrompt(facts?: TurnActionFacts): string {
  if (!facts) return ''
  const lines = ['【已核验的任务事实】', '以下来自当前机器人、当前会话和当前请求者的任务记录。任务存在、执行、产物、投递和后续登记分别成立；历史承诺、进度消息和工具调用返回都不等于最终产物已送达。']
  lines.push('未查到记录不代表任务没有在执行；这次未核验到有效后续登记，只限制本次自动跟进，不能据此说系统没有这个功能。')
  lines.push('以下各维度只按各自证据说明：未确认不等于没有、失败或未完成。对同一张图增加颜色、背景、版本等限定语，不改变该任务的证据归属。')
  lines.push('以下是本轮核验时的任务状态，并非完整历史审计。当前没有有效登记或登记未确认时，不能倒推先前从未登记或旧回复有误；只有当时证据能证明旧回复错误，才将其说明为记错或说错。')
  lines.push('有前后状态证据时按状态变化解释；没有历史证据时，不补写过去的登记、取消过程或执行者。用户对操作的转述应保留来源，不能说成机器人刚执行的操作。')
  if (facts.lookup === 'unavailable' && facts.tasks.length) lines.push('部分记录未能核验；以下已确认的事实仍成立，未列出的任务或后续安排保持未知。')
  if (!facts.tasks.length) lines.push(facts.lookup === 'unavailable' ? '本次未能核验相关任务记录；不能推断任务不存在、仍在执行或已经完成。' : '当前查询没有匹配的可核验任务记录；进度、产物与投递保持未确认。')
  for (const task of facts.tasks) {
    const type = taskTypeLabels[taskFactTopic(task)]
    lines.push(`原请求 ${task.requestMessageId}（任务类型：${type}）：${executionLabels[task.execution]}；${resultLabels[task.result]}；${deliveryLabels[task.delivery.state]}${task.delivery.state === 'sent' ? `（回执消息 ${task.delivery.messageId}）` : ''}。`)
    if (task.source === 'reminder') lines.push('这是一条定时提醒记录。这里的登记和排队只属于该提醒，不证明图片处理任务存在、已登记、正在排队或会在完成后发图。')
    lines.push('已核验该请求对应的任务记录存在；后续发送未登记、已取消或未确认，均不能否定原任务存在，也不能据此推断任务停止或产物不可用。')
    if (task.result === 'available') lines.push('已确认有可用产物，这一事实独立于投递状态；不能因投递状态改述为没有图、没有成品或尚未做好。')
    if (task.delivery.state === 'failed') {
      lines.push('投递失败只说明这次发送未成功，不证明接收者拒收、系统拦截、屏蔽或接收设置等具体原因。没有原因证据时，不自行补写失败原因。')
      lines.push('这次发送失败也不能证明重发通道缺失或不可用；是否可重发应依据当轮可用工具、权限和实际执行结果，不能单凭任务记录判断。')
    }
    if (task.followUp.state === 'registered') {
      lines.push(task.followUp.kind === 'reminder'
        ? `已核验提醒登记 ${task.followUp.id}，北京时间 ${new Date(task.followUp.dueAt!).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'})} 触发。这只证明该提醒已登记，不证明原图会完成、已安排重跑或稍后交付原结果。`
        : `已核验仍有效的完成后投递任务 ${task.followUp.id}；只在该登记范围内描述后续动作，不承诺完成时间。`)
    } else if (task.followUp.state === 'none') lines.push('已核验该任务当前没有仍有效的后续投递登记；这只说明本次没有完成后自动发送的安排，原任务及其执行状态仍按上面的记录成立。不能承诺自动查询、重跑或“好了再发”。')
    else lines.push('后续投递登记尚未确认，不能确认会自动发，也不能说原任务不存在或已经取消。不能承诺自动查询、重跑或“好了再发”。')
  }
  lines.push('用户再次发起请求时，可以按当轮可用工具和权限同步查询、回复或尝试发送，这不需要现在预先登记自动跟进；但用户愿意再要一次、已有产物或历史投递记录，都不能保证届时具备重发条件或一定发送成功。')
  lines.push('向用户只说与这次追问有关的事实及具体缺口，避免照读内部字段。用户说“好了发我”表达的是请求，不能自行变成已经安排的任务；若本轮可用工具支持且用户已授权，实际登记成功后再确认。')
  return lines.join('\n')
}
