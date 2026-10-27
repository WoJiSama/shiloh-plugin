// 模型价目表（元/百万 token，CNY）+ 峰谷分时计价的纯函数。
// 借鉴 qq-bridge model-prices.js；泛化点：多模型前缀匹配 + 未知模型按 fallback 估算并标记。
export interface PriceEntry { input: number; cachedInput?: number; output: number }
export interface PeakConfig { enabled: boolean; windows: [number, number][]; weekdays: number[]; multiplier: number; holidays: Record<string, string[]> }
export interface PriceTable { currency: 'CNY'; unit: number; models: Record<string, PriceEntry>; fallback: PriceEntry; peak: PeakConfig }

// 参考价（折 CNY，按各家 2026 公开价目取整；可被 message.yaml pricing.models 覆盖）
export const DEFAULT_PRICE_TABLE: PriceTable = {
  currency: 'CNY',
  unit: 1_000_000,
  models: {
    'gemini-2.5-pro': { input: 9, cachedInput: 2.25, output: 72 },
    'gemini-2.5-flash': { input: 2.2, cachedInput: 0.55, output: 17.3 },
    'gpt-4o-mini': { input: 1.1, output: 4.3 },
    'gpt-4o': { input: 18, output: 72 },
    'deepseek-chat': { input: 2, cachedInput: 0.2, output: 8 },
    'deepseek-reasoner': { input: 4, cachedInput: 1, output: 16 },
    'deepseek-r1': { input: 4, cachedInput: 1, output: 16 },
  },
  fallback: { input: 2, output: 8 },
  peak: {
    enabled: false, // 默认关：Gemini/OpenAI 平价；用 DeepSeek 官方计费时再开
    windows: [[9, 12], [14, 18]], // 北京时间半开区间 [起,止)
    weekdays: [1, 2, 3, 4, 5],
    multiplier: 2,
    // 法定节假日按空闲价；缺失年份的表现是静默高估——保留逐年补录的义务
    holidays: {
      2026: ['2026-01-01', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-04-06', '2026-05-01', '2026-06-19', '2026-09-25', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07'],
      2027: ['2027-01-01'],
    },
  },
}

/** 模型名常带 -preview/-001 等后缀：按最长前缀匹配价目键。 */
export function resolvePriceFor(model: string, table: PriceTable = DEFAULT_PRICE_TABLE): { entry: PriceEntry; estimated: boolean } {
  const name = String(model || '').toLowerCase()
  let best: string | null = null
  for (const key of Object.keys(table.models)) {
    if (name.startsWith(key) && (best === null || key.length > best.length)) best = key
  }
  if (best) return { entry: table.models[best]!, estimated: false }
  return { entry: table.fallback, estimated: true }
}

/** 统一 usage 形状：OpenAI 兼容字段 + 缓存/思考明细（有则取，无则 0）。 */
export interface NormalizedUsage { input: number; output: number; cached: number; reasoning: number; total: number }

export function normalizeUsage(usage: unknown): NormalizedUsage {
  const raw = usage && typeof usage === 'object' && !Array.isArray(usage) ? usage as Record<string, unknown> : {}
  const promptDetails = raw.prompt_tokens_details && typeof raw.prompt_tokens_details === 'object' ? raw.prompt_tokens_details as Record<string, unknown> : {}
  const completionDetails = raw.completion_tokens_details && typeof raw.completion_tokens_details === 'object' ? raw.completion_tokens_details as Record<string, unknown> : {}
  const input = Math.max(0, Math.floor(Number(raw.prompt_tokens) || 0))
  const output = Math.max(0, Math.floor(Number(raw.completion_tokens) || 0))
  return {
    input,
    output,
    cached: Math.min(input, Math.max(0, Math.floor(Number(promptDetails.cached_tokens) || 0))),
    reasoning: Math.min(output, Math.max(0, Math.floor(Number(completionDetails.reasoning_tokens) || 0))),
    total: Math.max(0, Math.floor(Number(raw.total_tokens) || input + output)),
  }
}

/** 北京日历（UTC+8 手算，不依赖机器时区）。 */
function beijingParts(at: number): { date: string; hour: number; weekday: number } {
  const d = new Date(at + 8 * 3600_000)
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours(), weekday: d.getUTCDay() }
}

export function isPeakAt(at: number, peak: PeakConfig): boolean {
  if (!peak.enabled) return false
  const { date, hour, weekday } = beijingParts(at)
  if ((peak.holidays[date.slice(0, 4)] || []).includes(date)) return false
  if (!peak.weekdays.includes(weekday)) return false
  return peak.windows.some(([from, to]) => hour >= from && hour < to)
}

export interface UsageCost { cny: number; estimated: boolean; peak: boolean }

export function costOfUsage(model: string, usage: NormalizedUsage, at: number, table: PriceTable = DEFAULT_PRICE_TABLE): UsageCost {
  const { entry, estimated } = resolvePriceFor(model, table)
  const peak = isPeakAt(at, table.peak)
  const multiplier = peak ? table.peak.multiplier : 1
  const freshInput = Math.max(0, usage.input - usage.cached)
  const cny = (freshInput * entry.input + usage.cached * (entry.cachedInput ?? entry.input) + usage.output * entry.output) * multiplier / table.unit
  return { cny: Math.round(cny * 10000) / 10000, estimated, peak }
}

/** message.yaml pricing.models 覆盖合并（浅合并按模型键）。 */
export function mergePriceOverrides(table: PriceTable, overrides: unknown): PriceTable {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return table
  const models = { ...table.models }
  for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue
    const entry = value as Record<string, unknown>
    const input = Number(entry.input)
    const output = Number(entry.output)
    if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0) continue
    const cached = Number(entry.cachedInput)
    models[key] = { input, output, ...(Number.isFinite(cached) && cached >= 0 ? { cachedInput: cached } : {}) }
  }
  return { ...table, models }
}
