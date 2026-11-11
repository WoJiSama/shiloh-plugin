import type { CharacterDecision, CharacterGoal, CharacterState } from '../../../contracts/character.js'
import { addCharacterMemory, createCharacterGoal, setCharacterDecision, transitionCharacterGoal } from '../domain/characterState.js'
import { AbstractTool, type ToolParameters } from '../../toolSupport/infrastructure/AbstractTool.js'

/** The runtime binds this interface to one captured bot/persona/group scope. */
export interface CharacterToolContext {
  now(): number
  read(): Promise<CharacterState>
  update(mutate: (state: CharacterState) => CharacterState): Promise<CharacterState>
  visibleEvidenceRefs(): string[]
  selectGoal(id: string): Promise<void>
  onDecision(kind: CharacterDecision['kind']): void
  makeId(prefix: string): string
  sharedSourceIds?(): string[]
  reviewMemory?(candidate: Record<string, unknown>, draft: CharacterState): Promise<void>
}

class CharacterTool extends AbstractTool {
  constructor(name: string, description: string, parameters: ToolParameters, private readonly run: (input: Record<string, unknown>) => Promise<unknown>) {
    super()
    this.name = name
    this.description = description
    this.parameters = parameters
  }

  override validateParameters(params: Record<string, unknown>) {
    const unknown = Object.keys(params).find(key => !(key in this.parameters.properties))
    if (unknown) return `不支持的参数: ${unknown}`
    return super.validateParameters(params)
  }

  override async func(input: Record<string, unknown>): Promise<unknown> {
    return await this.run(input)
  }
}

function text(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} 必须是非空文本`)
  return value.trim()
}

function choice<T extends string>(input: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const value = text(input, key)
  if (!allowed.includes(value as T)) throw new Error(`${key} 不在允许范围内`)
  return value as T
}

function strings(input: Record<string, unknown>, key: string): string[] {
  const value = input[key]
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim())) throw new Error(`${key} 必须是文本数组`)
  return [...new Set((value as string[]).map(item => item.trim()))]
}

function evidence(input: Record<string, unknown>, ctx: CharacterToolContext): string[] {
  const refs = strings(input, 'evidenceRefs')
  const visible = new Set(ctx.visibleEvidenceRefs())
  if (refs.some(ref => !visible.has(ref))) throw new Error('引用了本轮不可见的来源；仅用可见的完整 message:序号、receipt:回执ID 或 memory:记忆ID，不用裸ID或目标ID。没有可见来源就先读取，不能猜造。')
  return refs
}

function optionalNumber(input: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  if (input[key] === undefined) return undefined
  const value = input[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${key} 超出允许范围`)
  return value
}

/** Different actions must not silently ignore fields which suggest another operation. */
function fields(input: Record<string, unknown>, allowed: string[]): void {
  const invalid = Object.keys(input).find(key => !allowed.includes(key))
  if (invalid) throw new Error(`本操作不接受 ${invalid}`)
}

const LIST_RESULT_MAX_CHARS = 3500

/** Keep whole records inside the runtime's 4000-character tool-history budget. */
function page<T extends { id: string; createdAt: number; updatedAt: number }>(items: T[], beforeId: unknown, field: 'memories' | 'goals', extra: Record<string, unknown> = {}) {
  const sorted = [...items].sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id))
  let start = 0
  if (beforeId !== undefined) {
    if (typeof beforeId !== 'string' || !beforeId.trim()) throw new Error('beforeId 必须是已返回的记录ID')
    const index = sorted.findIndex(item => item.id === beforeId)
    if (index < 0) throw new Error('beforeId 不存在，请重新读取第一页')
    start = index + 1
  }
  const selected: T[] = []
  const result = (hasMore: boolean) => ({
    ok: true, ...extra, [field]: selected,
    hasMore, nextBeforeId: hasMore ? selected.at(-1)?.id ?? null : null,
  })
  for (let index = start; index < sorted.length; index += 1) {
    const item = sorted[index]!
    selected.push(item)
    if (JSON.stringify(result(index + 1 < sorted.length)).length <= LIST_RESULT_MAX_CHARS) continue
    selected.pop()
    if (!selected.length) throw new Error(`记录 ${item.id} 超过 ${LIST_RESULT_MAX_CHARS} 字符的整条读取上限，请在控制台查看；未暴露部分字段或来源`)
    break
  }
  return result(start + selected.length < sorted.length)
}

