/**
 * 模型宣告沉默的元话语识别（实测事故：模型用纯文本写「旁听，结束回合。」「无需发送，结束回合。」，
 * 未外发兜底把它当"想说话的内容"直发进群）。判定规则：整条文本去掉空白与标点后，
 * 必须能完全由元话语词表拼出才算沉默声明——「这游戏什么时候结束回合啊」这类含同词的真聊天不会误伤。
 */
const SILENT_TERMS = [
  '无需发送', '不用发送', '不用发', '不发了', '不再发言', '本轮不发言', '无话可说',
  '保持沉默', '结束回合', '回合结束', '本回合结束', '旁听结束', '旁听', '沉默', 'SILENT', '已读',
]

export function isSilentDeclaration(text: string): boolean {
  const stripped = String(text || '').replace(/[\s\p{P}\p{S}]/gu, '').toUpperCase()
  if (!stripped) return true
  const reachable = new Array<boolean>(stripped.length + 1).fill(false)
  reachable[0] = true
  for (let i = 0; i < stripped.length; i++) {
    if (!reachable[i]) continue
    for (const term of SILENT_TERMS) {
      const upper = term.toUpperCase()
      if (stripped.startsWith(upper, i)) reachable[i + upper.length] = true
    }
  }
  return reachable[stripped.length] === true
}
