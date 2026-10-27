/**
 * 模型传参容错（qq-bridge 实测教训）：模型经常把字符串/数组序列化成 JSON 字符串再传。
 * `"\"你好\""` → `你好`；`"[\"a\",\"b\"]"` → ["a","b"]。
 */
export function unquoteJsonString(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      const parsed = JSON.parse(text)
      if (typeof parsed === 'string') return parsed
    } catch { /* 不是合法 JSON 字符串字面量，按原样处理 */ }
  }
  return value
}

/** 宽容地把 unknown 归一成 string[]：单字符串、JSON 数组字符串、真数组都接受；全不合法返回 null。 */
export function coerceStringArray(value: unknown, opts: { maxLength: number; itemMaxChars: number }): string[] | null {
  let candidate: unknown = unquoteJsonString(value)
  if (typeof candidate === 'string') {
    const text = candidate.trim()
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text)
        if (Array.isArray(parsed)) candidate = parsed
      } catch { /* 保留原字符串 */ }
    }
  }
  const list = Array.isArray(candidate)
    ? candidate
    : typeof candidate === 'string' && candidate.trim()
      ? [candidate]
      : null
  if (!list) return null
  const cleaned = list
    .map(item => String(unquoteJsonString(item) ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(0, opts.maxLength)
    .map(item => item.slice(0, opts.itemMaxChars))
  return cleaned.length ? cleaned : null
}

/**
 * 工具参数形状识别：唯一权威实现在主链路出站清洗器（replySanitizer），
 * 这里再导出供仿真发送工具复用——同一套词表，两条出站路径共用一个判定。
 */
export { looksLikeToolArguments } from '../../conversation/domain/replySanitizer.js'
