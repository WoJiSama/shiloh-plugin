// 模型请求薄网关:主回复的多后端执行、分层 reasoning effort、不支持的参数自动降级
// 都已在 utils/apiClient.js(YTapi),失败分类与重试在 utils/chatRequestRecovery.js。
// 这里只收 apps/test.js 剩下的纯胶水——模型名解析、请求体拼装、带超时的 fetch——
// 使请求形状可单测,并把模型调用细节从主链路类里拿走。函数体原样迁出,语义不变。
import { SEMANTIC_TOOL_INTENT_TIMEOUT_MS } from "../core/intent/messageIntent.js"

// 原 getProvider/getModel:providers 目前只有 oneapi 一档,非 oneapi 时模型名为 undefined(保持原语义)
export function resolveChatModel(config = {}) {
  const provider = String(config?.providers || "").toLowerCase()
  const models = { oneapi: config?.chatAiConfig?.chatApiModel }
  return models[provider]
}

export function buildChatRequestData(config = {}, messages, tools, toolChoice = "auto") {
  const data = {
    model: resolveChatModel(config),
    messages,
    temperature: 0.7,
    top_p: 0.9
  }

  if (config?.useTools && tools?.length && toolChoice !== "none") {
    data.tools = tools
    data.tool_choice = toolChoice
  }
  return data
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = SEMANTIC_TOOL_INTENT_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...options, signal: controller.signal })
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`请求超过 ${Math.round(timeoutMs / 1000)} 秒没有返回`)
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}
