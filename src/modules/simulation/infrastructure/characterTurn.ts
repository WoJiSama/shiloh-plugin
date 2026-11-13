import type { CharacterState, CharacterMemory, CharacterGoal, CharacterDecision } from '../../../contracts/character.js'
import { AbstractTool, type ParameterSchema } from '../../toolSupport/infrastructure/AbstractTool.js'
import { createCharacterTools, type CharacterToolContext } from './characterTools.js'

export const CHARACTER_TURN_CHOICES = ['chat', 'interest_only', 'silent', 'cannot', 'unauthorized', 'unwilling', 'deferred', 'schedule', 'wait', 'complete', 'abandon'] as const
export type CharacterTurnChoice = typeof CHARACTER_TURN_CHOICES[number]

export interface CharacterTurnFinishResult {
  choice: CharacterTurnChoice
  state: CharacterState
  memories?: CharacterMemory[]
  goal?: CharacterGoal
  decision?: CharacterDecision['kind']
  messages?: string[]
  replyToSeq?: number
  atUserIds?: string[]
  throughSeq?: number
}

export interface CharacterTurnToolContext extends Pick<CharacterToolContext, 'now' | 'read' | 'update' | 'visibleEvidenceRefs' | 'makeId' | 'sharedSourceIds'> {
  ensureActive(): Promise<void>
  review?(input: { candidate: Record<string, unknown>; state: CharacterState }): Promise<void>
  finish(result: CharacterTurnFinishResult): Promise<unknown>
}

const GOAL_ACTIONS = { schedule: 'create', wait: 'wait', complete: 'complete', abandon: 'abandon' } as const
const DECISION_CHOICES = new Set(['silent', 'cannot', 'unauthorized', 'unwilling', 'deferred'])
const TOP_FIELDS = ['choice', 'reason', 'memories', 'goal', 'messages', 'replyToSeq', 'atUserIds', 'throughSeq']

