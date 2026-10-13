import type { ChatMessage, ChatRequestData, ChatResponse } from './modelGateway.js'
export interface Backend {
 apiUrl?: string | undefined; model?: string | undefined; apiKey?: string | string[] | undefined; label?: string | undefined
 reasoningEffort?: string | undefined; maxTokensField?: string | undefined; maxOutputTokens?: number | undefined
 complexity?: { score: number; signals: string[] }
}
export interface ChatBackendConfig { chatApiUrl?: string | undefined; chatApiModel?: string | undefined; chatApiKey?: string | string[] | undefined; chatReasoningEffort?: string; label?: string | undefined }
export interface ExecutionConfig {
 providers?: string; useTools?: boolean; chatAiConfig?: ChatBackendConfig
 toolsAiConfig?: { toolsAiUrl?: string; toolsAiModel?: string; toolsAiApikey?: string }
 trackAiConfig?: { trackAiUrl?: string; trackAiModel?: string; trackAiApikey?: string | string[] }
 searchAiConfig?: { searchApiUrl?: string; searchApiModel?: string; searchApiKey?: string | string[] }
 memoryAiConfig?: { memoryAiUrl?: string; memoryAiModel?: string; memoryAiApikey?: string | string[] }
 taskAiConfig?: Record<string, Backend>; [field: string]: unknown
}
export interface ExecutionOptions {
 taskBackend?: string; forceChatBackend?: boolean; toolsBackendFallback?: boolean; textBackendFallback?: boolean; routeLabel?: string
 signal?: AbortSignal; generation?: { temperature?: number; topP?: number; maxOutputTokens?: number; maxTokensField?: string; reasoningEffort?: string }
}
export interface ModelExecutionPorts {
 fetch: typeof fetch
 logger: { info(...values: unknown[]): void; warn(...values: unknown[]): void; error(...values: unknown[]): void }
 removeToolPromptsFromMessages(messages: ChatMessage[]): ChatMessage[]
 resolveChatCompletionUrl(url?: string): string
 resolveAgentBackend(config: ExecutionConfig, request: ChatRequestData): Backend
 shouldAcceptPlannerTextResponse(response: ChatResponse): boolean
 summarizeToolResultForAgent(name: string, content: unknown): string
}
