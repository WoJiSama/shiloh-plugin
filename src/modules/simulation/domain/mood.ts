/** 情绪四轴（跨群全局——你自己此刻的状态，所有群共用一个你）。
 *  借鉴 companion_v2 的 mood 模型：半衰期回归（情绪有惯性、会自然消散）+ 有界单步更新
 *  （一条消息掀不起惊涛骇浪，一个回合内连调几次也到不了极端）。
 *  分工：程序管不变量（衰减投影/包络/静息目标），模型管表达（delta 与理由）。 */
import type { SimMoodState } from '../../../contracts/simulation.js'

export const MOOD_AXES = ['joy', 'anger', 'sorrow', 'fear'] as const
export type MoodAxis = (typeof MOOD_AXES)[number]

/** 静息目标：joy 回到平常基线 5，三个负性轴回到 1（没有）。 */
export const MOOD_RESTING: Record<MoodAxis, number> = { joy: 5, anger: 1, sorrow: 1, fear: 1 }
/** 中性带：投影落在这些区间视为"情绪平常"，不注入段落（缺席=平常，省 token）。 */
const NEUTRAL_BAND: Record<MoodAxis, [number, number]> = { joy: [4, 6], anger: [1, 2], sorrow: [1, 2], fear: [1, 2] }
/** 更新后超过这么久仍非中性 → 注入"余韵"措辞（按消退中的余韵拿捏，不维持峰值）。 */
export const MOOD_DECAY_NOTE_AFTER_MS = 30 * 60_000

/** 存储形状归一化：只信白名单字段、数值夹取；null/非对象返回 null（从未写过）。 */
export function normalizeSimMood(raw: unknown, now: number): SimMoodState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const source = raw as { axes?: unknown; updatedAt?: unknown; reasons?: unknown }
  const rawAxes = source.axes && typeof source.axes === 'object' && !Array.isArray(source.axes) ? source.axes as Record<string, unknown> : {}
  const axes = {} as Record<MoodAxis, number>
  for (const axis of MOOD_AXES) {
    const value = Math.round(Number(rawAxes[axis]))
    axes[axis] = Number.isFinite(value) ? Math.min(10, Math.max(1, value)) : MOOD_RESTING[axis]
  }
  const updatedAt = Number(source.updatedAt)
  const reasons = Array.isArray(source.reasons)
    ? source.reasons.map(r => String(r || '').trim().slice(0, 60)).filter(Boolean).slice(0, 8)
    : []
  return { axes, updatedAt: Number.isFinite(updatedAt) && updatedAt > 0 ? updatedAt : now, ...(reasons.length ? { reasons } : {}) }
}

/** 单轴半衰期回归：target + (value - target) * 0.5^(elapsed/halfLife)。 */
export function decayedAxis(value: number, target: number, elapsedMs: number, halfLifeMs: number): number {
  if (elapsedMs <= 0) return value
  const ratio = Math.pow(0.5, elapsedMs / Math.max(1, halfLifeMs))
  return target + (value - target) * ratio
}

/** 读取时实时投影衰减（存储只存最近一次写入的瞬时值，不落盘衰减）。null = 从未写过 → 静息。 */
export function projectMood(mood: SimMoodState | null, now: number, halfLifeMs: number): Record<MoodAxis, number> {
  const elapsed = mood ? Math.max(0, now - mood.updatedAt) : 0
  const out = {} as Record<MoodAxis, number>
  for (const axis of MOOD_AXES) {
    out[axis] = mood ? decayedAxis(mood.axes[axis], MOOD_RESTING[axis], elapsed, halfLifeMs) : MOOD_RESTING[axis]
  }
  return out
}

export function isNeutralMood(axes: Record<MoodAxis, number>): boolean {
  return MOOD_AXES.every(axis => {
    const value = Math.round(axes[axis])
    return value >= NEUTRAL_BAND[axis][0] && value <= NEUTRAL_BAND[axis][1]
  })
}

export interface MoodUpdateResult {
  mood: SimMoodState
  /** 实际生效的每轴变动（只含有请求的轴；值可能为 0=被包络夹住） */
  applied: Partial<Record<MoodAxis, number>>
  /** 任一轴被 delta 上限或回合包络截取 */
  capped: boolean
}

/**
 * 有界更新：从「当前衰减投影」出发——单轴 delta 夹 ±maxStep，且结果不越出「回合锚点 ±maxStep」
 * （锚点=本回合开始时的投影；防止一个回合内反复调用把情绪推到极端——情绪有惯性）。
 */
