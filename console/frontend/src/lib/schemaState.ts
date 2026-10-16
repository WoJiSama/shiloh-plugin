export interface SchemaFieldDefinition {
  field: string
  label: string
  component: string
  props?: Record<string, any>
  subFields?: SchemaFieldDefinition[]
  help?: string
  value?: any
  secret?: boolean
  configured?: boolean
  required?: boolean
  unit?: string
  applyHint?: string
}
export interface SchemaGroup {
  label: string
  fields: SchemaFieldDefinition[]
}
export interface SchemaView {
  key: string
  title: string
  groups: SchemaGroup[]
  revision?: string
}
export interface SecretDraft {
  action: 'keep' | 'replace' | 'clear'
  value: string
}
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
export const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
export function initialValues(view: SchemaView) {
  return Object.fromEntries(
    view.groups
      .flatMap((group) => group.fields)
      .map((field) => [
        field.field,
        field.secret || field.component === 'InputPassword'
          ? { action: 'keep', value: '' }
          : clone(field.value ?? defaultValue(field.component))
      ])
  )
}
export function defaultValue(component: string): any {
  if (component === 'Switch') return false
  if (component === 'InputNumber') return null
  if (component === 'GTags' || component === 'GSubForm') return []
  return ''
}
export function validateField(field: SchemaFieldDefinition, value: any): string[] {
  const errors: string[] = []
  if (field.secret || field.component === 'InputPassword') {
    if (value?.action === 'replace' && !String(value.value || '').trim())
      errors.push(`${field.label}：请输入新的凭据，或选择保持现有配置`)
    return errors
  }
  if (
    field.required &&
    (value === null ||
      value === undefined ||
      value === '' ||
      (Array.isArray(value) && !value.length))
  )
    errors.push(`${field.label}不能为空`)
  if (field.component === 'InputNumber') {
    if (value === null || !Number.isFinite(Number(value))) errors.push(`${field.label}需要填写数字`)
    else {
      if (field.props?.min !== undefined && Number(value) < field.props.min)
        errors.push(`${field.label}不能小于 ${field.props.min}`)
      if (field.props?.max !== undefined && Number(value) > field.props.max)
        errors.push(`${field.label}不能大于 ${field.props.max}`)
      const step = Number(field.props?.step)
      if (
        step > 0 &&
        Number(value) !== Number(field.props?.min) &&
        Math.abs(Number(value) / step - Math.round(Number(value) / step)) > 1e-7
      )
        errors.push(`${field.label}需按 ${step} 的步长填写`)
    }
  }
  if (
    field.component === 'Select' &&
    field.props?.options &&
    !field.props.options.some(
      (option: { value: unknown }) => String(option.value) === String(value ?? '')
    )
  )
    errors.push(`${field.label}请选择有效选项`)
  if (field.component === 'GSubForm') {
    for (const [index, row] of (Array.isArray(value) ? value : []).entries())
      for (const sub of field.subFields || []) {
        errors.push(
          ...validateField(sub, row[sub.field]).map(
            (error) => `${field.label}第 ${index + 1} 项 · ${error}`
          )
        )
      }
  }
  const known = [
    'Select',
    'Switch',
    'InputNumber',
    'Input',
    'InputTextArea',
    'InputPassword',
    'GTags',
    'GSubForm'
  ]
  if (!known.includes(field.component))
    errors.push(`${field.label}：暂不支持组件 ${field.component}`)
  return errors
}

export function validatePolicyFields(
  kind: string,
  draft: Record<string, any>,
  changedFields: SchemaFieldDefinition[]
): string[] {
  if (!['dice', 'tracking', 'memory'].includes(kind)) return []
  const changed = new Set(changedFields.map((field) => field.field))
  const errors: string[] = []
  if (changed.has('diceSystem.timeZone')) {
    const timeZone = String(draft['diceSystem.timeZone'] ?? '').trim()
    try {
      new Intl.DateTimeFormat('en', { timeZone }).format()
    } catch {
      errors.push('骰娘日期时区无效，请填写 Asia/Shanghai 或 UTC 等有效时区')
    }
  }
  if (changed.has('diceSystem.baseDir')) {
    const directory = String(draft['diceSystem.baseDir'] ?? '').trim()
    if (!directory || directory.includes('\0')) errors.push('骰娘数据目录不能为空或包含空字符')
  }
  if (changed.has('smartTrigger.groupTalkValues')) {
    const seen = new Set<string>()
    for (const row of Array.isArray(draft['smartTrigger.groupTalkValues'])
      ? draft['smartTrigger.groupTalkValues']
      : []) {
      const group = String(row?.group ?? '').trim()
      if (!/^\d{4,12}$/.test(group)) errors.push('按群话痨覆盖需填写 4 至 12 位数字群号')
      if (seen.has(group)) errors.push(`按群话痨覆盖的群号 ${group} 重复`)
      seen.add(group)
    }
  }
  if (changed.has('smartTrigger.talkValueRules')) {
    for (const row of Array.isArray(draft['smartTrigger.talkValueRules'])
      ? draft['smartTrigger.talkValueRules']
      : []) {
      if (
        !/^(?:[01]\d|2[0-3]):[0-5]\d\s*-\s*(?:[01]\d|2[0-3]):[0-5]\d$/.test(
          String(row?.range ?? '').trim()
        )
      )
        errors.push('时段频率规则需填写 HH:MM-HH:MM，可使用跨夜时段')
    }
  }
  const intervals = [
    [
      'smartTrigger.minDeferredMs',
      'smartTrigger.maxDeferredMs',
      120000,
      900000,
      '主动唤醒的最长延迟不能小于最短延迟'
    ],
    [
      'smartTrigger.repeatMinCount',
      'smartTrigger.repeatDetectionWindow',
      3,
      5,
      '复读最少人数不能大于复读检测窗口'
    ],
    [
      'memorySystem.knowledgeDecisionInlineWaitMs',
      'memorySystem.knowledgeDecisionTimeoutMs',
      180,
      900,
      '回复内确认等待不能大于群知识裁决总超时'
    ]
  ] as const
  for (const [lower, upper, defaultLower, defaultUpper, message] of intervals) {
    if (!changed.has(lower) && !changed.has(upper)) continue
    if (Number(draft[lower] ?? defaultLower) > Number(draft[upper] ?? defaultUpper))
      errors.push(message)
  }
  return errors
}
export function describeUnit(field: SchemaFieldDefinition) {
  if (field.unit) return field.unit
  const label = field.label
  if (/毫秒|\(ms\)/i.test(label)) return '毫秒'
  if (/分钟/.test(label)) return '分钟'
  if (/小时/.test(label)) return '小时'
  if (/秒/.test(label)) return '秒'
  if (/\bMB\b/.test(label)) return 'MB'
  return ''
}
export function describeApply(field: SchemaFieldDefinition, kind: string) {
  if (field.applyHint) return field.applyHint
  if (/重启/.test(field.help || '')) return '保存后重启服务生效'
  if (kind === 'riskControl') return '保存后约 10 秒内生效'
  if (field.field.startsWith('mediaRelayAdminReport.')) return '下一报告周期生效'
  return '保存后热生效'
}
