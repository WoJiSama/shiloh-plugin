import { resolveChatCompletionUrl } from "../domain/chatCompletionUrl.js"
export interface ProbeResponse { status: number; ok: boolean; text(): Promise<string> }
export type ProbeFetch = (url: string, options: RequestInit) => Promise<ProbeResponse>
export interface ProbeProvider { name?: unknown; apiUrl?: unknown; apiKey?: unknown; model?: unknown }
export interface ProbeOptions { timeoutMs?: number }
export interface ProbeResult { name: string; ok: boolean; ms: number; detail: string }
function record(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {} }
export function createProviderProbe(fetch: ProbeFetch, now: () => number = Date.now) {
// AI 模型配置连通性探针：锅巴「测试连通性」按钮的后端实现。
// 对已保存的每个 provider 发一次最小请求，回报延迟或上游真实错误原因。
// 纯函数模块：不依赖插件运行时全局，便于测试与独立脚本复用。

const DEFAULT_PROBE_TIMEOUT_MS = 15000
const MAX_PROBE_PROVIDERS = 8

const KIND_BY_CONFIG_KEY: Record<string, string> = {
  embeddingAiConfig: "embedding",
  imageEditAiConfig: "image",
  imageGenerationAiConfig: "image"
}

function classifyConfigKind(configKey = "") {
  return KIND_BY_CONFIG_KEY[String(configKey)] || "chat"
}

/** 输出前抹掉密钥形态的字符串，避免 toast/日志泄漏 key */
function maskSecrets(text = "") {
  return String(text)
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, "sk-***")
    .replace(/Bearer\s+[A-Za-z0-9._-]{6,}/gi, "Bearer ***")
}

async function requestJson(url: string, options: RequestInit = {}, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = now()
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    const text = await response.text()
    let body: unknown = null
    try { body = JSON.parse(text) } catch { body = null }
    return { status: response.status, ok: response.ok, body, text, ms: now() - startedAt }
  } finally {
    clearTimeout(timer)
  }
}

function upsertError(value: unknown) {
  const body = record(value)
  const message = record(body.error).message || body.message || body.error || ""
  return typeof message === "string" ? message : (JSON.stringify(message) || "").slice(0, 160)
}

async function postChat(apiUrl: string, apiKey: unknown, model: unknown, payload: object, timeoutMs: number) {
  return await requestJson(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload)
  }, timeoutMs)
}

async function probeChat(provider: ProbeProvider, timeoutMs: number) {
  const payload: { model: unknown; messages: { role: string; content: string }[]; max_tokens?: number; max_completion_tokens?: number; stream: boolean } = { model: provider.model, messages: [{ role: "user", content: "ping" }], max_tokens: 5, stream: false }
  let response = await postChat(resolveChatCompletionUrl(String(provider.apiUrl || "")), provider.apiKey, provider.model, payload, timeoutMs)
  // 部分新模型只认 max_completion_tokens：400 且提示该词时换参数重试一次
  if (response.status === 400 && /max_tokens/i.test(upsertError(response.body) || "")) {
    delete payload.max_tokens
    payload.max_completion_tokens = 5
    response = await postChat(resolveChatCompletionUrl(String(provider.apiUrl || "")), provider.apiKey, provider.model, payload, timeoutMs)
  }
  if (!response.ok) {
    return { ok: false, detail: `HTTP ${response.status}${upsertError(response.body) ? ` ${upsertError(response.body)}` : ""}` }
  }
  const choices = record(response.body).choices
  const choice = record(record(Array.isArray(choices) ? choices[0] : null).message).content
  const rawUsage = record(record(response.body).usage).total_tokens
  const usage = typeof rawUsage === "number" ? rawUsage : NaN
  const reply = String(choice || "").replace(/\s+/g, " ").trim().slice(0, 20)
  // 空正文 + 0/缺失 usage：渠道返回了 200 但没有真正生成，机器人实际调用也会拿到空回复
  if (!reply && (!Number.isFinite(usage) || usage === 0)) {
    return { ok: false, detail: "HTTP 200 但空回复且 0 tokens——渠道没有真正生成，请检查网关渠道或模型名" }
  }
  if (!reply && Number.isFinite(usage) && usage > 0) {
    return { ok: true, detail: `${provider.model} 连通正常（${usage} tokens 全部用于思考，无正文，思考型模型小额度下的正常现象）` }
  }
  return { ok: true, detail: `${provider.model} 正常回复${reply ? `「${reply}」` : ""}${Number.isFinite(usage) ? `（${usage} tokens）` : ""}` }
}

function resolveEmbeddingsUrl(apiUrl = "") {
  const url = String(apiUrl || "").trim().replace(/\/+$/, "")
  if (!url) return ""
  if (/\/embeddings$/i.test(url)) return url
  if (/\/v\d+$/i.test(url)) return `${url}/embeddings`
  return `${url}/v1/embeddings`
}

