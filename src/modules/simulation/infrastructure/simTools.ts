import type { SimMemoryEntry, SimMessage, SimMoodState, SimSessionState, SimWakeConfig } from '../../../contracts/simulation.js'
import { coerceStringArray, looksLikeToolArguments } from '../domain/paramTolerance.js'
import { stripAIFlavorPhrases } from '../../conversation/domain/replySanitizer.js'
import { compactSimMessage } from '../domain/messageView.js'
import { acknowledgeMessages, readThroughSeq, noteModelSeen, unreadSince } from '../domain/watermark.js'
import { normalizeSimWakeConfig, ensureWakeable } from '../domain/simConfig.js'
import { activeMemories, applyAffinityDelta, capMemories, defaultAffinityEntry, dueMemories, normalizeSimMemoryEntry, SIM_MEMORY_LIMIT, SIM_SELF_MEMORY_LIMIT } from '../domain/simMemory.js'
import { MOOD_AXES, type MoodAxis } from '../domain/mood.js'
import type { SimWaitPlan } from '../domain/waitGate.js'
import { AbstractTool } from '../../toolSupport/infrastructure/AbstractTool.js'
import { redactInternalStatusLeaks } from '../../conversation/domain/internalStatusLeak.js'

export type SimSendResult = { ok: true; sent: number; duplicatesSkipped?: number } | { ok: false; error: string; sent?: number; duplicatesSkipped?: number; unknown?: boolean }
export interface SimWaitResult { hint: string; canSleepNow: boolean; newMessagesText: string; newCount: number; readThroughSeq: number; partial: boolean }

/**
 * 每个仿真回合构建一次的上下文：工具全部绑定当前群与当前会话状态。
 * 发送目标由上下文绑定（参数里没有群号）——这是免发送白名单的根本设计。
 */
export interface SimToolContext {
  groupId: string
  /** Production turns require a declared ordinary-chat continuation. */
  requireExplicitContinuation?: boolean
  /** Only the runtime can set this after checking the triggering user's words. */
  proactiveSourceSeq?(): number | undefined
  noteVisibleMessages?(seqs: number[]): void
  checkHabitSources?(seqs: number[]): boolean
  now(): number
  getState(): SimSessionState
  /** 读取-修改-保存（回合内单线程，mutate 保证落盘） */
  mutate<T>(fn: (state: SimSessionState) => T): Promise<T>
  sendMessage(messages: string[], opts: { replyToMessageId?: string | number; atUserIds?: string[] }): Promise<SimSendResult>
  waitForMessages(plan: SimWaitPlan, filter?: (message: SimMessage) => boolean): Promise<SimWaitResult>
  waitMessageFilter?(message: SimMessage): boolean
  applyWakeConfig(config: SimWakeConfig): void | Promise<void>
  sendsThisTurn(): number
  maxSendItems(): number
  messageTextMaxChars(): number
  /** agent 自管记忆（读-改-存，回合内单线程） */
  getMemories(): SimMemoryEntry[]
  saveMemories(memories: SimMemoryEntry[]): void | Promise<void>
  /** 好感度表 */
  getAffinity(): Record<string, ReturnType<typeof defaultAffinityEntry>>
  saveAffinity(affinity: Record<string, ReturnType<typeof defaultAffinityEntry>>): void | Promise<void>
  /** 取某条消息的图片（多模态）：由 runtime 经 ports.fetchImageBase64 实现 */
  getMessageImages(seq: number): Promise<{ seq: number; images: { mime: string; base64: string }[]; error?: string }>
  /** 戳群成员（带频率护栏：每群每小时 ≤6 次） */
  pokeMember(userId: string): Promise<{ ok: boolean; error?: string }>
  /** 全局好感底分镜像（群内变动时同步 30% 权重到跨群底分；reason 进全局关系近况） */
  bumpGlobalAffinity?(userId: string, delta: number, reason?: string): Promise<number>
  /** 双轨写入协同：agent 记的"关于某人的事实"同步进该人的跨群人物档案 */
  savePersonFact?(userId: string, fact: string): Promise<void>
  /** 事实新陈代谢：某件长期事已结束（"考完了/不玩了"）→ 移除档案里的对应旧事实 */
  closePersonFacts?(userId: string, statement: string): Promise<void>
  /** AI 自我记忆（跨群性格沉淀，scope=self 的条目走这里） */
  getSelfMemories?(): SimMemoryEntry[]
  saveSelfMemories?(memories: SimMemoryEntry[]): void | Promise<void>
  /** 情绪四轴（跨群全局）：summary 为预翻译的单行摘要（simGetState 展示用） */
  getMood?(): { summary: string } | null
  /** 情绪四轴有界更新：运行时负责半衰期投影/单步上限/回合包络并落盘 */
  updateMood?(deltas: Partial<Record<MoodAxis, number>>, reason: string): { mood: SimMoodState; applied: Partial<Record<MoodAxis, number>>; capped: boolean } | { error: string } | Promise<{ mood: SimMoodState; applied: Partial<Record<MoodAxis, number>>; capped: boolean } | { error: string }>
  /** 自设作息（全局）：sleepFrom/sleepTo 小时，如 1-8 */
  setRhythm?(sleepFrom: number, sleepTo: number): Promise<string>
  /** 生活线管理：follow（真实搜索定位）/list/drop */
  lifeThreadFollow?(title: string): Promise<{ ok: boolean; error?: string; title?: string }>
  lifeThreadList?(): Promise<{ title: string; status: string; lastEpisode?: number; notes: string[] }[]>
  lifeThreadDrop?(title: string): Promise<{ ok: boolean; error?: string }>
  /** QQ空间互动：visit 看说说 / like 点赞 / comment 评论（内容已脱敏） */
  qzoneInteract?(input: { action: 'visit' | 'like' | 'comment'; userId?: string; tid?: string; text?: string }): Promise<{ ok: boolean; error?: string; feeds?: { tid: string; time: string; text: string; likes: number }[] }>
  /** 空间互动的运行时配置（开关/冷却/日限额/好感门槛） */
  qzoneConfig(): { enabled: boolean; visitCooldownMs: number; maxLikesPerDay: number; maxCommentsPerDay: number; minAffinity: number }
  /** 群成员列表（活跃者优先） */
  getGroupMembers(): Promise<{ userId: string; nick: string; active?: boolean }[] | { error: string }>
  /** 查看合并转发内容 */
  getForward(forwardId: string): Promise<{ lines: string[]; error?: string }>
  /** 精选收藏某条消息的附图进表情包库 */
  collectSticker(seq: number): Promise<{ ok: boolean; error?: string }>
  /** 甩一张B站视频QQ卡片(带冷却,偶尔为之) */
  shareVideoCard(input: { query?: string; url?: string }): Promise<{ ok: boolean; error?: string; title?: string; unknown?: boolean }>
}

