import { dependencies } from "../dependence/dependencies.js";
import { removeToolPromptsFromMessages } from "../utils/textUtils.js"
import { sanitizeJsonValue, sanitizeMessagesForJson } from "./unicodeText.js"
import { resolveChatCompletionUrl } from "./chatCompletionUrl.js"
import { resolveAgentBackend, shouldAcceptPlannerTextResponse, summarizeToolResultForAgent } from "./agentIntelligence.js"
const { _path, fetch, fs, path } = dependencies;
/**
 * 发送请求到 OpenAI API 或其他提供者并处理响应
 * @param {Object} requestData - 请求体数据
 * @param {Object} config - 配置对象
 * @returns {Object|null} - 返回处理后的响应数据或错误信息
 */
export async function YTapi(requestData, config, toolContent, toolName, options = {}) {
    const provider = config.providers?.toLowerCase();

    try {
        let url, headers, finalRequestData, selectedTextBackend = null;

        const requestHasTools = Array.isArray(requestData?.tools) &&
            requestData.tools.length > 0 &&
            requestData.tool_choice !== "none";

        if (config.useTools && requestHasTools) {
            // useTools 开启，先调用 OpenAI API
            const openaiUrl = resolveChatCompletionUrl(config.toolsAiConfig.toolsAiUrl);
            // 确保使用OpenAiModel的模型
            if (!config.toolsAiConfig.toolsAiApikey) return { error: "OpenAI Token 未配置" };

            const openaiHeaders = {
                'Authorization': `Bearer ${config.toolsAiConfig.toolsAiApikey}`,
                'Content-Type': 'application/json'
            };

            let openaiResponse;
            try {
                // 使用config.OpenAiModel替换请求中的模型
                const openaiRequestData = sanitizeJsonValue(normalizeToolChoiceForToolsProvider({
                    ...requestData,
                    model: config.toolsAiConfig.toolsAiModel,
                    stream: false
                }, openaiUrl));
                // logger.error(config.toolsAiConfig.toolsAiApikey, config.toolsAiConfig.toolsAiModel, JSON.stringify(openaiRequestData))
                // logger.error('已触发全局AI对话', config.toolsAiConfig.toolsAiApikey, config.toolsAiConfig.toolsAiModel)
                openaiResponse = await fetch(openaiUrl, {
                    method: 'POST',
                    headers: openaiHeaders,
                    body: JSON.stringify(openaiRequestData)
                });

                if (!openaiResponse.ok) {
                    const errorText = await openaiResponse.text().catch(() => '无法读取错误内容');
                    const failure = `OpenAI API 请求失败：${openaiResponse.status} ${openaiResponse.statusText} - ${errorText}`;
                    logger.error(failure);
                    return await fallbackFromToolsBackend(requestData, config, toolContent, toolName, options, failure);
                }
            } catch (openaiFetchError) {
                const failure = `OpenAI API 请求失败：${openaiFetchError.message}`;
                logger.error("OpenAI API 请求失败:", openaiFetchError);
                return await fallbackFromToolsBackend(requestData, config, toolContent, toolName, options, failure);
            }

            let openaiData;
            try {
                openaiData = await openaiResponse.json();
                logger.error('OpenAI 响应:', JSON.stringify(openaiData, null, 2));
            } catch (openaiJsonError) {
                console.error("解析 OpenAI 响应 JSON 失败:", openaiJsonError);
                return { error: `解析 OpenAI 响应 JSON 失败：${openaiJsonError.message}` };
            }

            // 检查是否包含 tool_calls，无论 finish_reason 是什么
            const hasToolCalls = openaiData?.choices?.[0]?.message?.tool_calls?.length > 0;
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

            // 处理消息，过滤并转换 tool_calls 相关内容
            const processedMessages = requestData.messages
                .map(msg => {
                    if (msg.role === 'assistant' && msg.tool_calls?.length) {
                        //return null; // 跳过含 tool_calls 的 assistant 消息
                        const prefix = `你需要使用 ${toolName} 来处理用户的需求\n`;
                        return {
                            role: 'assistant',
                            content: '[系统反馈信息]: ' + prefix + msg.tool_calls[0].function.arguments
                        };
                    } else if (msg.role === 'tool') {
                        const prefix = `使用 ${toolName} 处理完成了，这是调用的结果：\n`;
                        return {
                            role: 'user',
                            content: '[系统反馈信息]: ' + prefix + msg.content
                        };
                    }
                    return msg;
                })
                .filter(Boolean);

            finalRequestData = {
                model: selectedTextBackend.model,
                messages: convertToolMessagesForChat(requestData.messages, toolName),
                stream: false
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
                logger.info(`[Agent路由] 复杂请求升档到 ${backend.model} score=${backend.complexity.score} signals=${backend.complexity.signals.join(',')}`);
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
        finalRequestData.messages = sanitizeMessagesForJson(moveFinalToolPromptToEnd(
            removeToolPromptsFromMessages(finalRequestData.messages || requestData.messages)
        ))
        finalRequestData = sanitizeJsonValue(finalRequestData)
        console.log('最终请求体:', finalRequestData);
        try {
            const sendRequest = () => fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(finalRequestData)
            });
            response = await sendRequest();

            if (!response.ok) {
                let errorText = await response.text().catch(() => '无法读取错误内容');
                const optionalFields = ["temperature", "top_p", "max_tokens", "max_completion_tokens", "reasoning_effort", "response_format"]
                    .filter(field => Object.hasOwn(finalRequestData, field))
                const mayRetryWithoutOptions = response.status === 400 && optionalFields.length > 0 &&
                    /(?:unsupported|unknown|unrecognized|not support|invalid parameter|max_tokens|max_completion_tokens|reasoning_effort|temperature|response_format)/i.test(errorText)
                if (mayRetryWithoutOptions) {
                    logger.warn(`[API兼容] 可选生成参数不受支持，移除后在同一后端重试 fields=${optionalFields.join(',')}`)
                    for (const field of optionalFields) delete finalRequestData[field]
                    response = await sendRequest()
                    if (response.ok) return processResponse(await response.json())
                    errorText = await response.text().catch(() => '无法读取错误内容')
                }
                const failure = `API 请求失败：${response.status} ${response.statusText} - ${errorText}`;
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
            const failure = `${provider || 'API'} 请求失败：${fetchError.message}`;
            console.error(`${provider || 'API'} 请求失败:`, fetchError);
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
            console.log(`${provider || 'API'} 响应:`, JSON.stringify(responseData, null, 2));
        } catch (jsonError) {
            console.error(`解析 ${provider || 'API'} 响应 JSON 失败:`, jsonError);
            return { error: `解析 ${provider || 'API'} 响应 JSON 失败：${jsonError.message}` };
        }
        return processResponse(responseData);

    } catch (error) {
        console.error('YTapi 异常:', error);
        return { error: `发生异常：${error.message}` };
    }
}

function canFallbackFromToolsBackend(requestData = {}) {
    const toolChoice = requestData?.tool_choice;
    // A forced tool is an execution contract. Falling back to text would make
    // the bot look as though the tool had been executed when it was not.
    if (toolChoice === "required" || toolChoice?.function?.name) return false;
    return true;
}

async function fallbackFromToolsBackend(requestData, config, toolContent, toolName, options, failure) {
    if (!canFallbackFromToolsBackend(requestData)) return { error: failure };

    const candidates = resolveToolsBackendFallbacks(config);
    let lastFailure = { error: failure };
    for (const candidate of candidates) {
        logger.warn(`[Agent路由] 工具模型不可用，当前请求不强制工具调用，降级到 ${candidate.label}: ${failure}`);
        const response = await YTapi(requestData, {
            ...config,
            useTools: false,
            chatAiConfig: candidate
        }, toolContent, toolName, {
            ...options,
            forceChatBackend: true,
            toolsBackendFallback: true,
            textBackendFallback: true
        });
        if (response?.choices?.[0]?.message?.content) return response;
        lastFailure = response?.error ? response : lastFailure;
    }
    return lastFailure;
}

function hasSameBackend(left = {}, right = {}) {
    return String(left?.apiUrl || left?.chatApiUrl || "").replace(/\/+$/, "") === String(right?.apiUrl || right?.chatApiUrl || "").replace(/\/+$/, "") &&
        String(left?.model || left?.chatApiModel || "") === String(right?.model || right?.chatApiModel || "");
}

async function fallbackFromTextBackend(requestData, config, toolContent, toolName, options, failure, selectedBackend) {
    if (options.textBackendFallback || options.taskBackend) return null;

    let lastFailure = null;
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

function resolveConfiguredChatBackend(config = {}) {
    const chat = config?.chatAiConfig || {}
    return {
        apiUrl: chat.chatApiUrl,
        model: chat.chatApiModel,
        apiKey: chat.chatApiKey,
        label: "chat",
        reasoningEffort: chat.chatReasoningEffort || ""
    }
}

function resolveToolsBackendFallbacks(config = {}) {
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

function resolveConfiguredTaskBackend(config = {}, taskName = "") {
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
    return { ...resolveConfiguredChatBackend(config), label: `task:${taskName}:chat-fallback` }
}

function buildGenerationOptions(requestData = {}, options = {}, backend = {}) {
    const generation = options.generation || {}
    const output = {}
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

function getChatApiKey(chatApiKey) {
    if (Array.isArray(chatApiKey)) {
        const keys = chatApiKey.filter(key => typeof key === 'string' && key.trim())
        return keys[Math.floor(Math.random() * keys.length)]
    }
    return chatApiKey
}

function normalizeToolChoiceForToolsProvider(requestData, apiUrl) {
    const toolChoice = requestData?.tool_choice;
    const functionName = toolChoice?.function?.name;

    if (!functionName || !/souimagery\.fun/i.test(String(apiUrl || ""))) {
        return requestData;
    }

    return {
        ...requestData,
        tool_choice: {
            type: toolChoice.type || "function",
            name: functionName
        }
    };
}

/**
 * 处理 API 响应数据
 * @param {Object|Array} responseData - API 响应数据
 * @returns {Object} - 处理后的响应数据
 */
function convertToolMessagesForChat(messages = [], fallbackToolName = 'tool') {
    const converted = [];

    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];

        if (msg.role === 'assistant' && msg.tool_calls?.length) {
            const requests = msg.tool_calls.map((toolCall, index) => {
                const name = toolCall.function?.name || fallbackToolName || 'tool';
                return `${index + 1}. ${name}`;
            });

            const results = [];
            while (messages[i + 1]?.role === 'tool') {
                i++;
                const toolMsg = messages[i];
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

function moveFinalToolPromptToEnd(messages = []) {
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
        ? [...normalMessages, finalPrompts[finalPrompts.length - 1]]
        : normalMessages;
}

function summarizeToolResultForChat(toolName, content = '') {
    const text = summarizeToolResultForAgent(toolName, content);
    return `content: ${text}`;
}
function processResponse(responseData) {
    // 处理数组响应（兼容某些 API 返回数组的情况）
    if (Array.isArray(responseData) && responseData.length > 0) {
        return processResponse(responseData[0]);
    }

    // 处理对象响应
    if (typeof responseData === 'object' && responseData !== null) {
        // 错误响应
        if (responseData.detail) {
            return { error: responseData.detail };
        }
        if (responseData.error && Object.keys(responseData.error).length > 0) {
            return { error: responseData.error.message || JSON.stringify(responseData.error) };
        }

        // 正常响应
        return responseData;
    }

    // 其他类型直接返回
    return { error: `Invalid response format: ${JSON.stringify(responseData)}` };
}
