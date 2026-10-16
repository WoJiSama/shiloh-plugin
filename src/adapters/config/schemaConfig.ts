import crypto from "node:crypto"

import type { ConfigSchemaItem } from '../../contracts/configSchema.js'
export type SchemaItem = ConfigSchemaItem
export interface SchemaField { field: string; label: string; component: string; props: NonNullable<SchemaItem['componentProps']>; required: boolean; subFields: SchemaField[]; help?: string }
export interface SchemaEntry { title: string; schema: SchemaItem[] }

const revisionSalt = crypto.randomBytes(32)
const has = (obj: object, key: PropertyKey) => Object.prototype.hasOwnProperty.call(obj, key)
const plainObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
const error = (message: string, status = 400) => Object.assign(new Error(message), { status })

export function getIn(obj: unknown, dottedPath = "") {
  let cursor = obj
  for (const key of String(dottedPath).split(".")) {
    if (!plainObject(cursor) || !has(cursor, key)) return undefined
    cursor = cursor[key]
  }
  return cursor
}

export function schemaFieldGroups(schema: SchemaItem[] = []) {
  const groups: { label: string; fields: SchemaField[] }[] = []
  let current: { label: string; fields: SchemaField[] } = { label: "通用", fields: [] }
  for (const item of schema) {
    if (!item || typeof item !== "object") continue
    if (["SOFT_GROUP_BEGIN", "Divider"].includes(item.component || "")) {
      if (current.fields.length) groups.push(current)
      current = { label: String(item.label || "通用"), fields: [] }
      continue
    }
    if (item.component === "SOFT_GROUP_END" || !item.field) continue
    const props = item.componentProps || {}
    current.fields.push({
      field: item.field,
      label: item.label || item.field,
      component: item.component || "Input",
      props,
      required: Boolean(item.required),
      subFields: (props.schemas || []).filter((sub): sub is SchemaItem & { field: string } => Boolean(sub.field)).map(sub => ({
        field: sub.field, label: sub.label || sub.field, component: sub.component || "Input",
        props: sub.componentProps || {}, required: Boolean(sub.required), subFields: []
      })),
      help: item.bottomHelpMessage || ""
    })
  }
  if (current.fields.length) groups.push(current)
  return groups
}

export function normalizeSchemaValue(component = "", value: unknown): unknown {
  if (component === "Switch") return value === true || value === "true"
  if (component === "InputNumber") {
    if (value === undefined || value === null || String(value).trim() === "") return null
    const number = Number(value)
    return Number.isFinite(number) ? number : null
  }
  if (component === "GTags") {
    return (Array.isArray(value) ? value : String(value || "").split(/[,\n，]/))
      .map(item => String(item ?? "").trim()).filter(Boolean)
  }
  if (component === "GSubForm") return Array.isArray(value) ? value : []
  return value === undefined || value === null ? "" : String(value)
}

function normalizeFieldValue(field: SchemaField, value: unknown): unknown {
  // Hand-written YAML also accepts a group-to-frequency map. Present every entry in
  // the table, and include it in revisions, without rewriting it on unrelated saves.
  if (field.field === "smartTrigger.groupTalkValues" && plainObject(value)) {
    return Object.entries(value).map(([group, frequency]) => ({ group, value: frequency }))
  }
  return normalizeSchemaValue(field.component, value)
}