export function createCharacterTools(ctx: CharacterToolContext): AbstractTool[] {
  const memory = new CharacterTool('simCharacterMemory',
    '读取或保存当前角色在本群的经历、观点和兴趣。list只传action和可选beforeId；remember必填kind/content/epistemic/evidenceRefs。转述群友反馈用experience+reported，自己的判断用opinion+inferred，兴趣用interest+inferred或desired；opinion绝不能搭配reported。独立来源分别保存，综合判断另记inferred。来源只用本轮可见的message:序号、receipt:回执ID或memory:记忆ID；observed必须有真实成功回执，不能把调用成功当作资料内容已核实。修正时先读取真实旧记忆，再传supersedes并引用旧memory来源及新证据；不存在旧记录就新建，不虚构修订。成功返回后才能说已记住，不得把愿望或计划记成已完成。', {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'remember'] },
        beforeId: { type: 'string', description: '仅list：下一页传上次nextBeforeId，从最近记录向更早记录分页读取。' },
        kind: { type: 'string', enum: ['experience', 'opinion', 'interest'], description: 'experience保存转述或经历；opinion保存自己的判断且epistemic只能inferred；interest保存兴趣。' },
        content: { type: 'string', description: '只写来源实际支持的内容；多条独立反馈分别保存，自己的综合判断另记。' },
        epistemic: { type: 'string', enum: ['reported', 'observed', 'inferred', 'desired'], description: 'reported=别人说的(experience)；inferred=自己的推测/观点；desired=想做；observed=有成功回执的实际行动。opinion必须inferred。' },
        evidenceRefs: { type: 'array', items: { type: 'string' }, description: 'remember必填，本轮可见来源；修正旧观点时包含memory:旧ID及支持修正的新证据。' },
        supersedes: { type: 'string', description: '仅修正实际存在且可见的旧记忆时传原ID，同时把memory:原ID加入evidenceRefs；首次保存不传。' },
      },
      required: ['action'], additionalProperties: false,
    }, async input => {
      const action = choice(input, 'action', ['list', 'remember'])
      if (action === 'list') {
        fields(input, ['action', 'beforeId'])
        return page((await ctx.read()).memories, input.beforeId, 'memories')
      }
      fields(input, ['action', 'kind', 'content', 'epistemic', 'evidenceRefs', 'supersedes'])
      const id = ctx.makeId('memory')
      const refs = evidence(input, ctx)
      const kind = choice(input, 'kind', ['experience', 'opinion', 'interest'])
      const epistemic = choice(input, 'epistemic', ['reported', 'observed', 'inferred', 'desired'])
      const content = text(input, 'content')
      const supersedes = input.supersedes === undefined ? undefined : text(input, 'supersedes')
      if (supersedes && !ctx.visibleEvidenceRefs().includes(`memory:${supersedes}`)) throw new Error('被修正的记忆本轮不可见')
      if (supersedes && !refs.includes(`memory:${supersedes}`)) throw new Error(`修正记忆必须在 evidenceRefs 中包含 memory:${supersedes}，并保留支持修正的新证据；本次未保存。`)
      const apply = (state: CharacterState) => addCharacterMemory(state, {
        id, kind, content, epistemic, evidenceRefs: refs,
        ...(supersedes === undefined ? {} : { supersedes }),
        ...(ctx.sharedSourceIds?.().length ? { sharedSources: ctx.sharedSourceIds() } : {}),
      }, ctx.visibleEvidenceRefs(), ctx.now())
      const before = ctx.reviewMemory ? await ctx.read() : undefined
      if (before) await ctx.reviewMemory!(input, apply(structuredClone(before)))
      const state = await ctx.update(state => {
        if (before && state.revision !== before.revision) throw new Error('角色状态在一致性检查期间已改变，本次记忆未保存')
        return apply(state)
      })
      return { ok: true, memory: state.memories.find(item => item.id === id) }
    })

  const goal = new CharacterTool('simGoal',
    '管理自己的少量自主目标，不能代替群友已接受的托付账本。普通聊天或只想关注话题不用建目标；若自己已决定稍后主动继续研究，先检查已有目标，新计划create成功后再表达，已有目标复用，不重复创建。后续排期或状态变更及其说明优先合并进simFinishTurn的schedule/wait/complete/abandon，先保存成功才发送。直接调用本工具wait/complete/abandon后旧目标授权失效，之后不继续行动或发言；不能先宣告尚未保存的结果。关键词唤醒不等于目标。create必填title/motivation/nextStep/completionCriteria/stopConditions/evidenceRefs，可选nextCheckInMinutes/expiresInHours/maxAttempts，不传id或outcome。focus只传action/id，在行动前选择目标，执行身份切为自主且不能借群友权限；不要给focus传outcome。wait传action/id及可选nextCheckInMinutes/nextStep/outcome/evidenceRefs，最早15分钟后检查。complete传action/id/evidenceRefs及可选outcome，来源必须有本目标的真实成功回执；abandon传action/id及可选outcome/evidenceRefs。list只传action和可选beforeId。', {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'focus', 'wait', 'complete', 'abandon'], description: '各action字段不能混用；focus仅action/id，结果在wait/complete/abandon的outcome中保存。' },
        beforeId: { type: 'string', description: '仅list：下一页传上次nextBeforeId，从最近记录向更早记录分页读取。' },
        id: { type: 'string', description: '操作已有目标时的ID；创建ID由系统生成。' },
        title: { type: 'string' }, motivation: { type: 'string' },
        nextStep: { type: 'string' }, completionCriteria: { type: 'string' },
        stopConditions: { type: 'array', items: { type: 'string' } },
        evidenceRefs: { type: 'array', items: { type: 'string' } },
        nextCheckInMinutes: { type: 'number', minimum: 15, maximum: 43200 },
        expiresInHours: { type: 'number', minimum: 0.25, maximum: 720 },
        maxAttempts: { type: 'number', minimum: 1, maximum: 8 },
        outcome: { type: 'string', description: '仅wait/complete/abandon：简短结果或放弃理由；create/focus/list不接受，不写完整思考过程。' },
      },
      required: ['action'], additionalProperties: false,
    }, async input => {
      const action = choice(input, 'action', ['list', 'create', 'focus', 'wait', 'complete', 'abandon'])
      if (action === 'list') {
        fields(input, ['action', 'beforeId'])
        const state = await ctx.read()
        return page(state.goals, input.beforeId, 'goals', { paused: state.paused })
      }
      if (action === 'create') {
        fields(input, ['action', 'title', 'motivation', 'nextStep', 'completionCriteria', 'stopConditions', 'evidenceRefs', 'nextCheckInMinutes', 'expiresInHours', 'maxAttempts'])
        const id = ctx.makeId('goal')
        const at = ctx.now()
        const minutes = optionalNumber(input, 'nextCheckInMinutes', 15, 43200)
        const hours = optionalNumber(input, 'expiresInHours', 0.25, 720)
        const maxAttempts = optionalNumber(input, 'maxAttempts', 1, 8)
        const refs = evidence(input, ctx)
        const title = text(input, 'title')
        const motivation = text(input, 'motivation')
        const nextStep = text(input, 'nextStep')
        const completionCriteria = text(input, 'completionCriteria')
        const stopConditions = strings(input, 'stopConditions')
        const state = await ctx.update(state => createCharacterGoal(state, {
          id, title, motivation, nextStep, completionCriteria, stopConditions, evidenceRefs: refs,
          ...(minutes === undefined ? {} : { nextCheckAt: at + minutes * 60_000 }),
          ...(hours === undefined ? {} : { expiresAt: at + hours * 3600_000 }),
          ...(maxAttempts === undefined ? {} : { maxAttempts }),
          ...(ctx.sharedSourceIds?.().length ? { sharedSources: ctx.sharedSourceIds() } : {}),
        }, ctx.visibleEvidenceRefs(), at))
        return { ok: true, goal: state.goals.find(item => item.id === id) }
      }
      const id = text(input, 'id')
      if (action === 'focus') {
        fields(input, ['action', 'id'])
        await ctx.selectGoal(id)
        return { ok: true, goal: (await ctx.read()).goals.find(item => item.id === id), actor: 'autonomous' }
      }
      fields(input, action === 'wait' ? ['action', 'id', 'nextCheckInMinutes', 'nextStep', 'outcome', 'evidenceRefs'] : ['action', 'id', 'outcome', 'evidenceRefs'])
      const at = ctx.now()
      const minutes = optionalNumber(input, 'nextCheckInMinutes', 15, 43200)
      const refs = input.evidenceRefs === undefined ? [] : evidence(input, ctx)
      const lastOutcome = input.outcome === undefined ? undefined : text(input, 'outcome')
      const nextStep = input.nextStep === undefined ? undefined : text(input, 'nextStep')
      const status: CharacterGoal['status'] = action === 'wait' ? 'waiting' : action === 'complete' ? 'completed' : 'abandoned'
      const state = await ctx.update(state => transitionCharacterGoal(state, id, status, {
        now: at,
        ...(action === 'wait' ? { nextCheckAt: at + (minutes ?? 15) * 60_000 } : {}),
        ...(lastOutcome === undefined ? {} : { lastOutcome }),
        ...(nextStep === undefined ? {} : { nextStep }),
        ...(refs.length ? { evidenceRefs: refs } : {}),
      }))
      return { ok: true, goal: state.goals.find(item => item.id === id) }
    })

  const decision = new CharacterTool('simDecide',
    '拒绝或暂缓请求时先调用本工具保存选择及简短理由，成功后再视需要用simSendMessage自然说明；只在聊天里拒绝不会留下决策记录。例如不愿一味迎合：先传kind=unwilling、reason=简短边界理由，再发自然拒绝。engage参与、silent旁听、cannot能力不足、unauthorized未获授权、unwilling不愿意、deferred暂缓。silent/deferred会阻止本轮发送，选择后直接结束。不向群友展示内部理由或标签；选择不会撤销已接受的正式承诺或提升权限。', {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['engage', 'silent', 'cannot', 'unauthorized', 'unwilling', 'deferred'] },
        reason: { type: 'string' },
      },
      required: ['kind', 'reason'], additionalProperties: false,
    }, async input => {
      const kind = choice(input, 'kind', ['engage', 'silent', 'cannot', 'unauthorized', 'unwilling', 'deferred'])
      const reason = text(input, 'reason')
      await ctx.update(state => setCharacterDecision(state, { kind, reason, at: ctx.now() }))
      ctx.onDecision(kind)
      return { ok: true, decision: kind }
    })
  return [memory, goal, decision]
}
