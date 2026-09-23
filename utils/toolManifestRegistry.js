/**
 * 工具清单注册中心:让一个工具的全部路由/呈现声明只写在一处。
 *
 * 背景:此前新增一个工具要同步改 LocalToolRegistry、oneapi_tools 白名单、
 * toolIntentManifests 触发词/披露说明、messageIntent 的终态集合、工具
 * description/skill 等多个文件,漏改任何一处就是线上事故(白名单漏加→工具
 * 不可见;终态漏加→重复执行;主模型提示漏改→路由错工具)。
 *
 * 用法:工具在轻量模块里声明 manifest 常量并在类上挂载,LocalToolRegistry
 * 启动时把每个工具的 manifest 注册进来,各基础设施从这里派生:
 *   manifest = {
 *     name, description, skill,
 *     terminal: true,            // 卡面/文件即回复,成功后不进 LLM 续轮
 *     background: false,         // 后台终态(带进度回报)
 *     triggers: [/regex/],       // 意图候选触发词
 *     disclosure: "...",         // 语义规划器的详细抽取规则
 *     deterministicResolver: fn, // 可选:确定性快路参数解析
 *     conflictRules: [...]       // 可选:候选消歧钩子(保留在 toolIntentManifests)
 *   }
 */

// legacy 静态默认:尚未迁移到 manifest 声明的老工具保持原行为
const DEFAULT_TERMINAL_TOOLS = [
  "sendLocalEmojiTool", "waitTool", "bananaTool", "googleImageEditTool",
  "voiceTool", "deltaForceTool", "mentionAdminsTool", "mentionMembersTool", "torrentDownloadTool"
]
const DEFAULT_BACKGROUND_TERMINAL_TOOLS = ["bananaTool", "googleImageEditTool", "torrentDownloadTool"]

const terminalTools = new Set(DEFAULT_TERMINAL_TOOLS)
const backgroundTerminalTools = new Set(DEFAULT_BACKGROUND_TERMINAL_TOOLS)
const intentManifests = new Map()

export function registerToolManifest(manifest = {}) {
  const name = String(manifest.name || "").trim()
  if (!name) return
  if (manifest.terminal === true) terminalTools.add(name)
  if (manifest.background === true) backgroundTerminalTools.add(name)
  if (Array.isArray(manifest.triggers) && manifest.triggers.length) {
    intentManifests.set(name, {
      triggers: manifest.triggers,
      disclosure: String(manifest.disclosure || ""),
      deterministicResolver: typeof manifest.deterministicResolver === "function" ? manifest.deterministicResolver : null
    })
  }
}

export function registerToolManifests(manifests = []) {
  for (const manifest of Array.isArray(manifests) ? manifests : []) registerToolManifest(manifest)
}

export function isTerminalTool(name = "") {
  return terminalTools.has(String(name || ""))
}

/** 返回活集合本身(messageIntent 的导出引用它,注册后立即可见) */
export function getTerminalToolSet() {
  return terminalTools
}

export function isBackgroundTerminalTool(name = "") {
  return backgroundTerminalTools.has(String(name || ""))
}

export function getBackgroundTerminalToolSet() {
  return backgroundTerminalTools
}

export function getRegisteredIntentManifest(name = "") {
  return intentManifests.get(String(name || "")) || null
}

export function getAllRegisteredIntentManifests() {
  return Object.fromEntries(intentManifests)
}

/** 测试辅助:清空注册,恢复 legacy 默认 */
export function resetToolManifestRegistry() {
  terminalTools.clear()
  for (const name of DEFAULT_TERMINAL_TOOLS) terminalTools.add(name)
  backgroundTerminalTools.clear()
  for (const name of DEFAULT_BACKGROUND_TERMINAL_TOOLS) backgroundTerminalTools.add(name)
  intentManifests.clear()
}
