import crypto from 'node:crypto'
import { adminRecord } from '../../contracts/groupAdmin.js'
import { GROUP_ADMIN_MODULES, groupAdminRowId, groupAdminOverride, groupAdminOverrides, legacyGroupAdminEnabled, legacyNoticeRule, resolveGroupAdminSettings } from '../../modules/groupAdmin/domain/groupAdminPolicy.js'
import { normalizeGroupGuardConfig } from '../../modules/groupAdmin/infrastructure/GroupGuardManager.js'
import { normalizeGroupNoticeConfig } from '../../modules/groupAdmin/infrastructure/GroupNoticeManager.js'
import { normalizeGroupModerationConfig } from '../../modules/groupAdmin/domain/groupModerationRules.js'
import { groupAdminDefaultSchema, groupAdminGroupSchema } from '../../modules/config/domain/schemas/shared/groupAdmin.js'
import { buildSchemaConfigView, getIn, prepareSchemaUpdates, schemaFieldGroups, validateSchemaValue } from './schemaConfig.js'

type Data = Record<string, unknown>
const fail = (message: string, status = 400) => Object.assign(new Error(message), { status })
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const defaultsEntry = { title: '群管理默认策略', schema: groupAdminDefaultSchema }
const groupEntry = { title: '本群管理', schema: groupAdminGroupSchema }
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)])) : value

export function validateGroupAdminId(value: unknown) {
  const id = String(value ?? '').trim()
  if (!/^\d{4,12}$/.test(id)) throw fail('群号需为 4 至 12 位数字')
  return id
}

function normalizeSettings(settings: Data, groupId?: string): Data {
  const resolved = resolveGroupAdminSettings(settings, groupId)
  const moderation = normalizeGroupModerationConfig(resolved.groupModeration)
  return {
    groupGuard: normalizeGroupGuardConfig(resolved.groupGuard),
    groupModeration: { ...moderation, admins: groupId ? moderation.groupAdmins.find(row => row.groupId === groupId)?.admins || [] : [] },
    groupNotice: normalizeGroupNoticeConfig(resolved.groupNotice)
  }
}

export function buildGroupAdminDefaultsView(settings: Data) {
  return buildSchemaConfigView('groupAdmin', defaultsEntry, normalizeSettings(settings))
}

function validatePolicyField(field: string, value: unknown) {
  if (field === 'groupGuard.questionOperators' && (value as string[]).some(item => !['add', 'sub'].includes(item))) throw fail('题型仅支持 add / sub')
  if (['groupModeration.admins', 'groupModeration.globalAdmins', 'groupModeration.ignoredBotIds'].includes(field) && (value as string[]).some(item => !/^\d{4,12}$/.test(item))) throw fail('QQ 号需为 4 至 12 位数字')
  if (typeof value === 'number' && !/\.(thresholds\.|modelThreshold$|adTemplateSimilarityThreshold$|adTemplateWeight$|floodConfidence$)/.test(field) && !Number.isInteger(value)) throw fail('条数、次数、等级和时长需填写整数')
}

export function prepareGroupAdminDefaultUpdates(settings: Data, payload: Data) {
  if (typeof payload.revision !== 'string') throw fail('缺少配置版本，请刷新后重试', 409)
  const prepared = prepareSchemaUpdates('groupAdmin', defaultsEntry, normalizeSettings(settings), payload)
  for (const [field, value] of Object.entries(prepared.updates)) validatePolicyField(field, value)
  return prepared
}

function groupRevision(id: string, settings: Data) {
  const moderation = adminRecord(settings.groupModeration)
  const legacyAdmins = Array.isArray(moderation.groupAdmins) ? moderation.groupAdmins.filter(row => groupAdminRowId(row) === id) : []
  return crypto.createHash('sha256').update(JSON.stringify(stable({
    id, defaults: buildGroupAdminDefaultsView(settings).revision,
    override: groupAdminOverride(settings, id),
    enabled: GROUP_ADMIN_MODULES.map(key => [key, legacyGroupAdminEnabled(settings, key, id)]),
    notice: legacyNoticeRule(settings, id) || null, admins: legacyAdmins
  }))).digest('hex')
}

export function buildGroupAdminView(groupId: string, settings: Data) {
  const id = validateGroupAdminId(groupId)
  const row = groupAdminOverride(settings, id)
  const globals = normalizeSettings(settings)
  const legacySettings = { ...settings, groupAdmin: { ...adminRecord(settings.groupAdmin), overrides: groupAdminOverrides(settings).filter(item => groupAdminRowId(item) !== id) } }
  const legacy = normalizeSettings(legacySettings, id)
  const resolved = normalizeSettings(settings, id)
  const view = buildSchemaConfigView(`groupAdmin:${id}`, groupEntry, resolved)
  const legacyRule = legacyNoticeRule(settings, id)
  const selection = (source: Data, field: string) => {
    if (field.endsWith('.enabled')) return (adminRecord(source[field.split('.')[0]!]).enabledGroups as string[]).includes(id)
    return getIn(source, field)
  }
  view.groups = view.groups.map(group => ({ ...group, fields: group.fields.map(field => {
    const isEnabled = field.field.endsWith('.enabled')
    const fallback = isEnabled ? false : getIn(globals, field.field)
    const inherited = selection(legacy, field.field)
    const value = selection(resolved, field.field)
    const legacyTemplate = field.field.startsWith('groupNotice.') && ['welcomeMessage', 'welcomeEnabled', 'leaveMessage', 'leaveEnabled'].includes(field.field.split('.')[1]!)
      && typeof legacyRule?.[field.field.includes('.welcome') ? 'welcomeMessage' : 'leaveMessage'] === 'string'
      && String(legacyRule?.[field.field.includes('.welcome') ? 'welcomeMessage' : 'leaveMessage']).trim().length > 0
    const legacyAdmins = field.field === 'groupModeration.admins' && Array.isArray(adminRecord(settings.groupModeration).groupAdmins)
      && (adminRecord(settings.groupModeration).groupAdmins as unknown[]).some(item => groupAdminRowId(item) === id)
    return { ...field, value, defaultValue: fallback, inheritedValue: inherited,
      inheritance: getIn(row, field.field) !== undefined ? 'custom' : ((isEnabled && inherited) || legacyTemplate || legacyAdmins) ? 'legacy' : 'default' }
  }) }))
  return { ...view, groupId: id, revision: groupRevision(id, settings),
    masters: Object.fromEntries(GROUP_ADMIN_MODULES.map(key => [key, adminRecord(globals[key]).enabled === true])) }
}

