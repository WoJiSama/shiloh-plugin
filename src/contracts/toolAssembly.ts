import type {LocalToolInfo,RegisteredLocalTool} from './localTools.js'
import type {ToolDefinition} from './toolExecution.js'
import type {ChatRequestData,ChatResponse} from './modelGateway.js'
import type {ExecutionConfig,ExecutionOptions} from './modelExecution.js'
import type {McpSettings,McpServerConfig} from './mcp.js'
export interface ToolAssemblyConfig extends ExecutionConfig {oneapi_tools?:unknown[];openai_tools?:unknown[];emojiSystem?:{enabled?:boolean};chatTriggerMode?:string;smartTrigger?:{waitToolEnabled?:boolean}}
export interface ToolRegistrySnapshot {toolInstances:Record<string,RegisteredLocalTool>;functions:LocalToolInfo[];functionMap:Map<string,LocalToolInfo>}
export interface ToolAssemblyHost extends ToolRegistrySnapshot {config:ToolAssemblyConfig;localToolsReady?:boolean;tools:ToolDefinition[];dedupeToolNames:Set<string>;sessionStore:{refreshTools(tools:ToolDefinition[]):void};updateToolsList(options?:{silent?:boolean}):void;getToolsByName(names:unknown[],options?:{warnMissing?:boolean}):ToolDefinition[];syncDedupeToolConfig(names?:unknown[]):void;mergeConfigPreserveUser(defaults:Record<string,unknown>,user:Record<string,unknown>):Record<string,unknown>;mergeMCPConfig(defaults:unknown,user:unknown):Record<string,unknown>}
export interface ToolAssemblyPorts {
 logger:{info(message:string):void;warn(message:string):void;error(message:string,error?:unknown):void};
 refreshLocalTools(options:{force?:boolean;silent?:boolean}):Promise<ToolRegistrySnapshot>;applyToolRegistrySnapshot():ToolRegistrySnapshot;
 mcpManager:{configure(settings:Partial<McpSettings>):void;rememberServerConfig(name:string,config:McpServerConfig):void;connectServer(name:string,config:McpServerConfig):Promise<boolean>;getAllTools():ToolDefinition[];isMCPTool(name:string):boolean;getToolsDescription():string;aliases:{size:number};tools:{size:number}};
 getMcpInitPromise():Promise<unknown>|null;parseToolConfigEntry(entry:unknown):{name:string;dedupe:boolean};
 YTapi(request:ChatRequestData,config:ToolAssemblyConfig,toolContent:unknown,toolName:string|undefined,options:ExecutionOptions):Promise<ChatResponse>;pluginRoot?:string
}
