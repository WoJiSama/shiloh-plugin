// 令牌账本：NDJSON 按天落盘 + 内存当日索引 + 汇总/走势/按群查询。
// 借鉴 qq-bridge token-ledger 的"丢明细不丢总量"思想；自持客户端无快照重放，记录天然幂等（一行一次调用）。
import fs from 'node:fs'
import path from 'node:path'
import { costOfUsage, DEFAULT_PRICE_TABLE, mergePriceOverrides, normalizeUsage, type NormalizedUsage, type PriceTable } from '../domain/modelPrices.js'

export interface TokenLedgerEntry {
  t: number
  /** 归组：群号 / 'global'（未归组的全局调用，如闸门/意图/未带上下文的 API 直调） */
  scope: string
  stage: string
  model: string
  u: { input: number; output: number; cached: number; reasoning: number; total: number }
  ms?: number
  cny: number
  estimated: boolean
  peak: boolean
}

export interface TokenLedgerPorts {
  dataDir: string
  logger?: { warn?(message: string): void }
  now?(): number
  retentionDays?: number
  priceOverrides?: unknown
}

export interface TokenSummary {
  today: { tokens: number; cost: number; calls: number; byStage: Record<string, { tokens: number; cost: number; calls: number }>; byModel: Record<string, { tokens: number; cost: number; calls: number; estimated: boolean }>; byScopeTop: { scope: string; tokens: number; cost: number }[] }
  priceTable: { currency: string; models: string[]; fallback: { input: number; output: number }; peakEnabled: boolean }
}

export interface TokenSeriesBucket { start: number; tokens: number; cost: number; calls: number }

