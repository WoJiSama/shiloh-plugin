import { safeTruncateUnicode } from "./unicodeText.js"

function compact(value = "", maxLength = 1200) {
  return safeTruncateUnicode(String(value || "")
    .replace(/\[CQ:[^\]]+\]/g, " ")
    .replace(/\s+/g, " ")
    .trim(), maxLength)
}

/**
 * Keep only the instructions and current user turn that a short follow-up
 * generation needs. Tool-call messages are intentionally omitted: sending a
 * request with an unfinished tool call is invalid for several OpenAI-compatible
 * backends, and the factual outcome is supplied separately below.
 */
export function selectAgentReplyContext(messages = []) {
  const source = Array.isArray(messages) ? messages : []
  const system = source.filter(message => message?.role === "system" && compact(message.content, 1))
  const currentUser = [...source].reverse().find(message => message?.role === "user" && compact(message.content, 1))
  return [...system, currentUser].filter(Boolean)
}

export function buildAgentProgressContext({ userContent = "", quotedContext = "", messages = [] } = {}) {
  const recent = (Array.isArray(messages) ? messages : [])
    .filter(message => message?.role !== "system" && compact(message.content, 1))
    .slice(-3)
    .map(message => compact(message.content, 420))
    .filter(Boolean)

  return [
    userContent ? `当前发言：${compact(userContent, 900)}` : "",
    quotedContext ? `引用内容：${compact(quotedContext, 620)}` : "",
    recent.length ? `最近对话：${recent.join(" | ")}` : ""
  ].filter(Boolean).join("\n")
}

export function buildToolFailureReplyInstruction({ factualReply = "", toolName = "" } = {}) {
  const fact = compact(factualReply, 500)
  return [
    "【工具结果后的自然回复】",
    "你刚才已经理解了用户的请求，但这一次没有得到可交付的工具结果。请基于当前对话和下面唯一确认的事实，写一到两句自然、直接的中文回复。",
    "不要说模型、系统、接口、API、工具、后台、服务状态或内部过程；不要假装已经查到、看到了、修改了或发送了结果；不要把问题归咎为用户没有说清楚，除非事实明确要求重新上传原文件。",
    "不要泛泛道歉、不要客服腔、不要复述规则。事实足够时，直接说明这次卡在哪，以及用户下一步能做什么；没有必要时不要追问。",
    "下一步建议必须跟「唯一确认事实」里说的一致：事实说等几分钟恢复，就不要让用户重发；事实说链接过期要重发原图，才提重发。不要自己发明「再发一遍试试」这类建议。",
    toolName ? `本轮动作类型：${compact(toolName, 60)}` : "",
    fact ? `唯一确认事实：${fact}` : "唯一确认事实：本轮没有可用结果，不能凭历史或猜测补答。"
  ].filter(Boolean).join("\n")
}
