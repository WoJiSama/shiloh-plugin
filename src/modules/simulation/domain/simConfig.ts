import type { SimulationSection, SimRuntimeConfig, SimSessionState, SimWakeConfig, SimWakeTriggers } from '../../../contracts/simulation.js'

export const SIM_UNREAD_LIMIT_DEFAULT = 30
export const SIM_PENDING_REASONS_LIMIT = 20
export const SIM_WAKE_TIMES_LIMIT = 200
export const SIM_KEYWORDS_LIMIT = 16
export const SIM_SPEAKER_LIMIT = 20
export const SIM_MIN_BATCH_WINDOW_MS = 1000

export const DEFAULT_SIM_WAKE_TRIGGERS: SimWakeTriggers = {
  atMention: true,
  nameMention: true,
  keywords: [],
  question: true,
  poke: true,
  anyMessage: false,
  speakerIds: [],
  probability: 0.05,
}

export const DEFAULT_SIM_WAKE_CONFIG: SimWakeConfig = {
  mode: 'diving',
  triggers: { ...DEFAULT_SIM_WAKE_TRIGGERS, keywords: [] },
  batchWindowMs: 8000,
  confirmedBy: 'default',
}

export function defaultSimRuntimeConfig(section: SimulationSection = {}): SimRuntimeConfig {
  const wake = section.wake || {}
  const turn = section.turn || {}
  return {
    enabled: section.enabled !== false,
    // 默认全群进仿真（过了群白名单的都算）；置 false 时只看显式清单
    allGroups: section.allGroups !== false,
    wake: {
      probability: clamp(wake.probability ?? 0.05, 0, 1),
      batchWindowMs: Math.max(SIM_MIN_BATCH_WINDOW_MS, Math.floor(wake.batchWindowMs ?? 8000)),
      maxWakePerMinute: Math.max(1, Math.floor(wake.maxWakePerMinute ?? 2)),
      maxWakePerHour: Math.max(1, Math.floor(wake.maxWakePerHour ?? 12)),
      proactiveIdleMs: Math.max(60_000, Math.floor(wake.proactiveIdleMs ?? 15 * 60_000)),
      proactiveCheckMinMs: Math.max(60_000, Math.floor(wake.proactiveCheckMinMs ?? 30 * 60_000)),
      proactiveCheckMaxMs: Math.max(120_000, Math.floor(wake.proactiveCheckMaxMs ?? 90 * 60_000)),
      proactiveProbability: clamp(wake.proactiveProbability ?? 0.3, 0, 1),
      replyCheckMs: Math.max(5000, Math.floor(wake.replyCheckMs ?? 30_000)),
      continuationWindowMs: Math.max(30_000, Math.floor(wake.continuationWindowMs ?? 300_000)),
    },
    turn: {
      maxToolRounds: Math.max(1, Math.floor(turn.maxToolRounds ?? 10)),
      maxSendsPerTurn: Math.max(1, Math.floor(turn.maxSendsPerTurn ?? 5)),
      minSendGapMs: Math.max(0, Math.floor(turn.minSendGapMs ?? 800)),
      sendPerMinute: Math.max(1, Math.floor(turn.sendPerMinute ?? 8)),
      maxTurnsPerDay: Math.max(1, Math.floor(turn.maxTurnsPerDay ?? 40)),
      historyMaxMessages: Math.max(4, Math.floor(turn.historyMaxMessages ?? 40)),
      historyMaxChars: Math.max(2000, Math.floor(turn.historyMaxChars ?? 24_000)),
      unreadLimit: Math.max(5, Math.floor(turn.unreadLimit ?? SIM_UNREAD_LIMIT_DEFAULT)),
      wakeMessageLimit: Math.max(1, Math.floor(turn.wakeMessageLimit ?? 12)),
      wakeMaxChars: Math.max(500, Math.floor(turn.wakeMaxChars ?? 6000)),
      messageTextMaxChars: Math.max(50, Math.floor(turn.messageTextMaxChars ?? 200)),
      waitQuietMaxMs: Math.max(1000, Math.floor(turn.waitQuietMaxMs ?? 120_000)),
      waitTimeoutMaxMs: Math.max(1000, Math.floor(turn.waitTimeoutMaxMs ?? 120_000)),
    },
    agentPresetKeywords: (section.agentPresetKeywords || []).map(k => String(k || '').trim()).filter(Boolean).slice(0, SIM_KEYWORDS_LIMIT),
    extraTools: Array.isArray(section.extraTools) ? [...new Set(section.extraTools.map(n => String(n || '').trim()).filter(Boolean))] : [],
    budget: {
      dailyCostCny: Math.max(0, Number((section.budget || {}).dailyCostCny ?? 5)),
    },
    userStyle: {
      enabled: (section.userStyle || {}).enabled !== false,
      cooldownMs: Math.max(600_000, Math.floor((section.userStyle || {}).cooldownMs ?? 6 * 3600_000)),
      archiveDays: Math.min(14, Math.max(1, Math.floor((section.userStyle || {}).archiveDays ?? 3))),
    },
    meme: {
      enabled: (section.meme || {}).enabled !== false,
      extractCooldownMs: Math.max(60_000, Math.floor((section.meme || {}).extractCooldownMs ?? 600_000)),
      extractMinMessages: Math.max(5, Math.floor((section.meme || {}).extractMinMessages ?? 10)),
      injectMax: Math.max(1, Math.floor((section.meme || {}).injectMax ?? 6)),
    },
  }
}

