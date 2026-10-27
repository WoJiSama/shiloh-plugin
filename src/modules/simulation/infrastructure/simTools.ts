import type { SimMemoryEntry, SimSessionState, SimWakeConfig } from '../../../contracts/simulation.js'
import { coerceStringArray, looksLikeToolArguments } from '../domain/paramTolerance.js'
import { stripAIFlavorPhrases } from '../../conversation/domain/replySanitizer.js'
import { compactSimMessage } from '../domain/messageView.js'
import { acknowledgeMessages, readThroughSeq, noteModelSeen, unreadSince } from '../domain/watermark.js'
import { normalizeSimWakeConfig, ensureWakeable } from '../domain/simConfig.js'
import { activeMemories, applyAffinityDelta, capMemories, defaultAffinityEntry, dueMemories, normalizeSimMemoryEntry, SIM_MEMORY_LIMIT } from '../domain/simMemory.js'
import type { SimWaitPlan } from '../domain/waitGate.js'
import { AbstractTool } from '../../toolSupport/infrastructure/AbstractTool.js'

export type SimSendResult = { ok: true; sent: number } | { ok: false; error: string }
export interface SimWaitResult { hint: string; canSleepNow: boolean; newMessagesText: string; newCount: number; readThroughSeq: number; partial: boolean }

/**
 * 每个仿真回合构建一次的上下文：工具全部绑定当前群与当前会话状态。
 * 发送目标由上下文绑定（参数里没有群号）——这是免发送白名单的根本设计。
 */
