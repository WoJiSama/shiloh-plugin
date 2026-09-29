export default [
  {
    component: "SOFT_GROUP_BEGIN",
    label: "长期记忆系统 (memorySystem)"
  },
  { component: "Divider", label: "基础与容量" },
  {
    field: "memorySystem.enabled",
    label: "长期记忆开关",
    component: "Switch",
    bottomHelpMessage: "开启前需在「AI 模型配置」页填好 memoryAiConfig。每个群的每个用户独立记忆,群记忆作为群共识独立维护"
  },
  {
    field: "memorySystem.maxEntitiesPerGroup",
    label: "每群最大实体数",
    component: "InputNumber",
    bottomHelpMessage: "每个群最多记录多少个实体(人/物),超过会按权重淘汰",
    componentProps: { min: 10, max: 2000, placeholder: "200" }
  },
  {
    field: "memorySystem.maxFactsPerGroup",
    label: "每群最大记忆条数",
    component: "InputNumber",
    bottomHelpMessage: "每个群的全局共识记忆最多保存多少条(所有类别总计)",
    componentProps: { min: 10, max: 1000, placeholder: "50" }
  },
  {
    field: "memorySystem.maxFactsPerEntity",
    label: "每实体最大记忆条数",
    component: "InputNumber",
    bottomHelpMessage: "每个实体最多保存多少条记忆,超过会按重要性淘汰",
    componentProps: { min: 1, max: 200, placeholder: "20" }
  },
  {
    field: 'memorySystem.saveStrictness',
    label: '记忆保存严格度',
    component: 'Select',
    bottomHelpMessage: 'off=AI 全权决定;normal=代码边界过滤+AI;strict=最严格过滤',
    componentProps: { options: [
      { label: '宽松(off)', value: 'off' },
      { label: '正常(normal)', value: 'normal' },
      { label: '严格(strict)', value: 'strict' }
    ] }
  },
  { component: "Divider", label: "抽取调度（节流，省 LLM 调用）" },
  {
    field: "memorySystem.userExtractDebounceSeconds",
    label: "用户记忆提取防抖（秒）",
    component: "InputNumber",
    bottomHelpMessage: "用户发言后等待 N 秒(期间无新消息)再抽取,把连续发言合并为一次;0=不防抖即时抽取",
    componentProps: { min: 0, max: 600, placeholder: "90" }
  },
  {
    field: "memorySystem.userExtractMaxBatchMessages",
    label: "用户记忆批量大小",
    component: "InputNumber",
    bottomHelpMessage: "缓冲攒满 N 条用户消息时立即抽取一次(防抖未到也会触发)",
    componentProps: { min: 1, max: 50, placeholder: "6" }
  },
  {
    field: "memorySystem.groupExtractMinIntervalMinutes",
    label: "群记忆最小整理间隔（分钟）",
    component: "InputNumber",
    bottomHelpMessage: "同一群两次记忆整理至少间隔 N 分钟,间隔内的触发会被跳过",
    componentProps: { min: 1, max: 120, placeholder: "10" }
  },
  {
    field: "memorySystem.groupExtractMaxBatchMessages",
    label: "群记忆触发条数",
    component: "InputNumber",
    bottomHelpMessage: "每次群整理最多取最近 N 条候选消息分析",
    componentProps: { min: 1, max: 100, placeholder: "12" }
  },
  { component: "Divider", label: "注入控制" },
  {
    field: "memorySystem.promptMaxGroupFacts",
    label: "注入群记忆最大条数",
    component: "InputNumber",
    bottomHelpMessage: "每次对话时注入 prompt 的群共识记忆条数上限",
    componentProps: { min: 0, max: 50, placeholder: "6" }
  },
  {
    field: "memorySystem.promptMaxEntityFacts",
    label: "注入个人记忆最大条数",
    component: "InputNumber",
    bottomHelpMessage: "每个人（说话人/被提及人）注入 prompt 的个人事实条数上限，按与当前问题的相关度排序后截取",
    componentProps: { min: 0, max: 50, placeholder: "6" }
  },
  {
    field: "memorySystem.promptMaxChars",
    label: "记忆 prompt 字符上限",
    component: "InputNumber",
    bottomHelpMessage: "记忆部分注入 system prompt 的总字符上限，控制 token 消耗",
    componentProps: { min: 100, max: 8000, placeholder: "1200" }
  },
  {
    field: "memorySystem.recallMaxMentionedEntities",
    label: "最大被提及实体数",
    component: "InputNumber",
    bottomHelpMessage: "一条消息中最多解析并注入多少个被提及的人的记忆",
    componentProps: { min: 0, max: 20, placeholder: "3" }
  },
  { component: "Divider", label: "语义召回（需 embeddingAiConfig）" },
  {
    field: "memorySystem.semanticRecallEnabled",
    label: "语义召回开关",
    component: "Switch",
    bottomHelpMessage: "开启后用 embedding 做语义排序与去重(需在「AI 模型配置」页填好 embeddingAiConfig 的 key);默认关,无 key 自动降级为常规排序"
  },
  {
    field: "memorySystem.semanticDupCosine",
    label: "语义去重阈值",
    component: "InputNumber",
    bottomHelpMessage: "写入记忆时两条 fact 的 embedding 余弦相似度 ≥ 该值视为同一事实(需开启语义召回)",
    componentProps: { min: 0, max: 1, step: 0.01, placeholder: "0.88" }
  },
  { component: "Divider", label: "群知识语义裁决" },
  {
    field: "memorySystem.knowledgeDecisionTimeoutMs",
    label: "群知识裁决总超时（毫秒）",
    component: "InputNumber",
    bottomHelpMessage: "由模型判断是否为明确长期群知识教学；在后台运行，超时仅跳过本次保存，不会阻塞正常回复",
    componentProps: { min: 300, max: 8000, step: 100, placeholder: "900" }
  },
  {
    field: "memorySystem.knowledgeDecisionInlineWaitMs",
    label: "回复内确认等待（毫秒）",
    component: "InputNumber",
    bottomHelpMessage: "只在此短窗口内提交成功时才允许自然确认“记住了”；超出后聊天继续，结果仍在后台保存",
    componentProps: { min: 0, max: 1000, step: 20, placeholder: "180" }
  },
  {
    field: "memorySystem.knowledgeDecisionMaxTokens",
    label: "群知识裁决输出上限",
    component: "InputNumber",
    bottomHelpMessage: "裁决器只输出短 JSON；较小的上限能减少额外延迟",
    componentProps: { min: 100, max: 1000, step: 50, placeholder: "400" }
  },
  { component: "Divider", label: "反思巩固（需 memoryAiConfig）" },
  {
    field: "memorySystem.reflectEntityThreshold",
    label: "实体反思触发条数",
    component: "InputNumber",
    bottomHelpMessage: "单个实体活跃记忆超过该条数后触发反思巩固(合并去冗余)",
    componentProps: { min: 1, max: 200, placeholder: "15" }
  },
  {
    field: "memorySystem.reflectGroupThreshold",
    label: "群反思触发条数",
    component: "InputNumber",
    bottomHelpMessage: "群共识记忆超过该条数后触发反思,产出高层洞察",
    componentProps: { min: 1, max: 500, placeholder: "30" }
  },
  { component: "Divider", label: "时间回扣（仅回复内自然提起，不主动发消息）" },
  {
    field: "memorySystem.proactiveCallback",
    label: "自然回扣开关",
    component: "Switch",
    bottomHelpMessage: "开启后会在回复内自然提起时间相关记忆(如'下周考试');绝不主动发消息"
  },
  {
    field: "memorySystem.proactiveWindowDaysBefore",
    label: "回扣窗口(未来天数)",
    component: "InputNumber",
    bottomHelpMessage: "事件时间落在未来 N 天内时可自然回扣(如临近的考试)",
    componentProps: { min: 0, max: 90, placeholder: "3" }
  },
  {
    field: "memorySystem.proactiveWindowDaysAfter",
    label: "回扣窗口(过去天数)",
    component: "InputNumber",
    bottomHelpMessage: "事件时间落在过去 N 天内时可自然回扣(如'考得咋样')",
    componentProps: { min: 0, max: 90, placeholder: "7" }
  }
]
