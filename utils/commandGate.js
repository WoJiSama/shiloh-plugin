// 命令统一门禁:权限(perm) + 作用域(scope) + 账号绑定(哪个号服务哪个群)。
// 命令处理器首行调用:
//   const g = guardCommand(e, { name: "xx", perm: "master", scope: "group" })
//   if (!g.proceed) return g.consume
// 语义:
//   proceed=true                → 放行
//   proceed=false + wrong_bot   → 该群不归这个号管,静默放过(return false,让绑定号的同一事件处理)
//   proceed=false + 其他原因     → 权限/作用域不符,静默吞掉(return true,避免其他规则误响应)
// 配置:config/commandGate.yaml(用户层)优先,回落 config_default/commandGate.yaml,mtime 热更新。
import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"

const cache = new Map()

function resolveConfigPath(pluginRoot) {
  const userPath = path.join(pluginRoot, "config", "commandGate.yaml")
  if (fs.existsSync(userPath)) return userPath
  return path.join(pluginRoot, "config_default", "commandGate.yaml")
}

/** 读取门禁配置;文件变更时自动重载(mtime 比对),force 强制刷新 */
export function getCommandGateSettings(pluginRoot = process.cwd(), { force = false } = {}) {
  const configPath = resolveConfigPath(pluginRoot)
  let stat = null
  try {
    stat = fs.statSync(configPath)
  } catch {
    return { defaultBot: "", groups: {}, masters: [] }
  }
  const cached = cache.get(configPath)
  if (!force && cached && cached.mtimeMs === stat.mtimeMs) return cached.value

  let data = {}
  try {
    data = YAML.parse(fs.readFileSync(configPath, "utf8")) || {}
  } catch (error) {
    if (cached) return cached.value
    data = { loadError: String(error?.message || error) }
  }
  const groups = {}
  for (const [groupId, botId] of Object.entries(data?.groups || {})) {
    const group = String(groupId).trim()
    const bot = String(botId).trim()
    if (group && bot) groups[group] = bot
  }
  const value = {
    defaultBot: String(data?.defaultBot || "").trim(),
    groups,
    masters: Array.isArray(data?.masters)
      ? data.masters.map(item => String(item).trim()).filter(Boolean)
      : []
  }
  cache.set(configPath, { mtimeMs: stat.mtimeMs, value })
  return value
}

/**
 * 纯函数判定(便于测试):settings 来自 getCommandGateSettings,e 为 Yunzai 事件。
 * 账号绑定只作用于群(私聊不拦,主人私聊任意号都应可用)。
 */
export function evaluateCommandGate(settings = {}, e = {}, { perm = "all", scope = "both" } = {}) {
  const userId = String(e?.user_id || e?.sender?.user_id || "").trim()
  const groupId = String(e?.group_id || "").trim()
  const botId = String(e?.self_id || e?.bot?.uin || globalThis.Bot?.uin || "").trim()
  const isMaster = Boolean(e?.isMaster) || settings.masters?.includes(userId)

  if (scope === "group" && !groupId) return { allowed: false, reason: "wrong_scope" }
  if (scope === "private" && groupId) return { allowed: false, reason: "wrong_scope" }

  if (groupId) {
    const assignedBot = settings.groups?.[groupId] || settings.defaultBot
    if (assignedBot && botId && String(assignedBot) !== botId) {
      return { allowed: false, reason: "wrong_bot", assignedBot, botId }
    }
  }

  if (perm === "master" && !isMaster) return { allowed: false, reason: "not_master" }
  if (perm === "admin" && !isMaster) {
    const role = String(e?.sender?.role || "").toLowerCase()
    const isGroupAdmin = Boolean(groupId) && (role === "admin" || role === "owner")
    if (!isGroupAdmin) return { allowed: false, reason: "not_admin" }
  }
  return { allowed: true, reason: "ok" }
}

/** 命令处理器首行调用的守卫;返回 { proceed, consume, reason } */
export function guardCommand(e, options = {}, { pluginRoot = process.cwd(), force = false } = {}) {
  const verdict = evaluateCommandGate(getCommandGateSettings(pluginRoot, { force }), e, options)
  if (verdict.allowed) return { proceed: true, consume: false, ...verdict }
  if (verdict.reason === "wrong_bot") return { proceed: false, consume: false, ...verdict }
  return { proceed: false, consume: true, ...verdict }
}