export function applyMoodUpdate(input: {
  mood: SimMoodState | null
  deltas: Partial<Record<MoodAxis, number>>
  reason: string
  now: number
  halfLifeMs: number
  maxStep: number
  turnAnchor?: Record<MoodAxis, number>
}): MoodUpdateResult {
  const projected = projectMood(input.mood, input.now, input.halfLifeMs)
  const anchor = input.turnAnchor || projected
  const axes = {} as Record<MoodAxis, number>
  const applied: Partial<Record<MoodAxis, number>> = {}
  let capped = false
  for (const axis of MOOD_AXES) {
    const delta = Math.round(Number(input.deltas[axis]))
    if (!Number.isFinite(delta) || delta === 0) {
      axes[axis] = Math.round(projected[axis])
      continue
    }
    const step = Math.min(input.maxStep, Math.max(-input.maxStep, delta))
    if (step !== delta) capped = true
    const lo = Math.max(1, Math.round(anchor[axis]) - input.maxStep)
    const hi = Math.min(10, Math.round(anchor[axis]) + input.maxStep)
    let next = Math.round(projected[axis] + step)
    if (next < lo || next > hi) {
      next = Math.min(hi, Math.max(lo, next))
      capped = true
    }
    axes[axis] = Math.min(10, Math.max(1, next))
    applied[axis] = axes[axis] - Math.round(projected[axis])
  }
  const reason = String(input.reason || '').trim().slice(0, 60)
  const reasons = [...(reason ? [reason] : []), ...(input.mood?.reasons || [])].slice(0, 8)
  return { mood: { axes, updatedAt: input.now, ...(reasons.length ? { reasons } : {}) }, applied, capped }
}

const AXIS_NAME: Record<MoodAxis, string> = { joy: '开心', anger: '生气', sorrow: '难过', fear: '担心' }

/** 数值 → 体感词（预翻译：模型拿到的是人描述自己状态的词汇，不是裸数据）。 */
function axisPhrase(axis: MoodAxis, value: number): string {
  const v = Math.round(value)
  const label = (word: string) => `${word}（${axis} ${v}/10）`
  switch (axis) {
    case 'joy':
      if (v >= 9) return label('特别开心')
      if (v >= 7) return label('挺开心')
      if (v <= 3) return label('有点蔫、提不起劲')
      return ''
    case 'anger':
      if (v >= 5) return label('生气')
      if (v >= 3) return label('有点不爽')
      return ''
    case 'sorrow':
      if (v >= 9) return label('很难过')
      if (v >= 5) return label('挺难过')
      if (v >= 3) return label('有点难过')
      return ''
    case 'fear':
      if (v >= 5) return label('挺担心')
      if (v >= 3) return label('有点担心')
      return ''
  }
}

function activePhrases(axes: Record<MoodAxis, number>): string[] {
  return MOOD_AXES.map(axis => axisPhrase(axis, axes[axis])).filter(Boolean)
}

/** 唤醒注入段：中性带/从未写过返回空串。含"状态是底色不是汇报"与"余韵"约束（对齐 companion 的措辞）。 */
export function formatMoodSection(mood: SimMoodState | null, now: number, halfLifeMs: number): string {
  if (!mood) return ''
  const projected = projectMood(mood, now, halfLifeMs)
  const phrases = activePhrases(projected)
  if (!phrases.length) return ''
  const lines = [
    '【你的情绪底色】（当前角色在本群的模拟状态。自然影响这轮的用词、节奏和情绪浓度——可以带出感受，但别把数值说出口、别写成状态汇报；它不改变事实、判断，也不改变你回不回。上一阵的情绪即使本轮在聊别的事，也可以留一点自然的余温，不必一秒切回机械语气）',
    ...phrases.map(p => `- ${p}`),
  ]
  if (now - mood.updatedAt > MOOD_DECAY_NOTE_AFTER_MS) {
    lines.push('（这些情绪在随时间慢慢消退——按余韵拿捏分寸，不必维持刚发生时的顶峰强度）')
  }
  return lines.join('\n')
}

/** 状态展示用单行摘要（.仿真 状态 / simGetState）：中性返回"平常"。 */
export function moodSummaryLine(mood: SimMoodState | null, now: number, halfLifeMs: number): string {
  const projected = projectMood(mood, now, halfLifeMs)
  const phrases = activePhrases(projected)
  return phrases.length ? phrases.join('、') : '平常'
}
