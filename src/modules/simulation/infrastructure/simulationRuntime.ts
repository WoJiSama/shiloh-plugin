import type { ChatRequestData, ChatResponse } from '../../../contracts/modelGateway.js'
import type { PersonaText } from '../../conversation/domain/personaSource.js'
import type { SimAffinityEntry, SimAffinityMap, SimulationSection, SimHistoryMessage, SimMemoryEntry, SimMessage, SimMoodState, SimRuntimeConfig, SimSessionState, SimWakeReason } from '../../../contracts/simulation.js'
import { defaultSimRuntimeConfig } from '../domain/simConfig.js'
import { affinityLevel, buildMemeExtractionPrompt, bumpMemeUsage, defaultAffinityEntry, dueMemories, formatSelfMemorySection, mergeMemeCandidates, normalizeMemoryList, parseMemeCandidates } from '../domain/simMemory.js'
import { mineUserCatchphrases } from '../domain/userStyle.js'
import { boundedTimerDelay, safeSetTimeout, isDuplicateMessageId, sanitizeUntrustedText, safeToolErrorText, shouldSendErrorNotice } from '../domain/safety.js'
import { evaluateWakeTrigger, formatWakeReason, mergeWakeReason, messageReasonStillPending, pushPendingReason, TIMER_WAKE_REASONS } from '../domain/wakeTrigger.js'
import { resolveSimToolSurface } from '../domain/toolPolicy.js'
import { noteModelSeen, readThroughSeq } from '../domain/watermark.js'
import { buildWakeSnapshot, compactSimMessage } from '../domain/messageView.js'
import { computeWaitOutcome, normalizeWaitPlan, type SimWaitPlan } from '../domain/waitGate.js'
import { checkSendAllowance, checkWakeBudget, describeBudgetLimit, limitNoticeDue, shouldAnnounceBudgetLimit, invalidatePreSleepWaitByParticipation, markPreSleepSatisfied, recordSend, recordWake, recordWakeTokens, resetPreSleepWait, rollBudgetDay } from '../domain/budget.js'
import { buildSimSystemPrompt, buildWakePrompt, trimAgentHistory } from '../domain/promptBuilder.js'
import { isSilentDeclaration, mentionsSilenceVocabulary } from '../domain/silentDeclaration.js'
import { parsePersonProfilePatches, interestMatchesTitle, type PersonProfile } from '../domain/personProfile.js'
import { isSleeping, activityFactor, sleepinessNote, staleMessageNote, type RhythmWindow } from '../domain/rhythm.js'
import { normalizeLifeThreads, mergeThreadSync, formatLifeThreads, type LifeThread } from '../domain/lifeThread.js'
import { applyMoodUpdate, formatMoodSection, moodSummaryLine, normalizeSimMood, projectMood, type MoodAxis } from '../domain/mood.js'
import { checkHealth, formatAlerts, type HealthAlert } from '../domain/healthSentinel.js'
import { buildChatRequestData } from '../../models/domain/modelGateway.js'
import { createSimSessionStore, type SimGroupOverrides, type SimSessionStore } from './simSessionStore.js'
import type { AbstractTool } from '../../toolSupport/infrastructure/AbstractTool.js'
import { redactInternalStatusLeaks } from '../../conversation/domain/internalStatusLeak.js'
import { collectMentionTargetIds, messageMentionsUser } from '../../conversation/domain/mentionTargets.js'
import { normalizeDelegatedEntries, formatDelegatedSection } from '../../memory/domain/delegatedMemory.js'
import { createSimTools, simToolsAsFunctions, type SimSendResult, type SimWaitResult, type SimToolContext } from './simTools.js'

export const SIM_RECENT_LIMIT = 60
export const SIM_SWEEP_INTERVAL_MS = 30_000

/** 仅@才回模式下仍放行的唤醒：点名（@/引用）、一次性开场、被点名后的定时延伸（等待超时/回合补发）、管理指令、承诺到期（答应了的事必须兑现）。主动冒泡(proactiveCheck)不放行。 */
const AT_ONLY_WAKE_KINDS = new Set<SimWakeReason['kind']>(['atMention', 'bootstrap', 'timeout', 'replyCheck', 'admin', 'commitment'])

/**
 * 唤醒预判闸旁路：这些唤醒不经便宜模型预判、直达完整回合——
 * 被@/开场/管理天然高价值；session(活跃档)是管理员明确要的参与；timeout/replyCheck 是已参与回合的收尾延伸。
 */
const WAKE_GATE_BYPASS_KINDS = new Set<SimWakeReason['kind']>([...AT_ONLY_WAKE_KINDS, 'session'])

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
  /** B站卡片分享:按关键词或链接解析视频并生成 QQ 卡片 JSON(发送由 runtime 统一出站) */
  resolveBilibiliCard?(input: { query?: string; url?: string }): Promise<{ ok: boolean; error?: string; title?: string; cardJson?: string }>
  /** 视觉侧模型把图片转成文字描述（主模型纯文本时 simGetMessageImages 的看图走这里）；返回 null/空 表示描述不可用 */
  describeImages?(images: { mime: string; base64: string }[], context: { groupId: string; label: string }): Promise<string | null>
  /** 出站发送：segments 为 OneBot 消息段数组（经全局出站闸门）；成功时尽量带回 message_id 供回执校验 */
  sendGroupMessage(groupId: string, segments: unknown[]): Promise<{ ok: boolean; error?: string; messageId?: string | number }>
  getPersona(groupId: string, selfId: string): { persona: PersonaText; systemContent: string }
  /** 仿真回合额外放通的既有工具（toolPolicy 解析出的实际放通名清单；从 localToolRegistry 取实例） */
  getExtraTools?(names: string[]): import('../../toolSupport/infrastructure/AbstractTool.js').AbstractTool[]
  /** 注册表工具名清单（toolPolicy open 模式的默认能力面）；缺省时安全回落 legacy 白名单行为 */
  listRegistryToolNames?(): { builtIn: string[]; all: string[] }
  /** 本群近期主线摘要（中期记忆）；无则空串 */
  getGroupDigest?(groupId: string): string
  /** 近两天情节记忆文本（"这两天聊过/做过什么"）；无则空串 */
  getRecentEpisodesText?(groupId: string): string
  /** 委托记忆（群友托付记的事，原文锚定）；无/失败=空数组，绝不阻塞唤醒 */
  loadDelegatedMemories?(groupId: string): Promise<unknown[]> | unknown[]
  /** 长程语义召回（更早的相关聊天片段，来自语义记忆混合检索）；无/超时/失败=空串，绝不阻塞唤醒 */
  getSemanticRecall?(groupId: string, query: string): Promise<string>
  /** 说话风格参考（群级表达学习 + 全局表达学习的注入文本）；无则空串 */
  getStyleDigest?(groupId: string): Promise<string> | string
  /** 读归档消息（按人挖口头禅的数据源）：近 N 天该群消息（userId+text） */
  readArchiveMessages?(groupId: string, days: number): Promise<{ userId: string; text: string }[]>
  /** P0 反污染：风格学习要跳过的机器人 QQ（pluginSettings.botUserIds + 自家账号） */
  getStyleBotUserIds?(): string[]
  /** 戳群成员（B2：回应拍一拍/主动逗熟人） */
  pokeMember?(groupId: string, userId: string): Promise<{ ok: boolean; error?: string }>
  /** 唤醒预判闸：低信号唤醒先判断值不值得进完整回合；返回 null = 预判不可用（fail-open 放行） */
  wakeGateJudge?(input: { reason: string; messages: { name: string; text: string; atSelf: boolean }[] }): Promise<{ engage: boolean; reason?: string } | null>
  /** QQ空间互动：看指定成员的最近说说 / 点赞 / 评论（凭据由装配层处理；内容已在上层脱敏） */
  qzoneInteract?(input: { action: 'visit' | 'like' | 'comment'; userId?: string; tid?: string; text?: string }): Promise<{ ok: boolean; error?: string; feeds?: { tid: string; time: string; text: string; likes: number }[] }>
  /** 人物核心档案提取（侧路小模型）：近期消息 → 跨群身份级事实补丁 */
  personProfileExtract?(messages: { userId: string; name: string; text: string }[]): Promise<string>
  /** 生活线真实数据源：resolve 按 kind 用真实搜索定位（找不到返回 error，拒绝编造）；sync 拉取真实更新 */
  lifeThreadResolve?(input: { title: string }): Promise<{ ok: true; sourceId: string; title: string; episode?: number } | { ok: false; error: string }>
  lifeThreadSync?(input: { sourceId: string; title: string; lastEpisode?: number }): Promise<{ newNotes: string[]; episode?: number } | { error: string }>
  /** 群成员列表（B3）：[{userId, nick}] */
  getGroupMembers?(groupId: string): Promise<{ userId: string; nick: string }[]>
  /** 合并转发内容（B4）：逐条正文 + 图片 URL 列表（按 [图片#N] 编号）+ 内嵌转发 id 列表（可递归展开） */
  getForwardContent?(forwardId: string): Promise<{ lines: string[]; error?: string; total?: number; truncated?: boolean; nestedForwardIds?: string[]; imageUrls?: string[] }>
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
  /** 按群回复模式：atOnly=仅被@才回（消息照常入库），auto=自主，active=自主·活跃（持续活动按节奏主动跟进）；缺省=query 查询 */
  setGroupReplyMode(groupId: string, mode?: 'atOnly' | 'auto' | 'active' | 'query'): Promise<string>
  groupStatus(groupId: string): Promise<string>
  resetGroup(groupId: string): Promise<string>
  listMemories(groupId: string): Promise<string>
  listAffinity(groupId: string, askerId?: string): Promise<string>
  ingestPoke(e: { group_id?: string | number; user_id?: string | number; self_id?: string | number; target_id?: string | number }): Promise<boolean>
  /** A3 撤回处理：从 unread/recent 里移除已撤回的消息 */
  handleRecall(e: { group_id?: string | number; message_id?: string | number }): Promise<boolean>
  /** 承诺账本查询口：该群当前是否仿真生效（commitmentTool 创建 agent 类承诺前的闸） */
  isGroupActive(groupId: string): boolean
  /** 承诺账本兑现口：agent 类承诺到期唤醒仿真回合（timer 类 1s 直醒；群未生效则忽略） */
  wakeForCommitment(groupId: string, detail: string): Promise<void>
  /** 控制台总览：全部生效群的状态列表 */
  overview(): Promise<Record<string, unknown>>
  describeGroup(groupId: string): Promise<Record<string, unknown>>
  getInitialPrompt(groupId: string): Promise<string>
  setInitialPrompt(groupId: string, text: string): Promise<string>
  /** 控制台：设置/清除按群每日金额上限（-1=不限，0=清除回落，>0=上限） */
  setGroupBudget(groupId: string, cap: number): Promise<string>
  /** 控制台：设置/清除按群每日回合上限（-1=不限，0=清除回落，>0=上限） */
  setGroupTurnsCap(groupId: string, cap: number): Promise<string>
  /** 控制台：设置/清除全局默认每日金额上限（cny<=0 清除，回落 yaml） */
  setDefaultBudget(cny: number): Promise<string>
  /** 控制台「人物记忆」：列出/删除跨群人物档案（透明化与被遗忘权） */
  listPersonProfiles(): Promise<{ userId: string; name?: string; interests: string[]; taboos: string[]; traits?: string[]; facts?: string[]; globalAffinity?: number; updatedAt?: number }[]>
  deletePersonProfile(userId: string): Promise<boolean>
  deletePersonProfileField(userId: string, field: string, value?: string): Promise<unknown>
  /** 控制台「作息与生活」页：总览 + 修改作息 */
  lifeOverview(): Promise<{ rhythm: { sleepFrom: number; sleepTo: number; setBy?: string }; threads: unknown[]; now: { hour: number; sleeping: boolean } }>
  setLifeRhythm(from: number, to: number): Promise<string>
  /** 控制台：健康哨兵告警列表 */
  getHealthAlerts(): Promise<{ alerts: unknown[]; checkedAt: number }>
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
  /** TRSS-Yunzai 系适配器 @机器人时设 atBot；e.at 只在 @ 别人时才被赋值 */
  atBot?: boolean
  time?: number
  message?: { type?: string }[]
  sender?: { user_id?: string | number; nickname?: string; card?: string }
  source?: { user_id?: string | number; nickname?: string; card?: string; text?: unknown; message?: unknown }
}

