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

export function buildTurnActionFactsPrompt(facts?: TurnActionFacts): string {
  if (!facts) return ''
  const lines = ['【已核验的任务事实】', '以下来自当前机器人、当前会话和当前请求者的任务记录。执行、产物和投递分别成立；历史承诺、进度消息和工具调用返回都不等于最终产物已送达。']
  if (facts.lookup === 'unavailable' && facts.tasks.length) lines.push('部分记录未能核验；以下已确认的事实仍成立，未列出的任务或后续安排保持未知。')
  if (!facts.tasks.length) lines.push(facts.lookup === 'unavailable' ? '本次未能核验相关任务记录；不能推断任务不存在、仍在执行或已经完成。' : '当前查询没有匹配的可核验任务记录；进度、产物与投递保持未确认。')
  for (const task of facts.tasks) {
    lines.push(`原请求 ${task.requestMessageId}：${executionLabels[task.execution]}；${resultLabels[task.result]}；${deliveryLabels[task.delivery.state]}${task.delivery.state === 'sent' ? `（回执消息 ${task.delivery.messageId}）` : ''}。`)
    if (task.delivery.state === 'failed') lines.push('投递失败只说明这次发送未成功，不证明接收者拒收、系统拦截、屏蔽或接收设置等具体原因。没有原因证据时，不自行补写失败原因。')
    if (task.followUp.state === 'registered') {
      lines.push(task.followUp.kind === 'reminder'
        ? `已核验提醒登记 ${task.followUp.id}，北京时间 ${new Date(task.followUp.dueAt!).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'})} 触发。这只证明该提醒已登记，不证明原图会完成、已安排重跑或稍后交付原结果。`
        : `已核验仍有效的完成后投递任务 ${task.followUp.id}；只在该登记范围内描述后续动作，不承诺完成时间。`)
    } else lines.push('没有核验到仍有效的后续投递登记，不能承诺自动查询、重跑或“好了再发”。')
  }
  lines.push('向用户只说与这次追问有关的事实及具体缺口，避免照读内部字段。用户说“好了发我”表达的是请求，不能自行变成已经安排的任务；若本轮可用工具支持且用户已授权，实际登记成功后再确认。')
  return lines.join('\n')
}
