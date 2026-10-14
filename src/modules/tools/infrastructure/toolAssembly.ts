import fs from "node:fs"
import path from "node:path"
import YAML from "yaml"
import type {ToolAssemblyHost,ToolAssemblyPorts} from "../../../contracts/toolAssembly.js"
import type {ChatRequestData} from "../../../contracts/modelGateway.js"
import type {ExecutionOptions} from "../../../contracts/modelExecution.js"
import {toolRecord} from "../../../contracts/toolExecution.js"
import {executeChatRequestWithRecovery} from "../../models/application/chatRequestRecovery.js"
import {parseMcpDocument} from "../domain/mcpConfiguration.js"
export function createToolAssembly(ports:ToolAssemblyPorts) {
 const {logger,refreshLocalTools,applyToolRegistrySnapshot,mcpManager,getMcpInitPromise,parseToolConfigEntry,YTapi}=ports
 const pluginRoot=ports.pluginRoot || path.join(process.cwd(),"plugins/shiloh-plugin")
 const delay=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms))
async function refreshLocalToolRegistry(host:ToolAssemblyHost, options:{force?:boolean;silent?:boolean;warnMissing?:boolean} = {}) {
    const state = await refreshLocalTools(options)
    host.toolInstances = state.toolInstances
    host.functions = state.functions
    host.functionMap = state.functionMap
    host.localToolsReady = true
    host.updateToolsList({ silent: options.silent === true })
    return state
  }

function initTools(host:ToolAssemblyHost) {
    const snapshot=applyToolRegistrySnapshot()
    host.toolInstances = snapshot.toolInstances
    host.functions = snapshot.functions
    host.functionMap = snapshot.functionMap

    const provider = String(host.config.providers || "oneapi").toLowerCase()
    const toolConfig:Record<string,unknown[]|undefined> = {
      oneapi: host.config.oneapi_tools
    }

    host.syncDedupeToolConfig(host.config.oneapi_tools || [])
    // 白名单缺省 = 全部已注册工具:新增工具不再要求同步改配置,漏改白名单的
    // 事故类型(工具静默不可见)从根上消除。配置了白名单时对排除项打告警提示。
    const configuredList = toolConfig[provider] || host.config.openai_tools
    const allRegisteredNames = Object.keys(host.toolInstances || {})
    const effectiveList = Array.isArray(configuredList) && configuredList.length ? configuredList : allRegisteredNames
    if (Array.isArray(configuredList) && configuredList.length) {
      const configuredNames = new Set(configuredList.map(entry => String(entry).replace(/\s*\(dedupe\)\s*$/i, "").trim()).filter(Boolean))
      const excluded = allRegisteredNames.filter(name => !configuredNames.has(name))
      if (excluded.length) {
        logger.warn(`[工具清单] oneapi_tools 白名单未包含以下已注册工具(如需启用请补进配置): ${excluded.join(", ")}`)
      }
    }
    const localTools = host.getToolsByName(effectiveList, {
      warnMissing: host.localToolsReady !== false
    })
    const mcpTools = mcpManager.getAllTools() || []
    host.tools = [...localTools, ...mcpTools]
  }

function syncDedupeToolConfig(host:ToolAssemblyHost, toolNames = host.config.oneapi_tools || []) {
    host.dedupeToolNames = new Set(
      (Array.isArray(toolNames) ? toolNames : [])
        .map(item => parseToolConfigEntry(item))
        .filter(item => item.name && item.dedupe)
        .map(item => item.name)
    )
  }

function getToolsByName(host:ToolAssemblyHost, toolNames:unknown[], options:{force?:boolean;silent?:boolean;warnMissing?:boolean} = {}) {
    if (!toolNames || !Array.isArray(toolNames)) return []
    const warnMissing = options.warnMissing !== false

    return toolNames
      .map(item => {
        const { name } = parseToolConfigEntry(item)
        if (name === 'sendLocalEmojiTool' && !host.config?.emojiSystem?.enabled) {
          return null
        }
        if (name === 'waitTool') {
          const mode = String(host.config?.chatTriggerMode || 'strict').toLowerCase()
          if (mode !== 'smart' || !host.config?.smartTrigger?.waitToolEnabled) return null
        }
        const func = host.functionMap.get(name)
        if (!func) {
          if (warnMissing) console.warn(`未找到工具 "${name}"`)
          return null
        }
        return {
          type: "function",
          function: {
            name: func.name,
            description: func.description,
            parameters: {
              type: "object",
              properties: func.parameters.properties,
              required: func.parameters.required || []
            }
          }
        }
      })
      .filter(Boolean)
  }

function getToolsDescriptionString(host:ToolAssemblyHost) {
    if (!host.tools?.length) return "当前没有可用的工具。"

    const localDesc = host.tools
      ?.filter(t => !mcpManager.isMCPTool(t.function?.name || ""))
      .map(t => `${t.function?.name}: ${t.function?.description}`)
      .join("\n") || ""

    const mcpDesc = mcpManager.getToolsDescription ? mcpManager.getToolsDescription() : ""

    const parts = []
    if (localDesc) parts.push("【本地工具】\n" + localDesc)
    if (mcpDesc) parts.push("【MCP工具】\n" + mcpDesc)

    return parts.length ? parts.join("\n\n") : "当前没有可用的工具。"
  }

