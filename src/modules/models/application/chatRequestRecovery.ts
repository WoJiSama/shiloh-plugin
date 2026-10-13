import type { ChatRequestData, ChatResponse, ChatFailure, RecoveryOptions } from '../../../contracts/modelGateway.js'

const TOOL_CHOICE_COMPATIBILITY_PATTERN = /thinking mode does not support this tool_choice/i
const TIMEOUT_PATTERN = /timeout|timed?\s*out|aborterror|超时|超过\s*\d+\s*秒/i
const NETWORK_PATTERN = /fetch failed|network|socket|econn(?:reset|refused)|enotfound|连接(?:失败|中断|重置)/i

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}
function errorTextFrom(value: unknown) {
  if (value instanceof Error) return value.message || value.name || "请求异常"
  if (typeof value === "string") return value
  const object = record(value)
  if (object.error instanceof Error) return object.error.message || object.error.name || "请求异常"
  if (typeof object.error === "string") return object.error
  if (record(object.error).message) return String(record(object.error).message)
  if (object.message) return String(object.message)
  return ""
}
function extractHttpStatus(text = "") {
  const match = String(text).match(/(?:请求失败|status(?:_code)?|http|error)\D{0,12}([45]\d\d)\b/i) ||
    String(text).match(/\b([45]\d\d)\b/)
  return match ? Number(match[1]) : null
}

export function classifyChatRequestFailure(response: unknown, { thrown = false } = {}): ChatFailure | null {
  if (Array.isArray(record(response).choices) && (record(response).choices as unknown[])[0]) return null

  const text = errorTextFrom(response).trim()
  if (!text) {
    return {
      kind: "empty",
      message: "回答服务没有返回有效内容",
      retryable: true,
      status: null
    }
  }

  const status = extractHttpStatus(text)
  if (TOOL_CHOICE_COMPATIBILITY_PATTERN.test(text)) {
    return { kind: "tool_choice_compatibility", message: text, retryable: true, status }
  }
  if (/余额不足|无可用资源包|insufficient[_ ](?:quota|balance|credit)|credit balance|billing|payment required|quota.{0,20}exhausted/i.test(text)) {
    return { kind: "balance", message: text, retryable: false, status: status || 429 }
  }
  if (status === 401 || status === 403 || /unauthorized|forbidden|api.?key|鉴权|密钥|权限/i.test(text)) {
    return { kind: "auth", message: text, retryable: false, status }
  }
  if (status === 429 || /rate.?limit|too many requests|限流|请求过多|额度/i.test(text)) {
    return { kind: "rate_limit", message: text, retryable: true, status: status || 429 }
  }
  if ((status && status >= 500) || /bad gateway|service unavailable|(?:servers?|service).{0,48}(?:overloaded|busy|at capacity)|overloaded|upstream|上游.*(?:失败|错误|不可用)|服务(?:当前|暂时)?繁忙|负载过高|服务过载/i.test(text)) {
    return { kind: "upstream", message: text, retryable: true, status }
  }
  if (TIMEOUT_PATTERN.test(text)) {
    return { kind: "timeout", message: text, retryable: true, status }
  }
  if (status && status >= 400) {
    return { kind: "request", message: text, retryable: false, status }
  }
  if (thrown || NETWORK_PATTERN.test(text)) {
    return { kind: "network", message: text, retryable: true, status }
  }
  return { kind: "unknown", message: text, retryable: false, status }
}

export function buildChatRequestRecovery(requestData: ChatRequestData = {}, failure: ChatFailure | null = null, { compatibilityRetried = false } = {}) {
  if (!failure?.retryable) return null
  if (failure.kind !== "tool_choice_compatibility") return { requestData, reason: failure.kind }
  if (compatibilityRetried || (typeof requestData.tool_choice !== "object" || !requestData.tool_choice.function?.name)) return null

  return {
    requestData: { ...requestData, tool_choice: "auto" as const },
    reason: failure.kind
  }
}

export async function executeChatRequestWithRecovery(sendRequest: (request: ChatRequestData) => Promise<ChatResponse>, requestData: ChatRequestData = {}, options: RecoveryOptions = {}) {
  const retryCount = Math.max(0, Number(options.retries) || 0)
  let retriesLeft = retryCount
  let currentRequest = requestData
  let compatibilityRetried = false
  let lastFailureResponse: ChatResponse | null = null

  while (true) {
    options.signal?.throwIfAborted()
    let response: ChatResponse
    let thrown = false
    try {
      response = await sendRequest(currentRequest)
    } catch (error) {
      options.signal?.throwIfAborted()
      thrown = true
      response = { error: errorTextFrom(error) || "请求异常" }
    }

    options.signal?.throwIfAborted()
    const failure = classifyChatRequestFailure(response, { thrown })
    if (!failure) return response

    lastFailureResponse = response?.error
      ? response
      : { error: failure.message, failure_kind: failure.kind, status: failure.status }
    if (retriesLeft <= 0) return lastFailureResponse

    const recovery = buildChatRequestRecovery(currentRequest, failure, { compatibilityRetried })
    if (!recovery) return lastFailureResponse

    retriesLeft--
    if (recovery.reason === "tool_choice_compatibility") compatibilityRetried = true
    options.onRetry?.({
      failure,
      reason: recovery.reason,
      retriesLeft,
      previousRequest: currentRequest,
      requestData: recovery.requestData
    })
    currentRequest = recovery.requestData
  }
}
