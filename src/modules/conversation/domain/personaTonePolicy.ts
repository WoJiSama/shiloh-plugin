import type {PersonaText} from './personaSource.js'
import type {TurnInteractionContext} from '../../../contracts/turnInteraction.js'
interface ToneContext { userText?: string; toolName?: string; persona?: PersonaText; interactionContext?: TurnInteractionContext }
import { safeTruncateUnicode } from "../../models/domain/unicodeText.js"
import { resolvePersonaName } from "./personaSource.js"

const PRECISE_CONTEXT_RE = /(?:科普|讲解|解释|原理|定义|推导|证明|公式|计算|代码|编程|开发|系统|架构|接口|API|数据库|配置|部署|日志|报错|错误|异常|排查|修复|版本|需求|方案|合同|法律|医疗|财务|Excel|工作簿|单元格|排名|数据|多少|谁是|是什么|为什么|怎么回事)/i
const FACT_QUESTION_RE = /(?:多少|谁是|是什么|为什么|怎么回事)/u
const OPERATIONAL_TOOL_RE = /(?:bananaTool|googleImageEditTool|googleImageAnalysisTool|searchInformationTool|excelWorkbookTool|mentionMembersTool|mentionAdminsTool|modrinthTool|videoAnalysisTool)/
const OUT_OF_PLACE_REACTION_PREFIX = /^(?:(?:嘿嘿|哈哈哈?|笑死|草|绷不住|啊这|哎呀|哇|诶嘿|欸嘿|行行行|你少来|别闹|那必须|吃瓜|6)[，,、\s]*)+/u

export function resolvePersonaReplyMode({ userText = "", toolName = "", interactionContext }: ToneContext = {}) {
  if (interactionContext?.kind === 'serious_answer') return 'precise'
  if (interactionContext?.kind === 'delivery') return 'operational'
  if (interactionContext?.kind === 'comfort' && !toolName) return 'social'
  // Perception can support a joke; running an action still needs an operational delivery.
  if (interactionContext?.kind === 'banter' && interactionContext.allowPlayfulness) {
    if (!toolName || /^(?:googleImageAnalysisTool|videoAnalysisTool)$/.test(toolName)) return 'social'
    if (OPERATIONAL_TOOL_RE.test(toolName)) return 'operational'
  }
  const text = String(userText || "")
  // Conversation is a fallback, not proof of banter. Preserve explicit fact
  // questions while allowing praise to mention the topic of a past explanation.
  if (FACT_QUESTION_RE.test(text)) return 'precise'
  if (interactionContext?.kind === 'conversation' && interactionContext.allowPlayfulness && !toolName) return 'social'
  if (PRECISE_CONTEXT_RE.test(text)) return "precise"
  if (OPERATIONAL_TOOL_RE.test(String(toolName || ""))) return "operational"
  return "social"
}

export function buildPersonaTonePrompt(context: ToneContext = {}) {
  const name = resolvePersonaName(context?.persona)
  return [
    `【${name}场景口吻】`,
    "先回应当前这个人的具体意思。情绪和关系反应由这轮对话触发，不由关键词自动触发；只在缺失信息会改变当前回答时追问。",
    buildPersonaReplyModePrompt(context)
  ].join("\n")
}

/** A continuation may update tone without introducing another persona's name or preferences. */
export function buildPersonaReplyModePrompt(context: ToneContext = {}): string {
  const mode = resolvePersonaReplyMode(context)
  if (mode === 'precise') return "本轮是科普、技术、事实或需要准确性的解释：清楚克制，直接给结论、依据和必要步骤。措辞可以体现当前人设，但准确性和可执行性优先，不表演与此事无关的情绪。"
  if (mode === 'operational') return "本轮是在交付或说明一个具体动作的结果：按实际结果和发送回执说清发生了什么。需要时补一句具体信息，一句说够就结束，不额外许诺或表演情绪。"
  return "本轮是普通群聊：按当前人设接住具体话题，可以顺着已有前提转一下或轻轻反打；不要把玩笑自动改成建议。一句说够就自然结束，补话只增加当前需要的信息，不为了续聊另起索取或邀请。"

}

export function enforcePersonaToneBoundary(text = "", context: ToneContext = {}) {
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
