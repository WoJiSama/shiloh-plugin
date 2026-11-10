import type { SimMoodState, SimSessionState } from '../../../contracts/simulation.js'
import { randomUUID } from 'node:crypto'
import type { CharacterScope } from '../../../contracts/character.js'
import { characterKey } from '../domain/characterState.js'
import { createDefaultSimSession } from '../domain/simConfig.js'
import { stripSupersededItems } from '../domain/personProfile.js'

/** Redis 形状约束：TRSS 包装层支持 get/set/del/eval，Set 用 JSON 数组模拟（避免依赖 sadd 族）。 */
export interface SimRedisLike {
  get(key: string): Promise<string | null>
  set(key: string, value: string, opts?: { PX?: number; NX?: boolean }): Promise<unknown>
  del(...keys: string[]): Promise<unknown>
  /** 控制台人物记忆页列出全部档案用（SCAN）；不可用时列表为空 */
  keys?(pattern: string): Promise<string[]>
}

export interface SimSessionStorePorts {
  characterScope?: CharacterScope
  redis: SimRedisLike
  logger?: { warn?(message: string): void; error?(message: string, error?: unknown): void }
  now?(): number
}

const SESSION_KEY = (groupId: string) => `shiloh:sim:g:${groupId}`
// Kept outside session snapshots: a second process can revoke an in-flight turn
// without a stale writer restoring the old version or overwriting unread input.
const ACTIVITY_VERSION_KEY = (groupId: string) => `${SESSION_KEY(groupId)}:activity-version`
/** One execution process may still have concurrent ingress, turn and background writers. */
const sessionWrites = new WeakMap<object, Map<string, Promise<void>>>()
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
/** 人物核心档案（跨群共享，按人一个 key）：称呼偏好 + 长期爱好 + 雷点，只放"到处都合适被知道"的身份级事实 */
const PERSON_KEY = (userId: string) => `shiloh:sim:person:${userId}`
/** 全局好感底分（跨群）：群内每次好感变动按 30% 权重镜像，作为关系的"本钱" */
const GLOBAL_AFFINITY_KEY = (userId: string) => `shiloh:sim:person:${userId}:affinity`
/** 全局作息（人物级，不分群）：AI 可用 simSetRhythm 自设睡眠窗口 */
const RHYTHM_KEY = 'shiloh:sim:rhythm'
/** 生活线（全局）：真实数据源的持续关注线（在追的番/在玩的游戏） */
const LIFE_THREADS_KEY = 'shiloh:sim:life-threads'
/** AI 自我记忆（跨群性格沉淀）：与群级 memories 同结构，但全局一份 */
const SELF_MEMORIES_KEY = 'shiloh:sim:self-memories'
/** 情绪四轴（跨群全局）：你自己此刻的状态，换群不重置 */
const MOOD_KEY = 'shiloh:sim:mood'
/** 回合忙租约：进程崩溃后最多这么久，别的唤醒可以接管。 */
/**
 * 回合忙租约：正常运行时 15 分钟（防并发回合），但进程重启后不应阻塞群这么久。
 * 修法（qq-bridge 176433a）：正常回合仍用完整租约，但 runtime 启动时主动清掉
 * 所有 busy 标记（重启=旧回合已死，不存在真并发），等效于"断线宽限≈启动时间"。
 */
export const SIM_TURN_BUSY_LEASE_MS = 15 * 60_000

/** 群级覆盖（.仿真 开/关 与控制台预算编辑都写这里）：budgetCaps 键=群号 值=每日金额上限；budgetDefaultCny 为空表示用 yaml 默认；atOnly=「仅被@才回」群清单（管理员设定，优先于 AI 自设触发器）；playAlongUntil=「活跃助推」到期表（epoch ms，助推窗口内系统兜底节奏，过期回落自主档、由 AI 自设配置接管） */
export interface SimGroupOverrides { explicitEnabled: string[]; disabled: string[]; budgetCaps: Record<string, number>; turnCaps: Record<string, number>; atOnly?: string[]; playAlongUntil?: Record<string, number>; budgetDefaultCny?: number }

