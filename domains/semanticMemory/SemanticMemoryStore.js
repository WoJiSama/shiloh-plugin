// 语义记忆存储:按群持久化分块(NDJSON,embedding 以 base64 Float32 存储),
// 内存侧构建归一化向量矩阵(暴力余弦)与 BM25 倒排(CJK bigram)。
// 语料受归档保留期约束(万级分块),暴力检索 <20ms,无需外部向量库。
import fs from "node:fs"
import path from "node:path"

export function tokenizeForBM25(text = "") {
  const normalized = String(text || "").toLowerCase()
  const tokens = []
  const cjkRuns = normalized.match(/[\u4e00-\u9fa5]+/g) || []
  for (const run of cjkRuns) {
    for (let i = 0; i < run.length - 1; i++) tokens.push(run.slice(i, i + 2))
    if (run.length === 1) tokens.push(run)
  }
  const words = normalized.match(/[a-z0-9]{2,}/g) || []
  tokens.push(...words)
  return tokens
}

export class BM25Index {
  constructor({ k1 = 1.2, b = 0.75 } = {}) {
    this.k1 = k1
    this.b = b
    this.docs = new Map() // id -> { tf: Map, len }
    this.df = new Map()
    this.totalLen = 0
  }

  add(id, tokens) {
    if (this.docs.has(id)) this.remove(id)
    const tf = new Map()
    for (const token of tokens) tf.set(token, (tf.get(token) || 0) + 1)
    this.docs.set(id, { tf, len: tokens.length })
    this.totalLen += tokens.length
    for (const token of tf.keys()) this.df.set(token, (this.df.get(token) || 0) + 1)
  }

  remove(id) {
    const doc = this.docs.get(id)
    if (!doc) return
    this.docs.delete(id)
    this.totalLen -= doc.len
    for (const [token, count] of doc.tf) {
      const next = (this.df.get(token) || 0) - count
      if (next <= 0) this.df.delete(token)
      else this.df.set(token, next)
    }
  }

  search(queryTokens = [], topN = 30) {
    if (!queryTokens.length || !this.docs.size) return []
    const avgLen = this.totalLen / this.docs.size
    const scored = []
    for (const [id, doc] of this.docs) {
      let score = 0
      for (const token of queryTokens) {
        const tf = doc.tf.get(token)
        if (!tf) continue
        const df = this.df.get(token) || 0
        const idf = Math.log(1 + (this.docs.size - df + 0.5) / (df + 0.5))
        score += idf * (tf * (this.k1 + 1)) / (tf + this.k1 * (1 - this.b + this.b * (doc.len / avgLen)))
      }
      if (score > 0) scored.push({ id, score })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, topN)
  }
}

function encodeVector(vector) {
  return Buffer.from(new Float32Array(vector).buffer).toString("base64")
}

function decodeVector(base64, dimension) {
  const buffer = Buffer.from(String(base64 || ""), "base64")
  const expectedBytes = dimension * 4
  if (buffer.length < expectedBytes) return null
  const view = new Float32Array(buffer.buffer, buffer.byteOffset, dimension)
  let norm = 0
  for (let i = 0; i < dimension; i++) norm += view[i] * view[i]
  norm = Math.sqrt(norm)
  if (norm > 0) for (let i = 0; i < dimension; i++) view[i] /= norm
  return view
}

const GROUP_STATE_LRU_LIMIT = 32

const DEFAULT_EVOLUTION = {
  enabled: true,
  halfLifeDays: 7,
  reinforceBoost: 0.35,
  maxStrength: 1,
  freezeThreshold: 0.06,
  flushBatch: 32
}

export function normalizeEvolutionConfig(raw = {}) {
  const config = { ...DEFAULT_EVOLUTION, ...(raw && typeof raw === "object" ? raw : {}) }
  config.enabled = config.enabled !== false
  config.halfLifeDays = Math.max(0.5, Number(config.halfLifeDays) || 7)
  config.reinforceBoost = Math.min(1, Math.max(0.05, Number(config.reinforceBoost) || 0.35))
  config.maxStrength = Math.min(1, Math.max(0.5, Number(config.maxStrength) || 1))
  config.freezeThreshold = Math.min(0.5, Math.max(0, Number(config.freezeThreshold) ?? 0.06))
  config.flushBatch = Math.max(4, Number(config.flushBatch) || 32)
  return config
}