function object(value: unknown, allowed: string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} 必须是对象`)
  const input = value as Record<string, unknown>
  const unknown = Object.keys(input).find(key => !allowed.includes(key))
  if (unknown) throw new Error(`${field} 不接受 ${unknown}`)
  return input
}

function optionalInteger(input: Record<string, unknown>, field: string, min: number): number | undefined {
  if (!Object.hasOwn(input, field)) return undefined
  const value = input[field]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new Error(`${field} 必须是至少 ${min} 的整数`)
  return value
}

function nestedSchema(tool: AbstractTool): ParameterSchema {
  return {
    ...structuredClone(tool.parameters),
    properties: Object.fromEntries(Object.entries(tool.parameters.properties).filter(([key]) => key !== 'action').map(([key, value]) => [key, structuredClone(value)])),
    required: tool.parameters.required.filter(key => key !== 'action'),
    description: tool.description,
  }
}

interface TurnInput extends Omit<CharacterTurnFinishResult, 'state' | 'memories' | 'goal' | 'decision'> {
  reason: string
  memories: Record<string, unknown>[]
  goal?: Record<string, unknown>
}

function parse(input: Record<string, unknown>, memoryFields: string[], goalFields: string[]): TurnInput {
  object(input, TOP_FIELDS, '收尾参数')
  if (typeof input.choice !== 'string' || !CHARACTER_TURN_CHOICES.includes(input.choice as CharacterTurnChoice)) throw new Error('choice 必须是明确的允许选项')
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 600) throw new Error('reason 必须是非空、至多 600 字符的简短理由，不写思考过程')
  const choice = input.choice as CharacterTurnChoice
  const memories = Object.hasOwn(input, 'memories') ? input.memories : []
  if (!Array.isArray(memories) || memories.length > 2) throw new Error('memories 必须是至多两条记忆的数组')
  const checkedMemories = memories.map(value => object(value, memoryFields, 'memories 记录'))
  const goalAction = Object.hasOwn(GOAL_ACTIONS, choice)
  const goal = goalAction ? object(input.goal, goalFields, 'goal') : undefined
  if (!goalAction && Object.hasOwn(input, 'goal')) throw new Error('当前 choice 不接受 goal')
  let messages: string[] | undefined
  if (Object.hasOwn(input, 'messages')) {
    if (choice === 'silent' || choice === 'deferred') throw new Error('silent/deferred 不接受 messages')
    const values = typeof input.messages === 'string' ? [input.messages] : input.messages
    if (!Array.isArray(values) || values.length < 1 || values.length > 5 || values.some(value => typeof value !== 'string' || !value.trim() || value.length > 500)) throw new Error('messages 必须是 1 至 5 条非空字符串，每条至多 500 字符')
    messages = values as string[]
  }
  const replyToSeq = optionalInteger(input, 'replyToSeq', 1)
  const throughSeq = optionalInteger(input, 'throughSeq', 0)
  let atUserIds: string[] | undefined
  if (Object.hasOwn(input, 'atUserIds')) {
    const values = input.atUserIds
    if (!Array.isArray(values) || values.length > 3 || values.some(value => typeof value !== 'string' || !/^\d{1,12}$/u.test(value))) throw new Error('atUserIds 必须是至多 3 个 QQ 号数字字符串')
    atUserIds = values as string[]
  }
  if (!messages && (replyToSeq !== undefined || atUserIds !== undefined)) throw new Error('replyToSeq/atUserIds 只能与 messages 一起使用')
  return {
    choice, reason: input.reason.trim(), memories: checkedMemories,
    ...(goal === undefined ? {} : { goal }), ...(messages === undefined ? {} : { messages }),
    ...(replyToSeq === undefined ? {} : { replyToSeq }), ...(atUserIds === undefined ? {} : { atUserIds }),
    ...(throughSeq === undefined ? {} : { throughSeq }),
  }
}

/** Validate with the existing tools on a private draft, then commit once. No transport is owned here. */
export function createCharacterTurnTool(ctx: CharacterTurnToolContext): AbstractTool {
  const schemas = createCharacterTools({ ...ctx,
    selectGoal: async () => { throw new Error('收尾不支持 focus') }, onDecision: () => {},
  })
  const memoryTool = schemas.find(tool => tool.name === 'simCharacterMemory')!
  const goalTool = schemas.find(tool => tool.name === 'simGoal')!
  const memoryFields = Object.keys(memoryTool.parameters.properties).filter(key => key !== 'action')
  const goalFields = Object.keys(goalTool.parameters.properties).filter(key => key !== 'action')

  class FinishTurnTool extends AbstractTool {
    constructor() {
      super()
      this.name = 'simFinishTurn'
      this.description = '显式选择本轮如何结束。chat普通聊天、interest_only仅有兴趣不承诺后续、silent旁听、cannot做不到、unauthorized未授权、unwilling不愿意、deferred暂缓；这些选择不自动建目标。schedule创建新自主目标，wait调整已有目标，complete完成有本目标成功回执的目标，abandon放弃目标。可显式保存至多两条有来源记忆；所有变更先完整校验再一次保存，成功后才交运行时发送可选消息、标读并结束本轮。reason只写简短选择理由。goal与memories都不传action，schedule也不传id；不支持focus。不推测聊天文字、不补来源、不自动发消息或重试。保存失败不表示安排或完成已生效，拒绝仍然自由。silent/deferred禁止messages；其余选择可发1至5条消息。throughSeq仅能提交实际看过的范围，由运行时再核对。'
      this.parameters = {
        type: 'object', additionalProperties: false, required: ['choice', 'reason'], properties: {
          choice: { type: 'string', enum: [...CHARACTER_TURN_CHOICES] },
          reason: { type: 'string', minLength: 1, maxLength: 600, description: '本轮选择的简短理由，不写思考链。' },
          memories: { type: 'array', maxItems: 2, description: '保存你自己的经历、兴趣或观点。你明确说了自己还想弄懂哪个具体问题，且下次可接着聊时，同次提交 interest/inferred 和当下消息来源；content 写想弄懂的那一点。已有兴趣就沿用，随口客套无需保存。形成可延续的选择或修订原判断时提交 opinion/inferred；修订带 supersedes=旧记录ID，evidenceRefs 同时引用旧记录与新证据。待办、相处习惯和小习惯在收尾前单独用 simRemember。每项不传 action 或新记录 id。', items: nestedSchema(memoryTool) },
          goal: { ...nestedSchema(goalTool), description: `仅 schedule/wait/complete/abandon 使用，操作由 choice 固定，不传 action。${goalTool.description}` },
          messages: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', minLength: 1, maxLength: 500 }, description: '可选的最终群消息；兼容单个字符串。silent/deferred 禁止。' },
          replyToSeq: { type: 'number', minimum: 1, description: '可选：引用已展示的消息序号，须为整数。' },
          atUserIds: { type: 'array', maxItems: 3, items: { type: 'string', pattern: '^\\d{1,12}$' } },
          throughSeq: { type: 'number', minimum: 0, description: '可选：显式标读到实际看过的连续消息位置，须为整数。' },
        },
      }
    }
    override normalizeParameters(params: unknown) { return object(params, TOP_FIELDS, '收尾参数') }
    override validateParameters(params: Record<string, unknown>) {
      try { parse(params, memoryFields, goalFields); return true }
      catch (error) { return error instanceof Error ? error.message : '收尾参数无效' }
    }
    override async func(params: Record<string, unknown>): Promise<unknown> {
      const input = parse(params, memoryFields, goalFields)
      await ctx.ensureActive()
      const snapshot = structuredClone(await ctx.read())
      let draft = structuredClone(snapshot), changed = false
      const visible = [...ctx.visibleEvidenceRefs()]
      const localTools = createCharacterTools({
        now: ctx.now, read: async () => structuredClone(draft),
        update: async mutate => { draft = mutate(structuredClone(draft)); changed = true; return structuredClone(draft) },
        visibleEvidenceRefs: () => [...visible], makeId: ctx.makeId,
        ...(ctx.sharedSourceIds ? { sharedSourceIds: ctx.sharedSourceIds } : {}),
        selectGoal: async () => { throw new Error('收尾不支持 focus') }, onDecision: () => {},
      })
      const apply = async (name: string, value: Record<string, unknown>) => {
        const tool = localTools.find(tool => tool.name === name)!
        const result = await tool.execute(value, {})
        if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) throw new Error(typeof result === 'string' ? result : '角色草稿校验失败')
      }
      for (const memory of input.memories) await apply('simCharacterMemory', { ...memory, action: 'remember' })
      if (input.goal) await apply('simGoal', { ...input.goal, action: GOAL_ACTIONS[input.choice as keyof typeof GOAL_ACTIONS] })
      if (DECISION_CHOICES.has(input.choice)) await apply('simDecide', { kind: input.choice, reason: input.reason })
      await ctx.review?.({ candidate: { ...structuredClone(input) }, state: structuredClone(draft) })
      await ctx.ensureActive()
      const stillVisible = new Set(ctx.visibleEvidenceRefs())
      const submittedRefs = [...input.memories, ...(input.goal ? [input.goal] : [])].flatMap(item => Array.isArray(item.evidenceRefs) ? item.evidenceRefs : [])
      if (submittedRefs.some(ref => typeof ref !== 'string' || !stillVisible.has(ref))) throw new Error('一致性检查期间引用来源已不可见，收尾未提交')
      const state = changed ? await ctx.update(current => {
        if (current.revision !== snapshot.revision) throw new Error('角色状态已改变，收尾未提交，请重新读取后选择')
        return structuredClone(draft)
      }) : snapshot
      const goal = input.goal ? state.goals.find(item => !snapshot.goals.some(old => old.id === item.id) || (item.id === input.goal!.id && item.revision !== snapshot.goals.find(old => old.id === item.id)?.revision)) : undefined
      return await ctx.finish({ choice: input.choice, state,
        memories: state.memories.filter(item => !snapshot.memories.some(old => old.id === item.id)),
        ...(goal ? { goal } : {}),
        ...(DECISION_CHOICES.has(input.choice) && state.decision ? { decision: state.decision.kind } : {}),
        ...(input.messages === undefined ? {} : { messages: input.messages }),
        ...(input.replyToSeq === undefined ? {} : { replyToSeq: input.replyToSeq }),
        ...(input.atUserIds === undefined ? {} : { atUserIds: input.atUserIds }),
        ...(input.throughSeq === undefined ? {} : { throughSeq: input.throughSeq }),
      })
    }
  }
  return new FinishTurnTool()
}
