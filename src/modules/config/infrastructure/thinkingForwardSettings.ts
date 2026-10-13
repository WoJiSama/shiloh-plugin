import { createJsonConfigRepository } from './jsonConfigRepository.js'

export interface ThinkingSettings { isEnabled(groupId: unknown): boolean; setEnabled(groupId: unknown, enabled: boolean): boolean }
export interface ThinkingCommandEvent { msg?: unknown; group_id?: unknown; isMaster?: unknown; sender?: { role?: unknown }; reply(message: string): unknown | Promise<unknown> }
function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {} }

function groupKey(groupId: unknown) {
  const key = String(groupId ?? '').trim()
  if (!/^[1-9]\d*$/.test(key)) throw new Error('无效的群号')
  return key
}

export function createThinkingForwardSettings(filePath: string): ThinkingSettings {
 const repository = createJsonConfigRepository(filePath, value => {
  const object = record(value), groups = object.groups
  if (!value || Array.isArray(value) || !groups || typeof groups !== 'object' || Array.isArray(groups)) throw new Error('思考过程配置格式无效')
  return { ...object, groups: record(groups) }
 }, () => ({ version: 1, groups: {} }))
 return {
  isEnabled(groupId) { if (!groupId) return false; try { return repository.read().value.groups[groupKey(groupId)] === true } catch { return false } },
  setEnabled(groupId, enabled) {
   const key = groupKey(groupId)
   repository.update(value => { if (enabled) value.groups[key] = true; else delete value.groups[key] })
   return Boolean(enabled)
  }
 }
}

export function parseThinkingForwardCommand(text: unknown) {
  const match = String(text ?? '').trim().match(/^#(?:思考过程\s*(开启|关闭|状态)|(开启|关闭)思考过程)$/)
  return match ? (match[1] || match[2]) : null
}

export function canManageThinkingForward(event: Pick<ThinkingCommandEvent, 'isMaster' | 'sender'> | null | undefined) {
  return Boolean(event?.isMaster || event?.sender?.role === 'owner')
}

export async function handleThinkingForwardCommand(event: ThinkingCommandEvent, settings: ThinkingSettings, logger?: { error(message: string): void }) {
  const action = parseThinkingForwardCommand(event?.msg)
  if (!action) return false
  if (!event?.group_id) {
    await event.reply('请在群里使用思考过程命令，每个群独立设置。')
    return true
  }
  if (!canManageThinkingForward(event)) {
    await event.reply('仅机器人主人或群主可以开启、关闭或查看思考过程转发状态。')
    return true
  }
  if (action === '状态') {
    await event.reply(`本群思考过程转发：${settings.isEnabled(event.group_id) ? '已开启' : '已关闭'}。`)
    return true
  }
  try {
    settings.setEnabled(event.group_id, action === '开启')
    await event.reply(action === '开启'
      ? '已开启本群思考过程转发。模型返回思考内容时，会单独发送一条合并转发记录；不支持的模型会跳过。'
      : '已关闭本群思考过程转发。')
  } catch (error) {
    logger?.error?.(`[ThinkingForward] 保存开关失败：${String(record(error).message || error)}`)
    await event.reply('思考过程开关保存失败，请稍后重试。')
  }
  return true
}
