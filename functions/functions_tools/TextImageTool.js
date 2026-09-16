import fs from "fs"
import { getSharedBrowser, scheduleSharedBrowserClose } from "../../utils/sharedBrowser.js"
import path from "path"
import sharp from "sharp"
import { AbstractTool } from "./AbstractTool.js"
import { personaFeedbackManager } from "../../domains/memory/PersonaFeedbackManager.js"
import { safeTruncateUnicode } from "../../utils/unicodeText.js"
import { pluginBridge } from "../../utils/pluginBridge.js"

const AVATAR_SIZE = 64
const CHAT_MAX_TEXT_LENGTH = 5000
const DOCUMENT_MAX_TEXT_LENGTH = 12000
const DELETE_RETRY_DELAYS_MS = [0, 200, 1000]

const TEXT_FONT_SIZE = 28
const TEXT_LINE_HEIGHT = 42
const HEADING_FONT_SIZE = 32
const HEADING_LINE_HEIGHT = 46
const QUOTE_FONT_SIZE = 25
const QUOTE_LINE_HEIGHT = 36
const CODE_FONT_SIZE = 20
const CODE_LINE_HEIGHT = 30
const PUPPETEER_LAUNCH_OPTIONS = {
  headless: "new",
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu"
  ]
}
function getRenderTheme(date = new Date()) {
  let hour = date.getHours()
  try {
    const shanghaiHour = new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      hourCycle: "h23"
    }).format(date)
    hour = Number.parseInt(shanghaiHour, 10)
  } catch {
    hour = date.getHours()
  }

  const night = hour >= 18 || hour < 6
  return night
    ? {
        mode: "night",
        pageBg: "#090f1f",
        cardBg: "#111827",
        cardBorder: "#2f3b56",
        text: "#f8fafc",
        muted: "#cbd5e1",
        subtle: "#94a3b8",
        quoteBg: "#182235",
        quoteBorder: "#8fb6ff",
        inlineBg: "#1d2940",
        inlineText: "#dbeafe",
        chatBg: "#09101f",
        chatBubble: "#151e31",
        chatBubbleBorder: "#2b3954",
        chatText: "#f8fafc",
        chatQuoteText: "#d8e3f3",
        chatName: "#b9c7da",
        chatShadow: "#020617"
      }
    : {
        mode: "day",
        pageBg: "#e8edf3",
        cardBg: "#f8fafc",
        cardBorder: "#cfd7e3",
        text: "#1f2937",
        muted: "#4b5563",
        subtle: "#74849a",
        quoteBg: "#eef3f8",
        quoteBorder: "#74849a",
        inlineBg: "#eef2f7",
        inlineText: "#1f3a5f",
        chatBg: "#f4f6fb",
        chatBubble: "#ffffff",
        chatBubbleBorder: "#e2e8f0",
        chatText: "#1f2937",
        chatQuoteText: "#5b6472",
        chatName: "#8a94a6",
        chatShadow: "#d7dde8"
      }
}

const KEYWORDS = {
  java: new Set([
    "abstract",
    "assert",
    "boolean",
    "break",
    "byte",
    "case",
    "catch",
    "char",
    "class",
    "continue",
    "default",
    "do",
    "double",
    "else",
    "enum",
    "extends",
    "final",
    "finally",
    "float",
    "for",
    "if",
    "implements",
    "import",
    "instanceof",
    "int",
    "interface",
    "long",
    "new",
    "package",
    "private",
    "protected",
    "public",
    "record",
    "return",
    "short",
    "static",
    "strictfp",
    "super",
    "switch",
    "synchronized",
    "this",
    "throw",
    "throws",
    "transient",
    "try",
    "void",
    "volatile",
    "while"
  ]),
  python: new Set([
    "and",
    "as",
    "assert",
    "async",
    "await",
    "break",
    "class",
    "continue",
    "def",
    "del",
    "elif",
    "else",
    "except",
    "finally",
    "for",
    "from",
    "global",
    "if",
    "import",
    "in",
    "is",
    "lambda",
    "nonlocal",
    "not",
    "or",
    "pass",
    "raise",
    "return",
    "try",
    "while",
    "with",
    "yield"
  ]),
  javascript: new Set([
    "async",
    "await",
    "break",
    "case",
    "catch",
    "class",
    "const",
    "continue",
    "debugger",
    "default",
    "delete",
    "do",
    "else",
    "export",
    "extends",
    "finally",
    "for",
    "from",
    "function",
    "if",
    "import",
    "in",
    "instanceof",
    "let",
    "new",
    "of",
    "return",
    "switch",
    "this",
    "throw",
    "try",
    "typeof",
    "var",
    "void",
    "while",
    "yield"
  ]),
  bash: new Set([
    "case",
    "do",
    "done",
    "elif",
    "else",
    "esac",
    "fi",
    "for",
    "function",
    "if",
    "in",
    "select",
    "then",
    "until",
    "while"
  ])
}

const LITERALS = new Set([
  "false",
  "null",
  "none",
  "true",
  "undefined",
  "False",
  "None",
  "True",
  "NaN",
  "Infinity"
])

function escapeXml(text = "") {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function stripInlineMarkdown(text = "") {
  return String(text)
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
}

function charUnits(char) {
  return /[\u4e00-\u9fff\u3400-\u4dbf\uff00-\uffef]/.test(char) ? 2 : 1
}

function measureTextWidth(text, fontSize, monospace = false) {
  // monospace 字体下中文同样占两个等宽字符宽度（与 wrapText 的 charUnits 保持一致）
  if (monospace) return [...String(text)].reduce((sum, char) => sum + charUnits(char) * fontSize * 0.62, 0)
  return [...String(text)].reduce((sum, char) => sum + charUnits(char) * fontSize * 0.52, 0)
}

function wrapText(text, maxUnits) {
  const lines = []
  const source = String(text || "")

  if (!source) return [""]

  for (const paragraph of source.split(/\r?\n/)) {
    let line = ""
    let units = 0

    for (const char of paragraph) {
      const width = charUnits(char)
      if (line && units + width > maxUnits) {
        if (/^[，。！？；：、,.!?;:)]$/.test(char)) {
          line += char
          lines.push(line)
          line = ""
          units = 0
          continue
        }
        lines.push(line)
        line = char
        units = width
      } else {
        line += char
        units += width
      }
    }

    lines.push(line)
  }

  return lines.length ? lines : [""]
}

function normalizeLanguage(language = "") {
  const lang = String(language).trim().toLowerCase()
  if (lang === "java") return "java"
  if (["py", "python3"].includes(lang)) return "python"
  if (["js", "jsx", "node", "mjs", "cjs"].includes(lang)) return "javascript"
  if (["ts", "tsx", "typescript"].includes(lang)) return "javascript"
  if (["sh", "shell", "zsh", "powershell", "ps1"].includes(lang)) return "bash"
  if (["yml", "yaml"].includes(lang)) return "yaml"
  if (lang === "json") return "json"
  return lang
}

function isIdentifierStart(char) {
  return /[A-Za-z_$]/.test(char)
}