function mergeMCPConfig(host:ToolAssemblyHost, rawDefaults:unknown, rawUser:unknown) {
    const defaults=toolRecord(rawDefaults),user=toolRecord(rawUser)
    const merged = host.mergeConfigPreserveUser(defaults || {}, user || {})

    if (merged.settings && typeof merged.settings === "object") {
      delete toolRecord(merged.settings).legacyAliasEnabled
    }

    if (user?.servers && typeof user.servers === "object" && !Array.isArray(user.servers)) {
      const servers:Record<string,unknown> = { ...toolRecord(user.servers) };merged.servers=servers
      for (const [serverName, serverConfig] of Object.entries(toolRecord(user.servers))) {
        if (toolRecord(defaults.servers)[serverName]) {
          servers[serverName] = host.mergeConfigPreserveUser(
            toolRecord(toolRecord(defaults.servers)[serverName]),
            toolRecord(serverConfig)
          )
        }
      }
    }

    return merged
  }

async function retryRequest(host:ToolAssemblyHost, requestData:ChatRequestData, toolContent:unknown, retries = 1, toolName?:string, options:ExecutionOptions = {}) {
	    return executeChatRequestWithRecovery(
	      currentRequest => YTapi(currentRequest, host.config, toolContent, toolName, options),
	      requestData,
	      {
	        retries,
	        onRetry: ({ failure, requestData: retryData, retriesLeft }) => {
	          const choice = typeof retryData?.tool_choice === "string"
	            ? retryData.tool_choice
	            : retryData?.tool_choice?.function?.name || "auto"
	          logger.warn(`[API重试] kind=${failure.kind} status=${failure.status || ""} toolChoice=${choice} retriesLeft=${retriesLeft}`)
	        }
	      }
	    )
	  }

async function initMCP(host:ToolAssemblyHost) {
    try {
      const configDir = path.join(pluginRoot, "config")
      const configDefaultDir = path.join(pluginRoot, "config_default")
      const configPath = path.join(configDir, "mcp-servers.yaml")
      const defaultConfigPath = path.join(configDefaultDir, "mcp-servers.yaml")

      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true })
      }

      if (!fs.existsSync(configPath)) {
        if (fs.existsSync(defaultConfigPath)) {
          fs.copyFileSync(defaultConfigPath, configPath)
          logger.info(`[MCP] 已从 config_default 复制配置文件: mcp-servers.yaml`)
          logger.info(`[MCP] 请根据需要修改配置并启用相应的MCP服务器`)
        } else {
          logger.warn(`[MCP] 默认配置文件不存在: ${defaultConfigPath}`)
          logger.warn(`[MCP] 请在 config_default 目录下创建 mcp-servers.yaml 文件`)
          return
        }
      }

      if (!fs.existsSync(configPath)) {
        logger.info("[MCP] MCP配置文件不存在，跳过初始化")
        return
      }

      let mcpConfig:unknown = YAML.parse(fs.readFileSync(configPath, "utf8"))
      if (fs.existsSync(defaultConfigPath)) {
        const defaultMcpConfig = YAML.parse(fs.readFileSync(defaultConfigPath, "utf8"))
        const mergedMcpConfig = host.mergeMCPConfig(defaultMcpConfig, mcpConfig || {})
        if (JSON.stringify(mcpConfig || {}) !== JSON.stringify(mergedMcpConfig)) {
          fs.writeFileSync(configPath, YAML.stringify(mergedMcpConfig))
          logger.info("[MCP] 已自动补齐 mcp-servers.yaml 新增默认配置项")
        }
        mcpConfig = mergedMcpConfig
      }
      const parsed=parseMcpDocument(mcpConfig)
      mcpManager.configure(parsed.settings)

      if (!parsed.servers) {
        logger.info("[MCP] MCP配置为空或无服务器配置")
        host.updateToolsList()
        return
      }

      for (const [serverName, config] of Object.entries(parsed.servers)) {
        mcpManager.rememberServerConfig(serverName, config)
      }

      const enabledServers = Object.entries(parsed.servers).filter(([_, config]) => config.enabled)

      if (enabledServers.length === 0) {
        logger.info("[MCP] 没有启用的MCP服务器")
        host.updateToolsList()
        return
      }

      for (const [serverName, config] of enabledServers) {
        await mcpManager.connectServer(serverName, config)
      }

      host.updateToolsList()

      logger.info(`[MCP] 初始化完成，共加载 ${mcpManager.aliases?.size || mcpManager.tools.size} 个MCP工具`)
    } catch (error) {
      logger.error("[MCP] 初始化失败:", error)
    }
  }

function updateToolsList(host:ToolAssemblyHost, options:{force?:boolean;silent?:boolean;warnMissing?:boolean} = {}) {
    host.syncDedupeToolConfig(host.config.oneapi_tools || [])
    const localTools = host.getToolsByName(host.config.oneapi_tools || [], {
      warnMissing: host.localToolsReady !== false
    })
    const mcpTools = mcpManager.getAllTools() || []

    host.tools = [...localTools, ...mcpTools]

    host.sessionStore.refreshTools(host.tools)

  }

async function waitForMCPReady(host:ToolAssemblyHost, timeoutMs = 5000) {
    if (!getMcpInitPromise()) return
    try {
      await Promise.race([
        getMcpInitPromise(),
        delay(timeoutMs).then(() => "timeout")
      ])
      host.updateToolsList()
    } catch (error) {
      logger.warn(`[MCP] 等待初始化完成失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
return {refreshLocalToolRegistry,initTools,syncDedupeToolConfig,getToolsByName,getToolsDescriptionString,mergeMCPConfig,retryRequest,initMCP,updateToolsList,waitForMCPReady}
}
