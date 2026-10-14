import {MCPClientManager as TypedMCPClientManager} from "../dist/backend/modules/tools/infrastructure/MCPClient.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
export class MCPClientManager extends TypedMCPClientManager {constructor(){super({info:message=>globalThis.logger?.info?.(message),warn:message=>globalThis.logger?.warn?.(message),error:(message,error)=>globalThis.logger?.error?.(message,error)},(url,options)=>new StreamableHTTPClientTransport(url,options))}}
export const mcpManager = new MCPClientManager()