interface PendingWake { timer: ReturnType<typeof setTimeout>; reason: SimWakeReason }

function sleep(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, boundedTimerDelay(ms))) }
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

  function parseSimImages(resultText: string, max = 2): { mime: string; base64: string }[] {
    try {
      const parsed = JSON.parse(resultText) as { images?: { mime?: string; base64?: string }[] }
      return (parsed?.images || []).filter((image): image is { mime: string; base64: string } => Boolean(image?.mime && image?.base64)).slice(0, Math.max(1, max))
    } catch { return [] }
  }

  /** 工具执行统一包装：事件含 reply 绑定（文本段/段数组归一 + message_id 回执） */
  async function runSimTool(tool: { name?: string; execute(args: Record<string, unknown>, event: unknown): Promise<unknown> }, args: Record<string, unknown>, groupId: string, selfId: string, triggerUser?: { id: string; name: string } | null): Promise<string> {
    try {
      const result = await tool.execute(args, {
        group_id: Number(groupId),
        self_id: selfId,
        ...(triggerUser?.id ? { user_id: /^\d+$/.test(triggerUser.id) ? Number(triggerUser.id) : triggerUser.id, sender: { user_id: /^\d+$/.test(triggerUser.id) ? Number(triggerUser.id) : triggerUser.id, nickname: triggerUser.name || '' } } : {}),
        simulation: true,
        reply: (payload: unknown) => ports.sendGroupMessage(groupId, normalizeReplyPayload(payload)).then(receipt => {
          if (!receipt.ok) throw new Error(receipt.error || '发送失败')
          return { message_id: receipt.messageId ?? '', data: { message_id: receipt.messageId ?? '' } }
        }),
      })
      return typeof result === 'string' ? result : JSON.stringify(result)
    } catch (error) {
      return safeToolErrorText(String(tool.name || ''), error)
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
  // 每日限额触发时的群内提示:同群 30 分钟最多一条,避免刷屏
  const limitNoticeAt = new Map<string, number>()
  // B站卡片分享冷却:同群 20 分钟一张,保持「偶尔甩一张」的克制感
  const videoCardAt = new Map<string, number>()
  let overridesLoadedAt = 0
  let healthSentinelLastRun = 0
  let knownGroupsCache: string[] = []

  function runtimeConfig(): SimRuntimeConfig {
    const cfg = defaultSimRuntimeConfig(ports.getSection())
    // 控制台/.仿真 写的 redis 覆盖优先于 yaml：按群上限 → 默认上限
    if (overridesCache) {
      const caps = { ...cfg.budget.groups }
      for (const [groupId, cap] of Object.entries(overridesCache.budgetCaps || {})) if (Number(cap) === -1 || Number(cap) > 0) caps[groupId] = Number(cap)
      const turnCaps = { ...cfg.turn.groups }
      for (const [groupId, cap] of Object.entries(overridesCache.turnCaps || {})) if (Number(cap) === -1 || Number(cap) > 0) turnCaps[groupId] = Number(cap)
      const defaultOverride = Number(overridesCache.budgetDefaultCny)
      cfg.budget = { ...cfg.budget, groups: caps, ...(Number.isFinite(defaultOverride) && defaultOverride > 0 ? { dailyCostCny: defaultOverride } : {}) }
      cfg.turn = { ...cfg.turn, groups: turnCaps }
    }
    return cfg
  }

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
      overrides = { explicitEnabled: seeded, disabled: [], budgetCaps: {}, turnCaps: {} }
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

  /** 承诺账本查询口：该群当前是否仿真生效（commitmentTool 创建 agent 类承诺前的闸） */
  function isSimulationGroup(groupId: string): boolean {
    return groupActive(runtimeConfig(), String(groupId || ''))
  }

  /** 承诺账本兑现口：agent 类承诺到期由 commitmentTick 调这里唤醒仿真回合（timer 类 1s 直醒） */
  async function wakeForCommitment(groupId: string, detail: string): Promise<void> {
    const gid = String(groupId || '')
    if (!gid) return
    const cfg = runtimeConfig()
    if (!groupActive(cfg, gid)) return
    await refreshGroupState(false).catch(() => {})
    await scheduleWake(gid, { kind: 'commitment', detail: String(detail || '').slice(0, 240) }, cfg)
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

  /** 实际放通的既有工具名清单:open=内置安全面−减法+追加(自定义/敏感走 extraTools/allowTools);legacy=extraTools 白名单。
   *  端口缺省或解析异常都安全回落 legacy 行为——能力面只会更小不会更大。 */
  function resolveExtraToolNames(cfg: SimRuntimeConfig, groupId: string): string[] {
    if (cfg.toolPolicy.mode === 'legacy' || typeof ports.listRegistryToolNames !== 'function') return cfg.extraTools
    try {
      const registry = ports.listRegistryToolNames()
      return resolveSimToolSurface({ policy: cfg.toolPolicy, builtInNames: registry.builtIn, extraTools: cfg.extraTools, groupId })
    } catch {
      return cfg.extraTools
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

  /** 引用解析：被引用人 + 原文截断 + 被引消息里的图片 URL（qq-bridge 的"判断对谁说"关键信号；引用自己仍由 quoteToSelf 表达） */
  function extractQuote(e: SimIngestEvent, selfId: string): { author: string; text: string; isSelf: boolean; imageUrls: string[]; targetUserId: string } | null {
    const source = e.source
    if (!source?.user_id) {
      // 兜底：断线补投/部分适配器不给 e.source——QQ 引用回复的原始串固定是
      // [CQ:reply,id=X][CQ:at,qq=Y]（客户端自动 @被回复人），从这里至少拿回"回复给谁"。
      const raw = String(e.msg || e.raw_message || '')
      const match = raw.match(/\[CQ:reply,[^\]]*\]\s*\[CQ:at,[^\]]*(?:qq|user_id|id|uin)=(\d+)[^\]]*\]/)
      if (match?.[1]) {
        const targetUserId = match[1]
        return { author: '', text: '', isSelf: targetUserId === selfId, imageUrls: [], targetUserId }
      }
      return null
    }
    const targetUserId = String(source.user_id)
    const isSelf = targetUserId === selfId
    if (isSelf) return { author: '', text: '', isSelf: true, imageUrls: [], targetUserId }
    const author = String(source.card || source.nickname || `群友${targetUserId.slice(-4)}`)
    let text = ''
    const imageUrls: string[] = []
    if (typeof source.text === 'string') text = source.text
    if (Array.isArray(source.message)) {
      for (const seg of source.message as { type?: string; data?: { text?: unknown; url?: unknown } }[]) {
        if (seg?.type === 'text') text += String(seg.data?.text ?? '')
        if ((seg?.type === 'image' || seg?.type === 'mface') && typeof seg.data?.url === 'string' && seg.data.url) imageUrls.push(seg.data.url)
      }
    }
    text = text.replace(/\s+/g, ' ').trim().slice(0, 60)
    return { author, text, isSelf: false, imageUrls: imageUrls.slice(0, 3), targetUserId }
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

  /** @ 了别的具体成员（非机器人）：延续触发的排除条件。与主链路同一解析（结构化段 + 裸 CQ 串都认） */
  function extractAtOther(e: SimIngestEvent, selfId: string): boolean {
    return collectMentionTargetIds(e, selfId).length > 0
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
    // A2 messageId 幂等：适配器重发同一条消息时跳过（防 seq 跳号 + 重复触发唤醒）
    if (isDuplicateMessageId(e.message_id)) return true
    await refreshGroupState()
    if (!isCapture(e)) return false
    void store.addKnownGroup(groupId).catch(() => { /* 登记失败不影响本条消息 */ })
    const self = ports.getSelf(e.self_id ?? e.bot?.uin)
    const userId = String(e.user_id || '')
    if (userId && userId === self.id) return true
    const images = (e.message || []).filter(seg => seg?.type === 'image' || seg?.type === 'mface').length
    // 命令前缀不入会话流;例外:@ 了机器人或引用机器人消息的(「#抱抱希洛@这里是希洛!」是点名不是命令)。
    // atSelf 必须用段级检测:TRSS-Yunzai @机器人设的是 e.atBot,e.at===true 永远不成立,
    // 只看 e.at 会把「@机器人 .r10」这类点名静默吞掉、atMention 唤醒也永不触发。
    // quoteToSelf/quote 均带 CQ 串兜底:断线补投等场景 e.source 缺失时,引用上下文不能整个丢掉
    // (实拍事故:引用回复别人的"你好"被存成裸文本,模型以为是对自己说的)。
    const atSelf = messageMentionsUser(e, self.id)
    const atOther = extractAtOther(e, self.id)
    const quote = extractQuote(e, self.id)
    const quoteToSelf = quote?.isSelf === true
    // 可见文本剥掉 reply/at 的 CQ 码（引用/点名语义由 replyToUserId/quote*/at* 字段结构化承载）；
    // 纯 @ 消息（一个字不带）保留为占位——点名本身就是内容，不能因剥码整条丢掉
    const text = String(e.msg || e.raw_message || '')
      .replace(/\[CQ:reply,[^\]]*\]/g, '')
      .replace(/\[CQ:at,[^\]]*\]/g, '')
      .replace(/\s+/g, ' ').trim()
      || (atSelf ? '@你' : atOther ? '@了某人' : '')
    if (!text && images === 0) return true
    if (text && /^[#./\\]/.test(text) && !atSelf && !quoteToSelf) return true

    const cfg = runtimeConfig()
    const live = liveStates.get(groupId)
    const state = live ?? await store.load(groupId)
    state.seq += 1
    const imageUrls = extractImageUrls(e)
    const forwardId = extractForwardId(e)
    // 兜底路径解析不出名片：从会话近窗按 QQ 找最近一个名字（被回复的人必然刚说过话）
    const fallbackQuoteAuthor = quote?.targetUserId
      ? (state.recent.find(m => m.userId === quote.targetUserId)?.name || `群友${quote.targetUserId.slice(-4)}`)
      : ''
    const message: SimMessage = {
      seq: state.seq,
      messageId: e.message_id ?? null,
      userId,
      name: String(e.sender?.card || e.sender?.nickname || userId || '群友'),
      text: sanitizeUntrustedText(text).slice(0, cfg.turn.messageTextMaxChars),
      at: e.time && Number(e.time) > 0 ? Number(e.time) * 1000 : now(),
      atSelf,
      ...(atOther ? { atOther: true } : {}),
      quoteToSelf,
      ...(quote && !quote.isSelf ? {
        ...(quote.targetUserId ? { replyToUserId: quote.targetUserId } : {}),
        ...(quote.author || fallbackQuoteAuthor ? { quoteAuthor: quote.author || fallbackQuoteAuthor } : {}),
        ...(quote.text ? { quoteText: quote.text } : {}),
        ...(quote.imageUrls.length ? { quoteImageUrls: quote.imageUrls } : {}),
      } : {}),
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
      const hourNow = new Date(now() + 8 * 3600_000).getUTCHours()
      // 插话熔断：我上次发言后有第三人插过话（recent 只含群友消息，当前消息已入列但按 userId 自然排除）——
      // 对话对象这条更可能是接那人的话而不是对我说的，不算延续唤醒。宁可漏接不要抢话。
      const interveningSinceBotTurn = state.lastAiSendAt > 0
        && state.recent.some(m => m.at > state.lastAiSendAt && m.userId !== message.userId)
      reason = evaluateWakeTrigger(message, state.wakeConfig, { selfId: self.id, selfName: self.name, random, conversation: state.conversation, interveningSinceBotTurn, activityFactor: cfg.rhythm.enabled ? activityFactor(hourNow) : 1 })
    }
    // 管理员设定的「仅@才回」优先于一切触发器（含 AI 自设唤醒）：非点名类唤醒压掉。
    // 消息照常入库——AI 被点名醒来后仍可读到全部内容；定时器/管理类唤醒是被点名后的延伸，不受影响。
    const atOnlyGroup = (overridesCache?.atOnly || []).includes(groupId)
    if (reason && atOnlyGroup && !AT_ONLY_WAKE_KINDS.has(reason.kind)) reason = null
    // 生物节律：睡眠窗口内非点名唤醒全部压掉（真人在睡觉；被@会醒，这是唯一的例外）
    if (reason && cfg.rhythm.enabled) {
      const rhythmWin = await loadRhythmWindow(cfg)
      const hour = new Date(now() + 8 * 3600_000).getUTCHours()
      if (isSleeping(hour, rhythmWin) && !AT_ONLY_WAKE_KINDS.has(reason.kind)) reason = null
    }
    // 自主·活跃档：群里持续有动静时按节奏主动醒来跟进剧情，不等点名。
    // 节奏由 lastPlayAlongWakeAt 冷却（默认 5 分钟）控制，防刷屏/烧钱；仅@模式优先于活跃档，两者同开时主动跟进被压掉。
    if (!reason && !atOnlyGroup && playAlongActive(groupId)
      && message.at - (state.lastPlayAlongWakeAt || 0) >= cfg.wake.playAlongGapMs) {
      reason = { kind: 'session', seq: message.seq }
      state.lastPlayAlongWakeAt = message.at
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
    const timer = safeSetTimeout(() => {
      // 读 map 里的最新 reason：合并窗口内高优先级触发会替换 map 条目，闭包里的旧值会把它降级（实测抓到的潜伏 bug）
      const entry = pendingWakes.get(groupId)
      pendingWakes.delete(groupId)
      void startTurn(groupId, entry?.reason ?? reason)
    }, delay, 3_600_000)
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
      const verdict = checkWakeBudget(state, cfg, now(), todayCost, reason, String(groupId))
      if (!verdict.allowed) {
        // 预算类(回合/金额)今日不会再放行:群内提示一次后不再重试;
        // 限频类延后重试（丢弃会让 timeout 唤醒停在无定时器静默态）
        const limitText = describeBudgetLimit(verdict.reason)
        if (limitText) {
          logger.warn(`[仿真] 群 ${groupId} 唤醒被预算拦截：${verdict.reason}（今日剩余唤醒不再重试）`)
          const hasAudience = shouldAnnounceBudgetLimit(String(reason?.kind || ""), Number(state.lastIncomingAt) || 0, now())
          if (hasAudience && limitNoticeDue(limitNoticeAt.get(groupId) || 0, now())) {
            limitNoticeAt.set(groupId, now())
            void ports.sendGroupMessage(groupId, [{ type: 'text', data: { text: `（${limitText}，调用已限额，明天自动恢复喵）` } }])
              .then(receipt => { if (!receipt.ok) logger.warn(`[仿真] 群 ${groupId} 限额提示发送失败: ${receipt.error || ''}`) })
              .catch(() => { /* 提示失败不影响主流程 */ })
          }
          return
        }
        if (!retryTimers.has(groupId)) {
          const timer = safeSetTimeout(() => {
            retryTimers.delete(groupId)
            void startTurn(groupId, reason)
          }, 60_000)
          retryTimers.set(groupId, { timer, reason })
        }
        return
      }
      recordWake(state, now())
      state.lastWakeReason = reason

      // 唤醒预判闸：低信号唤醒（关键词/概率/延续/旁观类）先由便宜模型小上下文预判；
      // 判定不值得 → 等价 simMarkRead 静默收尾（推进水位、清未读），不进完整回合。
      // 预判不可用/异常 → 放行（fail-open，宁多花一次也不丢回复）。
      if (cfg.wakeGate.enabled && typeof ports.wakeGateJudge === 'function' && !WAKE_GATE_BYPASS_KINDS.has(reason.kind)) {
        let verdict: { engage: boolean; reason?: string } | null = null
        try {
          verdict = await ports.wakeGateJudge({
            reason: formatWakeReason(reason),
            messages: [...state.unread].sort((a, b) => a.seq - b.seq).slice(-10)
              .map(m => ({ name: String(m.name || ''), text: String(m.text || '').slice(0, 80), atSelf: Boolean(m.atSelf || m.quoteToSelf) })),
          })
        } catch { verdict = null }
        if (verdict && verdict.engage === false) {
          state.lastReadThroughSeq = state.unread.reduce((max, m) => Math.max(max, m.seq), state.lastReadThroughSeq)
          state.unread = []
          await store.save(groupId, state)
          logger.info(`[仿真] 群 ${groupId} 预判闸拦截 wake=${reason.kind}${verdict.reason ? `（${verdict.reason}）` : ''}，省一次完整回合`)
          return
        }
        if (verdict) logger.info(`[仿真] 群 ${groupId} 预判闸放行 wake=${reason.kind}${verdict.reason ? `（${verdict.reason}）` : ''}`)
      }

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
      // 委托记忆（群友托付记的事）：原文注入【群友托付的事】段（在场优先、到期高亮）
      const delegatedEntries = normalizeDelegatedEntries(await (async () => {
        try { const raw = typeof ports.loadDelegatedMemories === 'function' ? await ports.loadDelegatedMemories(groupId) : []; return Array.isArray(raw) ? raw : [] } catch { return [] }
      })(), now())
      const delegatedSection = delegatedEntries.length ? formatDelegatedSection(delegatedEntries, now(), speakers) : ''
      // 初始提示词只在 bootstrap 唤醒注入一次（bootstrapSent 在 ingest 时已置位，不能作为这里的判据）
      const initialPrompt = reason.kind === 'bootstrap' ? await store.getInitPrompt(groupId) : ''
      const styleDigest = await (async () => { try { return String((await ports.getStyleDigest?.(groupId)) || '') } catch { return '' } })()
      const userStyle = (await store.loadUserStyle(groupId).catch(() => ({ users: {} as Record<string, string[]>, updatedAt: 0 }))).users || {}
      // 在场群友的人物核心档案（跨群身份级事实，≤5 人；原始字段交给人物卡合并注入）
      const speakerIds = [...new Set([...session.unread, ...session.recent].map(m => m.userId))].slice(0, 5)
      const personProfiles: Record<string, PersonProfile | undefined> = {}
      for (const speakerId of speakerIds) {
        const profile = await store.loadPersonProfile(speakerId).catch(() => undefined)
        if (profile && (profile.name || profile.interests.length || profile.taboos.length || profile.traits?.length || profile.facts?.length)) personProfiles[speakerId] = profile
      }
      const globalAffinity = await store.loadGlobalAffinity(speakerIds).catch(() => ({} as Record<string, number>))
      const globalAffinityNotes = await store.loadGlobalAffinityNotes(speakerIds).catch(() => ({} as Record<string, string[]>))
      // 生物节律+生活线注入
      const hourNow2 = new Date(now() + 8 * 3600_000).getUTCHours()
      const rhythmWin2 = cfg.rhythm.enabled ? await loadRhythmWindow(cfg) : null
      const sleepNote = rhythmWin2 ? sleepinessNote(hourNow2, rhythmWin2) : ''
      const staleNote = staleMessageNote(state.lastIncomingAt || 0, now())
      const lifeThreadsRaw = cfg.lifeThreads.enabled ? await store.loadLifeThreads().catch(() => []) : []
      const lifeThreads = normalizeLifeThreads(lifeThreadsRaw)
      // 生活线×档案兴趣连接：在追的作品恰好也是某位在场群友的爱好 → 提示共同话题（社交连接点）
      const commonTopicLines: string[] = []
      for (const thread of lifeThreads.filter(t => t.status === 'active').slice(0, 3)) {
        const sharers = speakerIds.filter(id => (personProfiles[id]?.interests || []).some(interest => interestMatchesTitle(interest, thread.title)))
        if (sharers.length) commonTopicLines.push(`《${thread.title}》：${sharers.map(nameOf).join('、')}也喜欢——你们有天然共同话题，聊到时可以自然提起`)
      }
      const lifeThreadSection = formatLifeThreads(lifeThreads, commonTopicLines)
      // AI 自我记忆（跨群性格沉淀）
      const selfNotesText = formatSelfMemorySection(normalizeMemoryList(await store.loadSelfMemories().catch(() => []), now()))
      // 情绪四轴（跨群全局）：回合开始投影一次——注入底色段 + 本回合更新的包络锚点共用；
      // 中性带/从未写过时段落为空串，不注入（缺席=情绪平常）
      const moodCurrent = cfg.mood.enabled ? normalizeSimMood(await store.loadMood().catch(() => null), now()) : null
      const moodAnchor = projectMood(moodCurrent, now(), cfg.mood.halfLifeMs)
      const moodBox = { current: moodCurrent }
      const moodSection = formatMoodSection(moodCurrent, now(), cfg.mood.halfLifeMs)
      // 长程语义召回：未读末尾消息做查询，检索"两天情节窗之外"的相关片段（1s 预算）。
      // 失败/超时不注入内容，但必须与"检索无结果"区分开——注入未完成提示，防止模型把"没召回到"当"没发生过"。
      const recallQuery = [...state.unread].sort((a, b) => a.seq - b.seq).slice(-6).map(m => String(m.text || '').trim()).filter(Boolean).join(' ').slice(0, 160)
      let semanticRecall = ''
      let semanticRecallIncomplete = false
      if (recallQuery && typeof ports.getSemanticRecall === 'function') {
        type RecallOutcome = { ok: boolean; value: string }
        const outcome = await Promise.race<RecallOutcome>([
          Promise.resolve(ports.getSemanticRecall(groupId, recallQuery))
            .then((value: string) => ({ ok: true, value: String(value || '') }))
            .catch(() => ({ ok: false, value: '' })),
          new Promise<RecallOutcome>(resolve => { const timer = setTimeout(() => resolve({ ok: false, value: '' }), 1000); timer.unref?.() }),
        ])
        semanticRecall = outcome.ok ? outcome.value : ''
        semanticRecallIncomplete = !outcome.ok
      }
      const wakePrompt = buildWakePrompt({
        state, reason, snapshotText: snapshot.text, unreadTotal: snapshot.unreadTotal, now: now(), selfName: self.name,
        ...(initialPrompt ? { initialPrompt } : {}),
        memories, affinity, speakers, nameOf,
        userCatchphrases: (userId: string) => userStyle[userId],
        ...(Object.keys(personProfiles).length ? { personProfiles } : {}),
        ...(Object.keys(globalAffinity).length ? { globalAffinity } : {}),
        ...(Object.keys(globalAffinityNotes).length ? { globalAffinityNotes } : {}),
        ...(selfNotesText ? { selfNotesText } : {}),
        ...(moodSection ? { moodSection } : {}),
        ...(semanticRecall ? { semanticRecall } : {}),
        ...(semanticRecallIncomplete ? { semanticRecallIncomplete: true } : {}),
        ...(sleepNote ? { sleepNote } : {}),
        ...(staleNote ? { staleNote } : {}),
        ...(lifeThreadSection ? { lifeThreadSection } : {}),
        ...(delegatedSection ? { delegatedSection } : {}),
        groupDigest: safeText(() => ports.getGroupDigest?.(groupId)),
        episodesText: safeText(() => ports.getRecentEpisodesText?.(groupId)),
        styleDigest,
      })
      state.agentHistory.push({ role: 'user', content: wakePrompt })
      await store.save(groupId, state)

      const persona = ports.getPersona(groupId, self.id)
      const extraToolNames = resolveExtraToolNames(cfg, groupId)
      const extraTools = resolveExtraTools(extraToolNames)
      const systemPrompt = buildSimSystemPrompt({ persona: persona.persona, systemContent: persona.systemContent, selfName: self.name, hasExtraTools: extraTools.length > 0, extraToolNames, hasEmojiTool: extraToolNames.includes('sendLocalEmojiTool'), hasMoodTool: cfg.mood.enabled })

      const memoryBox = { list: memories, sentTexts: [] as string[] }
      const selfMemoryBox = { list: normalizeMemoryList(await store.loadSelfMemories().catch(() => []), now()) }
      // 额外工具的触发者身份（commitmentTool/delegateMemoryTool 等 owner 维度工具需要 user_id）：
      // 优先本回合未读首条，回退最近一条，再回退会话触发者——与情节补记的 trigger 判定同源。
      const triggerMessage = [...state.unread][0] ?? [...state.recent].slice(-1)[0] ?? null
      const triggerUser = triggerMessage?.userId
        ? { id: String(triggerMessage.userId), name: String(triggerMessage.name || '') }
        : (state.conversation.lastTriggerUserId ? { id: String(state.conversation.lastTriggerUserId), name: nameOf(String(state.conversation.lastTriggerUserId)) } : null)
      const ctx = buildToolContext(groupId, state, cfg, delta => { sends += delta }, memoryBox, { map: affinity }, selfMemoryBox, moodBox, moodAnchor)
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
          // 兜底：写了像"要说的话"的文本但本回合一条都没发过 → 提醒一次（模型惯性问题，实测高发）。
          // 沉默声明（「旁听，结束回合。」「无需发送，结束回合。」）除外：那是模型在宣布不说话，
          // 提醒/直发都会把元话术漏进群里——按其意愿安静结束。
          if (text.length >= 6 && sends === 0 && !/^\[(?:不发了|SILENT|沉默)\]$/.test(text) && !isSilentDeclaration(text)) {
            if (!nudgedForUnsent) {
              nudgedForUnsent = true
              logger.info(`[仿真] 群 ${groupId} 检测到未外发文本（${text.length} 字，本回合 0 发送），已提醒模型用 simSendMessage 发出`)
              history.push({ role: 'user', content: '【系统提醒】你刚才写的这段话群友看不到——本模式下只有 simSendMessage 发出的内容才会出现在群里，群里刚才只能看到你发的表情/动作。如果那段话就是你想说的，现在用 simSendMessage 原样（或更口语化、可拆几条）发出去；如果改变主意不想说了，从此不要再输出任何文字——「无需发送」「结束回合」「已静默结束」「不是对我说的」这类说明也不要写，直接停下即可。' })
              continue
            }
            // 提醒过一次还是把话写在文本里(实测高发:连续多轮 6 字文本 0 发送,群里看着就是已读不回)——
            // 直接替它发出去。内容照原样,不走模型再加工,避免又一轮哑火。
            // 最后防线：提醒后还输出含元话术的文本（「已静默结束」「不是对我说的」等自创变体），按沉默处理不直发——
            // 漏发可以下轮补，误发进群里收不回。
            if (mentionsSilenceVocabulary(text)) {
              logger.info(`[仿真] 群 ${groupId} 提醒后文本仍含元话术（${text.slice(0, 24)}），按沉默处理不直发`)
            } else {
              logger.info(`[仿真] 群 ${groupId} 提醒后仍未发送，兜底直发 ${text.length} 字`)
              history.push({ role: 'user', content: '【系统】已替你把上面那段话发出去了。以后想说的话必须自己调 simSendMessage。' })
              try {
                const sendCtx = buildToolContext(groupId, state, cfg, delta => { sends += delta }, memoryBox, { map: affinity }, selfMemoryBox)
                await sendCtx.sendMessage([text.slice(0, cfg.turn.messageTextMaxChars)], {})
              } catch (error) {
                logger.warn(`[仿真] 群 ${groupId} 兜底直发失败: ${error instanceof Error ? error.message : String(error)}`)
              }
            }
          } else if (text.length >= 6 && sends === 0) {
            logger.info(`[仿真] 群 ${groupId} 模型以沉默声明收尾（${text.slice(0, 24)}），按其意愿安静结束回合`)
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
                resultText = await runSimTool(tool, args, groupId, self.id, triggerUser)
                if (!(typeof resultText === 'string' && resultText.startsWith('error:'))) emojiLastSentAt.set(groupId, now())
              }
            } else {
              resultText = await runSimTool(tool, args, groupId, self.id, triggerUser)
            }
          }
          // simGetMessageImages 的结果带回图片：主模型多为纯文本(实测 glm-5.3 收 image_url 直接 400，
          // 且带图历史会持久化毒化后续每个回合)。图片改经视觉侧模型转成文字描述注入，主模型保持纯文本请求。
          if ((name === 'simGetMessageImages' || name === 'simGetForward') && !resultText.startsWith('error:')) {
            const images = parseSimImages(resultText, name === 'simGetForward' ? 3 : 2)
            if (images.length) {
              let label = '【转发里的图片】（对应转发记录里的 [图片#N] 编号）'
              if (name === 'simGetMessageImages') {
                let seqLabel = ''
                try { seqLabel = String(record(JSON.parse(resultText)).seq ?? '') } catch { /* 忽略 */ }
                label = `【消息 ${seqLabel} 的图片】`
              }
              let described = ''
              try { described = ports.describeImages ? String(await ports.describeImages(images, { groupId, label })) || '' : '' } catch { described = '' }
              history.push({ role: 'tool', tool_call_id: String(callRecord.id || ''), name, content: `已获取 ${images.length} 张图片，视觉侧模型的描述见下一条消息。` })
              history.push({ role: 'user', content: `${label}\n【视觉模型描述】${described || '（图片描述暂不可用，可请群友用文字说明图片内容）'}` })
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

  function buildToolContext(groupId: string, state: SimSessionState, cfg: SimRuntimeConfig, addSends: (delta: number) => void, memoryBox: { list: SimMemoryEntry[]; sentTexts: string[] }, affinityBox: { map: SimAffinityMap }, selfMemoryBox: { list: SimMemoryEntry[] }, moodBox: { current: SimMoodState | null } = { current: null }, moodAnchor: Record<MoodAxis, number> | null = null): SimToolContext {
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
        // B2 排队动作发送前重查：回合可能已持续数十秒，期间管理员可能关了仿真/切了群
        if (!groupActive(runtimeConfig(), groupId)) {
          return { ok: false, error: '仿真模式已对本群关闭，本轮不再发送消息' }
        }
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
          // 拟人节奏：连发间隔带长抖动（0.4~3 秒额外停顿），避免固定节拍的机器感
          if (i < messages.length - 1) await sleep(boundedTimerDelay(cfg.turn.minSendGapMs + 400 + Math.floor(random() * 2600), 60_000))
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
      qzoneConfig: () => cfg.qzone,
      ...(typeof store.bumpGlobalAffinity === 'function' ? { bumpGlobalAffinity: (userId: string, delta: number) => store.bumpGlobalAffinity(userId, delta) } : {}),
      ...(cfg.personProfile.enabled && typeof store.mergePersonProfile === 'function' ? {
        savePersonFact: async (userId: string, fact: string) => {
          await store.mergePersonProfile(userId, { facts: [fact] }, cfg.personProfile.maxFields)
        },
        closePersonFacts: async (userId: string, statement: string) => {
          await store.mergePersonProfile(userId, { closedFacts: [statement] }, cfg.personProfile.maxFields)
        },
      } : {}),
      ...(typeof store.loadSelfMemories === 'function' && typeof store.saveSelfMemories === 'function' ? {
        getSelfMemories: () => selfMemoryBox.list,
        saveSelfMemories: (list: SimMemoryEntry[]) => { selfMemoryBox.list = list; void store.saveSelfMemories(list) },
      } : {}),
      ...(cfg.mood.enabled && typeof store.saveMood === 'function' ? {
        getMood: () => (moodBox.current ? { summary: moodSummaryLine(moodBox.current, now(), cfg.mood.halfLifeMs) } : null),
        updateMood: (deltas: Parameters<NonNullable<SimToolContext['updateMood']>>[0], reason: string) => {
          const result = applyMoodUpdate({ mood: moodBox.current, deltas, reason, now: now(), halfLifeMs: cfg.mood.halfLifeMs, maxStep: cfg.mood.maxStep, ...(moodAnchor ? { turnAnchor: moodAnchor } : {}) })
          // 全部被包络夹成零变化 → 不落盘（更新 updatedAt 会白刷新衰减起点，等于无事件续命情绪）
          if (!Object.values(result.applied).some(v => v !== 0)) return { error: '没有产生实际变化（可能已到本轮变化上限）' }
          moodBox.current = result.mood
          void store.saveMood(result.mood)
          return { mood: result.mood, applied: result.applied, capped: result.capped }
        },
      } : {}),
      setRhythm: async (sleepFrom: number, sleepTo: number) => {
        await store.saveRhythm({ sleepFrom, sleepTo, setBy: 'agent' })
        rhythmCache = null
        return `已设定你的作息：${sleepFrom}:00 睡到 ${sleepTo}:00。这个时间你会更少说话（被@还是会回），对话中可以自然提到自己的作息习惯。`
      },
      ...(typeof ports.lifeThreadResolve === 'function' ? {
        lifeThreadFollow: async (title: string) => {
          const threads = normalizeLifeThreads(await store.loadLifeThreads().catch(() => []))
          const activeCount = threads.filter(t => t.status === 'active').length
          const existing = threads.find(t => t.title.includes(title) || title.includes(t.title))
          if (existing && existing.status === 'active') return { ok: false, error: `你已经在追《${existing.title}》了` }
          if (activeCount >= 3 && !existing) return { ok: false, error: '最多同时追 3 部——先弃掉一部再追新的（drop）' }
          const resolved = await ports.lifeThreadResolve!({ title })
          if (!resolved.ok) return resolved
          const next = normalizeLifeThreads([...threads, { id: `lt-${Date.now()}`, kind: 'anime' as const, title: resolved.title, sourceId: resolved.sourceId, status: 'active' as const, addedAt: now(), lastSyncAt: 0, ...(resolved.episode ? { lastEpisode: resolved.episode } : {}), notes: [] }])
          await store.saveLifeThreads(next)
          return { ok: true, title: resolved.title }
        },
        lifeThreadList: async () => {
          const threads = normalizeLifeThreads(await store.loadLifeThreads().catch(() => []))
          return threads.map(t => ({ title: t.title, status: t.status, ...(t.lastEpisode ? { lastEpisode: t.lastEpisode } : {}), notes: t.notes }))
        },
        lifeThreadDrop: async (title: string) => {
          const threads = normalizeLifeThreads(await store.loadLifeThreads().catch(() => []))
          const target = threads.find(t => t.title.includes(title) || title.includes(t.title))
          if (!target) return { ok: false, error: `没找到《${title}》` }
          target.status = 'dropped'
          await store.saveLifeThreads(threads)
          return { ok: true }
        },
      } : {}),
      ...(typeof ports.qzoneInteract === 'function' ? { qzoneInteract: (input: { action: 'visit' | 'like' | 'comment'; userId?: string; tid?: string; text?: string }) => ports.qzoneInteract!(input) } : {}),
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
        // 转发里的图片真实取回（≤FORWARD_MAX_MODEL_IMAGES 张）→ 以 vision 消息注入，模型能"看见"
        const urls = (result.imageUrls || []).slice(0, 3)
        const images: { mime: string; base64: string }[] = []
        if (urls.length && typeof ports.fetchImageBase64 === 'function') {
          for (const url of urls) {
            try {
              const fetched = await ports.fetchImageBase64(url)
              if ('base64' in fetched && fetched.base64) images.push({ mime: fetched.mime, base64: fetched.base64 })
            } catch { /* 单张失败不影响 */ }
          }
        }
        return {
          lines: result.lines || [],
          ...(images.length ? { images } : {}),
          ...((result.imageUrls || []).length > urls.length ? { imagesNotShown: (result.imageUrls || []).length - urls.length } : {}),
          ...(Array.isArray(result.nestedForwardIds) && result.nestedForwardIds.length ? { nestedForwardIds: result.nestedForwardIds } : {}),
          ...(result.error ? { error: result.error } : {}),
        }
      },
      collectSticker: async (seq: number) => {
        if (typeof ports.collectStickerImage !== 'function') return { ok: false, error: '收藏不可用' }
        const message = [...state.unread, ...state.recent].find(m => m.seq === seq)
        const url = message?.imageUrls?.[0]
        if (!url) return { ok: false, error: '这条消息没有可收藏的图片' }
        return await ports.collectStickerImage(groupId, url)
      },
      shareVideoCard: async (input: { query?: string; url?: string }) => {
        if (typeof ports.resolveBilibiliCard !== 'function') return { ok: false, error: 'B站卡片分享不可用' }
        const last = videoCardAt.get(groupId) || 0
        if (now() - last < 20 * 60_000) {
          const waitSec = Math.ceil((20 * 60_000 - (now() - last)) / 1000)
          return { ok: false, error: `B站卡片冷却中（还要 ${waitSec} 秒）。别刷屏，本回合换文字说。` }
        }
        const resolved = await ports.resolveBilibiliCard(input || {})
        if (!resolved.ok) return { ok: false, error: resolved.error || '没找到合适的视频' }
        const receipt = await ports.sendGroupMessage(groupId, [{ type: 'json', data: { data: resolved.cardJson || '' } }])
        if (!receipt.ok) return { ok: false, error: receipt.error || '卡片发送失败' }
        videoCardAt.set(groupId, now())
        addSends(1)
        return { ok: true, title: resolved.title || '' }
      },
      getMessageImages: async (seq: number) => {
        const message = [...state.unread, ...state.recent].find(m => m.seq === seq)
        if (!message) return { seq, images: [], error: '该消息不在近期缓冲里' }
        // 引用别人的带图消息是常见的"给你看"信号:本消息的图优先,没有则回落被引消息的图
        const urls = [...(message.imageUrls || []).slice(0, 2), ...(message.imageUrls || []).length ? [] : (message.quoteImageUrls || []).slice(0, 2)]
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
      const timer = safeSetTimeout(finish, timeoutMs, 120_000)
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
      // 仅@才回的群不主动冒泡：静默期检查照常排期，但不产生 proactiveCheck 唤醒；睡眠窗口内同样不冒泡
      const atOnly = (overridesCache?.atOnly || []).includes(groupId)
      let sleepingNow = false
      if (cfg.rhythm.enabled) {
        const rhythmWin = await loadRhythmWindow(cfg)
        sleepingNow = isSleeping(new Date(now() + 8 * 3600_000).getUTCHours(), rhythmWin)
      }
      if (!atOnly && !sleepingNow && state.lastIncomingAt > 0 && at - state.lastIncomingAt >= cfg.wake.proactiveIdleMs && at >= state.nextProactiveCheckAt) {
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
      if (!saved && !running.has(groupId)) await maybeExtractPersonProfiles(groupId, state, cfg)
      // 按人挖口头禅（风格个性化）：冷却默认 6h，读归档 → 纯函数挖掘 → Redis
      if (!saved && !running.has(groupId)) await maybeMineUserStyle(groupId, cfg)
      if (!saved && !running.has(groupId)) await maybeSyncLifeThreads(cfg)
      // 健康哨兵：全局每小时跑一次（挂在第一个群的 sweep 里）
      if (now() - healthSentinelLastRun > 3600_000) {
        healthSentinelLastRun = now()
        void runHealthSentinel()
      }
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
  /** 人物核心档案提取（跨群身份级事实）：保守口径 + 冷却，空档时在 sweep 里跑 */
  async function maybeExtractPersonProfiles(groupId: string, state: SimSessionState, cfg: SimRuntimeConfig): Promise<void> {
    if (!cfg.personProfile.enabled || typeof ports.personProfileExtract !== 'function') return
    const at = now()
    const cursor = state.personProfileCursor
    if (cursor && at - cursor.at < cfg.personProfile.extractCooldownMs) return
    const fresh = state.recent.filter(m => m.seq > (cursor?.seq ?? Math.max(0, state.seq - 40)))
    if (fresh.length < 20) return
    state.personProfileCursor = { seq: state.seq, at }
    await store.save(groupId, state)
    try {
      const startedAt = now()
      const raw = await ports.personProfileExtract(fresh.slice(-40).map(m => ({ userId: m.userId, name: m.name, text: m.text })))
      try { ports.recordTokens?.({ scope: groupId, stage: 'person-profile', ms: now() - startedAt }) } catch { /* 账本不可用 */ }
      const patches = parsePersonProfilePatches(raw)
      let mergedCount = 0
      for (const patch of patches) {
        // 模型没提取到称呼时，用该群最常见的名片做默认名（否则没人说"叫我XX"就永远空着）
        if (!patch.name) {
          const nick = fresh.filter(m => m.userId === patch.userId).map(m => m.name).sort((a, b) =>
            fresh.filter(m => m.name === a).length - fresh.filter(m => m.name === b).length
          ).pop()
          if (nick && nick.length <= 12) patch.name = nick
        }
        const before = await store.loadPersonProfile(patch.userId)
        const after = await store.mergePersonProfile(patch.userId, patch, cfg.personProfile.maxFields)
        const beforeSig = JSON.stringify([before.name || '', before.interests, before.taboos])
        const afterSig = JSON.stringify([after.name || '', after.interests, after.taboos])
        if (beforeSig !== afterSig) mergedCount += 1
      }
      if (mergedCount > 0) logger.info(`[仿真] 群 ${groupId} 人物档案更新 ${mergedCount} 人（提取自 ${fresh.length} 条消息）`)
    } catch (error) {
      logger.warn(`[仿真] 群 ${groupId} 人物档案提取失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** 健康哨兵：定期检查后台组件连环失败/过期，写 Redis 供控制台展示 */
  async function runHealthSentinel(): Promise<void> {
    try {
      const alerts: HealthAlert[] = []
      let commitmentFailures: { id?: string; intent?: string; group_id?: string; reason?: string; at?: number }[] | null = null
      // 直接读 style_memory.json / redis faillog（与承诺模块约定键名，避免 import 循环依赖——同 style_memory 先例）
      try {
        const fs = await import('node:fs')
        const pathMod = await import('node:path')
        const memoryPath = pathMod.join(process.cwd(), 'plugins', 'shiloh-plugin', 'data', 'global_style_learning', 'style_memory.json')
        if (fs.existsSync(memoryPath)) {
          const memory = JSON.parse(fs.readFileSync(memoryPath, 'utf8'))
          alerts.push(...checkHealth({ now: now(), styleMemory: memory }))
        }
      } catch { /* 读不到就跳过 */ }
      try {
        const raw = await (globalThis as unknown as { redis?: { get(k: string): Promise<string | null> } }).redis?.get?.('bl-chat:commitment:faillog')
        if (raw) {
          const parsed: unknown = JSON.parse(raw)
          if (Array.isArray(parsed)) commitmentFailures = parsed.filter(v => v !== null && typeof v === 'object')
        }
      } catch { /* 读不到就跳过 */ }
      alerts.push(...checkHealth({ now: now(), commitmentFailures }))
      // 写 Redis 供控制台展示
      const payload = JSON.stringify({ alerts, checkedAt: now() })
      try { await (globalThis as unknown as { redis?: { set(k: string, v: string): Promise<unknown> } }).redis?.set?.('shiloh:health:alerts', payload) } catch { /* redis 不可用 */ }
      if (alerts.length) logger.warn(`[健康哨兵] ${formatAlerts(alerts)}`)
    } catch { /* 哨兵自身失败不影响主流程 */ }
  }

  /** 生活线同步：空闲时拉取真实更新（新集→记笔记），全局共享 */
  async function maybeSyncLifeThreads(cfg: SimRuntimeConfig): Promise<void> {
    if (!cfg.lifeThreads.enabled || typeof ports.lifeThreadSync !== 'function') return
    const threads = normalizeLifeThreads(await store.loadLifeThreads().catch(() => []))
    const at = now()
    let dirty = false
    for (const thread of threads) {
      if (thread.status !== 'active') continue
      if (at - thread.lastSyncAt < cfg.lifeThreads.syncIntervalMs) continue
      try {
        const started = now()
        const result = await ports.lifeThreadSync({ sourceId: thread.sourceId, title: thread.title, ...(thread.lastEpisode ? { lastEpisode: thread.lastEpisode } : {}) })
        try { ports.recordTokens?.({ scope: 'life-thread', stage: 'sync', ms: now() - started }) } catch {}
        if (result && !('error' in result) && result.newNotes?.length) {
          Object.assign(thread, mergeThreadSync(thread, result, at))
          dirty = true
          logger.info(`[仿真] 生活线《${thread.title}》新增 ${result.newNotes.length} 条真实笔记`)
        }
      } catch { /* 单线失败不影响整批 */ }
    }
    if (dirty) await store.saveLifeThreads(threads)
  }

  async function maybeMineUserStyle(groupId: string, cfg: SimRuntimeConfig): Promise<void> {
    if (!cfg.userStyle.enabled || typeof ports.readArchiveMessages !== 'function') return
    try {
      const current = await store.loadUserStyle(groupId)
      if (now() - current.updatedAt < cfg.userStyle.cooldownMs) return
      // P0 反污染：机器人发言不进口头禅挖掘——学 AI 的口头禅只会更像机器
      const botIds = new Set(ports.getStyleBotUserIds?.() || [])
      const messages = (await ports.readArchiveMessages(groupId, cfg.userStyle.archiveDays)).filter(item => !botIds.has(String(item.userId || '')))
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
    // B4 断线宽限：重启=旧回合已死，清掉全部 busy 标记（否则 Redis 里的 15 分钟租约
    // 会让重启时有回合的群卡住——群友感觉希洛突然消失了一刻钟）
    try {
      const known = knownGroupsCache || []
      for (const groupId of known) {
        await store.clearBusy(groupId).catch(() => {})
      }
      if (known.length) logger.info(`[仿真] 启动清理：${known.length} 个群的旧回合租约已释放`)
    } catch { /* 清理失败不阻塞启动 */ }
    sweeper = setInterval(() => { void sweepOnce() }, boundedTimerDelay(SIM_SWEEP_INTERVAL_MS, 3_600_000, 5_000))
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

  /** 覆盖表结构演进时保住已有字段：启停群不能把预算覆盖弄丢 */
  function nextOverrides(edit: { explicitEnabled?: string[]; disabled?: string[]; atOnly?: string[]; playAlongUntil?: Record<string, number> }): SimGroupOverrides {
    const current = overridesCache || { explicitEnabled: [], disabled: [], budgetCaps: {}, turnCaps: {} }
    return {
      explicitEnabled: edit.explicitEnabled ?? [...(current.explicitEnabled || [])],
      disabled: edit.disabled ?? [...(current.disabled || [])],
      budgetCaps: { ...(current.budgetCaps || {}) },
      turnCaps: { ...(current.turnCaps || {}) },
      atOnly: edit.atOnly ?? [...(current.atOnly || [])],
      playAlongUntil: edit.playAlongUntil ?? { ...(current.playAlongUntil || {}) },
      ...(current.budgetDefaultCny !== undefined ? { budgetDefaultCny: current.budgetDefaultCny } : {}),
    }
  }

  /** 永久活跃档的到期哨兵值（2100-01-01）：活跃=长期生效，不自动回落 */
  const ACTIVE_FOREVER_MS = 4102444800000

  let rhythmCache: { at: number; win: RhythmWindow } | null = null
  async function loadRhythmWindow(cfg: SimRuntimeConfig): Promise<RhythmWindow> {
    if (rhythmCache && now() - rhythmCache.at < 60_000) return rhythmCache.win
    const stored = await store.loadRhythm().catch(() => null)
    const win = stored ? { sleepFrom: stored.sleepFrom, sleepTo: stored.sleepTo } : { sleepFrom: cfg.rhythm.sleepFrom, sleepTo: cfg.rhythm.sleepTo }
    rhythmCache = { at: now(), win }
    return win
  }

  /** 活跃助推是否生效（窗口未过期） */
  function playAlongActive(groupId: string): boolean {
    const until = Number(overridesCache?.playAlongUntil?.[groupId])
    return Number.isFinite(until) && until > now()
  }

  async function enableGroup(groupId: string): Promise<string> {
    await refreshGroupState(true)
    const cfg = runtimeConfig()
    const overrides = nextOverrides({ disabled: (overridesCache?.disabled || []).filter(g => g !== groupId) })
    if (!cfg.allGroups && !overrides.explicitEnabled.includes(groupId)) overrides.explicitEnabled.push(groupId)
    await store.saveOverrides(overrides)
    overridesCache = overrides
    return cfg.allGroups && !overrides.disabled.includes(groupId)
      ? `群 ${groupId} 确认处于仿真模式（当前默认全群开启，未单独退出过）`
      : `群 ${groupId} 已切换到仿真模式（下一条消息起生效）`
  }

  async function disableGroup(groupId: string): Promise<string> {
    await refreshGroupState(true)
    const overrides = nextOverrides({ explicitEnabled: (overridesCache?.explicitEnabled || []).filter(g => g !== groupId) })
    if (!overrides.disabled.includes(groupId)) overrides.disabled.push(groupId)
    await store.saveOverrides(overrides)
    overridesCache = overrides
    const pending = pendingWakes.get(groupId)
    if (pending) { clearTimeout(pending.timer); pendingWakes.delete(groupId) }
    return `群 ${groupId} 已切回普通模式（.仿真 开 可再切回）`
  }

  /** .仿真 模式 仅@/自主/活跃：按群回复模式（管理员设定，优先于 AI 自设触发器）。
   *  自主档的主动程度：自主=触发器命中才说；活跃=群里持续有动静时按节奏主动跟进（跑团当玩家）。
   *  mode 缺省=query。 */
  async function setGroupReplyMode(groupId: string, mode: 'atOnly' | 'auto' | 'active' | 'query' = 'query'): Promise<string> {
    await refreshGroupState(true)
    const atOnlyList = overridesCache?.atOnly || []
    const isAtOnly = atOnlyList.includes(groupId)
    const isBoosted = playAlongActive(groupId)
    const gapMin = Math.round(runtimeConfig().wake.playAlongGapMs / 60_000)
    if (mode === 'query') {
      if (isAtOnly) return `本群回复模式：仅被@才回（AI 仍在看全部消息，只有被@或引用时才说话；.仿真 模式 自主 可恢复）`
      if (isBoosted) {
        const until = Number(overridesCache?.playAlongUntil?.[groupId])
        const left = until >= ACTIVE_FOREVER_MS ? '长期' : `剩约 ${Math.max(1, Math.ceil((until - now()) / 60_000))} 分钟`
        return `本群回复模式：自主·活跃（${left}；群里持续有动静时每 ${gapMin} 分钟最多兜底跟进一次，AI 会同步收到自调引导）`
      }
      return `本群回复模式：自主（观察全部消息，触发器命中/@点名时说话；.仿真 模式 活跃 可切换为长期活跃档）`
    }
    const current = isAtOnly ? 'atOnly' : isBoosted ? 'active' : 'auto'
    if (mode === current) return `本群回复模式已是「${mode === 'atOnly' ? '仅被@才回' : mode === 'active' ? '自主·活跃' : '自主'}」，无需修改`
    const playAlongUntil = { ...(overridesCache?.playAlongUntil || {}) }
    if (mode === 'active') playAlongUntil[groupId] = ACTIVE_FOREVER_MS
    else delete playAlongUntil[groupId]
    const overrides = nextOverrides({
      atOnly: mode === 'atOnly' ? [...new Set([...atOnlyList, groupId])] : atOnlyList.filter(g => g !== groupId),
      playAlongUntil,
    })
    await store.saveOverrides(overrides)
    overridesCache = overrides
    if (mode === 'atOnly') {
      // 切到仅@时，已排期的自主类唤醒立即取消，避免切换后还突然冒一次泡
      const pending = pendingWakes.get(groupId)
      if (pending && !AT_ONLY_WAKE_KINDS.has(pending.reason.kind)) { clearTimeout(pending.timer); pendingWakes.delete(groupId) }
      return `群 ${groupId} 已设为「仅被@才回」：消息照常看、照常记忆，但只有被@或引用时才说话（.仿真 模式 自主 可恢复）`
    }
    if (mode === 'active') {
      return `群 ${groupId} 已设为「自主·活跃」（长期生效）：群里持续有动静时每 ${gapMin} 分钟最多兜底跟进一次，AI 会同步用 simSetWakeConfig 调自己的触发器；.仿真 模式 自主 可调回（跑团若开了骰娘 log，记得 .骰娘 跑团AI 开）`
    }
    return `群 ${groupId} 已设为「自主」：观察全部消息，触发器命中/@点名时说话（.仿真 模式 活跃 可再开助推）`
  }

  async function groupStatus(groupId: string): Promise<string> {
    await refreshGroupState(true)
    const cfg = runtimeConfig()
    const active = groupActive(cfg, groupId)
    const live = liveStates.get(groupId)
    const state = live ?? await store.load(groupId)
    const moodSummary = cfg.mood.enabled
      ? moodSummaryLine(normalizeSimMood(await store.loadMood().catch(() => null), now()), now(), cfg.mood.halfLifeMs)
      : ''
    return [
      `模式：${active ? '仿真（AI 自主收发）' : '普通'}${running.has(groupId) ? '（回合进行中）' : ''}`,
      `回复模式：${(overridesCache?.atOnly || []).includes(groupId) ? '仅被@才回（管理员设定，优先于 AI 自设触发器）' : playAlongActive(groupId) ? (Number(overridesCache?.playAlongUntil?.[groupId]) >= 4102444800000 ? '自主·活跃（长期）' : `自主·活跃（剩 ${Math.max(1, Math.ceil((Number(overridesCache?.playAlongUntil?.[groupId]) - now()) / 60_000))} 分钟）`) : '自主'}`,
      `范围：${cfg.enabled ? (cfg.allGroups ? '默认全群开启，可按群 .仿真 关' : '仅显式清单') : '总开关关闭'}`,
      `唤醒配置：mode=${state.wakeConfig.mode}${state.wakeConfig.sleepUntil ? `（${Math.max(0, Math.ceil((state.wakeConfig.sleepUntil - now()) / 60_000))} 分钟后到期）` : ''}`,
      `触发器：${JSON.stringify(state.wakeConfig.triggers)}`,
      `水位：lastReadThrough=${state.lastReadThroughSeq} unread=${state.unread.length} recent=${state.recent.length}`,
      `今日：${state.budget.turns}/${cfg.turn.maxTurnsPerDay} 回合，${state.budget.tokens} tokens`,
      `最近唤醒：${state.lastWakeReason?.kind || '无'}（${state.lastWakeAt ? Math.round((now() - state.lastWakeAt) / 1000) + ' 秒前' : '从未'}）`,
      `最近发言：${state.lastAiSendAt ? Math.round((now() - state.lastAiSendAt) / 1000) + ' 秒前' : '未发言'}`,
      ...(moodSummary ? [`情绪底色（跨群全局）：${moodSummary}`] : []),
      `回合历史：${state.agentHistory.length} 条`,
    ].join('\n')
  }

  async function resetGroup(groupId: string): Promise<string> {
    if (running.has(groupId)) return '该群有仿真回合正在进行，请稍后再重置'
    const cfg = runtimeConfig()
    await store.reset(groupId, cfg.agentPresetKeywords)
    return `群 ${groupId} 的仿真会话已重置（历史/水位/预算清空，启用状态保留；长期记忆与好感度不受影响）`
  }

  /** A3 撤回：从 unread/recent 移除对应消息，水位只增不减 */
  async function handleRecall(e: { group_id?: string | number; message_id?: string | number }): Promise<boolean> {
    const groupId = String(e.group_id || '')
    const messageId = String(e.message_id ?? '')
    if (!groupId || !messageId) return false
    await refreshGroupState()
    if (!groupActive(runtimeConfig(), groupId)) return false
    const state = liveStates.get(groupId) ?? await store.load(groupId)
    const removeMsg = (list: SimMessage[]) => list.filter(m => String(m.messageId ?? '') !== messageId)
    const beforeUnread = state.unread.length
    const beforeRecent = state.recent.length
    state.unread = removeMsg(state.unread)
    state.recent = removeMsg(state.recent)
    if (state.unread.length < beforeUnread || state.recent.length < beforeRecent) {
      await store.save(groupId, state)
      logger.info(`[仿真] 群 ${groupId} 消息已撤回（messageId=${messageId.slice(0, 12)}），从未读/近期中移除`)
    }
    return true
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
    return { enabled: cfg.enabled, allGroups: cfg.allGroups, disabled: overridesCache?.disabled || [], explicitEnabled: overridesCache?.explicitEnabled || [], budgetDefaultCny: cfg.budget.dailyCostCny, budgetGroupsCny: cfg.budget.groups, groups }
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
      /** 管理员设定的回复模式（三档）：atOnly=仅被@才回，active=自主·活跃，auto=自主 */
      replyMode: (overridesCache?.atOnly || []).includes(groupId) ? 'atOnly' : playAlongActive(groupId) ? 'active' : 'auto',
      wakeConfig: state.wakeConfig,
      unreadCount: state.unread.length,
      recentCount: state.recent.length,
      lastReadThroughSeq: state.lastReadThroughSeq,
      budget: { ...state.budget, maxTurnsPerDay: cfg.turn.groups[groupId] ?? cfg.turn.maxTurnsPerDay, turnsCapOverridden: Boolean(overridesCache?.turnCaps?.[groupId]), dailyCostCny: cfg.budget.groups[groupId] ?? cfg.budget.dailyCostCny, capOverridden: Boolean(overridesCache?.budgetCaps?.[groupId]), todayCostCny: safeNumber(() => ports.getTodaySpendCny?.(groupId)) },
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

  async function setGroupBudget(groupId: string, cap: number): Promise<string> {
    if (!/^\d{5,12}$/.test(groupId)) return '群号格式无效'
    await refreshGroupState(true)
    const overrides = { ...(overridesCache || { explicitEnabled: [], disabled: [], budgetCaps: {}, turnCaps: {} }) }
    overrides.turnCaps = { ...(overrides.turnCaps || {}) }
    overrides.budgetCaps = { ...(overrides.budgetCaps || {}) }
    const value = Math.floor(Number(cap) * 100) / 100
    if (value === -1) {
      overrides.budgetCaps[groupId] = -1
      await store.saveOverrides(overrides)
      overridesCache = overrides
      return `群 ${groupId} 每日消耗上限已设为不限`
    }
    if (Number.isFinite(value) && value > 0) {
      overrides.budgetCaps[groupId] = Math.min(10_000, value)
      await store.saveOverrides(overrides)
      overridesCache = overrides
      return `群 ${groupId} 每日消耗上限已设为 ${overrides.budgetCaps[groupId]} 元`
    }
    delete overrides.budgetCaps[groupId]
    await store.saveOverrides(overrides)
    overridesCache = overrides
    return `群 ${groupId} 已清除按群上限，回落到默认配置`
  }

  async function setGroupTurnsCap(groupId: string, cap: number): Promise<string> {
    if (!/^\d{5,12}$/.test(groupId)) return '群号格式无效'
    await refreshGroupState(true)
    const overrides = { ...(overridesCache || { explicitEnabled: [], disabled: [], budgetCaps: {}, turnCaps: {} }) }
    overrides.budgetCaps = { ...(overrides.budgetCaps || {}) }
    overrides.turnCaps = { ...(overrides.turnCaps || {}) }
    const value = Math.floor(Number(cap))
    if (value === -1) {
      overrides.turnCaps[groupId] = -1
      await store.saveOverrides(overrides)
      overridesCache = overrides
      return `群 ${groupId} 每日回合上限已设为不限`
    }
    if (Number.isFinite(value) && value > 0) {
      overrides.turnCaps[groupId] = Math.min(10_000, value)
      await store.saveOverrides(overrides)
      overridesCache = overrides
      return `群 ${groupId} 每日回合上限已设为 ${overrides.turnCaps[groupId]}`
    }
    delete overrides.turnCaps[groupId]
    await store.saveOverrides(overrides)
    overridesCache = overrides
    return `群 ${groupId} 已清除按群回合上限，回落到默认配置`
  }

  async function setDefaultBudget(cny: number): Promise<string> {
    await refreshGroupState(true)
    const overrides = { ...(overridesCache || { explicitEnabled: [], disabled: [], budgetCaps: {}, turnCaps: {} }) }
    overrides.turnCaps = { ...(overrides.turnCaps || {}) }
    const value = Math.floor(Number(cny) * 100) / 100
    if (Number.isFinite(value) && value > 0) {
      overrides.budgetDefaultCny = Math.min(10_000, value)
      await store.saveOverrides(overrides)
      overridesCache = overrides
      return `默认每日消耗上限已设为 ${overrides.budgetDefaultCny} 元`
    }
    delete overrides.budgetDefaultCny
    await store.saveOverrides(overrides)
    overridesCache = overrides
    return '已恢复使用配置文件的默认每日消耗上限'
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

  return { isCapture, ingest, start, stop, sweepOnce, enableGroup, disableGroup, setGroupReplyMode, groupStatus, resetGroup, listMemories, listAffinity, ingestPoke, handleRecall, overview, describeGroup, getInitialPrompt, setInitialPrompt, setGroupBudget, setGroupTurnsCap, setDefaultBudget, isGroupActive: isSimulationGroup, wakeForCommitment, listPersonProfiles: () => store.listPersonProfiles(), deletePersonProfile: (userId: string) => store.deletePersonProfile(userId), deletePersonProfileField: (userId: string, field: string, value?: string) => store.deletePersonProfileField(userId, field, value),
  lifeOverview: async () => {
    const cfg = runtimeConfig()
    const stored = await store.loadRhythm().catch(() => null)
    const rhythm = stored ? { sleepFrom: stored.sleepFrom, sleepTo: stored.sleepTo, ...(stored.setBy ? { setBy: stored.setBy } : {}) } : { sleepFrom: cfg.rhythm.sleepFrom, sleepTo: cfg.rhythm.sleepTo }
    const threads = normalizeLifeThreads(await store.loadLifeThreads().catch(() => []))
    const hour = new Date(now() + 8 * 3600_000).getUTCHours()
    return { rhythm, threads, now: { hour, sleeping: isSleeping(hour, { sleepFrom: rhythm.sleepFrom, sleepTo: rhythm.sleepTo }) } }
  },
  getHealthAlerts: async () => {
      try {
        const raw = await (globalThis as unknown as { redis?: { get(k: string): Promise<string | null> } }).redis?.get?.('shiloh:health:alerts')
        return raw ? JSON.parse(raw) : { alerts: [], checkedAt: 0 }
      } catch { return { alerts: [], checkedAt: 0 } }
    },
    setLifeRhythm: async (from: number, to: number) => {
    await store.saveRhythm({ sleepFrom: from, sleepTo: to, setBy: 'admin' })
    rhythmCache = null
    return `已设定作息 ${from}:00 - ${to}:00（页面设定）`
  } }
}
