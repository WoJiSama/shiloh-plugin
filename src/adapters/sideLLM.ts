export interface SideLLMOptions {
  url?: string
  apikey?: string
  model?: string
  messages?: readonly { role: string; content: unknown }[]
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
  signal?: AbortSignal | null
  fetchImpl?: typeof fetch | null
}
export type SideLLMResult = { ok: true; content: string } | { ok: false; error: string; status?: number }
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}
/** Transport errors are values so each caller retains its own fallback policy. */
export async function sideLLMCall({ url, apikey, model, messages, temperature = 0.2, maxTokens,
  timeoutMs = 30000, signal = null, fetchImpl = null }: SideLLMOptions = {}): Promise<SideLLMResult> {
  const endpoint = String(url || '').trim()
  if (!endpoint || !apikey || !model || !Array.isArray(messages) || !messages.length) {
    return { ok: false, error: 'sideLLMCall 缺少 url/apikey/model/messages' }
  }
  const doFetch = fetchImpl || globalThis.fetch
  if (!doFetch) return { ok: false, error: 'fetch 不可用' }
  const body: { model: string; messages: SideLLMOptions['messages']; temperature: number; max_tokens?: number } = { model, messages, temperature }
  if (Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0) body.max_tokens = Number(maxTokens)
  const controller = new AbortController()
  let timedOut = false
  const onAbort = () => controller.abort(signal?.reason)
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, Math.max(1000, Number(timeoutMs) || 30000))
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    signal?.throwIfAborted()
    const response = await doFetch(endpoint, {
      method: 'POST', headers: { Authorization: `Bearer ${apikey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: controller.signal
    })
    signal?.throwIfAborted()
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return { ok: false, error: `模型请求失败: ${response.status} ${String(text).slice(0, 160)}`, status: response.status }
    }
    const data = record(await response.json())
    const first = Array.isArray(data.choices) ? record(data.choices[0]) : {}
    const content = String(record(first.message).content || '').trim()
    if (!content) return { ok: false, error: '模型返回空', status: response.status }
    return { ok: true, content }
  } catch (error) {
    if (signal?.aborted) return { ok: false, error: '模型请求已取消' }
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, error: timedOut || /abort|timeout/i.test(message) ? `模型请求超时(${timeoutMs}ms)` : `模型请求异常: ${message}` }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}
