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
  | 'commitment'
  | 'characterGoal'
  | 'interestUpdate'
  | 'projectUpdate'

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
  /** 已截断的消息不能证明明确社交许可。 */
  textTruncated?: boolean
  /** epoch ms */
  at: number
  atSelf: boolean
  /** @ 了别的具体成员（不是机器人）——延续触发要跳过这种"明显在跟别人说话" */
  atOther?: boolean
  quoteToSelf: boolean
  /** 引用的是别人的话：被引用人昵称 + 原文截断（判断"这句话对谁说"的关键信号） */
  quoteAuthor?: string
  quoteText?: string
  /** 引用回复的目标 QQ（e.source 缺失时从 CQ 串解析的兜底，QQ 引用回复自动 @被回复人；名字可能已并入 quoteAuthor） */
  replyToUserId?: string
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
  /** Internal projection metadata. Never sent as provider message fields. */
  conversationUserId?: string
}

export interface SimBudgetState { day: string; turns: number; tokens: number }

/** agent 自管记忆：pendingEvent=待跟进（到期提醒），note=事实/约定，impression=群友印象，meme=本群专属梗 */
export type SimMemoryKind = 'pendingEvent' | 'note' | 'impression' | 'meme' | 'activeTopic' | 'interaction'

export interface SimMemoryEntry {
  id: string
  kind: SimMemoryKind
  content: string
  /** 相关群友 QQ（impression/pendingEvent 常带） */
  aboutUser?: string
  /** pendingEvent 的到期时间（epoch ms）；到期后注入唤醒 prompt 提醒跟进 */
  dueAt?: number
  /** 运行时核验的邀请来源；旧的模型布尔值不能单独授权主动跟进。 */
  proactiveSourceSeq?: number
  /** 自我笔记可引用当时实际看过的本群消息，旧笔记可以没有。 */
  habitMessageSeqs?: number[]
  /** Recorded using confirmed outgoing replies as well as the incoming anchors. */
  habitBasis?: 'delivered'
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
  sharedSelfFingerprint?: string
  /** Version of the shared revocation key used by this history snapshot. */
  activityVersion?: string
  /** First bot observed owns this group session. A second account must use a separate runtime. */
  botId?: string
  personaId?: string
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
  /** 最近一次随机主动检查用过的入站序号。 */
  lastProactiveCheckedSeq?: number
  /** 已进入到期社交检查的记忆 ID。入选不代表已发送或处理完。 */
  offeredFollowUpIds?: string[]
  /** 同人格上一轮已确认投递的正文，供接话参考。 */
  lastConfirmedChat?: { at: number; userId?: string; text: string }
  /** Recent confirmed replies keyed by the incoming message they answered. */
  recentConfirmedReplies?: { seq: number; at: number; text: string; messageIds: string[] }[]
  bootstrapSent: boolean
  /** 会话延续状态：机器人最近参与过对话 → 对话对象的新消息即使不点名也值得醒来看（模型自行决定接不接） */
  conversation: { activeUntil: number; interlocutorIds: string[]; lastTriggerUserId?: string }
  /** 陪玩模式上次主动唤醒时间（epoch ms）——冷却节奏控制，避免跑团期间刷屏/烧钱 */
  lastPlayAlongWakeAt?: number
  /** QQ空间互动记账：上次逛空间时间 + 当日点赞/评论数（day=yyyymmdd 滚动） */
  qzone?: { lastVisitAt?: number; likes?: { day?: string; count?: number }; comments?: { day?: string; count?: number }; visitedTids?: string[] }
  /** 人物核心档案提取游标（已提取到哪条 seq、上次提取时间） */
  personProfileCursor?: { seq: number; at: number }
  /** 群梗自动提取游标：已提取到哪条消息（seq）、上次提取时间 */
  memeCursor?: { seq: number; at: number }
}

/** 情绪四轴状态（跨群全局，shiloh:sim:mood）：axes 为上次写入的瞬时值（1-10），读取侧按半衰期投影。 */
export interface SimMoodState {
  axes: { joy: number; anger: number; sorrow: number; fear: number }
  /** 上次更新时间（epoch ms）——投影起点 */
  updatedAt: number
  /** 最近变动理由（新在前，≤8 条）——审计/状态展示用 */
  reasons?: string[]
}

