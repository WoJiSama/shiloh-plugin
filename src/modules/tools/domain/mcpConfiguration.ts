import type {McpServerConfig,McpSettings} from '../../../contracts/mcp.js'
import {toolRecord} from '../../../contracts/toolExecution.js'
export function parseMcpDocument(value:unknown):{settings:Partial<McpSettings>;servers:Record<string,McpServerConfig>} {
 const document=toolRecord(value),rawSettings=toolRecord(document.settings)
 const settings:Partial<McpSettings>={}
 for(const key of ['connectTimeoutMs','toolCallTimeoutMs','toolResultMaxChars','reconnectMaxAttempts'] as const){if(typeof rawSettings[key]==='number')settings[key]=rawSettings[key]}
 if(typeof rawSettings.autoReconnect==='boolean')settings.autoReconnect=rawSettings.autoReconnect
 const servers:Record<string,McpServerConfig>={}
 for(const [name,value] of Object.entries(toolRecord(document.servers))){
  const raw=toolRecord(value),config:McpServerConfig={}
  for(const key of ['type','baseUrl','command','cwd','systemPrompt','description'] as const){if(typeof raw[key]==='string')config[key]=raw[key]}
  for(const key of ['connectTimeoutMs','toolCallTimeoutMs','reconnectMaxAttempts'] as const){if(typeof raw[key]==='number')config[key]=raw[key]}
  for(const key of ['enabled','autoReconnect'] as const){if(typeof raw[key]==='boolean')config[key]=raw[key]}
  if(Array.isArray(raw.args))config.args=raw.args.map(String)
  if(raw.headers&&typeof raw.headers==='object')config.headers=toolRecord(raw.headers)
  if(raw.env&&typeof raw.env==='object')config.env=toolRecord(raw.env)
  if(raw.includeTools!==undefined)config.includeTools=raw.includeTools
  if(raw.excludeTools!==undefined)config.excludeTools=raw.excludeTools
  const conditions=toolRecord(raw.promptConditions)
  if(Object.keys(conditions).length){
   config.promptConditions={}
   if(Array.isArray(conditions.messageType))config.promptConditions.messageType=conditions.messageType.map(String)
   if(Array.isArray(conditions.keywords))config.promptConditions.keywords=conditions.keywords.map(String)
   if(Array.isArray(conditions.groups))config.promptConditions.groups=conditions.groups.filter((id):id is string|number=>typeof id==='string'||typeof id==='number')
  }
  servers[name]=config
 }
 return {settings,servers}
}
