// 旁路模型调用统一传输层:TimingGate/中期记忆/记忆抽取反思等小模型调用共用。
// 只统一 HTTP 传输(超时/鉴权/错误形状),解析与降级策略留在各调用方。
// 主对话仍走 apiClient.YTapi,不经此层。
const DEFAULT_TIMEOUT_MS = 30000

/**
 * OpenAI 兼容 chat/completions 调用。
 * @returns {Promise<{ok: true, content: string}|{ok: false, error: string, status?: number}>}
 * 超时/网络错误/非 2xx 一律返回 ok:false,不抛错——调用方按自己的策略降级。
 */
export async function sideLLMCall({
  url,
  apikey,
  model,
  messages,
  temperature = 0.2,
  maxTokens,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal = null,
  fetchImpl = null
} = {}) {
  const endpoint = String(url || "").trim()
  if (!endpoint || !apikey || !model || !Array.isArray(messages) || !messages.length) {
    return { ok: false, error: "sideLLMCall 缺少 url/apikey/model/messages" }
  }
  const doFetch = fetchImpl || globalThis.fetch
  if (!doFetch) return { ok: false, error: "fetch 不可用" }
  const body = { model, messages, temperature }
  if (Number.isFinite(Number(maxTokens)) && Number(maxTokens) > 0) body.max_tokens = Number(maxTokens)
  const timeoutSignal = AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS))
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  try {
    const response = await doFetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apikey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: combined
    })
    if (!response.ok) {
      const text = await response.text().catch(() => "")
      return { ok: false, error: `模型请求失败: ${response.status} ${String(text).slice(0, 160)}`, status: response.status }
    }
    const data = await response.json()
    const content = String(data?.choices?.[0]?.message?.content || "").trim()
    if (!content) return { ok: false, error: "模型返回空", status: response.status }
    return { ok: true, content }
  } catch (error) {
    const message = String(error?.message || error)
    return { ok: false, error: /abort|timeout/i.test(message) ? `模型请求超时(${timeoutMs}ms)` : `模型请求异常: ${message}` }
  }
}
