// 仿真模式（自主仿真会话）类型契约。
// 设计参考 qq-bridge reserved2「一切皆工具」：消息不自动转发给模型，
// 由本地触发器决定何时唤醒 agent 回合，模型用工具自主读消息/发言/等待/设置唤醒。
export type SimWakeReasonKind =
  | 'bootstrap'
  | 'atMention'
  | 'nameMention'
  | 'keyword'
  | 'question'
  | 'speaker'
  | 'anyMessage'
  | 'probability'
  | 'continuation'
  | 'session'
  | 'timeout'
  | 'replyCheck'
  | 'proactiveCheck'
  | 'admin'

export interface SimWakeReason { kind: SimWakeReasonKind; seq?: number; detail?: string }

export interface SimWakeTriggers {
  atMention: boolean
  nameMention: boolean
  keywords: string[]
  question: boolean
  poke: boolean
  anyMessage: boolean
  speakerIds: string[]
  probability: number
}

export interface SimWakeConfig {
  mode: 'diving' | 'active'
  /** 有限潜水的到期时间（epoch ms）；缺省 = 无限潜水（靠触发器唤醒） */
  sleepUntil?: number
  triggers: SimWakeTriggers
  /** 触发合并窗口（ms），期间多条触发按优先级合并为一次唤醒 */
  batchWindowMs: number
  /** 该配置由谁确认：default 可被管理端批量刷新，agent/admin 不覆盖 */
  confirmedBy: 'default' | 'agent' | 'admin'
}

/** 入站消息在仿真会话中的紧凑存储形态（存储层必须保留全部字段，视图层再压缩） */
export interface SimMessage {
  seq: number
  /** OneBot 消息 id（引用回复要用），可能为空 */
  messageId: string | number | null
  userId: string
  name: string
  /** 纯文本（不含引用原文），上限由写入侧截断 */
  text: string
  /** epoch ms */
  at: number
  atSelf: boolean
  /** @ 了别的具体成员（不是机器人）——延续触发要跳过这种"明显在跟别人说话" */
  atOther?: boolean
  quoteToSelf: boolean
  /** 引用的是别人的话：被引用人昵称 + 原文截断（判断"这句话对谁说"的关键信号） */
  quoteAuthor?: string
  quoteText?: string
  /** 合并转发 id（有则可用 simGetForward 查看内容） */
  forwardId?: string
  /** 媒体摘要标记：图片/表情数量等 */
  imageCount: number
  /** 图片 URL（≤2 条，供 simGetMessageImages 取图进多模态回合） */
  imageUrls?: string[]
  /** 被引用消息里的图片 URL（引用别人带图的旧消息时，图在这里；模型经 simGetMessageImages 查看） */
  quoteImageUrls?: string[]
  kind: 'text' | 'poke'
}

export interface SimPreSleepWait {
  satisfiedAt?: number
  observedAt?: number
  accumMs: number
}

/** agent 自持对话历史的一条消息（OpenAI 兼容形状的最小子集；type 而非 interface 以获得隐式索引签名，可直接作 ChatMessage 传入） */
export type SimHistoryMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: unknown
  tool_calls?: { id?: string; type?: string; function?: { name?: string; arguments?: string } }[]
  tool_call_id?: string
  name?: string
}

export interface SimBudgetState { day: string; turns: number; tokens: number }

/** agent 自管记忆：pendingEvent=待跟进（到期提醒），note=事实/约定，impression=群友印象，meme=本群专属梗 */
export type SimMemoryKind = 'pendingEvent' | 'note' | 'impression' | 'meme' | 'activeTopic'

export interface SimMemoryEntry {
  id: string
  kind: SimMemoryKind
  content: string
  /** 相关群友 QQ（impression/pendingEvent 常带） */
  aboutUser?: string
  /** pendingEvent 的到期时间（epoch ms）；到期后注入唤醒 prompt 提醒跟进 */
  dueAt?: number
  /** meme 专用：出现/使用次数（注入排序与强化依据） */
  count?: number
  /** meme 专用：出处原话（谁第一次说的） */
  origin?: string
  /** activeTopic 专用：过期时间（epoch ms，默认创建后 6 小时）；过期即从注入与列表中消失 */
  expiresAt?: number
  done: boolean
  createdAt: number
  updatedAt: number
  source: 'agent' | 'admin'
}

/** 好感度：0-100，50 起步；按 (群,群友) 维度，随互动小幅移动 */
export interface SimAffinityEntry {
  score: number
  updatedAt: number
  /** 当日已变动额度（防刷：每群友每日 ±dailyCap） */
  today: string
  todayDelta: number
  reasons: string[]
}

export type SimAffinityMap = Record<string, SimAffinityEntry>

