const TONE_CORRECTION_PATTERNS = [
  /阴阳怪气|夹枪带棒|嘲讽|挤兑|酸我|讽刺/i,
  /(?:语气|口气|态度).{0,10}(?:不对|不太对|怪|奇怪|差|冲|欠|阴阳|不好|有问题)/i,
  /(?:怎么|咋|为什么).{0,8}(?:这样|这么).{0,8}(?:说话|讲话|回复|回我)/i,
  /你.{0,8}(?:什么态度|怎么说话|跟谁学的|哪学的)/i,
  /(?:别|不要|能不能别).{0,8}(?:顶嘴|顶着说|犟|抬杠|调情|恶心我)/i,
  /(?:我不喜欢|听着不舒服|让人不舒服|感觉很怪).{0,12}(?:你|这样|这种|语气|口气)?/i
]

export function isToneCorrectionMessage(text = "") {
  const content = String(text || "").replace(/\[CQ:[^\]]+\]/g, " ").replace(/\s+/g, " ").trim()
  return Boolean(content && TONE_CORRECTION_PATTERNS.some(pattern => pattern.test(content)))
}

export function hasMeaningfulUserText(text = "") {
  return Boolean(String(text || "")
    .replace(/\[CQ:[^\]]+\]/g, " ")
    .replace(/^\s*希洛(?:希洛)?[，,。.!！?？：:\s]*/i, "")
    .replace(/[\s，,。.!！?？：:~～]+/g, "")
    .trim())
}

export const buildVisibleChatFailureDetail = buildVisibleFailureDetail

export function buildGenericChatFailureReply(userText = "", { isGreeting = false, failureKind = "unknown", failureDetail = "" } = {}) {
  if (isToneCorrectionMessage(userText)) {
    return "你说得对，刚才那几句有点顶着你说了，听着确实不舒服。我收一下。"
  }
  if (!hasMeaningfulUserText(userText)) {
    return "这条消息里没有读到可处理的文字内容。你补一句具体要我做什么，我再处理。"
  }
  if (isGreeting) {
    return `我在。这次回复没生成出来，消息本身没问题。${failureDetail ? ` 原因：${failureDetail}` : ""}`
  }
  if (failureKind === "rate_limit") {
    return `这次请求被限流了，问题我看到了，但没能生成答案。${failureDetail ? ` 原因：${failureDetail}` : ""}`
  }
  if (failureKind === "timeout" || failureKind === "network") {
    return `这次回答超时了。消息没丢，不用重发。${failureDetail ? ` 原因：${failureDetail}` : ""}`
  }
  if (failureKind === "upstream") {
    return `回答服务现在有点忙，这次请求没等到结果。${failureDetail ? ` 原因：${failureDetail}` : ""}`
  }
  if (failureKind === "auth" || failureKind === "request") {
    return `这次没能生成回答。消息本身没问题。原因：${failureDetail || "回答服务请求失败"}`
  }
  return `这次没能生成回答。你的消息没丢，也不用重发。${failureDetail ? ` 原因：${failureDetail}` : ""}`
}
import { buildVisibleFailureDetail } from "./visibleFailure.js"
