import type { ChatRequestData, ChatResponse } from '../../../contracts/modelGateway.js'
import type { PersonaText } from '../../conversation/domain/personaSource.js'
import { randomUUID, createHash } from 'node:crypto'
import type { CharacterScope, CharacterReceipt, CharacterDecision, CharacterState } from '../../../contracts/character.js'
import { createPersonaSnapshot } from '../../conversation/infrastructure/personaSnapshot.js'
import { createCharacterStore } from './characterStore.js'
import { createCharacterTools } from './characterTools.js'
import { createCharacterTurnTool, type CharacterTurnFinishResult } from './characterTurn.js'
import { createCharacterConsistencyReviewer } from './characterConsistency.js'
import { planMessageDelivery } from '../domain/messageDelivery.js'
import type { CharacterActivityOperation, CharacterFeedItem } from '../../../contracts/characterActivities.js'
import { createCharacterWorkspace, createCharacterWorkspaceTools } from './characterWorkspace.js'
import { createCharacterSubscriptions, createCharacterSubscriptionTools } from './characterSubscriptions.js'
import { createCharacterReflection } from './characterReflection.js'
import { createCharacterSharedSelf, createSharedSelfTools } from './characterSharedSelf.js'
import { createCharacterWorkerTools, formatSavedCharacterWorkResult, type CharacterWorkerTask, type CharacterWorkerResult } from './characterWorker.js'
import type { CharacterProfile } from '../../../contracts/characterProfile.js'
import { describeCharacterEvidence, describeCharacterTaste, describePersona } from '../domain/characterProfile.js'
import { characterPromptMemories, beginCharacterGoalAttempt, beginCharacterGoalAction, recordCharacterReceipt, dueCharacterGoal, expireCharacterGoals, settleCharacter, formatCharacterSection, classifyCharacterResult, setCharacterPaused, transitionCharacterGoal, deleteCharacterMemory } from '../domain/characterState.js'
import { resolveSimulationActor, AUTONOMOUS_EXTRA_TOOLS, AUTONOMOUS_DENIED_SIM_TOOLS, AUTONOMOUS_CREATIVE_TOOLS, type SimulationActor } from '../domain/executionActor.js'
import type { SimAffinityEntry, SimAffinityMap, SimulationSection, SimHistoryMessage, SimMemoryEntry, SimMessage, SimMoodState, SimRuntimeConfig, SimSessionState, SimWakeReason } from '../../../contracts/simulation.js'
import { defaultSimRuntimeConfig } from '../domain/simConfig.js'
import { affinityLevel, buildMemeExtractionPrompt, bumpMemeUsage, defaultAffinityEntry, dueMemories, formatSelfMemorySection, mergeMemeCandidates, normalizeMemoryList, parseMemeCandidates } from '../domain/simMemory.js'
import { mineUserCatchphrases } from '../domain/userStyle.js'
import { boundedTimerDelay, safeSetTimeout, isDuplicateMessageId, sanitizeUntrustedText, safeToolErrorText, shouldSendErrorNotice } from '../domain/safety.js'
import { evaluateWakeTrigger, formatWakeReason, mergeWakeReason, messageReasonStillPending, pushPendingReason, TIMER_WAKE_REASONS } from '../domain/wakeTrigger.js'
import { resolveSimToolSurface } from '../domain/toolPolicy.js'
import { acknowledgeMessages, noteModelSeen, readThroughSeq } from '../domain/watermark.js'
import { buildWakeSnapshot, compactSimMessage } from '../domain/messageView.js'
import { buildSocialPermissionRequest, readSocialVerdict, type SocialAction } from '../domain/socialPermission.js'
import { computeWaitOutcome, normalizeWaitPlan, type SimWaitPlan } from '../domain/waitGate.js'
import { checkSendAllowance, checkWakeBudget, describeBudgetLimit, isDirectAddressKind, limitNoticeDue, shouldAnnounceBudgetLimit, invalidatePreSleepWaitByParticipation, markPreSleepSatisfied, recordSend, recordWake, recordWakeTokens, resetPreSleepWait, rollBudgetDay } from '../domain/budget.js'
import { buildCharacterTurnContext, buildSimSystemPrompt, buildWakePrompt, trimAgentHistory } from '../domain/promptBuilder.js'
import { isSilentDeclaration, isWrappedAnnotation, mentionsSilenceVocabulary } from '../domain/silentDeclaration.js'
import { parsePersonProfilePatches, interestMatchesTitle, type PersonProfile } from '../domain/personProfile.js'
import { isSleeping, activityFactor, sleepinessNote, staleMessageNote, type RhythmWindow } from '../domain/rhythm.js'
import { normalizeLifeThreads, mergeThreadSync, formatLifeThreads, type LifeThread } from '../domain/lifeThread.js'
import { applyMoodUpdate, formatMoodSection, moodSummaryLine, normalizeSimMood, projectMood, type MoodAxis } from '../domain/mood.js'
import { checkHealth, formatAlerts, type HealthAlert } from '../domain/healthSentinel.js'
import { buildChatRequestData } from '../../models/domain/modelGateway.js'
import { createSimSessionStore, type SimGroupOverrides, type SimSessionStore } from './simSessionStore.js'
import type { AbstractTool } from '../../toolSupport/infrastructure/AbstractTool.js'
import { redactInternalStatusLeaks } from '../../conversation/domain/internalStatusLeak.js'
import { sanitizeFinalReplyText, looksLikeToolArguments } from '../../conversation/domain/replySanitizer.js'
import { buildTurnInteractionContext } from '../../conversation/domain/turnInteractionContext.js'
import { buildPersonaReplyModePrompt, enforcePersonaToneBoundary } from '../../conversation/domain/personaTonePolicy.js'
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
const WAKE_GATE_BYPASS_KINDS = new Set<SimWakeReason['kind']>([...AT_ONLY_WAKE_KINDS, 'session', 'characterGoal'])

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
  /** Isolated, abortable model path for private reflection; absent means no background model calls. */
  reflectCharacter?(requestData: ChatRequestData, config: unknown, signal: AbortSignal): Promise<ChatResponse>
  /** Bounded semantic review. Production wires this to an abortable, tool-free model call. */
  reviewCharacter?(requestData: ChatRequestData, config: unknown, signal: AbortSignal): Promise<ChatResponse>
  /** Tool-free classification of the triggering message for deferred social actions. */
  judgeSocialPermission?(requestData: ChatRequestData, config: unknown, signal: AbortSignal): Promise<ChatResponse>
  fetchCharacterFeed?(url: string, kind: 'rss' | 'github'): Promise<CharacterFeedItem[]>
  runCharacterWorker?(task: CharacterWorkerTask, scope: CharacterScope, signal: AbortSignal): Promise<CharacterWorkerResult>
  characterWorkerAvailable?(): boolean
  /** B站卡片分享:按关键词或链接解析视频并生成 QQ 卡片 JSON(发送由 runtime 统一出站) */
  resolveBilibiliCard?(input: { query?: string; url?: string }): Promise<{ ok: boolean; error?: string; title?: string; cardJson?: string }>
  /** 视觉侧模型把图片转成文字描述（主模型纯文本时 simGetMessageImages 的看图走这里）；返回 null/空 表示描述不可用 */
  describeImages?(images: { mime: string; base64: string }[], context: { groupId: string; label: string }): Promise<string | null>
  /** 出站发送：segments 为 OneBot 消息段数组（经全局出站闸门）；成功时尽量带回 message_id 供回执校验 */
  sendGroupMessage(groupId: string, segments: unknown[], selfId?: string): Promise<{ ok: boolean; error?: string; messageId?: string | number; unknown?: boolean }>
  getPersona(groupId: string, selfId: string): { personaId?: string; persona: PersonaText; systemContent: string }
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
  pokeMember?(groupId: string, userId: string, selfId?: string): Promise<{ ok: boolean; error?: string }>
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
  getGroupMembers?(groupId: string, selfId?: string): Promise<{ userId: string; nick: string }[]>
  /** 合并转发内容（B4）：逐条正文 + 图片 URL 列表（按 [图片#N] 编号）+ 内嵌转发 id 列表（可递归展开） */
  getForwardContent?(forwardId: string, selfId?: string): Promise<{ lines: string[]; error?: string; total?: number; truncated?: boolean; nestedForwardIds?: string[]; imageUrls?: string[] }>
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
  describeGroup(groupId: string, options?: { profile?: boolean }): Promise<Record<string, unknown>>
  controlCharacter(groupId: string, action: 'pause' | 'resume' | 'cancel-goal' | 'pause-goal' | 'resume-goal' | 'delete-memory', id?: string): Promise<string>
  controlActivity(groupId: string, action: CharacterActivityOperation, id?: string, payload?: Record<string, unknown>): Promise<string>
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
  if (Array.isArray(payload)) return payload.map(segment => typeof segment === 'string' ? { type: 'text', data: { text: segment } } : segment)
  if (payload && typeof payload === 'object' && typeof (payload as { type?: unknown }).type === 'string') return [payload]
  return [{ type: 'text', data: { text: String(payload ?? '') } }]
}

