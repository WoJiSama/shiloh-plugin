const EXCEL_FILE_PATTERN = /\.(?:xlsx|xlsm|xltx|xltm|xls|xlt)(?:$|[?#\s\]\)）])/i
const EXCEL_SIGNAL_PATTERN = /(?:\bexcel\b|\.(?:xlsx|xlsm|xltx|xltm|xls|xlt)\b|工作簿|工作表|表格|\bsheet\b|\btab\b|tab页|单元格|格子|群文件)/i
const LIST_SHEETS_PATTERN = /(?:有哪些|列出|看看|查看|显示).{0,10}(?:工作表|sheet|tab)|(?:工作表|sheet|tab).{0,10}(?:有哪些|列表)/i
const LIST_GROUP_FILES_PATTERN = /(?:群文件).{0,16}(?:哪些|列出|列表|有什么).{0,8}(?:excel|表格|工作簿)?|(?:哪些|列出|列表).{0,8}(?:群文件).{0,8}(?:excel|表格|工作簿)/i
const EXCEL_ACTION_PATTERN = /(?:查|找|搜索|检索|定位|看|读取|读一下|告诉我|有没有|是否有|列出|显示|分析|检查)/i
const EXCEL_EXPLORATION_PATTERN = /(?:附近|周围|上下|左右|相邻|开头|起始|结尾|末尾|等于|包含|含有|公式|值|地址|坐标|哪一格|哪个格子|单元格)/i

const CHINESE_DIGITS = new Map([
  ["零", 0], ["〇", 0], ["一", 1], ["二", 2], ["两", 2], ["三", 3], ["四", 4],
  ["五", 5], ["六", 6], ["七", 7], ["八", 8], ["九", 9]
])

function normalizeText(text = "") {
  return String(text || "")
    .replace(/\[CQ:[^\]]+\]/g, " ")
    .replace(/^\s*希洛[，,：:\s]*/i, "")
    .replace(/\s+/g, " ")
    .trim()
}

export function hasExcelWorkbookContext({ text = "", media = [] }:{text?:string;media?:unknown[]} = {}) {
  if (EXCEL_FILE_PATTERN.test(String(text || ""))) return true
  return Array.isArray(media) && media.some(value => {
    const asset=value!==null&&typeof value==='object'?value as Record<string,unknown>:{}
    if (asset?.type && asset.type !== "file") return false
    return EXCEL_FILE_PATTERN.test(String(asset?.fileName || asset?.name || asset?.source || ""))
  })
}

function parseChineseNumber(value = "") {
  const text = String(value || "").trim()
  if (/^\d+$/.test(text)) return Number(text)
  if (!text) return null
  if (text === "十") return 10
  const tenIndex = text.indexOf("十")
  if (tenIndex >= 0) {
    const tens = tenIndex === 0 ? 1 : CHINESE_DIGITS.get(text[tenIndex - 1] || '')
    const ones = tenIndex === text.length - 1 ? 0 : CHINESE_DIGITS.get(text[tenIndex + 1] || '')
    if (tens!==undefined && ones!==undefined && Number.isInteger(tens) && Number.isInteger(ones)) return (tens * 10) + ones
    return null
  }
  if (text.length === 1 && CHINESE_DIGITS.has(text)) return CHINESE_DIGITS.get(text)
  return null
}

export function extractExcelSheetReference(text = "") {
  const content = normalizeText(text)
    .replace(/[^\s，。,.!?！？/\\]+\.(?:xlsx|xlsm|xltx|xltm)(?:里|中|里面|中的|里的)?/gi, " ")
  const ordinal = content.match(/第\s*([零〇一二两三四五六七八九十\d]{1,4})\s*(?:个)?\s*(?:tab(?:页)?|sheet|工作表)/i)
  if (ordinal) {
    const index = parseChineseNumber(ordinal[1])
    if (index!=null && Number.isInteger(index) && index > 0 && index <= 100) return String(index)
  }

  const numeric = content.match(/(?:tab|sheet|工作表)\s*[#第]?\s*(\d{1,3})\b/i)
  if (numeric && Number(numeric[1]) > 0 && Number(numeric[1]) <= 100) return String(Number(numeric[1]))

  const named = content.match(/(?:在|读取|搜索|查|看|读)?\s*([^\s，。,.]{1,30}?)\s*(?:这个|该)?\s*(?:tab(?:页)?|sheet|工作表)/i)
  const candidate = String(named?.[1] || "")
    .trim()
    .replace(/^(?:(?:帮我|请|查|看|读|读取|打开)|(?:群文件|文件)(?:里|中|里面|中的|里的)?)+/g, "")
    .replace(/^(?:第?[零〇一二两三四五六七八九十\d]+个?)$/, "")
  if (candidate && !/^(?:这个|该|某个|哪个|里面|文件)$/.test(candidate)) return candidate
  return ""
}

function cleanSearchQuery(value = "") {
  return String(value || "")
    .trim()
    .replace(/^[“”"'‘’]+|[“”"'‘’，。！？?]+$/g, "")
    .replace(/^(?:内容|文字|数据)[:：]?\s*/, "")
    .trim()
}

export function extractExcelSearchQuery(text = "") {
  const content = normalizeText(text)
  const patterns = [
    /(?:跟|和|与)\s*[“"']?(.{1,50}?)[”"']?\s*(?:有关|相关)(?:的内容)?/i,
    /(?:找|查|搜索|检索)(?:到|一下|一下子)?\s*[“"']?(.{1,50}?)[”"']?\s*(?:有关|相关|的内容)/i,
    /(?:包含|含有)\s*[“"']?(.{1,50}?)[”"']?(?:\s*的内容)?/i
  ]
  for (const pattern of patterns) {
    const match = content.match(pattern)
    const query = cleanSearchQuery(match?.[1])
    if (query) return query
  }
  return ""
}

export function getExcelRelatedTerms(query = "") {
  const normalized = String(query || "").trim().toLowerCase().replace(/\s+/g, "")
  if (/^\.?st(?:指令|命令)?$/.test(normalized)) {
    return [
      "属性", "技能", "STR", "CON", "SIZ", "DEX", "APP", "INT", "POW", "EDU",
      "Luck", "HP", "MP", "SAN", "力量", "体质", "体型", "敏捷", "外貌", "智力", "意志", "教育", "幸运", "理智"
    ]
  }
  return []
}

function extractFileName(text = "") {
  let candidate = String(normalizeText(text).match(/([^\s，。,.!?！？/\\]{1,120}\.(?:xlsx|xlsm|xltx|xltm))\b/i)?.[1] || "").trim()
  let previous = ""
  while (candidate && candidate !== previous) {
    previous = candidate
    candidate = candidate.replace(/^(?:帮我|请|查|看|读|读取|打开|群文件(?:里|中|里面|中的|里的)?|文件(?:里|中|里面|中的|里的)?)/, "")
  }
  return candidate
}

export function buildExcelToolParams(text = "", options:{hasExcelContext?:boolean} = {}) {
  const content = normalizeText(text)
  if (!content) return null
  const hasContext = options.hasExcelContext === true
  if (!hasContext && !EXCEL_SIGNAL_PATTERN.test(content)) return null

  const fileName = extractFileName(content)
  const common = fileName ? { fileName } : {}
  if (LIST_GROUP_FILES_PATTERN.test(content)) {
    return { operation: "list_group_excels", ...common }
  }

  const sheetName = extractExcelSheetReference(content)
  const range = content.match(/\b(\$?[A-Z]{1,3}\$?[1-9]\d{0,6}:\$?[A-Z]{1,3}\$?[1-9]\d{0,6})\b/i)?.[1]
  if (range) return { operation: "read_range", sheetName: sheetName || undefined, range: range.toUpperCase(), ...common }

  const cell = content.match(/\b(\$?[A-Z]{1,3}\$?[1-9]\d{0,6})\b/i)?.[1]
  if (cell) return { operation: "read_cell", sheetName: sheetName || undefined, cell: cell.toUpperCase(), ...common }

  const query = extractExcelSearchQuery(content)
  if (query) {
    const relatedTerms = getExcelRelatedTerms(query)
    return {
      operation: "find",
      sheetName: sheetName || undefined,
      query,
      ...(relatedTerms.length ? { relatedTerms } : {}),
      searchIn: "all",
      ...common
    }
  }

  if (LIST_SHEETS_PATTERN.test(content)) return { operation: "list_sheets", ...common }
  return null
}

/**
 * Only decides whether the workbook tool should be offered/required. It does
 * not translate open-ended natural language into fixed parameters; the model
 * receives the tool schema and chooses the appropriate operation and scope.
 */
export function shouldUseExcelWorkbookTool(text = "", options:{hasExcelContext?:boolean} = {}) {
  const content = normalizeText(text)
  if (!content) return false
  if (buildExcelToolParams(content, options)) return true
  const hasWorkbookContext = options.hasExcelContext === true
  const hasExcelSignal = EXCEL_SIGNAL_PATTERN.test(content)
  if (!hasWorkbookContext && !hasExcelSignal) return false
  return EXCEL_ACTION_PATTERN.test(content) && (hasExcelSignal || EXCEL_EXPLORATION_PATTERN.test(content))
}

export function shouldBypassMergeForExcel(text = "", options:{hasExcelContext?:boolean} = {}) {
  return shouldUseExcelWorkbookTool(text, options)
}
