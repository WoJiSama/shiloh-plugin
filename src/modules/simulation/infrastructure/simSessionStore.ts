import type { SimSessionState } from '../../../contracts/simulation.js'
import { createDefaultSimSession } from '../domain/simConfig.js'

/** Redis 形状约束：TRSS 包装层支持 get/set/del/eval，Set 用 JSON 数组模拟（避免依赖 sadd 族）。 */
export interface SimRedisLike {
  get(key: string): Promise<string | null>
  set(key: string, value: string, opts?: { PX?: number; NX?: boolean }): Promise<unknown>
  del(...keys: string[]): Promise<unknown>
}

export interface SimSessionStorePorts {
  redis: SimRedisLike
  logger?: { warn?(message: string): void; error?(message: string, error?: unknown): void }
  now?(): number
}

const SESSION_KEY = (groupId: string) => `shiloh:sim:g:${groupId}`
/** agent 自管记忆与好感度：独立于会话状态（.仿真 重置只清历史/水位/预算，长期记忆保留） */
const MEMORIES_KEY = (groupId: string) => `shiloh:sim:g:${groupId}:memories`
const INIT_KEY = (groupId: string) => `shiloh:sim:g:${groupId}:init`
const AFFINITY_KEY = (groupId: string) => `shiloh:sim:g:${groupId}:affinity`
const USER_STYLE_KEY = (groupId: string) => `shiloh:sim:g:${groupId}:userStyle`
/** .仿真 开/关 的按群覆盖：explicitEnabled（显式启用，allGroups=false 时生效）+ disabled（显式退出） */
const OVERRIDES_KEY = 'shiloh:sim:overrides'
/** 收到过消息的群登记（sweep 遍历用；allGroups 模式下运行时无法枚举白名单群，靠 ingest 自报） */
const KNOWN_KEY = 'shiloh:sim:known'
const BUSY_KEY = (groupId: string) => `shiloh:sim:busy:${groupId}`
/** 回合忙租约：进程崩溃后最多这么久，别的唤醒可以接管。 */
export const SIM_TURN_BUSY_LEASE_MS = 15 * 60_000

export interface SimGroupOverrides { explicitEnabled: string[]; disabled: string[] }

export interface SimSessionStore {
  load(groupId: string): Promise<SimSessionState>
  save(groupId: string, state: SimSessionState): Promise<void>
  reset(groupId: string, presetKeywords: string[]): Promise<SimSessionState>
  /** null = 从未写过覆盖（首次运行，可从 yaml groups 种子） */
  loadOverrides(): Promise<SimGroupOverrides | null>
  saveOverrides(overrides: SimGroupOverrides): Promise<void>
  loadKnownGroups(): Promise<string[]>
  addKnownGroup(groupId: string): Promise<void>
  markBusy(groupId: string): Promise<void>
  clearBusy(groupId: string): Promise<void>
  /** 会话初始提示词：仅 bootstrap 唤醒注入一次 */
  getInitPrompt(groupId: string): Promise<string>
  setInitPrompt(groupId: string, text: string): Promise<void>
  loadMemories(groupId: string): Promise<unknown[]>
  saveMemories(groupId: string, memories: unknown[]): Promise<void>
  loadAffinity(groupId: string): Promise<Record<string, unknown>>
  saveAffinity(groupId: string, affinity: Record<string, unknown>): Promise<void>
  /** 按人口头禅表：{ userId: string[], updatedAt } */
  loadUserStyle(groupId: string): Promise<{ users: Record<string, string[]>; updatedAt: number }>
  saveUserStyle(groupId: string, users: Record<string, string[]>): Promise<void>
}

function parseStringList(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(g => String(g)).filter(Boolean))] : []
}

