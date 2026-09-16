const MAX_TAGS = 5
const MAX_USE_CASES = 4
const MAX_QUERY_LENGTH = 80

const TAG_MATCH_WEIGHTS = [0.72, 0.42, 0.28, 0.18, 0.12]
const USE_CASE_MATCH_WEIGHTS = [0.58, 0.34, 0.22, 0.14]

function normalizeText(value, maxLength) {
  return Array.from(String(value || "").trim()).slice(0, maxLength).join("")
}

function normalizeList(value, maxItems, maxLength) {
  const source = Array.isArray(value) ? value : (value ? [value] : [])
  return [...new Set(source
    .map(item => normalizeText(item, maxLength))
    .filter(Boolean))]
    .slice(0, maxItems)
}

export function normalizeEmojiSelectionCriteria(input = "") {
  if (typeof input === "string") {
    return { query: normalizeText(input, MAX_QUERY_LENGTH), tags: [], useCases: [] }
  }

  const tags = normalizeList(input?.tags, MAX_TAGS, 8)
  const useCases = normalizeList(input?.useCases, MAX_USE_CASES, 16)
  const query = normalizeText(input?.query, MAX_QUERY_LENGTH)
    || [...tags, ...useCases].join(" ")

  return { query, tags, useCases }
}

export function filterEmojiSelectionCriteriaToCatalog(input = "", items = []) {
  const criteria = normalizeEmojiSelectionCriteria(input)
  const tagVocabulary = new Set()
  const useCaseVocabulary = new Set()
  for (const item of Array.isArray(items) ? items : []) {
    for (const tag of (Array.isArray(item?.tags) ? item.tags : [])) {
      const normalized = String(tag || "").trim().toLowerCase()
      if (normalized) tagVocabulary.add(normalized)
    }
    for (const scene of (Array.isArray(item?.useCases) ? item.useCases : [])) {
      const normalized = String(scene || "").trim().toLowerCase()
      if (normalized) useCaseVocabulary.add(normalized)
    }
  }
  return {
    query: criteria.query,
    tags: criteria.tags.filter(tag => tagVocabulary.has(tag.toLowerCase())),
    useCases: criteria.useCases.filter(scene => useCaseVocabulary.has(scene.toLowerCase()))
  }
}

export function describeEmojiSelectionCriteria(input = "") {
  const criteria = normalizeEmojiSelectionCriteria(input)
  return [
    criteria.tags.length ? `tags=[${criteria.tags.join(",")}]` : "",
    criteria.useCases.length ? `useCases=[${criteria.useCases.join(",")}]` : "",
    criteria.query ? `query=${criteria.query}` : ""
  ].filter(Boolean).join(" ")
}

function combineMatchScore(score, weight) {
  return 1 - ((1 - score) * (1 - weight))
}

/**
 * 对结构化字段做有优先级的精确匹配。
 * 数组越靠前权重越高；使用概率合并避免多个宽泛词轻易堆到 1 分并产生大量并列。
 */
export function structuredEmojiRelevanceScore(item, input = "") {
  const criteria = normalizeEmojiSelectionCriteria(input)
  if (!criteria.tags.length && !criteria.useCases.length) return 0

  const itemTags = new Set((Array.isArray(item?.tags) ? item.tags : [])
    .map(value => String(value || "").trim().toLowerCase())
    .filter(Boolean))
  const itemUseCases = new Set((Array.isArray(item?.useCases) ? item.useCases : [])
    .map(value => String(value || "").trim().toLowerCase())
    .filter(Boolean))

  let score = 0
  criteria.tags.forEach((tag, index) => {
    if (itemTags.has(tag.toLowerCase())) {
      score = combineMatchScore(score, TAG_MATCH_WEIGHTS[index] || TAG_MATCH_WEIGHTS.at(-1))
    }
  })
  criteria.useCases.forEach((scene, index) => {
    if (itemUseCases.has(scene.toLowerCase())) {
      score = combineMatchScore(score, USE_CASE_MATCH_WEIGHTS[index] || USE_CASE_MATCH_WEIGHTS.at(-1))
    }
  })
  return score
}

export function buildEmojiCandidatePool(candidates = [], { preserveStrongMatch = false } = {}) {
  const sorted = [...candidates].sort((a, b) => (b.score || 0) - (a.score || 0))
  if (!sorted.length) return []
  const topScore = sorted[0].score || 0
  const eligibleMin = Math.max(0.6, topScore - 0.1)
  const eligible = sorted.filter(candidate => (candidate.score || 0) >= eligibleMin)
  if (eligible.length >= 2) return eligible
  if (preserveStrongMatch && eligible.length) return eligible
  return sorted.slice(0, Math.min(3, sorted.length))
}