function isIdentifierPart(char) {
  return /[A-Za-z0-9_$]/.test(char)
}

function readStringToken(line, start) {
  const quote = line[start]
  let index = start + 1
  let escaped = false

  while (index < line.length) {
    const char = line[index]
    if (escaped) {
      escaped = false
      index++
      continue
    }
    if (char === "\\") {
      escaped = true
      index++
      continue
    }
    index++
    if (char === quote) break
  }

  return line.slice(start, index)
}

function pushToken(tokens, text, type = "default") {
  if (!text) return
  const last = tokens.at(-1)
  if (last?.type === type) {
    last.text += text
    return
  }
  tokens.push({ text, type })
}

function highlightCodeLine(line, language = "") {
  const lang = normalizeLanguage(language)
  const keywords = KEYWORDS[lang] || (lang ? new Set() : KEYWORDS.javascript)
  const tokens = []
  let index = 0

  while (index < line.length) {
    const rest = line.slice(index)
    const char = line[index]

    if (/\s/.test(char)) {
      const match = rest.match(/^\s+/)[0]
      pushToken(tokens, match)
      index += match.length
      continue
    }

    if ((lang === "python" || lang === "yaml" || lang === "bash") && char === "#") {
      pushToken(tokens, rest, "comment")
      break
    }

    if ((lang === "javascript" || lang === "json") && rest.startsWith("//")) {
      pushToken(tokens, rest, "comment")
      break
    }

    if (lang === "javascript" && rest.startsWith("/*")) {
      const end = line.indexOf("*/", index + 2)
      const comment = end === -1 ? rest : line.slice(index, end + 2)
      pushToken(tokens, comment, "comment")
      index += comment.length
      continue
    }

    if (["'", "\"", "`"].includes(char)) {
      if (char === "`" && !["javascript", "bash"].includes(lang)) {
        pushToken(tokens, char, "punctuation")
        index++
        continue
      }

      const token = readStringToken(line, index)
      pushToken(tokens, token, "string")
      index += token.length
      continue
    }

    const numberMatch = rest.match(/^(?:0x[\da-fA-F]+|\d+(?:\.\d+)?)/)
    if (numberMatch) {
      pushToken(tokens, numberMatch[0], "number")
      index += numberMatch[0].length
      continue
    }

    if (isIdentifierStart(char)) {
      let end = index + 1
      while (end < line.length && isIdentifierPart(line[end])) end++

      const word = line.slice(index, end)
      const nextChar = line.slice(end).trimStart()[0]
      if (keywords.has(word)) pushToken(tokens, word, "keyword")
      else if (LITERALS.has(word)) pushToken(tokens, word, "literal")
      else if (nextChar === "(") pushToken(tokens, word, "function")
      else pushToken(tokens, word)

      index = end
      continue
    }

    if (/[-+*/%=!<>|&^~?:.]/.test(char)) {
      const match = rest.match(/^[-+*/%=!<>|&^~?:.]+/)[0]
      pushToken(tokens, match, "operator")
      index += match.length
      continue
    }

    pushToken(tokens, char, "punctuation")
    index++
  }

  return tokens
}

function renderHighlightedCodeLine(line, language, x, y) {
  const tokens = highlightCodeLine(line, language)
    .map(token => `<tspan fill="${CODE_COLORS[token.type] || CODE_COLORS.default}">${escapeXml(token.text)}</tspan>`)
    .join("")

  return `<text x="${x}" y="${y}" font-size="${CODE_FONT_SIZE}" fill="${CODE_COLORS.default}" font-family="Consolas, Cascadia Mono, monospace" xml:space="preserve">${tokens || " "}</text>`
}

function createTextBlock(type, text, options = {}) {
  const fontSize = options.fontSize || TEXT_FONT_SIZE
  const maxUnits = options.maxUnits || 36
  const lines = wrapText(stripInlineMarkdown(text), maxUnits)

  return {
    type,
    text: String(text || ""),
    lines,
    fontSize,
    lineHeight: options.lineHeight || TEXT_LINE_HEIGHT,
    fill: options.fill || "#1f2937",
    fontWeight: options.fontWeight || "400",
    prefix: options.prefix || "",
    height: lines.length * (options.lineHeight || TEXT_LINE_HEIGHT)
  }
}

function createCodeBlock(lines, language = "") {
  const wrappedLines = []

  // 58 units 对应 bubbleWidth 上限 820 时的 code 区有效宽度（留余量防止边距溢出）
  for (const line of lines.length ? lines : [""]) {
    wrappedLines.push(...wrapText(line || " ", 58))
  }

  const labelHeight = language ? 26 : 0
  return {
    type: "code",
    language: language.trim(),
    lines: wrappedLines,
    fontSize: CODE_FONT_SIZE,
    lineHeight: CODE_LINE_HEIGHT,
    labelHeight,
    height: wrappedLines.length * CODE_LINE_HEIGHT + labelHeight + 26
  }
}

