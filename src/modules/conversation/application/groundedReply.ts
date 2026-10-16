import type {TurnInteractionContext} from '../../../contracts/turnInteraction.js'
import {validateActionReply, buildActionReplyFallback} from '../domain/actionReplyGrounding.js'
import {validateDiagnosticReply, buildDiagnosticFallbackReply} from '../domain/diagnosticContext.js'
import {buildTurnInteractionPrompt} from '../domain/turnInteractionContext.js'

export interface ReplyGroundingViolation {code: string; claim: string; reason: string; correctionInstruction: string}
export interface ReplyGroundingAudit {
  original: string
  violations: ReplyGroundingViolation[]
  repairAttempted: boolean
  repaired?: string
  remaining: ReplyGroundingViolation[]
  fallback: boolean
  repairError?: 'unavailable' | 'failed' | 'empty'
}
interface Input {
  candidate: string
  context: TurnInteractionContext
  /** Refresh runtime-owned evidence, including cancellation during generation. */
  refresh?: () => Promise<TurnInteractionContext>
  regenerate?: (candidate: string, instruction: string) => Promise<string | undefined>
  prepare?: (candidate: string) => Promise<string>
}

function validate(reply: string, context: TurnInteractionContext): ReplyGroundingViolation[] {
  return [...validateActionReply(reply, context.actionFacts, context.rawUserText), ...validateDiagnosticReply(reply, context.diagnosticContext)]
}

/** No additional call for an ordinary reply. An evidenced conflict gets at most
 * one text-only regeneration, and neither rejected candidate enters history. */
export async function groundFinalReply(input: Input): Promise<{text: string; context: TurnInteractionContext; audit: ReplyGroundingAudit}> {
  const refresh = async (previous: TurnInteractionContext): Promise<TurnInteractionContext> => {
    if (!input.refresh) return previous
    try {return await input.refresh()}
    catch {
      return previous.actionFacts ? {...previous, actionFacts: {...previous.actionFacts, observedAt: Date.now(), lookup: 'unavailable', tasks: []}} : previous
    }
  }
  let context = await refresh(input.context)
  const violations = validate(input.candidate, context)
  const audit: ReplyGroundingAudit = {original: input.candidate, violations, repairAttempted: false, remaining: [], fallback: false}
  if (!violations.length) return {text: input.candidate, context, audit}
  if (input.regenerate) {
    audit.repairAttempted = true
    const instruction = [
      '【候选回复与事实冲突，重新回答这一轮】',
      '下面的候选尚未发送，也不是新的证据。保留当前人格、原始问题、人物归属和有用内容，仅纠正事实冲突。直接返回完整可发送的正文，不复述校验流程，不调用工具，不增加新的后续承诺。',
      ...violations.map(item => `${item.code}：${item.reason}\n纠正要求：${item.correctionInstruction}`),
      buildTurnInteractionPrompt(context)
    ].join('\n')
    try {
      const candidate = await input.regenerate(input.candidate, instruction)
      if (candidate?.trim()) {
        audit.repaired = input.prepare ? await input.prepare(candidate) : candidate
        // Runtime state can change while the repair is being generated too.
        context = await refresh(context)
        audit.remaining = validate(audit.repaired, context)
        if (audit.repaired.trim() && !audit.remaining.length) return {text: audit.repaired, context, audit}
        if (!audit.repaired.trim()) audit.repairError = 'empty'
      } else audit.repairError = 'empty'
    } catch {
      audit.repairError = 'failed'
    }
  } else audit.repairError = 'unavailable'
  // A timeout, exception or empty repair also spends time. Never build a
  // follow-up promise from a snapshot captured before that wait.
  context = await refresh(context)
  audit.fallback = true
  // Build a fresh answer from evidence; never remove words inside a sentence.
  // A diagnostic and a delivery question can coexist in the same user turn.
  const codes = [...violations, ...audit.remaining].map(item => item.code)
  const diagnostic = codes.some(code => !['unregistered_followup', 'unsupported_task_state', 'unsupported_delivery'].includes(code))
  const action = codes.some(code => ['unregistered_followup', 'unsupported_task_state', 'unsupported_delivery'].includes(code))
  const text = [diagnostic ? buildDiagnosticFallbackReply(context.diagnosticContext) : '', action ? buildActionReplyFallback(context.actionFacts, context.rawUserText) : ''].filter(Boolean).join('\n')
  return {text, context, audit}
}
