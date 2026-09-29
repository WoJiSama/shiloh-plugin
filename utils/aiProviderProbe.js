// AI 模型配置连通性探针：锅巴「测试连通性」按钮的后端实现。
// 对已保存的每个 provider 发一次最小请求，回报延迟或上游真实错误原因。
// 纯函数模块：不依赖插件运行时全局，便于测试与独立脚本复用。
import { resolveChatCompletionUrl } from "./chatCompletionUrl.js"

const DEFAULT_PROBE_TIMEOUT_MS = 15000
const MAX_PROBE_PROVIDERS = 8

const KIND_BY_CONFIG_KEY = {
  embeddingAiConfig: "embedding",
  imageEditAiConfig: "image",
  imageGenerationAiConfig: "image"
}

export function classifyConfigKind(configKey = "") {
  return KIND_BY_CONFIG_KEY[String(configKey)] || "chat"
}

/** 输出前抹掉密钥形态的字符串，避免 toast/日志泄漏 key */
export function maskSecrets(text = "") {
  return String(text)
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, "sk-***")
    .replace(/Bearer\s+[A-Za-z0-9._-]{6,}/gi, "Bearer ***")
}

async function requestJson(url, options = {}, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = Date.now()
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    const text = await response.text()
    let body = null
    try { body = JSON.parse(text) } catch { body = null }
    return { status: response.status, ok: response.ok, body, text, ms: Date.now() - startedAt }
  } finally {
    clearTimeout(timer)
  }
}

function upsertError(body) {
  const message = body?.error?.message || body?.message || body?.error || ""
  return typeof message === "string" ? message : JSON.stringify(message).slice(0, 160)
}

async function postChat(apiUrl, apiKey, model, payload, timeoutMs) {
  return await requestJson(apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload)
  }, timeoutMs)
}

async function probeChat(provider, timeoutMs) {
  const payload = { model: provider.model, messages: [{ role: "user", content: "ping" }], max_tokens: 5, stream: false }
  let response = await postChat(resolveChatCompletionUrl(provider.apiUrl), provider.apiKey, provider.model, payload, timeoutMs)
  // 部分新模型只认 max_completion_tokens：400 且提示该词时换参数重试一次
  if (response.status === 400 && /max_tokens/i.test(upsertError(response.body) || "")) {
    delete payload.max_tokens
    payload.max_completion_tokens = 5
    response = await postChat(resolveChatCompletionUrl(provider.apiUrl), provider.apiKey, provider.model, payload, timeoutMs)
  }
  if (!response.ok) {
    return { ok: false, detail: `HTTP ${response.status}${upsertError(response.body) ? ` ${upsertError(response.body)}` : ""}` }
  }
  const choice = response.body?.choices?.[0]?.message?.content
  const usage = response.body?.usage?.total_tokens
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

async function probeEmbedding(provider, timeoutMs) {
  const response = await requestJson(resolveEmbeddingsUrl(provider.apiUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.apiKey}` },
    body: JSON.stringify({ model: provider.model, input: "ping" })
  }, timeoutMs)
  if (!response.ok) {
    return { ok: false, detail: `HTTP ${response.status}${upsertError(response.body) ? ` ${upsertError(response.body)}` : ""}` }
  }
  const dims = response.body?.data?.[0]?.embedding?.length
  return { ok: true, detail: Number.isFinite(dims) ? `${provider.model} ${dims} 维` : `${provider.model} 正常` }
}

async function probeImage(provider, timeoutMs) {
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
  const list = Array.isArray(response.body?.data) ? response.body.data : Array.isArray(response.body) ? response.body : []
  const ids = list.map(item => String(item?.id || "")).filter(Boolean)
  if (ids.length && provider.model && ids.includes(provider.model)) {
    return { ok: true, detail: `${provider.model} 连通且在模型列表中（未实际出图）` }
  }
  return { ok: true, detail: `连通与鉴权正常（列表 ${ids.length || "未知"} 个模型，未实际出图）` }
}

/**
 * 探测单个 provider。
 * @returns {Promise<{name:string, ok:boolean, ms:number, detail:string}>}
 */
export async function probeProvider(provider = {}, kind = "chat", options = {}) {
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
  const startedAt = Date.now()
  try {
    const outcome = kind === "embedding" ? await probeEmbedding(provider, timeoutMs)
      : kind === "image" ? await probeImage(provider, timeoutMs)
        : await probeChat(provider, timeoutMs)
    result.ms = Date.now() - startedAt
    result.ok = outcome.ok
    result.detail = maskSecrets(outcome.detail || "")
  } catch (error) {
    result.ms = Date.now() - startedAt
    if (error?.name === "AbortError") {
      result.detail = `超时（${Math.round(timeoutMs / 1000)}s 无响应）`
    } else {
      result.detail = maskSecrets(`网络错误 ${error?.cause?.code || error?.message || "unknown"}`)
    }
  }
  return result
}

/** 顺序探测一组 provider（上限 8 个），返回逐项结果 */
export async function probeProviders(providers = [], kind = "chat", options = {}) {
  const results = []
  for (const provider of providers.slice(0, MAX_PROBE_PROVIDERS)) {
    results.push(await probeProvider(provider, kind, options))
  }
  return results
}

/** 汇总为一行 toast 文案 */
export function summarizeProbes(results = []) {
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