export function createSimulationRuntime(ports: SimulationRuntimePorts): SimulationRuntime {
  const { logger } = ports
  const now = ports.now ?? Date.now
  const random = ports.random ?? Math.random
  const store: SimSessionStore = createSimSessionStore({ redis: ports.redis, logger, now })
  const workspaceFor = (scope: CharacterScope) => createCharacterWorkspace({ redis: ports.redis, scope, now })
  const retainEvidenceRefs = async (scope: CharacterScope) => (await workspaceFor(scope).list()).flatMap(work => work.versions.flatMap(version => version.evidenceRefs))
  const characters = createCharacterStore({ redis: ports.redis, now, retainEvidenceRefs })
  const subscriptionsFor = (scope: CharacterScope) => createCharacterSubscriptions({ redis: ports.redis, scope, now, ...(ports.fetchCharacterFeed ? { fetchFeed: ports.fetchCharacterFeed } : {}) })
  const sharedFor = (scope: CharacterScope) => createCharacterSharedSelf({ redis: ports.redis, scope, now })
  const reflectionFor = (scope: CharacterScope) => createCharacterReflection({ redis: ports.redis, scope, now, retainEvidenceRefs })
  const background = new Set<string>()
  const backgroundControllers = new Set<AbortController>()
  const backgroundByGroup = new Map<string, AbortController>()
  const recoveredCharacters = new Set<string>()
  let stopped = false
  function scopeFor(groupId: string, botId = ports.getSelf().id): CharacterScope {
    return { botId, personaId: ports.getPersona(groupId, botId).personaId || 'default', groupId }
  }
  // A console process may have no adapter identity, or an unrelated default bot.
  // Only an actual session binding establishes ownership of character data.
  function boundScopeFor(groupId: string, botId?: string): CharacterScope | null {
    return botId ? scopeFor(groupId, botId) : null
  }
  function scopedStore(scope: CharacterScope): SimSessionStore {
    return createSimSessionStore({ redis: ports.redis, logger, now, characterScope: scope })
  }
  async function revokeSharedDerived(scope: CharacterScope): Promise<void> {
    const active = new Set((await sharedFor(scope).projection()).map(entry => entry.id))
    const source = await characters.load(scope)
    const revoked = source.memories.filter(memory => memory.sharedSources?.some(id => !active.has(id)))
    const goals = source.goals.filter(goal => ['active','waiting','paused'].includes(goal.status) && goal.sharedSources?.some(id => !active.has(id)))
    if (revoked.length || goals.length) {
      await store.invalidateActivity(scope.groupId)
      await characters.update(scope, current => {
        let next = current
        for (const memory of revoked) if (next.memories.some(item => item.id === memory.id)) next = deleteCharacterMemory(next, memory.id, now())
        for (const goal of goals) if (next.goals.some(item => item.id === goal.id && ['active','waiting','paused'].includes(item.status))) next = transitionCharacterGoal(next, goal.id, 'abandoned', { now: now(), lastOutcome: '共享自我来源已撤销，停止派生目标' })
        return next
      })
      await store.invalidateActivity(scope.groupId)
      const live = liveStates.get(scope.groupId)
      if (live) {
        live.agentHistory = []
        await store.save(scope.groupId, live)
      }
    }
    await workspaceFor(scope).pruneShared([...active])
  }
  async function recoverCharacter(scope: CharacterScope): Promise<void> {
    const key = JSON.stringify(scope)
    if (recoveredCharacters.has(key)) return
    await characters.update(scope, current => {
      const uncertainGoals = new Set(current.receipts.filter(receipt => receipt.goalId && receipt.status === 'pending' && receipt.toolName !== 'simGoalCheck' && !AUTONOMOUS_EXTRA_TOOLS.includes(receipt.toolName)).map(receipt => receipt.goalId))
      let recovered = settleCharacter(current, now())
      for (const goal of recovered.goals) {
        if (uncertainGoals.has(goal.id) && ['active', 'waiting'].includes(goal.status)) recovered = transitionCharacterGoal(recovered, goal.id, 'paused', { now: now(), lastOutcome: '重启前的外部动作结果未知，暂停等待核对后再恢复，避免重复副作用' })
      }
      return recovered
    })
    recoveredCharacters.add(key)
  }

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
  async function runSimTool(tool: { name?: string; execute(args: Record<string, unknown>, event: unknown): Promise<unknown> }, args: Record<string, unknown>, groupId: string, selfId: string, actor: SimulationActor, reply: (payload: unknown) => Promise<unknown>, report?: (status: 'succeeded' | 'failed') => void, taskId?: string): Promise<string> {
    try {
      const result = await tool.execute(args, {
        group_id: Number(groupId),
        self_id: selfId,
        ...(actor.kind === 'user' && actor.userId ? { user_id: /^\d+$/.test(actor.userId) ? Number(actor.userId) : actor.userId, sender: { user_id: actor.userId, nickname: actor.userName || '' } } : {}),
        simulation: true,
        simulationActor: actor,
        simulationReportOutcome: report,
        ...(taskId ? { simulationTaskId: taskId } : {}),
        reply,
      })
      return typeof result === 'string' ? result : JSON.stringify(result) ?? 'null'
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
    const author = isSelf ? '' : String(source.card || source.nickname || `群友${targetUserId.slice(-4)}`)
    let text = ''
    const imageUrls: string[] = []
    if (typeof source.text === 'string') text = source.text
    if (Array.isArray(source.message)) {
      const useSegments = !text
      for (const seg of source.message as { type?: string; data?: { text?: unknown; url?: unknown } }[]) {
        if (useSegments && seg?.type === 'text') text += String(seg.data?.text ?? '')
        if ((seg?.type === 'image' || seg?.type === 'mface') && typeof seg.data?.url === 'string' && seg.data.url) imageUrls.push(seg.data.url)
      }
    }
    text = sanitizeUntrustedText(text.replace(/\s+/g, ' ').trim())
    if (text.length > 160) text = `${text.slice(0, 159)}…`
    return { author, text, isSelf, imageUrls: imageUrls.slice(0, 3), targetUserId }
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
    if (state.botId && state.botId !== self.id) {
      logger.warn(`[仿真] 群 ${groupId} 已绑定另一机器人，本账号不接管其会话`)
      return true
    }
    state.botId = self.id
    state.seq += 1
    const imageUrls = extractImageUrls(e)
    const forwardId = extractForwardId(e)
    // 兜底路径解析不出名片：从会话近窗按 QQ 找最近一个名字（被回复的人必然刚说过话）
    const fallbackQuoteAuthor = quote?.targetUserId
      ? (state.recent.find(m => m.userId === quote.targetUserId)?.name || `群友${quote.targetUserId.slice(-4)}`)
      : ''
    const sanitizedText = sanitizeUntrustedText(text)
    const message: SimMessage = {
      seq: state.seq,
      messageId: e.message_id ?? null,
      userId,
      name: String(e.sender?.card || e.sender?.nickname || userId || '群友'),
      text: sanitizedText.slice(0, cfg.turn.messageTextMaxChars),
      ...(sanitizedText.length > cfg.turn.messageTextMaxChars ? { textTruncated: true } : {}),
      at: e.time && Number(e.time) > 0 ? Number(e.time) * 1000 : now(),
      atSelf,
      ...(atOther ? { atOther: true } : {}),
      quoteToSelf,
      ...(quote && !quote.isSelf ? {
        ...(quote.targetUserId ? { replyToUserId: quote.targetUserId } : {}),
        ...(quote.author || fallbackQuoteAuthor ? { quoteAuthor: quote.author || fallbackQuoteAuthor } : {}),
      } : {}),
      ...(quote?.text ? { quoteText: quote.text } : {}),
      ...(quote?.imageUrls.length ? { quoteImageUrls: quote.imageUrls } : {}),
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
      reason = message.atSelf || message.quoteToSelf ? { kind: 'atMention', seq: message.seq } : { kind: 'bootstrap' }
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
      const rhythmWin = await loadRhythmWindow(cfg, scopeFor(groupId, state.botId))
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
    const busy = running.has(groupId) || background.has(groupId) || liveStates.has(groupId)
    if (busy && reason) {
      state.pendingWakeReasons = pushPendingReason(state.pendingWakeReasons, reason)
      reason = null
    }
    // 任何触发命中都视为"机器人在和这个人对话"：登记对话对象并刷新延续窗口
    if (reason) markConversationEngaged(state, message.userId, cfg.wake.continuationWindowMs)
    await store.save(groupId, state)
    notifyWaiters(groupId)
    if (reason) await scheduleWake(groupId, reason, cfg, state)
    return true
  }

  async function scheduleWake(groupId: string, reason: SimWakeReason, cfg?: SimRuntimeConfig, ingressState?: SimSessionState) {
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
      if (ingressState && isDirectAddressKind(existing.reason.kind) && isDirectAddressKind(reason.kind)) {
        const previous = ingressState.recent.find(message => message.seq === existing.reason.seq)
        const incoming = ingressState.recent.find(message => message.seq === reason.seq)
        if (previous && incoming && previous.userId !== incoming.userId) {
          const deferred = merged.changed ? existing.reason : reason
          ingressState.pendingWakeReasons = pushPendingReason(ingressState.pendingWakeReasons, deferred)
          await store.save(groupId, ingressState)
        }
      }
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
    if (background.has(groupId)) { await scheduleWake(groupId, reason, runtimeConfig()); return }
    if (running.has(groupId)) return
    running.add(groupId)
    const startedAt = now()
    let toolCalls = 0
    let sends = 0
    let tokens = 0
    let state: SimSessionState | null = null
    let nextWake: SimWakeReason | undefined
    try {
      await store.markBusy(groupId)
      const cfg = runtimeConfig()
      state = await store.load(groupId)
      const self = ports.getSelf(state.botId)
      if (['characterGoal', 'interestUpdate', 'proactiveCheck'].includes(reason.kind) && (overridesCache?.atOnly || []).includes(groupId)) return
      const resolvedPersona = ports.getPersona(groupId, self.id)
      const persona = createPersonaSnapshot({ botId: self.id, personaId: resolvedPersona.personaId || 'default', persona: { ...resolvedPersona.persona, name: String(resolvedPersona.persona.name || self.name) }, systemContent: resolvedPersona.systemContent })
      const characterScope: CharacterScope = { botId: self.id, personaId: persona.personaId, groupId }
      const selfStore = scopedStore(characterScope)
      await recoverCharacter(characterScope)
      await revokeSharedDerived(characterScope)
      const activityVersion = await store.loadActivityVersion(groupId)
      if ((state.activityVersion || '') !== activityVersion) {
        state.agentHistory = []
        delete state.lastConfirmedChat
      }
      state.activityVersion = activityVersion
      let character = await characters.update(characterScope, current => expireCharacterGoals(current, now()))
      const shared = sharedFor(characterScope)
      const sharedSnapshot = await shared.projection()
      const sharedFingerprint = createHash('sha256').update(JSON.stringify(sharedSnapshot)).digest('hex')
      if (state.sharedSelfFingerprint !== sharedFingerprint) {
        state.agentHistory = []
        delete state.lastConfirmedChat
      }
      state.sharedSelfFingerprint = sharedFingerprint
      const sharedIds = sharedSnapshot.map(entry => entry.id)
      const workspace = workspaceFor(characterScope)
      await workspace.pruneEvidence([...character.memories.map(m => `memory:${m.id}`), ...character.receipts.map(r => `receipt:${r.id}`)])
      const sourceMemoryIds = new Set(character.memories.map(memory => memory.id))
      if (state.personaId !== persona.personaId) {
        state.agentHistory = []
        delete state.lastConfirmedChat
      }
      state.personaId = persona.personaId
      state.botId = self.id
      let actor = resolveSimulationActor(characterScope, reason, state.recent)
      const triggerMessage = actor.kind === 'user' ? state.recent.find(message => message.seq === reason.seq) : undefined
      const anchor = reason.kind !== 'session' ? triggerMessage : undefined
      const conversationUserId = anchor?.userId
      if (actor.kind === 'autonomous' && character.paused) return
      let focusedGoalId: string | undefined
      let focusedGoalRevision: number | undefined
      let decision: CharacterDecision['kind'] | undefined
      let turnClosed = false
      let requiresClosing = false
      // Only the synchronous final announcement can use the committed goal version.
      // This permit is never exposed to a subsequent model tool call.
      type AnnouncementPermit = { revision: number; goalRevision?: number; goalStatus?: string }
      let announcement: AnnouncementPermit | undefined
      const focusGoal = async (id: string) => {
        if (reason.kind === 'commitment') throw new Error('正式托付回合不能转为自主目标并借用托付预算')
        if ((overridesCache?.atOnly || []).includes(groupId)) throw new Error('仅被@回应模式下不执行自主目标')
        if (focusedGoalId && focusedGoalId !== id) throw new Error('一回合只能推进一个自主目标')
        if (focusedGoalId) return
        const receiptId = randomUUID()
        character = await characters.update(characterScope, current => beginCharacterGoalAttempt(current, id, { id: receiptId, toolName: 'simGoalCheck' }, now()))
        const pending = character.receipts.find(item => item.id === receiptId)!
        focusedGoalId = id
        focusedGoalRevision = pending.goalRevision
        actor = { ...characterScope, kind: 'autonomous' }
        character = await characters.update(characterScope, current => recordCharacterReceipt(current, { ...pending, status: 'unknown', summary: '已进行一次目标检查，尚无外部行动结果', at: now() }, now()))
      }
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
            void ports.sendGroupMessage(groupId, [{ type: 'text', data: { text: `（${limitText}，调用已限额，明天自动恢复喵）` } }], self.id)
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
      if (reason.kind === 'characterGoal') {
        const goal = dueCharacterGoal(character, now())
        if (!goal || (reason.detail && reason.detail !== goal.id)) return
        await focusGoal(goal.id)
      }
      recordWake(state, now())
      state.lastWakeReason = reason
      const memories = normalizeMemoryList(await store.loadMemories(groupId), now())
      const followUpId = reason.kind === 'proactiveCheck' ? reason.detail : undefined
      if (reason.kind === 'proactiveCheck') {
        if (followUpId) {
          const due = dueMemories(memories, now())
          if (!due.some(item => item.id === followUpId && item.proactiveSourceSeq !== undefined) || state.offeredFollowUpIds?.includes(followUpId)) return
          const offered = new Set(state.offeredFollowUpIds)
          state.offeredFollowUpIds = [...due.filter(item => offered.has(item.id)).map(item => item.id), followUpId]
        }
        state.lastProactiveCheckedSeq = state.seq
      }

      // 唤醒预判闸：低信号唤醒（关键词/概率/延续/旁观类）先由便宜模型小上下文预判；
      // 判定不值得 → 等价 simMarkRead 静默收尾（推进水位、清未读），不进完整回合。
      // 预判不可用/异常 → 放行（fail-open，宁多花一次也不丢回复）。
      if (!followUpId && cfg.wakeGate.enabled && typeof ports.wakeGateJudge === 'function' && !WAKE_GATE_BYPASS_KINDS.has(reason.kind)) {
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

      const snapshot = buildWakeSnapshot(state, { limit: cfg.turn.wakeMessageLimit, maxChars: cfg.turn.wakeMaxChars, now: now(), ...(anchor ? { anchor } : {}) })
      const snapshotSeqs = snapshot.includedSeqs
      noteModelSeen(state, snapshotSeqs)
      const visibleMessageSeqs = new Set(anchor ? snapshotSeqs : [...state.modelSeenSeqs, ...snapshotSeqs])
      // agent 长期记忆/好感度/近期动态装配（.仿真 重置不清这些）
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
      const recentFirst = session.recent.slice().reverse()
      const nameOf = (userId: string) => recentFirst.find(m => m.userId === userId)?.name
        || session.unread.find(m => m.userId === userId)?.name
        || memories.find(m => m.aboutUser === userId)?.content.split('说')[0]?.slice(0, 12)
        || `群友${userId.slice(-4)}`
      const addressedBy = actor.kind === 'user' ? actor.userId : undefined
      const speakers = conversationUserId ? [conversationUserId] : [...new Set([
        ...(addressedBy ? [addressedBy] : []),
        ...session.recent.slice(-10).reverse().map(m => m.userId),
      ])]
      // 委托记忆（群友托付记的事）：原文注入【群友托付的事】段（在场优先、到期高亮）
      const delegatedEntries = normalizeDelegatedEntries(await (async () => {
        try { const raw = typeof ports.loadDelegatedMemories === 'function' ? await ports.loadDelegatedMemories(groupId) : []; return Array.isArray(raw) ? raw : [] } catch { return [] }
      })(), now())
      const delegatedSection = formatDelegatedSection(anchor ? delegatedEntries.filter(entry => entry.owner === anchor.userId) : delegatedEntries, now(), speakers)
      // 初始提示词只在 bootstrap 唤醒注入一次（bootstrapSent 在 ingest 时已置位，不能作为这里的判据）
      const initialPrompt = reason.kind === 'bootstrap' ? await store.getInitPrompt(groupId) : ''
      const styleDigest = anchor ? '' : await (async () => { try { return String((await ports.getStyleDigest?.(groupId)) || '') } catch { return '' } })()
      const userStyle = (await store.loadUserStyle(groupId).catch(() => ({ users: {} as Record<string, string[]>, updatedAt: 0 }))).users || {}
      // 在场群友的人物核心档案（跨群身份级事实，≤5 人；原始字段交给人物卡合并注入）
      const speakerIds = speakers.slice(0, 5)
      const personProfiles: Record<string, PersonProfile | undefined> = {}
      for (const speakerId of speakerIds) {
        const profile = await store.loadPersonProfile(speakerId).catch(() => undefined)
        if (profile && (profile.name || profile.interests.length || profile.taboos.length || profile.traits?.length || profile.facts?.length)) personProfiles[speakerId] = profile
      }
      const globalAffinity = await store.loadGlobalAffinity(speakerIds).catch(() => ({} as Record<string, number>))
      const globalAffinityNotes = await store.loadGlobalAffinityNotes(speakerIds).catch(() => ({} as Record<string, string[]>))
      // 生物节律+生活线注入
      const hourNow2 = new Date(now() + 8 * 3600_000).getUTCHours()
      const rhythmWin2 = cfg.rhythm.enabled ? await loadRhythmWindow(cfg, characterScope) : null
      const sleepNote = rhythmWin2 ? sleepinessNote(hourNow2, rhythmWin2) : ''
      const staleNote = staleMessageNote(state.lastIncomingAt || 0, now())
      const lifeThreadsRaw = cfg.lifeThreads.enabled ? await selfStore.loadLifeThreads().catch(() => []) : []
      const lifeThreads = normalizeLifeThreads(lifeThreadsRaw)
      // 生活线×档案兴趣连接：在追的作品恰好也是某位在场群友的爱好 → 提示共同话题（社交连接点）
      const commonTopicLines: string[] = []
      for (const thread of lifeThreads.filter(t => t.status === 'active').slice(0, 3)) {
        const sharers = speakerIds.filter(id => (personProfiles[id]?.interests || []).some(interest => interestMatchesTitle(interest, thread.title)))
        if (sharers.length) commonTopicLines.push(`《${thread.title}》：${sharers.map(nameOf).join('、')}也喜欢——你们有天然共同话题，聊到时可以自然提起`)
      }
      const lifeThreadSection = formatLifeThreads(lifeThreads, commonTopicLines)
      // AI 自我记忆（跨群性格沉淀）
      const selfNotesText = formatSelfMemorySection(normalizeMemoryList(await selfStore.loadSelfMemories().catch(() => []), now()))
      // 情绪四轴（跨群全局）：回合开始投影一次——注入底色段 + 本回合更新的包络锚点共用；
      // 中性带/从未写过时段落为空串，不注入（缺席=情绪平常）
      const moodCurrent = cfg.mood.enabled ? normalizeSimMood(await selfStore.loadMood().catch(() => null), now()) : null
      const moodAnchor = projectMood(moodCurrent, now(), cfg.mood.halfLifeMs)
      const moodBox = { current: moodCurrent }
      const moodSection = formatMoodSection(moodCurrent, now(), cfg.mood.halfLifeMs)
      // 长程语义召回：未读末尾消息做查询，检索"两天情节窗之外"的相关片段（1s 预算）。
      // 失败/超时不注入内容，但必须与"检索无结果"区分开——注入未完成提示，防止模型把"没召回到"当"没发生过"。
      const focusedGoal = character.goals.find(goal => goal.id === focusedGoalId)
      const recallQuery = anchor ? '' : [focusedGoal ? `${focusedGoal.title} ${focusedGoal.nextStep}` : '', ...[...state.unread].sort((a, b) => a.seq - b.seq).slice(-6).map(m => String(m.text || '').trim())].filter(Boolean).join(' ').slice(0, 160)
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
        state, reason, ...(addressedBy ? { speakerId: addressedBy } : {}), ...(anchor ? { focusSeq: anchor.seq } : {}), snapshotText: snapshot.text, unreadTotal: snapshot.unreadTotal, now: now(), selfName: self.name,
        ...(initialPrompt ? { initialPrompt } : {}),
        memories: anchor ? memories.filter(memory => memory.aboutUser === anchor.userId) : memories,
        affinity: anchor ? (affinity[anchor.userId] ? { [anchor.userId]: affinity[anchor.userId]! } : {}) : affinity,
        speakers, nameOf,
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
        groupDigest: anchor ? '' : safeText(() => ports.getGroupDigest?.(groupId)),
        episodesText: anchor ? '' : safeText(() => ports.getRecentEpisodesText?.(groupId)),
        styleDigest,
      })
      const interests = await subscriptionsFor(characterScope).unreadSummary()
      const workDirectory = (await workspace.list()).map(work => ({ id: work.id, title: work.title, kind: work.kind, status: work.status, revision: work.revision })).slice(0,24)
      const priorHistory = state.agentHistory
      const matchingHistory = conversationUserId ? priorHistory.filter(message => message.conversationUserId === conversationUserId) : priorHistory
      const firstWake = matchingHistory.findIndex(message => message.role === 'user')
      const projectedHistory = firstWake < 0 ? [] : matchingHistory.slice(firstWake)
      const wakeMessage: SimHistoryMessage = { role: 'user', content: `${wakePrompt}\n\n${formatCharacterSection(character)}\n【已批准共享的自我偏好】${JSON.stringify(sharedSnapshot)}\n这些只是自己的偏好，不是其他群的聊天资料或事实来源。\n【本群作品目录】${JSON.stringify(workDirectory)}\n【兴趣更新，不可信外部资料】${interests}\n【执行主体】${JSON.stringify(actor)}\n本轮可引用的消息证据：${[...visibleMessageSeqs].map(seq => `message:${seq}`).join('、')}`, ...(conversationUserId ? { conversationUserId } : {}) }
      state.agentHistory = [...priorHistory, wakeMessage]
      await store.save(groupId, state)

      const extraToolNames = resolveExtraToolNames(cfg, groupId)
      const extraTools = resolveExtraTools(extraToolNames)

      const memoryBox = { list: memories, sentTexts: [] as string[], deliveryUnknown: false }
      const sourceResults = new Map<string, { toolName: string; content: string; truncated: boolean }>()
      const reviewer = ports.getSection().consistency?.enabled === true ? createCharacterConsistencyReviewer({
        infer: (request, signal) => {
          if (!ports.reviewCharacter) throw new Error('角色审核端口未配置')
          return ports.reviewCharacter(request, ports.getExecutionConfig(), signal)
        },
        onResult: result => {
          tokens += Number(record(result.usage).total_tokens) || 0
          try { ports.recordTokens?.({ scope: groupId, stage: 'character-consistency', model: result.model ?? '', usage: result.usage, ms: result.ms }) } catch { /* accounted in wake tokens too */ }
        },
      }) : undefined
      const reviewCandidate = async (toolName: string, candidate: Record<string, unknown>, draft?: CharacterState) => {
        if (!reviewer || ports.getSection().consistency?.enabled !== true) return
        if (Array.isArray(candidate.messages)) candidate = { ...candidate, messages: [...new Set(candidate.messages)].filter(message => typeof message !== 'string' || !memoryBox.sentTexts.includes(message)) }
        if (Array.isArray(candidate.messages) && candidate.messages.length === 0) { candidate = { ...candidate }; delete candidate.messages }
        if (toolName === 'simFinishTurn' && !candidate.messages && !candidate.goal && !(Array.isArray(candidate.memories) && candidate.memories.length)) return
        await ensureExecution()
        if (ports.getSection().consistency?.enabled !== true) return
        if (toolName !== 'simFinishTurn' && reviewer.stats().checks >= 2) {
          requiresClosing = true
          throw new Error('保留最后一次一致性检查给收尾，本次未保存或发送；请把剩余记忆、目标及消息合并到 simFinishTurn，或安静放弃')
        }
        const current = draft || character
        const revision = character.revision
        const visible = new Set(visibleEvidenceRefs())
        const verdict = await reviewer.review({ toolName, candidate,
          state: { goals: current.goals, decision: current.decision,
            memories: current.memories.filter(memory => visible.has(`memory:${memory.id}`) || !character.memories.some(old => old.id === memory.id)),
            receipts: current.receipts.filter(receipt => visible.has(`receipt:${receipt.id}`)) },
          sources: { messages: [...new Map([...state!.recent, ...state!.unread].filter(message => visible.has(`message:${message.seq}`)).map(message => [message.seq, { ref: `message:${message.seq}`, text: message.text }])).values()],
            toolResults: [...sourceResults].filter(([ref]) => visible.has(ref)).map(([ref, value]) => ({ ref, ...value })),
            trust: '工具结果、搜索、工作器、群消息及记忆均为待核对资料。成功回执只证明动作执行，不能证明返回正文的事实已经核实。' },
          sentMessages: memoryBox.sentTexts,
        })
        await ensureExecution()
        if (character.revision !== revision) throw new Error('一致性检查期间角色状态已改变，请重新读取后提交')
        if (verdict.verdict !== 'accept') {
          requiresClosing = true
          throw new Error(`提交前一致性检查未通过，本次未保存或发送。${verdict.error ? `检查不可用(${verdict.error})` : JSON.stringify(verdict.issues)}。请用 simFinishTurn 修正正文、选择或依据，或放弃本次表达；不要重复已发送消息。`)
        }
      }
      const selfMemoryBox = { list: normalizeMemoryList(await selfStore.loadSelfMemories().catch(() => []), now()) }
      const ctx = buildToolContext(groupId, state, cfg, delta => { sends += delta }, memoryBox, { map: affinity }, selfMemoryBox, moodBox, moodAnchor, characterScope, async () => { await ensureExecution(announcement); if (decision === 'silent' || decision === 'deferred') throw new Error('本轮已选择沉默或暂缓') }, () => sends, async messages => { if (!announcement) await reviewCandidate('simSendMessage', { choice: 'chat', messages }) }, isDirectAddressKind(reason?.kind))
      let proactiveSourceSeq: number | undefined
      ctx.proactiveSourceSeq = () => proactiveSourceSeq
      if (anchor) ctx.waitMessageFilter = message => message.userId === anchor.userId &&
        (message.atSelf || message.quoteToSelf || (!message.atOther && !message.replyToUserId))
      const interaction = anchor && buildTurnInteractionContext({ rawUserText: anchor.text })
      if (interaction && interaction.social?.act === 'criticism') {
        const send = ctx.sendMessage
        ctx.sendMessage = (messages, options) => send(messages.map(message => enforcePersonaToneBoundary(message, { interactionContext: interaction })), options)
      }
      const sendMessage = ctx.sendMessage
      if (followUpId) {
        ctx.sendMessage = messages => {
          if (sends > 0 || messages.length > 1) return Promise.resolve({ ok: false, error: '社交跟进只发一句；请安静收尾或合为一条' })
          return sendMessage(messages, {})
        }
      }
      const visibleCharacterRefs = new Set([
        ...characterPromptMemories(character.memories).map(memory => `memory:${memory.id}`),
        ...character.receipts.slice(-8).map(receipt => `receipt:${receipt.id}`),
      ])
      const visibleEvidenceRefs = () => [...new Set([
        ...[...visibleMessageSeqs].filter(seq => state!.recent.some(message => message.seq === seq) || state!.unread.some(message => message.seq === seq)).map(seq => `message:${seq}`),
        ...visibleCharacterRefs,
      ])]
      ctx.noteVisibleMessages = seqs => {
        for (const seq of seqs) visibleMessageSeqs.add(seq)
      }
      ctx.checkHabitSources = seqs => {
        const sources = new Map([...state!.recent, ...state!.unread]
          .filter(message => visibleMessageSeqs.has(message.seq) && message.kind === 'text' && !!message.text)
          .map(message => [message.seq, message.at]))
        const times = seqs.map(seq => sources.get(seq))
        if (times.some(at => at === undefined)) return false
        const dates = times as number[]
        return Math.max(...dates) - Math.min(...dates) >= 10 * 60_000
      }
      const exposeToolResult = (toolName: string, result: string) => {
        try {
          const value = record(JSON.parse(result))
          if (toolName === 'simCharacterMemory') {
            if (record(value.memory).id) visibleCharacterRefs.add(`memory:${record(value.memory).id}`)
            if (Array.isArray(value.memories)) for (const memory of value.memories) if (record(memory).id) visibleCharacterRefs.add(`memory:${record(memory).id}`)
          }
        } catch { /* plain text tool result exposes no new character records */ }
      }
      const characterTools = createCharacterTools({
        now, read: () => characters.load(characterScope),
        update: async mutate => { character = await characters.update(characterScope, mutate); return character },
        visibleEvidenceRefs, selectGoal: focusGoal,
        onDecision: kind => { decision = kind }, makeId: prefix => `${prefix}-${randomUUID()}`,
        sharedSourceIds: () => sharedIds,
        reviewMemory: (candidate, draft) => reviewCandidate('simCharacterMemory', candidate, draft),
      })
      const activityTools = [
        ...createCharacterWorkspaceTools({ workspace, visibleEvidenceRefs, ensureActive: () => ensureExecution(), sharedSourceIds: () => sharedIds }),
        ...createCharacterSubscriptionTools({ subscriptions: subscriptionsFor(characterScope), ensureActive: () => ensureExecution() }),
        ...createSharedSelfTools({ shared, visibleEvidenceRefs, ensureActive: () => ensureExecution() }),
        ...createCharacterWorkerTools({ ensureActive: async () => { await ensureExecution(); if (ports.characterWorkerAvailable?.() === false) throw new Error('工作器连接已停用') }, visibleEvidenceRefs,
          ...(ports.runCharacterWorker && ports.characterWorkerAvailable?.() !== false ? { run: (task: CharacterWorkerTask, signal: AbortSignal) => ports.runCharacterWorker!(task, characterScope, signal) } : {}),
        }),
      ]
      ctx.requireExplicitContinuation = true
      const simulationTools = createSimTools(ctx)
      const finishTool = createCharacterTurnTool({
        now, read: () => characters.load(characterScope),
        update: async mutate => { character = await characters.update(characterScope, mutate); return character },
        visibleEvidenceRefs, makeId: prefix => `${prefix}-${randomUUID()}`,
        sharedSourceIds: () => sharedIds, ensureActive: () => ensureExecution(), finish: result => finishTurn(result),
        review: ({ candidate, state }) => reviewCandidate('simFinishTurn', candidate, state),
      })
      const tools = [...simulationTools, ...characterTools, finishTool, ...activityTools, ...extraTools]
      const toolReply = async (payload: unknown) => {
        await ensureExecution()
        if (memoryBox.deliveryUnknown) throw new Error('上次发送结果未知，本回合不再发送，请核对回执')
        if (decision === 'silent' || decision === 'deferred') throw new Error('本轮已选择沉默或暂缓')
        const segments = normalizeReplyPayload(payload)
        const safeSegments = segments.map(segment => {
          const item = record(segment)
          if (item.type !== 'text') return segment
          const text = String(record(item.data).text || '')
          if (looksLikeToolArguments(text)) throw new Error('工具回复含参数内容，已拦截')
          const sanitized = sanitizeFinalReplyText(text)
          if (!sanitized) throw new Error('工具回复清理后为空')
          const redacted = redactInternalStatusLeaks(sanitized)
          if (redacted.heavy) throw new Error('工具回复包含内部状态，已拦截')
          return { ...item, data: { ...record(item.data), text: redacted.text } }
        })
        const replySeen = new Set(memoryBox.sentTexts)
        let duplicatesSkipped = 0
        const transportSegments = safeSegments.filter(segment => {
          if (record(segment).type !== 'text') return true
          const text = String(record(record(segment).data).text || '')
          if (replySeen.has(text)) { duplicatesSkipped++; return false }
          replySeen.add(text); return true
        })
        const replyTexts = transportSegments.filter(segment => record(segment).type === 'text').map(segment => String(record(record(segment).data).text || ''))
        if (!transportSegments.some(segment => !['at', 'reply'].includes(String(record(segment).type)))) return { message_id: '', sent: 0, duplicatesSkipped }
        const allowance = checkSendAllowance(state!, cfg, now(), sends, isDirectAddressKind(reason?.kind))
        if (!allowance.allowed) throw new Error(allowance.reason)
        if (replyTexts.length) await reviewCandidate('toolReply', { messages: replyTexts })
        await ensureExecution()
        let receipt
        try { receipt = await ports.sendGroupMessage(groupId, transportSegments, self.id) }
        catch { memoryBox.deliveryUnknown = true; throw new Error('工具消息传输中断，是否送达未知，本回合不再发送') }
        if (receipt.unknown) { memoryBox.deliveryUnknown = true; throw new Error('工具消息回执未确认，是否送达未知，本回合不再发送') }
        if (!receipt.ok) throw new Error(receipt.error || '发送失败')
        memoryBox.sentTexts.push(...replyTexts)
        sends += 1
        recordSend(state!, now(), 1)
        state!.lastAiSendAt = now()
        await store.save(groupId, state!)
        return { message_id: receipt.messageId ?? '', data: { message_id: receipt.messageId ?? '' } }
      }
      const allowedTool = (name: string) => actor.kind === 'user' || (
        !AUTONOMOUS_DENIED_SIM_TOOLS.includes(name) && (simulationTools.some(tool => tool.name === name) || characterTools.some(tool => tool.name === name) || name === finishTool.name || activityTools.some(tool => tool.name === name) || AUTONOMOUS_EXTRA_TOOLS.includes(name) ||
          (AUTONOMOUS_CREATIVE_TOOLS.includes(name) && (ports.getSection().autonomousTools || []).includes(name) && resolveExtraToolNames(runtimeConfig(), groupId).includes(name)))
      )
      const ensureExecution = async (permit?: AnnouncementPermit) => {
        if (turnClosed && !permit) throw new Error('回合已结束，未执行')
        if (stopped) throw new Error('仿真运行时已停止')
        await refreshGroupState(true)
        if (!groupActive(runtimeConfig(), groupId)) throw new Error('本群仿真已关闭')
        const currentScope = scopeFor(groupId, self.id)
        if (currentScope.personaId !== characterScope.personaId) throw new Error('人设已切换，本回合停止行动')
        if (await shared.fingerprint() !== sharedFingerprint) throw new Error('共享偏好已改变，停止使用旧上下文')
        character = await characters.load(characterScope)
        if ([...sourceMemoryIds].some(id => !character.memories.some(memory => memory.id === id))) throw new Error('本轮引用的记忆已被删除，停止使用旧上下文')
        if (actor.kind === 'autonomous' && (character.paused || (overridesCache?.atOnly || []).includes(groupId))) throw new Error('自主行动已暂停或仅被@回应')
        if (focusedGoalId && (overridesCache?.atOnly || []).includes(groupId)) throw new Error('本群已切为仅被@回应，自主目标暂停执行')
        if (permit && character.revision !== permit.revision) throw new Error('收尾保存后角色状态已改变，停止公告或标读')
        if (focusedGoalId) {
          const goal = character.goals.find(item => item.id === focusedGoalId)
          if (permit) {
            if (!goal || goal.revision !== permit.goalRevision || goal.status !== permit.goalStatus || ['paused', 'failed'].includes(goal.status) || (['active', 'waiting'].includes(goal.status) && goal.expiresAt <= now())) throw new Error('收尾目标已改变或到期，停止公告或标读')
          } else if (!goal || !['active', 'waiting'].includes(goal.status) || goal.expiresAt <= now() || goal.revision !== focusedGoalRevision) throw new Error('目标已暂停、取消、到期或更新，本回合停止行动')
        }
        // Last asynchronous read before the caller executes/sends: the console
        // may have revoked the work while the permission checks were pending.
        if (await store.loadActivityVersion(groupId) !== activityVersion) throw new Error('角色活动内容已被管理员撤销，停止旧回合')
      }
      // Repair an oversized plain directed reply before persistence or transport.
      // Repeated batches, state changes and explicit read-only closures keep the normal send contract.
      let requestedMessageMerge = false
      const finishTurn = async (result: CharacterTurnFinishResult) => {
        turnClosed = true
        if (result.decision) decision = result.decision
        const committedGoal = result.state.goals.find(goal => goal.id === focusedGoalId)
        const permit: AnnouncementPermit = {
          revision: result.state.revision,
          ...(committedGoal ? { goalRevision: committedGoal.revision, goalStatus: committedGoal.status } : {}),
        }
        let sendStatus: 'not_requested' | 'succeeded' | 'failed' = 'not_requested'
        let readStatus: 'not_requested' | 'succeeded' | 'failed' = 'not_requested'
        let error: string | undefined
        let duplicatesSkipped = 0
        const sentBefore = sends
        if (result.messages) {
          sendStatus = 'failed'
          const id = randomUUID()
          let pending: CharacterReceipt | undefined
          try {
            await ensureExecution(permit)
            character = await characters.update(characterScope, current => {
              if (current.revision !== permit.revision) throw new Error('角色状态已改变，公告未登记')
              return recordCharacterReceipt(current, { id, toolName: 'simFinishTurn', status: 'pending', summary: '收尾状态已保存，等待最终消息发送回执', at: now() }, now())
            })
            permit.revision = character.revision
            pending = character.receipts.find(receipt => receipt.id === id)!
            announcement = permit
            const sender = simulationTools.find(tool => tool.name === 'simSendMessage')!
            const response = await runSimTool(sender, {
              continuation: 'chat', messages: result.messages,
              ...(result.replyToSeq === undefined ? {} : { replyToSeq: result.replyToSeq }),
              ...(result.atUserIds === undefined ? {} : { atUserIds: result.atUserIds }),
            }, groupId, self.id, actor, toolReply)
            sendStatus = classifyCharacterResult(response) === 'succeeded' ? 'succeeded' : 'failed'
            try { duplicatesSkipped = Number(record(JSON.parse(response.replace(/^error: /, ''))).duplicatesSkipped) || 0 } catch { /* error response retains its own delivery evidence */ }
            if (sendStatus === 'failed') error = response
          } catch (failure) { error = safeToolErrorText('simFinishTurn', failure) }
          finally { announcement = undefined }
          if (pending) {
            try {
              character = await characters.update(characterScope, current => {
                if (current.revision !== permit.revision) throw new Error('公告期间角色状态已改变，保留 pending 待核实，不覆盖新状态')
                return recordCharacterReceipt(current, { ...pending, status: sendStatus === 'succeeded' ? 'succeeded' : memoryBox.deliveryUnknown || sends > sentBefore ? 'unknown' : 'failed', summary: sendStatus === 'succeeded' ? `最终消息已确认发送 ${sends - sentBefore} 条，跳过重复 ${duplicatesSkipped} 条` : '最终消息发送未全部确认；已保存状态保留，不自动重发', at: now() }, now())
              })
              permit.revision = character.revision
            } catch (failure) {
              error = safeToolErrorText('simFinishTurn', failure)
              logger.warn(`[仿真] 群 ${groupId} 收尾发送最终回执未保存，禁止自动重发`)
            }
          }
        }
        if (result.throughSeq !== undefined) {
          readStatus = 'failed'
          try {
            if (sendStatus === 'failed') throw new Error('最终消息未确认，保留未读，已保存角色状态不回滚')
            await ensureExecution(permit)
            if (!acknowledgeMessages(state!, result.throughSeq)) throw new Error('标读范围已改变，保留未读')
            await store.save(groupId, state!)
            readStatus = 'succeeded'
          } catch (failure) { error = safeToolErrorText('simFinishTurn', failure) }
        }
        const outcome = {
          ok: true, choice: result.choice, saved: true,
          ...(result.goal ? { goal: result.goal } : {}), memories: result.memories || [],
          ...(result.decision ? { decision: result.decision } : {}),
          sendStatus, sent: sends - sentBefore, duplicatesSkipped, ...(memoryBox.deliveryUnknown ? { deliveryUnknown: true } : {}), readStatus, ...(error ? { error: error.slice(0, 500) } : {}),
        }
        if (JSON.stringify(outcome).length <= 3500) return outcome
        // Preserve a whole acknowledgement within the tool-history budget.
        // Full records remain in storage and can be read with the paged tools.
        const recordHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
        return { ...outcome,
          ...(result.goal ? { goal: { id: result.goal.id, revision: result.goal.revision, status: result.goal.status, recordHash: recordHash(result.goal) } } : {}),
          memories: (result.memories || []).map(memory => ({ id: memory.id, recordHash: recordHash(memory) })),
        }
      }
      const socialAttempts = new Set<SocialAction>()
      const judgeSocial = async (action: SocialAction, proposed: unknown) => {
        if (!triggerMessage || !ports.judgeSocialPermission || socialAttempts.has(action)) return 'unclear'
        if (action === 'follow_up' && triggerMessage.textTruncated) return 'unclear'
        socialAttempts.add(action)
        const started = now()
        const signal = AbortSignal.timeout(12_000)
        try {
          const response = await ports.judgeSocialPermission(buildSocialPermissionRequest(action, triggerMessage.text, proposed), ports.getExecutionConfig(), signal)
          const usage = record(response.usage)
          tokens += Number(usage.total_tokens) || 0
          try { ports.recordTokens?.({ scope: groupId, stage: 'sim-social-permission', model: String(response.model || ''), usage, ms: now() - started }) } catch { /* aggregate still counts usage */ }
          return signal.aborted ? 'unclear' : readSocialVerdict(action, triggerMessage.text, response)
        } catch { return 'unclear' }
      }
      const remainingMessageSlots = () => Math.max(0, Math.min(cfg.turn.maxSendsPerTurn - sends, followUpId ? 1 - sends : Infinity))
      const executeTool = async (tool: typeof tools[number], args: Record<string, unknown>) => {
        if (turnClosed) return 'error: 回合已结束，未执行'
        if (requiresClosing && tool !== finishTool) return 'error: 已进入收尾阶段，仅允许 simFinishTurn，未执行'

        if (!requiresClosing && tool === finishTool && Array.isArray(args.memories) &&
          args.memories.some(memory => ['pendingEvent', 'interaction'].includes(String(record(memory).kind)))) {
          return 'error: 本群社交记忆未保存。请先单独调用 simRemember 保存 pendingEvent 或 interaction，成功后再用 simFinishTurn 收尾。'
        }
        // A failed save cannot subsequently fall through the ordinary-text sender.
        if (tool === finishTool) requiresClosing = true
        if (tool.name === 'simWorkerTask' && ports.characterWorkerAvailable?.() === false) return 'error: 工作器连接已停用'
        if (!allowedTool(tool.name)) return 'error: 自主执行主体没有此工具权限，不能借用群友身份'
        try { await ensureExecution() } catch (error) { return safeToolErrorText(tool.name, error) }
        if (tool.name === 'simRemember') {
          proactiveSourceSeq = undefined
          if (args.kind === 'pendingEvent' && args.scope !== 'self' && actor.kind === 'user' && actor.userId &&
            (args.aboutUser === undefined || String(args.aboutUser) === actor.userId)) {
            args = { ...args, aboutUser: actor.userId }
            if (args.welcomeProactiveFollowUp === true &&
              await judgeSocial('follow_up', args.content) === 'explicit_invitation' &&
              triggerMessage && state!.recent.some(message => message.seq === triggerMessage.seq)) {
              proactiveSourceSeq = triggerMessage.seq
            }
            try { await ensureExecution() } catch (error) { return safeToolErrorText(tool.name, error) }
          }
        }
        if (tool === finishTool && args.choice === 'chat' && actor.kind === 'user' &&
          isDirectAddressKind(reason.kind) && sends === 0 && !requestedMessageMerge &&
          !args.memories && !args.goal && !args.atUserIds && !args.replyToSeq &&
          Array.isArray(args.messages) && args.messages.length > remainingMessageSlots() &&
          args.messages.length <= 5 && args.messages.every(message => typeof message === 'string' && message.trim() && message.length <= 500)) {
          requestedMessageMerge = true
          return `error: 本回合还可发送 ${remainingMessageSlots()} 条，尚未保存或发送。请把同一段解释合并到一条消息，再用 simFinishTurn 提交。`
        }
        const newGoal = tool === finishTool && args.choice === 'schedule' ? args.goal : tool.name === 'simGoal' && args.action === 'create' ? args : undefined
        if (newGoal && triggerMessage && ports.judgeSocialPermission) {
          if (await judgeSocial('goal', newGoal) !== 'own_goal') {
            // Nothing has been saved. Allow a valid chat or silent close.
            if (tool === finishTool) requiresClosing = false
            return 'error: 此安排没有核实为角色自己的目标。社交问候用 simRemember；请正常聊天或安静收尾。'
          }
          try { await ensureExecution() } catch (error) { return safeToolErrorText(tool.name, error) }
        }
        if ((decision === 'silent' || decision === 'deferred') && ['simSendMessage', 'simShareVideoCard', 'simSendPoke', 'simQzoneInteract', 'sendLocalEmojiTool'].includes(tool.name)) return 'error: 本轮已选择沉默或暂缓'
        if (tool === finishTool && Object.hasOwn(args, 'throughSeq') && (typeof args.throughSeq !== 'number' || !Number.isSafeInteger(args.throughSeq) || args.throughSeq < 0 || args.throughSeq > readThroughSeq(state!))) return 'error: throughSeq 超过了实际看过的范围或不是非负整数，本次未保存'
        if (tool === finishTool && Object.hasOwn(args, 'replyToSeq') && (typeof args.replyToSeq !== 'number' || !Number.isSafeInteger(args.replyToSeq) || args.replyToSeq < 1 || ![...state!.unread, ...state!.recent].some(message => message.seq === args.replyToSeq))) return 'error: replyToSeq 不是近期消息的有效序号，本次未保存'
        const internal = tool === finishTool || characterTools.includes(tool) || ['simGetState', 'simGetUnreadMessages', 'simGetRecentMessages', 'simGetMessageDetail', 'simMarkRead', 'simWaitForMessages', 'simSetWakeConfig', 'simGetGroupMembers', 'simGetMessageImages', 'simGetForward'].includes(tool.name)
          || (['simRemember', 'simLifeThread'].includes(tool.name) && args.action === 'list')
        if (internal) {
          const result = await runSimTool(tool, args, groupId, self.id, actor, toolReply)
          exposeToolResult(tool.name, result.slice(0, 4000))
          return result
        }
        const id = randomUUID()
        try {
          character = await characters.update(characterScope, current => focusedGoalId
            ? beginCharacterGoalAction(current, focusedGoalId, { id, toolName: tool.name }, now(), focusedGoalRevision)
            : recordCharacterReceipt(current, { id, toolName: tool.name, status: 'pending', summary: '等待工具回执', at: now() }, now()))
        } catch (error) { return safeToolErrorText(tool.name, error) }
        const pending = character.receipts.find(item => item.id === id)!
        // A cancellation arriving while persistence was pending must be observed before the external call.
        try { await ensureExecution() } catch (error) {
          character = await characters.update(characterScope, current => recordCharacterReceipt(current, { ...pending, status: 'failed', summary: '执行前已取消或授权变化，未调用工具', at: now() }, now()))
          return safeToolErrorText(tool.name, error)
        }
        let reported: 'succeeded' | 'failed' | undefined
        const alreadyUnknown = memoryBox.deliveryUnknown
        let result = await runSimTool(tool, args, groupId, self.id, actor, toolReply, status => { reported = status }, tool.name === 'simWorkerTask' ? id : undefined)
        const status = memoryBox.deliveryUnknown && !alreadyUnknown ? 'unknown' : reported ?? classifyCharacterResult(result)
        const summary = redactInternalStatusLeaks(result).text.slice(0, 500) || `${tool.name}: ${status}`
        const receipt: CharacterReceipt = { ...pending, status, summary, at: now() }
        // A lost final write leaves pending: recovery records unknown; never blindly repeat the side effect.
        character = await characters.update(characterScope, current => recordCharacterReceipt(current, receipt, now()))
        if (tool.name === 'simWorkerTask' && status === 'succeeded') {
          try {
            const value = record(JSON.parse(result)), artifact = record(value.artifact)
            if (typeof artifact.content === 'string' && typeof artifact.title === 'string') {
              await ensureExecution()
              const work = await workspace.write({ title: artifact.title.slice(0,120), kind: 'research', content: artifact.content, evidenceRefs: [`receipt:${id}`], ...(sharedIds.length ? {sharedSources: sharedIds} : {}) })
              result = formatSavedCharacterWorkResult(String(value.summary || ''), id, work, artifact.content)
            }
          } catch { result = JSON.stringify({ status, summary: '工作器返回成功，但作品未能保存，请核对回执后处理。' }) }
        }
        if (status === 'unknown' && focusedGoalId && !AUTONOMOUS_EXTRA_TOOLS.includes(tool.name)) {
          character = await characters.update(characterScope, current => {
            const goal = current.goals.find(item => item.id === focusedGoalId)
            return goal && ['active', 'waiting'].includes(goal.status)
              ? transitionCharacterGoal(current, goal.id, 'paused', { now: now(), lastOutcome: '外部动作结果未知，暂停以免重复副作用；核对后由管理员恢复' }) : current
          })
        }
        visibleCharacterRefs.add(`receipt:${id}`)
        sourceResults.set(`receipt:${id}`, { toolName: tool.name, content: result.slice(0, 8000), truncated: result.length > 8000 })
        return `${result}\n【运行时行动回执】${JSON.stringify({ evidenceRef: `receipt:${id}`, status, goalId: focusedGoalId })}`
      }
      const executionConfig = ports.getExecutionConfig()
      const providerConfig = record(executionConfig) as Parameters<typeof buildChatRequestData>[0]
      const systemPrompt = buildSimSystemPrompt({ persona: persona.persona, systemContent: persona.systemContent, selfName: self.name, hasExtraTools: extraTools.length > 0, extraToolNames, hasEmojiTool: extraToolNames.includes('sendLocalEmojiTool'), hasMoodTool: cfg.mood.enabled, availableToolNames: tools.filter(tool => allowedTool(tool.name)).map(tool => tool.name) })

      const history: SimHistoryMessage[] = [...projectedHistory, wakeMessage]
      const firstCurrentMessage = projectedHistory.length
      type RawToolCall = NonNullable<SimHistoryMessage['tool_calls']>[number]
      let rounds = 0
      // 用户对话/正式托付的未外发文本兜底：自主回合的最终文本只留在内部历史。
      let nudgedForUnsent = false
      while (rounds < cfg.turn.maxToolRounds) {
        rounds += 1
        const closing = requiresClosing || rounds > cfg.turn.maxToolRounds - 2
        const roundTools = closing ? [finishTool] : tools.filter(tool => allowedTool(tool.name))
        const context = buildCharacterTurnContext({ phase: closing ? 'closing' : 'acting', remainingToolRounds: cfg.turn.maxToolRounds - rounds + 1, remainingMessageSlots: remainingMessageSlots(), ...(focusedGoalId ? { focusedGoalId } : {}), visibleEvidenceRefs: visibleEvidenceRefs() }) +
          (anchor ? `\n当前只回应 #${anchor.seq} 的话题；同一人的前文也仅在有关时用。throughSeq 当前上限是 ${readThroughSeq(state)}，可省略。\n被问自己的口味时，先看本轮的角色自身状态，沿用相关的最新判断。新形成了可延续的口味，或新反馈让你改变原有判断，就把选择和理由放在同一条 simFinishTurn.messages，在同次提交的 memories 里保存 opinion/inferred（来源可引用 message:${anchor.seq}；修订还要引用旧记忆并填写 supersedes）。` : '') +
          (interaction ? `\n${buildPersonaReplyModePrompt({ interactionContext: interaction })}` : '') +
          (reviewer ? `\n本轮剩余提交检查次数：${Math.max(0, 3 - reviewer.stats().checks)}。将需要保存的观点、目标和最终消息合并进 simFinishTurn；检查退回后自行修正或安静放弃，检查提示不发到群里。` : '')
        const requestHistory = history.map(({ conversationUserId: _user, ...message }) => message)
        const requestData = buildChatRequestData(providerConfig, [{ role: 'system', content: systemPrompt }, ...requestHistory, { role: 'user', content: context }], simToolsAsFunctions(roundTools), closing ? 'required' : 'auto')
        if (closing && (!requestData.tools?.length || !requestData.tool_choice)) {
          logger.warn(`[仿真] 群 ${groupId} 模型配置未提供收尾工具，停止本轮`)
          break
        }
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
          // 先保留模型最终文本；自主回合是否发言必须由显式发送工具决定。
          if (text) history.push({ role: 'assistant', content: text })
          if (closing || actor.kind === 'autonomous') {
            if (text) logger.info(`[仿真] 群 ${groupId} 自主回合最终文本仅保留内部历史（${text.length} 字），结束回合`)
            break
          }
          // 兜底：写了像"要说的话"的文本但本回合一条都没发过 → 提醒一次（模型惯性问题，实测高发）。
          // 沉默声明（「旁听，结束回合。」「无需发送，结束回合。」）除外：那是模型在宣布不说话，
          // 提醒/直发都会把元话术漏进群里——按其意愿安静结束。
          if (!decision && text.length >= 6 && sends === 0 && !/^\[(?:不发了|SILENT|沉默)\]$/.test(text) && !isSilentDeclaration(text)) {
            if (!nudgedForUnsent) {
              nudgedForUnsent = true
              logger.info(`[仿真] 群 ${groupId} 检测到未外发文本（${text.length} 字，本回合 0 发送），已提醒模型用 simSendMessage 发出`)
              history.push({ role: 'user', content: '【系统提醒】你刚才写的这段话群友看不到——本模式下只有 simSendMessage 发出的内容才会出现在群里，群里刚才只能看到你发的表情/动作。如果那段话就是你想说的，现在用 simSendMessage 原样（或更口语化、可拆几条）发出去；如果改变主意不想说了，从此不要再输出任何文字——「无需发送」「结束回合」「已静默结束」「不是对我说的」「(已经决定不说话)」这类说明不要写，括号里的状态标注也一样不行，直接停下即可。' })
              continue
            }
            // 提醒过一次还是把话写在文本里(实测高发:连续多轮 6 字文本 0 发送,群里看着就是已读不回)——
            // 直接替它发出去。内容照原样,不走模型再加工,避免又一轮哑火。
            // 最后防线：提醒后还输出含元话术的文本，按沉默处理不直发——漏发可以下轮补，误发进群里收不回。
            // ①词表拦截（子串级）；②形状拦截（2026-11-09 实拍「(已经决定不说话，直接停。)」漏网后新增）：
            //   整条被括号/引号包裹的"状态标注"一律不直发——词表追不上模型造句，形状是稳定的；
            //   真想发言写裸文本，括号动作（（笑））远短于 6 字门槛。
            if (mentionsSilenceVocabulary(text) || isWrappedAnnotation(text)) {
              logger.info(`[仿真] 群 ${groupId} 提醒后文本仍含元话术或为括号标注（${text.slice(0, 24)}），按沉默处理不直发`)
            } else {
              logger.info(`[仿真] 群 ${groupId} 提醒后仍未发送，兜底直发 ${text.length} 字`)
              try {
                const sender = simulationTools.find(tool => tool.name === 'simSendMessage')!
                const result = await executeTool(sender, { continuation: 'chat', messages: [text.slice(0, cfg.turn.messageTextMaxChars)] })
                history.push({ role: 'user', content: classifyCharacterResult(result) === 'succeeded' ? '【系统】已替你把上面那段话发出去了。以后想说的话必须自己调 simSendMessage。' : `【系统】这段文本未确认发送：${result.slice(0, 1000)}` })
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
          if (turnClosed) {
            resultText = 'error: 回合已结束，未执行'
          } else if (closing && name !== finishTool.name) {
            resultText = 'error: 当前仅允许 simFinishTurn 收尾，未执行'
          } else if (!tool) {
            resultText = `error: 未知工具 ${name}`
          } else {
            let args: Record<string, unknown>
            try { args = record(JSON.parse(String(fn.arguments || '{}'))) } catch { args = {} }
            const textOutsideTool = typeof message.content === 'string' && message.content.trim()
            const missingChatMessage = tool === finishTool && args.choice === 'chat' && actor.kind === 'user' &&
              isDirectAddressKind(reason.kind) && sends === 0 && toolCallsRaw.length === 1 &&
              (!Array.isArray(args.messages) || args.messages.length === 0) &&
              textOutsideTool && !isSilentDeclaration(textOutsideTool)
            if (missingChatMessage && !nudgedForUnsent && rounds < cfg.turn.maxToolRounds) {
              nudgedForUnsent = true
              resultText = 'error: 回复正文写在工具参数外，群友看不到，且本次没有提交。请把想发送的正文写进 simFinishTurn 的 messages 再提交；选择安静收尾时无需发送。'
            } else if (name === 'sendLocalEmojiTool') {
              // 仿真回合表情冷却：跨回合短冷却防刷屏（与主链路 postSendCooldownMs 同参）
              const cooldownMs = safeNumber(() => ports.getEmojiCooldownMs?.()) || 90_000
              const lastAt = emojiLastSentAt.get(groupId) || 0
              if (now() - lastAt < cooldownMs) {
                const waitSec = Math.ceil((cooldownMs - (now() - lastAt)) / 1000)
                resultText = `error: 表情包冷却中（还要 ${waitSec} 秒）。请直接用文字回应，本回合不要再发表情。`
              } else {
                resultText = await executeTool(tool, args)
                if (!(typeof resultText === 'string' && resultText.startsWith('error:'))) emojiLastSentAt.set(groupId, now())
              }
            } else {
              resultText = await executeTool(tool, args)
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
        if (turnClosed) break
      }

      recordWakeTokens(state, tokens)
      const latestCharacter = await characters.load(characterScope)
      const removedSource = [...sourceMemoryIds].some(id => !latestCharacter.memories.some(memory => memory.id === id)) || await store.loadActivityVersion(groupId) !== activityVersion || await shared.fingerprint() !== sharedFingerprint
      const thisTurn = history.slice(firstCurrentMessage).map(message => conversationUserId ? { ...message, conversationUserId } : message)
      state.agentHistory = removedSource ? [] : trimAgentHistory([...priorHistory, ...thisTurn], cfg.turn.historyMaxMessages, cfg.turn.historyMaxChars)
      if (removedSource) delete state.lastConfirmedChat
      if (sends > 0 && !removedSource && actor.kind === 'user' && actor.userId && memoryBox.sentTexts.length) {
        state.lastConfirmedChat = { at: now(), userId: actor.userId, text: memoryBox.sentTexts.slice(-2).join('\n').slice(-500) }
      }
      if (sends > 0) {
        const lastSent = memoryBox.sentTexts.at(-1) || ''
        const interlocutorScore = Number(affinity[state.conversation.lastTriggerUserId || '']?.score ?? 50)
        const multiplier = Math.min(2, (/[?？]/.test(lastSent) ? 1.5 : 1) * (sends >= 3 ? 1.3 : 1) * (interlocutorScore >= 81 ? 0.87 : 1))
        state.nextReplyCheckAt = now() + Math.floor(cfg.wake.replyCheckMs * multiplier)
      }
      // 仿真群不走主链路，情节记忆在这里补记：让"这两天做过什么"持续有料
      if (sends > 0) {
        try {
          const trigger = actor.kind === 'user' ? state.recent.find(message => message.seq === reason.seq) : undefined
          const replyText = memoryBox.sentTexts.slice(0, 2).join(' / ').slice(0, 200)
          if (replyText) {
            ports.recordEpisode?.({
              groupId,
              ...(trigger?.userId ? { userId: trigger.userId, userName: trigger.name } : {}),
              summary: trigger ? `${trigger.name}说：${trigger.text}`.slice(0, 120) : `${actor.kind === 'commitment' ? '履行托付' : '主动行动'}（${reason.kind}${focusedGoalId ? `，目标 ${focusedGoalId}` : ''}）`,
              reply: replyText,
            })
          }
        } catch { /* 情节补记失败不影响回合 */ }
      }
      // 已在本回合展示的普通触发可消费。其他人的点名仍需独立回应，即使用户查过那条消息。
      const replay = state.pendingWakeReasons.filter(pending =>
        pending.seq !== reason.seq || pending.kind !== reason.kind).filter(pending =>
        (isDirectAddressKind(pending.kind) && state!.recent.some(message => message.seq === pending.seq)) ||
        messageReasonStillPending(pending, state!.unread))
      const [next, ...remaining] = replay
      state.pendingWakeReasons = remaining
      await store.save(groupId, state)
      nextWake = next
      logger.info(`[仿真] 群 ${groupId} 回合完成 wake=${reason.kind} rounds=${rounds} toolCalls=${toolCalls} sends=${sends} tokens=${tokens} ms=${now() - startedAt}`)
    } catch (error) {
      logger.error(`[仿真] 群 ${groupId} 回合异常`, error)
    } finally {
      running.delete(groupId)
      liveStates.delete(groupId)
      void store.clearBusy(groupId)
    }
    if (nextWake && !stopped) await scheduleWake(groupId, nextWake)
  }

  function buildToolContext(groupId: string, state: SimSessionState, cfg: SimRuntimeConfig, addSends: (delta: number) => void, memoryBox: { list: SimMemoryEntry[]; sentTexts: string[]; deliveryUnknown?: boolean }, affinityBox: { map: SimAffinityMap }, selfMemoryBox: { list: SimMemoryEntry[] }, moodBox: { current: SimMoodState | null } = { current: null }, moodAnchor: Record<MoodAxis, number> | null = null, scope = scopeFor(groupId, state.botId), beforeSend?: () => Promise<void>, totalSends?: () => number, reviewSend?: (messages: string[]) => Promise<void>, directAddress = false): SimToolContext {
    const store = scopedStore(scope)
    let sendsThisTurn = 0
    const context: SimToolContext = {
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
        if (memoryBox.deliveryUnknown) return { ok: false, sent: 0, unknown: true, error: '上次发送结果未知，本回合不再发送，请核对回执' }
        const cleaned: string[] = []
        for (let i = 0; i < messages.length; i++) {
          const redacted = redactInternalStatusLeaks(messages[i])
          if (redacted.heavy) return { ok: false, sent: 0, error: `第 ${i + 1} 条包含大量内部状态特征，整批未发送，请换一句自然的说法` }
          cleaned.push(redacted.text)
        }
        const plan = planMessageDelivery({ messages: cleaned, deliveredTexts: memoryBox.sentTexts, state, config: cfg, at: now(), sendsThisTurn: totalSends?.() ?? sendsThisTurn, directAddress })
        if (!plan.ok) return { ok: false, sent: 0, error: plan.error, duplicatesSkipped: plan.duplicatesSkipped }
        let sent = 0, inFlight = false
        const failed = (error: string): SimSendResult => ({ ok: false, sent, duplicatesSkipped: plan.duplicatesSkipped, ...(memoryBox.deliveryUnknown ? { unknown: true } : {}), error })
        try {
          if (plan.messages.length) await reviewSend?.(plan.messages)
          // Review may take time. Check the entire remaining batch again before its first send.
          const latest = planMessageDelivery({ messages: plan.messages, deliveredTexts: memoryBox.sentTexts, state, config: cfg, at: now(), sendsThisTurn: totalSends?.() ?? sendsThisTurn, directAddress })
          if (!latest.ok) return failed(latest.error)
          for (let i = 0; i < latest.messages.length; i++) {
            await beforeSend?.()
            const itemAllowance = checkSendAllowance(state, cfg, now(), totalSends?.() ?? sendsThisTurn, directAddress)
            if (!itemAllowance.allowed) return failed(itemAllowance.reason)
            const text = latest.messages[i]!
            const segments: unknown[] = []
            if (i === 0 && opts.replyToMessageId !== undefined && opts.replyToMessageId !== null && opts.replyToMessageId !== '') segments.push({ type: 'reply', data: { id: String(opts.replyToMessageId) } })
            for (const userId of opts.atUserIds || []) segments.push({ type: 'at', data: { qq: String(userId) } })
            segments.push({ type: 'text', data: { text } })
            inFlight = true
            const receipt = await ports.sendGroupMessage(groupId, segments, scope.botId)
            inFlight = false
            if (receipt.unknown) { memoryBox.deliveryUnknown = true; return failed(`第 ${sent + 1} 条回执未确认，是否送达未知，本回合不再发送（已确认 ${sent} 条）`) }
            if (!receipt.ok) return failed(`第 ${sent + 1} 条发送失败：${receipt.error || '网关错误'}（已确认 ${sent} 条，不自动重发）`)
            sent++
            sendsThisTurn++
            addSends(1)
            memoryBox.sentTexts.push(text)
            markConversationEngaged(state, state.conversation.lastTriggerUserId || '', cfg.wake.continuationWindowMs)
            const memeBumped = bumpMemeUsage(memoryBox.list, text, now()).length > 0
            recordSend(state, now(), 1)
            state.lastAiSendAt = now()
            invalidatePreSleepWaitByParticipation(state)
            // Confirmed delivery is durable before another network side effect.
            await store.save(groupId, state)
            if (memeBumped) await store.saveMemories(groupId, memoryBox.list)
            if (i < latest.messages.length - 1) await sleep(boundedTimerDelay(cfg.turn.minSendGapMs + 400 + Math.floor(random() * 2600), 60_000))
          }
          return { ok: true, sent, duplicatesSkipped: plan.duplicatesSkipped }
        } catch (error) {
          if (inFlight) memoryBox.deliveryUnknown = true
          return failed(`${inFlight ? '传输中断，是否送达未知，本回合不再发送' : error instanceof Error ? error.message : '发送中断'}（已确认 ${sent} 条，不自动重发）`)
        }
      },
      waitForMessages: async (rawPlan: SimWaitPlan, filter?: (message: SimMessage) => boolean): Promise<SimWaitResult> => {
        const plan = normalizeWaitPlan(rawPlan, cfg.turn.waitQuietMaxMs, cfg.turn.waitTimeoutMaxMs)
        const baselineSeq = state.seq
        const baselineReadThrough = readThroughSeq(state)
        const startAt = now()
        const deadline = startAt + plan.timeoutMs
        for (;;) {
          const at = now()
          const arrived = state.unread.filter(m => m.seq > baselineSeq && (!filter || filter(m))).slice(-4)
          const lastNewIncomingAt = arrived.length ? Math.max(...arrived.map(m => m.at)) : state.lastIncomingAt
          let done: boolean
          if (plan.purpose === 'reply') {
            done = at - Math.max(state.lastIncomingAt, 0) >= plan.quietMs
          } else {
            done = arrived.length >= plan.minNewMessages && at - Math.max(lastNewIncomingAt, 0) >= plan.minQuietAfterNewMs
          }
          if (done || at >= deadline) {
            const outcome = computeWaitOutcome(state, plan, arrived, at, lastNewIncomingAt, at >= deadline && !done)
            const seqs = arrived.map(m => m.seq)
            noteModelSeen(state, seqs)
            context.noteVisibleMessages?.(seqs)
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
      saveMemories: async memories => { await store.saveMemories(groupId, memories); memoryBox.list = memories },
      getAffinity: () => affinityBox.map,
      saveAffinity: async map => { await store.saveAffinity(groupId, map); affinityBox.map = map },
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
        saveSelfMemories: async (list: SimMemoryEntry[]) => { await store.saveSelfMemories(list); selfMemoryBox.list = list },
      } : {}),
      ...(cfg.mood.enabled && typeof store.saveMood === 'function' ? {
        getMood: () => (moodBox.current ? { summary: moodSummaryLine(moodBox.current, now(), cfg.mood.halfLifeMs) } : null),
        updateMood: async (deltas: Parameters<NonNullable<SimToolContext['updateMood']>>[0], reason: string) => {
          const result = applyMoodUpdate({ mood: moodBox.current, deltas, reason, now: now(), halfLifeMs: cfg.mood.halfLifeMs, maxStep: cfg.mood.maxStep, ...(moodAnchor ? { turnAnchor: moodAnchor } : {}) })
          // 全部被包络夹成零变化 → 不落盘（更新 updatedAt 会白刷新衰减起点，等于无事件续命情绪）
          if (!Object.values(result.applied).some(v => v !== 0)) return { error: '没有产生实际变化（可能已到本轮变化上限）' }
          await store.saveMood(result.mood)
          moodBox.current = result.mood
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
      ...(typeof ports.qzoneInteract === 'function' ? { qzoneInteract: async (input: { action: 'visit' | 'like' | 'comment'; userId?: string; tid?: string; text?: string }) => {
        if (memoryBox.deliveryUnknown) return { ok: false, error: '上次发送结果未知，本回合不再进行外部互动，请核对回执' }
        await beforeSend?.()
        return ports.qzoneInteract!(input)
      } } : {}),
      pokeMember: async (userId: string) => {
        if (memoryBox.deliveryUnknown) return { ok: false, error: '上次发送结果未知，本回合不再发送，请核对回执' }
        if (typeof ports.pokeMember !== 'function') return { ok: false, error: '戳一戳不可用' }
        if (!/^\d{1,12}$/.test(userId)) return { ok: false, error: 'userId 必须是 QQ 号' }
        const window = (pokeTimes.get(groupId) || []).filter(t => now() - t < 3600_000)
        if (window.length >= 6) return { ok: false, error: '本小时戳人次数已达上限（6），别把人戳烦了' }
        await beforeSend?.()
        const receipt = await ports.pokeMember(groupId, userId, scope.botId)
        if (receipt.ok) { window.push(now()); pokeTimes.set(groupId, window) }
        return receipt
      },
      getGroupMembers: async () => {
        if (typeof ports.getGroupMembers !== 'function') return { error: '群成员查询不可用' }
        try {
          const members = await ports.getGroupMembers(groupId, scope.botId)
          const activeIds = new Set(state.recent.map(m => m.userId))
          const sorted = [...members].sort((a, b) => Number(activeIds.has(b.userId)) - Number(activeIds.has(a.userId)))
          return sorted.slice(0, 40).map(m => ({ userId: m.userId, nick: m.nick, active: activeIds.has(m.userId) }))
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) }
        }
      },
      getForward: async (forwardId: string) => {
        if (typeof ports.getForwardContent !== 'function') return { lines: [], error: '合并转发查看不可用' }
        const result = await ports.getForwardContent(String(forwardId || '').slice(0, 64), scope.botId)
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
        if (memoryBox.deliveryUnknown) return { ok: false, unknown: true, error: '上次发送结果未知，本回合不再发送，请核对回执' }
        if (typeof ports.resolveBilibiliCard !== 'function') return { ok: false, error: 'B站卡片分享不可用' }
        const last = videoCardAt.get(groupId) || 0
        if (now() - last < 20 * 60_000) {
          const waitSec = Math.ceil((20 * 60_000 - (now() - last)) / 1000)
          return { ok: false, error: `B站卡片冷却中（还要 ${waitSec} 秒）。别刷屏，本回合换文字说。` }
        }
        const resolved = await ports.resolveBilibiliCard(input || {})
        if (!resolved.ok) return { ok: false, error: resolved.error || '没找到合适的视频' }
        await beforeSend?.()
        const allowance = checkSendAllowance(state, cfg, now(), totalSends?.() ?? sendsThisTurn, directAddress)
        if (!allowance.allowed) return { ok: false, error: allowance.reason }
        let receipt
        try { receipt = await ports.sendGroupMessage(groupId, [{ type: 'json', data: { data: resolved.cardJson || '' } }], scope.botId) }
        catch { memoryBox.deliveryUnknown = true; return { ok: false, unknown: true, error: '卡片传输中断，是否送达未知，本回合不再发送' } }
        if (receipt.unknown) { memoryBox.deliveryUnknown = true; return { ok: false, unknown: true, error: '卡片回执未确认，是否送达未知，本回合不再发送' } }
        if (!receipt.ok) return { ok: false, error: receipt.error || '卡片发送失败' }
        videoCardAt.set(groupId, now())
        addSends(1)
        sendsThisTurn += 1
        recordSend(state, now(), 1)
        state.lastAiSendAt = now()
        await store.save(groupId, state)
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
    return context
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
    if (stopped) return
    await refreshGroupState(true)
    const cfg = runtimeConfig()
    // allGroups 模式下无法枚举白名单群，sweep 遍历「登记过的群」∩ 当前生效判定
    const groups = knownGroupsCache.filter(groupId => groupActive(cfg, groupId))
    for (const groupId of groups) {
      if (running.has(groupId) || background.has(groupId) || pendingWakes.has(groupId) || retryTimers.has(groupId)) continue
      let state: SimSessionState
      try { state = await store.load(groupId) } catch (error) { logger.error(`[仿真] 群 ${groupId} sweep 读取失败`, error); continue }
      const at = now()
      const reasons: SimWakeReason[] = []
      let scheduleChanged = false
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
        scheduleChanged = true
        if (state.unread.some(message => message.at > state.lastAiSendAt && (message.atSelf || message.quoteToSelf || (!message.atOther && !message.replyToUserId)))) {
          reasons.push({ kind: 'replyCheck' })
        }
      }
      // 仅@才回的群不主动冒泡：静默期检查照常排期，但不产生 proactiveCheck 唤醒；睡眠窗口内同样不冒泡
      const atOnly = (overridesCache?.atOnly || []).includes(groupId)
      let sleepingNow = false
      if (cfg.rhythm.enabled) {
        const rhythmWin = await loadRhythmWindow(cfg, scopeFor(groupId, state.botId))
        sleepingNow = isSleeping(new Date(now() + 8 * 3600_000).getUTCHours(), rhythmWin)
      }
      if (!atOnly && !sleepingNow && state.lastIncomingAt > 0 && at - state.lastIncomingAt >= cfg.wake.proactiveIdleMs && at >= state.nextProactiveCheckAt) {
        state.nextProactiveCheckAt = at + cfg.wake.proactiveCheckMinMs + Math.floor(random() * Math.max(1, cfg.wake.proactiveCheckMaxMs - cfg.wake.proactiveCheckMinMs))
        scheduleChanged = true
        if (cfg.wake.proactiveProbability > 0) {
          try {
            const memories = normalizeMemoryList(await store.loadMemories(groupId), at)
            const next = dueMemories(memories, at).find(item => item.proactiveSourceSeq !== undefined && !state.offeredFollowUpIds?.includes(item.id))
            if (next) reasons.push({ kind: 'proactiveCheck', detail: next.id })
            else if (state.recent.some(message => message.seq > (state.lastProactiveCheckedSeq ?? 0) && message.at > state.lastAiSendAt) &&
              random() < cfg.wake.proactiveProbability) reasons.push({ kind: 'proactiveCheck' })
          } catch (error) {
            logger.warn(`[仿真] 群 ${groupId} 社交跟进检查失败：${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
      if (!atOnly && !sleepingNow) {
        try {
          const scope = scopeFor(groupId, state.botId)
          await recoverCharacter(scope)
          const current = await characters.update(scope, value => expireCharacterGoals(value, at))
          const due = dueCharacterGoal(current, at)
          if (due) reasons.push({ kind: 'characterGoal', detail: due.id })
        } catch (error) { logger.warn(`[仿真] 群 ${groupId} 角色目标检查失败：${error instanceof Error ? error.message : String(error)}`) }
      }
      const hasWake = reasons.length > 0
      if (hasWake || scheduleChanged) await store.save(groupId, state)
      if (hasWake) {
        const [first, ...rest] = reasons
        if (first) {
          const best = rest.reduce((acc, r) => mergeWakeReason(acc, r).reason, first)
          await scheduleWake(groupId, best, cfg)
        }
      }
      if (!hasWake && !running.has(groupId) && !background.has(groupId) && !atOnly && !sleepingNow) await runCharacterBackground(groupId, state, cfg)
      // 本群专属梗自动提取（独立于唤醒：不产生回合，只沉淀记忆）
      if (!hasWake && !running.has(groupId)) await maybeExtractMemes(groupId, state, cfg)
      if (!hasWake && !running.has(groupId)) await maybeExtractPersonProfiles(groupId, state, cfg)
      // 按人挖口头禅（风格个性化）：冷却默认 6h，读归档 → 纯函数挖掘 → Redis
      if (!hasWake && !running.has(groupId)) await maybeMineUserStyle(groupId, cfg)
      if (!hasWake && !running.has(groupId)) await maybeSyncLifeThreads(cfg, scopedStore(scopeFor(groupId, state.botId)))
      // 健康哨兵：全局每小时跑一次（挂在第一个群的 sweep 里）
      if (now() - healthSentinelLastRun > 3600_000) {
        healthSentinelLastRun = now()
        void runHealthSentinel()
      }
    }
  }

  /** One bounded background activity per group; no chat-sending port is passed to reflection. */
  async function runCharacterBackground(groupId: string, state: SimSessionState, cfg: SimRuntimeConfig): Promise<void> {
    background.add(groupId)
    liveStates.set(groupId, state)
    const scope = scopeFor(groupId, state.botId)
    const shared = sharedFor(scope)
    let fingerprint = ''
    let sources = new Set<string>()
    const controller = new AbortController()
    let activityVersion = ''
    backgroundControllers.add(controller)
    backgroundByGroup.set(groupId, controller)
    const guard = async () => {
      if (stopped || controller.signal.aborted) throw new Error('后台活动已停止')
      await refreshGroupState(true)
      if (!groupActive(runtimeConfig(), groupId) || (overridesCache?.atOnly || []).includes(groupId) || scopeFor(groupId, state.botId).personaId !== scope.personaId) throw new Error('角色活动范围已改变')
      const current = await characters.load(scope)
      if (current.paused || [...sources].some(id => !current.memories.some(m => m.id === id)) || await shared.fingerprint() !== fingerprint) throw new Error('角色暂停或来源已撤销')
      if (await store.loadActivityVersion(groupId) !== activityVersion) throw new Error('角色活动已撤销')
    }
    try {
      activityVersion = await store.loadActivityVersion(groupId)
      fingerprint = await shared.fingerprint()
      sources = new Set((await characters.load(scope)).memories.map(m => m.id))
      await guard()
      if (!checkWakeBudget(state, runtimeConfig(), now(), safeNumber(() => ports.getTodaySpendCny?.(groupId)), null, groupId).allowed) return
      const subscriptions = subscriptionsFor(scope)
      const dueSubscriptions = (await subscriptions.list()).some(item => item.status === 'active' && item.nextPollAt <= now())
      const pollReceiptId = dueSubscriptions ? randomUUID() : undefined
      if (pollReceiptId) await characters.update(scope, current => recordCharacterReceipt(current, { id: pollReceiptId, toolName: 'simSubscriptionPoll', status: 'pending', summary: '等待公开订阅抓取回执', at: now() }, now()))
      let update: Awaited<ReturnType<typeof subscriptions.poll>>
      try {
        update = await subscriptions.poll(guard)
        if (pollReceiptId) await characters.update(scope, current => recordCharacterReceipt(current, {
          id: pollReceiptId, toolName: 'simSubscriptionPoll', status: update.unknowns ? 'unknown' : update.failures && !update.updates.length ? 'failed' : 'succeeded',
          summary: (update.updates.length ? `取得公开订阅资料（未经事实核实）：${update.updates.slice(0,3).map(item => item.title).join('；')}${update.failures ? `；另有${update.failures}个订阅未取得结果` : ''}` : update.unknowns ? `${update.unknowns}个订阅超时，结果未知，未取得新资料` : update.failures ? `${update.failures}个订阅抓取失败，未取得新资料` : '订阅检查完成，没有新资料').slice(0,500), at: now(),
        }, now()))
      } catch (error) {
        if (pollReceiptId) await characters.update(scope, current => recordCharacterReceipt(current, { id: pollReceiptId, toolName: 'simSubscriptionPoll', status: 'unknown', summary: '订阅检查中断，结果未知', at: now() }, now()))
        throw error
      }
      await guard()
      if (update.updates.length) {
        state.pendingWakeReasons = pushPendingReason(state.pendingWakeReasons, { kind: 'interestUpdate', detail: update.updates.slice(0,2).map(item => item.title).join('；').slice(0,200) })
        await store.save(groupId, state)
      }
      if (!update.updates.length && ports.reflectCharacter && ports.getSection().reflection?.enabled !== false) {
        const reflection = reflectionFor(scope)
        await reflection.run({ guard, sharedSources: (await shared.projection()).map(item => item.id),
          ...(ports.getSection().consistency?.enabled === true ? { review: async (candidate: Record<string, unknown>, before: CharacterState, evidence: unknown) => {
            await guard()
            if (ports.getSection().consistency?.enabled !== true) return
            const reviewer = createCharacterConsistencyReviewer({ maxChecks: 1,
              infer: (request, signal) => {
                if (!ports.reviewCharacter) throw new Error('角色审核端口未配置')
                return ports.reviewCharacter(request, ports.getExecutionConfig(), AbortSignal.any([signal, controller.signal]))
              },
              onResult: result => {
                recordWakeTokens(state, Number(record(result.usage).total_tokens) || 0)
                try { ports.recordTokens?.({ scope: groupId, stage: 'character-consistency', model: result.model ?? '', usage: result.usage, ms: result.ms }) } catch { /* wake ledger still contains reported tokens */ }
              },
            })
            const normalized = { ...candidate, updates: Array.isArray(candidate.updates) ? candidate.updates.map(item => ({ ...record(item), epistemic: 'inferred' })) : candidate.updates }
            const verdict = await reviewer.review({ toolName: 'characterReflection', candidate: normalized, state: before, sources: evidence })
            await store.save(groupId, state)
            await guard()
            if (verdict.verdict !== 'accept') throw new Error(`反思一致性检查未通过，本次变更未保存：${verdict.error || JSON.stringify(verdict.issues)}`)
          } } : {}),
          reserve: async () => {
            await guard()
            if (!checkWakeBudget(state, runtimeConfig(), now(), safeNumber(() => ports.getTodaySpendCny?.(groupId)), null, groupId).allowed) throw new Error('反思预算已达到上限')
            rollBudgetDay(state, now()); recordWake(state, now()); await store.save(groupId, state)
          },
          infer: async prompt => {
            const timeout = setTimeout(() => controller.abort(), 30_000)
            timeout.unref?.()
            try {
              const response = await ports.reflectCharacter!({ messages: [{ role: 'system', content: prompt }, { role: 'user', content: '请根据以上材料进行本次反思，只返回规定 JSON。' }], temperature: 0.3, max_tokens: 1200 }, ports.getExecutionConfig(), controller.signal)
              const usage = record(response.usage)
              recordWakeTokens(state, Number(usage.total_tokens) || 0)
              await store.save(groupId, state)
              ports.recordTokens?.({ scope: groupId, stage: 'character-reflection', model: String(response.model || ''), usage })
              if (response.error) throw new Error('反思模型返回错误')
              const content = response.choices?.[0]?.message?.content
              if (typeof content !== 'string' || content.length > 12_000) throw new Error('反思未返回有效结构')
              return content
            } finally { clearTimeout(timeout) }
          },
        })
      }
    } catch (error) { logger.warn(`[仿真] 群 ${groupId} 后台活动停止：${error instanceof Error ? error.message : String(error)}`) }
    finally {
      let pending: SimWakeReason[] = []
      let finalSave: Promise<void> | undefined
      try {
        // Keep sharing the live object until the in-flight snapshot settles. Ingress may
        // add messages and wakes while Redis is slow; capture those only after this await.
        await store.save(groupId, state)
        pending = state.pendingWakeReasons.filter(reason => messageReasonStillPending(reason, state.unread))
        state.pendingWakeReasons = []
        // Queue the handoff snapshot before releasing ownership. New loads wait for this
        // write, and all session SETs execute in order so an old SET cannot erase ingress.
        finalSave = store.save(groupId, state)
      } finally {
        backgroundControllers.delete(controller)
        backgroundByGroup.delete(groupId)
        background.delete(groupId)
        liveStates.delete(groupId)
      }
      await finalSave
      if (!stopped && pending.length) await scheduleWake(groupId, pending.reduce((a,b) => mergeWakeReason(a,b).reason), cfg)
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
  async function maybeSyncLifeThreads(cfg: SimRuntimeConfig, store: SimSessionStore): Promise<void> {
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
    stopped = false
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
    stopped = true
    for (const controller of backgroundControllers) controller.abort()
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
  async function loadRhythmWindow(cfg: SimRuntimeConfig, scope?: CharacterScope): Promise<RhythmWindow> {
    if (!scope && rhythmCache && now() - rhythmCache.at < 60_000) return rhythmCache.win
    const stored = await (scope ? scopedStore(scope) : store).loadRhythm().catch(() => null)
    const adminDefault = scope && !stored ? await store.loadRhythm().catch(() => null) : null
    const effective = stored ?? (adminDefault?.setBy === 'admin' ? adminDefault : null)
    const win = effective ? { sleepFrom: effective.sleepFrom, sleepTo: effective.sleepTo } : { sleepFrom: cfg.rhythm.sleepFrom, sleepTo: cfg.rhythm.sleepTo }
    if (!scope) rhythmCache = { at: now(), win }
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
    backgroundByGroup.get(groupId)?.abort()
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
      backgroundByGroup.get(groupId)?.abort()
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
    if (background.has(groupId)) return '后台角色活动进行中，请暂停自主行动并稍后重试重置'
    if (running.has(groupId)) return '该群有仿真回合正在进行，请稍后再重置'
    const cfg = runtimeConfig()
    const previous = await store.load(groupId)
    const reset = await store.reset(groupId, cfg.agentPresetKeywords)
    // Evidence uses message:seq; a session reset must never reuse an old source identifier.
    reset.seq = previous.seq
    reset.lastReadThroughSeq = previous.seq
    if (previous.botId) reset.botId = previous.botId
    if (previous.personaId) reset.personaId = previous.personaId
    await store.save(groupId, reset)
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
    if (state.botId && state.botId !== self.id) return true
    state.botId = self.id
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
    if ((running.has(groupId) || background.has(groupId) || liveStates.has(groupId)) && reason) {
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

  async function describeProfile(character: CharacterState, state: SimSessionState, cfg: SimRuntimeConfig): Promise<CharacterProfile> {
    const { scope } = character
    const selfStore = scopedStore(scope)
    const at = now()
    const [rawMood, window, rawHabits, rawLife] = await Promise.all([
      cfg.mood.enabled ? selfStore.loadMood() : null,
      loadRhythmWindow(cfg, scope),
      selfStore.loadSelfMemories(),
      selfStore.loadLifeThreads(),
    ])
    const mood = normalizeSimMood(rawMood, at)
    const hour = new Date(at + 8 * 3600_000).getUTCHours()
    const taste = describeCharacterTaste(character)
    const habits = normalizeMemoryList(rawHabits, at).filter(memory => memory.kind === 'note' && !memory.done)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ id, content, updatedAt, habitMessageSeqs }) => ({
        id, content, updatedAt, ...(habitMessageSeqs ? { evidenceRefs: habitMessageSeqs.map(seq => `message:${seq}`) } : {}),
      }))
    const refs = [
      ...[...character.memories, ...character.goals].flatMap(memory => memory.evidenceRefs),
      ...habits.flatMap(habit => habit.evidenceRefs ?? []),
    ]
    return {
      persona: describePersona(ports.getPersona(scope.groupId, scope.botId).persona),
      mood: mood ? { status: 'recorded', summary: moodSummaryLine(mood, at, cfg.mood.halfLifeMs), updatedAt: mood.updatedAt }
        : { status: cfg.mood.enabled ? 'unrecorded' : 'disabled' },
      rhythm: { enabled: cfg.rhythm.enabled, ...window, sleeping: cfg.rhythm.enabled && isSleeping(hour, window) },
      ...taste, habits,
      life: normalizeLifeThreads(rawLife).map(({ id, title, kind, status, lastEpisode, lastSyncAt, notes }) => ({
        id, title, kind, status, ...(lastEpisode === undefined ? {} : { lastEpisode }), lastSyncAt, notes,
      })),
      evidence: describeCharacterEvidence(character, state.recent, refs),
    }
  }

  /** 控制台 JSON 视图 */
  async function describeGroup(groupId: string, options: { profile?: boolean } = {}): Promise<Record<string, unknown>> {
    await refreshGroupState(true)
    const cfg = runtimeConfig()
    const state = await store.load(groupId)
    const scope = boundScopeFor(groupId, state.botId)
    if (scope) await revokeSharedDerived(scope)
    const character = scope ? await characters.load(scope) : null
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
      running: running.has(groupId) || background.has(groupId),
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
      characterBinding: scope
        ? { status: 'bound', botId: scope.botId, personaId: scope.personaId }
        : { status: 'pending', botId: null, personaId: null, reason: '等待机器人收到本群消息后绑定角色' },
      character,
      ...(options.profile ? { profile: character ? await describeProfile(character, state, cfg) : null } : {}),
      activities: scope ? {
        works: await workspaceFor(scope).list(), subscriptions: await subscriptionsFor(scope).list(),
        reflection: await reflectionFor(scope).read(), shared: await sharedFor(scope).projection(), sharedPending: await sharedFor(scope).pending(),
        capabilities: [
          { name: '作品空间', description: '本群草稿、版本、恢复与来源撤销；分享须走发送工具', available: true },
          { name: '公开兴趣订阅', description: 'RSS、Atom、GitHub releases；有界轮询与更新去重', available: true },
          { name: '独立反思', description: '至少六小时一次、每日最多两次，受群预算与参与边界约束', available: !!ports.reflectCharacter && ports.getSection().reflection?.enabled !== false },
          { name: '跨群自我偏好', description: '只共享主人批准的角色观点/兴趣，来源撤销时失效', available: true },
          { name: '外部工作器', description: '可配置研究、图片或浏览器网关，受任务协议、超时、取消与真实回执约束', available: !!ports.runCharacterWorker && ports.characterWorkerAvailable?.() !== false },
          ...resolveExtraTools(resolveExtraToolNames(runtimeConfig(),groupId)).map(tool => ({ name: tool.name, description: (tool.description || '').slice(0,160), available: AUTONOMOUS_EXTRA_TOOLS.includes(tool.name) || (AUTONOMOUS_CREATIVE_TOOLS.includes(tool.name) && Array.isArray(ports.getSection().autonomousTools) && ports.getSection().autonomousTools!.includes(tool.name)) })),
        ],
      } : { works: [], subscriptions: [], reflection: null, shared: [], sharedPending: [], capabilities: [] },
    }
  }

  async function controlCharacter(groupId: string, action: 'pause' | 'resume' | 'cancel-goal' | 'pause-goal' | 'resume-goal' | 'delete-memory', id?: string): Promise<string> {
    if (!/^\d{5,12}$/.test(groupId)) throw new Error('群号格式无效')
    const state = await store.load(groupId)
    const scope = boundScopeFor(groupId, state.botId)
    if (!scope) throw new Error('本群尚未绑定机器人，请等待机器人收到本群消息后再管理角色')
    if (action === 'pause' || action === 'delete-memory') backgroundByGroup.get(groupId)?.abort()
    if (action === 'delete-memory') await store.invalidateActivity(groupId)
    await characters.update(scope, current => {
      if (action === 'pause' || action === 'resume') return setCharacterPaused(current, action === 'pause', now())
      if (!id) throw new Error('缺少记录标识')
      if (action === 'delete-memory') return deleteCharacterMemory(current, id, now())
      return transitionCharacterGoal(current, id, action === 'cancel-goal' ? 'abandoned' : action === 'pause-goal' ? 'paused' : 'active', { now: now(), lastOutcome: '管理员调整目标状态' })
    })
    if (action === 'delete-memory') {
      const live = liveStates.get(groupId)
      if (live) {
        live.agentHistory = []
        await store.save(groupId, live)
      }
      const updated = await characters.load(scope)
      await workspaceFor(scope).pruneEvidence([...updated.memories.map(m => `memory:${m.id}`), ...updated.receipts.map(r => `receipt:${r.id}`)])
      await revokeSharedDerived(scope)
      // A turn may have started after the first invalidation but before the
      // source deletion completed. Invalidate that intermediate view as well.
      await store.invalidateActivity(groupId)
    }
    return '角色状态已更新'
  }

  async function controlActivity(groupId: string, action: CharacterActivityOperation, id?: string, payload?: Record<string, unknown>): Promise<string> {
    if (!/^\d{5,12}$/.test(groupId)) throw new Error('群号格式无效')
    const session = await store.load(groupId), scope = boundScopeFor(groupId, session.botId)
    if (!scope) throw new Error('本群尚未绑定机器人，请等待机器人收到本群消息后再管理角色活动')
    if (action !== 'reflection-reset' && (!id || id.trim() !== id || id.length > 200)) throw new Error('缺少有效记录标识')
    const workspace = workspaceFor(scope), subscriptions = subscriptionsFor(scope), shared = sharedFor(scope)
    if (['work-delete','shared-delete','shared-approve'].includes(action)) {
      // Revoke before changing the source so an in-flight action cannot use it
      // between the source update and the shared cancellation becoming visible.
      await store.invalidateActivity(groupId)
      const live = liveStates.get(groupId)
      if (live) live.agentHistory = []
    }
    if (action === 'work-archive') await workspace.archive(id!, true)
    else if (action === 'work-delete') await workspace.remove(id!)
    else if (action === 'work-restore') {
      const current = await workspace.read(id!)
      await workspace.restore(id!, Number(payload?.revision), current.revision)
    } else if (action === 'subscription-pause' || action === 'subscription-resume') await subscriptions.pause(id!, action === 'subscription-pause')
    else if (action === 'subscription-remove') await subscriptions.remove(id!)
    else if (action === 'shared-approve') await shared.approve(id!)
    else if (action === 'shared-delete') await shared.remove(id!)
    else if (action === 'reflection-reset') await reflectionFor(scope).reset()
    else throw new Error('未知角色活动操作')
    // Do not save the console's session snapshot here: its runtime may be a
    // separate process. The shared version clears stale history on next use.
    await revokeSharedDerived(scope)
    if (['work-delete','shared-delete','shared-approve'].includes(action)) await store.invalidateActivity(groupId)
    return '角色活动已更新'
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

  return { isCapture, ingest, start, stop, sweepOnce, enableGroup, disableGroup, setGroupReplyMode, groupStatus, resetGroup, listMemories, listAffinity, ingestPoke, handleRecall, overview, describeGroup, controlCharacter, controlActivity, getInitialPrompt, setInitialPrompt, setGroupBudget, setGroupTurnsCap, setDefaultBudget, isGroupActive: isSimulationGroup, wakeForCommitment, listPersonProfiles: () => store.listPersonProfiles(), deletePersonProfile: (userId: string) => store.deletePersonProfile(userId), deletePersonProfileField: (userId: string, field: string, value?: string) => store.deletePersonProfileField(userId, field, value),
  lifeOverview: async () => {
    const cfg = runtimeConfig()
    const stored = await store.loadRhythm().catch(() => null)
    const rhythm = stored?.setBy === 'admin' ? { sleepFrom: stored.sleepFrom, sleepTo: stored.sleepTo, setBy: 'admin' } : { sleepFrom: cfg.rhythm.sleepFrom, sleepTo: cfg.rhythm.sleepTo }
    await refreshGroupState(true)
    const threads = (await Promise.all(knownGroupsCache.map(async groupId => {
      const state = await store.load(groupId)
      const scope = boundScopeFor(groupId, state.botId)
      if (!scope) return []
      return normalizeLifeThreads(await scopedStore(scope).loadLifeThreads()).map(thread => ({ ...thread, groupId }))
    }))).flat()
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
    await refreshGroupState(true)
    for (const groupId of knownGroupsCache) {
      const state = await store.load(groupId)
      const scope = boundScopeFor(groupId, state.botId)
      if (!scope) continue
      await scopedStore(scope).saveRhythm({ sleepFrom: from, sleepTo: to, setBy: 'admin' })
    }
    rhythmCache = null
    return `已设定作息 ${from}:00 - ${to}:00（页面设定）`
  } }
}