export function validateSchemaValue(field: SchemaField, value: unknown, label = field.label): unknown {
  if (field.component === "InputNumber") {
    if (value === null || value === undefined || !["number", "string"].includes(typeof value) || String(value).trim() === "") {
      throw error(`${label}不能为空，需填写有效数字`)
    }
    const number = Number(value)
    if (!Number.isFinite(number)) throw error(`${label}需填写有效数字`)
    const { min, max, step } = field.props || {}
    if (min !== undefined && number < Number(min)) throw error(`${label}不能小于 ${min}`)
    if (max !== undefined && number > Number(max)) throw error(`${label}不能大于 ${max}`)
    // Existing Guoba schemas use step as a numeric increment (some have min=1, step=5, default=30).
    if (Number(step) > 0 && number !== Number(min)) {
      const ratio = number / Number(step)
      if (Math.abs(ratio - Math.round(ratio)) > 1e-7) throw error(`${label}需按 ${step} 的步长填写`)
    }
    return number
  }
  if (field.component === "Switch") {
    if (![true, false, "true", "false"].some(item => item === value)) throw error(`${label}需为开关值`)
    return value === true || value === "true"
  }
  if (field.component === "GSubForm") {
    if (!Array.isArray(value)) throw error(`${label}需为列表`)
    return value.map((row, index) => {
      if (!plainObject(row)) throw error(`${label}第 ${index + 1} 行格式无效`)
      const result: Record<string, unknown> = {}
      const allowed = new Set(field.subFields.map(sub => sub.field))
      for (const key of Object.keys(row)) if (!allowed.has(key)) throw error(`${label}第 ${index + 1} 行包含未知字段 ${key}`)
      for (const sub of field.subFields) {
        const subLabel = `${label}第 ${index + 1} 行 · ${sub.label}`
        if (!has(row, sub.field)) {
          if (sub.required) throw error(`${subLabel}不能为空`)
          continue
        }
        result[sub.field] = validateSchemaValue(sub, row[sub.field], subLabel)
      }
      return result
    })
  }
  if (field.component === "GTags") {
    if (!Array.isArray(value) && typeof value !== "string") throw error(`${label}需为标签列表`)
    if (Array.isArray(value) && value.some(item => !["string", "number"].includes(typeof item))) throw error(`${label}包含无效标签`)
    return normalizeSchemaValue(field.component, value)
  }
  if (!["string", "number"].includes(typeof value) && value !== null) throw error(`${label}需为文本`)
  const text = String(normalizeSchemaValue(field.component, value))
  if (field.component === "Select" && field.props?.options && !field.props.options.some(option => String(option.value) === text)) throw error(`${label}请选择有效选项`)
  if (field.required && !text.trim()) throw error(`${label}不能为空`)
  return text
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (plainObject(value)) return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]))
  return value
}

export function schemaRevision(key: string, schema: SchemaItem[], settings: unknown) {
  const fields = schemaFieldGroups(schema).flatMap(group => group.fields)
  const values = fields.map(field => [field.field, normalizeFieldValue(field, getIn(settings, field.field))])
  return crypto.createHmac("sha256", revisionSalt).update(JSON.stringify(stable({ key, schema, values }))).digest("hex")
}

export function fieldApplyInfo(field: string) {
  if (field === "diceSystem.baseDir") return { applyMode: "hot", applyHint: "已保存；下次读写使用新目录，已有的人物卡、昵称与团录不会自动迁移。切换前请自行迁移需要保留的数据" }
  if (field === "diceSystem.timeZone") return { applyMode: "hot", applyHint: "已保存；下次 SAN 与今日人品日期计算使用新时区，已有记录保持" }
  if (field.startsWith("diceSystem.")) return { applyMode: "hot", applyHint: "已保存；后续骰子命令使用新配置" }
  if (field === "smartTrigger.avgLatencyDefaultMs") return { applyMode: "hot", applyHint: "已保存；后续判断在没有回复延迟样本时使用新初始值，已有样本保持" }
  if (field === "smartTrigger.activeChatTtlHours") return { applyMode: "next-cycle", applyHint: "已保存；下次会话维护扫描按新时限清理活跃状态" }
  if (/^(conversationTracking|batchJudgmentDelay$|smartTrigger\.|personProfileInjection\.)/.test(field)) return { applyMode: "hot", applyHint: "已保存；配置热更新后，后续消息判断与新调度使用新配置，已经排定的追踪、合并与唤醒计时器沿用原计划" }
  if (field.startsWith("memorySystem.max")) return { applyMode: "hot", applyHint: "已保存；下次相关记忆写入或反思时按新容量整理，不立即批量删除既有记忆" }
  if (/^memorySystem\.(prompt|recall|semanticRecall)/.test(field)) return { applyMode: "hot", applyHint: "已保存；后续记忆召回与注入使用新配置，已有提示缓存约一分钟内更新" }
  if (field.startsWith("memorySystem.")) return { applyMode: "hot", applyHint: "已保存；配置热更新后，后续提取、裁决和反思使用新配置，已开始的任务继续完成" }
  if (field.startsWith("semanticMemory.memoryEvolution.")) return { applyMode: "next-cycle", applyHint: "已保存；配置热更新后，后续召回使用新强度参数；淡忘在下一清扫周期处理（首次约一分钟，之后每日）" }
  if (field.startsWith("semanticMemory.selfCorrection.")) return { applyMode: "hot", applyHint: "已保存；配置热更新后，后续纠错使用新参数" }
  if (field.startsWith("midtermMemory.")) return { applyMode: "next-cycle", applyHint: "已保存；配置热更新后重建摘要实例，进程内待摘要缓冲会重置，已有摘要保留；新保留期限在下次读取或清扫（约十二小时）时应用" }
  if (/^(groupGuard|groupModeration|groupNotice)\./.test(field)) return { applyMode: "hot", applyHint: "已保存；后续群事件读取新配置。现有验证题目和到期时间保持，关闭后不再执行超时处理" }
  if (["groupMaxMessages", "groupChatMemoryMinutes"].includes(field)) return { applyMode: "restart", applyHint: "已保存；聊天模块会热更新，消息管道的历史写入参数需重启机器人服务后完全生效。已有历史按后续消息逐步更新" }
  if (field === "concurrentLimit") return { applyMode: "hot", applyHint: "已保存；配置热更新后，新回合使用新的每群并发额度，已在处理的请求继续完成" }
  if (["enabled", "chatTriggerMode", "groupHistory", "triggerPrefixes", "excludeMessageTypes", "enableGroupWhitelist", "allowedGroups", "useTools", "maxToolRounds"].includes(field) || ["privateChat.", "userBlacklist.", "forbiddenWords.", "agentIntelligence.", "taskAiConfig.", "replyRhythm.", "understandingEnhancement."].some(prefix => field.startsWith(prefix))) return { applyMode: "hot", applyHint: "已保存；配置热更新后，后续相关请求使用新配置，已开始的回合继续完成" }
  if (["chatAiConfig.chatReasoningEffort", "chatAiConfig.complexReasoningEffort", "toolsAiConfig.toolsReasoningEffort", "taskAiConfig.casual.reasoningEffort"].includes(field)) return { applyMode: "hot", applyHint: "已保存；配置热更新后，后续请求使用新档位" }
  if (field.startsWith("mediaRelayAdminReport.")) return { applyMode: "next-cycle", applyHint: "已保存；管理群报告在下一调度周期读取配置" }
  if (field.startsWith("messagePipeline.") || field.startsWith("youtubeRelay.") || field === "bilibiliQualityRelay.autoUseAuthorizedForMemberOnly") return { applyMode: "restart", applyHint: "已保存；消息管道初始化参数需重启机器人服务后生效" }
  if (field.startsWith("riskControl.")) return { applyMode: "hot", applyHint: "已保存；出站风控约 10 秒内读取更新" }
  if (field.startsWith("persona.") || field.startsWith("personaGuard.") || ["userProfiles", "groupProfiles", "bilibiliQualityRelay.enabled"].includes(field)) return { applyMode: "hot", applyHint: "已保存；后续相关请求读取新配置" }
  return { applyMode: "persisted", applyHint: "配置已持久化；此项生效时机取决于相关模块的读取周期" }
}

