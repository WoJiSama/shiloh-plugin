// 回复文本策略:卡面确认语、教学型解释识别、长提示压缩等纯函数。
// 从 apps/test.js 原样迁出(P2),行为不变。

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
