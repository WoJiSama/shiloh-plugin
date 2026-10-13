import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const thinkingForwardSettingsPath = fileURLToPath(new URL('../config/thinking-forward.json', import.meta.url))

function groupKey(groupId) {
  const key = String(groupId ?? '').trim()
  if (!/^[1-9]\d*$/.test(key)) throw new Error('无效的群号')
  return key
}

export function createThinkingForwardSettings(filePath = thinkingForwardSettingsPath) {
  function read() {
    try {
      const value = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value) || !value.groups || typeof value.groups !== 'object' || Array.isArray(value.groups)) throw new Error('思考过程配置格式无效')
      return value
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, groups: {} }
      throw error
    }
  }
  return {
    isEnabled(groupId) {
      if (!groupId) return false
      try { return read().groups[groupKey(groupId)] === true } catch { return false }
    },
    setEnabled(groupId, enabled) {
      const key = groupKey(groupId)
      const value = read()
      if (enabled) value.groups[key] = true
      else delete value.groups[key]
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
      try {
        fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
        fs.renameSync(temporary, filePath)
      } finally {
        try { fs.unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
      }
      return Boolean(enabled)
    }
  }
}

export const thinkingForwardSettings = createThinkingForwardSettings()
export const isThinkingForwardEnabled = groupId => thinkingForwardSettings.isEnabled(groupId)
export const setThinkingForwardEnabled = (groupId, enabled) => thinkingForwardSettings.setEnabled(groupId, enabled)

export function parseThinkingForwardCommand(text) {
  const match = String(text ?? '').trim().match(/^#(?:思考过程\s*(开启|关闭|状态)|(开启|关闭)思考过程)$/)
  return match ? (match[1] || match[2]) : null
}

export function canManageThinkingForward(event) {
  return Boolean(event?.isMaster || event?.sender?.role === 'owner')
}

export async function handleThinkingForwardCommand(event, settings = thinkingForwardSettings) {
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
    globalThis.logger?.error?.(`[ThinkingForward] 保存开关失败：${error.message}`)
    await event.reply('思考过程开关保存失败，请稍后重试。')
  }
  return true
}
