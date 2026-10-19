export interface ChatProviderConfig {
    providers?: string;
    chatAiConfig?: {
        chatApiModel?: string;
    };
    useTools?: boolean;
}
export type ToolChoice = 'auto' | 'none' | 'required' | {
    type?: string;
    function: {
        name: string;
    };
};
export interface ChatMessage {
    role: string;
    name?: string;
    tool_calls?: {
        function?: {
            name?: string;
            arguments?: string;
        };
    }[];
    content?: unknown;
    [field: string]: unknown;
}
export interface ChatTool {
    type: string;
    function?: {
        name: string;
        [field: string]: unknown;
    };
    [field: string]: unknown;
}
export interface ChatRequestData {
    model?: string | undefined;
    messages?: ChatMessage[];
    temperature?: number;
    top_p?: number;
    tools?: ChatTool[];
    tool_choice?: ToolChoice;
    [field: string]: unknown;
}
export type ChatFailureKind = 'empty' | 'tool_choice_compatibility' | 'balance' | 'rate_limit' | 'upstream' | 'timeout' | 'network' | 'auth' | 'request' | 'unknown';
export interface ChatFailure {
    kind: ChatFailureKind;
    message: string;
    retryable: boolean;
    status: number | null;
}
export interface ChatResponseMessage {
    role?: string;
    name?: string;
    tool_calls?: {
        function?: {
            name?: string;
            arguments?: string;
        };
    }[];
    content?: unknown;
    [field: string]: unknown;
}
export interface ChatResponse {
    error?: unknown;
    choices?: {
        message?: ChatResponseMessage;
        [field: string]: unknown;
    }[];
    [field: string]: unknown;
}
export interface RetryEvent {
    failure: ChatFailure;
    reason: ChatFailureKind;
    retriesLeft: number;
    previousRequest: ChatRequestData;
    requestData: ChatRequestData;
}
export interface RecoveryOptions {
    retries?: number;
    signal?: AbortSignal;
    onRetry?: (event: RetryEvent) => void;
}
