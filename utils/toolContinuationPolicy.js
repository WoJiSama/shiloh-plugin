const DIRECT_RESULT_TOOLS = new Set(["excelWorkbookTool", "forgetGroupKnowledgeTool", "memberInfoTool"])

function parseMaybeJson(text = "") {
  try {
    return JSON.parse(String(text))
  } catch {
    return null
  }
}

/**
 * 直发结果的呈现格式化：memberInfoTool 返回结构化 JSON，直接原文发群很难看，
 * 在不经过润色模型的前提下整理成几行事实。
 */
export function formatDirectToolResult(toolName = "", serialized = "") {
  const text = String(serialized || "")
  if (toolName === "memberInfoTool") {
    const parsed = parseMaybeJson(text)
    const data = parsed?.success && parsed?.data ? parsed.data : null
    if (data) {
      return [
        `QQ ${data.user_id}`,
        data.card && data.card !== "无群名片" ? `群名片 ${data.card}` : `昵称 ${data.nickname}`,
        `身份 ${data.role} · 头衔 ${data.title} · 等级 ${data.level}`,
        `入群 ${data.join_time} · 最后发言 ${data.last_sent_time}`,
        `禁言 ${data.shut_up_timestamp} · 性别 ${data.sex} · 年龄 ${data.age} · 地区 ${data.area}`
      ].join("\n")
    }
  }
  return text.replace(/^error:\s*/i, "")
}

export function decideToolContinuation(validResults = [], options = {}) {
  const toolNames = validResults.map(result => String(result?.toolName || "")).filter(Boolean)
  // 已知事实类结果直接回复、不经润色模型；但失败结果不能直发原文，交给后续失败路径
  const allSucceeded = validResults.every(result => !/^error:/i.test(String(result?.result || "")))
  if (toolNames.length && allSucceeded && toolNames.every(toolName => DIRECT_RESULT_TOOLS.has(toolName))) {
    return "direct_result"
  }
  if (options.syntheticToolCall === true) return "chat_only"
  return "tool_loop"
}
