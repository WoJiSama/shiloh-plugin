import { randomUUID } from 'node:crypto'
import { AbstractTool } from '../../toolSupport/infrastructure/AbstractTool.js'

export interface CharacterWorkerTask {
  taskId: string
  kind: 'research' | 'image' | 'browser'
  instruction: string
  evidenceRefs: string[]
}
export interface CharacterWorkerResult {
  status: 'succeeded' | 'failed' | 'unknown'
  summary: string
  artifact?: { title: string; content: string }
}
export interface CharacterWorkerToolPorts {
  run?: (input: CharacterWorkerTask, signal: AbortSignal) => Promise<CharacterWorkerResult>
  ensureActive(): Promise<void>
  visibleEvidenceRefs(): string[]
  /** Test seam; production timeout cannot exceed thirty seconds. */
  timeoutMs?: number
}

function record(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('工作器协议必须是对象')
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some(key => !fields.includes(key))) throw new Error('工作器协议存在未知字段')
  return raw
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('工作器文本为空或超出长度限制')
  return value
}
function refs(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 16) throw new Error('工作器来源必须为非空数组且至多16项')
  const checked = value.map(item => text(item, 180))
  if (new Set(checked).size !== checked.length || checked.some(ref => !/^(?:message:[1-9]\d*|receipt:[^\s:][^\s]*|memory:[^\s:][^\s]*)$/u.test(ref))) throw new Error('工作器来源格式无效')
  return checked
}
function result(value: unknown): CharacterWorkerResult {
  const raw = record(value, ['status', 'summary', 'artifact'])
  if (typeof raw.status !== 'string' || !['succeeded', 'failed', 'unknown'].includes(raw.status)) throw new Error('工作器状态无效')
  const checked: CharacterWorkerResult = { status: raw.status as CharacterWorkerResult['status'], summary: text(raw.summary, 1200) }
  if (raw.artifact !== undefined) {
    if (checked.status !== 'succeeded') throw new Error('未成功的工作器不能交付作品')
    const artifact = record(raw.artifact, ['title', 'content'])
    checked.artifact = { title: text(artifact.title, 120), content: text(artifact.content, 12_000) }
  }
  return checked
}

export function createCharacterWorkerTools({ run, ensureActive, visibleEvidenceRefs, timeoutMs = 30_000 }: CharacterWorkerToolPorts): AbstractTool[] {
  if (!run) return []
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('工作器超时必须为1至30000毫秒')
  const execute = run
  class WorkerTool extends AbstractTool {
    constructor() {
      super()
      this.name = 'simWorkerTask'
      this.description = '向管理员配置的受限工作器提交研究、图像或浏览任务。只接收任务描述与可见来源，不接受地址、凭据、群号或执行路径。taskId由运行时生成；超时或取消结果为unknown，不能盲目重试。成功返回的文本作品由运行时保存到本群作品区，结果给出savedWork；保存失败会明确说明。作品只是草稿，本工具不发消息、不自动公开作品。外部权限由配置的工作器网关决定。'
      this.parameters = {
        type: 'object', additionalProperties: false, required: ['kind', 'instruction', 'evidenceRefs'], properties: {
          kind: { type: 'string', enum: ['research', 'image', 'browser'] },
          instruction: { type: 'string', minLength: 1, maxLength: 2000 },
          evidenceRefs: { type: 'array', items: { type: 'string' } },
        },
      }
    }
    override normalizeParameters(params: unknown) {
      return record(params, ['kind', 'instruction', 'evidenceRefs'])
    }
    override validateParameters(params: Record<string, unknown>) {
      try {
        record(params, ['kind', 'instruction', 'evidenceRefs'])
        if (typeof params.kind !== 'string' || !['research', 'image', 'browser'].includes(params.kind)) return '工作器任务种类无效'
        text(params.instruction, 2000); refs(params.evidenceRefs)
        return true
      } catch (error) { return error instanceof Error ? error.message : '工作器参数无效' }
    }
    override async func(input: Record<string, unknown>, event: unknown) {
      await ensureActive()
      const evidenceRefs = refs(input.evidenceRefs), visible = new Set(visibleEvidenceRefs())
      if (evidenceRefs.some(ref => !visible.has(ref))) throw new Error('工作器引用了本轮不可见的来源')
      const suppliedTaskId = (event as { simulationTaskId?: unknown } | null)?.simulationTaskId
      const controller = new AbortController(), taskId = typeof suppliedTaskId === 'string' && /^[a-zA-Z0-9-]{1,128}$/u.test(suppliedTaskId) ? suppliedTaskId : randomUUID()
      const task: CharacterWorkerTask = { taskId, kind: input.kind as CharacterWorkerTask['kind'], instruction: text(input.instruction, 2000), evidenceRefs }
      let timer: ReturnType<typeof setTimeout> | undefined, poll: ReturnType<typeof setInterval> | undefined, checking = false
      let interrupt!: (outcome: CharacterWorkerResult) => void
      const interrupted = new Promise<CharacterWorkerResult>(resolve => { interrupt = resolve })
      const unknown = (summary: string): CharacterWorkerResult => ({ status: 'unknown', summary })
      const cancel = (summary: string) => { controller.abort(); interrupt(unknown(summary)) }
      try {
        timer = setTimeout(() => cancel('工作器已超时，外部结果未知；核实taskId后再决定，不能自动重试'), timeoutMs)
        poll = setInterval(() => {
          if (checking || controller.signal.aborted) return
          checking = true
          void ensureActive().catch(() => cancel('来源或执行授权已失效，已请求取消；外部结果未知')).finally(() => { checking = false })
        }, Math.min(250, Math.max(1, timeoutMs)))
        const execution = Promise.resolve().then(() => execute(task, controller.signal))
          .then(value => {
            try { return result(value) } catch { return unknown('工作器返回协议无效，已丢弃未校验结果；外部结果未知') }
          }, () => unknown('工作器调用未取得可确认回执，外部结果未知'))
        let outcome = await Promise.race([execution, interrupted])
        try { await ensureActive() } catch { controller.abort(); outcome = unknown('来源或执行授权已失效，已请求取消；外部结果未知') }
        const report = (event as { simulationReportOutcome?: unknown } | null)?.simulationReportOutcome
        if (outcome.status !== 'unknown' && typeof report === 'function') report(outcome.status)
        return { taskId, ...outcome }
      } finally {
        if (timer) clearTimeout(timer)
        if (poll) clearInterval(poll)
        controller.abort()
      }
    }
  }
  return [new WorkerTool()]
}
