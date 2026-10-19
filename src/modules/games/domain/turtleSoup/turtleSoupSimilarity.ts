// 海龟汤猜底判定——纯字面相似度部分。灰区(命中线与漏判线之间)交由主持模型语义判定,
// 这里只负责可确定性计算的字面分数与问题归一化。

const CQ_CODE = /\[CQ:[^\]]*\]/g
const PUNCTUATION = /[，,。.!！?？:：;；、~～"'“”‘’()（）\[\]【】\s]/g
const FILLER_PREFIX = /^(?:(?:我|你|他|她|它)?(?:觉得|认为|猜|知道|断定|怀疑)|答案(?:是)?|应该(?:是)?|好像|似乎|可能|大概(?:是)?|估计(?:是)?|因为|由于|其实就是?|就是说|也就是|事实(?:是)?|真相(?:是)?|难道(?:是)?|莫非(?:是)?)+/
const TAIL_PARTICLES = /[吧呢啊哦嘛呀吗咯呗啦]$/

export function normalizeSoupText(text:unknown):string {
  let value = String(text ?? "")
  value = value.replace(CQ_CODE, " ")
  value = value.replace(PUNCTUATION, "")
  let previous = ""
  while (previous !== value) {
    previous = value
    value = value.replace(FILLER_PREFIX, "")
  }
  value = value.replace(TAIL_PARTICLES, "")
  return value.trim()
}

export function levenshteinRatio(left:string, right:string):number {
  let a = Array.from(left)
  let b = Array.from(right)
  if (!a.length || !b.length) return a.length === b.length ? 1 : 0
  if (a.length > b.length) { const swap = a; a = b; b = swap }
  let previous = Array.from({length: a.length + 1}, (_, index) => index)
  for (let j = 1; j <= b.length; j++) {
    const current = [j]
    for (let i = 1; i <= a.length; i++) {
      const up = previous[i] ?? i
      const left = current[i - 1] ?? i
      const diagonal = previous[i - 1] ?? 0
      current[i] = Math.min(up + 1, left + 1, diagonal + ((a[i - 1] ?? '') === (b[j - 1] ?? '') ? 0 : 1))
    }
    previous = current
  }
  return 1 - (previous[a.length] ?? 0) / b.length
}

function bigrams(text:string):string[] {
  const chars = Array.from(text)
  const result:string[] = []
  for (let index = 0; index + 1 < chars.length; index++) result.push(`${chars[index] ?? ''}${chars[index + 1] ?? ''}`)
  return result
}

export function bigramDice(left:string, right:string):number {
  const a = bigrams(left)
  const b = bigrams(right)
  if (!a.length || !b.length) return left === right ? 1 : 0
  const pool = new Map<string, number>()
  for (const gram of a) pool.set(gram, (pool.get(gram) || 0) + 1)
  let shared = 0
  for (const gram of b) {
    const remain = pool.get(gram) || 0
    if (remain > 0) { shared++; pool.set(gram, remain - 1) }
  }
  return (2 * shared) / (a.length + b.length)
}

export function literalSoupSimilarity(guess:unknown, solution:unknown):number {
  const left = normalizeSoupText(guess)
  const right = normalizeSoupText(solution)
  if (!left || !right) return 0
  if (left === right) return 1
  return Math.max(levenshteinRatio(left, right), bigramDice(left, right))
}

export type SoupGuessVerdict = 'hit'|'gray'|'miss'
export interface SoupGuessClassification {score:number;verdict:SoupGuessVerdict}
export function classifySoupGuess(guess:unknown, solution:unknown, thresholds:{hitThreshold:number;missThreshold:number}):SoupGuessClassification {
  if (!normalizeSoupText(guess)) return {score: 0, verdict: 'miss'}
  const score = literalSoupSimilarity(guess, solution)
  if (score >= thresholds.hitThreshold) return {score, verdict: 'hit'}
  if (score < thresholds.missThreshold) return {score, verdict: 'miss'}
  return {score, verdict: 'gray'}
}

// 灰区语义判定时给主持模型对照的关键点覆盖率(归一化后逐条子串匹配)。
export function keyPointCoverage(keyPoints:string[], guess:unknown):{matched:string[];missing:string[]} {
  const normalized = normalizeSoupText(guess)
  const matched:string[] = []
  const missing:string[] = []
  for (const point of keyPoints) {
    const target = normalizeSoupText(point)
    if (target && normalized.includes(target)) matched.push(point)
    else missing.push(point)
  }
  return {matched, missing}
}

// 主持输出防泄漏:归一化后包含完整汤底即泄漏;否则退回字面相似度兜底。
export function looksLikeSolutionLeak(replyText:unknown, solution:unknown, threshold = 0.75):boolean {
  const reply = normalizeSoupText(replyText)
  const target = normalizeSoupText(solution)
  if (!reply || !target) return false
  if (target.length >= 2 && reply.includes(target)) return true
  return literalSoupSimilarity(replyText, solution) >= threshold
}
