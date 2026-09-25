// 悬空引用防护:P2 拆分重构曾批量产生"用了别人模块的符号但没 import"的 bug
// (isAvatarInspectionRequest/logDeliveryOutcome/extractJsonObject/hasExcelContext TDZ…),
// 全部要到线上跑起来才炸。本测试静态扫描 apps/lib/* 与 test.js 的包装方法,
// 让这类错误在测试阶段就失败。
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const testJs = readFileSync(join(root, "apps/test.js"), "utf8")

/** 提取 import 绑定名与模块级声明名,组成"共享符号表" */
function extractSharedSymbols(source) {
  const names = new Set()
  const importRe = /import\s+(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\}|\*\s+as\s+([\w$]+)|([\w$]+))?\s*from\s*["'][^"']+["']/g
  for (const match of source.matchAll(importRe)) {
    const [, default1, named, ns, default2] = match
    if (default1) names.add(default1)
    if (named) {
      for (const part of named.split(",")) {
        const segment = part.trim()
        if (!segment) continue
        const alias = segment.match(/(\w+)\s+as\s+(\w+)/)
        names.add(alias ? alias[2] : segment)
      }
    }
    if (ns) names.add(ns)
    if (default2) names.add(default2)
  }
  const declRe = /^(?:export\s+)?(?:async\s+function\s+([\w$]+)|function\s+([\w$]+)|const\s+([\w$]+)\s*=|let\s+([\w$]+)\s*=|class\s+([\w$]+))/gm
  for (const match of source.matchAll(declRe)) {
    const name = match[1] || match[2] || match[3] || match[4] || match[5]
    if (name) names.add(name)
  }
  return names
}

function extractOwnBindings(source) {
  const own = extractSharedSymbols(source)
  const decls = /(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s*\*?\s*([\w$]+)|const\s+([\w$]+)|let\s+([\w$]+)|var\s+([\w$]+)|class\s+([\w$]+))/g
  for (const match of source.matchAll(decls)) {
    const name = match[1] || match[2] || match[3] || match[4] || match[5]
    if (name) own.add(name)
  }
  for (const match of source.matchAll(/function\s*\*?\s*[\w$]*\s*\(([^)]*)\)/g)) {
    for (const param of match[1].split(",")) {
      const clean = param.trim().split(/\s*=\s*/)[0].trim()
      if (/^[\w$]+$/.test(clean)) own.add(clean)
    }
  }
  for (const match of source.matchAll(/catch\s*(?:\(([\w$]+)\))?/g)) {
    if (match[1]) own.add(match[1])
  }
  return own
}

function listJsFiles(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "backups" || name.startsWith(".")) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) listJsFiles(full, acc)
    else if (/\.js$/.test(name)) acc.push(full)
  }
  return acc
}

/** 剥离字符串与注释,只留代码骨架(注释里出现的符号不算使用) */
function stripNoise(source) {
  return String(source || "")
    .replace(/`[\s\S]*?`/g, "``")
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '\"\"')
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
}

const globals = new Set(["logger", "Bot", "segment", "global", "process", "console", "Buffer", "globalThis",
  "setTimeout", "setInterval", "clearTimeout", "clearInterval", "fetch", "URL", "URLSearchParams",
  "AbortController", "AbortSignal", "Promise", "Error", "TypeError", "RangeError", "ReferenceError",
  "JSON", "Math", "Date", "Object", "Array", "String", "Number", "Boolean", "Map", "Set", "WeakMap",
  "RegExp", "Symbol", "BigInt", "Infinity", "NaN", "isNaN", "parseInt", "parseFloat", "encodeURIComponent",
  "decodeURIComponent", "structuredClone", "queueMicrotask", "crypto", "performance", "Intl", "require",
  "localStorage", "test", "expect", "describe", "it", "before", "after", "beforeEach", "afterEach", "module"])

test("apps/lib 拆分模块无悬空引用(引用共享符号但未 import/声明即失败)", () => {
  const shared = extractSharedSymbols(testJs)
  const libFiles = listJsFiles(join(root, "apps/lib"))
  const missing = []
  for (const file of libFiles) {
    const source = readFileSync(file, "utf8")
    const code = stripNoise(source)
    const own = extractOwnBindings(source)
    for (const name of shared) {
      if (own.has(name) || globals.has(name)) continue
      const useRe = new RegExp(`(?<![\\w$.])${name}(?![\\w$])`)
      if (useRe.test(code)) missing.push(`${file.replace(root + "/", "")}: ${name}`)
    }
  }
  assert.deepEqual(missing, [], `以下符号被使用但未 import/声明——先在文件头补 import:\n${missing.join("\n")}`)
})

test("apps/test.js 的委托包装方法目标都存在于模块作用域(防 TDZ/悬空)", () => {
  const imported = new Set()
  const importRe = /import\s+(?:([\w$]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*["'][^"']+["']/g
  for (const match of testJs.matchAll(importRe)) {
    const [, default1, named] = match
    if (default1) imported.add(default1)
    if (named) {
      for (const part of named.split(",")) {
        const segment = part.trim()
        if (!segment) continue
        const alias = segment.match(/(\w+)\s+as\s+(\w+)/)
        imported.add(alias ? alias[2] : segment)
      }
    }
  }
  for (const match of testJs.matchAll(/^(?:export\s+)?(?:async\s+function\s+([\w$]+)|function\s+([\w$]+)|const\s+([\w$]+)|class\s+([\w$]+))/gm)) {
    imported.add(match[1] || match[2] || match[3] || match[4])
  }
  const dangling = []
  const testCode = stripNoise(testJs)
  for (const match of testCode.matchAll(/^\s+(?:async\s+)?([\w$]+)\(\.\.\.args\)\s*\{\s*return\s+(?:await\s+)?([\w$]+)\(/gm)) {
    const [method, target] = [match[1], match[2]]
    if (method === target && !imported.has(target)) dangling.push(`包装方法 ${method} → 模块作用域不存在的 ${target}`)
  }
  assert.deepEqual(dangling, [], `以下委托包装的目标未 import/声明(运行时必抛 ReferenceError/TDZ):\n${dangling.join("\n")}`)
})
