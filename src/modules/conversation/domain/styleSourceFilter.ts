/**
 * 风格学习源的机器人判定（P0 反污染）：
 * 学其他机器人的输出只会越来越像机器——观察器、群表达学习、按人口头禅挖掘都要跳过机器人消息。
 * 名单 = 配置的外部 bot 清单（pluginSettings.botUserIds）∪ 自家全部账号（多号实例，从 Bot 注册表取）。
 */
export function collectBotStyleIds(configured: readonly unknown[], botRegistry: unknown): string[] {
  const ids = new Set<string>()
  const addId = (value: unknown) => {
    const id = String(value ?? "").trim()
    if (/^\d+$/.test(id)) ids.add(id)
  }
  for (const value of Array.isArray(configured) ? configured : []) addId(value)
  const registry = botRegistry && typeof botRegistry === "object" ? botRegistry as { uin?: unknown; bots?: Record<string, unknown> } : null
  if (registry) {
    addId(registry.uin)
    for (const key of Object.keys(registry.bots || {})) addId(key)
  }
  return [...ids]
}

export function isBotStyleSource(userId: unknown, botIds: readonly string[]): boolean {
  return botIds.includes(String(userId ?? "").trim())
}
