import type { SchemaFieldDefinition, SchemaGroup } from './schemaState'

export type PolicyKind = 'dice' | 'tracking' | 'memory'
export interface PolicySection {
  id: string
  label: string
  groups: SchemaGroup[]
}
interface SectionRule {
  id: string
  label: string
  matches: (field: SchemaFieldDefinition, group: SchemaGroup) => boolean
}

const rules: Record<PolicyKind, SectionRule[]> = {
  dice: [
    {
      id: 'basics',
      label: '开关与检定',
      matches: (field) =>
        /^diceSystem\.(enabled|customRulesEnabled|defaultRule|allowHiddenRoll|logAiSilent)$/.test(
          field.field
        )
    },
    {
      id: 'limits',
      label: '掷骰上限',
      matches: (field) => /^diceSystem\.(maxDiceCount|maxDiceSides|maxRounds)$/.test(field.field)
    },
    { id: 'storage', label: '日期与团录', matches: () => true }
  ],
  tracking: [
    { id: 'strict', label: '严格模式', matches: (_, group) => group.label.startsWith('严格模式') },
    {
      id: 'frequency',
      label: '参与频率',
      matches: (_, group) => /频率与阈值|强制触发|时段化频率/.test(group.label)
    },
    {
      id: 'replies',
      label: '回复与续话',
      matches: (_, group) => /打断保护|本地识别/.test(group.label)
    },
    {
      id: 'focus',
      label: '焦点与唤醒',
      matches: (_, group) => /对话焦点|主动唤醒/.test(group.label)
    },
    {
      id: 'limits',
      label: '防刷屏',
      matches: (_, group) => /速率硬上限|本地预筛|prompt 信号阈值/.test(group.label)
    },
    {
      id: 'profiles',
      label: '画像与复读',
      matches: (_, group) => /复读跟读|画像注入/.test(group.label)
    }
  ],
  memory: [
    {
      id: 'basics',
      label: '保存与提取',
      matches: (_, group) => /基础与容量|抽取调度/.test(group.label)
    },
    {
      id: 'recall',
      label: '召回与注入',
      matches: (_, group) => /注入控制|语义召回|群知识语义裁决/.test(group.label)
    },
    {
      id: 'consolidation',
      label: '巩固与回扣',
      matches: (_, group) => /反思巩固|时间回扣/.test(group.label)
    },
    {
      id: 'evolution',
      label: '演化与纠错',
      matches: (_, group) => /强度演化|自纠错/.test(group.label)
    },
    { id: 'midterm', label: '中期摘要', matches: (_, group) => /中期记忆/.test(group.label) }
  ]
}

// Match each field once. Newly introduced or renamed schema groups remain reachable.
export function policySections(kind: PolicyKind, groups: SchemaGroup[]): PolicySection[] {
  const sections: PolicySection[] = rules[kind].map(({ id, label }) => ({ id, label, groups: [] }))
  const extra: PolicySection = { id: 'other', label: '其他设置', groups: [] }
  for (const group of groups) {
    const buckets = new Map<PolicySection, SchemaFieldDefinition[]>()
    for (const field of group.fields) {
      const index = rules[kind].findIndex((rule) => rule.matches(field, group))
      const section = index < 0 ? extra : sections[index]!
      if (!buckets.has(section)) buckets.set(section, [])
      buckets.get(section)!.push(field)
    }
    for (const [section, fields] of buckets)
      section.groups.push({
        ...group,
        label: kind === 'dice' ? section.label : group.label,
        fields
      })
  }
  return [...sections, extra].filter((section) => section.groups.length)
}

export function policyAdvanced(kind: string, field: SchemaFieldDefinition) {
  if (kind === 'dice') return field.field === 'diceSystem.baseDir'
  if (kind === 'tracking')
    return /^smartTrigger\.(avgLatencyDefaultMs|gateContextSize|directTriggerMergeMaxMessages|activeChatTtlHours|focusMaxNoAction|fadingForceGate|continuationKeywordMaxCount|promptHintBusyGroupRate|promptHintRateLimitWarn)$/.test(
      field.field
    )
  if (kind === 'memory')
    return /^memorySystem\.(semanticDupCosine|knowledgeDecisionTimeoutMs|knowledgeDecisionInlineWaitMs|knowledgeDecisionMaxTokens)$/.test(
      field.field
    )
  return false
}

export const policyHelp: Record<PolicyKind, Record<string, string>> = {
  dice: {
    basics: '设置骰娘与自定义规则包开关，以及默认检定方式。回复文案在“骰子回复”中单独维护。',
    limits: '限制一次掷骰的数量、骰面和轮数，避免过大的计算请求。',
    storage: '设置每日 SAN 与今日人品使用的时区，并控制团录导出和人物卡存储位置。'
  },
  tracking: {
    strict: '仅在对话触发方式为严格模式时生效。触发方式在“对话配置”中设置。',
    frequency:
      '设置智能模式参与群聊的频率、按群覆盖、强制触发与时段规则；需在 AI 模型页配置追踪模型。',
    replies: '合并接连发来的消息，控制打断与回复节奏，并识别仍在等待机器人回应的续话。',
    focus: '控制一轮对话保持焦点和逐步退出的时间，以及冷群空窗后的再次判断。',
    limits: '约束主动回复频率，预先跳过无关消息，并向追踪模型提供群活跃度提示。',
    profiles: '控制近期发言画像的注入，以及机器人参与群内复读的条件。'
  },
  memory: {
    basics: '设置长期记忆开关、保存容量和提取频率。模型连接在 AI 模型页配置。',
    recall: '限制每次回复携带的记忆量，设置语义召回、去重和群知识确认的等待预算。',
    consolidation: '控制记忆整理与自然回扣；时间回扣只在回复内自然提起，不会主动发消息。',
    evolution: '设置记忆随时间衰减、被召回时强化，以及出错后的降权方式。',
    midterm: '以滚动摘要保存近期对话主线，设置触发条数、摘要长度、保留时间和模型。'
  }
}