/** message.yaml pluginSettings.simulation 配置段（未解码的宽松形状） */
export interface SimulationSection {
  /** Experimental semantic review is opt-in and requires its own configured task backend. */
  consistency?: { enabled?: boolean }
  /** 后台角色反思的资源边界；行为不由管理员逐轮编排。 */
  reflection?: { enabled?: boolean }
  /** Explicit additional autonomous creative capabilities; still intersected with current tool policy. */
  autonomousTools?: string[]
  capabilities?: {
    enabled?: boolean
    groups?: string[]
    projectUpdatesInAtOnly?: boolean
    mcpTools?: string[]
    autonomousTools?: string[]
  }
  worker?: { endpoint?: string; token?: string; enabled?: boolean }
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
  /** QQ空间互动（偷偷逛群友空间点赞/评论）：开关、冷却、日限额与好感门槛 */
  qzone?: { enabled?: boolean; visitCooldownMs?: number; maxLikesPerDay?: number; maxCommentsPerDay?: number; minAffinity?: number }
  /** 人物核心档案（跨群）：称呼/长期爱好/雷点——只在所有群都合适的身份级事实；提取冷却与字段上限 */
  personProfile?: { enabled?: boolean; extractCooldownMs?: number; maxFields?: number }
  /** 生物节律：作息窗口（小时，AI 可用 simSetRhythm 自设）与分时活跃调制 */
  rhythm?: { enabled?: boolean; sleepFrom?: number; sleepTo?: number }
  /** 生活线：真实数据源的持续关注线（在追的番/在玩的游戏），同步冷却与条数上限 */
  lifeThreads?: { enabled?: boolean; maxThreads?: number; syncIntervalMs?: number }
  /** 情绪四轴（跨群全局）：AI 用 simSetMood 小幅更新，半衰期自动回归静息 */
  mood?: { enabled?: boolean; halfLifeMinutes?: number; maxStep?: number }
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
    /** 滑动 60 分钟窗口的发送条数上限——防"每条必回"式高频输出（实拍事故：13 分钟 13 条被群友识破） */
    sendsPerHour?: number
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
  /** 仿真回合额外放通的既有工具名（legacy 白名单；open 模式下作为追加面——自定义工具仍走这里显式放行） */
  extraTools?: unknown
  /** 工具能力策略（P1-3 翻转）：mode=open 默认放通全量内置安全工具再按需做减法；legacy=仅 extraTools 白名单 */
  toolPolicy?: unknown
  /** 本群专属梗自动提取（从群聊自身长出来的梗，不联网） */
  meme?: {
    enabled?: boolean
    extractCooldownMs?: number
    extractMinMessages?: number
    injectMax?: number
  }
}

/** 工具能力策略（仿真回合既有工具的放通口径） */
export interface SimToolPolicyConfig {
  /** legacy=仅 extraTools 白名单（P0 行为，可一键回退）；open=默认放通内置安全工具再做减法 */
  mode: 'legacy' | 'open'
  /** 显式放行（可解禁 RESTRICTED 默认禁的敏感工具；自定义工具也走这里） */
  allowTools: string[]
  /** 全局减法（对 open 默认面与 allowTools 都生效） */
  denyTools: string[]
  /** 按群减法：键=群号，值=工具名数组 */
  groups: Record<string, string[]>
}

/** 归一化后的仿真运行配置（domain 默认值 + yaml 覆盖） */
export interface SimRuntimeConfig {
  enabled: boolean
  /** 所有过了群白名单的群默认进仿真（.仿真 关 可按群退出） */
  allGroups: boolean
  wake: Required<Pick<NonNullable<SimulationSection['wake']>, 'probability' | 'batchWindowMs' | 'maxWakePerMinute' | 'maxWakePerHour' | 'proactiveIdleMs' | 'proactiveCheckMinMs' | 'proactiveCheckMaxMs' | 'proactiveProbability' | 'replyCheckMs' | 'continuationWindowMs' | 'playAlongGapMs'>>
  turn: Required<Pick<NonNullable<SimulationSection['turn']>, 'maxToolRounds' | 'maxSendsPerTurn' | 'minSendGapMs' | 'sendPerMinute' | 'sendsPerHour' | 'maxTurnsPerDay' | 'historyMaxMessages' | 'historyMaxChars' | 'unreadLimit' | 'wakeMessageLimit' | 'wakeMaxChars' | 'messageTextMaxChars' | 'waitQuietMaxMs' | 'waitTimeoutMaxMs'>> & { groups: Record<string, number> }
  agentPresetKeywords: string[]
  extraTools: string[]
  /** 归一化后的工具能力策略（open=默认放通内置安全工具再减法；legacy=仅 extraTools 白名单） */
  toolPolicy: SimToolPolicyConfig
  meme: { enabled: boolean; extractCooldownMs: number; extractMinMessages: number; injectMax: number }
  budget: { dailyCostCny: number; groups: Record<string, number> }
  /** 唤醒预判闸开关（模型与凭证在装配层解析） */
  wakeGate: { enabled: boolean }
  /** 活跃助推窗口时长（ms） */
  activeBoostMs: number
  qzone: { enabled: boolean; visitCooldownMs: number; maxLikesPerDay: number; maxCommentsPerDay: number; minAffinity: number }
  personProfile: { enabled: boolean; extractCooldownMs: number; maxFields: number }
  rhythm: { enabled: boolean; sleepFrom: number; sleepTo: number }
  lifeThreads: { enabled: boolean; maxThreads: number; syncIntervalMs: number }
  userStyle: { enabled: boolean; cooldownMs: number; archiveDays: number }
  /** 情绪四轴（跨群全局）：半衰期投影在读取侧做 */
  mood: { enabled: boolean; halfLifeMs: number; maxStep: number }
}
