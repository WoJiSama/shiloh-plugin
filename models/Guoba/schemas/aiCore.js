export default [
  {
    field: "systemContent",
    label: "系统提示词（人设）",
    component: "InputTextArea",
    bottomHelpMessage: "定义 AI 的个性、行为准则和回答风格。这是决定 bot 性格的核心字段",
    componentProps: { rows: 8, placeholder: "你的名字叫哈基米..." }
  },
  {
    field: "useTools",
    label: "工具调用开关",
    component: "Switch",
    bottomHelpMessage: "是否启用扩展功能工具（搜索、点赞、戳一戳、表情包等）"
  },
  {
    field: "maxToolRounds",
    label: "最大工具调用轮次",
    component: "InputNumber",
    bottomHelpMessage: "单次对话中允许 LLM 连续调用工具的最大轮数，防止死循环",
    componentProps: { min: 1, max: 20, placeholder: "2" }
  },
  {
    component: "Divider",
    label: "Agent 智能路由"
  },
  {
    field: "agentIntelligence.enabled",
    label: "智能上下文与模型路由",
    component: "Switch",
    bottomHelpMessage: "启用相关历史选择、复杂请求升档和动态工具轮次"
  },
  {
    field: "agentIntelligence.recentHistoryMessages",
    label: "保留最近连续消息数",
    component: "InputNumber",
    componentProps: { min: 4, max: 30, placeholder: "10" }
  },
  {
    field: "agentIntelligence.relevantHistoryMessages",
    label: "补充相关历史消息数",
    component: "InputNumber",
    componentProps: { min: 0, max: 20, placeholder: "6" }
  },
  {
    field: "agentIntelligence.maxSelectedHistoryMessages",
    label: "最终上下文消息上限",
    component: "InputNumber",
    bottomHelpMessage: "从最近消息、引用邻居和相关历史中选择，不再原样堆满全部历史",
    componentProps: { min: 8, max: 50, placeholder: "18" }
  },
  {
    field: "agentIntelligence.shortChatRecentHistoryMessages",
    label: "短闲聊保留最近消息数",
    component: "InputNumber",
    componentProps: { min: 4, max: 12, placeholder: "6" }
  },
  {
    field: "agentIntelligence.shortChatRelevantHistoryMessages",
    label: "短闲聊补充相关消息数",
    component: "InputNumber",
    componentProps: { min: 0, max: 6, placeholder: "2" }
  },
  {
    field: "agentIntelligence.shortChatMaxSelectedHistoryMessages",
    label: "短闲聊上下文上限",
    component: "InputNumber",
    bottomHelpMessage: "仅用于无媒体、无工具、无引用指代的短消息；复杂请求仍使用完整历史预算",
    componentProps: { min: 6, max: 16, placeholder: "8" }
  },
  {
    field: "agentIntelligence.complexModelRouting",
    label: "复杂请求自动使用工具模型",
    component: "Switch",
    bottomHelpMessage: "长请求、多人物、引用指代、工具总结等场景自动升到 toolsAiConfig 模型"
  },
  {
    field: "agentIntelligence.complexMaxToolRounds",
    label: "复杂任务最大工具轮次",
    component: "InputNumber",
    componentProps: { min: 2, max: 6, placeholder: "3" }
  },
  {
    component: "Divider",
    label: "紧凑任务模型"
  },
  {
    field: "taskAiConfig.casual.apiUrl",
    label: "短闲聊 API URL",
    component: "Input",
    bottomHelpMessage: "短、无工具、非复杂的闲聊使用；留空时回退主对话模型"
  },
  {
    field: "taskAiConfig.casual.model",
    label: "短闲聊模型",
    component: "Input",
    bottomHelpMessage: "建议使用低成本、响应快的模型；不复用对话追踪模型，除非你明确这样配置"
  },
  {
    field: "taskAiConfig.casual.apiKey",
    label: "短闲聊 API Key",
    component: "InputPassword"
  },
  {
    field: "taskAiConfig.casual.maxOutputTokens",
    label: "短闲聊输出额度",
    component: "InputNumber",
    componentProps: { min: 80, max: 800, placeholder: "280" }
  },
  {
    field: "taskAiConfig.casual.reasoningEffort",
    label: "短闲聊推理强度",
    component: "Input",
    bottomHelpMessage: "后端支持时可填 low/none；留空不发送 reasoning_effort"
  },
  {
    field: "taskAiConfig.progress.apiUrl",
    label: "进度回复 API URL",
    component: "Input",
    bottomHelpMessage: "留空时优先复用跟踪模型，没有时再用聊天模型；配置后长任务的自然中途接话使用此后端"
  },
  {
    field: "taskAiConfig.progress.model",
    label: "进度回复模型",
    component: "Input",
    bottomHelpMessage: "建议使用响应快的小模型，不限制厂商或模型名称"
  },
  {
    field: "taskAiConfig.progress.apiKey",
    label: "进度回复 API Key",
    component: "InputPassword"
  },
  {
    field: "taskAiConfig.progress.maxTokensField",
    label: "进度回复输出参数名",
    component: "Select",
    componentProps: {
      options: [
        { label: "max_tokens", value: "max_tokens" },
        { label: "max_completion_tokens", value: "max_completion_tokens" }
      ]
    }
  },
  {
    field: "taskAiConfig.progress.maxOutputTokens",
    label: "进度回复输出额度",
    component: "InputNumber",
    componentProps: { min: 120, max: 800, placeholder: "400" },
    bottomHelpMessage: "需要覆盖部分模型的内部推理消耗；最终可见回复仍会截到一小句"
  },
  {
    field: "taskAiConfig.progress.reasoningEffort",
    label: "进度回复推理强度",
    component: "Input",
    bottomHelpMessage: "后端支持时可填 low/none；留空不发送 reasoning_effort"
  },
  {
    field: "taskAiConfig.progress.timeoutMs",
    label: "进度回复模型超时（毫秒）",
    component: "InputNumber",
    componentProps: { min: 800, max: 15000, placeholder: "6000" }
  },
  {
    field: "taskAiConfig.translation.apiUrl",
    label: "翻译任务 API URL",
    component: "Input",
    bottomHelpMessage: "留空时复用聊天模型；配置后 Modrinth 等短翻译任务使用此后端"
  },
  {
    field: "taskAiConfig.translation.model",
    label: "翻译任务模型",
    component: "Input",
    bottomHelpMessage: "按用途配置，不限制厂商或模型名称"
  },
  {
    field: "taskAiConfig.translation.apiKey",
    label: "翻译任务 API Key",
    component: "InputPassword"
  },
  {
    field: "taskAiConfig.translation.maxTokensField",
    label: "翻译输出参数名",
    component: "Select",
    componentProps: {
      options: [
        { label: "max_tokens", value: "max_tokens" },
        { label: "max_completion_tokens", value: "max_completion_tokens" }
      ]
    }
  },
  {
    field: "taskAiConfig.translation.reasoningEffort",
    label: "翻译推理强度",
    component: "Input",
    bottomHelpMessage: "后端支持时可填 low/none；留空不发送 reasoning_effort"
  },
  {
    component: "Divider",
    label: "回复节奏"
  },
  {
    field: "replyRhythm.enabled",
    label: "自然回复节奏",
    component: "Switch",
    bottomHelpMessage: "默认单条；只把短反应加独立补话拆成两条，并统一约束表情包位置"
  },
  {
    field: "replyRhythm.maxTextMessages",
    label: "单轮最多文字消息数",
    component: "InputNumber",
    componentProps: { min: 1, max: 2, placeholder: "2" }
  },
  {
    field: "replyRhythm.maxEmojiReplyMessages",
    label: "含表情时最多消息数",
    component: "InputNumber",
    bottomHelpMessage: "包括文字和表情包；设为 3 才允许少量文字-表情-文字结构",
    componentProps: { min: 1, max: 3, placeholder: "3" }
  },
  {
    field: "replyRhythm.allowThreePartEmojiReply",
    label: "允许少量三段式表情回复",
    component: "Switch",
    bottomHelpMessage: "仅当表情前后两段含义不同且位置自然时使用，不代表每轮都拆三条"
  },
  {
    component: "Divider",
    label: "理解增强"
  },
  {
    field: "understandingEnhancement.enabled",
    label: "理解增强开关",
    component: "Switch",
    bottomHelpMessage: "遇到引用、合并转发、图片、长上下文或指代词时，注入结构化理解卡片，减少漏看和答偏；不会额外调用模型"
  },
  {
    field: "understandingEnhancement.maxChars",
    label: "理解卡片字符上限",
    component: "InputNumber",
    bottomHelpMessage: "限制理解卡片占用的上下文长度，过大可能挤占聊天历史",
    componentProps: { min: 600, max: 3000, step: 100, placeholder: "1400" }
  },
  {
    field: "understandingEnhancement.includeRecentContext",
    label: "带少量近期上下文",
    component: "Switch",
    bottomHelpMessage: "在理解卡片中加入少量近期对话，帮助理解“这个/刚才/里面”等指代"
  }
]
