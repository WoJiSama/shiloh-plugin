import { resolveChatCompletionUrl } from '../domain/chatCompletionUrl.js'
export type DiagnosisFetch = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>
export interface DiagnosisLogger { info?(message: string): void; warn?(message: string): void }
export interface BackendProbeInput { url?: unknown; apiKey?: unknown; model?: unknown; fetchImpl?: DiagnosisFetch | null; timeoutMs?: number }
export interface BackendProbeResult { ok: boolean; kind: 'unconfigured' | 'ok' | 'timeout' | 'connect_fail' | `http_${number}`; detail: string; ms: number }
export interface DiagnosisReport { at: number; backends: (BackendProbeResult & { label: string })[] }
export interface DiagnosisOptions { settings?: unknown; logger?: DiagnosisLogger | undefined; fetchImpl?: DiagnosisFetch | null }
export interface DiagnosisPorts { fetch: DiagnosisFetch; readSettings(): unknown; resolveFetch(proxyUrl: string): Promise<DiagnosisFetch>; logger?: DiagnosisLogger; now?: () => number }
function record(value: unknown): Record<string, unknown> { return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {} }
export function createChatFailureDiagnosis(ports: DiagnosisPorts) {
const now = ports.now ?? Date.now

const PROBE_TIMEOUT_MS = 4000
const DIAGNOSIS_MIN_INTERVAL_MS = 60_000
const REPORT_MAX_AGE_MS = 180_000

let lastReport: DiagnosisReport | null = null
let lastProbeAt = 0
let probing = false

const BACKEND_DEFS = [
  { key: "chatAiConfig", urlField: "chatApiUrl", keyField: "chatApiKey", modelField: "chatApiModel", label: "主对话" },
  { key: "searchAiConfig", urlField: "searchApiUrl", keyField: "searchApiKey", modelField: "searchApiModel", label: "联网搜索", proxyField: "searchApiProxy" },
  { key: "toolsAiConfig", urlField: "toolsAiUrl", keyField: "toolsAiApikey", modelField: "toolsAiModel", label: "工具模型" },
  { key: "memoryAiConfig", urlField: "memoryAiUrl", keyField: "memoryAiApikey", modelField: "memoryAiModel", label: "上下文记忆" }
]

/** 单后端探测:1 token 的最小 ping,区分 连不上/超时/HTTP错误/正常 */
async function probeChatBackend({ url, apiKey, model, fetchImpl, timeoutMs = PROBE_TIMEOUT_MS }: BackendProbeInput): Promise<BackendProbeResult> {
  const endpoint = resolveChatCompletionUrl(String(url || ""))
  if (!endpoint || !apiKey || String(apiKey).includes("sk-xxx")) {
    return { ok: false, kind: "unconfigured", detail: "未配置", ms: 0 }
  }
  const startedAt = now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const fetchFn = fetchImpl || ports.fetch
    const response = await fetchFn(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: model || "gpt", messages: [{ role: "user", content: "ok" }], max_tokens: 1 }),
      signal: controller.signal
    })
    const ms = now() - startedAt
    if (response.ok) return { ok: true, kind: "ok", detail: `${ms}ms`, ms }
    return { ok: false, kind: `http_${response.status}`, detail: `HTTP ${response.status}`, ms }
  } catch (error) {
    const ms = now() - startedAt
    const aborted = record(error).name === "AbortError" || /abort/i.test(String(record(error).message || ""))
    return aborted
      ? { ok: false, kind: "timeout", detail: `超时>${timeoutMs / 1000 | 0}s`, ms }
      : { ok: false, kind: "connect_fail", detail: "连不上(域名被墙或服务宕机)", ms }
  } finally {
    clearTimeout(timer)
  }
}

/** 并行探测全部后端,产出报告并写入缓存;内部限频,失败不影响调用方 */
async function runChatFailureDiagnosis({ settings = null, logger = ports.logger, fetchImpl = null }: DiagnosisOptions = {}): Promise<DiagnosisReport | null> {
  if (probing || now() - lastProbeAt < DIAGNOSIS_MIN_INTERVAL_MS) return lastReport
  probing = true
  lastProbeAt = now()
  try {
    const config = settings || ports.readSettings()
    const tasks = BACKEND_DEFS.map(async def => {
      const section = record(record(config)[def.key])
      const result = await probeChatBackend({
        url: section[def.urlField],
        apiKey: section[def.keyField],
        model: section[def.modelField],
        fetchImpl: fetchImpl || (def.proxyField && section[def.proxyField] ? await ports.resolveFetch(String(section[def.proxyField])) : null)
      })
      return { label: def.label, ...result }
    })
    const backends = await Promise.all(tasks)
    lastReport = { at: now(), backends }
    const summary = backends.map(b => `${b.label}${b.ok ? "✅" : "❌"}${b.ok ? b.detail : `(${b.detail})`}`).join(" ")
    logger?.info?.(`[失败诊断] ${summary}`)
    return lastReport
  } catch (error) {
    logger?.warn?.(`[失败诊断] 探测异常: ${String(record(error).message || error)}`)
    return lastReport
  } finally {
    probing = false
  }
}

/** 同步读取最近的诊断快照;过期返回空串(失败话术里就不附加) */
function getCachedDiagnosisLine({ maxAgeMs = REPORT_MAX_AGE_MS }: { maxAgeMs?: number } = {}) {
  if (!lastReport || now() - lastReport.at > maxAgeMs) return ""
  const line = lastReport.backends
    .map(b => `${b.label}${b.ok ? "✅" : "❌"}`)
    .join(" ")
  return `后端自检：${line}`
}

/** fire-and-forget:失败话术构建时触发一次探测(限频内部控制) */
function triggerChatFailureDiagnosis() {
  void runChatFailureDiagnosis().catch(() => {})
}

return { probeChatBackend, runChatFailureDiagnosis, getCachedDiagnosisLine, triggerChatFailureDiagnosis }
}
