interface GatewayOptions { apiUrl?: string; apiKey?: string; model?: string; batchSize?: number; timeoutMs?: number; fetchFn?: typeof fetch; logger?: { warn?(message:string):void } }
function record(value:unknown):Record<string,unknown> { return value&&typeof value==='object'?value as Record<string,unknown>:{} }
// 重排网关:SiliconFlow /v1/rerank(免费 bge-reranker-v2-m3),复用 embedding 配置的 key。
// 端点由 embeddingApiUrl 把 /embeddings 换成 /rerank 推导,无需单独配置。
const FAILURE_COOLDOWN_MS = 60000

export function rerankUrlFromEmbeddingUrl(embeddingUrl = "") {
  return String(embeddingUrl || "").replace(/\/embeddings\/?$/, "/rerank")
}

export class RerankGateway {
 apiUrl:string;apiKey:string;model:string;timeoutMs:number;fetchFn:typeof fetch;logger:GatewayOptions["logger"];failureUntil:number
 stats:{requests:number;failures:number;timeouts:number}

  constructor({ apiUrl = "", apiKey = "", model = "BAAI/bge-reranker-v2-m3", timeoutMs = 1500, fetchFn = fetch, logger }:GatewayOptions = {}) {
    this.apiUrl = String(apiUrl || "")
    this.apiKey = String(apiKey || "")
    this.model = String(model || "BAAI/bge-reranker-v2-m3")
    this.timeoutMs = Math.max(300, Number(timeoutMs) || 1500)
    this.fetchFn = fetchFn
    this.logger = logger
    this.failureUntil = 0
    this.stats = { requests: 0, failures: 0, timeouts: 0 }
  }

  configured() {
    return Boolean(
      this.apiUrl &&
      this.apiKey &&
      !this.apiKey.includes("sk-xxx") &&
      this.model &&
      typeof this.fetchFn === "function" &&
      Date.now() >= this.failureUntil
    )
  }

  markFailure() {
    this.stats.failures++
    this.failureUntil = Date.now() + FAILURE_COOLDOWN_MS
    this.logger?.warn?.(`[SemanticMemory] rerank 熔断 ${FAILURE_COOLDOWN_MS / 1000}s (${this.model})`)
  }

  // 返回 Map(chunkId -> relevanceScore);失败/超时返回 null,调用方回落 RRF 顺序
  async rerank(query = "", chunks: {id?:string|number;text?:string}[] = []) {
    if (!this.configured() || !String(query || "").trim() || !chunks.length) return null
    const timeoutSignal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(this.timeoutMs)
      : undefined
    try {
      this.stats.requests++
      const response = await this.fetchFn(this.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`
        },
        body: JSON.stringify({
          model: this.model,
          query: String(query).slice(0, 2000),
          documents: chunks.map(chunk => String(chunk.text || "").slice(0, 4000)),
          top_n: chunks.length
        }),
        ...(timeoutSignal ? { signal: timeoutSignal } : {})
      })
      if (!response?.ok) {
        const body = await response.text().catch(() => "")
        throw new Error(`rerank API ${response.status} ${String(body).slice(0, 120)}`)
      }
      const payload: unknown = await response.json()
      const rows: unknown[] = Array.isArray(record(payload).results) ? record(payload).results as unknown[] : []
      const scores = new Map<string,number>()
      for (const row of rows) {
        const chunk = chunks[Number(record(row).index)]
        if (chunk?.id !== undefined && Number.isFinite(Number(record(row).relevance_score))) {
          scores.set(String(chunk.id), Number(record(row).relevance_score))
        }
      }
      return scores.size ? scores : null
    } catch (error) {
      if (record(error).name === "TimeoutError" || record(error).name === "AbortError") this.stats.timeouts++
      this.markFailure()
      this.logger?.warn?.(`[SemanticMemory] rerank 失败(回落 RRF 顺序): ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }
}
