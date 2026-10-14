import type {MentionEvent,ChatIdentity} from "../../../contracts/chatEvent.js"
import { looksGroupAddressed } from "./messageIntent.js"
import { getMentionTargetId, messageMentionsUser } from "./mentionTargets.js"

export {getReplySender,messageQuotesUser} from "./messageContext.js"

/**
 * 「这句话在回谁」的统一判定：@、文本点名、引用、上一说话人接续 → bot / group / other / unknown。
 * 触发 TimingGate 与主回复链路共用同一份信号，避免"要不要插话"和"回给谁"各判各的。
 * mentionsBotName / quotesBot / sameUserAsLastReply 依赖调用方环境（文本锚点/引用解析/会话状态），作为入参传入。
 */
export function computeAddresseeSignal({
  e = {},
  botId = "",
  mentionsBotName = false,
  quotesBot = false,
  sameUserAsLastReply = false,
  prefilterKind = "regular"
}: {e?:MentionEvent;botId?:ChatIdentity;mentionsBotName?:boolean;quotesBot?:boolean;sameUserAsLastReply?:boolean;prefilterKind?:string} = {}) {
  let addressedToOther = false
  let atBot = false
  if (Array.isArray(e?.message)) {
    for (const seg of e.message) {
      if (seg?.type === "at" && String(getMentionTargetId(seg)) === String(botId)) atBot = true
      if (seg?.type === "at" && String(getMentionTargetId(seg)) !== String(botId)) addressedToOther = true
    }
  }
  if (!atBot) atBot = messageMentionsUser(e, botId)
  const currentText = String(e?.msg || "")
  const groupAddressed = looksGroupAddressed(currentText)
  const targetKind = (atBot || mentionsBotName || quotesBot || sameUserAsLastReply)
    ? "bot"
    : groupAddressed
      ? "group"
      : (prefilterKind === "likely_addressed_other" || addressedToOther)
        ? "other"
        : "unknown"
  const pronounWithoutBotAnchor = /[你妳]/.test(currentText) && !mentionsBotName && !atBot && !quotesBot && !sameUserAsLastReply && !groupAddressed
  return { atBot, addressedToOther, groupAddressed, targetKind, pronounWithoutBotAnchor }
}

/**
 * 主链路的对象指认提示：一句话告诉模型这条消息像在对谁说，闲聊/任务两种画像都注入。
 */
export function buildAddresseePrompt(signal:{targetKind?:string}|null = null) {
  const kind = signal?.targetKind
  if (!kind || kind === "unknown") return ""
  if (kind === "bot") return "【对象指认】当前消息在对你说话：优先接住，可以自然接续上一轮内容。"
  if (kind === "group") return "【对象指认】当前消息是面向全群的话题：可以补充，但别抢占正在聊的人的话头。"
  return "【对象指认】当前消息更像在回应群里其他人：不要当成在叫你，除非内容明确需要你，否则不要抢话。"
}
