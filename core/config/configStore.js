import fs from "fs"
import path from "path"
import YAML from "yaml"

// 配置内核：默认值深合并、用户层落盘、文件变更热更新。
// 从 apps/test.js 的 initConfig/ensureConfigFiles/mergeConfig 迁出（P3），
// 变更回调通过 onChange 注入，内核不依赖任何插件实例。

export function mergeDeepConfig(defaults, user) {
  const merged = { ...defaults }
  for (const key in defaults) {
    if (typeof defaults[key] === "object" && !Array.isArray(defaults[key]) && defaults[key] !== null) {
      merged[key] = mergeDeepConfig(defaults[key], user?.[key] || {})
    } else if (user && key in user) {
      // 用户配置存在该字段就用用户的值（即使是空值）
      merged[key] = user[key]
    }
  }
  return merged
}

export function createConfigStore({
  pluginRoot,
  configFiles = ["message.yaml"],
  mainFile = "message.yaml",
  settingsKey = "pluginSettings",
  onChange = null,
  logger = globalThis.logger,
  watchImpl = null
} = {}) {
  const root = String(pluginRoot || "")
  const configDir = path.join(root, "config")
  const configDefaultDir = path.join(root, "config_default")
  const mainConfigPath = path.join(configDir, mainFile)
  const mainDefaultPath = path.join(configDefaultDir, mainFile)
  let watcher = null

  function ensureFiles() {
    if (!fs.existsSync(configDefaultDir)) {
      logger?.error?.(`[配置] 默认配置目录不存在: ${configDefaultDir}`)
      return false
    }
    if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true })
    for (const fileName of configFiles) {
      const configPath = path.join(configDir, fileName)
      if (!fs.existsSync(configPath) && fs.existsSync(path.join(configDefaultDir, fileName))) {
        fs.copyFileSync(path.join(configDefaultDir, fileName), configPath)
        logger?.info?.(`[配置] 已从 config_default 复制配置文件: ${fileName}`)
      }
    }
    return true
  }

  function readYaml(file) {
    return YAML.parse(fs.readFileSync(file, "utf8"))
  }

  function load() {
    ensureFiles()
    try {
      if (!fs.existsSync(mainDefaultPath)) {
        logger?.error?.(`[配置] 默认配置文件不存在: ${mainDefaultPath}`)
        return { settings: {}, merged: {} }
      }
      const defaults = readYaml(mainDefaultPath)
      if (fs.existsSync(mainConfigPath)) {
        const user = readYaml(mainConfigPath)
        const merged = mergeDeepConfig(defaults, user)
        if (JSON.stringify(user) !== JSON.stringify(merged)) {
          fs.writeFileSync(mainConfigPath, YAML.stringify(merged))
          logger?.info?.(`[配置] 配置文件已更新，合并了新增字段`)
        }
        return { settings: merged[settingsKey] || {}, merged }
      }
      fs.mkdirSync(path.dirname(mainConfigPath), { recursive: true })
      fs.writeFileSync(mainConfigPath, YAML.stringify(defaults))
      logger?.info?.(`[配置] 已从默认配置创建: ${mainConfigPath}`)
      return { settings: defaults[settingsKey] || {}, merged: defaults }
    } catch (err) {
      logger?.error?.(`[配置] 加载配置文件失败: ${err}`)
      return { settings: {}, merged: {} }
    }
  }

  function startWatch() {
    if (watcher || !watchImpl) return
    let reloadTimer = null
    watcher = watchImpl(mainConfigPath, async filePath => {
      clearTimeout(reloadTimer)
      reloadTimer = setTimeout(async () => {
        try {
          const { settings } = load()
          await onChange?.(settings)
          logger?.mark?.(`[bl-chat-plugin][热更新] ${mainFile} 配置已重新加载`)
        } catch (err) {
          logger?.error?.(`[bl-chat-plugin][热更新] 重新加载配置失败: ${err}`)
        }
      }, 500)
    })
  }

  return { load, startWatch, ensureFiles, paths: { configDir, configDefaultDir, mainConfigPath, mainDefaultPath } }
}
