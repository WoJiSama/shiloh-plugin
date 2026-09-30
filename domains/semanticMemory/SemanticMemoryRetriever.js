// 语义记忆检索:向量(归一化余弦)+ BM25 混合召回 → RRF 融合(k=60)
// → 相邻窗口重叠去重 → 余弦阈值门控。可选 LLM 重排(评估/调试用,不进热路径)。
const RRF_K = 60
const CANDIDATE_POOL = 30

export function rrfFuse(vectorHits = [], bm25Hits = [], { pool = CANDIDATE_POOL } = {}) {
  const scores = new Map()
  const add = (chunk, source, rank, vectorScore = 0) => {
    const entry = scores.get(chunk.id) || { chunk, rrf: 0, vector: 0, bm25Rank: 0, vectorRank: 0 }
    entry.rrf += 1 / (RRF_K + rank + 1)
    if (source === "vector") {
      entry.vector = Math.max(entry.vector, vectorScore)
      entry.vectorRank = rank + 1
    } else {
      entry.bm25Rank = rank + 1
    }
    scores.set(chunk.id, entry)
  }
  vectorHits.slice(0, pool).forEach((hit, rank) => add(hit.chunk, "vector", rank, hit.score))
  bm25Hits.slice(0, pool).forEach((hit, rank) => add(hit.chunk, "bm25", rank))
  return [...scores.values()].sort((a, b) => b.rrf - a.rrf)
}

function messageIdOverlap(a = [], b = []) {
  if (!a.length || !b.length) return 0
  const set = new Set(a.map(String))
  const shared = b.filter(id => set.has(String(id)))
  return shared.length / Math.min(a.length, b.length)
}

export class SemanticMemoryRetriever {
  constructor({ store, gateway, config = {}, logger = globalThis.logger } = {}) {
    this.store = store
    this.gateway = gateway
    this.config = config
    this.logger = logger
    this.stats = { queries: 0, hits: 0, timeouts: 0, failures: 0 }
  }

  async search(groupId, query, { topK, minScore, timeoutMs, candidatePool } = {}) {
    const startedAt = Date.now()
    const budget = Math.max(200, Number(timeoutMs || this.config.retrieveTimeoutMs) || 900)
    const k = Math.max(1, Number(topK || this.config.topK) || 5)
    const threshold = Number(minScore ?? this.config.minScore ?? 0.35)
    const text = String(query || "").trim()
    if (!text) return { items: [], elapsedMs: 0, reason: "empty query" }
    try {
      const queryVector = await Promise.race([
        this.gateway.embed(text),
        new Promise(resolve => setTimeout(() => resolve(null), budget).unref?.())
      ])
      if (Date.now() - startedAt > budget) {
        this.stats.timeouts++
        return { items: [], elapsedMs: Date.now() - startedAt, reason: "timeout" }
      }
      const vectorStart = Date.now()
      const vectorHits = queryVector ? this.store.searchVector(groupId, queryVector, candidatePool || CANDIDATE_POOL) : []
      const vectorMs = Date.now() - vectorStart
      const bm25Start = Date.now()
      const bm25Hits = this.store.searchBM25(groupId, text, candidatePool || CANDIDATE_POOL)
      const bm25Ms = Date.now() - bm25Start

      const fused = rrfFuse(vectorHits, bm25Hits)
      // 阈值门控:向量分数是唯一可比的绝对量;纯 BM25 命中需排前 3 才保留(关键词强信号)
      const gated = fused.filter(entry => entry.vector >= threshold || (entry.bm25Rank >= 1 && entry.bm25Rank <= 3))
      // 相邻窗口去重:与已保留分块消息重叠 >50% 的丢弃
      const kept = []
      for (const entry of gated) {
        const overlaps = kept.some(item => messageIdOverlap(item.chunk.message_ids, entry.chunk.message_ids) > 0.5)
        if (!overlaps) kept.push(entry)
        if (kept.length >= k) break
      }
      this.stats.queries++
      if (kept.length) this.stats.hits++
      return {
        items: kept.map(entry => ({
          chunk: entry.chunk,
          rrfScore: entry.rrf,
          vectorScore: entry.vector,
          vectorRank: entry.vectorRank,
          bm25Rank: entry.bm25Rank
        })),
        elapsedMs: Date.now() - startedAt,
        vectorMs,
        bm25Ms,
        candidates: fused.length
      }
    } catch (error) {
      this.stats.failures++
      this.logger?.warn?.(`[SemanticMemory] 检索失败 group=${groupId}: ${error.message}`)
      return { items: [], elapsedMs: Date.now() - startedAt, reason: error.message }
    }
  }

  formatClock(ts) {
    const date = new Date(Number(ts) || 0)
    if (Number.isNaN(date.getTime())) return "??:??"
    const pad = n => String(n).padStart(2, "0")
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
  }

  // 注入主模型上下文的文本块
  renderContext(result, { maxChars } = {}) {
    if (!result?.items?.length) return ""
    const limit = Math.max(200, Number(maxChars || this.config.contextMaxChars) || 900)
    const lines = []
    for (const item of result.items) {
      const head = `[${this.formatClock(item.chunk.start_ts)}~${this.formatClock(item.chunk.end_ts)}]`
      lines.push(`${head} ${item.chunk.text}`)
    }
    const joined = lines.join("\n")
    return joined.length > limit ? joined.slice(0, limit) : joined
  }
}
