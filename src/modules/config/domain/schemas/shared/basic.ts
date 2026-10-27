import type { ConfigSchemaItem } from '../../../../../contracts/configSchema.js'
const schema: ConfigSchemaItem[] = [
  {
    component: "SOFT_GROUP_BEGIN",
    label: "基础与运行"
  },
  {
    field: "enabled",
    label: "插件总开关",
    component: "Switch",
    bottomHelpMessage: "关闭后本插件不再进行 AI 对话，包括 @/前缀、smart 续话、复读跟读和主动搭话。骰子、视频搬运、群管不受影响"
  },
  { component: "Divider", label: "私聊功能" },
  {
    field: "privateChat.enabled",
    label: "启用私聊",
    component: "Switch",
    bottomHelpMessage: "开启后白名单用户可私聊机器人（同一人设/心情/违禁词）；私聊不入归档与记忆索引"
  },
  {
    field: "privateChat.allowedUsers",
    label: "私聊白名单",
    component: "GTags",
    bottomHelpMessage: "可私聊的 QQ 号；留空 = 仅主人可聊",
    componentProps: { allowAdd: true, allowDel: true }
  },
  {
    field: "privateChat.cooldownSeconds",
    label: "私聊冷却(秒)",
    component: "InputNumber",
    bottomHelpMessage: "同一用户两轮私聊的最小间隔；默认 0 = 不节流（由连发合并+发送节奏兜底），设大于 0 会丢弃冷却期内的消息",
    componentProps: { min: 0, max: 60, step: 1, placeholder: "0" }
  },
  {
    field: "privateChat.quoteChance",
    label: "引用概率",
    component: "InputNumber",
    bottomHelpMessage: "私聊回复引用上一条消息的概率（0~1）；一对一对话基本无需引用，默认 0.05",
    componentProps: { min: 0, max: 1, step: 0.05, placeholder: "0.05" }
  },
  {
    field: "privateChat.mergeMs",
    label: "连发合并窗口(毫秒)",
    component: "InputNumber",
    bottomHelpMessage: "窗口内连发的多条私聊消息并成一次回复；0 = 不合并（连发逐条回）",
    componentProps: { min: 0, max: 5000, step: 100, placeholder: "1200" }
  },
  {
    field: "privateChat.allowEmojiTool",
    label: "私聊表情包",
    component: "Switch",
    bottomHelpMessage: "私聊开放表情包工具；关闭后私聊无表情"
  },
  {
    field: "privateChat.allowTools",
    label: "私聊工具白名单",
    component: "GTags",
    bottomHelpMessage: "私聊额外开放的工具名。识图默认已开放；可加 bananaTool（画图）/searchInformationTool（搜索）/videoAnalysisTool（识视频）等",
    componentProps: { allowAdd: true, allowDel: true }
  },
  {
    field: "groupHistory",
    label: "群聊历史记录",
    component: "Switch",
    bottomHelpMessage: "建议开启，使 AI 能参考上下文对话"
  },
  {
    field: "groupMaxMessages",
    label: "最大历史消息数",
    component: "InputNumber",
    bottomHelpMessage: "AI 能记住的最近群聊消息数量",
    componentProps: { min: 10, max: 1000, placeholder: "100" }
  },
  {
    field: "groupChatMemoryMinutes",
    label: "近期上下文保留分钟",
    component: "InputNumber",
    bottomHelpMessage: "Redis 中供 AI 衔接上下文的近期消息保留时间；每条新消息会重新开始计时，不影响长期聊天归档",
    componentProps: { min: 1, max: 1440, placeholder: "60" }
  },
  {
    field: "concurrentLimit",
    label: "并发数限制",
    component: "InputNumber",
    bottomHelpMessage: "单个群同时处理的最大 AI 请求数量；新回合使用新额度，已在处理的请求继续完成",
    componentProps: { min: 1, max: 20, step: 1, placeholder: "3" }
  },
  {
    field: "triggerPrefixes",
    label: "触发关键词",
    component: "GTags",
    bottomHelpMessage: "包含这些词的消息会激活 AI 回复（按回车添加）",
    componentProps: { allowAdd: true, allowDel: true }
  },
  {
    field: "excludeMessageTypes",
    label: "过滤消息类型",
    component: "GTags",
    bottomHelpMessage: "忽略这些类型的消息，通常保持默认 file 即可",
    componentProps: { allowAdd: true, allowDel: true }
  }
]

export default schema