export interface SimSessionState {
  /** 本群单调消息序号 */
  seq: number
  /** 未读环形缓冲（≤ unreadLimit，淘汰即视为再也不可能展示） */
  unread: SimMessage[]
  /** 近期消息环形缓冲（含已读，≤ recentLimit）——给模型查"刚才聊了什么"用 */
  recent: SimMessage[]
  lastReadThroughSeq: number
  /** 确实给过模型的 seq（裁剪到 unread 窗口内） */
  modelSeenSeqs: number[]
  wakeConfig: SimWakeConfig
  lastIncomingAt: number
  lastAiSendAt: number
  lastWakeReason: SimWakeReason | null
  lastWakeAt: number
  /** 回合忙时暂存的触发原因（≤20），回合结束补发 */
  pendingWakeReasons: SimWakeReason[]
  /** 唤醒限频滚动窗 */
  wakeTimes: number[]
  /** 发送限频滚动窗 */
  sendTimes: number[]
  preSleepWait: SimPreSleepWait
  agentHistory: SimHistoryMessage[]
  budget: SimBudgetState
  nextProactiveCheckAt: number
  nextReplyCheckAt: number
  bootstrapSent: boolean
  /** 会话延续状态：机器人最近参与过对话 → 对话对象的新消息即使不点名也值得醒来看（模型自行决定接不接） */
  conversation: { activeUntil: number; interlocutorIds: string[]; lastTriggerUserId?: string }
  /** 陪玩模式上次主动唤醒时间（epoch ms）——冷却节奏控制，避免跑团期间刷屏/烧钱 */
  lastPlayAlongWakeAt?: number
  /** 群梗自动提取游标：已提取到哪条消息（seq）、上次提取时间 */
  memeCursor?: { seq: number; at: number }
}

/** message.yaml pluginSettings.simulation 配置段（未解码的宽松形状） */
export interface SimulationSection {
  enabled?: boolean
  /** true（默认）= 所有过了群白名单的群都进仿真；false = 仅 groups 清单（含 .仿真 开 追加的） */
  allGroups?: boolean
  groups?: unknown
  wake?: {
    probability?: number
    batchWindowMs?: number
    maxWakePerMinute?: number
    maxWakePerHour?: number
    proactiveIdleMs?: number
    proactiveCheckMinMs?: number
    proactiveCheckMaxMs?: number
    proactiveProbability?: number
    replyCheckMs?: number
    continuationWindowMs?: number
    /** 陪玩模式主动唤醒的最小间隔（ms，默认 5 分钟）：跑团等持续活动期间的跟进节奏 */
    playAlongGapMs?: number
  }
  /** 唤醒预判闸：低信号唤醒先由便宜模型小上下文预判值不值得进完整回合（被@/开场/活跃档等直达）；model 缺省用 memoryAiModel */
  wakeGate?: { enabled?: boolean; model?: string }
  /** 活跃助推窗口时长（ms，默认 3 小时）：.仿真 模式 活跃 的系统兜底节奏只在该窗口内生效，过期回落自主、AI 自设配置接管 */
  activeBoostMs?: number
  /** 仿真回合模型：缺省沿用 toolsAiModel；设为 glm-5.3-flash 等可整体降档（省 token） */
  turnModel?: string
  budget?: {
    dailyCostCny?: number
    /** 按群消耗上限覆盖（键=群号，值=该群每日金额上限元，-1=不限）；未列出的群用 dailyCostCny */
    groups?: Record<string, number>
  }
  /** 按人挖口头禅（风格个性化）：从归档挖每个群友的专属说法，注入高好感对象的风格指引 */
  userStyle?: {
    enabled?: boolean
    cooldownMs?: number
    archiveDays?: number
  }
  turn?: {
    maxToolRounds?: number
    maxSendsPerTurn?: number
    minSendGapMs?: number
    sendPerMinute?: number
    maxTurnsPerDay?: number
    historyMaxMessages?: number
    historyMaxChars?: number
    unreadLimit?: number
    wakeMessageLimit?: number
    wakeMaxChars?: number
    messageTextMaxChars?: number
    waitQuietMaxMs?: number
    waitTimeoutMaxMs?: number
    /** 按群每日回合上限覆盖（键=群号，-1=不限）；未列出的群用 maxTurnsPerDay */
    groups?: Record<string, number>
  }
  agentPresetKeywords?: string[]
  /** 仿真回合额外放通的既有工具名（白名单：不在此列的 40 工具仍不可用） */
  extraTools?: unknown
  /** 本群专属梗自动提取（从群聊自身长出来的梗，不联网） */
  meme?: {
    enabled?: boolean
    extractCooldownMs?: number
    extractMinMessages?: number
    injectMax?: number
  }
}

/** 归一化后的仿真运行配置（domain 默认值 + yaml 覆盖） */
export interface SimRuntimeConfig {
  enabled: boolean
  /** 所有过了群白名单的群默认进仿真（.仿真 关 可按群退出） */
  allGroups: boolean
  wake: Required<Pick<NonNullable<SimulationSection['wake']>, 'probability' | 'batchWindowMs' | 'maxWakePerMinute' | 'maxWakePerHour' | 'proactiveIdleMs' | 'proactiveCheckMinMs' | 'proactiveCheckMaxMs' | 'proactiveProbability' | 'replyCheckMs' | 'continuationWindowMs' | 'playAlongGapMs'>>
  turn: Required<Pick<NonNullable<SimulationSection['turn']>, 'maxToolRounds' | 'maxSendsPerTurn' | 'minSendGapMs' | 'sendPerMinute' | 'maxTurnsPerDay' | 'historyMaxMessages' | 'historyMaxChars' | 'unreadLimit' | 'wakeMessageLimit' | 'wakeMaxChars' | 'messageTextMaxChars' | 'waitQuietMaxMs' | 'waitTimeoutMaxMs'>> & { groups: Record<string, number> }
  agentPresetKeywords: string[]
  extraTools: string[]
  meme: { enabled: boolean; extractCooldownMs: number; extractMinMessages: number; injectMax: number }
  budget: { dailyCostCny: number; groups: Record<string, number> }
  /** 唤醒预判闸开关（模型与凭证在装配层解析） */
  wakeGate: { enabled: boolean }
  /** 活跃助推窗口时长（ms） */
  activeBoostMs: number
  userStyle: { enabled: boolean; cooldownMs: number; archiveDays: number }
}
