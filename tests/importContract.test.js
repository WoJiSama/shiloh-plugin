// import 契约测试:静态扫描仓库内所有相对路径的命名导入,
// 校验 (1) 目标文件存在 (2) 目标文件确实导出了这些命名。
// 抓住的 bug 形态:重构弄丢 export(conversationUtils 事故)、
// import 路径指向不存在的文件(textPolicy 路径事故)。
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const SCAN_DIRS = ["apps", "utils", "core", "domains", "functions", "model", "models", "custom_tools"]
const SKIP_PATTERNS = [/node_modules/]

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (SKIP_PATTERNS.some(pattern => pattern.test(full))) continue
    if (entry.isDirectory()) walk(full, files)
    else if (entry.name.endsWith(".js")) files.push(full)
  }
  return files
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter(line => !line.trim().startsWith("//")).join("\n")
}

function collectExportedNames(source) {
  const names = new Set()
  const patterns = [
    /export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g,
    /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /export\s+class\s+([A-Za-z_$][\w$]*)/g
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) names.add(match[1])
  }
  for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of match[1].split(",")) {
      const name = part.split(/\s+as\s+/).pop().trim()
      if (name) names.add(name)
    }
  }
  return names
}

test("全仓库命名导入契约:目标文件存在且确实导出该命名", () => {
  const files = SCAN_DIRS.flatMap(dir => {
    const full = path.join(repoRoot, dir)
    return fs.existsSync(full) ? walk(full) : []
  })
  assert.ok(files.length > 100, `扫描范围异常: ${files.length} 个文件`)

  const problems = []
  for (const file of files) {
    const source = stripComments(fs.readFileSync(file, "utf8"))
    const importPattern = /import\s*\{([^}]+)\}\s*from\s*["'](\.[^"']+)["']/g
    for (const match of source.matchAll(importPattern)) {
      const target = path.resolve(path.dirname(file), match[2])
      // 指向 Yunzai 部署环境(仓库外)的跨插件引用不做本地校验,如 ../../other/update.js
      if (!target.startsWith(repoRoot + path.sep)) continue
      if (!fs.existsSync(target)) {
        problems.push(`${path.relative(repoRoot, file)} -> ${match[2]}: 文件不存在`)
        continue
      }
      const exported = collectExportedNames(fs.readFileSync(target, "utf8"))
      for (const rawName of match[1].split(",")) {
        const name = rawName.split(/\s+as\s+/)[0].trim()
        if (name && !exported.has(name)) {
          problems.push(`${path.relative(repoRoot, file)} 从 ${match[2]} 导入的「${name}」不存在`)
        }
      }
    }
  }
  assert.deepEqual(problems, [], `发现 ${problems.length} 处 import 契约违约:\n${problems.slice(0, 20).join("\n")}`)
})
