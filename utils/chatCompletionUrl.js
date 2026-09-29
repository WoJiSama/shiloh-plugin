export function resolveChatCompletionUrl(apiUrl = "") {
  const url = String(apiUrl || "").trim().replace(/\/+$/, "")
  if (!url) return ""
  if (/\/chat\/completions$/i.test(url)) return url
  if (/\/v[0-9]+$/i.test(url)) return `${url}/chat/completions`
  return `${url}/v1/chat/completions`
}
