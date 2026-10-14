interface GroupEntry {group_id?:unknown;group_name?:string;name?:string}
interface BotEntry {uin?:unknown;self_id?:unknown;nickname?:string;info?:{nickname?:string};gl?:ReadonlyMap<unknown,GroupEntry>}
export interface BotRegistry extends BotEntry {bots?:Record<string,BotEntry>}
import fs from "node:fs"
import path from "node:path"

function addGroupName(names:Map<string,string>, id:unknown, name:unknown, overwrite = true) {
  const groupId = String(id ?? "").trim()
  if (!/^\d+$/.test(groupId) || typeof name !== "string" || !name.trim()) return
  if (overwrite || !names.has(groupId)) names.set(groupId, name.trim())
}

/** Existing caches live both in the plugin data directory and in Yunzai's data directory. */
export function readCachedGroupNames(pluginRoot:string) {
  const names = new Map<string,string>()
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
export function collectBotGroupNames(botRegistry:BotRegistry = {}) {
  const names = new Map<string,string>()
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

export function mergeGroupNames(cached:Iterable<[string,string]>, groups:{id?:unknown;name?:unknown}[] = []) {
  const names = new Map(cached)
  if (Array.isArray(groups)) {
    for (const group of groups) addGroupName(names, group?.id, group?.name)
  }
  return names
}

export function collectBotIdentities(botRegistry:BotRegistry = {}) {
  return Object.entries(botRegistry?.bots || {}).flatMap(([key, bot]) => {
    const id = String(bot?.uin || bot?.self_id || key).trim()
    if (!/^\d+$/.test(id)) return []
    const name = bot?.nickname || bot?.info?.nickname || ""
    return [{ id, name: typeof name === "string" && name.trim() !== id ? name.trim() : "" }]
  })
}
