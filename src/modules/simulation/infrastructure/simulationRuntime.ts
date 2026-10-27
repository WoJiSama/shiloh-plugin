import type { ChatRequestData, ChatResponse } from '../../../contracts/modelGateway.js'
import type { PersonaText } from '../../conversation/domain/personaSource.js'
import type { SimAffinityEntry, SimAffinityMap, SimulationSection, SimHistoryMessage, SimMemoryEntry, SimMessage, SimRuntimeConfig, SimSessionState, SimWakeReason } from '../../../contracts/simulation.js'
import { defaultSimRuntimeConfig } from '../domain/simConfig.js'
import { affinityLevel, buildMemeExtractionPrompt, bumpMemeUsage, defaultAffinityEntry, dueMemories, mergeMemeCandidates, normalizeMemoryList, parseMemeCandidates } from '../domain/simMemory.js'
import { mineUserCatchphrases } from '../domain/userStyle.js'
import { evaluateWakeTrigger, mergeWakeReason, messageReasonStillPending, pushPendingReason, TIMER_WAKE_REASONS } from '../domain/wakeTrigger.js'
import { noteModelSeen, readThroughSeq } from '../domain/watermark.js'
import { buildWakeSnapshot, compactSimMessage } from '../domain/messageView.js'
import { computeWaitOutcome, normalizeWaitPlan, type SimWaitPlan } from '../domain/waitGate.js'
import { checkSendAllowance, checkWakeBudget, invalidatePreSleepWaitByParticipation, markPreSleepSatisfied, recordSend, recordWake, recordWakeTokens, resetPreSleepWait, rollBudgetDay } from '../domain/budget.js'
import { buildSimSystemPrompt, buildWakePrompt, trimAgentHistory } from '../domain/promptBuilder.js'
import { buildChatRequestData } from '../../models/domain/modelGateway.js'
import { createSimSessionStore, type SimGroupOverrides, type SimSessionStore } from './simSessionStore.js'
import type { AbstractTool } from '../../toolSupport/infrastructure/AbstractTool.js'
import { redactInternalStatusLeaks } from '../../conversation/domain/internalStatusLeak.js'
import { createSimTools, simToolsAsFunctions, type SimSendResult, type SimWaitResult, type SimToolContext } from './simTools.js'

export const SIM_RECENT_LIMIT = 60
export const SIM_SWEEP_INTERVAL_MS = 30_000

export interface SimulationRuntimePorts {
  redis: Parameters<typeof createSimSessionStore>[0]['redis']
  logger: { info(message: string): void; warn(message: string): void; error(message: string, error?: unknown): void }
  /** 每次调用重读（config 热更新即时生效） */
  getSection(): SimulationSection
  /** 解码后的宿主执行配置（YTapi 的 config 参数） */
  getExecutionConfig(): unknown
  /** 当前 bot 身份（多号时以事件的 self_id 为准） */
  getSelf(selfIdHint?: string | number): { id: string; name: string }
  YTapi(requestData: ChatRequestData, config: unknown): Promise<ChatResponse>
  /** 出站发送：segments 为 OneBot 消息段数组（经全局出站闸门）；成功时尽量带回 message_id 供回执校验 */
  sendGroupMessage(groupId: string, segments: unknown[]): Promise<{ ok: boolean; error?: string; messageId?: string | number }>
  getPersona(groupId: string, selfId: string): { persona: PersonaText; systemContent: string }
  /** 仿真回合额外放通的既有工具（simulation.extraTools 白名单；从 localToolRegistry 取实例） */
  getExtraTools?(names: string[]): import('../../toolSupport/infrastructure/AbstractTool.js').AbstractTool[]
  /** 本群近期主线摘要（中期记忆）；无则空串 */
  getGroupDigest?(groupId: string): string
  /** 近两天情节记忆文本（"这两天聊过/做过什么"）；无则空串 */
  getRecentEpisodesText?(groupId: string): string
  /** 说话风格参考（群级表达学习 + 全局表达学习的注入文本）；无则空串 */
  getStyleDigest?(groupId: string): Promise<string> | string
  /** 读归档消息（按人挖口头禅的数据源）：近 N 天该群消息（userId+text） */
  readArchiveMessages?(groupId: string, days: number): Promise<{ userId: string; text: string }[]>
  /** 戳群成员（B2：回应拍一拍/主动逗熟人） */
  pokeMember?(groupId: string, userId: string): Promise<{ ok: boolean; error?: string }>
  /** 群成员列表（B3）：[{userId, nick}] */
  getGroupMembers?(groupId: string): Promise<{ userId: string; nick: string }[]>
  /** 合并转发内容（B4）：逐条正文 + 内嵌转发 id 列表（可递归展开） */
  getForwardContent?(forwardId: string): Promise<{ lines: string[]; error?: string; total?: number; truncated?: boolean; nestedForwardIds?: string[] }>
  /** 精选收藏表情（B6）：把消息附图收进表情包库（走完整 VLM 审核打标管线） */
  collectStickerImage?(groupId: string, url: string): Promise<{ ok: boolean; error?: string }>
  /** 仿真回合结束补记情节（仿真群不走主链路，情节记忆会断档） */
  recordEpisode?(input: { groupId: string; userId?: string; userName?: string; summary: string; reply: string }): void
  /** 本群专属梗提取（侧路小模型，返回原始模型文本；runtime 负责容错解析） */
  memeExtract?(messages: { name: string; text: string }[]): Promise<string>
  /** 令牌账本：仿真回合/梗提取的归组记录 */
  recordTokens?(input: { scope: string; stage: string; model?: string; usage?: unknown; ms?: number }): void
  /** 当日该群花费（元，读令牌账本；预算闸用） */
  getTodaySpendCny?(scope: string): number
  /** 仿真回合表情冷却（毫秒；读 emojiSystem.postSendCooldownMs） */
  getEmojiCooldownMs?(): number
  /** 下载图片为 base64（simGetMessageImages 用；SSRF/大小限制由实现负责） */
  fetchImageBase64?(url: string): Promise<{ mime: string; base64: string; error?: undefined } | { mime?: undefined; base64?: undefined; error: string }>
  now?(): number
  random?(): number
}

export interface SimulationRuntime {
  isCapture(e: { group_id?: string | number; message_type?: string }): boolean
  ingest(e: SimIngestEvent): Promise<boolean>
  start(): Promise<void>
  stop(): void
  sweepOnce(): Promise<void>
  enableGroup(groupId: string): Promise<string>
  disableGroup(groupId: string): Promise<string>
  groupStatus(groupId: string): Promise<string>
  resetGroup(groupId: string): Promise<string>
  listMemories(groupId: string): Promise<string>
  listAffinity(groupId: string, askerId?: string): Promise<string>
  ingestPoke(e: { group_id?: string | number; user_id?: string | number; self_id?: string | number; target_id?: string | number }): Promise<boolean>
  /** 控制台总览：全部生效群的状态列表 */
  overview(): Promise<Record<string, unknown>>
  describeGroup(groupId: string): Promise<Record<string, unknown>>
  getInitialPrompt(groupId: string): Promise<string>
  setInitialPrompt(groupId: string, text: string): Promise<string>
}

export interface SimIngestEvent {
  group_id?: string | number
  user_id?: string | number
  self_id?: string | number
  bot?: { uin?: string | number; nickname?: string }
  message_id?: string | number
  msg?: string
  raw_message?: string
  at?: boolean | unknown
  time?: number
  message?: { type?: string }[]
  sender?: { user_id?: string | number; nickname?: string; card?: string }
  source?: { user_id?: string | number; nickname?: string; card?: string; text?: unknown; message?: unknown }
}