// 记忆强度演化(借鉴 A-Memorix 半衰期模型):强度随时间衰减,被召回注入即强化并重置衰减时钟。
// 基准时间取 lastRecallAt(最近一次被想起)与 end_ts(内容发生时间)的较大者——
// 新写入的记忆从写入时刻起算,被想起过的从最近想起时刻起算。
export function effectiveStrength(record = {}, now = Date.now(), halfLifeDays = 7) {
  const base = Number(record?.strength)
  const strength = Number.isFinite(base) && base > 0 ? Math.min(1, base) : 1
  const anchor = Math.max(Number(record?.lastRecallAt) || 0, Number(record?.end_ts) || 0)
  const elapsedDays = Math.max(0, (Number(now) - anchor) / (24 * 3600 * 1000))
  return strength * Math.pow(0.5, elapsedDays / Math.max(0.5, halfLifeDays))
}

export class SemanticMemoryStore {
  constructor({ baseDir, dimension = 1024, retentionDays = 7, evolution = {}, logger = globalThis.logger } = {}) {
    this.baseDir = baseDir
    this.dimension = Number(dimension) || 1024
    this.retentionDays = Math.max(1, Number(retentionDays) || 7)
    this.evolution = normalizeEvolutionConfig(evolution)
    this.logger = logger
    this.groups = new Map() // groupId -> { file, chunks: Map(id->meta), matrix: Float32Array|null, norms, bm25 }
  }

  // embedding 实际维度与配置不符时自适应(清空内存态,按新维度重载/写入)
  setDimension(dimension) {
    const next = Number(dimension) || 0
    if (next < 2 || next === this.dimension) return
    this.dimension = next
    this.groups.clear()
  }

  groupDir() {
    return path.join(this.baseDir, "group")
  }

  groupFile(groupId) {
    return path.join(this.groupDir(), `${groupId}.ndjson`)
  }

