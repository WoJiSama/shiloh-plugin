import {
  clone,
  defaultValue,
  equal,
  type SchemaFieldDefinition,
  type SchemaGroup,
  type SchemaView
} from './schemaState'

export const groupAdminModules = [
  { id: 'groupGuard', label: '入群验证', description: '答题验证、超时与错误处理' },
  { id: 'groupModeration', label: '广告与刷屏', description: '内容检测、处置与通知名单' },
  { id: 'groupNotice', label: '欢迎与退群', description: '入群欢迎、退群提示与文案' }
] as const
export type GroupAdminModule = (typeof groupAdminModules)[number]['id']
export interface GroupAdminField extends SchemaFieldDefinition {
  inheritance: 'default' | 'legacy' | 'custom'
  defaultValue: any
  inheritedValue: any
}
export interface GroupAdminView extends SchemaView {
  groupId: string
  masters: Record<GroupAdminModule, boolean>
  groups: Array<Omit<SchemaGroup, 'fields'> & { fields: GroupAdminField[] }>
}
export interface GroupAdminEntry {
  custom: boolean
  value: any
}
export type GroupAdminDraft = Record<string, GroupAdminEntry>
export function isGroupEnabled(field: string) {
  return /^group(?:Guard|Moderation|Notice)\.enabled$/.test(field)
}
export function validGroupId(value: string) {
  return /^\d{4,12}$/.test(value)
}
export function groupAdminFields(view: GroupAdminView) {
  return view.groups.flatMap((group) => group.fields)
}
export function groupAdminInitial(view: GroupAdminView): GroupAdminDraft {
  return Object.fromEntries(
    groupAdminFields(view).map((field) => [
      field.field,
      {
        custom: isGroupEnabled(field.field) || field.inheritance !== 'default',
        value: clone(field.value ?? defaultValue(field.component))
      }
    ])
  )
}
export function sameGroupAdminEntry(a?: GroupAdminEntry, b?: GroupAdminEntry) {
  return a?.custom === b?.custom && (!a?.custom || equal(a.value, b?.value))
}
export function groupAdminChanges(
  fields: GroupAdminField[],
  draft: GroupAdminDraft,
  baseline: GroupAdminDraft
) {
  return fields.filter((field) => !sameGroupAdminEntry(draft[field.field], baseline[field.field]))
}
export function groupAdminPayload(
  fields: GroupAdminField[],
  draft: GroupAdminDraft,
  baseline: GroupAdminDraft,
  revision?: string
) {
  const values: Record<string, any> = {}
  const resets: string[] = []
  for (const field of groupAdminChanges(fields, draft, baseline)) {
    const entry = draft[field.field]
    if (entry.custom) values[field.field] = clone(entry.value)
    else resets.push(field.field)
  }
  return { revision, values, resets }
}
export function resetGroupAdminField(field: GroupAdminField): GroupAdminEntry {
  return { custom: false, value: clone(field.defaultValue ?? defaultValue(field.component)) }
}
/** Rebase only changes made after comparison; reset previews follow the latest defaults. */
export function rebaseGroupAdminDraft(
  view: GroupAdminView,
  local: GroupAdminDraft,
  comparison: GroupAdminDraft
) {
  const next = groupAdminInitial(view)
  for (const field of groupAdminFields(view)) {
    const entry = local[field.field]
    if (entry && !sameGroupAdminEntry(entry, comparison[field.field]))
      next[field.field] = entry.custom ? clone(entry) : resetGroupAdminField(field)
  }
  return next
}