function setPath(target: Data, field: string, value: unknown) {
  const parts = field.split('.')
  let cursor = target
  for (const part of parts.slice(0, -1)) {
    const next = clone(adminRecord(cursor[part]))
    cursor[part] = next
    cursor = next
  }
  cursor[parts.at(-1)!] = value
}

function removePath(target: Data, field: string) {
  const [key, ...parts] = field.split('.')
  if (!key) return
  if (!parts.length) { delete target[key]; return }
  const child = adminRecord(target[key])
  removePath(child, parts.join('.'))
  if (!Object.keys(child).length) delete target[key]
}

export function prepareGroupAdminUpdates(groupId: string, settings: Data, payload: Data) {
  const id = validateGroupAdminId(groupId)
  if (typeof payload.revision !== 'string' || payload.revision !== groupRevision(id, settings)) throw fail('配置已变化，请刷新并核对本群草稿后保存', 409)
  for (const key of Object.keys(payload)) if (!['values', 'resets', 'revision'].includes(key)) throw fail(`未知请求字段: ${key}`)
  const values = payload.values ?? {}
  const resets = payload.resets ?? []
  if (values === null || typeof values !== 'object' || Array.isArray(values) || !Array.isArray(resets) || resets.some(field => typeof field !== 'string')) throw fail('values 需为对象，resets 需为字段列表')
  const fields = new Map(schemaFieldGroups(groupEntry.schema).flatMap(group => group.fields).map(field => [field.field, field]))
  const row = clone(groupAdminOverride(settings, id))
  const before = JSON.stringify(stable(row))
  const updates: Data = {}
  const validated: Data = {}
  const removeLegacyMessage = (field: string) => {
    const rules = updates['groupNotice.groupRules'] ?? adminRecord(settings.groupNotice).groupRules
    if (Array.isArray(rules)) updates['groupNotice.groupRules'] = rules.map(rule => {
      if (groupAdminRowId(rule) !== id) return rule
      const next = { ...adminRecord(rule) }; delete next[field]; return next
    })
  }
  for (const [name, value] of Object.entries(values)) {
    const field = fields.get(name)
    if (!field) throw fail(`未知本群配置字段: ${name}`)
    if (resets.includes(name)) throw fail(`同一字段不能同时设置和恢复默认: ${name}`)
    validated[name] = validateSchemaValue(field, value)
    validatePolicyField(name, validated[name])
  }
  for (const name of resets as string[]) {
    if (!fields.has(name)) throw fail(`未知本群配置字段: ${name}`)
    if (name.endsWith('.enabled')) throw fail('恢复默认保留本群启用状态，请单独调整启用开关')
    removePath(row, name)
    if (['groupNotice.welcomeEnabled', 'groupNotice.leaveEnabled'].includes(name)) {
      const message = name.includes('.welcome') ? 'welcomeMessage' : 'leaveMessage'
      const template = legacyNoticeRule(settings, id)?.[message]
      if (typeof template === 'string' && template.trim()) {
        // Old nonempty templates implicitly forced the flag on. Preserve the text as a sparse
        // override while removing that implicit flag, so it can really inherit future defaults.
        if (!resets.includes(`groupNotice.${message}`) && getIn(row, `groupNotice.${message}`) === undefined) setPath(row, `groupNotice.${message}`, template)
        removeLegacyMessage(message)
      }
    }
    if (['groupNotice.welcomeMessage', 'groupNotice.leaveMessage'].includes(name)) {
      removeLegacyMessage(name.split('.')[1]!)
    }
    if (name === 'groupModeration.admins') {
      const admins = adminRecord(settings.groupModeration).groupAdmins
      if (Array.isArray(admins)) updates['groupModeration.groupAdmins'] = admins.filter(rule => groupAdminRowId(rule) !== id)
    }
  }
  for (const [name, value] of Object.entries(validated)) setPath(row, name, value)
  const after = JSON.stringify(stable(row))
  if (before !== after) {
    row.groupId = id
    const rows = groupAdminOverrides(settings)
    const index = rows.findIndex(item => groupAdminRowId(item) === id)
    const meaningful = Object.keys(row).some(key => !['groupId', 'group_id', 'group'].includes(key))
    if (index < 0 && meaningful) rows.push(row)
    else if (index >= 0) { if (meaningful) rows[index] = row; else rows.splice(index, 1) }
    updates['groupAdmin.overrides'] = rows
  }
  for (const [field, value] of Object.entries(updates)) if (JSON.stringify(stable(getIn(settings, field))) === JSON.stringify(stable(value))) delete updates[field]
  return { updates, changed: Object.keys(updates).length ? Object.keys(validated).length + new Set(resets as string[]).size : 0 }
}
