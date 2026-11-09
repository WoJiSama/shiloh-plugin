/**
 * 模型宣告沉默的元话语识别（实测事故：模型用纯文本写「旁听，结束回合。」「无需发送，结束回合。」，
 * 未外发兜底把它当"想说话的内容"直发进群）。判定规则：整条文本去掉空白与标点后，
 * 必须能完全由元话语词表拼出才算沉默声明——「这游戏什么时候结束回合啊」这类含同词的真聊天不会误伤。
 */
const SILENT_TERMS = [
  '无需发送', '不用发送', '不用发', '不发了', '不再发言', '本轮不发言', '无话可说',
  '保持沉默', '结束回合', '回合结束', '本回合结束', '旁听结束', '旁听', '沉默', 'SILENT', '已读',
  // 实拍补充（295708427 群）：模型自创的变体——静默/结束/「不是对我说的」
  '静默', '静默结束', '已静默结束', '已沉默', '沉默结束', '已沉默结束', '结束',
  '不是对我说的', '与我无关',
  // 实拍补充（953676639 群 2026-11-09）：「(已经决定不说话，直接停。)」漏进群——补"不说话/停"族
  '不说话', '不说了', '别说了', '不吭声', '直接停', '停',
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

/** 兜底直发前的最后防线：文本只要沾到元话语词汇（子串级）就按沉默处理。
 *  提醒过一次后还输出含元词的纯文本，几乎必然是又一次沉默声明而非想发的内容——
 *  漏发可以下轮补，误发进群里收不回。 */
const SILENT_HINT_RE = /旁听|沉默|静默|无需发送|不用发送|不用发|不发了|不再发言|本轮不发言|不说话|不说了|别说了|不吭声|直接停|结束回合|回合结束|本回合结束|不是对我说的|与我无关|已读|SILENT/i

export function mentionsSilenceVocabulary(text: string): boolean {
  return SILENT_HINT_RE.test(String(text || ''))
}

/**
 * 形状防线（2026-11-09 实拍「(已经决定不说话，直接停。)」第三次漏网后确立）：
 * 词表枚举永远追不上模型造句，但元话术的**形状**稳定——整条被括号/引号包裹的"状态标注"。
 * 真想发言的模型写裸文本；括号动作（（笑）（溜了））远短于兜底长度门槛(≥6字)。
 * 损失不对称支持从严：误判沉默=漏发一句可下轮补，误判发言=元话术进群收不回。
 */
const WRAP_PAIRS: [string, string][] = [['（', '）'], ['(', ')'], ['「', '」'], ['『', '』'], ['【', '】']]

export function isWrappedAnnotation(text: string): boolean {
  const value = String(text || '').trim()
  if (value.length < 3) return false
  for (const [open, close] of WRAP_PAIRS) {
    if (value.startsWith(open) && value.endsWith(close) && value.length >= open.length + close.length + 1) return true
  }
  return false
}
