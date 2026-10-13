import type { ConfigSchemaItem } from '../../../../../contracts/configSchema.js'
const schema: ConfigSchemaItem[] = [
  {
    component: "SOFT_GROUP_BEGIN",
    label: "表达学习系统 (expressionLearning)"
  },
  {
    field: "expressionLearning.enabled",
    label: "表达学习开关",
    component: "Switch",
    bottomHelpMessage: "让机器人学习群友的说话风格（每群独立）"
  },
  {
    field: "expressionLearning.minWordFrequency",
    label: "最小词频",
    component: "InputNumber",
    bottomHelpMessage: "词汇出现至少几次才记录",
    componentProps: { min: 1, max: 50, placeholder: "3" }
  },
  {
    field: "expressionLearning.maxWords",
    label: "最大词汇数",
    component: "InputNumber",
    bottomHelpMessage: "每群最多记录多少个高频词",
    componentProps: { min: 5, max: 500, placeholder: "50" }
  },
  {
    field: "expressionLearning.blockedWords",
    label: "屏蔽词列表",
    component: "GTags",
    bottomHelpMessage: "不学习这些词（按回车添加）",
    componentProps: { allowAdd: true, allowDel: true }
  },
  {
    field: "expressionLearning.aiLearningEnabled",
    label: "AI 场景化学习开关",
    component: "Switch",
    bottomHelpMessage: "使用 AI 提取表达模式（复用「AI 模型配置」页的 memoryAiConfig），未配置时降级为词频统计"
  },
  {
    field: "expressionLearning.aiLearningMessageThreshold",
    label: "AI 学习消息阈值",
    component: "InputNumber",
    bottomHelpMessage: "积累多少条消息后触发一次 AI 学习",
    componentProps: { min: 10, max: 500, placeholder: "50" }
  },
  {
    field: "expressionLearning.sequenceWindowMs",
    label: "连续消息时间窗（毫秒）",
    component: "InputNumber",
    bottomHelpMessage: "同一群友在此时间内连续发送的文字/表情包会作为一整轮学习；其他人插话会立即断开",
    componentProps: { min: 3000, max: 120000, step: 1000, placeholder: "20000" }
  },
  {
    field: "expressionLearning.maxSequenceTurns",
    label: "每轮最大学习条数",
    component: "InputNumber",
    bottomHelpMessage: "最多学习同一轮中的几条消息，建议保持 2-3，避免把长刷屏学成常态",
    componentProps: { min: 2, max: 5, placeholder: "3" }
  },
  {
    field: "expressionLearning.maxSequenceSamples",
    label: "整轮节奏样本上限",
    component: "InputNumber",
    bottomHelpMessage: "每个群最多保留多少条整轮节奏样本",
    componentProps: { min: 5, max: 100, placeholder: "30" }
  }
]

export default schema
