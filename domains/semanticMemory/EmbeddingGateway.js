// Embedding 网关:复用 embeddingAiConfig(OpenAI 兼容 /embeddings 端点)。
// 批量(默认 16/批)、文本哈希缓存、失败 60s 熔断,模式沿用 GlobalStyleLearnerManager。
import { createHash } from "node:crypto"

const CACHE_LIMIT = 8000
const FAILURE_COOLDOWN_MS = 60000

export class EmbeddingGateway {
  constructor({ apiUrl = "", apiKey = "", model = "", batchSize = 16, timeoutMs = 12000, fetchFn = fetch, logger = globalThis.logger } = {}) {
    this.apiUrl = String(apiUrl || "")
    this.apiKey = String(apiKey || "")
    this.model = String(model || "")
    this.batchSize = Math.max(1, Number(batchSize) || 16)
    this.timeoutMs = Math.max(2000, Number(timeoutMs) || 12000)
    this.fetchFn = fetchFn
    this.logger = logger
    this.cache = new Map() // sha1(text) -> Float32Array | null(负缓存)
    this.failureUntil = 0
    this.stats = { requests: 0, batchRequests: 0, cacheHits: 0, failures: 0, texts: 0 }
  }

  get providerKey() {
    return `${this.apiUrl}|${this.model}`
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
    this.logger?.warn?.(`[SemanticMemory] embedding 熔断 ${FAILURE_COOLDOWN_MS / 1000}s (${this.providerKey})`)
  }

  hash(text) {
    return createHash("sha1").update(String(text || "")).digest("hex")
  }

  cacheGet(hash) {
    if (!this.cache.has(hash)) return { hit: false }
    const value = this.cache.get(hash)
    this.cache.delete(hash)
    this.cache.set(hash, value) // LRU touch
    this.stats.cacheHits++
    return { hit: true, vector: value }
  }

  cachePut(hash, vector) {
    this.cache.set(hash, vector)
    while (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value)
  }

  async requestBatch(texts) {
    const timeoutSignal = typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(this.timeoutMs)
      : undefined
    const response = await this.fetchFn(this.apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({ model: this.model, input: texts }),
      signal: timeoutSignal
    })
    if (!response?.ok) {
      const body = await response.text().catch(() => "")
      throw new Error(`embedding API ${response.status} ${String(body).slice(0, 160)}`)
    }
    const payload = await response.json()
    const rows = Array.isArray(payload?.data) ? payload.data : []
    const byIndex = new Map(rows.map((row, index) => [row?.index ?? index, row]))
    return texts.map((_, index) => {
      const row = byIndex.get(index)
      const vector = row?.embedding
      if (!Array.isArray(vector) || !vector.length || !vector.every(value => Number.isFinite(Number(value)))) return null
      return Float32Array.from(vector)
    })
  }

  // 批量向量化:缓存命中直接返回;未命中按 batchSize 分批请求(串行,控制上游压力)。
  async embedBatch(texts = []) {
    const list = texts.map(text => String(text || "").trim())
    const results = new Array(list.length).fill(null)
    if (!list.length) return results
    const pending = []
    for (let i = 0; i < list.length; i++) {
      if (!list[i]) continue
      const entry = this.cacheGet(this.hash(list[i]))
      if (entry.hit) results[i] = entry.vector
      else pending.push(i)
    }
    if (!pending.length) return results
    if (!this.configured()) return results

    for (let start = 0; start < pending.length; start += this.batchSize) {
      const slice = pending.slice(start, start + this.batchSize)
      const sliceTexts = slice.map(i => list[i])
      try {
        this.stats.requests++
        this.stats.batchRequests++
        this.stats.texts += sliceTexts.length
        const vectors = await this.requestBatch(sliceTexts)
        slice.forEach((targetIndex, offset) => {
          const vector = vectors[offset] || null
          results[targetIndex] = vector
          this.cachePut(this.hash(list[targetIndex]), vector)
        })
      } catch (error) {
        this.markFailure()
        this.logger?.warn?.(`[SemanticMemory] embedding 批量失败: ${error.message}`)
        break
      }
    }
    return results
  }

  async embed(text) {
    return (await this.embedBatch([text]))[0] || null
  }
}
