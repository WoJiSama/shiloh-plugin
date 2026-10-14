import fs from "node:fs"
import path from "node:path"
import {pathToFileURL} from "node:url"
import type {RegisteredLocalTool,LocalToolInfo,LocalRegistryOptions,LocalRegistryPorts} from "../../../contracts/localTools.js"
import {toolRecord,type ToolManifest} from "../../../contracts/toolExecution.js"
import {resolveToolSkill} from "../domain/toolSkills.js"
import {registerToolManifests} from "../domain/toolManifestRegistry.js"
const PLUGIN_NAME = "shiloh-plugin"
const CUSTOM_TOOL_EXTENSIONS = new Set([".js", ".mjs", ".cjs"])
const TOOL_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/
const DEFAULT_RELOAD_INTERVAL_MS = 5000

export class LocalToolRegistry {
 pluginRoot:string;customToolsDir:string;builtInToolInstances:Record<string,RegisteredLocalTool>;builtInToolNames:Set<string>;toolInstances:Record<string,RegisteredLocalTool>;functions:LocalToolInfo[];functionMap:Map<string,LocalToolInfo>;reloadPromise:Promise<ReturnType<LocalToolRegistry['getSnapshot']>>|null;lastCustomToolCount:number;lastReloadAt:number;reloadIntervalMs:number;
 private logWarn(message:string){this.ports.logger.warn(`[LocalToolRegistry] ${message}`)}
 private logError(message:string,error?:unknown){this.ports.logger.error(`[LocalToolRegistry] ${message}`,error)}

  constructor(options:LocalRegistryOptions = {}, private readonly ports:LocalRegistryPorts={factories:[],logger:{info(){},warn(){},error(){}}}) {
    this.pluginRoot = options.pluginRoot || path.join(process.cwd(), "plugins", PLUGIN_NAME)
    this.customToolsDir = options.customToolsDir || path.join(this.pluginRoot, "custom_tools")
    this.builtInToolInstances = this.createBuiltInToolInstances()
    this.builtInToolNames = new Set(Object.keys(this.builtInToolInstances))
    this.toolInstances = { ...this.builtInToolInstances }
    this.functions = this.buildFunctions(this.toolInstances)
    this.functionMap = new Map(this.functions.map(func => [func.name, func]))
    this.reloadPromise = null
    this.lastCustomToolCount = 0
    this.lastReloadAt = 0
    this.reloadIntervalMs = options.reloadIntervalMs ?? DEFAULT_RELOAD_INTERVAL_MS
  }

  getSnapshot() {
    return {
      toolInstances: { ...this.toolInstances },
      functions: [...this.functions],
      functionMap: new Map(this.functionMap),
      toolSkills: Object.fromEntries(Object.entries(this.toolInstances).map(([name, tool]) => [name, resolveToolSkill(tool)])),
      builtInToolCount: this.builtInToolNames.size,
      customToolCount: this.lastCustomToolCount
    }
  }

  async reload(options:{force?:boolean} = {}) {
    if (!options.force && Date.now() - this.lastReloadAt < this.reloadIntervalMs) {
      return this.getSnapshot()
    }

    if (this.reloadPromise) return this.reloadPromise

    this.reloadPromise = this.reloadInternal()
      .catch(error => {
        this.logError("重新加载失败，保留上一份工具注册表", error)
        return this.getSnapshot()
      })
      .finally(() => {
        this.reloadPromise = null
      })

    return this.reloadPromise
  }

  async reloadInternal() {
    const toolInstances = { ...this.builtInToolInstances }
    const customTools = await this.loadCustomTools(toolInstances)

    this.toolInstances = toolInstances
    this.functions = this.buildFunctions(this.toolInstances)
    this.functionMap = new Map(this.functions.map(func => [func.name, func]))
    this.lastCustomToolCount = customTools.length
    this.lastReloadAt = Date.now()

    // logInfo(`已加载 ${this.builtInToolNames.size} 个内置工具，${customTools.length} 个自定义工具`)
    return this.getSnapshot()
  }

  createBuiltInToolInstances() {
    const instances:Record<string,RegisteredLocalTool> = {}
    const manifests:ToolManifest[] = []

    for (const factory of this.ports.factories) {
      try {
        const tool = factory()
        const validationError = this.validateTool(tool)
        if (validationError || !this.isValidTool(tool)) {
          this.logWarn(`跳过无效的内置工具：${validationError}`)
          continue
        }
        if (instances[tool.name]) {
          this.logWarn(`跳过重复的内置工具：${tool.name}`)
          continue
        }
        instances[tool.name] = tool
        if (tool.manifest && typeof tool.manifest === "object") manifests.push(tool.manifest)
      } catch (error) {
        this.logError("创建内置工具失败", error)
      }
    }

    registerToolManifests(manifests)
    return instances
  }

