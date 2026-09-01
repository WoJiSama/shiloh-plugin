// Only strip transport/tool protocol fragments. A normal explanation may
// legitimately discuss an API, server, timeout, or configuration; treating
// those words themselves as leaks turns useful Agent replies into templates.
const RAW_INTERNAL_MARKER_RE = /(?:bananaTool|googleImageAnalysisTool|googleImageEditTool|textImageTool|sendLocalEmojiTool|souimagery|gpt-image|tool_call|function_call|\[tool(?:_code)?\]|<tool(?:_code)?>|Bad gateway|\bHTTP\s*[45]\d\d\b|\bECONN(?:RESET|REFUSED)\b|\bETIMEDOUT\b)/i
const INTERNAL_EXECUTION_NARRATION_RE = /(?:调用工具|工具调用|函数调用|内部执行|上游返回|接口返回|模型报错|模型错误|请求体|响应体|重试第?\d+次)/i

export function containsInternalStatusLeak(text = "") {
  const content = String(text || "")
  if (!content.trim()) return false
  return RAW_INTERNAL_MARKER_RE.test(content) || INTERNAL_EXECUTION_NARRATION_RE.test(content)
}
