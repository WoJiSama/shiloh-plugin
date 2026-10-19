export interface McpSettings {
    connectTimeoutMs: number;
    toolCallTimeoutMs: number;
    toolResultMaxChars: number;
    autoReconnect: boolean;
    reconnectMaxAttempts: number;
}
export interface McpServerConfig {
    type?: string;
    enabled?: boolean;
    includeTools?: unknown;
    excludeTools?: unknown;
    connectTimeoutMs?: number;
    toolCallTimeoutMs?: number;
    autoReconnect?: boolean;
    reconnectMaxAttempts?: number;
    headers?: Record<string, unknown>;
    baseUrl?: string;
    command?: string;
    args?: string[];
    env?: Record<string, unknown>;
    cwd?: string;
    systemPrompt?: string;
    description?: string;
    promptConditions?: {
        messageType?: string[];
        groups?: (string | number)[];
        keywords?: string[];
    };
    connected?: boolean;
    toolCount?: number;
    toolNames?: string[];
    toolAliases?: string[];
    lastError?: string | null;
    error?: string | null;
    connectedAt?: string;
    disconnectedAt?: string;
    failedAt?: string;
    updatedAt?: string;
    reconnectAttempts?: number;
}
export interface McpLogger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string, error?: unknown): void;
}
export interface McpSchema {
    type?: unknown;
    description?: unknown;
    properties?: Record<string, unknown>;
    required?: unknown[];
    items?: unknown;
    enum?: unknown[];
    [key: string]: unknown;
}
export declare function mcpRecord(value: unknown): McpSchema;
