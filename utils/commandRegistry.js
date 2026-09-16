import fs from "fs"
import path from "path"
import YAML from "yaml"

// 命令总表加载器：config/commands.yaml（用户可编辑）优先，回落 config_default。
// 基于 mtime 的惰性热更新，避免引入新的文件监听依赖。

const PERM_LABEL = { all: "所有人", admin: "群管理", master: "仅主人" }

const cache = new Map()

function resolveConfigPath(pluginRoot) {
  const userPath = path.join(pluginRoot, "config", "commands.yaml")
  if (fs.existsSync(userPath)) return userPath
  return path.join(pluginRoot, "config_default", "commands.yaml")
}

function normalizeRegistry(data) {
  const domains = Array.isArray(data?.domains) ? data.domains : []
  return {
    domains: domains
      .filter(domain => Array.isArray(domain?.commands) && domain.commands.length)
      .map((domain, index) => ({
        key: String(domain.key || `domain_${index + 1}`),
        name: String(domain.name || domain.key || "未命名"),
        icon: String(domain.icon || ""),
        desc: String(domain.desc || ""),
        order: Number(domain.order) || index + 1,
        commands: domain.commands
          .filter(command => command?.usage)
          .map(command => ({
            usage: String(command.usage),
            desc: String(command.desc || ""),
            perm: PERM_LABEL[command.perm] ? command.perm : "all",
            src: String(command.src || "")
          }))
      }))
      .sort((a, b) => a.order - b.order)
  }
}

/** 读取命令总表；文件变更时自动重载（mtime 比对），force 强制刷新 */
export function getCommandRegistry(pluginRoot = process.cwd(), { force = false } = {}) {
  const configPath = resolveConfigPath(pluginRoot)
  let stat = null
  try {
    stat = fs.statSync(configPath)
  } catch {
    return { domains: [], configPath: "", commandCount: 0 }
  }
  const cached = cache.get(configPath)
  if (!force && cached && cached.mtimeMs === stat.mtimeMs) return cached.value

  let data = null
  try {
    data = YAML.parse(fs.readFileSync(configPath, "utf8"))
  } catch (error) {
    if (cached) {
      cached.value.loadError = String(error?.message || error)
      return cached.value
    }
    return { domains: [], configPath, commandCount: 0, loadError: String(error?.message || error) }
  }
  const value = normalizeRegistry(data)
  value.configPath = configPath
  value.commandCount = value.domains.reduce((count, domain) => count + domain.commands.length, 0)
  cache.set(configPath, { mtimeMs: stat.mtimeMs, value })
  return value
}

export function findCommandDomain(registry = {}, query = "") {
  const text = String(query || "").trim().toLowerCase()
  if (!text) return null
  return registry.domains?.find(domain =>
    domain.key === text || domain.name === text || domain.name.includes(text)
  ) || null
}

export function renderHelpMenu(registry = {}) {
  if (!registry.domains?.length) {
    return `命令总表还没有加载到内容${registry.loadError ? `（解析失败：${registry.loadError}）` : ""}`
  }
  const lines = [
    `📖 命令总表（${registry.commandCount} 条 / ${registry.domains.length} 个模块）`,
    "",
    ...registry.domains.map(domain =>
      `${domain.icon ? `${domain.icon} ` : ""}${domain.name}（${domain.commands.length}）—— 发送 .命令 ${domain.key} 查看`
    ),
    "",
    "编辑 config/commands.yaml 可随时调整说明，立即生效；.命令 导出 重新生成文档。"
  ]
  return lines.join("\n")
}

export function renderDomainHelp(domain = null) {
  if (!domain) return null
  const lines = [
    `${domain.icon ? `${domain.icon} ` : ""}${domain.name}（${domain.commands.length} 条）`,
    domain.desc ? `${domain.desc}` : "",
    "",
    ...domain.commands.map(command =>
      `${command.usage}\n    ${command.desc}［${PERM_LABEL[command.perm]}］`
    )
  ]
  return lines.filter(line => line !== "").join("\n")
}

