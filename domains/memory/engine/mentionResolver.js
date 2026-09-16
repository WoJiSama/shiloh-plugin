// utils/memory/mentionResolver.js
import { normalizeAlias } from './constants.js'

// 文本中显式号：@QQ:123456 / QQ:123456（QQ 大小写不敏感，冒号可中英文）
const EXPLICIT_QQ_RE = /@?\s*qq\s*[:：]\s*(\d{4,})/gi

const DEFAULT_MAX = 3

// 把消息切成候选 token，用于别名/实体子串命中（保留中文片段与字母数字串）
function tokenize(message) {
  const text = String(message || '')
  const tokens = []
  // @某人 / 词组：按空白与常见分隔切，保留原片段供 normalizeAlias 归一
  const raw = text.split(/[\s,，。!！?？、;；:：()（）【】\[\]"'""'']+/u)
  for (const piece of raw) {
    const trimmed = piece.trim()
    if (trimmed) tokens.push(trimmed)
  }
  return tokens
}

// 从 entities 文档收集 (qq, 名称/别名片段) 用于子串命中
function collectEntityTerms(entities) {
  const terms = []
  for (const entity of Object.values(entities || {})) {
    if (!entity || !entity.qq) continue
    const qq = String(entity.qq)
    const names = []
    if (entity.canonicalName) names.push(entity.canonicalName)
    for (const alias of entity.aliases || []) {
      if (alias && !alias.superseded && alias.text) names.push(alias.text)
    }
    for (const name of names) {
      const norm = normalizeAlias(name)
      if (norm) terms.push({ qq, norm })
    }
  }
  return terms
}

/**
 * 解析消息中被提及的人 → QQ 集合（纯函数，不读 Redis）。
 * 来源：
 *  ① 文本中的 `@QQ:数字` / `QQ:数字` 显式号；
 *  ② 别名命中（normalizeAlias(token) 命中 aliasDoc → qq）；
 *  ③ 实体 canonicalName/aliases 子串命中。
 * 去重；排除 speakerQQ；上限 max（默认 3）。
 *
 * @param {string} message
 * @param {{ aliasDoc?: object, entities?: object, speakerQQ?: string|number, max?: number }} opts
 * @returns {{ qqs: string[] }}
 */
export function resolveMentions(message, opts = {}) {
  const { aliasDoc = {}, entities = {}, speakerQQ } = opts
  const max = Number.isFinite(opts.max) && opts.max > 0 ? Math.floor(opts.max) : DEFAULT_MAX
  const text = String(message || '')
  const speaker = speakerQQ === undefined || speakerQQ === null ? null : String(speakerQQ)

  const ordered = []
  const seen = new Set()
  const add = qq => {
    if (!qq) return
    const id = String(qq)
    if (speaker && id === speaker) return
    if (seen.has(id)) return
    seen.add(id)
    ordered.push(id)
  }

  // ① 显式号
  let m
  EXPLICIT_QQ_RE.lastIndex = 0
  while ((m = EXPLICIT_QQ_RE.exec(text)) !== null) add(m[1])

  // ② 别名命中（整 token 归一后查 aliasDoc）
  const tokens = tokenize(text)
  for (const token of tokens) {
    const key = normalizeAlias(token)
    if (key && aliasDoc[key] && aliasDoc[key].qq) add(aliasDoc[key].qq)
  }

  // ③ 实体 canonicalName/aliases 子串命中
  const normMessage = normalizeAlias(text)
  if (normMessage) {
    for (const { qq, norm } of collectEntityTerms(entities)) {
      if (normMessage.includes(norm)) add(qq)
    }
  }

  return { qqs: ordered.slice(0, max) }
}
