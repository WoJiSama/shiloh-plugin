export function classifyImageFailure(error = "") {
  const text = typeof error === "string" ? error : JSON.stringify(error || "")
  if (!text.trim()) return "unknown"
  if (/\b400\b.*invalid request format|invalid request format|invalid_request_error|unsupported model|unknown model|model.{0,24}(?:not found|not available|does not exist)/i.test(text)) return "request_contract"
  if (/\b503\b|no\s+available\s+channel|(?:service|channel|provider|distributor)\s+(?:is\s+)?unavailable|unavailable\s+(?:service|channel|provider|distributor)|bad_response_status_code|openai_error|provider.?error|图片编辑服务错误|没有可用(?:通道|渠道)|服务(?:暂时)?不可用/i.test(text)) return "provider_error"
  if (/safety|sensitive|policy|content.?filter|risk|blocked|敏感|审核|安全|违规|不合规|拦截/i.test(text)) return "safety"
  if (/multipart|NextPart:\s*EOF|unexpected\s*EOF/i.test(text)) return "multipart"
  if (/超时|timeout|timed?\s*out|AbortError|超过\s*\d+\s*秒|没有返回|ETIMEDOUT|fetch failed/i.test(text)) return "timeout"
  if (/未接收到有效图片|未接收到有效图像|no\s*(valid\s*)?image|empty|invalid image response|没有拿到.*图/i.test(text)) return "empty_image"
  if (/429|rate.?limit|quota|too many requests|insufficient|余额|限流|频率/i.test(text)) return "rate_limit"
  if (/401|403|unauthorized|forbidden|permission|invalid.?key|api.?key|token|鉴权|权限|密钥/i.test(text)) return "auth"
  if (/发送|send|reply|segment|download|链接已过期|无效的图片|无效的图片下载链接|图片下载/i.test(text)) return "send"
  return "unknown"
}

export function inferImageFailureOperation(error = "", fallback = "edit") {
  const text = typeof error === "string" ? error : JSON.stringify(error || "")
  if (/所有文生图模型|文生图|图片生成(?:失败|通道|服务)|image[ _-]?generation/i.test(text)) return "generate"
  if (/所有图片编辑通道|图片编辑(?:失败|通道|服务)|图像编辑|image[ _-]?edit/i.test(text)) return "edit"
  return fallback === "generate" ? "generate" : "edit"
}

export function buildImageFailureReply(error = "", { operation = "edit" } = {}) {
  const text = typeof error === "string" ? error : JSON.stringify(error || "")
  const unavailableRequested = text.match(/未找到可用于(文生图|图片编辑)的指定图片渠道[“"]([^”"]+)[”"]/)
  if (unavailableRequested) {
    return `当前没有可用于${unavailableRequested[1]}的“${unavailableRequested[2]}”渠道，我没有改用其他渠道。`
  }
  const ambiguousRequested = text.match(/指定的图片模型[“"]([^”"]+)[”"]同时匹配多个渠道（([^）]+)）/)
  if (ambiguousRequested) {
    return `“${ambiguousRequested[1]}”同时对应多个图片渠道（${ambiguousRequested[2]}），你说一下具体渠道名，我不会替你随便选。`
  }
  const effectiveOperation = inferImageFailureOperation(error, operation)
  const kind = classifyImageFailure(error)
  if (kind === "safety") return appendVisibleFailureDetail("这次图片服务没有接受这段描述。我没有改你的原话；如果要继续，需要你自己决定是否调整后再发。", text)
  if (kind === "multipart") return appendVisibleFailureDetail("刚刚传图时中断了，不是图片改坏了。你再发一次，我重新处理。", text)
  if (kind === "timeout") return effectiveOperation === "edit"
    ? appendVisibleFailureDetail("图还没能顺利拿回来，网络请求超时了。你再发一次，我重新处理并直接发出来。", text)
    : appendVisibleFailureDetail("这次生成超时了，我重新来会更稳。", text)
  if (kind === "empty_image") return appendVisibleFailureDetail("这次图片服务没有返回成图，不代表你的描述有问题。我没有改你的原话。", text)
  if (kind === "rate_limit") return appendVisibleFailureDetail("图片服务现在请求太多或额度受限，稍后再试会更稳。", text)
  if (kind === "auth") return appendVisibleFailureDetail("图片服务的鉴权配置有问题，这不是你描述方式导致的。", text)
  if (kind === "send") return appendVisibleFailureDetail("图片已经处理到发送阶段，但没有成功送到群里。我重新发送一次。", text)
  if (kind === "request_contract") return effectiveOperation === "edit"
    ? appendVisibleFailureDetail("这条图片编辑渠道当前没有接通，不是你的描述有问题；原样重试也不会解决。", text)
    : appendVisibleFailureDetail("这条图片生成渠道当前没有接通，不是你的描述有问题；原样重试也不会解决。", text)
  if (kind === "provider_error") return effectiveOperation === "edit"
    ? appendVisibleFailureDetail("图片编辑通道现在不可用，不是你的描述有问题。我没有改你的原话。", text)
    : appendVisibleFailureDetail("图片生成通道现在不可用，不是你的描述有问题。我没有改你的原话。", text)
  return effectiveOperation === "edit"
    ? appendVisibleFailureDetail("这次图片编辑没有完成，不代表你的描述有问题；可以稍后按原图和原话再试。", text)
    : appendVisibleFailureDetail("这次图片生成没有完成，不代表你的描述有问题；可以稍后按原话再试。", text)
}
import { appendVisibleFailureDetail } from "./visibleFailure.js"