export function createSimSessionStore(ports: SimSessionStorePorts): SimSessionStore {
  const { redis } = ports
  const now = ports.now ?? Date.now
  const logWarn = (message: string) => { try { ports.logger?.warn?.(message) } catch { /* 日志不可用不阻塞 */ } }

  return {
    async load(groupId) {
      try {
        const raw = await redis.get(SESSION_KEY(groupId))
        if (!raw) return createDefaultSimSession(now())
        const parsed = JSON.parse(raw) as SimSessionState
        if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.unread)) {
          throw new Error('仿真会话状态损坏')
        }
        return normalizeSession(parsed, now())
      } catch (error) {
        // 损坏隔离：不让一次坏数据把后续保存也变成写坏库（qq-bridge 教训：catch{return 默认}会让下次保存清掉整库）。
        logWarn(`[仿真] 群 ${groupId} 会话状态损坏，已重建：${error instanceof Error ? error.message : String(error)}`)
        return createDefaultSimSession(now())
      }
    },
    async save(groupId, state) {
      await redis.set(SESSION_KEY(groupId), JSON.stringify(state))
    },
    async reset(groupId, presetKeywords) {
      const state = createDefaultSimSession(now(), presetKeywords)
      state.bootstrapSent = true // 重置视为已引导过，不再补发初始提示词
      await redis.set(SESSION_KEY(groupId), JSON.stringify(state))
      return state
    },
    async loadOverrides() {
      const raw = await redis.get(OVERRIDES_KEY)
      if (raw === null || raw === undefined) return null
      try {
        const parsed = record(JSON.parse(raw))
        return { explicitEnabled: parseStringList(parsed.explicitEnabled), disabled: parseStringList(parsed.disabled) }
      } catch {
        return { explicitEnabled: [], disabled: [] }
      }
    },
    async saveOverrides(overrides) {
      await redis.set(OVERRIDES_KEY, JSON.stringify({
        explicitEnabled: [...new Set(overrides.explicitEnabled)],
        disabled: [...new Set(overrides.disabled)],
      }))
    },
    async loadKnownGroups() {
      const raw = await redis.get(KNOWN_KEY)
      if (!raw) return []
      try {
        return parseStringList(JSON.parse(raw))
      } catch {
        return []
      }
    },
    async addKnownGroup(groupId) {
      const known = await this.loadKnownGroups()
      if (known.includes(groupId)) return
      await redis.set(KNOWN_KEY, JSON.stringify([...known, groupId]))
    },
    async markBusy(groupId) {
      await redis.set(BUSY_KEY(groupId), String(now()), { PX: SIM_TURN_BUSY_LEASE_MS })
    },
    async clearBusy(groupId) {
      await redis.del(BUSY_KEY(groupId))
    },
    async getInitPrompt(groupId) {
      const raw = await redis.get(INIT_KEY(groupId))
      return raw === null || raw === undefined ? '' : String(raw).slice(0, 2000)
    },
    async setInitPrompt(groupId, text) {
      const value = String(text || '').trim().slice(0, 2000)
      if (value) await redis.set(INIT_KEY(groupId), value)
      else await redis.del(INIT_KEY(groupId))
    },
    async loadMemories(groupId) {
      try {
        const raw = await redis.get(MEMORIES_KEY(groupId))
        return raw ? (Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) as unknown[] : []) : []
      } catch {
        logWarn(`[仿真] 群 ${groupId} 记忆库损坏，按空处理（不回写覆盖，等下一次保存重建）`)
        return []
      }
    },
    async saveMemories(groupId, memories) {
      await redis.set(MEMORIES_KEY(groupId), JSON.stringify(memories))
    },
    async loadAffinity(groupId) {
      try {
        const raw = await redis.get(AFFINITY_KEY(groupId))
        const parsed = raw ? JSON.parse(raw) : {}
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
      } catch {
        logWarn(`[仿真] 群 ${groupId} 好感度数据损坏，按空处理`)
        return {}
      }
    },
    async saveAffinity(groupId, affinity) {
      await redis.set(AFFINITY_KEY(groupId), JSON.stringify(affinity))
    },
    async loadUserStyle(groupId) {
      try {
        const raw = await redis.get(USER_STYLE_KEY(groupId))
        const parsed = raw ? record(JSON.parse(raw)) : {}
        const users: Record<string, string[]> = {}
        for (const [userId, words] of Object.entries(record(parsed.users))) {
          if (Array.isArray(words)) users[userId] = words.map(String).filter(Boolean).slice(0, 6)
        }
        return { users, updatedAt: Number(parsed.updatedAt) || 0 }
      } catch {
        return { users: {}, updatedAt: 0 }
      }
    },
    async saveUserStyle(groupId, users) {
      await redis.set(USER_STYLE_KEY(groupId), JSON.stringify({ users, updatedAt: now() }))
    },
  }
}

function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }

/** 状态解码防御：缺字段补默认，未知字段忽略（旧版本数据升级不炸）。 */
function normalizeSession(parsed: Partial<SimSessionState>, now: number): SimSessionState {
  const base = createDefaultSimSession(now)
  const state: SimSessionState = {
    ...base,
    ...parsed,
    unread: Array.isArray(parsed.unread) ? parsed.unread : [],
    recent: Array.isArray(parsed.recent) ? parsed.recent : [],
    modelSeenSeqs: Array.isArray(parsed.modelSeenSeqs) ? parsed.modelSeenSeqs : [],
    pendingWakeReasons: Array.isArray(parsed.pendingWakeReasons) ? parsed.pendingWakeReasons : [],
    wakeTimes: Array.isArray(parsed.wakeTimes) ? parsed.wakeTimes : [],
    sendTimes: Array.isArray(parsed.sendTimes) ? parsed.sendTimes : [],
    agentHistory: Array.isArray(parsed.agentHistory) ? parsed.agentHistory : [],
    preSleepWait: parsed.preSleepWait && typeof parsed.preSleepWait === 'object' ? parsed.preSleepWait : { accumMs: 0 },
    budget: parsed.budget && typeof parsed.budget === 'object' ? parsed.budget : base.budget,
    wakeConfig: parsed.wakeConfig && typeof parsed.wakeConfig === 'object' ? parsed.wakeConfig : base.wakeConfig,
    conversation: parsed.conversation && typeof parsed.conversation === 'object'
      ? {
          activeUntil: Number(parsed.conversation.activeUntil) || 0,
          interlocutorIds: Array.isArray(parsed.conversation.interlocutorIds) ? parsed.conversation.interlocutorIds.map(String).slice(0, 5) : [],
          ...(parsed.conversation.lastTriggerUserId !== undefined ? { lastTriggerUserId: String(parsed.conversation.lastTriggerUserId) } : {}),
        }
      : base.conversation,
  }
  return state
}