export function createTokenLedger(ports: TokenLedgerPorts) {
  const now = ports.now ?? Date.now
  const dir = path.join(ports.dataDir, 'token_usage')
  const table: PriceTable = mergePriceOverrides(DEFAULT_PRICE_TABLE, ports.priceOverrides)
  const retentionDays = Math.max(3, Math.floor(ports.retentionDays ?? 90))
  let writeChain: Promise<void> = Promise.resolve()
  let todayRows: TokenLedgerEntry[] = []
  let todayKey = ''
  const fileCache = new Map<string, { at: number; rows: TokenLedgerEntry[] }>()

  const dayKey = (at: number) => new Date(at + 8 * 3600_000).toISOString().slice(0, 10)
  const filePath = (key: string) => path.join(dir, `${key}.ndjson`)

  function ensureDir() {
    try { fs.mkdirSync(dir, { recursive: true }) } catch { /* 已存在或不可写：记录时再报 */ }
  }

  function rollDay(at: number) {
    const key = dayKey(at)
    if (key === todayKey) return
    todayKey = key
    todayRows = []
    try {
      const raw = fs.existsSync(filePath(key)) ? fs.readFileSync(filePath(key), 'utf8') : ''
      todayRows = raw.split('\n').filter(Boolean).map(line => parseLine(line)).filter((x): x is TokenLedgerEntry => x !== null)
    } catch { /* 读不了当日文件就从头记 */ }
  }

  function parseLine(line: string): TokenLedgerEntry | null {
    try {
      const parsed = JSON.parse(line) as TokenLedgerEntry
      if (!parsed || typeof parsed !== 'object' || typeof parsed.scope !== 'string' || !parsed.u) return null
      return parsed
    } catch { return null /* 半行/坏行丢弃（进程中断的尾巴） */ }
  }

  function record(input: { scope: string; stage: string; model?: string; usage: unknown; ms?: number; at?: number }): void {
    const at = input.at ?? now()
    rollDay(at)
    const usage: NormalizedUsage = normalizeUsage(input.usage)
    if (usage.total <= 0) return
    const model = String(input.model || 'unknown')
    const cost = costOfUsage(model, usage, at, table)
    const entry: TokenLedgerEntry = {
      t: at, scope: String(input.scope || 'global'), stage: String(input.stage || 'api'), model,
      u: usage, ...(typeof input.ms === 'number' && input.ms >= 0 ? { ms: Math.floor(input.ms) } : {}),
      cny: cost.cny, estimated: cost.estimated, peak: cost.peak,
    }
    todayRows.push(entry)
    // 串行化追加，避免并发 append 错乱
    writeChain = writeChain.then(() => {
      ensureDir()
      try {
        fs.appendFileSync(filePath(dayKey(at)), JSON.stringify(entry) + '\n')
      } catch (error) {
        try { ports.logger?.warn?.(`[令牌账本] 写入失败：${error instanceof Error ? error.message : String(error)}`) } catch { /* 日志不可用 */ }
      }
    })
  }

  function loadDay(key: string): TokenLedgerEntry[] {
    if (key === todayKey) return todayRows
    const cached = fileCache.get(key)
    const file = filePath(key)
    try {
      const stat = fs.statSync(file)
      if (cached && cached.at === stat.mtimeMs) return cached.rows
      const raw = fs.readFileSync(file, 'utf8')
      const rows = raw.split('\n').filter(Boolean).map(parseLine).filter((x): x is TokenLedgerEntry => x !== null)
      fileCache.set(key, { at: stat.mtimeMs, rows })
      return rows
    } catch {
      return key === todayKey ? todayRows : []
    }
  }

  function lastDayKeys(count: number): string[] {
    const keys: string[] = []
    const base = now()
    for (let i = 0; i < count; i += 1) keys.push(dayKey(base - i * 86_400_000))
    return keys
  }

  function summary(): TokenSummary {
    rollDay(now())
    const rows = todayRows
    const byStage: TokenSummary['today']['byStage'] = {}
    const byModel: TokenSummary['today']['byModel'] = {}
    const byScope: Record<string, { tokens: number; cost: number }> = {}
    let tokens = 0
    let cost = 0
    for (const row of rows) {
      tokens += row.u.total
      cost += row.cny
      const stage = byStage[row.stage] || (byStage[row.stage] = { tokens: 0, cost: 0, calls: 0 })
      stage.tokens += row.u.total; stage.cost += row.cny; stage.calls += 1
      const model = byModel[row.model] || (byModel[row.model] = { tokens: 0, cost: 0, calls: 0, estimated: row.estimated })
      model.tokens += row.u.total; model.cost += row.cny; model.calls += 1
      const scope = byScope[row.scope] || (byScope[row.scope] = { tokens: 0, cost: 0 })
      scope.tokens += row.u.total; scope.cost += row.cny
    }
    const round = (value: number) => Math.round(value * 10000) / 10000
    for (const key of Object.keys(byStage)) { byStage[key]!.cost = round(byStage[key]!.cost) }
    for (const key of Object.keys(byModel)) { byModel[key]!.cost = round(byModel[key]!.cost) }
    return {
      today: {
        tokens, cost: round(cost), calls: rows.length, byStage, byModel,
        byScopeTop: Object.entries(byScope)
          .map(([scope, value]) => ({ scope, tokens: value.tokens, cost: round(value.cost) }))
          .sort((a, b) => b.cost - a.cost)
          .slice(0, 12),
      },
      priceTable: { currency: table.currency, models: Object.keys(table.models), fallback: table.fallback, peakEnabled: table.peak.enabled },
    }
  }

  function series(hours = 24, buckets = 24): TokenSeriesBucket[] {
    const at = now()
    const spanMs = Math.min(24 * 30, Math.max(1, Math.floor(hours))) * 3600_000
    const count = Math.min(120, Math.max(6, Math.floor(buckets)))
    const widthMs = spanMs / count
    const start = at - spanMs
    const out: TokenSeriesBucket[] = Array.from({ length: count }, (_, i) => ({ start: start + i * widthMs, tokens: 0, cost: 0, calls: 0 }))
    for (const key of lastDayKeys(Math.ceil(spanMs / 86_400_000) + 1)) {
      for (const row of loadDay(key)) {
        if (row.t < start) continue
        const index = Math.min(count - 1, Math.floor((row.t - start) / widthMs))
        const bucket = out[index]
        if (!bucket) continue
        bucket.tokens += row.u.total
        bucket.cost = Math.round((bucket.cost + row.cny) * 10000) / 10000
        bucket.calls += 1
      }
    }
    return out
  }

  /** 某群当日花费（预算闸用；含该群 sim/meme 提取等归组记录）。 */
  function todayCostOfScope(scope: string): number {
    rollDay(now())
    return Math.round(todayRows.filter(row => row.scope === scope).reduce((sum, row) => sum + row.cny, 0) * 10000) / 10000
  }

  function recent(limit = 50): TokenLedgerEntry[] {
    rollDay(now())
    return todayRows.slice(-Math.max(1, Math.min(500, limit))).reverse()
  }

  function prune(): number {
    let removed = 0
    try {
      const cutoff = dayKey(now() - retentionDays * 86_400_000)
      for (const name of fs.readdirSync(dir)) {
        if (!/^\d{4}-\d{2}-\d{2}\.ndjson$/.test(name)) continue
        if (name.slice(0, 10) < cutoff) {
          try { fs.unlinkSync(path.join(dir, name)); removed += 1 } catch { /* 删不掉下次再试 */ }
        }
      }
    } catch { /* 目录不存在 */ }
    return removed
  }

  return { record, summary, series, todayCostOfScope, recent, prune, table }
}

export type TokenLedger = ReturnType<typeof createTokenLedger>