export function buildSchemaConfigView(key: string, entry: SchemaEntry, settings: unknown) {
  const groups = schemaFieldGroups(entry.schema).map(group => ({
    ...group,
    fields: group.fields.map(field => {
      const raw = getIn(settings, field.field)
      const secret = field.component === "InputPassword" || field.props.type === "password"
      return {
        ...field, ...fieldApplyInfo(field.field),
        value: secret ? "" : normalizeFieldValue(field, raw),
        ...(secret ? { secret: true, configured: Boolean(raw) } : {})
      }
    })
  }))
  return { key, title: entry.title, groups, revision: schemaRevision(key, entry.schema, settings) }
}

export function prepareSchemaUpdates(key: string, entry: SchemaEntry, settings: unknown, payload: Record<string, unknown> = {}) {
  if (["dice", "tracking", "memory"].includes(key) && (typeof payload.revision !== "string" || !payload.revision)) throw error("请重新加载配置，携带当前版本后保存")
  const revision = schemaRevision(key, entry.schema, settings)
  if (payload.revision !== undefined && payload.revision !== revision) throw error("配置已被其他页面修改，请重新加载并核对草稿后保存", 409)
  const values = payload.values ?? {}
  const secrets = payload.secrets ?? {}
  if (!plainObject(values) || !plainObject(secrets)) throw error("values 和 secrets 需为对象")
  const fields = schemaFieldGroups(entry.schema).flatMap(group => group.fields)
  const byName = new Map(fields.map(field => [field.field, field]))
  for (const name of [...Object.keys(values), ...Object.keys(secrets)]) if (!byName.has(name)) throw error(`未知配置字段: ${name}`)
  const updates: Record<string, unknown> = {}
  const apply = []
  for (const field of fields) {
    const name = field.field
    const secret = field.component === "InputPassword" || field.props.type === "password"
    if (!has(values, name) && !has(secrets, name)) continue
    let next
    if (secret) {
      if (!has(secrets, name)) {
        // Old clients may return an empty/redacted field. It is never a replacement credential.
        const legacy = values[name]
        if (legacy === "" || legacy === undefined || /^(?:\*{3,}|.*….*)$/.test(String(legacy))) continue
        throw error(`${field.label}请使用明确的替换或清除操作`)
      }
      const intent = secrets[name]
      if (!plainObject(intent) || !["replace", "clear", "keep"].some(action => action === intent.action)) throw error(`${field.label}凭据操作无效`)
      if (intent.action === "keep") continue
      if (intent.action === "clear") next = ""
      else {
        if (typeof intent.value !== "string" || !intent.value.trim()) throw error(`${field.label}替换值不能为空`)
        if (/^(?:\*{3,}|.*….*)$/.test(intent.value)) throw error(`${field.label}不能用脱敏占位符替换凭据`)
        next = intent.value
      }
    } else {
      if (has(secrets, name)) throw error(`${field.label}不是凭据字段`)
      next = validateSchemaValue(field, values[name])
    }
    const current = normalizeFieldValue(field, getIn(settings, name))
    if (JSON.stringify(stable(current)) === JSON.stringify(stable(next))) continue
    updates[name] = next
    apply.push({ field: name, ...fieldApplyInfo(name) })
  }
  // The lower/upper bounds are individually valid but must also form a valid interval.
  if (has(updates, "riskControl.delayMinMs") || has(updates, "riskControl.delayMaxMs")) {
    const min = updates["riskControl.delayMinMs"] ?? getIn(settings, "riskControl.delayMinMs") ?? 0
    const max = updates["riskControl.delayMaxMs"] ?? getIn(settings, "riskControl.delayMaxMs") ?? 400
    if (Number(max) < Number(min)) throw error("随机延迟上限不能小于下限")
  }
  validatePolicyUpdates(updates, settings)
  return { updates, changed: Object.keys(updates).length, revision, apply }
}

