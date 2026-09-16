// 重新生成 docs/commands.md：node scripts/gen-commands-doc.mjs
import path from "path"
import process from "process"
import { getCommandRegistry, writeCommandsMarkdown } from "../utils/commandRegistry.js"

const pluginRoot = path.resolve(process.argv[2] || process.cwd())
const registry = getCommandRegistry(pluginRoot, { force: true })
if (registry.loadError) {
  console.error("commands.yaml 解析失败:", registry.loadError)
  process.exit(1)
}
const target = writeCommandsMarkdown(registry, pluginRoot)
console.log(`已生成 ${target}（${registry.commandCount} 条命令 / ${registry.domains.length} 个模块）`)