export interface SimSessionStore {
  load(groupId: string): Promise<SimSessionState>
  save(groupId: string, state: SimSessionState): Promise<void>
  reset(groupId: string, presetKeywords: string[]): Promise<SimSessionState>
  loadActivityVersion(groupId: string): Promise<string>
  invalidateActivity(groupId: string): Promise<void>
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
  /** 人物核心档案（跨群）：读取 + 合并去重（name 最新优先，interests/taboos 并集截断；closedFacts 新陈代谢先剔除再并入） */
  loadPersonProfile(userId: string): Promise<{ name?: string; interests: string[]; taboos: string[]; traits?: string[]; facts?: string[]; updatedAt?: number }>
  mergePersonProfile(userId: string, patch: { name?: string; interests?: string[]; taboos?: string[]; traits?: string[]; facts?: string[]; closedFacts?: string[] }, maxFields: number): Promise<{ name?: string; interests: string[]; taboos: string[]; traits?: string[]; facts?: string[] }>
  /** 全局好感底分：批量读 + 变动镜像（delta×权重，EMA 不需要——简单累积即长期均值；reason 进全局关系近况） */
  loadGlobalAffinity(userIds: string[]): Promise<Record<string, number>>
  bumpGlobalAffinity(userId: string, delta: number, reason?: string): Promise<number>
  /** 全局关系近况：跨群好感变动的理由（最近在前，≤6 条），供人物卡"关系近况"行 */
  loadGlobalAffinityNotes(userIds: string[]): Promise<Record<string, string[]>>
  /** 控制台：列出全部人物档案（跨群数据透明化） */
  listPersonProfiles(): Promise<{ userId: string; name?: string; interests: string[]; taboos: string[]; traits?: string[]; facts?: string[]; globalAffinity?: number; updatedAt?: number }[]>
  /** 控制台：整人删除（档案 + 全局好感） */
  deletePersonProfile(userId: string): Promise<boolean>
  /** 控制台：删单条字段（field: name|interests|taboos|traits|facts；value 省略=清空 name） */
  deletePersonProfileField(userId: string, field: string, value?: string): Promise<{ name?: string; interests: string[]; taboos: string[]; traits?: string[]; facts?: string[] }>
  /** 全局作息：load 返回 null=从未设过（用配置默认）；save 由 simSetRhythm 调用 */
  loadRhythm(): Promise<{ sleepFrom: number; sleepTo: number; setBy?: string } | null>
  saveRhythm(rhythm: { sleepFrom: number; sleepTo: number; setBy?: string }): Promise<void>
  /** 生活线：全局列表读写（真实数据源线程） */
  loadLifeThreads(): Promise<unknown[]>
  saveLifeThreads(threads: unknown[]): Promise<void>
  /** AI 自我记忆（跨群性格沉淀：口头禅/偏好，scope=self 的 simRemember 条目） */
  loadSelfMemories(): Promise<unknown[]>
  saveSelfMemories(memories: unknown[]): Promise<void>
  /** 情绪四轴（跨群全局）：存最近一次写入的瞬时值，null=从未写过；衰减投影由读取侧做 */
  loadMood(): Promise<unknown>
  saveMood(mood: SimMoodState): Promise<void>
}

function parseStringList(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.map(g => String(g)).filter(Boolean))] : []
}

