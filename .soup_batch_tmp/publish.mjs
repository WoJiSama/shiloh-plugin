import fs from "fs"
// 读取本批产物,合并进服务器题库:全部 active 入池,附带三域审计档案
const batch = JSON.parse(fs.readFileSync("./batch.json", "utf8"))
const current = JSON.parse(fs.readFileSync("./current.json", "utf8")).puzzles
const ids = new Set(current.map(z => z.id))
const merged = [...current]
for (const puzzle of batch) {
  if (!ids.has(puzzle.id)) merged.push({ ...puzzle, status: "active" })
}
fs.writeFileSync("./merged.json", JSON.stringify({ puzzles: merged }, null, 2))
console.log(`合并:${current.length} 现有 + ${batch.length} 新增(全部 active)`)
for (const z of batch) console.log(`  [${z.difficulty}] ${z.title} | audits:${(z.audits || []).length}`)
