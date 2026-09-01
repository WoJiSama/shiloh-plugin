function compact(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim()
}

function uniqueNames(items = []) {
  return [...new Set(items.map(item => compact(item?.displayName || item?.userId || item)).filter(Boolean))]
}

export function recordActionOutcomes(session = {}, kind = "", items = []) {
  const committed = Array.isArray(items) ? items.filter(Boolean) : []
  if (!kind || !committed.length) return []
  session.actionOutcomes ||= []
  const outcomes = committed.map(item => ({ kind, item }))
  session.actionOutcomes.push(...outcomes)
  return outcomes
}

function formatOutcome(outcome = {}) {
  const item = outcome.item || {}
  if (outcome.kind === "group_workflow") {
    const targets = uniqueNames(item.targets)
    if (!compact(item.condition) || !targets.length) return ""
    return `遇到“${compact(item.condition)}”时通知${targets.join("、")}`
  }
  if (outcome.kind === "group_knowledge") {
    const subject = compact(item.subject)
    if (!subject) return ""
    if (item.kind === "group_file") {
      const fileName = compact(item.resource?.fileName)
      return fileName ? `“${subject}”对应群文件「${fileName}」` : ""
    }
    const targets = uniqueNames(item.targets)
    return targets.length ? `“${subject}”指的是${targets.join("、")}` : ""
  }
  return ""
}

export function buildCommittedActionReply(session = {}) {
  const facts = [...new Set((session.actionOutcomes || []).map(formatOutcome).filter(Boolean))]
  if (!facts.length) return ""
  return facts.length === 1 ? `记住了，${facts[0]}。` : `记住了：${facts.join("；")}。`
}
