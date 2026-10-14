const FORGET_ACTION = /(?:忘(?:掉|记)?|删(?:掉|除)?|清除|移除)/u
const MEMORY_CONTEXT = /(?:记忆|群知识|群里的知识|记住|教会|定义|刚刚那条|这(?:条|个)|我的|我之前)/u

function compact(value = '', maxLength = 180) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLength)
}

export function isExplicitGroupKnowledgeForgetRequest(text = '') {
  const value = compact(text)
  return FORGET_ACTION.test(value) && MEMORY_CONTEXT.test(value)
}

export function extractGroupKnowledgeForgetTarget(text = '') {
  const value = compact(text)
  if (!isExplicitGroupKnowledgeForgetRequest(value)) return ''
  const actionLast = value.match(/(?:把|将)?\s*(.+?)\s*(?:忘(?:掉|记)?|删(?:掉|除)?|清除|移除)(?:了|掉)?[。！？!?]?$/u)
  if (actionLast?.[1]) {
    return compact(actionLast[1]
      .replace(/^(?:希洛[，,：:\s]*)?(?:请|帮我|麻烦)?(?:把|将)?/u, '')
      .replace(/^(?:我(?:之前)?(?:教(?:给|会)?你|你记住)的?|关于|群里的?)(?:记忆|群知识)?[：:，,、]?/u, ''))
  }
  const actionFirst = value.match(/(?:忘(?:掉|记)?|删(?:掉|除)?|清除|移除)\s*(?:一下|掉)?\s*(?:我(?:之前)?(?:教(?:给|会)你|你记住)的?|关于|群里的?|这(?:条|个)?|记忆|群知识)?\s*[：:，,、]?\s*(.+)$/u)
  if (actionFirst?.[1]) {
    return compact(actionFirst[1]
      .replace(/(?:这(?:条|个)?|记忆|群知识)$/u, '')
      .replace(/[。！？!?]+$/u, ''))
  }
  return ''
}