async function probeEmbedding(provider: ProbeProvider, timeoutMs: number) {
  const response = await requestJson(resolveEmbeddingsUrl(String(provider.apiUrl || "")), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify({ model: provider.model, input: "ping" })
  }, timeoutMs)
  if (!response.ok) {
    return { ok: false, detail: `HTTP ${response.status}${upsertError(response.body) ? ` ${upsertError(response.body)}` : ""}` }
  }
  const data = record(response.body).data
  const embedding = record(Array.isArray(data) ? data[0] : null).embedding
  const dims = Array.isArray(embedding) ? embedding.length : NaN
  return { ok: true, detail: Number.isFinite(dims) ? `${provider.model} ${dims} 维` : `${provider.model} 正常` }
}

async function probeImage(provider: ProbeProvider, timeoutMs: number) {
  // 图片生成按次计费，不实际出图：只验证 URL 可达 + key 鉴权 + 模型是否在列表
  const modelsUrl = String(provider.apiUrl)
    .replace(/\/images\/generations?\/?$/i, "")
    .replace(/\/images\/edits\/?$/i, "")
    .replace(/\/+$/, "") + "/models"
  const response = await requestJson(modelsUrl, {
    method: "GET",
    headers: { Authorization: `Bearer ${provider.apiKey}` }
  }, timeoutMs)
  if (!response.ok) {
    return { ok: false, detail: `HTTP ${response.status}${upsertError(response.body) ? ` ${upsertError(response.body)}` : ""}（探测 /models）` }
  }
  const data = record(response.body).data
  const list: unknown[] = Array.isArray(data) ? data : Array.isArray(response.body) ? response.body : []
  const ids = list.map(item => String(record(item).id || "")).filter(Boolean)
  if (ids.length && provider.model && ids.includes(String(provider.model))) {
    return { ok: true, detail: `${provider.model} 连通且在模型列表中（未实际出图）` }
  }
  return { ok: true, detail: `连通与鉴权正常（列表 ${ids.length || "未知"} 个模型，未实际出图）` }
}

/**
 * 探测单个 provider。
 * @returns {Promise<{name:string, ok:boolean, ms:number, detail:string}>}
 */
async function probeProvider(provider: ProbeProvider = {}, kind = "chat", options: ProbeOptions = {}): Promise<ProbeResult> {
  const name = String(provider.name || "未命名").slice(0, 30)
  const result = { name, ok: false, ms: 0, detail: "" }
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_PROBE_TIMEOUT_MS
  if (!String(provider.apiUrl || "").trim()) {
    result.detail = "缺少 URL"
    return result
  }
  if (!String(provider.model || "").trim()) {
    result.detail = "缺少模型名"
    return result
  }
  if (!String(provider.apiKey || "").trim()) {
    result.detail = "缺少 API Key"
    return result
  }
  const startedAt = now()
  try {
    const outcome = kind === "embedding" ? await probeEmbedding(provider, timeoutMs)
      : kind === "image" ? await probeImage(provider, timeoutMs)
        : await probeChat(provider, timeoutMs)
    result.ms = now() - startedAt
    result.ok = outcome.ok
    result.detail = maskSecrets(outcome.detail || "")
  } catch (error) {
    result.ms = now() - startedAt
    if (record(error).name === "AbortError") {
      result.detail = `超时（${Math.round(timeoutMs / 1000)}s 无响应）`
    } else {
      result.detail = maskSecrets(`网络错误 ${record(record(error).cause).code || record(error).message || "unknown"}`)
    }
  }
  return result
}

/** 顺序探测一组 provider（上限 8 个），返回逐项结果 */
async function probeProviders(providers: ProbeProvider[] = [], kind = "chat", options: ProbeOptions = {}): Promise<ProbeResult[]> {
  const results = []
  for (const provider of providers.slice(0, MAX_PROBE_PROVIDERS)) {
    results.push(await probeProvider(provider, kind, options))
  }
  return results
}

/** 汇总为一行 toast 文案 */
function summarizeProbes(results: ProbeResult[] = []) {
  const parts = results.map(item => {
    const ms = item.ms ? `${item.ms}ms` : ""
    if (item.ok) return `✅${item.name} ${ms} ${item.detail}`.trim()
    return `❌${item.name} ${ms} ${item.detail}`.trim()
  })
  const allOk = results.length > 0 && results.every(item => item.ok)
  let text = parts.join("；")
  if (results.length >= MAX_PROBE_PROVIDERS) text += `；（仅测试前 ${MAX_PROBE_PROVIDERS} 个）`
  return { allOk, text: text.slice(0, 500) }
}

return { classifyConfigKind, maskSecrets, probeProvider, probeProviders, summarizeProbes }
}