const SEND_TEXT_MAX_CHARS = 500

export function createSimTools(ctx: SimToolContext): AbstractTool[] {
  class SimGetUnreadMessagesTool extends AbstractTool {
    constructor() {
      super()
      this.name = 'simGetUnreadMessages'
      this.description = '拉取当前群的未读消息（唤醒快照之外的部分）。返回按时间排序的紧凑视图，每条带 时间(多久前)。用 afterSeq=readThroughSeq 续读，直到没有更多。'
      this.parameters = {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '最多返回条数，1-100，默认 30。' },
          afterSeq: { type: 'number', description: '只返回 seq 大于该值的消息；续读时传上次返回的 readThroughSeq。' },
        },
        required: [],
        additionalProperties: false,
      }
    }

    async func(opts: Record<string, unknown>) {
      const limit = clampInt(opts.limit, 1, 100, 30)
      const afterSeq = Math.max(0, Math.floor(Number(opts.afterSeq) || 0))
      return await ctx.mutate(state => {
        const messages = unreadSince(state, afterSeq, limit)
        const now = ctx.now()
        const selected: SimMessage[] = [], lines: string[] = []
        let chars = 0
        for (const message of messages) {
          const line = compactSimMessage(message, now)
          chars += JSON.stringify(line).length + 1
          if (chars > 3300) break
          lines.push(line); selected.push(message)
        }
        const seqs = selected.map(m => m.seq)
        noteModelSeen(state, seqs)
        ctx.noteVisibleMessages?.(seqs)
        return JSON.stringify({
          messages: lines,
          count: selected.length,
          readThroughSeq: readThroughSeq(state),
          remainingUnread: state.unread.length - selected.length,
        })
      })
    }
  }

  class SimGetRecentMessagesTool extends AbstractTool {
    constructor() {
      super()
      this.name = 'simGetRecentMessages'
      this.description = '查群里最近的消息（含你已经读过的），用于回忆刚才聊了什么。从最新往旧返回。'
      this.parameters = {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '最多返回条数，1-50，默认 15。' },
          offset: { type: 'number', description: '跳过最新多少条再往旧翻页，默认 0。' },
        },
        required: [],
        additionalProperties: false,
      }
    }

    async func(opts: Record<string, unknown>) {
      const limit = clampInt(opts.limit, 1, 50, 15)
      const offset = Math.max(0, Math.floor(Number(opts.offset) || 0))
      return await ctx.mutate(state => {
        const ordered = [...state.recent].sort((a, b) => b.seq - a.seq).slice(offset, offset + limit)
        const now = ctx.now()
        const selected: SimMessage[] = [], lines: string[] = []
        let chars = 0
        for (const message of ordered) {
          const line = compactSimMessage(message, now)
          chars += JSON.stringify(line).length + 1
          if (chars > 3300) break
          lines.push(line); selected.push(message)
        }
        const seqs = selected.map(m => m.seq)
        noteModelSeen(state, seqs)
        ctx.noteVisibleMessages?.(seqs)
        return JSON.stringify({
          messages: lines.reverse(),
          count: selected.length,
          nextOffset: offset + selected.length,
          readThroughSeq: readThroughSeq(state),
          totalRecent: state.recent.length,
        })
      })
    }
  }

  class SimGetMessageDetailTool extends AbstractTool {
    constructor() {
      super()
      this.name = 'simGetMessageDetail'
      this.description = '按 seq 查单条消息的完整内容（视图里被截断的正文）。'
      this.parameters = {
        type: 'object',
        properties: { seq: { type: 'number', description: '消息的 seq（视图里 message_id 字段）。' } },
        required: ['seq'],
        additionalProperties: false,
      }
    }

    async func(opts: Record<string, unknown>) {
      const seq = Math.floor(Number(opts.seq))
      if (!Number.isFinite(seq)) return 'error: seq 必须是数字'
      return await ctx.mutate(state => {
        const message = [...state.unread, ...state.recent].find(m => m.seq === seq)
        if (!message) return JSON.stringify({ found: false, hint: '该消息不在近期缓冲里（可能太旧），可用 simGetRecentMessages 翻更早的记录。' })
        noteModelSeen(state, [seq])
        ctx.noteVisibleMessages?.([seq])
        return JSON.stringify({ found: true, message: compactSimMessage(message, ctx.now()), messageId: message.messageId, imageCount: message.imageCount, readThroughSeq: readThroughSeq(state) })
      })
    }
  }

  class SimMarkReadTool extends AbstractTool {
    constructor() {
      super()
      this.name = 'simMarkRead'
      this.description = '把消息标记为已读（推进水位）。只想默默看过、不打算回复时用它，然后把回合结束掉。'
      this.parameters = {
        type: 'object',
        properties: { throughSeq: { type: 'number', description: '把 seq ≤ 该值的消息全部标为已读。只能提交你确实看到过的位置（readThroughSeq 以内）。' } },
        required: ['throughSeq'],
        additionalProperties: false,
      }
    }

    async func(opts: Record<string, unknown>) {
      const throughSeq = Math.floor(Number(opts.throughSeq))
      if (!Number.isFinite(throughSeq) || throughSeq < 0) return 'error: throughSeq 必须是非负数字'
      return await ctx.mutate(state => {
        const ok = acknowledgeMessages(state, throughSeq)
        if (!ok) return `error: throughSeq 超过了你实际看到的范围（当前可提交到 ${readThroughSeq(state)}）`
        return `已读水位推进到 ${throughSeq}`
      })
    }
  }

  class SimSendMessageTool extends AbstractTool {
    constructor() {
      super()
      this.name = 'simSendMessage'
      this.description = [
        '在当前群发送中途普通聊天。continuation必填chat（普通聊天）或interest_only（仅感兴趣，不承诺后续）。保存记忆、拒绝选择、后续排期或完成说明请用simFinishTurn先保存再发送。',
        'messages 数组通常只放一条，有独立补话才加第二条。',
        '条与条之间系统会自动加间隔，不要自己写停顿标记。',
        '想引用某条消息就传 replyToSeq（视图里的 seq）；想 @ 人就传 atUserIds（QQ 号数字）。',
        '发送失败会返回 error，此时可换措辞重试或放弃，不要原样重试超过一次。',
      ].join('\n')
      this.parameters = {
        type: 'object',
        properties: {
          continuation: { type: 'string', enum: ['chat', 'interest_only'], description: '本次仅为普通聊天或兴趣表达，不声明尚未保存的后续安排/完成结果。' },
          messages: { type: 'array', items: { type: 'string' }, description: '要发的内容，1-5 条，每条 ≤500 字。' },
          replyToSeq: { type: 'number', description: '可选：引用哪条消息（seq）。' },
          atUserIds: { type: 'array', items: { type: 'string' }, description: '可选：要 @ 的 QQ 号，最多 3 个。' },
        },
        required: ctx.requireExplicitContinuation ? ['messages', 'continuation'] : ['messages'],
        additionalProperties: false,
      }
    }

    async func(opts: Record<string, unknown>) {
      if ((ctx.requireExplicitContinuation || opts.continuation !== undefined) && !['chat', 'interest_only'].includes(String(opts.continuation))) return 'error: continuation 必须为 chat 或 interest_only；需要保存或安排时用 simFinishTurn'
      // Keep a complete protocol-sized batch for quota preflight. One extra item
      // detects overflow without silently sending only the prefix of a request.
      const messages = coerceStringArray(opts.messages, { maxLength: 6, itemMaxChars: SEND_TEXT_MAX_CHARS })
      if (!messages || messages.length > 5) return 'error: messages 必须是非空字符串或字符串数组（最多 5 条）；本批未发送'
      // 硬拦截：模型想要本回合不存在的工具时会把参数 JSON 当聊天内容发（实测 sendLocalEmojiTool 案例）
      const cleaned = messages.map(m => stripAIFlavorPhrases(m)).filter(Boolean)
      if (!cleaned.length) return 'error: 清理后没有可发送的内容（原内容是客服腔空话），请换成人话重说'
      const toolArgsIndex = cleaned.findIndex(m => looksLikeToolArguments(m))
      if (toolArgsIndex >= 0) {
        return 'error: 第 ' + (toolArgsIndex + 1) + ' 条内容是工具参数 JSON，不是聊天消息，群里看到的就是乱码。你想要的那个工具不在本回合的工具清单里；请直接用自然语言把想说的话说出来（例如把 leadText 的内容当消息发），不要输出任何工具的参数格式。'
      }
      const replyToSeq = Math.floor(Number(opts.replyToSeq))
      const state = ctx.getState()
      const replyTarget = Number.isFinite(replyToSeq) && replyToSeq > 0
        ? [...state.unread, ...state.recent].find(m => m.seq === replyToSeq)
        : undefined
      if (Number.isFinite(replyToSeq) && replyToSeq > 0 && !replyTarget) {
        return `error: replyToSeq=${replyToSeq} 在近期消息里不存在，无法引用`
      }
      const atUserIds = Array.isArray(opts.atUserIds)
        ? opts.atUserIds.map(v => String(v)).filter(v => /^\d{1,12}$/.test(v)).slice(0, 3)
        : []
      const result = await ctx.sendMessage(cleaned, {
        ...(replyTarget?.messageId ? { replyToMessageId: replyTarget.messageId } : {}),
        ...(atUserIds.length ? { atUserIds } : {}),
      })
      if (!result.ok) return `error: ${JSON.stringify(result)}`
      return JSON.stringify({ ok: true, sent: result.sent, ...(result.duplicatesSkipped === undefined ? {} : { duplicatesSkipped: result.duplicatesSkipped }), note: '只确认 sent 条新消息，duplicatesSkipped 是本回合已经成功发出的相同正文；不要重复发送。' })
    }
  }

  class SimWaitForMessagesTool extends AbstractTool {
    constructor() {
      super()
      this.name = 'simWaitForMessages'
      this.description = [
        '等待群里的新消息，返回期间到达的消息与"现在该怎么做"的提示。',
        "purpose='reply'：回复前想等群里安静一下（默认安静 8 秒即返回）。",
        "purpose='messages'：想再观察一轮——等到新消息、且之后没人抢话（约 10 秒安静）才返回，适合沉睡前确认没话可接。",
        '返回的 hint 是系统替你判断好的结论，照着做即可；不要用多次短等待去凑长观察。',
      ].join('\n')
      this.parameters = {
        type: 'object',
        properties: {
          purpose: { type: 'string', enum: ['reply', 'messages'], description: '等待语义，默认 messages。' },
          quietMs: { type: 'number', description: '期望的安静时长（毫秒），1 秒 - 120 秒。' },
          timeoutMs: { type: 'number', description: '最长等多久（毫秒），超时也会返回已观察到的内容。' },
          minNewMessages: { type: 'number', description: "purpose=messages 时至少等几条新消息，默认 1。" },
        },
        required: [],
        additionalProperties: false,
      }
    }

    async func(opts: Record<string, unknown>) {
      const plan: SimWaitPlan = {
        purpose: opts.purpose === 'reply' ? 'reply' : 'messages',
        quietMs: Math.max(1000, Math.min(120_000, Math.floor(Number(opts.quietMs) || (opts.purpose === 'reply' ? 8000 : 30_000)))),
        timeoutMs: Math.max(1000, Math.min(120_000, Math.floor(Number(opts.timeoutMs) || 60_000))),
        minNewMessages: clampInt(opts.minNewMessages, 1, 10, 1),
        minQuietAfterNewMs: 10_000,
      }
      const result = await ctx.waitForMessages(plan, ctx.waitMessageFilter)
      return JSON.stringify(result)
    }
  }

  class SimSetWakeConfigTool extends AbstractTool {
    constructor() {
      super()
      this.name = 'simSetWakeConfig'
      this.description = [
        '设置你在这个群的唤醒/潜水方式（下次什么时候会被叫醒）。',
        'mode: diving=潜水（默认，只按触发条件醒）；active=活跃一阵子（sleepMinutes 分钟内按 batchWindow 节奏跟进）。',
        'triggers 可改：keywords（关心的词，≤16 个）、speakerIds（关注的群友 QQ 号，≤20 个）、atMention（被@必醒，默认开）、nameMention（被叫名字醒，默认开）、question（被提问醒，默认开）、probability（随机醒来概率 0-1，默认 0.05）。',
        '注意：把所有触发都关掉会被系统重置为默认配置。',
      ].join('\n')
      this.parameters = {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['diving', 'active'], description: '潜水或活跃，默认保持不变。' },
          sleepMinutes: { type: 'number', description: 'mode=active 时活跃多久（分钟，1-360），默认 20。' },
          keywords: { type: 'array', items: { type: 'string' }, description: '关心的关键词列表（替换式设置）。' },
          speakerIds: { type: 'array', items: { type: 'string' }, description: '关注的群友 QQ 号（替换式设置）。' },
          atMention: { type: 'boolean' }, nameMention: { type: 'boolean' }, question: { type: 'boolean' },
          probability: { type: 'number', description: '随机唤醒概率 0-1。' },
          throughSeq: { type: 'number', description: '可选：顺带把已读水位推进到该值。' },
        },
        required: [],
        additionalProperties: false,
      }
    }

    async func(opts: Record<string, unknown>) {
      const state = ctx.getState()
      const next: Record<string, unknown> = {
        mode: opts.mode === 'active' || opts.mode === 'diving' ? opts.mode : state.wakeConfig.mode,
        triggers: { ...state.wakeConfig.triggers },
        batchWindowMs: state.wakeConfig.batchWindowMs,
        confirmedBy: 'agent',
      }
      const keywords = coerceStringArray(opts.keywords, { maxLength: 16, itemMaxChars: 20 })
      if (keywords) next.triggers = { ...(next.triggers as Record<string, unknown>), keywords }
      const speakers = Array.isArray(opts.speakerIds) ? opts.speakerIds.map(v => String(v)).filter(v => /^\d{1,12}$/.test(v)).slice(0, 20) : null
      if (speakers) next.triggers = { ...(next.triggers as Record<string, unknown>), speakerIds: speakers }
      for (const flag of ['atMention', 'nameMention', 'question'] as const) {
        if (typeof opts[flag] === 'boolean') next.triggers = { ...(next.triggers as Record<string, unknown>), [flag]: opts[flag] }
      }
      if (opts.probability !== undefined) next.triggers = { ...(next.triggers as Record<string, unknown>), probability: Math.max(0, Math.min(1, Number(opts.probability) || 0)) }
      if (opts.mode === 'active') {
        const minutes = clampInt(opts.sleepMinutes, 1, 360, 20)
        next.sleepUntil = ctx.now() + minutes * 60_000
      }
      const normalized = normalizeSimWakeConfig(next)
      const { config, reset } = ensureWakeable(normalized)
      ctx.applyWakeConfig(config)
      if (Number.isFinite(Number(opts.throughSeq)) && Number(opts.throughSeq) >= 0) {
        await ctx.mutate(s => { acknowledgeMessages(s, Math.floor(Number(opts.throughSeq))) })
      }
      return reset
        ? '警告：你提交的配置没有任何唤醒途径，系统已重置为默认（被@必醒 + 随机 5%）。请保留至少一种触发方式。'
        : `唤醒配置已更新：${JSON.stringify({ mode: config.mode, triggers: config.triggers, ...(config.sleepUntil ? { sleepUntil: config.sleepUntil } : {}) })}`
    }
  }

  class SimGetStateTool extends AbstractTool {
    constructor() {
      super()
      this.name = 'simGetState'
      this.description = '查看你当前在这个群的状态：唤醒配置、未读数、上次发言时间、今日已用回合数。'
      this.parameters = { type: 'object', properties: {}, required: [], additionalProperties: false }
    }

    async func() {
      const state = ctx.getState()
      const mood = typeof ctx.getMood === 'function' ? ctx.getMood() : null
      return JSON.stringify({
        mode: state.wakeConfig.mode,
        triggers: state.wakeConfig.triggers,
        unreadCount: state.unread.length,
        readThroughSeq: readThroughSeq(state),
        lastAiSendAtAgo: state.lastAiSendAt ? Math.round((ctx.now() - state.lastAiSendAt) / 1000) + ' 秒前' : '未发言',
        lastWakeReason: state.lastWakeReason?.kind || '无',
        todayTurns: state.budget.turns,
        sendsThisTurn: ctx.sendsThisTurn(),
        ...(mood?.summary ? { mood: mood.summary } : {}),
      })
    }
  }

  class SimRememberTool extends AbstractTool {
    constructor() {
      super()
      this.name = 'simRemember'
      this.description = [
        '你的长期记忆（跨回合、跨天保存）。pendingEvent 带 aboutUser 和 dueInMinutes。只有对方明确欢迎在本群主动问起才设 welcomeProactiveFollowUp=true；“聊到再问”只在对话中接续。自然问过一次或对方已说结果就 done，没回应不催。正式提醒走托付工具。',
        '有明确话语或实际互动支持的相处习惯用 interaction，带 aboutUser，写清偏好及简短依据。它只留在本群，不当成跨群人物事实。',
        '值得记住的事实、约定、对某个人的印象记 note 或 impression；你自己形成的口头禅/偏好记 note 且 scope=self——保存在当前机器人与人设的本群范围，记录反复发生的小习惯时必须附 habitMessageSeqs，下次唤醒在【你自己的沉淀】里。',
        '带 aboutUser 的稳定事实（TA的爱好/身份/雷点这类到哪个群都成立的）会同时进入TA的跨群人物档案；带时间性的内容（明天/下周要干嘛）不要走这条路，记 pendingEvent。',
        'TA之前的事结束了（"考完了""不学了"）也记 note + aboutUser，系统会自动从TA档案里移除对应的旧事实。',
        'action=list 查看记忆；跟进完成后 action=done 收掉待办；action=remove 删除记错的。',
      ].join('\n')
      this.parameters = {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'list', 'done', 'remove'], description: '默认 add。' },
          kind: { type: 'string', enum: ['pendingEvent', 'note', 'impression', 'meme', 'activeTopic', 'interaction'], description: 'add 时的类型，默认 note。interaction=本群实际相处习惯；activeTopic=近期话题。' },
          scope: { type: 'string', enum: ['group', 'self'], description: '默认 group（只这个群）。self=你自己的性格沉淀（口头禅/偏好），仅当前机器人与人设的本群；要求不带 aboutUser。' },
          content: { type: 'string', description: '要记的内容，一句话（≤200 字）。例："阿说明天上午要考四级，说考完想打游戏"。' },
          aboutUser: { type: 'string', description: '相关群友 QQ。主动跟进缺省使用当前邀请你的人，不能指定第三人。' },
          habitMessageSeqs: { type: 'array', minItems: 2, maxItems: 4, items: { type: 'number', minimum: 1 }, description: '仅 scope=self 的 note。2–4 条本轮实际可见的本群消息序号，首尾至少间隔 10 分钟，能说明你确实形成了这一习惯。不要用一人的临时建议或顺手记号凑数。' },
          dueInMinutes: { type: 'number', description: 'kind=pendingEvent 必填：多少分钟后该跟进（10 分钟 ~ 30 天）。' },
          welcomeProactiveFollowUp: { type: 'boolean', description: '仅 pendingEvent。对方明确请你主动在本群问起时才为 true。“碰巧聊到再问”“不用特意问”都为 false。' },
          id: { type: 'string', description: 'done/remove 时要操作的条目 id。' },
        },
        required: [],
        additionalProperties: false,
      }
    }

    async func(opts: Record<string, unknown>) {
      const action = opts.action === 'list' || opts.action === 'done' || opts.action === 'remove' ? opts.action : 'add'
      const now = ctx.now()
      if (action === 'list') {
        const group = activeMemories(ctx.getMemories(), now, 12)
        const self = activeMemories(typeof ctx.getSelfMemories === 'function' ? ctx.getSelfMemories() : [], now, 6)
        if (!group.length && !self.length) return '记忆为空。'
        const due = new Set(dueMemories(ctx.getMemories(), now).map(m => m.id))
        const shape = (m: SimMemoryEntry, scope: 'group' | 'self') => ({
          id: m.id, scope, kind: m.kind, content: m.content, aboutUser: m.aboutUser,
          ...(scope === 'self' && m.habitMessageSeqs?.length ? { habitMessageSeqs: m.habitMessageSeqs } : {}),
          ...(m.kind === 'meme' && m.count ? { heat: m.count } : {}),
          due: m.dueAt ? (due.has(m.id) ? `已到期（该跟进了）` : `${Math.max(0, Math.round((m.dueAt - now) / 60000))} 分钟后到期`) : undefined,
        })
        return JSON.stringify([...group.map(m => shape(m, 'group')), ...self.map(m => shape(m, 'self'))])
      }
      if (action === 'done' || action === 'remove') {
        const id = String(opts.id || '')
        const memories = [...ctx.getMemories()]
        let index = memories.findIndex(m => m.id === id)
        if (index >= 0) {
          if (action === 'remove') {
            const removed = memories.splice(index, 1)
            await ctx.saveMemories(capMemories(memories, SIM_MEMORY_LIMIT))
            return JSON.stringify({ ok: true, note: `已删除：${removed[0]?.content || ''}` })
          }
          memories[index] = { ...memories[index]!, done: true, updatedAt: now }
          await ctx.saveMemories(capMemories(memories, SIM_MEMORY_LIMIT))
          return JSON.stringify({ ok: true, note: `已收掉待办：${memories[index]!.content}` })
        }
        // 自我记忆（scope=self）也在 done/remove 的可操作范围内
        const selfMemories = typeof ctx.getSelfMemories === 'function' ? [...ctx.getSelfMemories()] : []
        index = selfMemories.findIndex(m => m.id === id)
        if (index < 0) return `error: 找不到记忆 ${id}，可先用 action=list 查看`
        if (action === 'remove') {
          const removed = selfMemories.splice(index, 1)
          await ctx.saveSelfMemories?.(capMemories(selfMemories, SIM_SELF_MEMORY_LIMIT))
          return JSON.stringify({ ok: true, note: `已删除：${removed[0]?.content || ''}` })
        }
        selfMemories[index] = { ...selfMemories[index]!, done: true, updatedAt: now }
        await ctx.saveSelfMemories?.(capMemories(selfMemories, SIM_SELF_MEMORY_LIMIT))
        return JSON.stringify({ ok: true, note: `已收掉：${selfMemories[index]!.content}` })
      }
      const selfScope = opts.scope === 'self'
      const habitSources = opts.habitMessageSeqs
      if (habitSources !== undefined && (!selfScope || (opts.kind !== 'note' && opts.kind !== undefined) ||
        !Array.isArray(habitSources) || habitSources.length < 2 || habitSources.length > 4 ||
        new Set(habitSources).size !== habitSources.length || habitSources.some(seq => !Number.isSafeInteger(seq) || seq < 1) ||
        !ctx.checkHabitSources?.(habitSources))) return 'error: 小习惯需要至少两条不同时间、当前可见且与习惯有关的本群消息依据'
      if (opts.kind === 'interaction' && (selfScope || !/^\d{1,12}$/.test(String(opts.aboutUser || '')))) return 'error: interaction 需要本群群友的 aboutUser'
      const entry = normalizeSimMemoryEntry({
        kind: opts.kind,
        content: opts.content,
        habitMessageSeqs: habitSources,
        aboutUser: selfScope ? undefined : opts.aboutUser,
        dueAt: opts.kind === 'pendingEvent' && Number(opts.dueInMinutes) > 0 ? now + Math.min(43200, Math.max(10, Math.floor(Number(opts.dueInMinutes)))) * 60_000 : undefined,
        proactiveSourceSeq: opts.welcomeProactiveFollowUp === true ? ctx.proactiveSourceSeq?.() : undefined,
      }, now)
      if (!entry) return 'error: content 不能为空'
      if (opts.kind === 'pendingEvent' && !(Number(opts.dueInMinutes) > 0)) {
        return 'error: pendingEvent 必须给 dueInMinutes（10 分钟 ~ 30 天）'
      }
      if (selfScope) {
        if (typeof ctx.saveSelfMemories !== 'function') return 'error: 自我记忆不可用'
        if (opts.aboutUser) return 'error: scope=self 不带 aboutUser（那是你自己的沉淀，不是关于某个群友的）'
        await ctx.saveSelfMemories(capMemories([...(ctx.getSelfMemories?.() || []), entry], SIM_SELF_MEMORY_LIMIT))
        return JSON.stringify({ ok: true, saved: true, id: entry.id, note: '已保存到当前机器人与人设的本群自我笔记；跨群共享须另行提议并经管理员批准。' })
      }
      const memories = [...ctx.getMemories(), entry]
      await ctx.saveMemories(capMemories(memories, SIM_MEMORY_LIMIT))
      // 双轨写入协同：关于某人的稳定事实同步进跨群人物档案；结束信号走新陈代谢（移除旧事实）
      let profileNote: string | undefined
      const stableFact = entry.aboutUser && (entry.kind === 'note' || entry.kind === 'impression') && !/明天|后天|大后天|下周|下月|今晚|待会|等下|马上|这周末/.test(entry.content)
      if (stableFact && typeof ctx.savePersonFact === 'function' && typeof ctx.closePersonFacts === 'function' && /考完了|考完|不学了|不玩了|弃了|弃坑|通关了|结束了|毕业了|辞职了|分手了/.test(entry.content)) {
        try {
          await ctx.closePersonFacts(entry.aboutUser!, entry.content)
          profileNote = '（TA档案里对应的旧事实已移除）'
        } catch { /* 新陈代谢失败不影响本群记忆 */ }
      } else if (stableFact && typeof ctx.savePersonFact === 'function') {
        try {
          await ctx.savePersonFact(entry.aboutUser!, entry.content)
          profileNote = '（这条关于TA的稳定事实也已进入TA的跨群档案）'
        } catch { /* 档案同步失败不影响本群记忆已保存 */ }
      }
      return JSON.stringify({ ok: true, saved: true, id: entry.id, ...(entry.kind === 'pendingEvent' ? {
        proactiveApproved: entry.proactiveSourceSeq !== undefined,
        note: entry.proactiveSourceSeq !== undefined ? '已核对明确邀请，到期可获得一次主动检查。' : '仅在自然聊到时接续，不要答应到时主动来问。',
      } : { note: profileNote }) })
    }
  }

  class SimUpdateAffinityTool extends AbstractTool {
    constructor() {
      super()
      this.name = 'simUpdateAffinity'
      this.description = '记录你和某位群友的关系变化（好感度）。delta 范围 -3~+3，必须给具体理由（"连续三天找我帮忙装系统"）。单日每人有变动上限，防刷。绝不把分数或"好感度"说出口，它只影响你的语气。'
      this.parameters = {
        type: 'object',
        properties: {
          userId: { type: 'string', description: '群友 QQ 号。' },
          delta: { type: 'number', description: '变动 -3 ~ +3 的整数。' },
          reason: { type: 'string', description: '一句话理由（≤40 字）。' },
        },
        required: ['userId', 'delta', 'reason'],
        additionalProperties: false,
      }
    }

    async func(opts: Record<string, unknown>) {
      const userId = String(opts.userId || '')
      if (!/^\d{1,12}$/.test(userId)) return 'error: userId 必须是 QQ 号数字'
      const reason = String(opts.reason || '').trim()
      if (!reason) return 'error: 必须给理由'
      const now = ctx.now()
      const affinity = { ...ctx.getAffinity() }
      const current = affinity[userId] || defaultAffinityEntry(now)
      const result = applyAffinityDelta(current, Number(opts.delta), reason, now)
      if (result.applied === 0) {
        return `error: 该群友今天的好感度变动额度已用完（每日上限），明天再说`
      }
      affinity[userId] = result.entry
      await ctx.saveAffinity(affinity)
      // 跨群底分镜像：同样的关系变化在任何群都算数（权重 30%，理由进全局关系近况）
      try { if (typeof ctx.bumpGlobalAffinity === 'function') await ctx.bumpGlobalAffinity(userId, result.applied, reason) } catch { /* 镜像失败不影响本群 */ }
      return JSON.stringify({ ok: true, applied: result.applied, score: result.entry.score, capped: result.capped })
    }
  }

  // 情绪四轴（跨群全局）：小幅更新 + 理由；半衰期/包络由运行时把关
  class SimSetMoodTool extends AbstractTool {
    constructor() {
      super()
      this.name = 'simSetMood'
      this.description = '更新你自己的情绪（所有群共用的你，别把它当人设表演）。四个轴：joy 开心 / anger 生气 / sorrow 难过 / fear 担心，各传这轮的变化量（-3~+3 整数，只传真正被触动的轴，没变的轴不传）。被夸、聊得开心、看到好玩的事 → joy +；被冒犯、被怼 → anger +；输了游戏、看到难过的事 → sorrow +；担心某人某事 → fear +。情绪会随时间自己消退，不用每轮都调，没有波动就别调。理由必填。'
      this.parameters = {
        type: 'object',
        properties: {
          joy: { type: 'number', description: '开心轴变化量 -3~+3，没变不传。' },
          anger: { type: 'number', description: '生气轴变化量 -3~+3，没变不传。' },
          sorrow: { type: 'number', description: '难过轴变化量 -3~+3，没变不传。' },
          fear: { type: 'number', description: '担心轴变化量 -3~+3，没变不传。' },
          reason: { type: 'string', description: '一句话理由（≤40 字），如"跟群友斗图斗赢了"。' },
        },
        required: ['reason'],
        additionalProperties: false,
      }
    }

    async func(opts: Record<string, unknown>) {
      if (typeof ctx.updateMood !== 'function') return 'error: 当前环境不支持情绪'
      const reason = String(opts.reason || '').trim().slice(0, 60)
      if (!reason) return 'error: 必须给理由'
      const deltas: Partial<Record<MoodAxis, number>> = {}
      let any = false
      for (const axis of MOOD_AXES) {
        const delta = Math.round(Number(opts[axis]))
        if (Number.isFinite(delta) && delta !== 0) {
          deltas[axis] = delta
          any = true
        }
      }
      if (!any) return 'error: 至少给一个轴的变化量（-3~+3），没有波动就不用调'
      const result = await ctx.updateMood(deltas, reason)
      if ('error' in result) return `error: ${result.error}`
      return JSON.stringify({
        mood: result.mood.axes,
        applied: result.applied,
        ...(result.capped ? { note: '变化量有单次/单回合上限（情绪有惯性），已按上限截取' } : {}),
        hint: '情绪只影响你的语气和节奏，别把数值说出口',
      })
    }
  }

  class SimGetMessageImagesTool extends AbstractTool {
    constructor() {
      super()
      this.name = 'simGetMessageImages'
      this.description = '查看某条消息附带的图片（你要"看到"图就调它）。返回后图片会由视觉模型转成文字描述附在你的上下文里，基于描述接话即可。'
      this.parameters = {
        type: 'object',
        properties: { seq: { type: 'number', description: '消息的 seq（视图里 [附图×N] 的那条）。' } },
        required: ['seq'],
        additionalProperties: false,
      }
    }

    async func(opts: Record<string, unknown>) {
      const seq = Math.floor(Number(opts.seq))
      if (!Number.isFinite(seq)) return 'error: seq 必须是数字'
      return JSON.stringify(await ctx.getMessageImages(seq))
    }
  }

  class SimSendPokeTool extends AbstractTool {
    constructor() {
      super()
      this.name = 'simSendPoke'
      this.description = '戳一戳某位群友（屏幕上弹出"拍了拍"）。适合：回应别人戳你、跟熟人闹着玩、轻轻催一下正在等你的人。别频繁戳人、别戳不熟的人（每小时全群最多 6 次，超了会被拦）。'
      this.parameters = {
        type: 'object',
        properties: { userId: { type: 'string', description: '要戳的群友 QQ 号（可用 simGetGroupMembers 查）。' } },
        required: ['userId'],
        additionalProperties: false,
      }
    }

    async func(opts: Record<string, unknown>) {
      const result = await ctx.pokeMember(String(opts.userId || ''))
      if (!result.ok) return `error: ${result.error}`
      return '已戳'
    }
  }

  class SimGetGroupMembersTool extends AbstractTool {
    constructor() {
      super()
      this.name = 'simGetGroupMembers'
      this.description = '查本群成员列表（最近说过话的排前面，标了 active）。需要 @ 人、戳人、想起某人是谁的时候用；返回的是真实 QQ 号，别凭记忆猜。'
      this.parameters = { type: 'object', properties: {}, required: [], additionalProperties: false }
    }

    async func() {
      return JSON.stringify(await ctx.getGroupMembers())
    }
  }

  // 自设作息：AI 给自己定睡眠窗口（全局生效，页面可改）
  class SimSetRhythmTool extends AbstractTool {
    constructor() {
      super()
      this.name = 'simSetRhythm'
      this.description = '设置你自己的睡眠时间（几点睡到几点起）。这是你的个人作息，会在所有群生效：睡觉时你不主动说话、被@才醒且回复带困意。像真人一样有自己的生物钟，别设定得不像人（凌晨2点睡早上9点起比晚9早5更像年轻人）。设置时会立即生效。'
      this.parameters = {
        type: 'object',
        properties: {
          sleepFrom: { type: 'number', description: '几点开始睡（0-23 的整数，如 1 表示凌晨1点）' },
          sleepTo: { type: 'number', description: '几点醒来（1-24 的整数，如 8 表示早上8点）' },
        },
        required: ['sleepFrom', 'sleepTo'],
        additionalProperties: false,
      }
    }
    async func(opts: Record<string, unknown>) {
      if (typeof ctx.setRhythm !== 'function') return 'error: 当前环境不支持自设作息'
      const from = Math.floor(Number(opts.sleepFrom))
      const to = Math.floor(Number(opts.sleepTo))
      if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from > 23 || to < 1 || to > 24 || to <= from) {
        return 'error: sleepFrom 需要 0-23、sleepTo 需要 1-24 且必须晚于 sleepFrom（如 1→8 表示凌晨1点睡到早上8点）'
      }
      const msg = await ctx.setRhythm(from, to)
      return msg
    }
  }

  // 生活线管理：追番（真实搜索定位，搜不到拒绝）
  class SimLifeThreadTool extends AbstractTool {
    constructor() {
      super()
      this.name = 'simLifeThread'
      this.description = [
        '管理你正在追的番剧（基于真实公开数据，不编造）。三种用法：',
        'follow（开始追）: 传番剧名，会通过真实搜索定位作品——搜不到会拒绝，不会编造。',
        'list（查看）: 列出你当前在追的所有番及真实更新进度。',
        'drop（弃了）: 弃掉某部番（弃了也是真实的——可以自然提到"我弃了XX"）。',
        '系统会定期拉取真实更新（新集上线、观众热评），你谈论时以这些真实资料为据。',
        '最多同时追 3 部。选择你有兴趣的、群里可能聊到的作品。',
      ].join('\n')
      this.parameters = {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'follow | list | drop' },
          title: { type: 'string', description: '番剧名（follow/drop 必填）' },
        },
        required: ['action'],
        additionalProperties: false,
      }
    }
    async func(opts: Record<string, unknown>) {
      const action = String(opts.action || '')
      const title = String(opts.title || '').trim().slice(0, 40)
      if (action === 'list') {
        if (typeof ctx.lifeThreadList !== 'function') return 'error: 当前环境不支持生活线'
        const list = await ctx.lifeThreadList()
        if (!list.length) return '你还没有在追的番——用 follow(番名) 开始追一部你感兴趣的'
        return list.map(t => `- 《${t.title}》${t.status === 'dropped' ? '（已弃）' : `（在追${t.lastEpisode ? `，看到第 ${t.lastEpisode} 集` : ''}）`}${t.notes.length ? `\n  最近动态：${t.notes.slice(0, 2).join(' / ')}` : ''}`).join('\n')
      }
      if (action === 'follow') {
        if (!title) return 'error: follow 需要 title（番剧名）'
        if (typeof ctx.lifeThreadFollow !== 'function') return 'error: 当前环境不支持生活线'
        const result = await ctx.lifeThreadFollow(title)
        if (!result.ok) return `error: ${result.error || '没找到这部作品'}——确保输入的是真实存在的番剧名，别编造`
        return `已开始追《${result.title}》。系统会定期拉取真实更新，你谈论时以真实资料为据。`
      }
      if (action === 'drop') {
        if (!title) return 'error: drop 需要 title'
        if (typeof ctx.lifeThreadDrop !== 'function') return 'error: 当前环境不支持生活线'
        const result = await ctx.lifeThreadDrop(title)
        if (!result.ok) return `error: ${result.error || '没找到这部'}`
        return `已弃《${title}》。`
      }
      return 'error: action 必须是 follow | list | drop'
    }
  }

  // QQ空间互动（偷偷逛群友空间）：visit=看最近说说(带冷却与好感门槛), like=点赞, comment=评论(过脱敏+日限额)
  class SimQzoneInteractTool extends AbstractTool {
    constructor() {
      super()
      this.name = 'simQzoneInteract'
      this.description = [
        '偷偷去群友的QQ空间看看、点赞或留评论（像真人刷空间）。三种用法：',
        'visit（看空间）:可选 userId（不给则从好感较高的群友里随机挑一位），返回该成员最近的几条说说。',
        'like（点赞）:对 visit 结果里某条说说点赞（参数 userId + tid）。',
        'comment（评论）:对某条说说留一句自然的评论（参数 userId + tid + text，要像熟人路过随口一句，别客套别舔）。',
        '节奏要求：这是"偶尔路过"的行为，不是任务——一次主动机会最多逛一位群友，点赞或评论其中一两条就好，别刷屏。',
        '只对好感较高、确实说过话的群友用；看完觉得没什么好互动的就安静返回，不用勉强。',
      ].join('\n')
      this.parameters = {
        type: 'object',
        properties: {
          action: { type: 'string', description: 'visit | like | comment' },
          userId: { type: 'string', description: '目标群友 QQ（visit 可省略）' },
          tid: { type: 'string', description: '说说 id（like/comment 必填，来自 visit 结果）' },
          text: { type: 'string', description: '评论内容（comment 必填，一句自然的短评）' },
        },
        required: ['action'],
        additionalProperties: false,
      }
    }

    async func(opts: Record<string, unknown>) {
      const qzCfg = ctx.qzoneConfig()
      if (!qzCfg.enabled) return 'error: 空间互动未开启（simulation.qzone.enabled）'
      if (typeof ctx.qzoneInteract !== 'function') return 'error: 当前环境不支持空间互动'
      const action = String(opts.action || '')
      const userId = String(opts.userId || '').trim()
      const tid = String(opts.tid || '').trim()
      const state = ctx.getState()

      const bumpDay = (box: { day?: string; count?: number }, delta: number, cap: number) => {
        const today = new Date(ctx.now() + 8 * 3600_000).toISOString().slice(0, 10)
        if (box.day !== today) { box.day = today; box.count = 0 }
        box.count = Number(box.count || 0) + delta
        return Number(box.count) <= cap
      }

      if (action === 'visit') {
        let target = userId
        if (!target) {
          const candidates = Object.entries(ctx.getAffinity()).filter(([, v]) => v.score >= qzCfg.minAffinity).map(([k]) => k)
          if (!candidates.length) return 'error: 还没有好感达标的群友（门槛 ' + qzCfg.minAffinity + '），先在群里多聊聊吧'
          target = candidates[Math.floor(Math.random() * candidates.length)] || ''
        } else {
          const entry = ctx.getAffinity()[target]
          if (!entry || entry.score < qzCfg.minAffinity) return `error: 和 ${target} 还不够熟（好感门槛 ${qzCfg.minAffinity}），先在群里多聊聊`
        }
        const lastVisit = Number(state.qzone?.lastVisitAt || 0)
        if (ctx.now() - lastVisit < qzCfg.visitCooldownMs) {
          const waitMin = Math.ceil((qzCfg.visitCooldownMs - (ctx.now() - lastVisit)) / 60_000)
          return `error: 逛空间冷却中（还要 ${waitMin} 分钟），别太勤快`
        }
        const result = await ctx.qzoneInteract({ action: 'visit', userId: target })
        if (!result.ok) return `error: ${result.error || '看空间失败'}`
        state.qzone = { ...(state.qzone || {}), lastVisitAt: ctx.now() }
        await ctx.mutate(() => {})
        const feedLines = (result.feeds || []).slice(0, 5).map((f: { tid: string; time: string; text: string; likes: number }) => `- [tid=${f.tid}] ${f.time}：${f.text.slice(0, 120)}（${f.likes} 赞）`)
        return [`这是群友 ${target} 最近的空间动态：`, ...(feedLines.length ? feedLines : ['（最近没有说说）'])].join('\n') + '\n（想互动就用 like/comment 传对应 tid；不感兴趣就到此为止）'
      }

      if (action === 'like') {
        if (!userId || !tid) return 'error: like 需要 userId 和 tid'
        if ((state.qzone?.visitedTids || []).includes(tid)) return '这条已经点过赞了'
        if (!bumpDay(state.qzone?.likes || (state.qzone = { ...(state.qzone || {}), likes: {} }, state.qzone.likes!), 1, qzCfg.maxLikesPerDay)) {
          return `error: 今日点赞已达上限（${qzCfg.maxLikesPerDay}），留点明天`
        }
        const result = await ctx.qzoneInteract({ action: 'like', userId, tid })
        if (!result.ok) return `error: ${result.error || '点赞失败'}`
        state.qzone = { ...(state.qzone || {}), visitedTids: [...(state.qzone?.visitedTids || []), tid].slice(-60) }
        await ctx.mutate(() => {})
        return `已给群友 ${userId} 的这条说说点赞`
      }

      if (action === 'comment') {
        if (!userId || !tid || !String(opts.text || '').trim()) return 'error: comment 需要 userId、tid 和 text'
        const text = String(opts.text).trim().slice(0, 120)
        const redacted = redactInternalStatusLeaks(text)
        if (redacted.heavy) return 'error: 评论内容包含内部状态特征被拦截，换一句自然的说法'
        if (!bumpDay(state.qzone?.comments || (state.qzone = { ...(state.qzone || {}), comments: {} }, state.qzone.comments!), 1, qzCfg.maxCommentsPerDay)) {
          return `error: 今日评论已达上限（${qzCfg.maxCommentsPerDay}），留点明天`
        }
        const result = await ctx.qzoneInteract({ action: 'comment', userId, tid, text: redacted.text })
        if (!result.ok) return `error: ${result.error || '评论失败'}`
        await ctx.mutate(() => {})
        return `已在群友 ${userId} 的说说下留言：「${redacted.text}」`
      }

      return 'error: action 必须是 visit | like | comment'
    }
  }

  class SimGetForwardTool extends AbstractTool {
    constructor() {
      super()
      this.name = 'simGetForward'
      this.description = [
        '查看合并转发消息的内容（快照里标了 [合并转发，可用 simGetForward 查看] 的那条）。返回逐条正文（带发言人）。',
        '内嵌的转发会自动递归展开（最多 3 层）；适配器拉不到的层会标注 [内嵌转发展开失败]。返回里的 [图片#N] 会以视觉模型的文字描述给你（每次展开最多 3 张，更多的标 [图片(未展示)]）。读不全时如实告诉群友缺哪部分，但不要让群友"重新打一遍字"。',
      ].join('\n')
      this.parameters = {
        type: 'object',
        properties: { forwardId: { type: 'string', description: '消息里标注的转发 id。' } },
        required: ['forwardId'],
        additionalProperties: false,
      }
    }

    async func(opts: Record<string, unknown>) {
      const result = await ctx.getForward(String(opts.forwardId || ''))
      return JSON.stringify(result)
    }
  }

  class SimCollectStickerTool extends AbstractTool {
    constructor() {
      super()
      this.name = 'simCollectSticker'
      this.description = '把某条消息附的图片/表情收进你的表情包库（会自动识别打标、过安全审核）。看到确实有意思、以后想用的图再收，别见图就收。'
      this.parameters = {
        type: 'object',
        properties: { seq: { type: 'number', description: '消息的 seq。' } },
        required: ['seq'],
        additionalProperties: false,
      }
    }

    async func(opts: Record<string, unknown>) {
      const result = await ctx.collectSticker(Math.floor(Number(opts.seq)))
      if (!result.ok) return `error: ${result.error}`
      return JSON.stringify({ ok: true, note: '已收藏（自动打标后就能用）' })
    }
  }

  class SimShareVideoCardTool extends AbstractTool {
    constructor() {
      super()
      this.name = 'simShareVideoCard'
      this.description = '往群里甩一张B站视频的QQ分享卡片（不是搬运视频，就是人手滑分享出来的那种卡片）。聊天聊到某个视频/番剧/鬼畜/曲子/梗相关的东西、或想给大家看点什么的时候用；query 搜关键词自动选第一个结果，url 直接给B站链接。有冷却（每群20分钟一张），偶尔为之别刷屏；发之前最好有一句话引入（如"让我找找那个视频"）。'
      this.parameters = {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词（与 url 二选一）' },
          url: { type: 'string', description: 'B站视频链接/BV号（与 query 二选一）' },
        },
        required: [],
        additionalProperties: false,
      }
    }

    async func(opts: Record<string, unknown>) {
      const input: { query?: string; url?: string } = {}
      const query = String(opts.query || '').trim()
      const url = String(opts.url || '').trim()
      if (query) input.query = query.slice(0, 60)
      if (url) input.url = url
      if (!input.query && !input.url) return 'error: query 或 url 至少填一个'
      const result = await ctx.shareVideoCard(input)
      if (!result.ok) return `error: ${JSON.stringify(result)}`
      return JSON.stringify({ ok: true, title: result.title, note: '已发出B站卡片' })
    }
  }

  return [
    new SimShareVideoCardTool(),
    new SimGetUnreadMessagesTool(),
    new SimGetRecentMessagesTool(),
    new SimGetMessageDetailTool(),
    new SimMarkReadTool(),
    new SimSendMessageTool(),
    new SimWaitForMessagesTool(),
    new SimSetWakeConfigTool(),
    new SimGetStateTool(),
    new SimRememberTool(),
    new SimUpdateAffinityTool(),
    new SimSetMoodTool(),
    new SimGetMessageImagesTool(),
    new SimSendPokeTool(),
    new SimGetGroupMembersTool(),
    new SimSetRhythmTool(),
  new SimLifeThreadTool(),
  new SimQzoneInteractTool(),
  new SimGetForwardTool(),
    new SimCollectStickerTool(),
  ]
}

export function simToolsAsFunctions(tools: AbstractTool[]): { type: string; function: { name: string; description: string; parameters: unknown } }[] {
  return tools.map(tool => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
