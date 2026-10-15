import { buildVisibleFailureDetail } from '../domain/visibleFailure.js'
import { sanitizeJsonValue } from '../domain/unicodeText.js'
import { parseChatResponse } from '../domain/chatResponse.js'
import type { ChatMessage, ChatRequestData, ChatResponse } from '../../../contracts/modelGateway.js'
import type { Backend, ChatBackendConfig, ExecutionConfig, ExecutionOptions, ModelExecutionPorts } from '../../../contracts/modelExecution.js'
// A provider may require a flat named choice on the wire. Keep that shape at
// this boundary instead of weakening the application's nested tool contract.
interface ProviderChatRequestData {
    [field: string]: unknown
    tool_choice?: ChatRequestData['tool_choice'] | { type: string; name: string }
}
function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message
  if (value && typeof value === 'object' && 'message' in value) return String(value.message)
  return typeof value === 'string' ? value : ''
}
function sourceFailure(url: string, model: unknown, detail: string): string {
 let host = '未知渠道'
 try { host = new URL(url).hostname } catch {}
 return `【渠道=${host}；模型=${buildVisibleFailureDetail(String(model || '未知'))}】${buildVisibleFailureDetail(detail)}`
}
export function createModelExecutor(ports: ModelExecutionPorts) {
 const { fetch, logger, removeToolPromptsFromMessages, resolveChatCompletionUrl, resolveAgentBackend, shouldAcceptPlannerTextResponse, summarizeToolResultForAgent } = ports

async function fetchWithGenerationCompatibility(url: string, headers: Record<string, string>, requestData: ProviderChatRequestData, options: ExecutionOptions) {
    const sendRequest = () => {
        options.signal?.throwIfAborted()
        return fetch(url, {
            method: 'POST', headers,
            body: JSON.stringify(sanitizeJsonValue(requestData)),
            ...(options.signal ? { signal: options.signal } : {})
        })
    }
    let response = await sendRequest()
    if (response.ok) return { response, errorText: "" }

    let errorText = await response.text().catch(() => '无法读取错误内容')
    const optionalFields = ["temperature", "top_p", "max_tokens", "max_completion_tokens", "reasoning_effort", "response_format"]
        .filter(field => Object.hasOwn(requestData, field))
    // Tool-choice recovery has its own contract and must retain the effort.
    const mayRetryWithoutOptions = response.status === 400 && optionalFields.length > 0 &&
        !/thinking mode does not support this tool_choice/i.test(errorText) &&
        /(?:unsupported|unknown|unrecognized|not support|invalid parameter|max_tokens|max_completion_tokens|reasoning_effort|temperature|response_format)/i.test(errorText)
    if (mayRetryWithoutOptions) {
        logger.warn(`[API兼容] 可选生成参数不受支持，移除后在同一后端重试 fields=${optionalFields.join(',')}${optionalFields.includes("reasoning_effort") ? " effort=provider_default" : ""}`)
        for (const field of optionalFields) delete requestData[field]
        response = await sendRequest()
        errorText = response.ok ? "" : await response.text().catch(() => '无法读取错误内容')
    }
    return { response, errorText }
}

function preserveReasoningEffort(options: ExecutionOptions, effort: unknown): ExecutionOptions {
    return typeof effort === "string" && effort.trim()
        ? { ...options, generation: { ...options.generation, reasoningEffort: effort } }
        : options
}
/**
 * 发送请求到 OpenAI API 或其他提供者并处理响应
 * @param {Object} requestData - 请求体数据
 * @param {Object} config - 配置对象
 * @returns {Object|null} - 返回处理后的响应数据或错误信息
 */
async function YTapi(requestData: ChatRequestData, config: ExecutionConfig, toolContent?: unknown, toolName?: string, options: ExecutionOptions = {}): Promise<ChatResponse> {
    const provider = config.providers?.toLowerCase();

    options.signal?.throwIfAborted()
    try {
        let url: string, headers: Record<string, string>, finalRequestData: ChatRequestData, selectedTextBackend: Backend | null = null;

        const requestHasTools = Array.isArray(requestData?.tools) &&
            requestData.tools.length > 0 &&
            requestData.tool_choice !== "none";

        if (config.useTools && requestHasTools) {
            // useTools 开启，先调用 OpenAI API
            const toolsBackend = resolveConfiguredToolsBackend(config, options.taskBackend);
            const openaiUrl = resolveChatCompletionUrl(toolsBackend.apiUrl);
            // 确保使用OpenAiModel的模型
            if (!config.toolsAiConfig?.toolsAiApikey) return { error: "OpenAI Token 未配置" };

            const openaiHeaders = {
                'Authorization': `Bearer ${config.toolsAiConfig?.toolsAiApikey}`,
                'Content-Type': 'application/json'
            };

            let openaiResponse;
            try {
                // 使用config.OpenAiModel替换请求中的模型
                const openaiRequestData = normalizeToolChoiceForToolsProvider({
                    ...requestData,
                    model: toolsBackend.model,
                    stream: false,
                    ...buildGenerationOptions(requestData, options, toolsBackend)
                }, openaiUrl);
                options = preserveReasoningEffort(options, openaiRequestData.reasoning_effort)
                // logger.error(config.toolsAiConfig?.toolsAiApikey, config.toolsAiConfig?.toolsAiModel, JSON.stringify(openaiRequestData))
                // logger.error('已触发全局AI对话', config.toolsAiConfig?.toolsAiApikey, config.toolsAiConfig?.toolsAiModel)
                const sent = await fetchWithGenerationCompatibility(openaiUrl, openaiHeaders, openaiRequestData, options)
                openaiResponse = sent.response

                if (!openaiResponse.ok) {
                    const failure = sourceFailure(openaiUrl, config.toolsAiConfig?.toolsAiModel, `OpenAI API 请求失败：${openaiResponse.status} ${openaiResponse.statusText} - ${sent.errorText}`);
                    logger.error(failure);
                    return await fallbackFromToolsBackend(requestData, config, toolContent, toolName, options, failure);
                }
            } catch (openaiFetchError) {
            options.signal?.throwIfAborted()
                const failure = sourceFailure(openaiUrl, config.toolsAiConfig?.toolsAiModel, `OpenAI API 请求失败：${errorMessage(openaiFetchError)}`);
                logger.error("OpenAI API 请求失败:", openaiFetchError);
                return await fallbackFromToolsBackend(requestData, config, toolContent, toolName, options, failure);
            }

            let openaiData;
            try {
                openaiData = processResponse(await openaiResponse.json());
                logger.error('OpenAI 响应:', JSON.stringify(openaiData, null, 2));
            } catch (openaiJsonError) {
                logger.error("解析 OpenAI 响应 JSON 失败:", openaiJsonError);
                return { error: sourceFailure(openaiUrl, config.toolsAiConfig?.toolsAiModel, `解析 OpenAI 响应 JSON 失败：${errorMessage(openaiJsonError)}`) };
            }

            // 检查是否包含 tool_calls，无论 finish_reason 是什么
            const hasToolCalls = (openaiData?.choices?.[0]?.message?.tool_calls?.length || 0) > 0;
            if (hasToolCalls) {
                // 直接返回 tool_calls 响应，保持 OpenAI 模型
                return processResponse(openaiData);
            }
            if (shouldAcceptPlannerTextResponse(openaiData)) {
                logger.info(`[Agent路由] 工具模型选择直接文字回复，保留原始回答，不再交给快速模型重答`);
                return processResponse(openaiData);
            }

            // 检查 OneAPI 配置
            selectedTextBackend = resolveConfiguredChatBackend(config);
            if (!selectedTextBackend.apiUrl || !selectedTextBackend.model || !selectedTextBackend.apiKey?.length) {
                return { error: "OneAPI URL、模型或 API Key 未配置" };
            }
            url = resolveChatCompletionUrl(selectedTextBackend.apiUrl);
            const oneApiKey = getChatApiKey(selectedTextBackend.apiKey);
            headers = {
                'Authorization': `Bearer ${oneApiKey}`,
                'Content-Type': 'application/json'
            };

            finalRequestData = {
                model: selectedTextBackend.model,
                messages: convertToolMessagesForChat(requestData.messages, toolName),
                stream: false,
                ...buildGenerationOptions(requestData, options, selectedTextBackend)
            };
        } else {
            const backend = options.taskBackend
                ? resolveConfiguredTaskBackend(config, options.taskBackend)
                : options.forceChatBackend
                    ? resolveConfiguredChatBackend(config)
                    : resolveAgentBackend(config, requestData);
            selectedTextBackend = backend;
            if (!backend.apiUrl || !backend.model || !backend.apiKey?.length) {
                return { error: "OneAPI URL、模型或 API Key 未配置" };
            }
            url = resolveChatCompletionUrl(backend.apiUrl);
            const oneApiKey = getChatApiKey(backend.apiKey);
            headers = {
                'Authorization': `Bearer ${oneApiKey}`,
                'Content-Type': 'application/json'
            };
            finalRequestData = {
                model: backend.model,
                messages: convertToolMessagesForChat(requestData.messages, toolName),
                stream: false,
                ...buildGenerationOptions(requestData, options, backend)
            };
            if (backend.label === "reasoning") {
                logger.info(`[Agent路由] 复杂请求升档到 ${backend.model} score=${backend.complexity?.score} signals=${backend.complexity?.signals.join(',')}`);
            } else if (options.taskBackend || options.forceChatBackend) {
                logger.info(`[Agent路由] ${options.routeLabel || "紧凑请求"} 固定使用快速模型 ${backend.model}`);
            }
        }

        // 发送 API 请求

        if (!url || !headers || !finalRequestData) {
            return { error: "缺少必要的请求参数（URL、headers 或请求体）" };
        }

        let response;
        if (url.includes('v1/chat/completions') && typeof finalRequestData === 'object' && finalRequestData !== null) {
            delete finalRequestData.tools;
            delete finalRequestData.tool_choice;
        }
        finalRequestData.messages = moveFinalToolPromptToEnd(
            removeToolPromptsFromMessages(finalRequestData.messages || requestData.messages || [])
        )
        logger.info('最终请求体:', finalRequestData);
        options = preserveReasoningEffort(options, finalRequestData.reasoning_effort)
        try {
            const sent = await fetchWithGenerationCompatibility(url, headers, finalRequestData, options)
            response = sent.response

            if (!response.ok) {
                const failure = sourceFailure(selectedTextBackend?.apiUrl || url, selectedTextBackend?.model || finalRequestData.model, `API 请求失败：${response.status} ${response.statusText} - ${sent.errorText}`);
                logger.error(failure);
                const fallback = await fallbackFromTextBackend(
                    requestData,
                    config,
                    toolContent,
                    toolName,
                    options,
                    failure,
                    selectedTextBackend
                );
                return fallback || { error: failure };
            }
        } catch (fetchError) {
            options.signal?.throwIfAborted()
            const failure = sourceFailure(selectedTextBackend?.apiUrl || url, selectedTextBackend?.model || finalRequestData.model, `${provider || 'API'} 请求失败：${errorMessage(fetchError)}`);
            logger.error(`${provider || 'API'} 请求失败:`, fetchError);
            const fallback = await fallbackFromTextBackend(
                requestData,
                config,
                toolContent,
                toolName,
                options,
                failure,
                selectedTextBackend
            );
            return fallback || { error: failure };
        }

        let responseData;
        try {
            responseData = await response.json();
            logger.info(`${provider || 'API'} 响应:`, JSON.stringify(responseData, null, 2));
        } catch (jsonError) {
            logger.error(`解析 ${provider || 'API'} 响应 JSON 失败:`, jsonError);
            return { error: sourceFailure(selectedTextBackend?.apiUrl || url, selectedTextBackend?.model || finalRequestData.model, `解析 ${provider || 'API'} 响应 JSON 失败：${errorMessage(jsonError)}`) };
        }
        return processResponse(responseData);

    } catch (error) {
            options.signal?.throwIfAborted()
        logger.error('YTapi 异常:', error);
        return { error: `发生异常：${errorMessage(error)}` };
    }
}

function canFallbackFromToolsBackend(requestData: ChatRequestData = {}) {
    const toolChoice = requestData?.tool_choice;
    // A forced tool is an execution contract. Falling back to text would make
    // the bot look as though the tool had been executed when it was not.
    if (toolChoice === "required" || (typeof toolChoice === "object" ? toolChoice.function?.name : undefined)) return false;
    return true;
}

async function fallbackFromToolsBackend(requestData: ChatRequestData, config: ExecutionConfig, toolContent: unknown, toolName: string | undefined, options: ExecutionOptions, failure: string): Promise<ChatResponse> {
    if (!canFallbackFromToolsBackend(requestData)) return { error: failure };

    const candidates = resolveToolsBackendFallbacks(config);
    // A casual task may lend its effort to a tool request, but cannot replace
    // the explicitly selected text fallback's address, model or credentials.
    const { taskBackend: _taskBackend, ...fallbackOptions } = options
    let lastFailure: ChatResponse = { error: failure };
    for (const candidate of candidates) {
        logger.warn(`[Agent路由] 工具模型不可用，当前请求不强制工具调用，降级到 ${candidate.label}: ${failure}`);
        const response = await YTapi(requestData, {
            ...config,
            useTools: false,
            chatAiConfig: candidate
        }, toolContent, toolName, {
            ...fallbackOptions,
            forceChatBackend: true,
            toolsBackendFallback: true,
            textBackendFallback: true
        });
        if (response?.choices?.[0]?.message?.content) return response;
        lastFailure = response?.error ? response : lastFailure;
    }
    return lastFailure;
}

function hasSameBackend(left: Backend & ChatBackendConfig = {}, right: (Backend & ChatBackendConfig) | null = {}) {
    return String(left?.apiUrl || left?.chatApiUrl || "").replace(/\/+$/, "") === String(right?.apiUrl || right?.chatApiUrl || "").replace(/\/+$/, "") &&
        String(left?.model || left?.chatApiModel || "") === String(right?.model || right?.chatApiModel || "");
}

async function fallbackFromTextBackend(requestData: ChatRequestData, config: ExecutionConfig, toolContent: unknown, toolName: string | undefined, options: ExecutionOptions, failure: string, selectedBackend: Backend | null): Promise<ChatResponse | null> {
    if (options.textBackendFallback || options.taskBackend) return null;

    let lastFailure: ChatResponse | null = null;
    for (const candidate of resolveToolsBackendFallbacks(config)) {
        if (hasSameBackend(candidate, selectedBackend)) continue;
        logger.warn(`[Agent路由] 回答模型不可用，降级到 ${candidate.label}: ${failure}`);
        const response = await YTapi(requestData, {
            ...config,
            useTools: false,
            chatAiConfig: candidate
        }, toolContent, toolName, {
            ...options,
            forceChatBackend: true,
            textBackendFallback: true
        });
        if (response?.choices?.[0]?.message?.content) return response;
        if (response?.error) lastFailure = response;
    }
    return lastFailure;
}

function resolveConfiguredChatBackend(config: ExecutionConfig = {}): Backend {
    const chat = config?.chatAiConfig || {}
    return {
        apiUrl: chat.chatApiUrl,
        model: chat.chatApiModel,
        apiKey: chat.chatApiKey,
        label: "chat",
        reasoningEffort: chat.chatReasoningEffort || ""
    }
}

function resolveConfiguredToolsBackend(config: ExecutionConfig = {}, taskName = ""): Backend {
    const tools = config.toolsAiConfig || {}
    const task = config.taskAiConfig?.[taskName]
    return {
        apiUrl: tools.toolsAiUrl,
        model: tools.toolsAiModel,
        apiKey: tools.toolsAiApikey,
        label: "tools",
        reasoningEffort: tools.toolsReasoningEffort?.trim() || task?.reasoningEffort?.trim() || config.chatAiConfig?.chatReasoningEffort || ""
    }
}

function resolveToolsBackendFallbacks(config: ExecutionConfig = {}) {
    const chat = config?.chatAiConfig || {};
    const track = config?.trackAiConfig || {};
    const search = config?.searchAiConfig || {};
    const memory = config?.memoryAiConfig || {};
    const candidates = [
        {
            label: "聊天模型",
            chatApiUrl: chat.chatApiUrl,
            chatApiModel: chat.chatApiModel,
            chatApiKey: chat.chatApiKey
        },
        {
            label: "追踪回答模型",
            chatApiUrl: track.trackAiUrl,
            chatApiModel: track.trackAiModel,
            chatApiKey: track.trackAiApikey
        },
        {
            label: "检索回答模型",
            chatApiUrl: search.searchApiUrl,
            chatApiModel: search.searchApiModel,
            chatApiKey: search.searchApiKey
        },
        {
            // This remains text-only fallback. Explicit tool execution never
            // reaches this path, so a text answer cannot impersonate a tool.
            label: "记忆回答模型",
            chatApiUrl: memory.memoryAiUrl,
            chatApiModel: memory.memoryAiModel,
            chatApiKey: memory.memoryAiApikey
        }
    ];
    const seen = new Set();
    return candidates.filter(candidate => {
        const key = [candidate.chatApiUrl, candidate.chatApiModel, Array.isArray(candidate.chatApiKey) ? candidate.chatApiKey.join("|") : candidate.chatApiKey].join("\u0000");
        if (!candidate.chatApiUrl || !candidate.chatApiModel || !candidate.chatApiKey?.length || seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function resolveConfiguredTaskBackend(config: ExecutionConfig = {}, taskName = ""): Backend {
    const task = config?.taskAiConfig?.[String(taskName || "").trim()] || {}
    if (task.apiUrl && task.model && task.apiKey?.length) {
        return {
            apiUrl: task.apiUrl,
            model: task.model,
            apiKey: task.apiKey,
            label: `task:${taskName}`,
            maxTokensField: task.maxTokensField,
            maxOutputTokens: task.maxOutputTokens,
            reasoningEffort: task.reasoningEffort
        }
    }
    const chatBackend = resolveConfiguredChatBackend(config)
    // 只配置思考档、不另配地址时：沿用 chat 后端但覆盖 effort
    // none 仅在后端支持时按原值透传；全局 chat 保持 low，复杂档由 generation 覆盖。
    if (task.reasoningEffort !== undefined && String(task.reasoningEffort).trim() !== "") {
        return { ...chatBackend, label: `task:${taskName}:chat-effort`, reasoningEffort: String(task.reasoningEffort).trim() }
    }
    return { ...chatBackend, label: `task:${taskName}:chat-fallback` }
}

function buildGenerationOptions(requestData: ChatRequestData = {}, options: ExecutionOptions = {}, backend: Backend = {}) {
    const generation = options.generation || {}
    const output: Record<string, unknown> = {}
    for (const field of ["temperature", "top_p", "max_tokens", "max_completion_tokens", "reasoning_effort", "response_format"]) {
        if (requestData[field] !== undefined) output[field] = requestData[field]
    }
    if (generation.temperature !== undefined) output.temperature = generation.temperature
    if (generation.topP !== undefined) output.top_p = generation.topP
    const maxOutputTokens = Number(generation.maxOutputTokens ?? backend.maxOutputTokens)
    if (Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) {
        const field = String(generation.maxTokensField || backend.maxTokensField || "max_tokens")
        if (["max_tokens", "max_completion_tokens"].includes(field)) output[field] = Math.floor(maxOutputTokens)
    }
    const reasoningEffort = generation.reasoningEffort || backend.reasoningEffort
    if (reasoningEffort) output.reasoning_effort = reasoningEffort
    return output
}

function getChatApiKey(chatApiKey: string | string[] | undefined) {
    if (Array.isArray(chatApiKey)) {
        const keys = chatApiKey.filter(key => typeof key === 'string' && key.trim())
        return keys[Math.floor(Math.random() * keys.length)]
    }
    return chatApiKey
}

function normalizeToolChoiceForToolsProvider(requestData: ChatRequestData, apiUrl: string): ProviderChatRequestData {
    const toolChoice = requestData?.tool_choice;
    const functionName = (typeof toolChoice === "object" ? toolChoice.function?.name : undefined);

    if (!functionName || !/souimagery\.fun/i.test(String(apiUrl || ""))) {
        return requestData;
    }

    return {
        ...requestData,
        tool_choice: {
            type: typeof toolChoice === "object" ? toolChoice.type || "function" : "function",
            name: functionName
        }
    };
}

/**
 * 处理 API 响应数据
 * @param {Object|Array} responseData - API 响应数据
 * @returns {Object} - 处理后的响应数据
 */
function convertToolMessagesForChat(messages: ChatMessage[] = [], fallbackToolName = 'tool') {
    const converted = [];

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]!;

        if (msg.role === 'assistant' && msg.tool_calls?.length) {
            const requests = msg.tool_calls.map((toolCall, index) => {
                const name = toolCall.function?.name || fallbackToolName || 'tool';
                return `${index + 1}. ${name}`;
            });

            const results = [];
            while (messages[i + 1]?.role === 'tool') {
                i++;
                const toolMsg = messages[i]!;
                const name = toolMsg.name || fallbackToolName || 'tool';
                results.push(summarizeToolResultForChat(name, toolMsg.content));
            }

            converted.push({
                role: 'system',
                content: [
                    '[tool_execution]',
                    'requests:',
                    ...requests,
                    results.length ? 'results:' : null,
                    ...results
                ].filter(Boolean).join('\n')
            });
            continue;
        }

        if (msg.role === 'tool') {
            const name = msg.name || fallbackToolName || 'tool';
            converted.push({
                role: 'system',
                content: `[tool_execution]\nresults:\n${summarizeToolResultForChat(name, msg.content)}`
            });
            continue;
        }

        converted.push(msg);
    }

    return converted.filter(Boolean);
}

function moveFinalToolPromptToEnd(messages: ChatMessage[] = []) {
    const finalPrompts = [];
    const normalMessages = [];

    for (const msg of messages) {
        const content = String(msg?.content || "");
        const isFinalToolPrompt = msg?.role === "system"
            && content.includes("工具已全部执行完成")
            && content.includes("自然口语");

        if (isFinalToolPrompt) {
            finalPrompts.push(msg);
        } else {
            normalMessages.push(msg);
        }
    }

    return finalPrompts.length
        ? [...normalMessages, finalPrompts[finalPrompts.length - 1]!]
        : normalMessages;
}

function summarizeToolResultForChat(toolName: string, content: unknown = '') {
    const text = summarizeToolResultForAgent(toolName, content);
    return `content: ${text}`;
}
function processResponse(responseData: unknown): ChatResponse {
    // 处理数组响应（兼容某些 API 返回数组的情况）
    if (Array.isArray(responseData) && responseData.length > 0) {
        return processResponse(responseData[0]);
    }

    // 处理对象响应
    if (typeof responseData === 'object' && responseData !== null) {
        const data = parseChatResponse(responseData);
        // 错误响应
        if (data.detail) {
            return { error: data.detail };
        }
        if (data.error && Object.keys(data.error).length > 0) {
            return { error: errorMessage(data.error) || JSON.stringify(data.error) };
        }

        // 正常响应
        return data;
    }

    // 其他类型直接返回
    return { error: `Invalid response format: ${JSON.stringify(responseData)}` };
}

return { YTapi, resolveConfiguredTaskBackend }
}