function clamp(value: number, min: number, max: number) {
  const n = Number(value)
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

function normalizeKeywordList(value: unknown): string[] {
  const list = Array.isArray(value) ? value : []
  return [...new Set(list.map(item => String(item || '').trim()).filter(Boolean))].slice(0, SIM_KEYWORDS_LIMIT)
}

function normalizeSpeakerList(value: unknown): string[] {
  const list = Array.isArray(value) ? value : []
  return [...new Set(list.map(item => String(item || '').trim()).filter(item => /^\d{1,12}$/.test(item)))].slice(0, SIM_SPEAKER_LIMIT)
}

/** 唤醒配置归一化：只信白名单字段，数值全部夹取；非法输入回落默认。 */
export function normalizeSimWakeConfig(input: unknown): SimWakeConfig {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
  const rawTriggers = raw.triggers && typeof raw.triggers === 'object' && !Array.isArray(raw.triggers) ? raw.triggers as Record<string, unknown> : {}
  const triggers: SimWakeTriggers = {
    atMention: rawTriggers.atMention !== false,
    nameMention: rawTriggers.nameMention !== false,
    keywords: normalizeKeywordList(rawTriggers.keywords),
    question: rawTriggers.question !== false,
    poke: rawTriggers.poke !== false,
    anyMessage: rawTriggers.anyMessage === true,
    speakerIds: normalizeSpeakerList(rawTriggers.speakerIds),
    probability: clamp(Number(rawTriggers.probability ?? DEFAULT_SIM_WAKE_TRIGGERS.probability), 0, 1),
  }
  const mode = raw.mode === 'active' ? 'active' : 'diving'
  const confirmedBy = raw.confirmedBy === 'agent' || raw.confirmedBy === 'admin' ? raw.confirmedBy : 'default'
  const batchWindowMs = Math.max(SIM_MIN_BATCH_WINDOW_MS, Math.floor(Number(raw.batchWindowMs) || DEFAULT_SIM_WAKE_CONFIG.batchWindowMs))
  const sleepUntilRaw = Number(raw.sleepUntil)
  const config: SimWakeConfig = { mode, triggers, batchWindowMs, confirmedBy }
  if (mode === 'active' && Number.isFinite(sleepUntilRaw) && sleepUntilRaw > 0) config.sleepUntil = sleepUntilRaw
  return config
}

/**
 * 防永眠：触发器全部关闭（无硬触发、无定时、无概率）的配置等于让会话永远醒不来，
 * 直接重置为默认配置。返回是否发生了重置，调用方需要把这件事告诉模型和管理日志。
 */
export function ensureWakeable(config: SimWakeConfig): { config: SimWakeConfig; reset: boolean } {
  const t = config.triggers
  const hasHardTrigger = t.atMention || t.nameMention || t.question || t.poke || t.anyMessage
    || t.keywords.length > 0 || t.speakerIds.length > 0
  const hasTimed = config.mode === 'active' && typeof config.sleepUntil === 'number'
  const hasProbability = t.probability > 0
  if (hasHardTrigger || hasTimed || hasProbability) return { config, reset: false }
  return { config: { ...DEFAULT_SIM_WAKE_CONFIG, triggers: { ...DEFAULT_SIM_WAKE_CONFIG.triggers } }, reset: true }
}

export function createDefaultSimSession(now = Date.now(), presetKeywords: string[] = []): SimSessionState {
  const triggers = { ...DEFAULT_SIM_WAKE_CONFIG.triggers, keywords: [...presetKeywords] }
  return {
    seq: 0,
    unread: [],
    recent: [],
    lastReadThroughSeq: 0,
    modelSeenSeqs: [],
    wakeConfig: { ...DEFAULT_SIM_WAKE_CONFIG, triggers },
    lastIncomingAt: 0,
    lastAiSendAt: 0,
    lastWakeReason: null,
    lastWakeAt: 0,
    pendingWakeReasons: [],
    wakeTimes: [],
    sendTimes: [],
    preSleepWait: { accumMs: 0 },
    agentHistory: [],
    budget: { day: dayKey(now), turns: 0, tokens: 0 },
    conversation: { activeUntil: 0, interlocutorIds: [] },
    nextProactiveCheckAt: nextProactiveSlot(now),
    nextReplyCheckAt: 0,
    bootstrapSent: false,
  }
}

export function dayKey(now: number): string {
  const d = new Date(now + 8 * 3600_000)
  return d.toISOString().slice(0, 10)
}

function nextProactiveSlot(now: number, minMs = 30 * 60_000, maxMs = 90 * 60_000): number {
  return now + minMs + Math.floor(Math.random() * (maxMs - minMs))
}
