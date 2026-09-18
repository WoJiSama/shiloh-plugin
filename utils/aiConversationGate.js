export function isAiConversationEnabled(config) {
  const value = config?.enabled
  if (value === false || value === 0 || value == null) return false
  if (typeof value === "string" && /^(false|0|off|no)$/i.test(value.trim())) return false
  return Boolean(value)
}