  async loadCustomTools(toolInstances:Record<string,RegisteredLocalTool>) {
    await fs.promises.mkdir(this.customToolsDir, { recursive: true }).catch(() => {})
    const files = await this.scanCustomToolFiles(this.customToolsDir)
    const loaded = []

    for (const filePath of files) {
      try {
        const stat = await fs.promises.stat(filePath)
        const moduleUrl = `${pathToFileURL(filePath).href}?mtime=${stat.mtimeMs}`
        const moduleExports = await import(moduleUrl)
        const candidates = this.getExportCandidates(moduleExports)

        if (!candidates.length) {
          const exportNames = Object.keys(moduleExports || {}).join(", ") || "空"
          this.logWarn(`跳过 ${this.relativePath(filePath)}：未找到可用的工具导出，实际导出项：${exportNames}`)
          continue
        }

        let fileLoaded = 0
        for (const candidate of candidates) {
          let tool = null
          try {
            tool = this.instantiateCandidate(candidate)
          } catch (error) {
            this.logWarn(`跳过 ${this.relativePath(filePath)} 的导出项：${error instanceof Error ? error.message : String(error)}`)
            continue
          }

          const validationError = this.validateTool(tool)
          if (validationError || !this.isValidTool(tool)) {
            this.logWarn(`跳过 ${this.relativePath(filePath)}：${validationError}`)
            continue
          }
          if (this.builtInToolNames.has(tool.name)) {
            this.logWarn(`跳过自定义工具 "${tool.name}"（${this.relativePath(filePath)}）：与内置工具同名`)
            continue
          }
          if (toolInstances[tool.name]) {
            this.logWarn(`跳过自定义工具 "${tool.name}"（${this.relativePath(filePath)}）：工具名重复`)
            continue
          }

          toolInstances[tool.name] = tool
          loaded.push(tool)
          fileLoaded++
        }

        if (!fileLoaded) {
          this.logWarn(`跳过 ${this.relativePath(filePath)}：没有有效的工具导出`)
        }
      } catch (error) {
        this.logError(`加载自定义工具文件 ${this.relativePath(filePath)} 失败`, error)
      }
    }

    return loaded
  }

  async scanCustomToolFiles(dir:string):Promise<string[]> {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])
    const files:string[] = []

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        files.push(...await this.scanCustomToolFiles(entryPath))
        continue
      }

      if (!entry.isFile()) continue
      if (entry.name.endsWith(".example")) continue
      if (!CUSTOM_TOOL_EXTENSIONS.has(path.extname(entry.name))) continue
      files.push(entryPath)
    }

    return files.sort()
  }

  getExportCandidates(moduleExports:Record<string,unknown>) {
    const seen = new Set()
    const candidates:unknown[] = []
    const addCandidate = (value:unknown) => {
      if (!value || seen.has(value)) return
      seen.add(value)
      candidates.push(value)
    }

    for (const value of [moduleExports?.default, ...Object.values(moduleExports || {})]) {
      addCandidate(value)

      if (this.isPlainExportContainer(value)) {
        for (const nestedValue of Object.values(toolRecord(value))) {
          addCandidate(nestedValue)
        }
      }
    }

    return candidates
  }

  isPlainExportContainer(value:unknown) {
    if (!value || typeof value !== "object") return false
    const record=toolRecord(value)
    if (typeof record.execute === "function" || typeof record.func === "function") return false
    if (record.name && record.description && record.parameters) return false
    return Object.getPrototypeOf(value) === Object.prototype
  }

  instantiateCandidate(candidate:unknown):unknown {
    if (typeof candidate === "function") {
      const instance:unknown=Reflect.construct(candidate,[]);return instance
    }
    return candidate
  }

  isValidTool(tool:unknown):tool is RegisteredLocalTool {return this.validateTool(tool)===null}

  validateTool(raw:unknown) {
    const tool=toolRecord(raw)
    const parameters=toolRecord(tool.parameters)
    if (!raw || typeof raw !== "object") return "导出内容不是工具对象或工具类"
    if (!tool.name || typeof tool.name !== "string") return "缺少 tool.name"
    if (!TOOL_NAME_PATTERN.test(tool.name)) {
      return `tool.name "${tool.name}" 不合法，只能使用字母、数字、_ 或 -`
    }
    if (!tool.description || typeof tool.description !== "string") return `工具 "${tool.name}" 缺少 description`
    if (!tool.parameters || typeof tool.parameters !== "object") return `工具 "${tool.name}" 缺少 parameters schema`
    if (parameters.type !== "object") return `工具 "${tool.name}" 的 parameters.type 必须是 object`
    if (!parameters.properties || typeof parameters.properties !== "object") {
      return `工具 "${tool.name}" 的 parameters.properties 必须是对象`
    }
    if (parameters.required && !Array.isArray(parameters.required)) {
      return `工具 "${tool.name}" 的 parameters.required 必须是数组`
    }
    if (typeof tool.execute !== "function") return `工具 "${tool.name}" 缺少 execute(params, event)`

    return null
  }

  buildFunctions(toolInstances:Record<string,RegisteredLocalTool>) {
    const functions = []

    for (const tool of Object.values(toolInstances)) {
      try {
        const info = typeof tool.getToolInfo === "function"
          ? tool.getToolInfo()
          : {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters
            }

        functions.push({
          name: info.name,
          description: info.description,
          parameters: info.parameters
        })
      } catch (error) {
        this.logError(`构建工具 ${tool?.name || "未知"} 的 schema 失败`, error)
      }
    }

    return functions
  }

  relativePath(filePath:string) {
    return path.relative(this.pluginRoot, filePath).replaceAll("\\", "/")
  }
}



export function applyToolRegistrySnapshot<T extends object>(state:T,snapshot:ReturnType<LocalToolRegistry['getSnapshot']>) {
 return Object.assign(state,{toolInstances:snapshot.toolInstances,functions:snapshot.functions,functionMap:snapshot.functionMap,customToolCount:snapshot.customToolCount||0,builtInToolCount:snapshot.builtInToolCount||0})
}
export async function refreshLocalToolSnapshot<T extends object>(state:T,registry:Pick<LocalToolRegistry,'reload'>,options:{force?:boolean}={}) {
 return applyToolRegistrySnapshot(state,await registry.reload(options))
}
