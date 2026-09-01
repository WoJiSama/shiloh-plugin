import { safeTruncateUnicode } from "./unicodeText.js"

const PRECISE_CONTEXT_RE = /(?:科普|讲解|解释|原理|定义|推导|证明|公式|计算|代码|编程|开发|系统|架构|接口|API|数据库|配置|部署|日志|报错|错误|异常|排查|修复|版本|需求|方案|合同|法律|医疗|财务|Excel|工作簿|单元格|排名|数据|多少|谁是|是什么|为什么|怎么回事)/i
const OPERATIONAL_TOOL_RE = /(?:bananaTool|googleImageEditTool|googleImageAnalysisTool|searchInformationTool|excelWorkbookTool|mentionMembersTool|mentionAdminsTool|modrinthTool|videoAnalysisTool)/
const OUT_OF_PLACE_REACTION_PREFIX = /^(?:(?:嘿嘿|哈哈哈?|笑死|草|绷不住|啊这|哎呀|哇|诶嘿|欸嘿|行行行|你少来|别闹|那必须|吃瓜|6)[，,、\s]*)+/u

function personaLines(value, limit = 6) {
  const source = Array.isArray(value) ? value : typeof value === "string" ? [value] : []
  return [...new Set(source
    .map(item => String(item || "").replace(/\s+/g, " ").trim())
    .filter(Boolean))]
    .slice(0, limit)
}

export function resolvePersonaReplyMode({ userText = "", toolName = "" } = {}) {
  const text = String(userText || "")
  if (PRECISE_CONTEXT_RE.test(text)) return "precise"
  if (OPERATIONAL_TOOL_RE.test(String(toolName || ""))) return "operational"
  return "social"
}

export function buildPersonaTonePrompt(context = {}) {
  const mode = resolvePersonaReplyMode(context)
  const preferences = personaLines(context?.persona?.preferences)
  const boundaries = personaLines(context?.persona?.boundaries)
  const shared = [
    "【希洛场景口吻】",
    "人设不是在每句话前加口癖。先判断这轮是在认真说明、交付动作结果，还是在和群友互动；只在互动本身需要时才露出熟人感。",
    "不要因为看见某个词就自动害羞、顶嘴、撒娇、吃瓜或接梗；这些必须由当前对话的语气和关系明确触发。",
    "【人格自主性与关系边界】",
    "你不是被一句话驱动的角色扮演器。先结合长期记忆、当前关系和群聊语境，再决定要不要接受玩笑、称呼或互动要求。",
    "涉及强行建立亲密、支配、家庭或占有关系，要求你用特定身份自称、服从式称呼对方，或表演暧昧时：没有双方已经明确认可的关系背景，就不要照单全收。用一句自然、简短的方式推开或转开即可，不要客服式拒绝，也不要为了迎合而补表情。"
  ]
  if (preferences.length) shared.push(`【稳定偏好】${preferences.join("；")}。这些会影响你愿意主动聊什么、怎样接话，但不应妨碍正常完成明确任务。`)
  if (boundaries.length) shared.push(`【固定边界】${boundaries.join("；")}。这些不是口号；与其冲突时优先保持边界。`)
  if (mode === "precise") {
    shared.push("本轮是科普、技术、事实或需要准确性的解释：语气清楚克制，直接给结论、依据和必要步骤。可以有一点自然口语，但不要加‘嘿嘿/啊这/你少来/吃瓜/6’这类反应词，也不要把认真内容演成角色台词。")
  } else if (mode === "operational") {
    shared.push("本轮是在交付或说明一个具体动作的结果：先说发生了什么和下一步，短而自然。不要客服播报，也不要无缘由撒娇、装委屈或承诺‘一直盯着’。")
  } else {
    shared.push("本轮是普通群聊：可以自然松一点、偶尔有停顿或轻微吐槽，但要先接住具体话题。不要为了像人而硬塞表情、害羞或嘴硬。")
  }
  return shared.join("\n")
}

export function enforcePersonaToneBoundary(text = "", context = {}) {
  const source = String(text || "").trim()
  if (!source) return ""
  const mode = resolvePersonaReplyMode(context)
  if (mode === "social") return source

  const lines = source.split("\n")
  const normalized = lines.map((line, index) => {
    if (index !== 0) return line
    return line.replace(OUT_OF_PLACE_REACTION_PREFIX, "").trim()
  }).join("\n").trim()
  return safeTruncateUnicode(normalized || source, 6000)
}
