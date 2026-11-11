import type { SimRuntimeConfig, SimSessionState } from '../../../contracts/simulation.js'
import { checkSendAllowance, recordSend } from './budget.js'

export interface MessageDeliveryInput {
  /** Exact text after all existing outbound cleaning; no semantic matching. */
  messages: readonly string[]
  /** Only confirmed deliveries in the current turn belong in this set. */
  deliveredTexts: Iterable<string>
  state: SimSessionState
  config: SimRuntimeConfig
  at: number
  sendsThisTurn: number
  /** 直接点名回合（被@/叫名字/提问）跳过小时级节流——被点名必须能回 */
  directAddress?: boolean
}

export type MessageDeliveryPlan =
  | { ok: true; messages: string[]; duplicatesSkipped: number }
  | { ok: false; error: string; duplicatesSkipped: number }

/** Preflight the whole batch without spending quota or recording a delivery. */
export function planMessageDelivery(input: MessageDeliveryInput): MessageDeliveryPlan {
  const seen = new Set(input.deliveredTexts)
  const messages: string[] = []
  let duplicatesSkipped = 0
  for (const text of input.messages) {
    if (seen.has(text)) { duplicatesSkipped++; continue }
    seen.add(text)
    messages.push(text)
  }
  // Acknowledging an already delivered batch must not require another send slot.
  if (!messages.length) return { ok: true, messages, duplicatesSkipped }
  const projected = structuredClone(input.state)
  for (let index = 0; index < messages.length; index++) {
    const allowance = checkSendAllowance(projected, input.config, input.at, input.sendsThisTurn + index, input.directAddress === true)
    if (!allowance.allowed) return {
      ok: false, duplicatesSkipped,
      error: `本批 ${messages.length} 条消息无法全部发送，整批未发送：${allowance.reason}`,
    }
    recordSend(projected, input.at, 1)
  }
  return { ok: true, messages, duplicatesSkipped }
}