function scoreCodeLanguage(lines, language) {
  const text = lines.join("\n")
  const nonEmptyLines = lines.filter(line => line.trim())
  const indentedLines = nonEmptyLines.filter(line => /^\s{2,}\S/.test(line)).length
  let score = 0

  if (language === "java") {
    score += (text.match(/^\s*(?:@[\w.]+(?:\([^)]*\))?|public|protected|private|static|final|abstract|class|interface|enum|record|package|import|return|throw|new|if|else|for|while|switch|try|catch)\b/gm) || []).length * 2
    score += (text.match(/[;{}]/g) || []).length
  } else if (language === "python") {
    score += (text.match(/^\s*(def|class|import|from|for|if|elif|else|while|try|except|with|return|print|break|continue)\b/gm) || []).length * 2
    score += (text.match(/:\s*$/gm) || []).length
    score += indentedLines
  } else if (language === "javascript") {
    score += (text.match(/^\s*(const|let|var|function|class|import|export|return|if|for|while|switch|try|catch)\b/gm) || []).length * 2
    score += (text.match(/=>|console\.|;\s*$|{\s*$|}\s*$/gm) || []).length
  } else if (language === "json") {
    score += /^\s*[{[]/.test(text) ? 3 : 0
    score += (text.match(/^\s*"[^"]+"\s*:/gm) || []).length * 2
  } else if (language === "yaml") {
    score += (text.match(/^\s*[\w.-]+\s*:\s*.+$/gm) || []).length
    score += (text.match(/^\s*-\s+[\w"']/gm) || []).length
  } else if (language === "bash") {
    score += (text.match(/^\s*(#!|cd|echo|export|grep|curl|wget|npm|pnpm|yarn|git|sudo|if|for|while)\b/gm) || []).length * 2
    score += (text.match(/\$\w+|\|\s*\w+|&&|\bfi\b|\bdone\b/g) || []).length
  }

  return score
}

function inferCodeLanguage(lines) {
  const candidates = ["java", "python", "javascript", "json", "yaml", "bash"]
  return candidates
    .map(language => ({ language, score: scoreCodeLanguage(lines, language) }))
    .sort((a, b) => b.score - a.score)[0]
}

const EXPLICIT_CODE_LANGUAGES = new Set([
  "java",
  "python",
  "py",
  "javascript",
  "js",
  "typescript",
  "ts",
  "json",
  "yaml",
  "yml",
  "bash",
  "sh"
])

function explicitCodeLanguageMarker(line = "") {
  const marker = String(line || "")
    .trim()
    .replace(/^[\'\"`]+|[\'\"`]+$/g, "")
    .toLowerCase()
  if (!EXPLICIT_CODE_LANGUAGES.has(marker)) return ""
  return normalizeLanguage(marker)
}

function looksLikeCodeLineForLanguage(line = "", language = "") {
  const source = String(line || "").trim()
  if (!source) return true
  const lang = normalizeLanguage(language)

  if (lang === "java") {
    return /[;{}]|^@[\w.]+(?:\([^)]*\))?$|^(?:public|protected|private|static|final|abstract|class|interface|enum|record|package|import|return|throw|new|if|else|for|while|switch|case|try|catch)\b|^[A-Z][A-Z0-9_]*\s*\([^)]*\)\s*[,;]?$/.test(source)
  }
  if (lang === "python") return /[:#]|^(?:def|class|import|from|for|if|elif|else|while|try|except|with|return|print)\b/.test(source)
  if (lang === "javascript") return /[;{}]|^(?:const|let|var|function|class|import|export|return|if|else|for|while|switch|try|catch)\b/.test(source)
  if (lang === "json") return /^[\[{]}]|^[\"'][^\"']+[\"']\s*:/.test(source)
  if (lang === "yaml") return /^[-\w.]+\s*:/.test(source)
  if (lang === "bash") return /^(?:#!|cd|echo|export|grep|curl|wget|npm|pnpm|yarn|git|sudo|if|for|while)\b|\$\w+|&&|\|/.test(source)
  return false
}

function normalizeImplicitCodeFences(text = "") {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n")
  const normalized = []
  let inFence = false

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (/^```\s*[^`]*$/.test(line)) {
      inFence = !inFence
      normalized.push(line)
      continue
    }
    if (inFence) {
      normalized.push(line)
      continue
    }

    const language = explicitCodeLanguageMarker(line)
    if (!language) {
      normalized.push(line)
      continue
    }

    const codeLines = []
    let cursor = index + 1
    while (cursor < lines.length) {
      const candidate = lines[cursor]
      if (!candidate.trim()) {
        const next = lines[cursor + 1]
        if (next !== undefined && looksLikeCodeLineForLanguage(next, language)) {
          codeLines.push(candidate)
          cursor++
          continue
        }
        break
      }
      if (!looksLikeCodeLineForLanguage(candidate, language)) break
      codeLines.push(candidate)
      cursor++
    }

    if (!codeLines.some(codeLine => codeLine.trim())) {
      normalized.push(line)
      continue
    }

    normalized.push(`\`\`\`${language}`)
    normalized.push(...codeLines)
    normalized.push("```")
    index = cursor - 1
  }

  return normalized.join("\n")
}

function looksLikeMarkdown(text) {
  const src = String(text || "")
  if (!src) return false

  // 强信号：以下任一命中即认为是 markdown
  // - markdown 二级以上标题 ## xxx / ### xxx（单 # 容易和 bash/python 行注释 "# 注释" 撞，剔除）
  if (/^#{2,3}\s+\S/m.test(src)) return true
  // - markdown 引用 > xxx（代码里 > 通常在行中而非行首）
  if (/^>\s+\S/m.test(src)) return true

  // 弱信号：单独命中不足以判定（避免和代码/yaml/shell 混淆），需要至少两类联合
  let weakSignals = 0
  // 加粗 **xxx**（至少 2 处）
  const boldMatches = src.match(/\*\*[^*\n]+\*\*/g)
  if (boldMatches && boldMatches.length >= 2) weakSignals++
  // 无序列表 - xxx / * xxx / + xxx（≥ 3 行）
  const listLines = src.split(/\r?\n/).filter(line => /^\s*[-*+]\s+\S/.test(line)).length
  if (listLines >= 3) weakSignals++
  // 有序列表 1. xxx 2. xxx（≥ 2 行）
  const orderedListLines = src.split(/\r?\n/).filter(line => /^\s*\d+\.\s+\S/.test(line)).length
  if (orderedListLines >= 2) weakSignals++
  // 行内代码 `xxx`（≥ 2 处）
  const inlineCode = src.match(/`[^`\n]+`/g)
  if (inlineCode && inlineCode.length >= 2) weakSignals++
  // markdown 链接 [text](url)：要求 url 像真 URL（含 :// 或 / 或 . 后缀），且 text 至少 2 字符
  // 这样 python/js 代码里 arr[i](x) / dict["k"](v) 不会误命中
  if (/\[[^\]\n]{2,}\]\((?:https?:\/\/|\/|\.\/|#)[^)\n]+\)/.test(src)) weakSignals++

  return weakSignals >= 2
}

function getPlainCodeBlock(text) {
  if (String(text).includes("```")) return null
  // markdown 特征明显的内容不走"无栅栏代码块"识别
  if (looksLikeMarkdown(text)) return null

  const rawLines = String(text || "").split(/\r?\n/)
  const lines = rawLines.filter(line => line.trim())
  if (lines.length < 3) return null

  let language = ""
  let codeLines = rawLines
  const firstTextLineIndex = rawLines.findIndex(line => line.trim())
  const firstTextLine = rawLines[firstTextLineIndex]?.trim().toLowerCase()

  if (firstTextLine && EXPLICIT_CODE_LANGUAGES.has(firstTextLine)) {
    language = normalizeLanguage(firstTextLine)
    codeLines = rawLines.slice(firstTextLineIndex + 1)
  }

  const inferred = inferCodeLanguage(codeLines)
  language ||= inferred.language

  const joinedCode = codeLines.join("\n")
  const hasKeywordLine = /^\s*(?:@[\w.]+(?:\([^)]*\))?|public|protected|private|static|final|abstract|class|interface|enum|record|package|import|return|throw|new|def|for|if|elif|else|while|from|print|break|continue|const|let|var|function|export|switch|try|catch)\b/m.test(joinedCode)
  const hasMultipleIndentedLines = codeLines.filter(line => /^\s{2,}\S/.test(line)).length >= 2
  const hasCodeOperator = /[A-Za-z_$][\w$.\[\]]*\s*(?:=|==|===|>|<|\+|-|\*|\/)/.test(joinedCode)
  const hasCodeBrackets = /[{}();]/.test(joinedCode)
  const hasCodeShape =
    inferred.score >= 5 ||
    (hasKeywordLine && (hasMultipleIndentedLines || hasCodeOperator || hasCodeBrackets)) ||
    (inferred.score >= 3 && hasCodeOperator && hasCodeBrackets)
  if (!hasCodeShape) return null

  return createCodeBlock(codeLines, language)
}

export function shouldUseDocumentTemplateForTextImage(text = "") {
  const content = String(text || "")
  if (!content.trim()) return false
  if (/```[\s\S]*```/.test(content)) return true
  if (normalizeImplicitCodeFences(content) !== content.replace(/\r\n/g, "\n")) return true
  if (looksLikeMarkdown(content)) return true
  return Boolean(getPlainCodeBlock(content))
}

function flushMarkdownLines(blocks, lines) {
  for (const rawLine of lines) {
    const line = rawLine.trimEnd()
    const trimmed = line.trim()

    if (!trimmed) {
      blocks.push({ type: "spacer", height: 14, lines: [] })
      continue
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/)
    if (heading) {
      blocks.push(
        createTextBlock("heading", heading[2], {
          fontSize: HEADING_FONT_SIZE,
          lineHeight: HEADING_LINE_HEIGHT,
          maxUnits: 30,
          fontWeight: "700",
          fill: "#111827"
        })
      )
      continue
    }

    const quote = trimmed.match(/^>\s?(.+)$/)
    if (quote) {
      blocks.push(
        createTextBlock("quote", quote[1], {
          fontSize: QUOTE_FONT_SIZE,
          lineHeight: QUOTE_LINE_HEIGHT,
          maxUnits: 36,
          fill: "#5b6472"
        })
      )
      continue
    }

    const list = trimmed.match(/^((?:[-*+])|(?:\d+\.))\s+(.+)$/)
    if (list) {
      blocks.push(createTextBlock("list", list[2], { prefix: list[1].match(/\d+\./) ? list[1] : "•" }))
      continue
    }

    blocks.push(createTextBlock("paragraph", line.trim(), { maxUnits: 36 }))
  }
}

function parseMarkdown(text) {
  const normalizedText = normalizeImplicitCodeFences(text)
  const plainCodeBlock = getPlainCodeBlock(normalizedText)
  if (plainCodeBlock) return [plainCodeBlock]

  const blocks = []
  const normalLines = []
  let inCode = false
  let codeLanguage = ""
  let codeLines = []

  for (const rawLine of normalizedText.split(/\r?\n/)) {
    const fence = rawLine.match(/^```\s*([^`]*)$/)
    if (fence) {
      if (inCode) {
        blocks.push(createCodeBlock(codeLines, codeLanguage))
        codeLines = []
        codeLanguage = ""
        inCode = false
      } else {
        flushMarkdownLines(blocks, normalLines.splice(0))
        codeLanguage = fence[1] || ""
        inCode = true
      }
      continue
    }

    if (inCode) codeLines.push(rawLine)
    else normalLines.push(rawLine)
  }

  if (inCode) blocks.push(createCodeBlock(codeLines, codeLanguage))
  flushMarkdownLines(blocks, normalLines)

  while (blocks[0]?.type === "spacer") blocks.shift()
  while (blocks.at(-1)?.type === "spacer") blocks.pop()

  return blocks.length ? blocks : [createTextBlock("paragraph", "")]
}

function measureBlockWidth(block) {
  if (block.type === "code") {
    const codeWidth = Math.max(...block.lines.map(line => measureTextWidth(line, block.fontSize, true)), 80)
    const labelWidth = block.language ? measureTextWidth(block.language, 14, true) + 24 : 0
    return Math.max(codeWidth + 28, labelWidth)
  }

  const prefixWidth = block.prefix ? measureTextWidth(`${block.prefix} `, block.fontSize) : 0
  return Math.max(...block.lines.map(line => prefixWidth + measureTextWidth(line, block.fontSize)), 80)
}

async function fetchAvatarDataUrl(avatarUrl) {
  if (!avatarUrl) return ""

  try {
    const response = await fetch(avatarUrl)
    if (!response.ok) return ""

    const contentType = response.headers.get("content-type") || "image/png"
    const buffer = Buffer.from(await response.arrayBuffer())
    return `data:${contentType};base64,${buffer.toString("base64")}`
  } catch {
    return ""
  }
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function deleteGeneratedFile(filePath) {
  for (let index = 0; index < DELETE_RETRY_DELAYS_MS.length; index++) {
    const delay = DELETE_RETRY_DELAYS_MS[index]
    if (delay > 0) await wait(delay)

    try {
      await fs.promises.unlink(filePath)
      return
    } catch (error) {
      if (error?.code === "ENOENT") return

      const canRetry = ["EBUSY", "EPERM"].includes(error?.code) && index < DELETE_RETRY_DELAYS_MS.length - 1
      if (canRetry) continue

      globalThis.logger?.warn?.(`[textImageTool] 清理临时图片失败：${error.message}`)
      return
    }
  }
}

function renderInlineMarkdownHtml(text = "") {
  return escapeXml(text)
    .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
}

function renderHighlightedCodeHtml(line, language = "") {
  return highlightCodeLine(line, language)
    .map(token => `<span class="token ${token.type}">${escapeXml(token.text)}</span>`)
    .join("") || " "
}

export function markdownToDocumentHtml(text = "") {
  const normalizedText = normalizeImplicitCodeFences(text)
  const html = []
  const paragraphLines = []
  let inCode = false
  let codeLanguage = ""
  let codeLines = []

  const flushParagraph = () => {
    if (!paragraphLines.length) return
    const joined = paragraphLines.join("\n").trim()
    paragraphLines.length = 0
    if (!joined) return

    const lines = joined.split(/\n+/).map(line => line.trim()).filter(Boolean)
    const allList = lines.every(line => /^\s*(?:[-*+•]|\d+\.)\s+\S/.test(line))
    if (allList) {
      html.push(`<ul>${lines.map(line => {
        const item = line.replace(/^\s*(?:[-*+•]|\d+\.)\s+/, "")
        return `<li>${renderInlineMarkdownHtml(item)}</li>`
      }).join("")}</ul>`)
      return
    }

    html.push(`<p>${renderInlineMarkdownHtml(joined).replace(/\n+/g, "<br>")}</p>`)
  }

  const flushCode = () => {
    const language = normalizeLanguage(codeLanguage)
    const label = language ? `<div class="code-label">${escapeXml(language)}</div>` : ""
    const code = codeLines
      .map(line => `<div class="code-line">${renderHighlightedCodeHtml(line, language)}</div>`)
      .join("")
    html.push(`<pre class="code-block">${label}<code>${code || '<div class="code-line"> </div>'}</code></pre>`)
    codeLines = []
    codeLanguage = ""
  }

  for (const rawLine of normalizedText.split(/\r?\n/)) {
    const fence = rawLine.match(/^```\s*([^`]*)$/)
    if (fence) {
      if (inCode) {
        flushCode()
        inCode = false
      } else {
        flushParagraph()
        codeLanguage = fence[1] || ""
        inCode = true
      }
      continue
    }

    if (inCode) {
      codeLines.push(rawLine)
      continue
    }

    if (!rawLine.trim()) {
      flushParagraph()
      continue
    }

    const heading = rawLine.match(/^\s*(#{1,3})\s+(.+)$/)
    if (heading) {
      flushParagraph()
      const level = Math.min(3, heading[1].length)
      html.push(`<h${level}>${renderInlineMarkdownHtml(heading[2].trim())}</h${level}>`)
      continue
    }

    const quote = rawLine.match(/^\s*>\s+(.+)$/)
    if (quote) {
      flushParagraph()
      html.push(`<blockquote>${renderInlineMarkdownHtml(quote[1].trim())}</blockquote>`)
      continue
    }

    paragraphLines.push(rawLine)
  }

  if (inCode) flushCode()
  flushParagraph()
  return html.join("\n") || "<p></p>"
}

export function markdownToKnowledgeHtml(text = "") {
  const normalizedText = normalizeImplicitCodeFences(text)
  const html = []
  const paragraphLines = []
  let inCode = false
  let codeLanguage = ""
  let codeLines = []
  let hasTitle = false
  let hasLead = false

  const flushParagraph = () => {
    if (!paragraphLines.length) return
    const lines = paragraphLines.splice(0)
      .map(line => line.trim())
      .filter(Boolean)
    if (!lines.length) return

    const ordered = lines.every(line => /^\d+[.、]\s+\S/.test(line))
    const unordered = lines.every(line => /^(?:[-*+•])\s+\S/.test(line))
    const keyValue = lines.map(line => line.match(/^(?:[-*+•]\s+)?(?:\*\*)?([^:：*]{1,28})(?:\*\*)?\s*[：:]\s*(.+)$/))

    if (ordered) {
      html.push(`<ol class="knowledge-steps">${lines.map(line => `<li>${renderInlineMarkdownHtml(line.replace(/^\d+[.、]\s+/, ""))}</li>`).join("")}</ol>`)
      return
    }
    if (unordered) {
      html.push(`<ul class="knowledge-checklist">${lines.map(line => `<li>${renderInlineMarkdownHtml(line.replace(/^(?:[-*+•])\s+/, ""))}</li>`).join("")}</ul>`)
      return
    }
    if (keyValue.every(Boolean) && keyValue.length >= 2) {
      html.push(`<dl class="knowledge-facts">${keyValue.map(match => `<div><dt>${renderInlineMarkdownHtml(match[1].trim())}</dt><dd>${renderInlineMarkdownHtml(match[2].trim())}</dd></div>`).join("")}</dl>`)
      return
    }

    const content = renderInlineMarkdownHtml(lines.join("\n")).replace(/\n+/g, "<br>")
    const className = hasTitle && !hasLead ? "knowledge-lead" : "knowledge-paragraph"
    html.push(`<p class="${className}">${content}</p>`)
    hasLead ||= hasTitle
  }

  const flushCode = () => {
    const language = normalizeLanguage(codeLanguage)
    const label = language ? `<div class="code-label">${escapeXml(language)}</div>` : ""
    const code = codeLines
      .map(line => `<div class="code-line">${renderHighlightedCodeHtml(line, language)}</div>`)
      .join("")
    html.push(`<pre class="code-block">${label}<code>${code || '<div class="code-line"> </div>'}</code></pre>`)
    codeLines = []
    codeLanguage = ""
  }

  for (const rawLine of normalizedText.split(/\r?\n/)) {
    const fence = rawLine.match(/^```\s*([^`]*)$/)
    if (fence) {
      if (inCode) {
        flushCode()
        inCode = false
      } else {
        flushParagraph()
        codeLanguage = fence[1] || ""
        inCode = true
      }
      continue
    }
    if (inCode) {
      codeLines.push(rawLine)
      continue
    }
    if (!rawLine.trim()) {
      flushParagraph()
      continue
    }

    const heading = rawLine.match(/^\s*(#{1,3})\s+(.+)$/)
    if (heading) {
      flushParagraph()
      const level = heading[1].length
      const title = renderInlineMarkdownHtml(heading[2].trim())
      if (!hasTitle && level === 1) {
        html.push(`<header class="knowledge-header"><div class="knowledge-kicker">知识说明</div><h1>${title}</h1></header>`)
        hasTitle = true
      } else if (level === 2) {
        html.push(`<h2>${title}</h2>`)
      } else {
        html.push(`<h3>${title}</h3>`)
      }
      continue
    }

    const quote = rawLine.match(/^\s*>\s+(.+)$/)
    if (quote) {
      flushParagraph()
      html.push(`<aside class="knowledge-note"><span>提示</span><p>${renderInlineMarkdownHtml(quote[1].trim())}</p></aside>`)
      continue
    }
    paragraphLines.push(rawLine)
  }

  if (inCode) flushCode()
  flushParagraph()
  return html.join("\n") || '<p class="knowledge-paragraph"></p>'
}

function buildDocumentHtml(text = "") {
  const theme = getRenderTheme()
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: ${theme.pageBg}; color: ${theme.text}; }
    body {
      position: relative;
      width: 980px;
      padding: 20px;
      font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", Arial, sans-serif;
      letter-spacing: 0;
    }
    body::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      background:
        ${theme.mode === "night"
          ? "radial-gradient(circle at 8% 92%, rgba(219,234,254,0.3) 0 28px, rgba(96,165,250,0.12) 29px 78px, transparent 80px), radial-gradient(circle at 12% 18%, rgba(255,255,255,0.9) 0 1px, transparent 2px), radial-gradient(circle at 24% 72%, rgba(255,255,255,0.66) 0 1px, transparent 2px), radial-gradient(circle at 78% 16%, rgba(191,219,254,0.88) 0 1.4px, transparent 2.6px), radial-gradient(circle at 88% 62%, rgba(255,255,255,0.7) 0 1px, transparent 2px), radial-gradient(circle at 50% 34%, rgba(147,197,253,0.36) 0 1px, transparent 2px), radial-gradient(circle at 7% 86%, rgba(255,255,255,0.9) 0 1.4px, transparent 2.6px), radial-gradient(circle at 14% 94%, rgba(191,219,254,0.86) 0 1px, transparent 2px), radial-gradient(circle at 19% 82%, rgba(255,255,255,0.72) 0 1px, transparent 2px)"
          : "radial-gradient(circle at 88% 12%, rgba(251,191,36,0.36) 0 46px, rgba(251,191,36,0.15) 47px 86px, transparent 88px), radial-gradient(circle at 12% 86%, rgba(96,165,250,0.18) 0 64px, transparent 66px)"};
    }
    body::after {
      content: "";
      position: fixed;
      inset: 14px;
      pointer-events: none;
      border-radius: 14px;
      border: 1px solid ${theme.mode === "night" ? "rgba(191, 219, 254, 0.2)" : "rgba(251, 191, 36, 0.22)"};
    }
    .document {
      position: relative;
      width: 940px;
      padding: 34px 42px;
      background: ${theme.cardBg};
      border: 1px solid ${theme.cardBorder};
      border-radius: 8px;
      box-shadow: ${theme.mode === "night"
        ? "0 18px 42px rgba(0, 0, 0, 0.38), inset 0 1px 0 rgba(255, 255, 255, 0.05)"
        : "0 14px 30px rgba(27, 39, 63, 0.12), inset 0 1px 0 rgba(255, 255, 255, 0.7)"};
      overflow: hidden;
    }
    .document::before {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background:
        ${theme.mode === "night"
          ? "linear-gradient(135deg, rgba(96,165,250,0.13), transparent 32%), radial-gradient(circle at 7% 92%, rgba(147,197,253,0.16) 0 52px, transparent 54px), radial-gradient(circle at 92% 8%, rgba(255,255,255,0.22) 0 1px, transparent 2px), radial-gradient(circle at 83% 26%, rgba(191,219,254,0.34) 0 1px, transparent 2px), radial-gradient(circle at 8% 18%, rgba(255,255,255,0.18) 0 1px, transparent 2px), radial-gradient(circle at 5% 89%, rgba(255,255,255,0.38) 0 1px, transparent 2px), radial-gradient(circle at 11% 96%, rgba(191,219,254,0.28) 0 1px, transparent 2px)"
          : "linear-gradient(135deg, rgba(251,191,36,0.12), transparent 36%), radial-gradient(circle at 92% 10%, rgba(251,191,36,0.24) 0 28px, transparent 30px)"};
    }
    .content { position: relative; z-index: 1; font-size: 25px; line-height: 1.62; }
    h1, h2, h3 {
      margin: 0 0 18px;
      color: ${theme.text};
      line-height: 1.28;
      font-weight: 800;
      letter-spacing: 0;
    }
    h1 { font-size: 34px; padding-bottom: 14px; border-bottom: 2px solid ${theme.mode === "night" ? "#26344d" : "#dde4ee"}; }
    h2 { margin-top: 26px; font-size: 31px; }
    h3 { margin-top: 22px; font-size: 28px; }
    p { margin: 0 0 16px; white-space: normal; overflow-wrap: anywhere; }
    ul { margin: 0 0 18px; padding-left: 32px; }
    li { margin: 0 0 8px; padding-left: 4px; overflow-wrap: anywhere; }
    blockquote {
      margin: 4px 0 18px;
      padding: 14px 18px;
      color: ${theme.muted};
      background: ${theme.quoteBg};
      border-left: 5px solid ${theme.quoteBorder};
      border-radius: 6px;
      overflow-wrap: anywhere;
    }
    strong { font-weight: 800; color: ${theme.text}; }
    .inline-code {
      padding: 2px 7px;
      border-radius: 5px;
      background: ${theme.inlineBg};
      color: ${theme.inlineText};
      font-family: Consolas, "SFMono-Regular", Menlo, monospace;
      font-size: 0.88em;
    }
    .code-block {
      position: relative;
      margin: 8px 0 18px;
      padding: 44px 20px 18px;
      overflow: hidden;
      border-radius: 8px;
      background: #111827;
      color: #e5e7eb;
      font-family: Consolas, "SFMono-Regular", Menlo, monospace;
      font-size: 20px;
      line-height: 1.55;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .code-label {
      position: absolute;
      top: 12px;
      left: 18px;
      color: #9ca3af;
      font-size: 15px;
      font-weight: 700;
      text-transform: uppercase;
    }
    .code-line { min-height: 31px; }
    .token.keyword { color: #c084fc; }
    .token.string { color: #86efac; }
    .token.number { color: #fbbf24; }
    .token.comment { color: #7dd3fc; }
    .token.literal { color: #f472b6; }
    .token.function { color: #93c5fd; }
    .token.operator { color: #f9a8d4; }
    .token.punctuation { color: #94a3b8; }
  </style>
</head>
<body>
  <main class="document">
    <article class="content">${markdownToDocumentHtml(text)}</article>
  </main>
</body>
</html>`
}

function buildKnowledgeHtml(text = "") {
  const theme = getRenderTheme()
  const accent = theme.mode === "night" ? "#7dd3fc" : "#2563eb"
  const accentSoft = theme.mode === "night" ? "rgba(125, 211, 252, 0.12)" : "#e8f0ff"
  const divider = theme.mode === "night" ? "#334155" : "#d7e0eb"
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: ${theme.pageBg}; color: ${theme.text}; }
    body { width: 980px; padding: 20px; font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", Arial, sans-serif; letter-spacing: 0; }
    .knowledge { width: 940px; min-height: 1px; padding: 36px 42px 42px; background: ${theme.cardBg}; border: 1px solid ${theme.cardBorder}; border-top: 7px solid ${accent}; border-radius: 8px; box-shadow: ${theme.mode === "night" ? "0 16px 38px rgba(0,0,0,0.32)" : "0 12px 28px rgba(27,39,63,0.12)"}; }
    .knowledge-header { margin: 0 0 24px; padding-bottom: 22px; border-bottom: 1px solid ${divider}; }
    .knowledge-kicker { margin-bottom: 8px; color: ${accent}; font-size: 17px; font-weight: 800; line-height: 1; }
    h1, h2, h3 { margin: 0; color: ${theme.text}; font-weight: 800; line-height: 1.32; letter-spacing: 0; }
    h1 { font-size: 40px; }
    h2 { margin-top: 32px; padding: 0 0 10px 16px; border-bottom: 1px solid ${divider}; border-left: 5px solid ${accent}; font-size: 30px; }
    h3 { margin-top: 24px; color: ${theme.text}; font-size: 26px; }
    .knowledge-lead, .knowledge-paragraph { margin: 0 0 18px; font-size: 25px; line-height: 1.7; overflow-wrap: anywhere; }
    .knowledge-lead { padding: 18px 20px; background: ${accentSoft}; border-radius: 6px; font-weight: 600; }
    .knowledge-steps, .knowledge-checklist { margin: 12px 0 22px; padding: 0; list-style: none; counter-reset: knowledge-step; }
    .knowledge-steps li, .knowledge-checklist li { position: relative; min-height: 38px; margin: 0 0 12px; padding: 13px 16px 13px 58px; background: ${theme.quoteBg}; border-left: 3px solid ${accent}; border-radius: 5px; font-size: 24px; line-height: 1.58; overflow-wrap: anywhere; }
    .knowledge-steps li::before { counter-increment: knowledge-step; content: counter(knowledge-step); position: absolute; left: 16px; top: 13px; width: 27px; height: 27px; border-radius: 50%; background: ${accent}; color: ${theme.mode === "night" ? "#082f49" : "#fff"}; text-align: center; font-size: 16px; font-weight: 800; line-height: 27px; }
    .knowledge-checklist li::before { content: "✓"; position: absolute; left: 18px; top: 12px; color: ${accent}; font-size: 24px; font-weight: 800; }
    .knowledge-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin: 12px 0 22px; }
    .knowledge-facts div { padding: 14px 16px; background: ${theme.quoteBg}; border: 1px solid ${divider}; border-radius: 5px; }
    .knowledge-facts dt { margin-bottom: 6px; color: ${theme.subtle}; font-size: 17px; font-weight: 700; }
    .knowledge-facts dd { margin: 0; font-size: 23px; font-weight: 700; line-height: 1.5; overflow-wrap: anywhere; }
    .knowledge-note { display: flex; gap: 13px; margin: 16px 0 22px; padding: 16px 18px; background: ${accentSoft}; border: 1px solid ${divider}; border-radius: 6px; }
    .knowledge-note span { flex: 0 0 auto; color: ${accent}; font-size: 18px; font-weight: 800; line-height: 1.7; }
    .knowledge-note p { margin: 0; font-size: 24px; line-height: 1.65; overflow-wrap: anywhere; }
    strong { color: ${theme.text}; font-weight: 800; }
    .inline-code { padding: 2px 7px; border-radius: 4px; background: ${theme.inlineBg}; color: ${theme.inlineText}; font-family: Consolas, "SFMono-Regular", Menlo, monospace; font-size: 0.88em; }
    .code-block { position: relative; margin: 12px 0 22px; padding: 44px 20px 18px; overflow: hidden; border-radius: 6px; background: #111827; color: #e5e7eb; font-family: Consolas, "SFMono-Regular", Menlo, monospace; font-size: 20px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
    .code-label { position: absolute; top: 12px; left: 18px; color: #9ca3af; font-size: 15px; font-weight: 700; text-transform: uppercase; }
    .code-line { min-height: 31px; }
    .token.keyword { color: #c084fc; } .token.string { color: #86efac; } .token.number { color: #fbbf24; } .token.comment { color: #7dd3fc; } .token.literal { color: #f472b6; } .token.function { color: #93c5fd; } .token.operator { color: #f9a8d4; } .token.punctuation { color: #94a3b8; }
  </style>
</head>
<body>
  <main class="knowledge">${markdownToKnowledgeHtml(text)}</main>
</body>
</html>`
}

export class TextImageTool extends AbstractTool {
  constructor() {
    super()
    this.name = "textImageTool"
    this.description =
      "把文字、Markdown 或代码内容渲染成图片并发送。普通短文本使用 QQ 聊天气泡；代码、Markdown 用 document 文档卡；科普、技术讲解、推导和入门路线用 knowledge 知识卡，它会把标题、结论、步骤、清单、提示和代码块排成易读的层级。用户明确要求纯文本、Markdown 原文或代码原文时不要擅自转图。"
    this.parameters = {
      type: "object",
      properties: {
        text: {
          type: "string",
          description: "需要转成图片发送的完整内容。用户要求写代码、示例代码、算法实现、Markdown/MD 文档、科普讲解、公式推导时，请把生成好的完整内容放在这里"
        },
        nickname: {
          type: "string",
          description: "图片中显示的昵称，不填则使用机器人昵称"
        },
        avatarUrl: {
          type: "string",
          description: "图片左侧头像链接，不填则使用机器人 QQ 头像"
        },
        template: {
          type: "string",
          enum: ["chat", "document", "knowledge"],
          description: "渲染模板。chat 为普通短文本聊天气泡；document 为代码或 Markdown 文档卡；knowledge 为科普和技术讲解的结构化知识卡"
        }
      },
      required: ["text"],
      additionalProperties: false
    }
  }

  async func(opts, e) {
    const text = personaFeedbackManager.guardReply(String(opts.text || "").trim(), pluginBridge.instance?.config?.personaGuard, {
      userText: e?.msg || "",
      botNames: [e?.bot?.nickname, pluginBridge.instance?.config?.persona?.name]
    })
    if (!text) return "error: text 不能为空"

    const rawTemplate = String(opts.template || "").trim()
    const shouldUseDocument = shouldUseDocumentTemplateForTextImage(text)
    const template = rawTemplate === "knowledge"
      ? "knowledge"
      : shouldUseDocument || rawTemplate === "document" || rawTemplate === "html" || rawTemplate.startsWith("parchment")
        ? "document"
        : "chat"
    const maxTextLength = template === "chat" ? CHAT_MAX_TEXT_LENGTH : DOCUMENT_MAX_TEXT_LENGTH
    const safeText = safeTruncateUnicode(text, maxTextLength)
    const nickname = String(opts.nickname || "").trim()
    const avatarUrl = String(opts.avatarUrl || "").trim()
    let imagePath = ""
    const startedAt = Date.now()

    try {
      imagePath = template === "document" || template === "knowledge"
        ? await this.renderDocumentImage({ text: safeText, template })
        : await this.renderChatImage({
            text: safeText,
            nickname,
            avatarUrl
          })

      const renderedAt = Date.now()
      await e.reply(segment.image(imagePath))
      const sentAt = Date.now()
      globalThis.logger?.info?.(`[textImageTool] timing template=${template} render=${renderedAt - startedAt}ms send=${sentAt - renderedAt}ms total=${sentAt - startedAt}ms`)
      return "已将文字、Markdown 或代码转为图片发送成功，不需要再重复发送原始内容，绝对不要以文本形式发送代码和markdown内容，会导致严重群内刷屏！！！。"
    } finally {
      if (imagePath) await deleteGeneratedFile(imagePath)
    }
  }

  async renderDocumentImage({ text, template = "document" }) {
    const outputDir = path.join(process.cwd(), "resources", "bl-chat-plugin", "safe_text_images")
    await fs.promises.mkdir(outputDir, { recursive: true })
    const outputPath = path.join(
      outputDir,
      `safe_text_${template}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`
    )

    let page
    try {
      const browser = await getSharedBrowser()
      page = await browser.newPage()
      await page.setViewport({ width: 980, height: 1200, deviceScaleFactor: 2 })
      const html = template === "knowledge" ? buildKnowledgeHtml(text) : buildDocumentHtml(text)
      await page.setContent(html, { waitUntil: "domcontentloaded", timeout: 60000 })
      const clip = await page.evaluate(() => {
        const body = document.body
        const height = Math.ceil(body.getBoundingClientRect().height)
        return { x: 0, y: 0, width: 980, height: Math.max(1, height) }
      })
      await page.screenshot({ path: outputPath, clip, type: "png" })
      return outputPath
    } catch (error) {
      await deleteGeneratedFile(outputPath)
      throw error
    } finally {
      if (page) await page.close().catch(() => {})
      scheduleSharedBrowserClose()
    }
  }

  async renderChatImage({ text, nickname, avatarUrl }) {
    const outputDir = path.join(process.cwd(), "resources", "bl-chat-plugin", "safe_text_images")
    await fs.promises.mkdir(outputDir, { recursive: true })

    const theme = getRenderTheme()
    const avatarDataUrl = await fetchAvatarDataUrl(avatarUrl)
    const hasIdentity = Boolean(nickname || avatarDataUrl)
    const blocks = parseMarkdown(text)
    const bubblePaddingX = 28
    const bubblePaddingY = 24
    const maxContentWidth = Math.max(...blocks.map(measureBlockWidth), 140)
    const bubbleWidth = Math.min(820, Math.max(210, Math.ceil(maxContentWidth + bubblePaddingX * 2)))
    const contentWidth = bubbleWidth - bubblePaddingX * 2
    const contentHeight = blocks.reduce((sum, block, index) => {
      const gap = index > 0 && block.type !== "spacer" ? 12 : 0
      return sum + block.height + gap
    }, 0)
    const bubbleHeight = Math.max(76, contentHeight + bubblePaddingY * 2)
    const avatarX = 28
    const avatarY = 28
    const bubbleX = hasIdentity ? avatarX + AVATAR_SIZE + 26 : 28
    const nameY = avatarY + 19
    const bubbleY = hasIdentity ? avatarY + 36 : 28
    const width = bubbleX + bubbleWidth + 28
    const height = hasIdentity
      ? Math.max(avatarY + AVATAR_SIZE + 28, bubbleY + bubbleHeight + 28)
      : bubbleY + bubbleHeight + 28
    const contentX = bubbleX + bubblePaddingX
    let currentY = bubbleY + bubblePaddingY

    const blockSvg = blocks
      .map((block, index) => {
        if (index > 0 && block.type !== "spacer") currentY += 12

        if (block.type === "spacer") {
          currentY += block.height
          return ""
        }

        if (block.type === "code") {
          const rectY = currentY
          const rectHeight = block.height
          const labelSvg = block.language
            ? `<text x="${contentX + 14}" y="${rectY + 21}" font-size="14" fill="#9ca3af" font-family="Consolas, Cascadia Mono, monospace">${escapeXml(block.language)}</text>`
            : ""
          const firstLineY = rectY + 18 + block.labelHeight + CODE_FONT_SIZE
          const linesSvg = block.lines
            .map(
              (line, lineIndex) =>
                renderHighlightedCodeLine(line, block.language, contentX + 14, firstLineY + lineIndex * CODE_LINE_HEIGHT)
            )
            .join("")

          currentY += block.height
          return `
  <rect x="${contentX - 2}" y="${rectY}" width="${contentWidth + 4}" height="${rectHeight}" rx="12" fill="#111827"/>
  ${labelSvg}
  ${linesSvg}`
        }

        const prefixWidth = block.prefix ? measureTextWidth(`${block.prefix} `, block.fontSize) : 0
        const lineX = contentX + prefixWidth
        const textFill = block.type === "quote" ? theme.chatQuoteText : theme.chatText
        const prefixSvg = block.prefix
          ? `<text x="${contentX}" y="${currentY + block.fontSize}" font-size="${block.fontSize}" fill="${theme.chatText}" font-family="Microsoft YaHei, Noto Sans CJK SC, Arial">${escapeXml(block.prefix)}</text>`
          : ""
        const quoteSvg =
          block.type === "quote"
            ? `<rect x="${contentX - 12}" y="${currentY + 2}" width="4" height="${block.height - 4}" rx="2" fill="${theme.mode === "night" ? "#8fb6ff" : "#c9d2df"}"/>`
            : ""
        const linesSvg = block.lines
          .map(
            (line, lineIndex) =>
              `<tspan x="${lineX}" y="${currentY + block.fontSize + lineIndex * block.lineHeight}">${escapeXml(line)}</tspan>`
          )
          .join("")

        currentY += block.height
        return `
  ${quoteSvg}
  ${prefixSvg}
  <text font-size="${block.fontSize}" fill="${textFill}" font-weight="${block.fontWeight}" font-family="Microsoft YaHei, Noto Sans CJK SC, Arial" dominant-baseline="alphabetic">
    ${linesSvg}
  </text>`
      })
      .join("")

    const avatarSvg = avatarDataUrl
      ? `<image href="${avatarDataUrl}" x="${avatarX}" y="${avatarY}" width="${AVATAR_SIZE}" height="${AVATAR_SIZE}" clip-path="url(#avatarClip)" preserveAspectRatio="xMidYMid slice"/>`
      : ""
    const nameSvg = nickname
      ? `<text x="${bubbleX}" y="${nameY}" font-size="18" fill="${theme.chatName}" font-family="Microsoft YaHei, Arial">${escapeXml(nickname)}</text>`
      : ""
    const tailSvg = hasIdentity
      ? `<path d="M ${bubbleX - 10} ${bubbleY + 26} L ${bubbleX + 4} ${bubbleY + 18} L ${bubbleX + 4} ${bubbleY + 34} Z" fill="${theme.chatBubble}"/>`
      : ""

    const decorationSvg = theme.mode === "night"
      ? `
  <circle cx="${Math.max(26, width - 86)}" cy="28" r="1.4" fill="#ffffff" opacity="0.88"/>
  <circle cx="${Math.max(32, width - 42)}" cy="74" r="1.1" fill="#bfdbfe" opacity="0.82"/>
  <circle cx="42" cy="${Math.max(34, height - 34)}" r="23" fill="#60a5fa" opacity="0.08"/>
  <circle cx="34" cy="${Math.max(34, height - 28)}" r="1.7" fill="#ffffff" opacity="0.9"/>
  <circle cx="58" cy="${Math.max(38, height - 48)}" r="1.2" fill="#bfdbfe" opacity="0.82"/>
  <circle cx="82" cy="${Math.max(40, height - 22)}" r="1" fill="#ffffff" opacity="0.68"/>
  <path d="M 54 ${Math.max(34, height - 32)} l7 0 m-3.5 -3.5 l0 7" stroke="#dbeafe" stroke-width="1.5" stroke-linecap="round" opacity="0.84"/>
  <circle cx="${Math.max(44, width - 138)}" cy="${Math.max(36, height - 38)}" r="1" fill="#93c5fd" opacity="0.66"/>
  <path d="M ${Math.max(40, width - 118)} 42 l4 0 m-2 -2 l0 4" stroke="#dbeafe" stroke-width="1.4" stroke-linecap="round" opacity="0.78"/>`
      : `
  <circle cx="${Math.max(58, width - 58)}" cy="46" r="24" fill="#fbbf24" opacity="0.28"/>
  <circle cx="${Math.max(58, width - 58)}" cy="46" r="39" fill="none" stroke="#fbbf24" stroke-width="2" opacity="0.14"/>
  <path d="M ${Math.max(58, width - 58)} 8 v13 M ${Math.max(58, width - 58)} 71 v13 M ${Math.max(24, width - 96)} 46 h13 M ${Math.max(22, width - 19)} 46 h13" stroke="#f59e0b" stroke-width="3" stroke-linecap="round" opacity="0.22"/>`

    const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <clipPath id="avatarClip">
      <circle cx="${avatarX + AVATAR_SIZE / 2}" cy="${avatarY + AVATAR_SIZE / 2}" r="${AVATAR_SIZE / 2}"/>
    </clipPath>
    <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="2" stdDeviation="4" flood-color="${theme.chatShadow}" flood-opacity="${theme.mode === "night" ? "0.62" : "0.75"}"/>
    </filter>
  </defs>
  <rect width="100%" height="100%" fill="${theme.chatBg}"/>
  ${decorationSvg}
  ${avatarSvg}
  ${nameSvg}
  ${tailSvg}
  <rect x="${bubbleX}" y="${bubbleY}" width="${bubbleWidth}" height="${bubbleHeight}" rx="18" fill="${theme.chatBubble}" stroke="${theme.chatBubbleBorder}" stroke-width="1" filter="url(#softShadow)"/>
  ${blockSvg}
</svg>`

    const outputPath = path.join(
      outputDir,
      `safe_text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`
    )

    try {
      await sharp(Buffer.from(svg)).png().toFile(outputPath)
      return outputPath
    } catch (error) {
      await deleteGeneratedFile(outputPath)
      throw error
    }
  }
}
