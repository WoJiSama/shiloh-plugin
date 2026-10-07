// 未定义标识符扫描:抓"迁移时没带上 import/定义,运行时 ReferenceError"这类 bug。
// conversationUtils 丢 export、chatTurn 缺 summarizeForLog 两代事故都属此类。
// import 契约测试(见 importContract.test.js)只校验命名导入,本测试补"裸调用"维度。
// 扫描前剥离注释与字符串字面量,避免提示词/注释里的普通词误报。
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

// 关键字/内置/常见对象方法,不视为"工具函数调用"
const BUILTIN = new Set([
  "await", "async", "function", "return", "typeof", "instanceof", "delete", "new", "throw", "case", "switch",
  "if", "for", "while", "do", "else", "try", "catch", "finally", "yield", "import", "export", "default",
  "stringify", "parse", "now", "keys", "values", "entries", "isArray", "from", "of", "call", "apply", "bind",
  "trim", "split", "join", "slice", "splice", "replace", "replaceAll", "match", "matchAll", "test", "exec",
  "includes", "indexOf", "lastIndexOf", "forEach", "map", "filter", "find", "findIndex", "findLast", "findLastIndex",
  "some", "every", "reduce", "reduceRight", "push", "pop", "shift", "unshift", "concat", "repeat",
  "toUpperCase", "toLowerCase", "padStart", "padEnd", "startsWith", "endsWith", "charAt", "codePointAt",
  "round", "floor", "ceil", "abs", "max", "min", "random", "sqrt", "pow", "parseInt", "parseFloat",
  "setTimeout", "setInterval", "clearTimeout", "clearInterval", "setImmediate", "queueMicrotask",
  "fetch", "assign", "freeze", "defineProperty", "getOwnPropertyNames", "setPrototypeOf", "create",
  "isFinite", "isNaN", "then", "catch", "finally", "all", "allSettled", "race", "any", "resolve", "reject",
  "get", "set", "has", "delete", "add", "size", "sort", "toSorted", "flat", "flatMap", "fill", "reverse", "at", "with",
  "getMonth", "getFullYear", "getDate", "getHours", "getMinutes", "getSeconds", "toISOString", "toLocaleString", "getTime",
  "createHash", "randomBytes", "randomUUID", "existsSync", "mkdirSync", "readFileSync", "writeFileSync", "appendFileSync",
  "statSync", "readdirSync", "rmSync", "copyFileSync", "renameSync", "normalize", "resolve", "join", "dirname",
  "basename", "extname", "relative", "isAbsolute", "watch", "unwatch", "readFile", "writeFile", "unlink", "mkdir",
  "encodeURI", "decodeURI", "encodeURIComponent", "decodeURIComponent", "escape", "unescape", "structuredClone",
  "mark", "measure", "error", "warn", "info", "debug", "log", "trace", "group", "groupEnd", "time", "timeEnd",
  "handler", "fnc", "reg", "priority", "event", "name", "type", "value", "key", "data", "message", "code"
])

function stripCommentsAndStrings(source) {
  // 依次去掉:块注释、行注释、模板字符串、双引号/单引号字符串
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/`(?:\\.|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
}

function collectDefinedNames(cleanSource) {
  const defined = new Set()
  for (const match of cleanSource.matchAll(/import\s*\{([^}]+)\}/g)) {
    match[1].split(",").forEach(part => {
      const name = part.split(/\s+as\s+/).pop().trim()
      if (name) defined.add(name)
    })
  }
  for (const match of cleanSource.matchAll(/import\s+(\w+)\s+from/g)) defined.add(match[1])
  for (const match of cleanSource.matchAll(/import\s*\*\s*as\s+(\w+)/g)) defined.add(match[1])
  // 函数声明(任意层级)与任意缩进的 const/let/var/class
  for (const match of cleanSource.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)) defined.add(match[1])
  for (const match of cleanSource.matchAll(/(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) defined.add(match[1])
  for (const match of cleanSource.matchAll(/(?:^|\n)\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g)) defined.add(match[1])
  // 类方法与对象字面量方法:xxx(...) { 形式(含 async/get/set/静态、带默认值参数)。
  // 参数段不跨行不含右括号即可——禁跨行防止 if (a) b\n c(...) { 吞掉后续行漏收方法名
  for (const match of cleanSource.matchAll(/(?:^|\n)\s*(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*\([^)\n]*\)\s*\{/g)) defined.add(match[1])
  // 箭头函数与函数参数(调用点若与参数同名视为已定义)
  for (const match of cleanSource.matchAll(/([A-Za-z_$][\w$]*)\s*(?:=>|\([^)]*\)\s*=>)/g)) defined.add(match[1])
  for (const match of cleanSource.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
    match[1].split(",").forEach(param => {
      const name = param.trim().split("=")[0].trim().replace(/^\.{3}/, "").split(":")[0].trim()
      if (/^[A-Za-z_$][\w$]*$/.test(name)) defined.add(name)
    })
  }
  return defined
}

function scanFile(file) {
  const clean = stripCommentsAndStrings(fs.readFileSync(file, "utf8"))
  const defined = collectDefinedNames(clean)
  const problems = []
  for (const match of clean.matchAll(/(?<![\w$.])([a-z][A-Za-z0-9]{5,})\s*\(/g)) {
    const name = match[1]
    if (defined.has(name) || BUILTIN.has(name)) continue
    // (?: 紧随其后的必然是正则字面量里的非捕获组,不是函数调用
    if (clean.slice(match.index + match[0].length).startsWith("?:")) continue
    const line = clean.slice(0, match.index).split("\n").length
    problems.push(`${name}(L${line})`)
  }
  return problems
}

test("apps 目录无未定义的裸函数调用(迁移丢 import 防线)", () => {
  const targets = [
    ...fs.readdirSync(path.join(repoRoot, "apps/lib")).filter(f => f.endsWith(".js")).map(f => `apps/lib/${f}`),
    "apps/test.js",
    "apps/CommandHelp.js"
  ].map(relative => path.join(repoRoot, relative))

  const problemsByFile = []
  for (const file of targets) {
    const problems = scanFile(file)
    if (problems.length) problemsByFile.push(`${path.relative(repoRoot, file)} -> ${problems.join(", ")}`)
  }
  assert.deepEqual(problemsByFile, [], `发现疑似未定义调用:\n${problemsByFile.join("\n")}\n(若为误报请把标识符加进 BUILTIN 并注明原因)`)
})
