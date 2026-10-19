import { shouldSampleSkippedIntent } from '../domain/intentFastPath.js'

export interface IntentShadowResult {
  status: 'match' | 'mismatch' | 'unavailable' | 'timeout' | 'error'
  elapsedMs: number
  intent?: string
  confidence?: number
  reason?: string
}

interface ShadowDecision { intent?: string; confidence?: number; reason?: string }
export interface IntentShadowOptions {
  enabled?: boolean
  isCasualFastPath: boolean
  rate?: number
  maxConcurrent?: number
  timeoutMs?: number
  minConfidence?: number
  classify(options: {signal: AbortSignal; timeoutMs: number}): Promise<ShadowDecision | null>
  onResult(result: IntentShadowResult): void | Promise<void>
}

function bounded(value: number | undefined, fallback: number, min: number, max: number) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Number(value))) : fallback
}

/** No queue: shadow traffic is dropped when its independent budget is occupied.
 * A timed-out classifier keeps its slot until it actually settles, even when it
 * ignores AbortSignal, so slow backends cannot accumulate background requests. */
export function createIntentShadowSampler({ random = Math.random, now = Date.now } = {}) {
  let active = 0
  return function scheduleSkippedIntentShadow(options: IntentShadowOptions): boolean {
    const capacity = Math.floor(bounded(options.maxConcurrent, 1, 1, 8))
    if (!options.enabled || !options.isCasualFastPath || active >= capacity) return false
    if (!shouldSampleSkippedIntent(options.rate ?? 0.1, random)) return false
    active++
    const timeoutMs = bounded(options.timeoutMs, 3000, 1, 30000)
    const minConfidence = bounded(options.minConfidence, 0.7, 0, 1)
    const startedAt = now()
    const controller = new AbortController()
    let reported = false
    const report = (result: Omit<IntentShadowResult, 'elapsedMs'>) => {
      if (reported) return
      reported = true
      // Neither a throwing logger nor an asynchronous archive failure may leak
      // an unhandled rejection into the real conversation.
      try {
        void Promise.resolve(options.onResult({ ...result, elapsedMs: Math.max(0, now() - startedAt) })).catch(() => {})
      } catch {}
    }
    const timer = setTimeout(() => {
      report({ status: 'timeout', reason: 'shadow_timeout' })
      controller.abort()
    }, timeoutMs)
    void Promise.resolve()
      .then(() => options.classify({ signal: controller.signal, timeoutMs }))
      .then(decision => {
        const intent = String(decision?.intent || '').trim()
        const confidence = Number(decision?.confidence)
        if (!intent || intent === 'unavailable' || !Number.isFinite(confidence) || confidence < minConfidence) {
          report({ status: 'unavailable', reason: intent && intent !== 'unavailable' ? 'low_confidence' : 'classifier_unavailable' })
          return
        }
        report({ status: ['chat', 'noise'].includes(intent) ? 'match' : 'mismatch', intent, confidence: Math.min(1, Math.max(0, confidence)) })
      })
      .catch(() => report({ status: 'error', reason: 'classifier_error' }))
      .finally(() => {
        clearTimeout(timer)
        active--
      })
    return true
  }
}

export const scheduleSkippedIntentShadow = createIntentShadowSampler()
