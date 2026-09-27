// 回复文本策略:卡面确认语、教学型解释识别、长提示压缩等纯函数。
// 从 apps/test.js 原样迁出(P2),行为不变。
import { safeTruncateUnicode } from "../../utils/unicodeText.js"

export function cardAcknowledgement(presentation = "") {
  if (presentation === "narrative") return "好，我先写，正文整理成一张完整卡片发你。"
  if (presentation === "knowledge") return "好，我整理成一张完整卡片发你。"
  if (presentation === "document") return "好，我整理成一张完整卡片发你。"
  return ""
}

export function looksLikeEducationalExplanation(text = "") {
  const content = String(text || "").trim()
  if (content.length < 120) return false
  let score = 0
  if (/(公式|定义|原理|推导|证明|结论|本质|可以理解为|简单说|例如|比如|常见|注意|适用于)/.test(content)) score++
  if (/(导数|微积分|极限|积分|函数|定理|物理|化学|生物|历史|地理|天文|宇宙|经济|哲学|语法|算法|机器学习)/.test(content)) score++
  if (/(?:^|\n)\s*(?:[-*+•]|\d+\.)\s+\S/.test(content)) score++
  if (/[a-zA-Z]\s*(?:\^|=|≈|≤|≥|<|>)|lim|sin|cos|tan|ln|log|∞|π|√|∑|∫/.test(content)) score++
  return score >= 2
}

export function looksLikeDiagnosticExplanation(text = "") {
  const content = String(text || "").trim()
  if (content.length < 120) return false
  let score = 0
  if (/(原因|主要是|问题在|因为|所以|报错|红了|红线|红一片|找不到|缺少|依赖|版本|配置|环境|解决|检查|确认|不用太慌|不是什么大问题)/i.test(content)) score++
  if (/(IDEA|IntelliJ|Maven|Gradle|pom\.xml|Tomcat|Servlet|jakarta\.|javax\.|Spring|WebServlet|import|class|package|dependency|Cannot|Error|Exception)/i.test(content)) score++
  if (/(?:^|\n)\s*(?:[-*+•]|\d+\.)\s+\S/.test(content)) score++
  if (/[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+|<[^>\n]+>|@[A-Za-z_$][\w$]*/.test(content)) score++
  return score >= 2
}

export function compactDrawPromptText(text = "", maxLength = 3800) {
  return safeTruncateUnicode(String(text || "")
    .replace(/\[CQ:[^\]]+\]/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim(), maxLength)
}

// 判断回复是否含代码/markdown 结构(用于决定转卡面渲染)。除了围栏/标题/表格,
// 还认中文说明里常见的行内标记:成对 **加粗**、反引号、`-` 列表——QQ 纯文本
// 会把它们原样带星号发出去,必须进卡面。
export function looksLikeCodeOrMarkdown(text = "") {
  const content = String(text || "")
  if (/```[\s\S]*```/.test(content)) return true
  if (/^\s{0,3}#{1,4}\s+\S/m.test(content) && content.split(/\r?\n/).length >= 3) return true
  if (/^\s*\|.+\|\s*$/m.test(content) && /^\s*\|[-:\s|]+\|\s*$/m.test(content)) return true

  const lines = content.split(/\r?\n/)
  const nonEmptyLines = lines.filter(line => line.trim())
  if (nonEmptyLines.length < 3) return false

  const boldCount = (content.match(/\*\*[^*\n]+\*\*/g) || []).length
  const inlineCodeCount = (content.match(/`[^`\n]+`/g) || []).length
  const bulletLines = nonEmptyLines.filter(line => /^\s*[-*+]\s+\S/.test(line)).length
  if ((boldCount >= 2 || inlineCodeCount >= 2 || bulletLines >= 3) && nonEmptyLines.length >= 3) return true

  const codeLineCount = nonEmptyLines.filter(line =>
    /^\s*(def|class|for|if|elif|else|while|return|import|from|print|break|continue|const|let|var|function|class|export|switch|try|catch|public|private|static|package|func|fn)\b/.test(line) ||
    /^\s{2,}\S/.test(line) ||
    /[A-Za-z_$][\w$.\[\]]*\s*(?:=|==|===|>|<|\+|-|\*|\/)/.test(line) ||
    /[{}]/.test(line)
  ).length

  return codeLineCount >= 2
}

// 检测树形结构文本(├── │ └── 字符),模型输出流程图/层级关系时常见
export function looksLikeTreeStructure(text = "") {
  const lines = String(text || "").split(/\n/).filter(line => line.trim())
  if (lines.length < 3) return false
  const treeLines = lines.filter(line => /[│├└][─━┄┈]/.test(line) || /^[\s]*[├└][─━]/.test(line))
  return treeLines.length >= 3 && treeLines.length >= lines.length * 0.5
}

// 把树形字符结构转为 markdown 嵌套列表(markmap/导图工具可渲染)
export function treeToMarkdown(text = "") {
  const lines = String(text || "").split(/\n/).filter(line => line.trim())
  const result = []
  for (const line of lines) {
    const trimmed = line.trim()
    // 计算缩进深度(每个 │ 或空格组算一层)
    const indentMatch = line.match(/^([\s│├└─]+)/)
    const rawIndent = indentMatch ? indentMatch[1] : ""
    // 深度 = 缩进字符中的 ├──/└── 分支数 + 层级
    const branches = (rawIndent.match(/[├└]/g) || []).length
    const depth = Math.max(0, branches)
    // 提取内容(去掉树形字符)
    const content = trimmed.replace(/^[│├└─━\s]+/, "").trim()
    if (!content) continue
    result.push(`${"  ".repeat(depth)}- ${content}`)
  }
  return result.join("\n")
}
