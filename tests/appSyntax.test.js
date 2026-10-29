import test from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const dirs = ["apps", "apps/lib", "utils", "console", "functions/functions_tools"]
const files = dirs.flatMap(dir => {
  const base = path.join(root, dir)
  if (!fs.existsSync(base)) return []
  return fs.readdirSync(base).filter(name => name.endsWith(".js")).map(name => path.join(base, name))
})
assert.ok(files.length > 60, `扫描范围异常: ${files.length}`)

test("宿主垫片与应用入口全部通过 node 语法检查(重复声明等低级错误在门禁拦下)", () => {
  const broken = []
  for (const file of files) {
    try { execFileSync(process.execPath, ["--check", file], { stdio: "pipe" }) }
    catch (error) { broken.push(`${path.relative(root, file)}: ${String(error.stderr).split("\n")[1] || error.message}`.trim()) }
  }
  assert.deepEqual(broken, [], `语法错误:\n${broken.join("\n")}`)
})
