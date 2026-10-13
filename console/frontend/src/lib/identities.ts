import { shallowRef } from 'vue'
import { api } from './api'

export interface NamedIdentity {
  id: string
  name: string
}
export interface IdentityDirectory {
  bots: NamedIdentity[]
  groups: NamedIdentity[]
}
export const identities = shallowRef<IdentityDirectory>({ bots: [], groups: [] })
export async function refreshIdentities(signal?: AbortSignal) {
  const data = await api<IdentityDirectory>('/api/identities', { signal })
  identities.value = { bots: data.bots || [], groups: data.groups || [] }
  return identities.value
}
export function clearIdentities() {
  identities.value = { bots: [], groups: [] }
}
export function entityName(kind: 'bot' | 'group', id: string | number, fallback = '') {
  const name = identities.value[kind === 'bot' ? 'bots' : 'groups'].find(
    (item) => item.id === String(id)
  )?.name
  const suppliedName = fallback.trim() === String(id) ? '' : fallback.trim()
  return name || suppliedName || (kind === 'bot' ? '昵称未获取' : '群名未获取')
}
export function entityLabel(kind: 'bot' | 'group', id: string | number, fallback = '') {
  return id ? String(id) + ' · ' + entityName(kind, id, fallback) : '—'
}
export const botLabel = (id: string | number, fallback = '') => entityLabel('bot', id, fallback)
export const groupLabel = (id: string | number, fallback = '') => entityLabel('group', id, fallback)
export function containerLabel(
  container: string,
  accounts: Array<{ container: string; account: string; nickname?: string }> = []
) {
  const account = accounts.find((item) => item.container === container)
  const id = account?.account || container.match(/(?:napcat[-_])(\d+)/)?.[1]
  return id ? botLabel(id, account?.nickname) + ' · ' + container : container
}
export function fieldIdentityKind(field: string): 'group' | null {
  return field === 'allowedGroups' ||
    field === 'groupId' ||
    field.endsWith('.groupId') ||
    /-\d+-groupId$/.test(field)
    ? 'group'
    : null
}
