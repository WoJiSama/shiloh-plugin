import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

// 从 test.js 源码里按括号配数完整提取 filterToolsForMessageIntent，
// 配 stub 真实执行：专治"签名改成解构后函数体内残留旧引用"这类
// node --check 查不出、但每轮线上必炸的 ReferenceError。
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`)
  assert.ok(start >= 0, `function ${name} not found`)
  const bodyOpen = source.indexOf(") {", start) + 1
  let depth = 0
  let i = bodyOpen
  while (true) {
    if (source[i] === "{") depth += 1
    else if (source[i] === "}") {
      depth -= 1
      if (depth === 0) break
    }
    i += 1
  }
  return source.slice(start, i + 1)
}

test("filterToolsForMessageIntent 可执行且不残留未定义引用", () => {
  const src = fs.readFileSync(path.join(root, "apps/test.js"), "utf8")
  const fn = extractFunction(src, "filterToolsForMessageIntent").replace(
    "function filterToolsForMessageIntent", "function __f")
  const stub = `
const normalizeIntentText = s => String(s || "");
const isRealtimeInfoRequest = () => false;
const isExplicitSearchRequest = () => false;
const isExplicitToolIntent = () => false;
const isExplicitAdminCollectionMentionRequest = () => false;
const shouldExposeToolsForMessage = () => true;
const collectMentionTargetIds = () => [];
const filterToolsForEmojiExposure = (t, c, o) => Array.isArray(t) ? t : [];
const SEARCH_TOOL_NAMES = new Set(["searchInformationTool"]);
`
  const call = `
const tools = [{ function: { name: "sendLocalEmojiTool" } }, { function: { name: "searchInformationTool" } }];
const evt = { group_id: 1, msg: "希洛你好吗" };
const out = __f(tools, evt, "希洛你好吗", { allowSearch: false, emojiCooldownMs: 120000 });
globalThis.__smokeOut = out.length;
`
  // 用 Function 构造器同步执行（无异步依赖）
  const runner = new Function(stub + fn + call + "return globalThis.__smokeOut")
  const kept = runner()
  assert.ok(Number.isInteger(kept), "必须无异常返回工具数")
})
