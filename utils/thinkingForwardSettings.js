// Runtime path and logger composition for typed per-group permission and settings.
import { fileURLToPath } from 'node:url'
import { createThinkingForwardSettings, parseThinkingForwardCommand, canManageThinkingForward, handleThinkingForwardCommand as handleCommand } from '../dist/backend/modules/config/infrastructure/thinkingForwardSettings.js'
export { createThinkingForwardSettings, parseThinkingForwardCommand, canManageThinkingForward }
export const thinkingForwardSettingsPath = fileURLToPath(new URL('../config/thinking-forward.json', import.meta.url))
export const thinkingForwardSettings = createThinkingForwardSettings(thinkingForwardSettingsPath)
export const isThinkingForwardEnabled = groupId => thinkingForwardSettings.isEnabled(groupId)
export const setThinkingForwardEnabled = (groupId, enabled) => thinkingForwardSettings.setEnabled(groupId, enabled)
export const handleThinkingForwardCommand = (event, settings = thinkingForwardSettings) => handleCommand(event, settings, { error: message => globalThis.logger?.error?.(message) })
