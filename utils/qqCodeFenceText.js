// QQ 客户端的 markdown 渲染只认行内代码 `x`，不认 ``` 围栏代码块：
// 围栏会被行内解析器拆成 `` bash、游离反引号等碎片。纯文本发送前把围栏
// 压平成逐行行内代码，让 QQ 渲染成一枚枚代码胶囊，不渲染的客户端也保持可读。
const FENCE_LINE = /^\s{0,3}(`{3,}|~{3,})(.*)$/

function wrapAsInlineCode(line) {
  const text = line.trim()
  if (!text) return ""
  // 行内本身含反引号时再包一层会破坏配对，保持原样发送
  if (text.includes("`")) return text
  return `\`${text}\``
}

export function flattenCodeFences(text = "") {
  const source = String(text || "")
  if (!source.includes("```") && !/~{3,}/.test(source)) return source

  const lines = source.split("\n")
  const output = []
  let inFence = false

  for (const line of lines) {
    const fenceMatch = FENCE_LINE.exec(line)
    if (fenceMatch) {
      if (!inFence) {
        inFence = true
        continue
      }
      // 同符号围栏闭合；行内多余内容丢弃
      inFence = false
      continue
    }
    output.push(inFence ? wrapAsInlineCode(line) : line)
  }
  // 未闭合的围栏按代码处理到底，上面循环已经压平，这里无需补课
  return output.join("\n")
}

export function containsCodeFence(text = "") {
  return /^\s{0,3}`{3,}/m.test(String(text || ""))
}
