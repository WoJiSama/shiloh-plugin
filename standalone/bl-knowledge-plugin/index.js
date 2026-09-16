// 独立插件入口：与 shiloh-plugin 相同的动态加载模式
import fs from "fs"
import path from "path"

const pluginDir = path.dirname(new URL(import.meta.url).pathname)
const files = fs.readdirSync(path.join(pluginDir, "apps")).filter(file => file.endsWith(".js"))

let ret = []
files.forEach(file => {
  ret.push(import(`./apps/${file}`))
})
ret = await Promise.allSettled(ret)

let apps = {}
for (let i in files) {
  const name = files[i].replace(".js", "")
  if (ret[i].status !== "fulfilled") {
    logger.error(`[bl-knowledge-plugin] 载入 ${name} 失败：`, ret[i].reason)
    continue
  }
  apps = { ...apps, ...ret[i].value }
}

export { apps }
