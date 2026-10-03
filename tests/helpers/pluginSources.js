// 插件源码聚合读取:源码级合同测试统一入口。
// 之前合同测试各自手工声明"读哪些文件",每次方法搬家都要改测试清单;
// 统一聚合(test.js + apps/lib/*)后,搬家零测试改动,合同意图(接线存在)不变。
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

/**
 * 聚合读取主链路源码:apps/test.js + apps/lib/*.js(按文件名序)。
 * 需要额外源文件(routeDecision/turnPromptComposer 等 utils)时,调用方自行 concat。
 */
export function readPluginSources() {
  const libDir = path.join(root, "apps/lib")
  const parts = [fs.readFileSync(path.join(root, "apps/test.js"), "utf8")]
  for (const file of fs.readdirSync(libDir).filter(f => f.endsWith(".js"))) {
    parts.push(fs.readFileSync(path.join(libDir, file), "utf8"))
  }
  return parts.join("\n")
}

export function readSource(relPath) {
  return fs.readFileSync(path.join(root, relPath), "utf8")
}

export const pluginRoot = root