export function createSimSessionStore(ports: SimSessionStorePorts): SimSessionStore {
  const { redis } = ports
  const now = ports.now ?? Date.now
  const selfKey = (legacy: string): string => ports.characterScope ? `${characterKey(ports.characterScope)}:legacy:${legacy.split(':').pop()}` : legacy
  const logWarn = (message: string) => { try { ports.logger?.warn?.(message) } catch { /* 日志不可用不阻塞 */ } }
  const saveSession = async (groupId: string, state: SimSessionState): Promise<void> => {
    const key = SESSION_KEY(groupId), snapshot = JSON.stringify(state)
    let writes = sessionWrites.get(redis)
    if (!writes) { writes = new Map(); sessionWrites.set(redis, writes) }
    const previous = writes.get(key) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(async () => { await redis.set(key, snapshot) })
    writes.set(key, operation)
    try { await operation } finally { if (writes.get(key) === operation) writes.delete(key) }
  }

  return {
    async loadActivityVersion(groupId) {
      return (await redis.get(ACTIVITY_VERSION_KEY(groupId))) ?? ''
    },
    async invalidateActivity(groupId) {
      await redis.set(ACTIVITY_VERSION_KEY(groupId), randomUUID())
    },
    async load(groupId) {
      // A released live state may still have its last snapshot queued for persistence.
      for (;;) {
        const pending = sessionWrites.get(redis)?.get(SESSION_KEY(groupId))
        if (!pending) break
        await pending
        if (sessionWrites.get(redis)?.get(SESSION_KEY(groupId)) === pending) break
      }
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
      await saveSession(groupId, state)
    },
    async reset(groupId, presetKeywords) {
      const state = createDefaultSimSession(now(), presetKeywords)
      state.bootstrapSent = true // 重置视为已引导过，不再补发初始提示词
      await saveSession(groupId, state)
      return state
    },
    async loadOverrides() {
      const raw = await redis.get(OVERRIDES_KEY)
      if (raw === null || raw === undefined) return null
      try {
        const parsed = record(JSON.parse(raw))
        const normalizeCaps = (raw: unknown): Record<string, number> => {
          const caps: Record<string, number> = {}
          for (const [key, value] of Object.entries(record(raw))) {
            const cap = Number(value)
            if (!/^\d{5,12}$/.test(key)) continue
            if (cap === -1) { caps[key] = -1; continue }
            if (Number.isFinite(cap) && cap > 0) caps[key] = Math.min(10_000, cap)
          }
          return caps
        }
        const budgetCaps = normalizeCaps(parsed.budgetCaps)
        const turnCaps = normalizeCaps(parsed.turnCaps)
        const rawDefault = Number(parsed.budgetDefaultCny)
        const playAlongUntil: Record<string, number> = {}
        for (const [key, value] of Object.entries(record(parsed.playAlongUntil))) {
          const until = Number(value)
          if (/^\d{5,12}$/.test(key) && Number.isFinite(until) && until > 0) playAlongUntil[key] = Math.floor(until)
        }
        return { explicitEnabled: parseStringList(parsed.explicitEnabled), disabled: parseStringList(parsed.disabled), budgetCaps, turnCaps, atOnly: parseStringList(parsed.atOnly), playAlongUntil, ...(Number.isFinite(rawDefault) && rawDefault > 0 ? { budgetDefaultCny: Math.min(10_000, rawDefault) } : {}) }
      } catch {
        return { explicitEnabled: [], disabled: [], budgetCaps: {}, turnCaps: {} }
      }
    },
    async saveOverrides(overrides) {
      await redis.set(OVERRIDES_KEY, JSON.stringify({
        explicitEnabled: [...new Set(overrides.explicitEnabled)],
        disabled: [...new Set(overrides.disabled)],
        budgetCaps: overrides.budgetCaps || {},
        turnCaps: overrides.turnCaps || {},
        atOnly: overrides.atOnly || [],
        playAlongUntil: overrides.playAlongUntil || {},
        ...(overrides.budgetDefaultCny !== undefined ? { budgetDefaultCny: overrides.budgetDefaultCny } : {}),
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
    async loadPersonProfile(userId) {
      const id = String(userId || '').replace(/[^0-9]/g, '')
      if (!id) return { interests: [], taboos: [] }
      const raw = await redis.get(PERSON_KEY(id))
      try {
        const parsed = raw ? record(JSON.parse(raw)) : {}
        return {
          ...(typeof parsed.name === 'string' && parsed.name.trim() ? { name: parsed.name.trim().slice(0, 20) } : {}),
          interests: parseStringList(parsed.interests).slice(0, 12),
          taboos: parseStringList(parsed.taboos).slice(0, 12),
          ...(parseStringList(parsed.traits).length ? { traits: parseStringList(parsed.traits).slice(0, 12) } : {}),
          ...(parseStringList(parsed.facts).length ? { facts: parseStringList(parsed.facts).slice(0, 12) } : {}),
          ...(typeof parsed.updatedAt === 'number' ? { updatedAt: parsed.updatedAt } : {})
        }
      } catch { return { interests: [], taboos: [] } }
    },
    async mergePersonProfile(userId, patch, maxFields) {
      const id = String(userId || '').replace(/[^0-9]/g, '')
      if (!id) return { interests: [], taboos: [] }
      const current = await this.loadPersonProfile(id)
      const name = typeof patch.name === 'string' && patch.name.trim() ? patch.name.trim().slice(0, 20) : current.name
      const uniq = (list: string[]) => {
        const seen = new Set<string>()
        const out: string[] = []
        for (const item of list) {
          const value = String(item || '').trim().slice(0, 30)
          if (!value || seen.has(value)) continue
          seen.add(value); out.push(value)
        }
        return out
      }
      // 新陈代谢：closedFacts 先剔除存量（facts/interests/traits 都可能被结束），新事实再并入
      const closed = patch.closedFacts
      const merged = {
        ...(name ? { name } : {}),
        interests: uniq([...(patch.interests || []), ...stripSupersededItems(current.interests, closed)]).slice(0, maxFields),
        taboos: uniq([...(patch.taboos || []), ...current.taboos]).slice(0, maxFields),
        ...(uniq([...(patch.traits || []), ...stripSupersededItems(current.traits, closed)]).length ? { traits: uniq([...(patch.traits || []), ...stripSupersededItems(current.traits, closed)]).slice(0, 4) } : {}),
        ...(uniq([...(patch.facts || []), ...stripSupersededItems(current.facts, closed)]).length ? { facts: uniq([...(patch.facts || []), ...stripSupersededItems(current.facts, closed)]).slice(0, maxFields) } : {}),
        updatedAt: now()
      }
      await redis.set(PERSON_KEY(id), JSON.stringify(merged))
      return merged
    },
    async loadGlobalAffinity(userIds) {
      const out: Record<string, number> = {}
      for (const raw of userIds) {
        const id = String(raw || '').replace(/[^0-9]/g, '')
        if (!id) continue
        try {
          const parsed = record(JSON.parse(String(await redis.get(GLOBAL_AFFINITY_KEY(id)) || 'null')))
          const score = Number(parsed.score)
          if (Number.isFinite(score) && score >= 0 && score <= 100) out[id] = Math.round(score)
        } catch { /* 单人失败不影响整批 */ }
      }
      return out
    },
    async bumpGlobalAffinity(userId, delta, reason) {
      const id = String(userId || '').replace(/[^0-9]/g, '')
      if (!id) return 50
      let existing: { score?: number; reasons?: unknown[] } = {}
      try {
        existing = record(JSON.parse(String(await redis.get(GLOBAL_AFFINITY_KEY(id)) || 'null')))
      } catch { existing = {} }
      const current = Number(existing.score)
      const base = Number.isFinite(current) && current >= 0 && current <= 100 ? current : 50
      const next = Math.max(0, Math.min(100, Math.round(base + (Number(delta) || 0) * 0.3)))
      const reasonText = String(reason || '').replace(/\s+/g, ' ').trim().slice(0, 40)
      const reasons = [...(reasonText ? [reasonText] : []), ...(Array.isArray(existing.reasons) ? existing.reasons.map(String) : [])].slice(0, 6)
      await redis.set(GLOBAL_AFFINITY_KEY(id), JSON.stringify({ score: next, updatedAt: Date.now(), reasons }))
      return next
    },
    async loadGlobalAffinityNotes(userIds) {
      const out: Record<string, string[]> = {}
      for (const raw of userIds) {
        const id = String(raw || '').replace(/[^0-9]/g, '')
        if (!id) continue
        try {
          const parsed = record(JSON.parse(String(await redis.get(GLOBAL_AFFINITY_KEY(id)) || 'null')))
          const reasons = Array.isArray(parsed.reasons) ? parsed.reasons.map(String).filter(Boolean).slice(0, 6) : []
          if (reasons.length) out[id] = reasons
        } catch { /* 单人失败不影响整批 */ }
      }
      return out
    },
    async listPersonProfiles() {
      if (typeof redis.keys !== 'function') return []
      let ids: string[] = []
      try {
        const keysList = await redis.keys('shiloh:sim:person:*')
        const idSet = new Set<string>()
        for (const key of keysList || []) {
          const match = String(key).match(/^shiloh:sim:person:(\d+)/)
          if (match) idSet.add(match[1]!)
        }
        ids = [...idSet]
      } catch { return [] }
      const out = []
      for (const id of ids.slice(0, 500)) {
        const profile = await this.loadPersonProfile(id)
        const globalAffinity = (await this.loadGlobalAffinity([id]))[id]
        const isEmpty = !profile.name && !profile.interests.length && !profile.taboos.length && !(profile.traits?.length) && !(profile.facts?.length) && globalAffinity === undefined
        if (isEmpty) continue
        out.push({ userId: id, ...profile, ...(globalAffinity !== undefined ? { globalAffinity } : {}) })
      }
      return out.sort((a, b) => (b.globalAffinity ?? 50) - (a.globalAffinity ?? 50))
    },
    async deletePersonProfile(userId) {
      const id = String(userId || '').replace(/[^0-9]/g, '')
      if (!id) return false
      await redis.del(PERSON_KEY(id), GLOBAL_AFFINITY_KEY(id))
      return true
    },
    async loadRhythm() {
      try {
        const raw = await redis.get(selfKey(RHYTHM_KEY))
        if (!raw) return null
        const parsed = record(JSON.parse(raw))
        const from = Number(parsed.sleepFrom), to = Number(parsed.sleepTo)
        if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || from > 23 || to < 1 || to > 24 || to <= from) return null
        return { sleepFrom: from, sleepTo: to, ...(typeof parsed.setBy === 'string' ? { setBy: parsed.setBy } : {}) }
      } catch { return null }
    },
    async saveRhythm(rhythm) {
      await redis.set(selfKey(RHYTHM_KEY), JSON.stringify({ sleepFrom: rhythm.sleepFrom, sleepTo: rhythm.sleepTo, setBy: rhythm.setBy || 'agent', updatedAt: now() }))
    },
    async loadLifeThreads() {
      try {
        const raw = await redis.get(selfKey(LIFE_THREADS_KEY))
        const parsed = raw ? JSON.parse(raw) : []
        return Array.isArray(parsed) ? parsed : []
      } catch { return [] }
    },
    async saveLifeThreads(threads) {
      await redis.set(selfKey(LIFE_THREADS_KEY), JSON.stringify(Array.isArray(threads) ? threads : []))
    },
    async loadSelfMemories() {
      try {
        const raw = await redis.get(selfKey(SELF_MEMORIES_KEY))
        const parsed = raw ? JSON.parse(raw) : []
        return Array.isArray(parsed) ? parsed : []
      } catch { return [] }
    },
    async saveSelfMemories(memories) {
      await redis.set(selfKey(SELF_MEMORIES_KEY), JSON.stringify(Array.isArray(memories) ? memories : []))
    },
    async loadMood() {
      try {
        const raw = await redis.get(selfKey(MOOD_KEY))
        return raw ? JSON.parse(raw) : null
      } catch { return null }
    },
    async saveMood(mood) {
      await redis.set(selfKey(MOOD_KEY), JSON.stringify(mood))
    },
    async deletePersonProfileField(userId, field, value) {
      const id = String(userId || '').replace(/[^0-9]/g, '')
      if (!id) return { interests: [], taboos: [] }
      const current = await this.loadPersonProfile(id)
      const name = field === 'name' ? undefined : current.name
      const filter = (list: string[] | undefined) => value === undefined ? [] : (list || []).filter(item => item !== value)
      const merged = {
        ...(name ? { name } : {}),
        interests: field === 'interests' ? filter(current.interests) : current.interests,
        taboos: field === 'taboos' ? filter(current.taboos) : current.taboos,
        ...(field === 'traits' || current.traits?.length ? { traits: field === 'traits' ? filter(current.traits) : current.traits } : {}),
        ...(field === 'facts' || current.facts?.length ? { facts: field === 'facts' ? filter(current.facts) : current.facts } : {}),
        updatedAt: now()
      }
      await redis.set(PERSON_KEY(id), JSON.stringify(merged))
      return merged
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