  loadGroup(groupId) {
    const id = String(groupId || "")
    if (!id) return this.emptyState("")
    const cached = this.groups.get(id)
    if (cached) return cached

    const file = this.groupFile(id)
    const cutoff = Date.now() - this.retentionDays * 24 * 3600 * 1000
    const seen = new Map()
    let malformed = 0
    const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const record = JSON.parse(line)
        if (!record?.id || !record?.emb) continue
        seen.set(record.id, record) // 追加式存储,同 id 后写覆盖先写
      } catch {
        malformed++
      }
    }

    const state = this.emptyState(id)
    state.file = file
    let dropped = 0
    let compactable = 0
    const keptRecords = []
    for (const record of seen.values()) {
      if (Number(record.end_ts || 0) < cutoff) {
        dropped++
        compactable++
        continue
      }
      keptRecords.push(record)
    }
    if (malformed) compactable += malformed

    if (keptRecords.length) {
      state.matrix = new Float32Array(keptRecords.length * this.dimension)
      let valid = 0
      for (const record of keptRecords) {
        const vector = decodeVector(record.emb, this.dimension)
        if (!vector) {
          dropped++
          continue
        }
        state.matrix.set(vector, valid * this.dimension)
        const meta = { ...record }
        delete meta.emb
        meta.index = valid
        state.chunks.set(meta.id, meta)
        state.byIndex.set(valid, meta)
        valid++
      }
      state.matrix = state.matrix.subarray(0, valid * this.dimension)
      for (const meta of state.chunks.values()) {
        state.bm25.add(meta.id, tokenizeForBM25(meta.text))
      }
    }
    state.loaded = true
    state.droppedOnLoad = dropped
    state.records = keptRecords

    // 载入时顺带压实:过期/重复行占比高则重写文件
    if (file && fs.existsSync(file) && dropped > 0 && dropped >= keptRecords.length * 0.2) {
      this.compactFile(file, keptRecords).catch(error =>
        this.logger?.warn?.(`[SemanticMemory] 压实 ${id} 失败: ${error.message}`))
    }

    this.groups.set(id, state)
    this.evictLRU()
    return state
  }

  emptyState(groupId) {
    return {
      groupId,
      file: null,
      chunks: new Map(),
      byIndex: new Map(),
      matrix: null,
      bm25: new BM25Index(),
      loaded: false,
      droppedOnLoad: 0,
      records: [],
      dirty: new Set() // 已强化未落盘的分块 id
    }
  }

  // LRU 淘汰前先把强化落盘,防止"被想起过"的状态随缓存消失
  evictLRU() {
    while (this.groups.size > GROUP_STATE_LRU_LIMIT) {
      const oldestKey = this.groups.keys().next().value
      const oldest = this.groups.get(oldestKey)
      if (oldest?.dirty?.size) {
        this.flushDirty(oldest).catch(error =>
          this.logger?.warn?.(`[SemanticMemory] 淘汰落盘 ${oldestKey} 失败: ${error.message}`))
      }
      this.groups.delete(oldestKey)
    }
  }

  // 召回强化:被注入上下文的分块提升强度并重置衰减时钟。
  // 内存即时生效;达到 flushBatch 批量追加落盘(同 id 后写覆盖)。
  reinforceChunks(groupId, ids = [], { boost, now = Date.now() } = {}) {
    if (!this.evolution.enabled || !ids.length) return 0
    const state = this.touchGroup(groupId)
    const gain = Math.min(1, Math.max(0.05, Number(boost ?? this.evolution.reinforceBoost)))
    let updated = 0
    for (const id of ids) {
      const meta = state.chunks.get(String(id))
      const record = state.records.find(item => item.id === String(id))
      if (!meta || !record) continue
      const next = Math.min(this.evolution.maxStrength, (Number(meta.strength) || 1) + gain)
      meta.strength = next
      meta.recallCount = (Number(meta.recallCount) || 0) + 1
      meta.lastRecallAt = now
      record.strength = next
      record.recallCount = meta.recallCount
      record.lastRecallAt = now
      state.dirty.add(String(id))
      updated++
    }
    if (state.dirty.size >= this.evolution.flushBatch) {
      this.flushDirty(state).catch(error =>
        this.logger?.warn?.(`[SemanticMemory] 强化落盘 ${groupId} 失败: ${error.message}`))
    }
    return updated
  }

  // 把强化过的分块以整行记录追加回去(追加式存储,同 id 后写覆盖)
  async flushDirty(state) {
    if (!state?.dirty?.size || !state.file) return 0
    const dirtyIds = [...state.dirty]
    const lines = []
    for (const id of dirtyIds) {
      const record = state.records.find(item => item.id === id)
      if (record) lines.push(JSON.stringify(record))
    }
    if (lines.length) {
      await fs.promises.appendFile(state.file, lines.join("\n") + "\n", "utf8")
    }
    state.dirty.clear()
    return lines.length
  }

  // 按群号落盘未写的强化(网页"想起"按钮等手动场景用)
  async flushGroupDirty(groupId) {
    const state = this.loadGroup(String(groupId || ""))
    return this.flushDirty(state)
  }

  // 记忆自纠错的降权:与强化对称,但不重置衰减锚点——被纠错的记忆基准下调,
  // 继续沿原时钟衰减,重复纠错会跌破冻结线由清扫淡忘;单次误伤只降权不丢数据。
  penalizeChunks(groupId, ids = [], { penalty = 0.5 } = {}) {
    const key = String(groupId || "")
    if (!key || !ids.length) return 0
    const state = this.touchGroup(key)
    const cut = Math.min(0.95, Math.max(0.05, Number(penalty) || 0.5))
    let updated = 0
    for (const id of ids) {
      const meta = state.chunks.get(String(id))
      const record = state.records.find(item => item.id === String(id))
      if (!meta || !record) continue
      const next = Math.max(0.02, (Number(meta.strength) || 1) - cut)
      meta.strength = next
      record.strength = next
      state.dirty.add(String(id))
      updated++
    }
    if (state.dirty.size >= this.evolution.flushBatch) {
      this.flushDirty(state).catch(error =>
        this.logger?.warn?.(`[SemanticMemory] 纠错落盘 ${key} 失败: ${error.message}`))
    }
    return updated
  }

  // 单条遗忘:重写该群文件(剔除目标 id)后重载内存态
  async forgetChunk(groupId, id) {
    const key = String(groupId || "")
    const targetId = String(id || "")
    const state = this.loadGroup(key)
    if (!state.chunks.has(targetId)) return false
    const kept = (state.records || []).filter(record => record.id !== targetId)
    if (state.file) {
      await fs.promises.mkdir(this.groupDir(), { recursive: true })
      await this.compactFile(state.file, kept)
    }
    this.groups.delete(key)
    this.loadGroup(key)
    return true
  }

  // 每日清扫:逐群装载(丢弃过期)并强制压实任何含过期/无效行的文件;
  // 记忆演化启用时,强度衰减到冻结阈值以下的分块一并遗忘(半衰期模型代替硬保留期)。
  async sweepAll() {
    const groupIds = []
    try {
      for (const entry of fs.readdirSync(this.groupDir(), { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".ndjson")) groupIds.push(entry.name.replace(/\.ndjson$/, ""))
      }
    } catch {
      return { groups: 0, compactedGroups: 0, droppedChunks: 0, frozenChunks: 0 }
    }
    const now = Date.now()
    const evolutionOn = this.evolution.enabled && this.evolution.freezeThreshold > 0
    let compactedGroups = 0
    let droppedChunks = 0
    let frozenChunks = 0
    for (const groupId of groupIds) {
      const state = this.loadGroup(groupId)
      if (!state.file || !fs.existsSync(state.file)) continue
      droppedChunks += state.droppedOnLoad || 0
      let records = state.records || []
      if (evolutionOn) {
        const survivors = records.filter(record =>
          effectiveStrength(record, now, this.evolution.halfLifeDays) >= this.evolution.freezeThreshold)
        frozenChunks += records.length - survivors.length
        records = survivors
      }
      // 强化未落盘的行不能被旧记录覆盖:先落盘再按合并结果压实
      await this.flushDirty(state).catch(error =>
        this.logger?.warn?.(`[SemanticMemory] 清扫落盘 ${groupId} 失败: ${error.message}`))
      if (records.length !== (state.records || []).length || (state.droppedOnLoad || 0) > 0) {
        await this.compactFile(state.file, records).catch(error =>
          this.logger?.warn?.(`[SemanticMemory] 清扫压实 ${groupId} 失败: ${error.message}`))
        compactedGroups++
        this.groups.delete(String(groupId))
        this.loadGroup(String(groupId))
      }
    }
    return { groups: groupIds.length, compactedGroups, droppedChunks, frozenChunks }
  }

  async compactFile(file, records) {
    const tmp = `${file}.compact-tmp`
    const body = records.map(record => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "")
    await fs.promises.writeFile(tmp, body, "utf8")
    await fs.promises.rename(tmp, file)
  }

  touchGroup(groupId) {
    const state = this.loadGroup(groupId)
    this.groups.delete(String(groupId))
    this.groups.set(String(groupId), state)
    return state
  }

  // 追加分块(带向量);同 id 后写覆盖。返回写入条数。
  async appendChunks(groupId, chunks = []) {
    const usable = chunks.filter(chunk => chunk?.id &&
      (Array.isArray(chunk?.vector) || chunk?.vector instanceof Float32Array) &&
      chunk.vector.length === this.dimension)
    if (!usable.length) return 0
    const file = this.groupFile(groupId)
    await fs.promises.mkdir(this.groupDir(), { recursive: true })
    const lines = usable.map(chunk => {
      const record = { ...chunk }
      record.emb = encodeVector(chunk.vector)
      delete record.vector
      return JSON.stringify(record)
    })
    await fs.promises.appendFile(file, lines.join("\n") + "\n", "utf8")

    // 内存增量:重载该群(文件已在页缓存,毫秒级);重载前先保住未落盘的强化
    const prior = this.groups.get(String(groupId))
    if (prior?.dirty?.size) {
      await this.flushDirty(prior).catch(error =>
        this.logger?.warn?.(`[SemanticMemory] 写入前落盘 ${groupId} 失败: ${error.message}`))
    }
    this.groups.delete(String(groupId))
    this.loadGroup(groupId)
    return usable.length
  }

  searchVector(groupId, queryVector, topN = 30) {
    const state = this.touchGroup(groupId)
    if (!state.matrix || !state.chunks.size) return []
    const query = decodeVector(encodeVector(queryVector), this.dimension)
    if (!query) return []
    const count = state.matrix.length / this.dimension
    const scored = []
    for (let i = 0; i < count; i++) {
      let dot = 0
      const base = i * this.dimension
      for (let d = 0; d < this.dimension; d++) dot += state.matrix[base + d] * query[d]
      if (dot > 0) scored.push({ index: i, score: dot })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, topN)
      .map(item => ({ chunk: state.byIndex.get(item.index), score: item.score }))
      .filter(item => item.chunk)
  }

  searchBM25(groupId, queryText, topN = 30) {
    const state = this.touchGroup(groupId)
    return state.bm25.search(tokenizeForBM25(queryText), topN).map(item => ({
      chunk: state.chunks.get(item.id),
      score: item.score
    })).filter(item => item.chunk)
  }

  stats() {
    const groupIds = []
    let chunkCount = 0
    try {
      for (const entry of fs.readdirSync(this.groupDir(), { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".ndjson")) groupIds.push(entry.name.replace(/\.ndjson$/, ""))
      }
    } catch {}
    for (const groupId of groupIds) chunkCount += this.loadGroup(groupId).chunks.size
    const loaded = [...this.groups.values()].map(state => ({
      groupId: state.groupId,
      chunks: state.chunks.size,
      droppedOnLoad: state.droppedOnLoad || 0
    }))
    return { dimension: this.dimension, retentionDays: this.retentionDays, groups: groupIds.length, chunks: chunkCount, loaded }
  }
}
