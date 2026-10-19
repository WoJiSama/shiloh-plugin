import fs from "fs"
import { TurtleSoupGenerator } from "./dist/modules/games/infrastructure/turtleSoup/TurtleSoupGenerator.js"
import { TurtleSoupStore } from "./dist/modules/games/infrastructure/turtleSoup/TurtleSoupStore.js"

const key = process.env.SOUP_KEY
const endpoint = "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions"
const current = JSON.parse(fs.readFileSync("./current.json", "utf8")).puzzles
const callModel = async (messages, options = {}) => {
  const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify({ model: "glm-5.3", messages, temperature: options.temperature ?? 0.7, top_p: 0.9 }) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const data = await response.json()
  if (!data?.choices?.[0]?.message?.content) throw new Error("空回复")
  return data.choices[0].message.content
}
const plan = ["easy", "easy", "normal", "normal", "hard", "hard"]
const results = []
for (const difficulty of plan) {
  let done = false
  for (let attempt = 1; attempt <= 16 && !done; attempt++) {
    // 每次用独立临时库,避免失败残留;成功后回滚重新记录
    const dir = fs.mkdtempSync("/tmp/soup_slot_")
    try {
      const store = new TurtleSoupStore({ cwd: dir, baseDir: "data/turtle_soup" })
      const generator = new TurtleSoupGenerator({
        store, config: () => ({ freshPoolTarget: 1, contentPolicy: "题材保持本格推理趣味,可以悬疑惊悚,但避免直白血腥、猎奇虐待细节与涉政内容" }),
        callModel, logger: { info() {}, warn() {} }
      })
      // 注入现有题库做去重基准
      const file = store.readPuzzles()
      file.puzzles = current.concat(results)
      await store.writePuzzles(file)
      const puzzle = await generator.generateOne(difficulty)
      results.push(puzzle)
      done = true
      console.log(`[OK] ${difficulty} #${results.length}/6 ${puzzle.title}`)
    } catch (error) {
      console.log(`  (${difficulty}) 尝试${attempt} 失败: ${String(error.message || error).slice(0, 70)}`)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  }
  if (!done) console.log(`[GIVEUP] ${difficulty} 16次尝试未通过`)
}
if (results.length) fs.writeFileSync("./batch.json", JSON.stringify(results, null, 2))
console.log(`完成 ${results.length}/6`)
