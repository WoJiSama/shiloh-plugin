const DEFAULT_REPLACEMENT = "�"

export function sanitizeUnicodeText(value: unknown = "", replacement = DEFAULT_REPLACEMENT) {
  const text = String(value ?? "")
  let output = ""

  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xDC00 && next <= 0xDFFF) {
        output += text.charAt(index) + text.charAt(index + 1)
        index++
      } else {
        output += replacement
      }
      continue
    }
    if (code >= 0xDC00 && code <= 0xDFFF) {
      output += replacement
      continue
    }
    output += text[index]
  }

  return output
}

export function safeTruncateUnicode(value: unknown = "", maxCodePoints = Infinity, suffix = "") {
  const text = sanitizeUnicodeText(value)
  const limit = Number(maxCodePoints)
  if (!Number.isFinite(limit)) return text
  const bounded = Math.max(0, Math.floor(limit))
  const codePoints = Array.from(text)
  if (codePoints.length <= bounded) return text
  return codePoints.slice(0, bounded).join("") + sanitizeUnicodeText(suffix)
}

export function splitUnicodeText(value: unknown = "", chunkSize = 1000) {
  const size = Math.max(1, Math.floor(Number(chunkSize) || 1))
  const codePoints = Array.from(sanitizeUnicodeText(value))
  const chunks = []
  for (let index = 0; index < codePoints.length; index += size) {
    chunks.push(codePoints.slice(index, index + size).join(""))
  }
  return chunks
}

export function sanitizeJsonValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return sanitizeUnicodeText(value)
  if (!value || typeof value !== "object") return value
  if (seen.has(value)) return null

  seen.add(value)
  if (Array.isArray(value)) {
    const output = value.map(item => sanitizeJsonValue(item, seen))
    seen.delete(value)
    return output
  }
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    output[sanitizeUnicodeText(key)] = sanitizeJsonValue(item, seen)
  }
  seen.delete(value)
  return output
}

export function sanitizeMessagesForJson(messages: unknown = []): unknown[] {
  return Array.isArray(messages)
    ? messages.map(message => sanitizeJsonValue(message))
    : []
}
