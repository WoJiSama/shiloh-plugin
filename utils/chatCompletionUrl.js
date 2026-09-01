export function resolveChatCompletionUrl(apiUrl = "") {
  const url = String(apiUrl || "").trim().replace(/\/+$/, "")
  if (!url) return ""
  if (/\/chat\/completions$/i.test(url)) return url
  if (/\/v1$/i.test(url)) return `${url}/chat/completions`
  return `${url}/v1/chat/completions`
}
