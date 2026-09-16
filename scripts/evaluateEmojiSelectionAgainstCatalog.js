import fs from "fs"
import path from "path"
import { buildEmojiCandidatePool, structuredEmojiRelevanceScore } from "../domains/emoji/emojiSelection.js"

const defaultPath = path.join(process.cwd(), "plugins/bl-chat-plugin/database/emoji-packs.ndjson")
const dbPath = process.argv.find(arg => arg.startsWith("--db="))?.slice(5) || defaultPath
const shouldAssert = process.argv.includes("--assert")

if (!fs.existsSync(dbPath)) {
  console.error(`emoji catalog not found: ${dbPath}`)
  process.exit(2)
}

const items = fs.readFileSync(dbPath, "utf8")
  .split("\n")
  .map(line => line.trim())
  .filter(Boolean)
  .map(line => JSON.parse(line))

const cases = [
  ["笑与接梗", { tags: ["笑死", "吐槽"], useCases: ["群友翻车", "接梗吐槽"] }],
  ["无语震惊", { tags: ["无语", "震惊"], useCases: ["无言以对", "看到离谱"] }],
  ["困累摆烂", { tags: ["疲惫", "摆烂"], useCases: ["累到躺平", "拒绝加班"] }],
  ["委屈破防", { tags: ["委屈", "破防"], useCases: ["委屈诉苦", "突然破防"] }],
  ["尴尬社死", { tags: ["尴尬", "心虚"], useCases: ["场面尴尬", "缓和尴尬"] }],
  ["害羞心动", { tags: ["害羞", "心动"], useCases: ["被人夸奖", "表达喜欢"] }],
  ["开心庆祝", { tags: ["开心", "兴奋"], useCases: ["分享快乐", "接梗起哄"] }],
  ["安慰贴贴", { tags: ["安慰", "卖萌"], useCases: ["安慰对方", "接梗摸头"] }],
  ["认怂装乖", { tags: ["认怂", "无辜"], useCases: ["认怂求饶", "求放过"] }]
]

let passed = 0
for (const [name, criteria] of cases) {
  const ranked = items
    .map(item => ({ item, score: structuredEmojiRelevanceScore(item, criteria) }))
    .filter(result => result.score >= 0.18)
    .sort((a, b) => b.score - a.score)
  const top = ranked[0]
  const pool = buildEmojiCandidatePool(ranked, { preserveStrongMatch: true })
  const topTags = top?.item?.tags || []
  const topUseCases = top?.item?.useCases || []
  const primaryMatched = topTags.includes(criteria.tags[0]) || topUseCases.includes(criteria.useCases[0])
  const poolKeepsPrimary = pool.every(candidate =>
    (candidate.item?.tags || []).includes(criteria.tags[0])
    || (candidate.item?.useCases || []).includes(criteria.useCases[0])
  )
  const pass = Boolean(top && primaryMatched && poolKeepsPrimary && top.score >= 0.6)
  if (pass) passed++
  console.log(`${pass ? "PASS" : "FAIL"} ${name} score=${top?.score?.toFixed(3) || "0"} candidates=${ranked.length} pool=${pool.length} tags=[${topTags.slice(0, 4).join(",")}] useCases=[${topUseCases.slice(0, 3).join(",")}]`)
}

console.log(`emoji catalog relevance: ${passed}/${cases.length}, items=${items.length}`)
if (shouldAssert && passed !== cases.length) process.exitCode = 1
