import fs from "fs"
import path from "path"

// 锅巴跳转按钮守卫注入：锅巴不提供官方外链入口，命令管理页的悬浮按钮
// 只能注入在锅巴 index.html 里；锅巴升级会重写该文件，这里负责自动补回。

const MARKER = "blchat-cmd-jump-v3"
const LEGACY_MARKERS = ["blchat-cmd-jump", "blchat-cmd-jump-v2"]

// v3:按钮点击时读取钩子捕获的锅巴 accessToken(XHR/fetch 头拦截,不依赖
// 锅巴前端存储实现),以 guoba_token 跳转——命令管理页信任锅巴登录态,
// 登录了锅巴就不再要本页令牌。旧版嵌入静态 token 的注入会被自动清除。
const INJECT_SNIPPET = `<script>/* blchat-cmd-jump-v3 */(function(){
var captured=localStorage.getItem("__BL_GUOBA_TOKEN__")||"";
function grab(v){if(v){captured=String(v);try{localStorage.setItem("__BL_GUOBA_TOKEN__",captured)}catch(e){}}}
var _set=XMLHttpRequest.prototype.setRequestHeader;
XMLHttpRequest.prototype.setRequestHeader=function(n,v){if(/guoba-access-token/i.test(String(n)))grab(v);return _set.apply(this,arguments)};
var _fetch=window.fetch?window.fetch.bind(window):null;
if(_fetch){window.fetch=function(i,o){try{var h=(o&&o.headers)||(i&&i.headers)||{};var v=h["guoba-access-token"]||(h.get&&h.get("guoba-access-token"));grab(v)}catch(e){}return _fetch(i,o)}}
function add(){if(document.getElementById("blchat-cmd-jump"))return;var b=document.createElement("a");b.id="blchat-cmd-jump";b.target="_blank";b.rel="noopener";b.textContent="\\u{1F4D6} \\u547D\\u4EE4\\u7BA1\\u7406";b.style.cssText="position:fixed;right:18px;bottom:18px;z-index:99999;background:#4c6ef5;color:#fff;padding:10px 16px;border-radius:10px;text-decoration:none;box-shadow:0 4px 14px rgba(0,0,0,.25);font-size:14px";b.addEventListener("click",function(){var t=captured||localStorage.getItem("__BL_GUOBA_TOKEN__")||"";var q=t?("?guoba_token="+encodeURIComponent(t)):"";b.href="/bl-chat/commands/"+q});document.body.appendChild(b)}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",add);else add()})();</script>`

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
  // 先查当前标记(旧标记是其子串,顺序不能反),幂等返回
  if (src.includes(MARKER)) return { injected: false, already: true }
  if (LEGACY_MARKERS.some(marker => src.includes(marker))) {
    // 升级场景:剥离旧注入脚本(靠脚本体内含标记 id 识别),还原干净页面
    src = src.replace(/<script>\(function\(\)\{[\s\S]*?\}\)\(\);<\/script>/g, (block) =>
      LEGACY_MARKERS.some(marker => block.includes(marker)) ? "" : block
    )
  }
  if (!src.includes("</body>")) return { injected: false, reason: "no_body_tag" }

  // 每次遇到"干净"的锅巴页面都留一份纯净备份（升级后的新版本）
  const backup = `${target}.bak-blchat-jump`
  try {
    fs.copyFileSync(target, backup)
  } catch {}
  try {
    fs.writeFileSync(target, src.replace("</body>", `${INJECT_SNIPPET}</body>`), "utf8")
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