interface PendingWake { timer: ReturnType<typeof setTimeout>; reason: SimWakeReason }

function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function safeText(resolve: () => string | undefined): string {
  try { return String(resolve() || '') } catch { return '' }
}

/** 额外工具 e.reply 的负载归一：字符串→文本段；单个段对象/段数组原样透传。 */
function normalizeReplyPayload(payload: unknown): unknown[] {
  if (typeof payload === 'string') return [{ type: 'text', data: { text: payload } }]
  if (Array.isArray(payload)) return payload
  if (payload && typeof payload === 'object' && typeof (payload as { type?: unknown }).type === 'string') return [payload]
  return [{ type: 'text', data: { text: String(payload ?? '') } }]
}

export function createSimulationRuntime(ports: SimulationRuntimePorts): SimulationRuntime {
  const { logger } = ports
  const now = ports.now ?? Date.now
  const random = ports.random ?? Math.random
  const store: SimSessionStore = createSimSessionStore({ redis: ports.redis, logger, now })

  function safeNumber(resolve: () => number | undefined): number {
    try { return Number(resolve() || 0) || 0 } catch { return 0 }
  }

  function parseSimImages(resultText: string): { mime: string; base64: string }[] {
    try {
      const parsed = JSON.parse(resultText) as { images?: { mime?: string; base64?: string }[] }
      return (parsed?.images || []).filter((image): image is { mime: string; base64: string } => Boolean(image?.mime && image?.base64)).slice(0, 2)
    } catch { return [] }
  }

  /** 工具执行统一包装：事件含 reply 绑定（文本段/段数组归一 + message_id 回执） */
  async function runSimTool(tool: { name?: string; execute(args: Record<string, unknown>, event: unknown): Promise<unknown> }, args: Record<string, unknown>, groupId: string, selfId: string): Promise<string> {
    try {
      const result = await tool.execute(args, {
        group_id: Number(groupId),
        self_id: selfId,
        simulation: true,
        reply: (payload: unknown) => ports.sendGroupMessage(groupId, normalizeReplyPayload(payload)).then(receipt => {
          if (!receipt.ok) throw new Error(receipt.error || '发送失败')
          return { message_id: receipt.messageId ?? '', data: { message_id: receipt.messageId ?? '' } }
        }),
      })
      return typeof result === 'string' ? result : JSON.stringify(result)
    } catch (error) {
      return `error: 工具 ${tool.name || ''} 执行失败: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  const running = new Set<string>()
  const pendingWakes = new Map<string, PendingWake>()
  const retryTimers = new Map<string, PendingWake>()
  /** 回合进行中的群 → 共享内存状态。回合期间 ingest 直接改这份对象，避免双写者互覆。 */
  const liveStates = new Map<string, SimSessionState>()
  /** wait 实现：群 → 待踢醒的 resolver（新消息到达即全部触发重新判定） */
  const waiters = new Map<string, Set<() => void>>()
  /** 仿真回合表情冷却：群 → 上次成功发表情时间 */
  const emojiLastSentAt = new Map<string, number>()
  /** 戳人频率护栏：群 → 历史戳的时间戳（每小时上限 6 次，防骚扰） */
  const pokeTimes = new Map<string, number[]>()
  let sweeper: ReturnType<typeof setInterval> | null = null
  let overridesCache: SimGroupOverrides | null = null
  let overridesLoadedAt = 0
  let knownGroupsCache: string[] = []

  function runtimeConfig(): SimRuntimeConfig { return defaultSimRuntimeConfig(ports.getSection()) }

  /**
   * 群覆盖状态（.仿真 开/关 写 Redis）：60s 缓存 + 强制刷新。
   * 首次运行（从未写过覆盖）时把 yaml simulation.groups 种子进显式启用清单。
   */
  async function refreshGroupState(force = false): Promise<void> {
    if (!force && overridesCache && now() - overridesLoadedAt <= 60_000) return
    let overrides = await store.loadOverrides()
    if (overrides === null) {
      const section = ports.getSection()
      const seeded = Array.isArray(section.groups) ? section.groups.map(g => String(g)) : []
      overrides = { explicitEnabled: seeded, disabled: [] }
      await store.saveOverrides(overrides)
    }
    overridesCache = overrides
    knownGroupsCache = await store.loadKnownGroups()
    overridesLoadedAt = now()
  }

  /** 群是否处于仿真模式：enabled 总开关 → 显式退出优先 → allGroups 默认全开 / 显式清单。 */
  function groupActive(cfg: SimRuntimeConfig, groupId: string): boolean {
    if (!cfg.enabled || !overridesCache) return false
    if (overridesCache.disabled.includes(groupId)) return false
    if (cfg.allGroups) return true
    return overridesCache.explicitEnabled.includes(groupId)
  }

  function notifyWaiters(groupId: string) {
    const set = waiters.get(groupId)
    if (!set) return
    for (const wake of [...set]) { try { wake() } catch { /* resolver 自防 */ } }
  }

  function isCapture(e: { group_id?: string | number; message_type?: string }): boolean {
    if (String(e.message_type || 'group') !== 'group') return false
    if (!e.group_id) return false
    // 启动未完成（覆盖未加载）前先走原链路，首个 sweep/ingest 后生效
    return groupActive(runtimeConfig(), String(e.group_id))
  }

  /** 白名单放通的既有工具（simulation.extraTools）：装配期合并进仿真回合工具面 */
  function resolveExtraTools(names: string[]): AbstractTool[] {
    if (!names.length || typeof ports.getExtraTools !== 'function') return []
    try {
      return ports.getExtraTools(names)
    } catch {
      return []
    }
  }

  /** 入站图片 URL 提取（≤2 条，仅 http(s)），供 simGetMessageImages 取图 */
  function extractImageUrls(e: SimIngestEvent): string[] {
    const segments = (e as { message?: { type?: string; url?: unknown }[] }).message || []
    const urls: string[] = []
    for (const seg of segments) {
      if (seg?.type !== 'image' && seg?.type !== 'mface') continue
      const url = String((seg as { url?: unknown }).url || (seg as { data?: { url?: unknown } }).data?.url || '')
      if (/^https?:\/\//.test(url) && url.length <= 1024) urls.push(url)
      if (urls.length >= 2) break
    }
    return urls
  }

  /** 引用解析：被引用人 + 原文截断（qq-bridge 的"判断对谁说"关键信号；引用自己仍由 quoteToSelf 表达） */
  function extractQuote(e: SimIngestEvent, selfId: string): { author: string; text: string; isSelf: boolean } | null {
    const source = e.source
    if (!source?.user_id) return null
    const isSelf = String(source.user_id) === selfId
    if (isSelf) return { author: '', text: '', isSelf: true }
    const author = String(source.card || source.nickname || `群友${String(source.user_id).slice(-4)}`)
    let text = ''
    if (typeof source.text === 'string') text = source.text
    else if (Array.isArray(source.message)) {
      text = (source.message as { type?: string; data?: { text?: unknown } }[])
        .filter(seg => seg?.type === 'text')
        .map(seg => String(seg.data?.text ?? ''))
        .join('')
    }
    text = text.replace(/\s+/g, ' ').trim().slice(0, 60)
    return { author, text, isSelf: false }
  }

  /** 合并转发 id（Yunzai 转发段） */
  function extractForwardId(e: SimIngestEvent): string {
    const segments = (e as { message?: { type?: string; data?: { id?: unknown; resid?: unknown } }[] }).message || []
    for (const seg of segments) {
      if (seg?.type !== 'forward') continue
      const id = String((seg as { data?: { id?: unknown } }).data?.id || (seg as { data?: { resid?: unknown } }).data?.resid || '')
      if (id) return id.slice(0, 64)
    }
    return ''
  }

  /** @ 了别的具体成员（非机器人）：延续触发的排除条件 */
  function extractAtOther(e: SimIngestEvent, selfId: string): boolean {
    const segments = (e as { message?: { type?: string; data?: { qq?: unknown } }[] }).message || []
    for (const seg of segments) {
      if (seg?.type !== 'at') continue
      const qq = String((seg as { data?: { qq?: unknown } }).data?.qq || '')
      if (qq && qq !== 'all' && qq !== selfId) return true
    }
    return false
  }

  /** 会话延续：登记对话对象（≤5，最近优先）并刷新活跃窗口 */
  function markConversationEngaged(state: SimSessionState, userId: string, windowMs: number): void {
    if (!userId) return
    const nowAt = now()
    state.conversation.activeUntil = Math.max(state.conversation.activeUntil, nowAt + windowMs)
    state.conversation.interlocutorIds = [userId, ...state.conversation.interlocutorIds.filter(id => id !== userId)].slice(0, 5)
    state.conversation.lastTriggerUserId = userId
  }

  async function ingest(e: SimIngestEvent): Promise<boolean> {
    const groupId = String(e.group_id || '')
    if (!groupId) return false
    await refreshGroupState()
    if (!isCapture(e)) return false
    void store.addKnownGroup(groupId).catch(() => { /* 登记失败不影响本条消息 */ })
    const self = ports.getSelf(e.self_id ?? e.bot?.uin)
    const userId = String(e.user_id || '')
    if (userId && userId === self.id) return true
    const text = String(e.msg || e.raw_message || '').trim()
    const images = (e.message || []).filter(seg => seg?.type === 'image' || seg?.type === 'mface').length
    if (!text && images === 0) return true
    if (text && /^[#./\\]/.test(text)) return true // 命令前缀不入会话流

    const cfg = runtimeConfig()
    const live = liveStates.get(groupId)
    const state = live ?? await store.load(groupId)
    state.seq += 1
    const imageUrls = extractImageUrls(e)
    const atOther = extractAtOther(e, self.id)
    const quote = extractQuote(e, self.id)
    const forwardId = extractForwardId(e)
    const message: SimMessage = {
      seq: state.seq,
      messageId: e.message_id ?? null,
      userId,
      name: String(e.sender?.card || e.sender?.nickname || userId || '群友'),
      text: text.slice(0, cfg.turn.messageTextMaxChars),
      at: e.time && Number(e.time) > 0 ? Number(e.time) * 1000 : now(),
      atSelf: e.at === true,
      ...(atOther ? { atOther: true } : {}),
      quoteToSelf: !!e.source?.user_id && String(e.source.user_id) === self.id,
      ...(quote && !quote.isSelf ? { quoteAuthor: quote.author, quoteText: quote.text } : {}),
      ...(forwardId ? { forwardId } : {}),
      imageCount: images,
      ...(imageUrls.length ? { imageUrls } : {}),
      kind: 'text',
    }
    state.unread.push(message)
    if (state.unread.length > cfg.turn.unreadLimit) state.unread = state.unread.slice(-cfg.turn.unreadLimit)
    state.recent.push(message)
    if (state.recent.length > SIM_RECENT_LIMIT) state.recent = state.recent.slice(-SIM_RECENT_LIMIT)
    state.lastIncomingAt = message.at
    resetPreSleepWait(state)

    let reason: SimWakeReason | null = null
    if (!state.bootstrapSent) {
      reason = { kind: 'bootstrap' }
      state.bootstrapSent = true
    } else {
      reason = evaluateWakeTrigger(message, state.wakeConfig, { selfId: self.id, selfName: self.name, random, conversation: state.conversation })
    }
    const busy = running.has(groupId) || live !== undefined
    if (busy && reason) {
      state.pendingWakeReasons = pushPendingReason(state.pendingWakeReasons, reason)
      reason = null
    }
    // 任何触发命中都视为"机器人在和这个人对话"：登记对话对象并刷新延续窗口
    if (reason) markConversationEngaged(state, message.userId, cfg.wake.continuationWindowMs)
    await store.save(groupId, state)
    notifyWaiters(groupId)
    if (reason) await scheduleWake(groupId, reason, cfg)
    return true
  }

  async function scheduleWake(groupId: string, reason: SimWakeReason, cfg?: SimRuntimeConfig) {
    const config = cfg ?? runtimeConfig()
    if (running.has(groupId)) {
      const live = liveStates.get(groupId)
      if (live) {
        live.pendingWakeReasons = pushPendingReason(live.pendingWakeReasons, reason)
        await store.save(groupId, live)
      }
      return
    }
    const existing = pendingWakes.get(groupId)
    if (existing) {
      const merged = mergeWakeReason(existing.reason, reason)
      if (merged.changed) pendingWakes.set(groupId, { timer: existing.timer, reason: merged.reason })
      return
    }
    // 定时器类唤醒到点即醒（不再等合并窗），消息类按 batchWindowMs 合并可能更高优先级的触发
    const delay = TIMER_WAKE_REASONS.includes(reason.kind) ? 1_000 : config.wake.batchWindowMs
    const timer = setTimeout(() => {
      pendingWakes.delete(groupId)
      void startTurn(groupId, reason)
    }, delay)
    pendingWakes.set(groupId, { timer, reason })
  }

  async function startTurn(groupId: string, reason: SimWakeReason): Promise<void> {
    if (running.has(groupId)) return
    running.add(groupId)
    const startedAt = now()
    let toolCalls = 0
    let sends = 0
    let tokens = 0
    let state: SimSessionState | null = null
    try {
      await store.markBusy(groupId)
      const cfg = runtimeConfig()
      const self = ports.getSelf()
      state = await store.load(groupId)
      liveStates.set(groupId, state)
      rollBudgetDay(state, now())
      const todayCost = safeNumber(() => ports.getTodaySpendCny?.(groupId))
      const verdict = checkWakeBudget(state, cfg, now(), todayCost)
      if (!verdict.allowed) {
        // 限频类延后重试（丢弃会让 timeout 唤醒停在无定时器静默态）；预算类今日不再试
        if (!verdict.reason.startsWith('dailyTurns')) {
          if (!retryTimers.has(groupId)) {
            const timer = setTimeout(() => {
              retryTimers.delete(groupId)
              void startTurn(groupId, reason)
            }, 60_000)
            retryTimers.set(groupId, { timer, reason })
          }
        } else {
          logger.warn(`[仿真] 群 ${groupId} 唤醒被预算拦截：${verdict.reason}（今日剩余唤醒不再重试）`)
        }
        return
      }
      recordWake(state, now())
      state.lastWakeReason = reason

      const snapshot = buildWakeSnapshot(state, { limit: cfg.turn.wakeMessageLimit, maxChars: cfg.turn.wakeMaxChars, now: now() })
      const snapshotSeqs = [...state.unread].sort((a, b) => a.seq - b.seq).slice(0, snapshot.included).map(m => m.seq)
      noteModelSeen(state, snapshotSeqs)
      // agent 长期记忆/好感度/近期动态装配（.仿真 重置不清这些）
      const memories = normalizeMemoryList(await store.loadMemories(groupId), now())
      const affinityRaw = await store.loadAffinity(groupId)
      const affinity: SimAffinityMap = {}
      for (const [userId, value] of Object.entries(affinityRaw)) {
        const entry = value && typeof value === 'object' && !Array.isArray(value) ? value as Partial<SimAffinityEntry> : {}
        affinity[userId] = {
          score: Math.max(0, Math.min(100, Math.floor(Number(entry.score ?? 50)))),
          updatedAt: Number(entry.updatedAt) || now(),
          today: String(entry.today || ''),
          todayDelta: Math.floor(Number(entry.todayDelta) || 0),
          reasons: Array.isArray(entry.reasons) ? entry.reasons.map(String).slice(0, 8) : [],
        }
      }
      const session = state
      const nameOf = (userId: string) => session.recent.find(m => m.userId === userId)?.name
        || session.unread.find(m => m.userId === userId)?.name
        || memories.find(m => m.aboutUser === userId)?.content.split('说')[0]?.slice(0, 12)
        || `群友${userId.slice(-4)}`
      const speakers = [...new Set([...session.unread, ...session.recent].map(m => m.userId))]
      // 初始提示词只在 bootstrap 唤醒注入一次（bootstrapSent 在 ingest 时已置位，不能作为这里的判据）
      const initialPrompt = reason.kind === 'bootstrap' ? await store.getInitPrompt(groupId) : ''
      const styleDigest = await (async () => { try { return String((await ports.getStyleDigest?.(groupId)) || '') } catch { return '' } })()
      const userStyle = (await store.loadUserStyle(groupId).catch(() => ({ users: {} as Record<string, string[]>, updatedAt: 0 }))).users || {}
      const wakePrompt = buildWakePrompt({
        state, reason, snapshotText: snapshot.text, unreadTotal: snapshot.unreadTotal, now: now(), selfName: self.name,
        ...(initialPrompt ? { initialPrompt } : {}),
        memories, affinity, speakers, nameOf,
        userCatchphrases: (userId: string) => userStyle[userId],
        groupDigest: safeText(() => ports.getGroupDigest?.(groupId)),
        episodesText: safeText(() => ports.getRecentEpisodesText?.(groupId)),
        styleDigest,
      })
      state.agentHistory.push({ role: 'user', content: wakePrompt })
      await store.save(groupId, state)

      const persona = ports.getPersona(groupId, self.id)
      const extraTools = resolveExtraTools(cfg.extraTools)
      const systemPrompt = buildSimSystemPrompt({ persona: persona.persona, systemContent: persona.systemContent, selfName: self.name, hasExtraTools: extraTools.length > 0, extraToolNames: cfg.extraTools, hasEmojiTool: cfg.extraTools.includes('sendLocalEmojiTool') })

      const memoryBox = { list: memories, sentTexts: [] as string[] }
      const ctx = buildToolContext(groupId, state, cfg, delta => { sends += delta }, memoryBox, { map: affinity })
      const tools = [...createSimTools(ctx), ...extraTools]
      const toolFunctions = simToolsAsFunctions(tools)
      const executionConfig = ports.getExecutionConfig()
      const providerConfig = record(executionConfig) as Parameters<typeof buildChatRequestData>[0]

      const history: SimHistoryMessage[] = state.agentHistory.map(m => ({ ...m }))
      type RawToolCall = NonNullable<SimHistoryMessage['tool_calls']>[number]
      let rounds = 0
      // 未外发文本兜底（实测事故：模型按聊天习惯把要说的话写在最终文本里——本模式不外发，群里只剩它调的表情工具）
      let nudgedForUnsent = false
      while (rounds < cfg.turn.maxToolRounds) {
        rounds += 1
        const requestData = buildChatRequestData(providerConfig, [{ role: 'system', content: systemPrompt }, ...history], toolFunctions)
        let response: ChatResponse
        try {
          response = await ports.YTapi(requestData, executionConfig)
        } catch (error) {
          logger.error(`[仿真] 群 ${groupId} 模型调用失败`, error)
          break
        }
        tokens += Number(record(response.usage).total_tokens) || 0
        try {
          ports.recordTokens?.({ scope: groupId, stage: 'sim', model: String((response as { model?: unknown }).model || ''), usage: record(response.usage), ms: 0 })
        } catch { /* 账本不可用不影响回合 */ }
        const message = record(record((response as { choices?: { message?: unknown }[] }).choices?.[0])?.message)
        const toolCallsRaw: RawToolCall[] = Array.isArray(message.tool_calls) ? message.tool_calls as RawToolCall[] : []
        if (!toolCallsRaw.length) {
          const text = String(message.content || '').trim()
          // reserved2 语义：模型文本永不外发，只留在回合记忆里（外发只能走 simSendMessage）
          if (text) history.push({ role: 'assistant', content: text })
          // 兜底：写了像"要说的话"的文本但本回合一条都没发过 → 提醒一次（模型惯性问题，实测高发）
          if (text.length >= 6 && sends === 0 && !nudgedForUnsent && !/^\[(?:不发了|SILENT|沉默)\]$/.test(text)) {
            nudgedForUnsent = true
            logger.info(`[仿真] 群 ${groupId} 检测到未外发文本（${text.length} 字，本回合 0 发送），已提醒模型用 simSendMessage 发出`)
            history.push({ role: 'user', content: '【系统提醒】你刚才写的这段话群友看不到——本模式下只有 simSendMessage 发出的内容才会出现在群里，群里刚才只能看到你发的表情/动作。如果那段话就是你想说的，现在用 simSendMessage 原样（或更口语化、可拆几条）发出去；如果改变主意不想说了，直接结束回合，不要再输出纯文本。' })
            continue
          }
          break
        }
        history.push({ role: 'assistant', content: String(message.content || ''), tool_calls: toolCallsRaw })
        for (const call of toolCallsRaw) {
          toolCalls += 1
          const callRecord = record(call)
          const fn = record(callRecord.function)
          const name = String(fn.name || '')
          const tool = tools.find(t => t.name === name)
          let resultText: string
          if (!tool) {
            resultText = `error: 未知工具 ${name}`
          } else {
            let args: Record<string, unknown>
            try { args = record(JSON.parse(String(fn.arguments || '{}'))) } catch { args = {} }
            if (name === 'sendLocalEmojiTool') {
              // 仿真回合表情冷却：跨回合短冷却防刷屏（与主链路 postSendCooldownMs 同参）
              const cooldownMs = safeNumber(() => ports.getEmojiCooldownMs?.()) || 90_000
              const lastAt = emojiLastSentAt.get(groupId) || 0
              if (now() - lastAt < cooldownMs) {
                const waitSec = Math.ceil((cooldownMs - (now() - lastAt)) / 1000)
                resultText = `error: 表情包冷却中（还要 ${waitSec} 秒）。请直接用文字回应，本回合不要再发表情。`
              } else {
                resultText = await runSimTool(tool, args, groupId, self.id)
                if (!(typeof resultText === 'string' && resultText.startsWith('error:'))) emojiLastSentAt.set(groupId, now())
              }
            } else {
              resultText = await runSimTool(tool, args, groupId, self.id)
            }
          }
          // simGetMessageImages 的结果带回图片：tool 结果之后追加视觉消息，让模型真的"看到图"
          if (name === 'simGetMessageImages' && !resultText.startsWith('error:')) {
            const images = parseSimImages(resultText)
            if (images.length) {
              history.push({ role: 'tool', tool_call_id: String(callRecord.id || ''), name, content: '已把图片附在本条消息下方。' })
              let seqLabel = ''
              try { seqLabel = String(record(JSON.parse(resultText)).seq ?? '') } catch { /* 忽略 */ }
              history.push({ role: 'user', content: [{ type: 'text', text: `【消息 ${seqLabel} 的图片】` }, ...images.map(image => ({ type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.base64}` } }))] })
              continue
            }
          }
          history.push({ role: 'tool', tool_call_id: String(callRecord.id || ''), name, content: resultText.slice(0, 4000) })
        }
      }

      recordWakeTokens(state, tokens)
      state.agentHistory = trimAgentHistory(history, cfg.turn.historyMaxMessages, cfg.turn.historyMaxChars)
      if (sends > 0) {
        const lastSent = memoryBox.sentTexts[memoryBox.sentTexts.length - 1] || ''
        // 亲近档（≥81）对话对象说话后更快回查有没有回应
        const interlocutorScore = Number(affinity[state.conversation.lastTriggerUserId || '']?.score ?? 50)
        const affinityBoost = interlocutorScore >= 81 ? 0.87 : 1
        const multiplier = Math.min(2, (/[?？]/.test(lastSent) ? 1.5 : 1) * (sends >= 3 ? 1.3 : 1) * affinityBoost)
        state.nextReplyCheckAt = now() + Math.floor(cfg.wake.replyCheckMs * multiplier)
      }
      // 仿真群不走主链路，情节记忆在这里补记：让"这两天做过什么"持续有料
      if (sends > 0) {
        try {
          const trigger = [...state.unread][0] ?? [...state.recent].slice(-1)[0]
          const replyText = memoryBox.sentTexts.slice(0, 2).join(' / ').slice(0, 200)
          if (replyText) {
            ports.recordEpisode?.({
              groupId,
              ...(trigger?.userId ? { userId: trigger.userId, userName: trigger.name } : {}),
              summary: trigger ? `${trigger.name}说：${trigger.text}`.slice(0, 120) : `主动行动（${reason.kind}）`,
              reply: replyText,
            })
          }
        } catch { /* 情节补记失败不影响回合 */ }
      }
      // 回合结束：补发忙碌期间的触发（消息类只有未读里还找得到才补；定时器类无条件补）
      const replay: SimWakeReason[] = []
      for (const pending of state.pendingWakeReasons) {
        if (messageReasonStillPending(pending, state.unread)) replay.push(pending)
      }
      state.pendingWakeReasons = []
      await store.save(groupId, state)
      logger.info(`[仿真] 群 ${groupId} 回合完成 wake=${reason.kind} rounds=${rounds} toolCalls=${toolCalls} sends=${sends} tokens=${tokens} ms=${now() - startedAt}`)
      for (const pending of replay.slice(0, 1)) await scheduleWake(groupId, pending, cfg)
    } catch (error) {
      logger.error(`[仿真] 群 ${groupId} 回合异常`, error)
    } finally {
      running.delete(groupId)
      liveStates.delete(groupId)
      void store.clearBusy(groupId)
    }
  }

  function buildToolContext(groupId: string, state: SimSessionState, cfg: SimRuntimeConfig, addSends: (delta: number) => void, memoryBox: { list: SimMemoryEntry[]; sentTexts: string[] }, affinityBox: { map: SimAffinityMap }): SimToolContext {
    let sendsThisTurn = 0
    return {
      groupId,
      now,
      getState: () => state,
      mutate: async fn => {
        const value = fn(state)
        await store.save(groupId, state)
        return value
      },
      sendMessage: async (messages, opts): Promise<SimSendResult> => {
        const verdict = checkSendAllowance(state, cfg, now(), sendsThisTurn)
        if (!verdict.allowed) return { ok: false, error: verdict.reason }
        let sent = 0
        let memeBumped = false
        for (let i = 0; i < messages.length; i += 1) {
          // 出站脱敏与主链路同源（内部路径/堆栈/日志标签片段级脱敏；heavy 整条拦截）
          const redacted = redactInternalStatusLeaks(messages[i])
          if (redacted.heavy) {
            return { ok: false, error: `第 ${i + 1} 条包含大量内部状态特征已被安全策略拦截，请换一句自然的说法${sent > 0 ? `（前 ${sent} 条已发出）` : ''}` }
          }
          const segments: unknown[] = []
          if (i === 0 && opts.replyToMessageId !== undefined && opts.replyToMessageId !== null && opts.replyToMessageId !== '') {
            segments.push({ type: 'reply', data: { id: String(opts.replyToMessageId) } })
          }
          for (const userId of opts.atUserIds || []) segments.push({ type: 'at', data: { qq: String(userId) } })
          segments.push({ type: 'text', data: { text: redacted.text } })
          const receipt = await ports.sendGroupMessage(groupId, segments)
          if (!receipt.ok) {
            // 发送失败不刷新参与状态：没发出去的话不算说过话
            return { ok: false, error: `第 ${sent + 1} 条发送失败：${receipt.error || '网关错误'}${sent > 0 ? `（前 ${sent} 条已发出）` : ''}` }
          }
          sent += 1
          sendsThisTurn += 1
          addSends(1)
          markConversationEngaged(state, state.conversation.lastTriggerUserId || '', cfg.wake.continuationWindowMs)
          memoryBox.sentTexts.push(messages[i]!.slice(0, 100))
          // 梗使用强化：AI 发的话里用到了本群梗 → 该梗热度 +1（下次注入排位上升）
          if (bumpMemeUsage(memoryBox.list, messages[i]!, now()).length) memeBumped = true
          recordSend(state, now(), 1)
          state.lastAiSendAt = now()
          invalidatePreSleepWaitByParticipation(state)
          if (i < messages.length - 1) await sleep(cfg.turn.minSendGapMs + Math.floor(random() * 600))
        }
        await store.save(groupId, state)
        // 强化过的梗库必须落盘（发送路径只存会话状态，不存记忆库）
        if (memeBumped) await store.saveMemories(groupId, memoryBox.list)
        return { ok: true, sent }
      },
      waitForMessages: async (rawPlan: SimWaitPlan): Promise<SimWaitResult> => {
        const plan = normalizeWaitPlan(rawPlan, cfg.turn.waitQuietMaxMs, cfg.turn.waitTimeoutMaxMs)
        const baselineSeq = state.seq
        const baselineReadThrough = readThroughSeq(state)
        const startAt = now()
        const deadline = startAt + plan.timeoutMs
        for (;;) {
          const at = now()
          const arrived = state.unread.filter(m => m.seq > baselineSeq)
          const lastNewIncomingAt = arrived.length ? Math.max(...arrived.map(m => m.at)) : state.lastIncomingAt
          let done: boolean
          if (plan.purpose === 'reply') {
            done = at - Math.max(state.lastIncomingAt, 0) >= plan.quietMs
          } else {
            done = arrived.length >= plan.minNewMessages && at - Math.max(lastNewIncomingAt, 0) >= plan.minQuietAfterNewMs
          }
          if (done || at >= deadline) {
            const outcome = computeWaitOutcome(state, plan, arrived, at, lastNewIncomingAt, at >= deadline && !done)
            noteModelSeen(state, arrived.map(m => m.seq))
            if (outcome.countsAsObservation) markPreSleepSatisfied(state, at)
            await store.save(groupId, state)
            return {
              hint: outcome.hint,
              canSleepNow: outcome.canSleepNow,
              newMessagesText: arrived.map(m => compactSimMessage(m, at)).join('\n'),
              newCount: arrived.length,
              readThroughSeq: Math.max(baselineReadThrough, readThroughSeq(state)),
              partial: false,
            }
          }
          await waitForArrival(groupId, Math.min(500, Math.max(50, deadline - at)))
        }
      },
      applyWakeConfig: config => {
        state.wakeConfig = config
        void store.save(groupId, state)
      },
      sendsThisTurn: () => sendsThisTurn,
      maxSendItems: () => cfg.turn.maxSendsPerTurn,
      messageTextMaxChars: () => cfg.turn.messageTextMaxChars,
      getMemories: () => memoryBox.list,
      saveMemories: memories => { memoryBox.list = memories; void store.saveMemories(groupId, memories) },
      getAffinity: () => affinityBox.map,
      saveAffinity: map => { affinityBox.map = map; void store.saveAffinity(groupId, map) },
      pokeMember: async (userId: string) => {
        if (typeof ports.pokeMember !== 'function') return { ok: false, error: '戳一戳不可用' }
        if (!/^\d{1,12}$/.test(userId)) return { ok: false, error: 'userId 必须是 QQ 号' }
        const window = (pokeTimes.get(groupId) || []).filter(t => now() - t < 3600_000)
        if (window.length >= 6) return { ok: false, error: '本小时戳人次数已达上限（6），别把人戳烦了' }
        const receipt = await ports.pokeMember(groupId, userId)
        if (receipt.ok) { window.push(now()); pokeTimes.set(groupId, window) }
        return receipt
      },
      getGroupMembers: async () => {
        if (typeof ports.getGroupMembers !== 'function') return { error: '群成员查询不可用' }
        try {
          const members = await ports.getGroupMembers(groupId)
          const activeIds = new Set(state.recent.map(m => m.userId))
          const sorted = [...members].sort((a, b) => Number(activeIds.has(b.userId)) - Number(activeIds.has(a.userId)))
          return sorted.slice(0, 40).map(m => ({ userId: m.userId, nick: m.nick, active: activeIds.has(m.userId) }))
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) }
        }
      },
      getForward: async (forwardId: string) => {
        if (typeof ports.getForwardContent !== 'function') return { lines: [], error: '合并转发查看不可用' }
        const result = await ports.getForwardContent(String(forwardId || '').slice(0, 64))
        return { lines: result.lines || [], ...(result.error ? { error: result.error } : {}) }
      },
      collectSticker: async (seq: number) => {
        if (typeof ports.collectStickerImage !== 'function') return { ok: false, error: '收藏不可用' }
        const message = [...state.unread, ...state.recent].find(m => m.seq === seq)
        const url = message?.imageUrls?.[0]
        if (!url) return { ok: false, error: '这条消息没有可收藏的图片' }
        return await ports.collectStickerImage(groupId, url)
      },
      getMessageImages: async (seq: number) => {
        const message = [...state.unread, ...state.recent].find(m => m.seq === seq)
        if (!message) return { seq, images: [], error: '该消息不在近期缓冲里' }
        const urls = (message.imageUrls || []).slice(0, 2)
        if (!urls.length) return { seq, images: [], error: '这条消息没有可取的图片（或图片 URL 已过期）' }
        if (typeof ports.fetchImageBase64 !== 'function') return { seq, images: [], error: '图片读取不可用' }
        const images: { mime: string; base64: string }[] = []
        for (const url of urls) {
          try {
            const result = await ports.fetchImageBase64(url)
            if ('error' in result && result.error) continue
            if ('base64' in result && result.base64) images.push({ mime: result.mime, base64: result.base64 })
          } catch { /* 单张失败不影响其他 */ }
        }
        return images.length ? { seq, images } : { seq, images: [], error: '图片下载失败（URL 可能已过期）' }
      },
    }
  }

  function waitForArrival(groupId: string, timeoutMs: number): Promise<void> {
    return new Promise(resolve => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        const set = waiters.get(groupId)
        if (set) { set.delete(finish); if (!set.size) waiters.delete(groupId) }
        clearTimeout(timer)
        resolve()
      }
      let set = waiters.get(groupId)
      if (!set) { set = new Set(); waiters.set(groupId, set) }
      set.add(finish)
      const timer = setTimeout(finish, Math.max(20, timeoutMs))
    })
  }

  async function sweepOnce(): Promise<void> {
    await refreshGroupState(true)
    const cfg = runtimeConfig()
    // allGroups 模式下无法枚举白名单群，sweep 遍历「登记过的群」∩ 当前生效判定
    const groups = knownGroupsCache.filter(groupId => groupActive(cfg, groupId))
    for (const groupId of groups) {
      if (running.has(groupId) || pendingWakes.has(groupId) || retryTimers.has(groupId)) continue
      let state: SimSessionState
      try { state = await store.load(groupId) } catch (error) { logger.error(`[仿真] 群 ${groupId} sweep 读取失败`, error); continue }
      const at = now()
      const reasons: SimWakeReason[] = []
      if (state.wakeConfig.mode === 'active' && typeof state.wakeConfig.sleepUntil === 'number' && at >= state.wakeConfig.sleepUntil) {
        reasons.push({ kind: 'timeout' })
        const { mode: _mode, sleepUntil: _sleepUntil, ...rest } = state.wakeConfig
        state.wakeConfig = { ...rest, mode: 'diving' }
      }
      if (state.pendingWakeReasons.length) {
        const pending = state.pendingWakeReasons
        state.pendingWakeReasons = []
        for (const reason of pending) if (messageReasonStillPending(reason, state.unread)) reasons.push(reason)
      }
      if (state.nextReplyCheckAt && at >= state.nextReplyCheckAt) {
        state.nextReplyCheckAt = 0
        reasons.push({ kind: 'replyCheck' })
      }
      if (state.lastIncomingAt > 0 && at - state.lastIncomingAt >= cfg.wake.proactiveIdleMs && at >= state.nextProactiveCheckAt) {
        state.nextProactiveCheckAt = at + cfg.wake.proactiveCheckMinMs + Math.floor(random() * Math.max(1, cfg.wake.proactiveCheckMaxMs - cfg.wake.proactiveCheckMinMs))
        if (random() < cfg.wake.proactiveProbability) reasons.push({ kind: 'proactiveCheck' })
      }
      const saved = reasons.length > 0
      if (saved) {
        await store.save(groupId, state)
        const [first, ...rest] = reasons
        if (first) {
          const best = rest.reduce((acc, r) => mergeWakeReason(acc, r).reason, first)
          await scheduleWake(groupId, best, cfg)
        }
      }
      // 本群专属梗自动提取（独立于唤醒：不产生回合，只沉淀记忆）
      if (!saved && !running.has(groupId)) await maybeExtractMemes(groupId, state, cfg)
      // 按人挖口头禅（风格个性化）：冷却默认 6h，读归档 → 纯函数挖掘 → Redis
      if (!saved && !running.has(groupId)) await maybeMineUserStyle(groupId, cfg)
    }
  }

  /** 梗提取管线：冷却 + 游标之后的新消息达到阈值才调侧路小模型；合并入库后等下次唤醒注入。 */
  async function maybeExtractMemes(groupId: string, state: SimSessionState, cfg: SimRuntimeConfig): Promise<void> {
    if (!cfg.meme.enabled || typeof ports.memeExtract !== 'function') return
    const at = now()
    const cursor = state.memeCursor
    if (cursor && at - cursor.at < cfg.meme.extractCooldownMs) return
    const fresh = state.recent.filter(m => m.seq > (cursor?.seq ?? Math.max(0, state.seq - 40)))
    if (cursor && fresh.length < cfg.meme.extractMinMessages) return
    if (!cursor && state.recent.length < cfg.meme.extractMinMessages) return
    state.memeCursor = { seq: state.seq, at }
    await store.save(groupId, state)
    try {
      const extractStartedAt = now()
      const raw = await ports.memeExtract(fresh.slice(-40).map(m => ({ name: m.name, text: m.text })))
      try { ports.recordTokens?.({ scope: groupId, stage: 'meme-extract', ms: now() - extractStartedAt }) } catch { /* 账本不可用 */ }
      const candidates = parseMemeCandidates(raw)
      if (!candidates.length) return
      // 回合可能刚改过记忆库：重新加载合并，避免双写者互覆
      const current = normalizeMemoryList(await store.loadMemories(groupId), at)
      const { memories, newCount } = mergeMemeCandidates(current, candidates, at)
      await store.saveMemories(groupId, memories)
      if (newCount > 0) logger.info(`[仿真] 群 ${groupId} 梗库新增 ${newCount} 条（提取自 ${fresh.length} 条消息）`)
    } catch (error) {
      logger.warn(`[仿真] 群 ${groupId} 梗提取失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 按人口头禅挖掘：每群冷却（默认 6h），从归档挖"他说得多、别人基本不说"的专属词 */
  async function maybeMineUserStyle(groupId: string, cfg: SimRuntimeConfig): Promise<void> {
    if (!cfg.userStyle.enabled || typeof ports.readArchiveMessages !== 'function') return
    try {
      const current = await store.loadUserStyle(groupId)
      if (now() - current.updatedAt < cfg.userStyle.cooldownMs) return
      const messages = await ports.readArchiveMessages(groupId, cfg.userStyle.archiveDays)
      if (messages.length < 50) return
      const catchphrases = mineUserCatchphrases(messages)
      const users: Record<string, string[]> = {}
      for (const item of catchphrases) users[item.userId] = item.words
      await store.saveUserStyle(groupId, users)
      if (Object.keys(users).length) logger.info(`[仿真] 群 ${groupId} 口头禅库更新：${Object.keys(users).length} 人`)
    } catch (error) {
      logger.warn(`[仿真] 群 ${groupId} 口头禅挖掘失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function start() {
    if (sweeper) return
    await refreshGroupState(true)
    sweeper = setInterval(() => { void sweepOnce() }, SIM_SWEEP_INTERVAL_MS)
    sweeper.unref?.()
    const cfg = runtimeConfig()
    const scope = !cfg.enabled ? '总开关关闭，全部群走普通模式'
      : cfg.allGroups ? '默认全部白名单群（.仿真 关 可按群退出）'
        : `显式清单 ${(overridesCache?.explicitEnabled || []).join(',') || '空'}`
    logger.info(`[仿真] 自主仿真模式已就绪（sweep ${SIM_SWEEP_INTERVAL_MS / 1000}s）：${scope}`)
  }

  function stop() {
    if (sweeper) { clearInterval(sweeper); sweeper = null }
    for (const [, pending] of pendingWakes) clearTimeout(pending.timer)
    pendingWakes.clear()
    for (const [, pending] of retryTimers) clearTimeout(pending.timer)
    retryTimers.clear()
  }

  async function enableGroup(groupId: string): Promise<string> {
    await refreshGroupState(true)
    const cfg = runtimeConfig()
    const overrides = { explicitEnabled: [...(overridesCache?.explicitEnabled || [])], disabled: (overridesCache?.disabled || []).filter(g => g !== groupId) }
    if (!cfg.allGroups && !overrides.explicitEnabled.includes(groupId)) overrides.explicitEnabled.push(groupId)
    await store.saveOverrides(overrides)
    overridesCache = overrides
    return cfg.allGroups && !overrides.disabled.includes(groupId)
      ? `群 ${groupId} 确认处于仿真模式（当前默认全群开启，未单独退出过）`
      : `群 ${groupId} 已切换到仿真模式（下一条消息起生效）`
  }

  async function disableGroup(groupId: string): Promise<string> {
    await refreshGroupState(true)
    const overrides = {
      explicitEnabled: (overridesCache?.explicitEnabled || []).filter(g => g !== groupId),
      disabled: [...(overridesCache?.disabled || [])],
    }
    if (!overrides.disabled.includes(groupId)) overrides.disabled.push(groupId)
    await store.saveOverrides(overrides)
    overridesCache = overrides
    const pending = pendingWakes.get(groupId)
    if (pending) { clearTimeout(pending.timer); pendingWakes.delete(groupId) }
    return `群 ${groupId} 已切回普通模式（.仿真 开 可再切回）`
  }

  async function groupStatus(groupId: string): Promise<string> {
    await refreshGroupState(true)
    const cfg = runtimeConfig()
    const active = groupActive(cfg, groupId)
    const live = liveStates.get(groupId)
    const state = live ?? await store.load(groupId)
    return [
      `模式：${active ? '仿真（AI 自主收发）' : '普通'}${running.has(groupId) ? '（回合进行中）' : ''}`,
      `范围：${cfg.enabled ? (cfg.allGroups ? '默认全群开启，可按群 .仿真 关' : '仅显式清单') : '总开关关闭'}`,
      `唤醒配置：mode=${state.wakeConfig.mode}${state.wakeConfig.sleepUntil ? `（${Math.max(0, Math.ceil((state.wakeConfig.sleepUntil - now()) / 60_000))} 分钟后到期）` : ''}`,
      `触发器：${JSON.stringify(state.wakeConfig.triggers)}`,
      `水位：lastReadThrough=${state.lastReadThroughSeq} unread=${state.unread.length} recent=${state.recent.length}`,
      `今日：${state.budget.turns}/${cfg.turn.maxTurnsPerDay} 回合，${state.budget.tokens} tokens`,
      `最近唤醒：${state.lastWakeReason?.kind || '无'}（${state.lastWakeAt ? Math.round((now() - state.lastWakeAt) / 1000) + ' 秒前' : '从未'}）`,
      `最近发言：${state.lastAiSendAt ? Math.round((now() - state.lastAiSendAt) / 1000) + ' 秒前' : '未发言'}`,
      `回合历史：${state.agentHistory.length} 条`,
    ].join('\n')
  }

  async function resetGroup(groupId: string): Promise<string> {
    if (running.has(groupId)) return '该群有仿真回合正在进行，请稍后再重置'
    const cfg = runtimeConfig()
    await store.reset(groupId, cfg.agentPresetKeywords)
    return `群 ${groupId} 的仿真会话已重置（历史/水位/预算清空，启用状态保留；长期记忆与好感度不受影响）`
  }

  /** 戳一戳入流：被戳 = 一条 kind='poke' 消息 + triggers.poke 唤醒（qq-bridge 的拍一拍机制） */
  async function ingestPoke(e: { group_id?: string | number; user_id?: string | number; self_id?: string | number; target_id?: string | number; sender?: { nickname?: string; card?: string } }): Promise<boolean> {
    const groupId = String(e.group_id || '')
    if (!groupId) return false
    await refreshGroupState()
    const self = ports.getSelf(e.self_id)
    // 只处理戳到机器人的（OneBot notice: sub_type=poke, target_id=self）
    if (e.target_id !== undefined && String(e.target_id) !== self.id) return false
    if (!groupActive(runtimeConfig(), groupId)) return false
    void store.addKnownGroup(groupId).catch(() => {})
    const cfg = runtimeConfig()
    const live = liveStates.get(groupId)
    const state = live ?? await store.load(groupId)
    state.seq += 1
    const message: SimMessage = {
      seq: state.seq,
      messageId: null,
      userId: String(e.user_id || ''),
      name: String(e.sender?.card || e.sender?.nickname || e.user_id || '群友'),
      text: '（戳了戳你）',
      at: now(),
      atSelf: true,
      quoteToSelf: false,
      imageCount: 0,
      kind: 'poke',
    }
    state.unread.push(message)
    if (state.unread.length > cfg.turn.unreadLimit) state.unread = state.unread.slice(-cfg.turn.unreadLimit)
    state.recent.push(message)
    if (state.recent.length > SIM_RECENT_LIMIT) state.recent = state.recent.slice(-SIM_RECENT_LIMIT)
    state.lastIncomingAt = message.at
    resetPreSleepWait(state)
    let reason: SimWakeReason | null = state.wakeConfig.triggers.poke ? { kind: 'atMention', seq: message.seq } : null
    if ((running.has(groupId) || live !== undefined) && reason) {
      state.pendingWakeReasons = pushPendingReason(state.pendingWakeReasons, reason)
      reason = null
    }
    await store.save(groupId, state)
    notifyWaiters(groupId)
    if (reason) await scheduleWake(groupId, reason, cfg)
    return true
  }

  async function overview(): Promise<Record<string, unknown>> {
    await refreshGroupState(true)
    const cfg = runtimeConfig()
    const known = [...new Set([...knownGroupsCache])]
    const groups: Record<string, unknown>[] = []
    for (const groupId of known.slice(0, 60)) {
      try { groups.push(await describeGroup(groupId)) } catch { /* 单群失败不影响总览 */ }
    }
    return { enabled: cfg.enabled, allGroups: cfg.allGroups, disabled: overridesCache?.disabled || [], explicitEnabled: overridesCache?.explicitEnabled || [], budgetDefaultCny: cfg.budget.dailyCostCny, groups }
  }

  /** 控制台 JSON 视图 */
  async function describeGroup(groupId: string): Promise<Record<string, unknown>> {
    await refreshGroupState(true)
    const cfg = runtimeConfig()
    const state = await store.load(groupId)
    const memories = normalizeMemoryList(await store.loadMemories(groupId), now())
    const memes = memories.filter(m => m.kind === 'meme' && !m.done).sort((a, b) => (b.count || 1) - (a.count || 1)).slice(0, 10)
    const affinity = await store.loadAffinity(groupId)
    const affinityList = Object.entries(affinity)
      .map(([userId, value]) => ({ userId, score: Math.max(0, Math.min(100, Math.floor(Number(record(value).score ?? 50)))) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
    return {
      groupId,
      active: groupActive(cfg, groupId),
      running: running.has(groupId),
      enabled: cfg.enabled,
      allGroups: cfg.allGroups,
      mode: state.wakeConfig.mode,
      wakeConfig: state.wakeConfig,
      unreadCount: state.unread.length,
      recentCount: state.recent.length,
      lastReadThroughSeq: state.lastReadThroughSeq,
      budget: { ...state.budget, maxTurnsPerDay: cfg.turn.maxTurnsPerDay, dailyCostCny: cfg.budget.dailyCostCny, todayCostCny: safeNumber(() => ports.getTodaySpendCny?.(groupId)) },
      lastWakeReason: state.lastWakeReason?.kind || null,
      lastWakeAtAgo: state.lastWakeAt ? Math.round((now() - state.lastWakeAt) / 1000) : null,
      lastAiSendAtAgo: state.lastAiSendAt ? Math.round((now() - state.lastAiSendAt) / 1000) : null,
      historyLength: state.agentHistory.length,
      initialPrompt: await store.getInitPrompt(groupId),
      pendingEvents: memories.filter(m => m.kind === 'pendingEvent' && !m.done).slice(0, 10).map(m => ({ id: m.id, content: m.content, dueAt: m.dueAt })),
      memes: memes.map(m => ({ id: m.id, content: m.content, count: m.count || 1, origin: m.origin || '' })),
      affinity: affinityList,
    }
  }

  async function getInitialPrompt(groupId: string): Promise<string> {
    return await store.getInitPrompt(groupId)
  }

  async function setInitialPrompt(groupId: string, text: string): Promise<string> {
    await store.setInitPrompt(groupId, text)
    return text.trim() ? '初始提示词已保存（下次该群会话重置后的首次唤醒生效）' : '初始提示词已清空'
  }

  async function listMemories(groupId: string): Promise<string> {
    const memories = normalizeMemoryList(await store.loadMemories(groupId), now())
    const due = new Set(dueMemories(memories, now()).map(m => m.id))
    const lines = memories
      .filter(m => !m.done)
      .slice(-20)
      .reverse()
      .map(m => {
        const state = m.kind === 'pendingEvent' && m.dueAt
          ? (due.has(m.id) ? '【已到期】' : `【${Math.max(0, Math.round((m.dueAt - now()) / 60000))}分钟后】`)
          : m.kind === 'impression' ? '【印象】'
            : m.kind === 'meme' ? `【梗×${m.count || 1}】`
              : '【记事】'
        return `${state}${m.content}${m.aboutUser ? `（关于 ${m.aboutUser}）` : ''}${m.origin && m.kind === 'meme' ? `（${m.origin}）` : ''} [${m.id}]`
      })
    return lines.length ? `【仿真记忆 · 本群】\n${lines.join('\n')}` : '本群还没有仿真记忆。'
  }

  async function listAffinity(groupId: string, askerId?: string): Promise<string> {
    const raw = await store.loadAffinity(groupId)
    const entries = Object.entries(raw)
      .map(([userId, value]) => {
        const entry = record(value) as Partial<SimAffinityEntry>
        return { userId, score: Math.max(0, Math.min(100, Math.floor(Number(entry.score ?? 50)))), reasons: Array.isArray(entry.reasons) ? entry.reasons.map(String) : [] }
      })
      .sort((a, b) => b.score - a.score)
    if (!entries.length) return '本群还没有好感度记录（AI 会在互动中慢慢积累）。'
    const top = entries.slice(0, 8).map(e => `${e.userId}：${e.score}（${affinityLevel(e.score)}）`).join('\n')
    const mine = askerId ? entries.find(e => e.userId === String(askerId)) : undefined
    const mineLine = mine ? `\n\n你（${askerId}）：${mine.score}（${affinityLevel(mine.score)}）${mine.reasons[0] ? `，最近：${mine.reasons[0]}` : ''}` : ''
    return `【群友好感 · 前8】\n${top}${mineLine}`
  }

  return { isCapture, ingest, start, stop, sweepOnce, enableGroup, disableGroup, groupStatus, resetGroup, listMemories, listAffinity, ingestPoke, overview, describeGroup, getInitialPrompt, setInitialPrompt }
}