export interface SimToolContext {
  groupId: string
  now(): number
  getState(): SimSessionState
  /** 读取-修改-保存（回合内单线程，mutate 保证落盘） */
  mutate<T>(fn: (state: SimSessionState) => T): Promise<T>
  sendMessage(messages: string[], opts: { replyToMessageId?: string | number; atUserIds?: string[] }): Promise<SimSendResult>
  waitForMessages(plan: SimWaitPlan): Promise<SimWaitResult>
  applyWakeConfig(config: SimWakeConfig): void
  sendsThisTurn(): number
  maxSendItems(): number
  messageTextMaxChars(): number
  /** agent 自管记忆（读-改-存，回合内单线程） */
  getMemories(): SimMemoryEntry[]
  saveMemories(memories: SimMemoryEntry[]): void
  /** 好感度表 */
  getAffinity(): Record<string, ReturnType<typeof defaultAffinityEntry>>
  saveAffinity(affinity: Record<string, ReturnType<typeof defaultAffinityEntry>>): void
  /** 取某条消息的图片（多模态）：由 runtime 经 ports.fetchImageBase64 实现 */
  getMessageImages(seq: number): Promise<{ seq: number; images: { mime: string; base64: string }[]; error?: string }>
  /** 戳群成员（带频率护栏：每群每小时 ≤6 次） */
  pokeMember(userId: string): Promise<{ ok: boolean; error?: string }>
  /** 群成员列表（活跃者优先） */
  getGroupMembers(): Promise<{ userId: string; nick: string; active?: boolean }[] | { error: string }>
  /** 查看合并转发内容 */
  getForward(forwardId: string): Promise<{ lines: string[]; error?: string }>
  /** 精选收藏某条消息的附图进表情包库 */
  collectSticker(seq: number): Promise<{ ok: boolean; error?: string }>
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
        noteModelSeen(state, messages.map(m => m.seq))
        const now = ctx.now()
        const lines = messages.map(m => compactSimMessage(m, now))
        return JSON.stringify({
          messages: lines,
          count: messages.length,
          readThroughSeq: readThroughSeq(state),
          remainingUnread: state.unread.filter(m => !messages.some(x => x.seq === m.seq)).length,
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
        return JSON.stringify({
          messages: ordered.map(m => compactSimMessage(m, now)).reverse(),
          count: ordered.length,
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
      const state = ctx.getState()
      const message = [...state.unread, ...state.recent].find(m => m.seq === seq)
      if (!message) return JSON.stringify({ found: false, hint: '该消息不在近期缓冲里（可能太旧），可用 simGetRecentMessages 翻更早的记录。' })
      return JSON.stringify({ found: true, message: compactSimMessage(message, ctx.now()), messageId: message.messageId, imageCount: message.imageCount })
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
        '在当前群发言。传字符串数组 = 分多条连发（像真人打字连发），传单个字符串 = 一条。',
        '条与条之间系统会自动加间隔，不要自己写停顿标记。',
        '想引用某条消息就传 replyToSeq（视图里的 seq）；想 @ 人就传 atUserIds（QQ 号数字）。',
        '发送失败会返回 error，此时可换措辞重试或放弃，不要原样重试超过一次。',
      ].join('\n')
      this.parameters = {
        type: 'object',
        properties: {
          messages: { type: 'array', items: { type: 'string' }, description: '要发的内容，1-5 条，每条 ≤500 字。' },
          replyToSeq: { type: 'number', description: '可选：引用哪条消息（seq）。' },
          atUserIds: { type: 'array', items: { type: 'string' }, description: '可选：要 @ 的 QQ 号，最多 3 个。' },
        },
        required: ['messages'],
        additionalProperties: false,
      }
    }

    async func(opts: Record<string, unknown>) {
      const maxItems = Math.min(ctx.maxSendItems(), 5)
      const messages = coerceStringArray(opts.messages, { maxLength: maxItems, itemMaxChars: SEND_TEXT_MAX_CHARS })
      if (!messages) return 'error: messages 必须是非空字符串或字符串数组（最多 ' + maxItems + ' 条）'
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
      if (!result.ok) return `error: ${result.error}`
      return JSON.stringify({ sent: result.sent, note: '已发出，不要在后续文本里再汇报"已发送"。' })
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
      const result = await ctx.waitForMessages(plan)
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
      return JSON.stringify({
        mode: state.wakeConfig.mode,
        triggers: state.wakeConfig.triggers,
        unreadCount: state.unread.length,
        readThroughSeq: readThroughSeq(state),
        lastAiSendAtAgo: state.lastAiSendAt ? Math.round((ctx.now() - state.lastAiSendAt) / 1000) + ' 秒前' : '未发言',
        lastWakeReason: state.lastWakeReason?.kind || '无',
        todayTurns: state.budget.turns,
        sendsThisTurn: ctx.sendsThisTurn(),
      })
    }
  }

  class SimRememberTool extends AbstractTool {
    constructor() {
      super()
      this.name = 'simRemember'
      this.description = [
        '你的长期记忆（跨回合、跨天保存）。群友提到未来安排/约定/考试/生日时记 pendingEvent（必须给 dueInMinutes，到点系统会提醒你跟进）；',
        '值得记住的事实、约定、对某个人的印象记 note 或 impression；你自己形成的口头禅/偏好记 note（不带 aboutUser，这是你的性格沉淀）。',
        'action=list 查看记忆；跟进完成后 action=done 收掉待办；action=remove 删除记错的。',
      ].join('\n')
      this.parameters = {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add', 'list', 'done', 'remove'], description: '默认 add。' },
          kind: { type: 'string', enum: ['pendingEvent', 'note', 'impression', 'meme', 'activeTopic'], description: 'add 时的类型，默认 note。meme=本群专属梗（系统也会自动提取）；activeTopic=正在聊的话题（6小时后自动过期，聊完用 done 删掉）。' },
          content: { type: 'string', description: '要记的内容，一句话（≤200 字）。例："阿说明天上午要考四级，说考完想打游戏"。' },
          aboutUser: { type: 'string', description: '可选：相关的群友 QQ 号。' },
          dueInMinutes: { type: 'number', description: 'kind=pendingEvent 必填：多少分钟后该跟进（10 分钟 ~ 30 天）。' },
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
        const memories = activeMemories(ctx.getMemories(), now, 12)
        if (!memories.length) return '记忆为空。'
        const due = new Set(dueMemories(ctx.getMemories(), now).map(m => m.id))
        return JSON.stringify(memories.map(m => ({
          id: m.id, kind: m.kind, content: m.content, aboutUser: m.aboutUser,
          ...(m.kind === 'meme' && m.count ? { heat: m.count } : {}),
          due: m.dueAt ? (due.has(m.id) ? `已到期（该跟进了）` : `${Math.max(0, Math.round((m.dueAt - now) / 60000))} 分钟后到期`) : undefined,
        })))
      }
      if (action === 'done' || action === 'remove') {
        const id = String(opts.id || '')
        const memories = ctx.getMemories()
        const index = memories.findIndex(m => m.id === id)
        if (index < 0) return `error: 找不到记忆 ${id}，可先用 action=list 查看`
        if (action === 'remove') {
          const removed = memories.splice(index, 1)
          ctx.saveMemories(capMemories(memories, SIM_MEMORY_LIMIT))
          return `已删除：${removed[0]?.content || ''}`
        }
        memories[index] = { ...memories[index]!, done: true, updatedAt: now }
        ctx.saveMemories(capMemories(memories, SIM_MEMORY_LIMIT))
        return `已收掉待办：${memories[index]!.content}`
      }
      const entry = normalizeSimMemoryEntry({
        kind: opts.kind,
        content: opts.content,
        aboutUser: opts.aboutUser,
        dueAt: opts.kind === 'pendingEvent' && Number(opts.dueInMinutes) > 0 ? now + Math.min(43200, Math.max(10, Math.floor(Number(opts.dueInMinutes)))) * 60_000 : undefined,
      }, now)
      if (!entry) return 'error: content 不能为空'
      if (opts.kind === 'pendingEvent' && !(Number(opts.dueInMinutes) > 0)) {
        return 'error: pendingEvent 必须给 dueInMinutes（10 分钟 ~ 30 天）'
      }
      const memories = [...ctx.getMemories(), entry]
      ctx.saveMemories(capMemories(memories, SIM_MEMORY_LIMIT))
      return JSON.stringify({ saved: true, id: entry.id, note: entry.kind === 'pendingEvent' ? '到点后系统会在唤醒时提醒你跟进。' : undefined })
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
      ctx.saveAffinity(affinity)
      return JSON.stringify({ applied: result.applied, score: result.entry.score, capped: result.capped })
    }
  }

  class SimGetMessageImagesTool extends AbstractTool {
    constructor() {
      super()
      this.name = 'simGetMessageImages'
      this.description = '查看某条消息附带的图片（你要"看到"图就调它）。返回后图片会直接出现在你的上下文里，然后用一句话描述你看到了什么、怎么接。'
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

  class SimGetForwardTool extends AbstractTool {
    constructor() {
      super()
      this.name = 'simGetForward'
      this.description = [
        '查看合并转发消息的内容（快照里标了 [合并转发，可用 simGetForward 查看] 的那条）。返回逐条正文（带发言人）。',
        '返回里的 [图片#N] 会直接给你看（每次展开最多 3 张，更多的标 [图片(未展示)]）。读不全时如实告诉群友缺什么，但不要让群友"重新打一遍字"——能展开的展开，实在缺的说明缺的部分就行。',
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
      return '已收藏（自动打标后就能用）'
    }
  }

  return [
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
    new SimGetMessageImagesTool(),
    new SimSendPokeTool(),
    new SimGetGroupMembersTool(),
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
