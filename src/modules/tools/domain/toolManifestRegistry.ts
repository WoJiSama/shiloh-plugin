import type {ToolManifest,RegisteredToolIntentManifest} from "../../../contracts/toolExecution.js"
let builtinManifests:ToolManifest[]=[]
export function initializeBuiltinToolManifests(manifests:ToolManifest[]) {builtinManifests=manifests;registerToolManifests(manifests)}
const terminalTools = new Set<string>()
const backgroundTerminalTools = new Set<string>()
const intentManifests = new Map<string,RegisteredToolIntentManifest>()

// 内置工具清单在模块加载时自注册:任何入口(messageIntent/工具/测试)导入本模块
// 即获得完整的终态集合与意图清单,不存在注册时序问题。

export function registerToolManifest(manifest:ToolManifest = {}) {
  const name = String(manifest.name || "").trim()
  if (!name) return
  if (manifest.terminal === true) terminalTools.add(name)
  if (manifest.background === true) backgroundTerminalTools.add(name)
  // triggers 或 disclosure 任一存在即登记:无 triggers 的清单只提供披露说明,
  // 不参与候选选择(selectToolIntentCandidates 对无 triggers 的清单跳过)。
  const hasTriggers = Array.isArray(manifest.triggers) && manifest.triggers.length > 0
  if (hasTriggers || manifest.disclosure) {
    intentManifests.set(name, {
      triggers: hasTriggers ? manifest.triggers ?? [] : [],
      disclosure: String(manifest.disclosure || ""),
      deterministicResolver: typeof manifest.deterministicResolver === "function" ? manifest.deterministicResolver : null
    })
  }
}

export function registerToolManifests(manifests:ToolManifest[] = []) {
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

/** 测试辅助:清空注册,恢复内置清单 */
export function resetToolManifestRegistry() {
  terminalTools.clear()
  backgroundTerminalTools.clear()
  intentManifests.clear()
  registerToolManifests(builtinManifests)
}
