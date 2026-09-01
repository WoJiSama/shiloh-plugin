function toErrorText(error = "") {
  if (error instanceof Error) return error.message || error.name || ""
  if (typeof error === "string") return error
  if (error?.error instanceof Error) return error.error.message || error.error.name || ""
  if (typeof error?.error === "string") return error.error
  if (error?.error?.message) return String(error.error.message)
  if (error?.message) return String(error.message)
  try {
    return JSON.stringify(error || "")
  } catch {
    return String(error || "")
  }
}

function redactSensitiveFailureText(text = "") {
  return String(text || "")
    .replace(/Bearer\s+\S+/gi, "Bearer [已隐藏]")
    .replace(/\b(?:sk|rk|pk|key)-[A-Za-z0-9_-]{8,}\b/gi, "[已隐藏]")
    .replace(/([?&](?:api[_-]?key|token|authorization|signature|sign|rkey|x-signature)=)[^&\s]*/gi, "$1[已隐藏]")
    .replace(/magnet:\?[^\s]+/gi, "磁链")
    .replace(/https?:\/\/[^\s?#]+(?:\?[^\s]*)?/gi, value => value.replace(/\?.*$/, ""))
    .replace(/(?:\/opt\/|\/Users\/|[A-Za-z]:\\)[^\s'"`]+/g, "[内部路径]")
    .replace(/\s+/g, " ")
    .trim()
}

function extractStatus(text = "") {
  const match = String(text).match(/\b([45]\d\d)\b/)
  return match ? Number(match[1]) : null
}

function extractMessage(text = "") {
  const jsonMessage = String(text).match(/"message"\s*:\s*"([^"\\]*(?:\\.[^"\\]*)*)"/i)?.[1]
  const suffix = String(text).match(/(?:\s[-:：]\s*)([^{}]+)$/)?.[1]
  return redactSensitiveFailureText(jsonMessage || suffix || text)
    .replace(/^(?:OpenAI |API |oneapi )?(?:API )?请求失败[:：]?/i, "")
    .replace(/^(?:error|message)\s*[:：]?\s*/i, "")
    .replace(/[{}"\\]+/g, "")
    .trim()
    .slice(0, 180)
}

function isUpstreamOverloaded(text = "") {
  return /(?:our |the )?(?:servers?|service|upstream).{0,48}(?:currently |temporarily )?(?:overloaded|busy|at capacity)|(?:overloaded|server busy|capacity exceeded)|服务(?:当前|暂时)?繁忙|负载过高|服务过载/i.test(text)
}

export function buildVisibleFailureDetail(error = "", { fallback = "执行没有返回可用结果" } = {}) {
  const raw = redactSensitiveFailureText(toErrorText(error))
  if (!raw) return fallback
  const status = extractStatus(raw)
  const message = extractMessage(raw)

  if (status === 401 && /invalid token|unauthorized|鉴权|token|api.?key|密钥/i.test(raw)) {
    return "401 Unauthorized（invalid token：当前渠道的授权无效或已失效）"
  }
  if (status === 403) return `403 Forbidden${message ? `（${message}）` : ""}`
  if (status === 404) return `404 Not Found${message ? `（${message}）` : ""}`
  if (status === 429) return `429 Too Many Requests${message ? `（${message}）` : ""}`
  if (isUpstreamOverloaded(raw)) {
    return status && status >= 500
      ? `${status} 上游服务当前负载过高，请稍后重试`
      : "上游服务当前负载过高，请稍后重试"
  }
  if (status && status >= 500) return `${status} 上游服务异常${message ? `（${message}）` : ""}`
  if (status) return `${status} 请求失败${message ? `（${message}）` : ""}`
  if (/timeout|timed?\s*out|aborterror|超时/i.test(raw)) return "请求超时"
  if (/fetch failed|network|econn|enotfound|socket|连接(?:失败|中断|重置)/i.test(raw)) return "网络连接失败"
  return message || fallback
}

export function appendVisibleFailureDetail(message = "", error = "") {
  if (!toErrorText(error).trim()) return String(message || "")
  return `${String(message || "").trim()} 原因：${buildVisibleFailureDetail(error)}`
}