function validatePolicyUpdates(updates: Record<string, unknown>, settings: unknown) {
  if (has(updates, "diceSystem.timeZone")) {
    const timeZone = String(updates["diceSystem.timeZone"]).trim()
    try { new Intl.DateTimeFormat("en", { timeZone }).format() }
    catch { throw error("骰娘日期时区无效，请填写 Asia/Shanghai 或 UTC 等有效时区") }
    updates["diceSystem.timeZone"] = timeZone
  }
  if (has(updates, "diceSystem.baseDir")) {
    const baseDir = String(updates["diceSystem.baseDir"]).trim()
    if (!baseDir || baseDir.includes("\0")) throw error("骰娘数据目录不能为空或包含空字符")
    updates["diceSystem.baseDir"] = baseDir
  }
  const groupValues = updates["smartTrigger.groupTalkValues"]
  if (Array.isArray(groupValues)) {
    const seen = new Set<string>()
    for (const row of groupValues as Record<string, unknown>[]) {
      const group = String(row.group).trim()
      if (!/^\d{4,12}$/.test(group)) throw error("按群话痨覆盖需填写 4 至 12 位数字群号")
      if (seen.has(group)) throw error(`按群话痨覆盖的群号 ${group} 重复`)
      seen.add(group)
      row.group = group
    }
  }
  const timingRules = updates["smartTrigger.talkValueRules"]
  if (Array.isArray(timingRules)) {
    for (const row of timingRules as Record<string, unknown>[]) {
      const range = String(row.range).trim()
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d\s*-\s*(?:[01]\d|2[0-3]):[0-5]\d$/.test(range)) throw error("时段频率规则需填写 HH:MM-HH:MM，可使用跨夜时段")
      row.range = range.replace(/\s/g, "")
    }
  }
  const intervals = [
    ["smartTrigger.minDeferredMs", "smartTrigger.maxDeferredMs", 120000, 900000, "主动唤醒的最长延迟不能小于最短延迟"],
    ["smartTrigger.repeatMinCount", "smartTrigger.repeatDetectionWindow", 3, 5, "复读最少人数不能大于复读检测窗口"],
    ["memorySystem.knowledgeDecisionInlineWaitMs", "memorySystem.knowledgeDecisionTimeoutMs", 180, 900, "回复内确认等待不能大于群知识裁决总超时"]
  ] as const
  for (const [lower, upper, defaultLower, defaultUpper, message] of intervals) {
    if (!has(updates, lower) && !has(updates, upper)) continue
    if (Number(updates[lower] ?? getIn(settings, lower) ?? defaultLower) > Number(updates[upper] ?? getIn(settings, upper) ?? defaultUpper)) throw error(message)
  }
}
