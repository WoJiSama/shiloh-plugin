// 画图请求被文字兜底（或画图工具失败）后，给下一轮对话留一条系统提示，
// 让模型能接住用户的不满，而不是把抱怨当成玩梗素材。
const notes = new Map()
const NOTE_TTL_MS = 10 * 60 * 1000
const IMAGE_TOOL_NAMES = new Set(["bananaTool", "googleImageEditTool"])

export function recordDrawTextFallback(scope, requestText = "") {
  const key = String(scope || "")
  if (!key) return
  notes.set(key, { at: Date.now(), requestText: String(requestText || "").slice(0, 200) })
}

export function clearDrawFailureNote(scope) {
  notes.delete(String(scope || ""))
}

export function isImageDeliveryToolName(toolName = "") {
  return IMAGE_TOOL_NAMES.has(String(toolName || ""))
}

/** 读取并消费一条未过期的失败标记；过期自动清理 */
export function takeDrawFailureNote(scope, { now = Date.now(), ttlMs = NOTE_TTL_MS } = {}) {
  const key = String(scope || "")
  const note = notes.get(key)
  if (!note) return null
  notes.delete(key)
  if (now - note.at > ttlMs) return null
  return note
}

export function buildDrawFailureNoteMessage(note) {
  if (!note) return ""
  return [
    "【系统提示】最近一次画图请求没有生成图片，最终只发了文字。",
    note.requestText ? `当时的请求原文：「${note.requestText}」` : "",
    "如果当前消息在表达不满（例如\"草啊\"\"傻逼ai\"），那是冲着没画出图来的：先承认这次没画出来，可以提出稍后再试，不要把用户的抱怨当梗接。",
    "注意人物指认：表达不满的是当前发消息的人，不要把他错认成画里的角色或其他群友。"
  ].filter(Boolean).join("\n")
}
