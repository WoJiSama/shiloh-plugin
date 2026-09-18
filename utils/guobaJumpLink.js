import fs from "fs"
import path from "path"

// 锅巴跳转按钮守卫注入：锅巴不提供官方外链入口，命令管理页的悬浮按钮
// 只能注入在锅巴 index.html 里；锅巴升级会重写该文件，这里负责自动补回。

const MARKER = "blchat-cmd-jump"

const INJECT_SNIPPET = `<script>(function(){
window.__BL_CMD_TOKEN__=window.__BL_CMD_TOKEN__||"";
function add(){if(document.getElementById("blchat-cmd-jump"))return;var b=document.createElement("a");b.id="blchat-cmd-jump";b.href="/bl-chat/commands/?v=2&token="+encodeURIComponent(window.__BL_CMD_TOKEN__||"");b.target="_blank";b.textContent="\\u{1F4D6} \\u547D\\u4EE4\\u7BA1\\u7406";b.style.cssText="position:fixed;right:18px;bottom:18px;z-index:99999;background:#4c6ef5;color:#fff;padding:10px 16px;border-radius:10px;text-decoration:none;box-shadow:0 4px 14px rgba(0,0,0,.25);font-size:14px";document.body.appendChild(b)}if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",add);else add()})();</script>`

export function resolveGuobaIndexPath(pluginRoot = process.cwd()) {
  return path.join(String(pluginRoot || ""), "..", "Guoba-Plugin", "server", "static", "index.html")
}

/** 幂等注入：无标记则备份原文件后注入；返回注入结果 */
export function ensureGuobaJumpLink({ pluginRoot = process.cwd(), token = "", logger = globalThis.logger } = {}) {
  const target = resolveGuobaIndexPath(pluginRoot)
  let src = ""
  try {
    src = fs.readFileSync(target, "utf8")
  } catch {
    return { injected: false, reason: "guoba_index_not_found" }
  }
  if (src.includes(MARKER)) return { injected: false, already: true }
  if (!src.includes("</body>")) return { injected: false, reason: "no_body_tag" }

  // 每次遇到"干净"的锅巴页面都留一份纯净备份（升级后的新版本）
  const backup = `${target}.bak-blchat-jump`
  try {
    fs.copyFileSync(target, backup)
  } catch {}
  try {
    const snippet = INJECT_SNIPPET.replace('window.__BL_CMD_TOKEN__=window.__BL_CMD_TOKEN__||""', `window.__BL_CMD_TOKEN__=${JSON.stringify(String(token || ""))}`)
    fs.writeFileSync(target, src.replace("</body>", `${snippet}</body>`), "utf8")
    logger?.mark?.("[命令管理页] 已自动注入锅巴跳转按钮（锅巴升级后自动补回）")
    return { injected: true }
  } catch (error) {
    logger?.warn?.(`[命令管理页] 锅巴跳转按钮注入失败：${error?.message || error}`)
    return { injected: false, reason: "write_failed" }
  }
}

/** 监听锅巴 index.html：升级重写后 1 秒自动补注入（幂等，需带回原 token） */
export function watchGuobaJumpLink({ pluginRoot = process.cwd(), token = "", watchImpl, logger = globalThis.logger } = {}) {
  if (typeof watchImpl !== "function") return false
  const target = resolveGuobaIndexPath(pluginRoot)
  let timer = null
  watchImpl(target, () => {
    clearTimeout(timer)
    timer = setTimeout(() => ensureGuobaJumpLink({ pluginRoot, token, logger }), 1000)
  })
  return true
}
