import { adminRecord } from '../../../contracts/groupAdmin.js'
import type { GroupId } from '../../../contracts/groupAdmin.js'

export const GROUP_ADMIN_MODULES = ['groupGuard', 'groupModeration', 'groupNotice'] as const
export type GroupAdminModule = typeof GROUP_ADMIN_MODULES[number]
type Data = Record<string, unknown>
const own = (value: Data, key: string) => Object.prototype.hasOwnProperty.call(value, key)
const list = (value: unknown): string[] => Array.isArray(value) ? [...new Set(value.map(String).map(id => id.trim()).filter(Boolean))] : []

/** Legacy moderation rows also accepted group_id/group aliases. */
export function groupAdminRowId(value: unknown) {
  const row = adminRecord(value)
  return String(row.groupId ?? row.group_id ?? row.group ?? '').trim()
}

export function groupAdminOverrides(settings: Data): Data[] {
  const raw = adminRecord(settings.groupAdmin).overrides
  return Array.isArray(raw) ? raw.map(adminRecord) : []
}

export function groupAdminOverride(settings: Data, groupId: GroupId): Data {
  return groupAdminOverrides(settings).find(item => groupAdminRowId(item) === String(groupId)) || {}
}

export function legacyGroupAdminEnabled(settings: Data, key: GroupAdminModule, groupId: GroupId) {
  const base = adminRecord(settings[key])
  return list(base.enabledGroups).includes(String(groupId)) || (key === 'groupNotice' && legacyNoticeRule(settings, groupId) !== undefined)
}

export function legacyNoticeRule(settings: Data, groupId: GroupId) {
  const rules = adminRecord(settings.groupNotice).groupRules
  return Array.isArray(rules) ? rules.map(adminRecord).find(rule => groupAdminRowId(rule) === String(groupId)) : undefined
}

/** Sparse overrides share the existing module configuration; module enabled remains the master switch. */
export function resolveGroupAdminSettings(settings: Data, groupId?: GroupId): Data {
  if (groupId === undefined) return settings
  const id = String(groupId)
  const row = groupAdminOverride(settings, id)
  const result: Data = { ...settings }
  for (const key of GROUP_ADMIN_MODULES) {
    const base = adminRecord(settings[key])
    const local = adminRecord(row[key])
    const resolved: Data = { ...base }
    if (key === 'groupNotice') {
      const legacy = legacyNoticeRule(settings, id)
      for (const field of ['welcomeMessage', 'leaveMessage'] as const) {
        if (typeof legacy?.[field] === 'string' && legacy[field].trim()) {
          resolved[field] = legacy[field]
          resolved[field === 'welcomeMessage' ? 'welcomeEnabled' : 'leaveEnabled'] = true
        }
      }
      // Legacy rules have already been applied. Do not let their templates override the new explicit values.
      resolved.groupRules = Array.isArray(base.groupRules) ? base.groupRules.filter(item => groupAdminRowId(item) !== id) : []
    }
    for (const [field, value] of Object.entries(local)) {
      if (['enabled', 'enabledGroups', 'globalAdmins', 'groupAdmins', 'groupRules', 'admins', '__proto__', 'constructor', 'prototype'].includes(field)) continue
      resolved[field] = ['thresholds', 'actions'].includes(field) ? { ...adminRecord(base[field]), ...adminRecord(value) } : value
    }
    if (key === 'groupModeration' && own(local, 'admins')) {
      const others = Array.isArray(base.groupAdmins) ? base.groupAdmins.filter(item => groupAdminRowId(item) !== id) : []
      resolved.groupAdmins = [...others, { groupId: id, admins: list(local.admins) }]
    }
    const enabled = typeof local.enabled === 'boolean' ? local.enabled : legacyGroupAdminEnabled(settings, key, id)
    const groups = list(base.enabledGroups).filter(item => item !== id)
    if (enabled) groups.push(id)
    resolved.enabledGroups = groups
    resolved.enabled = base.enabled
    result[key] = resolved
  }
  return result
}

export function configuredGroupAdminIds(settings: Data): string[] {
  const ids = new Set<string>()
  for (const key of GROUP_ADMIN_MODULES) for (const id of list(adminRecord(settings[key]).enabledGroups)) ids.add(id)
  for (const key of ['groupRules', 'groupAdmins']) {
    const rows = adminRecord(settings[key === 'groupRules' ? 'groupNotice' : 'groupModeration'])[key]
    if (Array.isArray(rows)) for (const row of rows) {
      const id = groupAdminRowId(row)
      if (id) ids.add(id)
    }
  }
  for (const row of groupAdminOverrides(settings)) if (groupAdminRowId(row)) ids.add(groupAdminRowId(row))
  return [...ids].filter(id => /^\d{4,12}$/.test(id))
}

export function groupAdminStatus(settings: Data, groupId: GroupId) {
  const resolved = resolveGroupAdminSettings(settings, groupId)
  const notice = legacyNoticeRule(settings, groupId)
  const enabled = (key: GroupAdminModule) => {
    const config = adminRecord(resolved[key])
    return config.enabled === true && list(config.enabledGroups).includes(String(groupId))
  }
  return {
    groupGuard: enabled('groupGuard'), groupModeration: enabled('groupModeration'), groupNotice: enabled('groupNotice'),
    customized: GROUP_ADMIN_MODULES.some(key => Object.keys(adminRecord(groupAdminOverride(settings, groupId)[key])).some(field => field !== 'enabled'))
      || ['welcomeMessage', 'leaveMessage'].some(field => typeof notice?.[field] === 'string' && String(notice[field]).trim().length > 0)
      || (Array.isArray(adminRecord(settings.groupModeration).groupAdmins) && (adminRecord(settings.groupModeration).groupAdmins as unknown[]).some(row => groupAdminRowId(row) === String(groupId)))
  }
}
