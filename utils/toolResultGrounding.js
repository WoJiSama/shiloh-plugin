const ERROR_PATTERN = /^(?:error|错误|失败)[:：]|"error"\s*:|(?:请求|查询|分析|下载|解析|发送).{0,16}(?:失败|错误|异常|超时)|链接已过期|无效的.+链接|未检测到有效/i
const NOT_FOUND_PATTERN = /(?:未找到|没有找到|没找到|未查到|没有查到|没查到|未命中|无匹配|没有匹配|没有相关结果|未找到相关结果|匹配数量\s*[:：]\s*0|结果数量\s*[:：]\s*0)/i

function parseJson(text = "") {
  try { return JSON.parse(text) } catch { return undefined }
}
function hasMeaningfulValue(value) {
  if (value === undefined || value === null) return false
  if (typeof value === "string") return value.trim().length > 0
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value === "boolean") return false
  if (Array.isArray(value)) return value.some(hasMeaningfulValue)
  if (typeof value === "object") {
    return Object.entries(value).some(([key, nested]) => {
      if (["success", "ok", "status", "code"].includes(String(key).toLowerCase())) return false
      return hasMeaningfulValue(nested)
    })
  }
  return false
}

export function classifyToolResult(result) {
  const text = typeof result === "string" ? result.trim() : JSON.stringify(result ?? "").trim()
  if (!text) return { kind: "empty", text: "" }
  const parsed = parseJson(text)
  if (parsed?.kind === "tool_outcome") {
    const status = String(parsed.status || "").toLowerCase()
    if (["error", "failed", "timeout"].includes(status)) return { kind: "error", text, parsed }
    if (["not_found", "missing"].includes(status)) return { kind: "not_found", text, parsed }
    if (["empty", "unavailable"].includes(status)) return { kind: "empty", text, parsed }
    if (status === "success") return { kind: "success", text, parsed }
  }
  if (ERROR_PATTERN.test(text)) return { kind: "error", text, parsed }
  if (NOT_FOUND_PATTERN.test(text)) return { kind: "not_found", text }
  if (parsed !== undefined && !hasMeaningfulValue(parsed)) return { kind: "empty", text, parsed }
  return { kind: "success", text, parsed }
}

export function buildToolGroundingInstruction(results = []) {
  const statuses = results.map(result => ({
    toolName: String(result?.toolName || "tool"),
    kind: classifyToolResult(result?.result).kind
  }))
  return [
    "【本轮工具结果事实边界】",
    "最终回复只能陈述本轮工具结果中明确出现的事实。聊天历史、旧回复、记忆和常识只能帮助理解指代，绝不能用来填补本轮工具的空白。",
    "如果某项结果是 empty、not_found 或 error，必须明确说本轮没有拿到/没有找到，禁止回忆旧答案、猜测数值、补全名称或假装查到了。",
    `本轮状态: ${statuses.map(item => `${item.toolName}=${item.kind}`).join("；")}`
  ].join("\n")
}

export function buildUnavailableToolReply(results = []) {
  const classified = results.map(result => ({ toolName: String(result?.toolName || ""), state: classifyToolResult(result?.result) }))
  const kinds = classified.map(result => result.state.kind)
  const imageFailure = classified.find(result => result.toolName === "googleImageAnalysisTool" && result.state.kind !== "success")
  if (imageFailure) {
    const code = String(imageFailure.state.parsed?.error?.code || "")
    const lastAttempt = imageFailure.state.parsed?.evidence?.attempts?.at?.(-1) || imageFailure.state.parsed?.error?.evidence?.attempts?.at?.(-1) || null
    const status = Number(imageFailure.state.parsed?.error?.status || lastAttempt?.status || 0)
    if (code === "image_link_expired") return "图片我收到了，但这张图的下载链接已经过期了。你重新发一次原图，我再看。"
    if (code === "image_download_failed") return "图片收到了，不过这次没能把原图读下来。我还没看到里面的内容，先不乱猜。"
    if (code === "vision_timeout") return "图片收到了，不过这次看图等太久，最后没有读到内容。我先不乱猜图里的问题。"
    if (code === "vision_http" && [401, 403].includes(status)) return "图片收到了，不过识图渠道的授权没有通过，所以我还没读到图里的内容。"
    if (code === "vision_http" && status === 429) return "图片收到了，不过识图渠道现在请求太多，暂时没有返回内容。"
    if (code === "vision_http" && status >= 500) {
      // 渠道整体趴了(auth池被污染/上游全挂)和单张图被拒是两种病,给用户的建议必须不同:
      // 前者重发没用要等恢复,后者重发别的图就能过
      const detail = String(lastAttempt?.message || imageFailure.state.parsed?.error?.message || "")
      if (/auth_unavailable|no auth available/i.test(detail)) {
        return "图片我收到了——这次不是图的问题，是识图通道那边整体掉线了，重发图片也没用；等几分钟再叫我一次，应该就恢复了。"
      }
      if (/can'?t help|cannot help|refus|policy/i.test(detail)) {
        return "图片收到了，不过识图渠道那边不肯看这张图，我读不到里面的内容；换一张图或稍后再试试。"
      }
      return "图片收到了，不过识图渠道这次临时出错，我还没读到里面的内容；稍等几分钟再试一次。"
    }
    if (code === "vision_http") return "图片收到了，不过识图渠道没有正常接住这次请求，我还没读到图里的内容。"
    return "图片收到了，不过这次没有读到可用内容。我先不乱猜图里的问题。"
  }
  if (kinds.includes("not_found")) {
    return "这轮我确实没找到能对上的内容，手里没依据，就不拿旧消息硬凑答案了。"
  }
  if (kinds.includes("error")) {
    return "这次没查成，我手里没有能确定的东西，就不装作知道了。"
  }
  return "这次没拿到能确认的内容，我不想凭猜测回你。"
}

export function hasUsableToolResult(results = []) {
  return results.some(result => classifyToolResult(result?.result).kind === "success")
}
