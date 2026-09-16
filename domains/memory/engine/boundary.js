// utils/memory/boundary.js
const TOOL_MARKERS = [
  '[tool_request]', '[tool_result]', '[tool_execution]',
  '系统反馈信息', '工具已全部执行完成', '此处为调用工具的结果',
  '调用工具:', '调用结果:', 'tool_calls', "role: 'tool'", 'role: "tool"'
]

const LOW_SIGNAL_RE = /^(哈+|哈哈+|啊+|哦+|嗯+|额+|呃+|好+|好的|收到|行吧|可以|牛+|草+|笑死|离谱|6+|ok|okay)$/i

function normalize(text) {
  return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}一-龥]+/gu, '').trim()
}

// 返回 {verdict:'drop'|'candidate', reason}
export function classifyBoundary(content) {
  const text = String(content || '').trim()
  if (!text) return { verdict: 'drop', reason: 'empty' }
  if (TOOL_MARKERS.some(m => text.includes(m))) return { verdict: 'drop', reason: 'tool/system' }
  const norm = normalize(text)
  if (norm.length < 3) return { verdict: 'drop', reason: 'too-short' }
  if (LOW_SIGNAL_RE.test(text)) return { verdict: 'drop', reason: 'low-signal' }
  return { verdict: 'candidate', reason: 'ok' }
}

export function isToolOrSystem(content) {
  return TOOL_MARKERS.some(m => String(content || '').includes(m))
}