export function renderCommandsMarkdown(registry = {}) {
  const generatedAt = new Date().toISOString().replace("T", " ").slice(0, 19)
  const head = [
    "# 命令总表",
    "",
    "> 本文档由 `config_default/commands.yaml` 生成（`.命令 导出` 或运行 scripts/gen-commands-doc.mjs）。",
    `> 生成时间：${generatedAt} ｜ 共 ${registry.commandCount ?? 0} 条命令 / ${registry.domains?.length ?? 0} 个模块`,
    ""
  ]
  const body = (registry.domains || []).map(domain => {
    const rows = domain.commands.map(command =>
      `| \`${command.usage}\` | ${command.desc} | ${PERM_LABEL[command.perm]} | \`${command.src}\` |`
    )
    return [
      `## ${domain.icon ? `${domain.icon} ` : ""}${domain.name}`,
      "",
      ...(domain.desc ? [domain.desc, ""] : []),
      "| 用法 | 说明 | 权限 | 实现位置 |",
      "| --- | --- | --- | --- |",
      ...rows,
      ""
    ].join("\n")
  })
  return [...head, ...body].join("\n")
}

/** 把 markdown 快照写到 docs/commands.md，返回写入路径 */
export function writeCommandsMarkdown(registry = {}, pluginRoot = process.cwd()) {
  const targetDir = path.join(pluginRoot, "docs")
  fs.mkdirSync(targetDir, { recursive: true })
  const target = path.join(targetDir, "commands.md")
  fs.writeFileSync(target, renderCommandsMarkdown(registry), "utf8")
  return target
}

const VALID_PERMS = new Set(["all", "admin", "master"])

/** 校验网页端提交的命令表数据，返回 { value, errors }；errors 非空时拒绝写入 */
export function validateRegistryInput(data = {}) {
  const errors = []
  const domains = Array.isArray(data?.domains) ? data.domains : []
  if (!domains.length) errors.push("至少需要一个命令模块")
  if (domains.length > 50) errors.push("命令模块数量超过上限（50）")
  const seenKeys = new Set()
  let commandCount = 0
  const value = {
    meta: {
      version: 1,
      desc: "命令总表：由命令管理页维护，机器人热更新读取"
    },
    domains: []
  }
  domains.forEach((domain, index) => {
    const key = String(domain?.key || "").trim() || `domain_${index + 1}`
    if (!/^[\w-]{1,32}$/.test(key)) errors.push(`模块 ${index + 1} 的 key 只能是字母数字-_（≤32 字符）`)
    if (seenKeys.has(key)) errors.push(`模块 key 重复：${key}`)
    seenKeys.add(key)
    const name = String(domain?.name || "").trim()
    if (!name) errors.push(`模块 ${key} 缺少名称`)
    const commands = []
    for (const command of Array.isArray(domain?.commands) ? domain.commands : []) {
      const usage = String(command?.usage || "").trim()
      if (!usage) {
        errors.push(`模块 ${key} 里有空的命令用法`)
        continue
      }
      if (usage.length > 200) errors.push(`命令用法过长：${usage.slice(0, 40)}…`)
      commandCount += 1
      commands.push({
        usage,
        desc: String(command?.desc || "").trim().slice(0, 300),
        perm: VALID_PERMS.has(command?.perm) ? command.perm : "all",
        src: String(command?.src || "").trim().slice(0, 200)
      })
    }
    if (commandCount > 500) errors.push("命令总数超过上限（500）")
    value.domains.push({
      key,
      name: name.slice(0, 50),
      icon: String(domain?.icon || "").trim().slice(0, 4),
      desc: String(domain?.desc || "").trim().slice(0, 200),
      order: Number(domain?.order) || index + 1,
      commands
    })
  })
  return { value, errors, commandCount }
}

/** 把编辑后的命令表写入 config/commands.yaml（用户层，优先于 config_default） */
export function writeRegistryConfig(data = {}, pluginRoot = process.cwd()) {
  const { value, errors } = validateRegistryInput(data)
  if (errors.length) {
    const error = new Error(`命令表校验失败：${errors.slice(0, 5).join("；")}`)
    error.code = "invalid_registry"
    error.errors = errors
    throw error
  }
  const configDir = path.join(pluginRoot, "config")
  fs.mkdirSync(configDir, { recursive: true })
  const target = path.join(configDir, "commands.yaml")
  fs.writeFileSync(target, `# 由命令管理页维护（${new Date().toISOString().slice(0, 19).replace("T", " ")}）\n${YAML.stringify(value)}`, "utf8")
  return target
}
