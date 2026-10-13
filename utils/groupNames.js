import fs from "node:fs"
import path from "node:path"

function addGroupName(names, id, name, overwrite = true) {
  const groupId = String(id ?? "").trim()
  if (!/^\d+$/.test(groupId) || typeof name !== "string" || !name.trim()) return
  if (overwrite || !names.has(groupId)) names.set(groupId, name.trim())
}

/** Existing caches live both in the plugin data directory and in Yunzai's data directory. */
export function readCachedGroupNames(pluginRoot) {
  const names = new Map()
  const root = path.resolve(pluginRoot)
  const directories = [root]
  if (path.basename(path.dirname(root)) === "plugins") directories.push(path.resolve(root, "..", ".."))
  for (const directory of directories) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(directory, "data", "group_names.json"), "utf8"))
      if (!value || Array.isArray(value) || typeof value !== "object") continue
      for (const [id, name] of Object.entries(value)) addGroupName(names, id, name)
    } catch {}
  }
  return names
}

/** Read bot membership caches only; no network calls or message sending. */
export function collectBotGroupNames(botRegistry = globalThis.Bot) {
  const names = new Map()
  const bots = Object.values(botRegistry?.bots || {})
  for (const bot of bots) {
    if (!bot?.gl || typeof bot.gl.entries !== "function") continue
    for (const [id, group] of bot.gl.entries()) {
      addGroupName(names, group?.group_id ?? id, group?.group_name || group?.name, false)
    }
  }
  if (botRegistry?.gl && typeof botRegistry.gl.entries === "function") {
    for (const [id, group] of botRegistry.gl.entries()) {
      addGroupName(names, group?.group_id ?? id, group?.group_name || group?.name, false)
    }
  }
  return [...names].map(([id, name]) => ({ id, name }))
}

export function mergeGroupNames(cached, groups = []) {
  const names = new Map(cached)
  if (Array.isArray(groups)) {
    for (const group of groups) addGroupName(names, group?.id, group?.name)
  }
  return names
}

export function collectBotIdentities(botRegistry = globalThis.Bot) {
  return Object.entries(botRegistry?.bots || {}).flatMap(([key, bot]) => {
    const id = String(bot?.uin || bot?.self_id || key).trim()
    if (!/^\d+$/.test(id)) return []
    const name = bot?.nickname || bot?.info?.nickname || ""
    return [{ id, name: typeof name === "string" && name.trim() !== id ? name.trim() : "" }]
  })
}
