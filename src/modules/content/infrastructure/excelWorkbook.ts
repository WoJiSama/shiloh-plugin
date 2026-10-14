import ExcelJS from "exceljs"

const MAX_EXCEL_ROWS = 1_048_576
const MAX_EXCEL_COLUMNS = 16_384
const DEFAULT_MAX_RANGE_CELLS = 300
const DEFAULT_MAX_SEARCH_CELLS = 50_000
const DEFAULT_MAX_SEARCH_RESULTS = 30
type Scalar = undefined | null | string | number | boolean | Scalar[] | {[key:string]:Scalar}
type Bounds = ReturnType<typeof parseExcelRange>
type SerializedCell = ReturnType<typeof serializeExcelCell>
interface SearchIndex {cells:SerializedCell[];scannedCells:number;truncated:boolean}
interface SearchOptions {sheetName?:string|undefined;query?:string|undefined;relatedTerms?:string[]|undefined;searchIn?:string|undefined;matchMode?:string|undefined;range?:string|undefined;anchorCell?:string|undefined;rowRadius?:number|undefined;columnRadius?:number|undefined;limit?:number|undefined;maxScannedCells?:number|undefined}
const record=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'?value as Record<string,unknown>:{}
const workbookSearchIndexCache = new WeakMap<ExcelJS.Workbook,Map<string,SearchIndex>>()

function columnNameToNumber(name = "") {
  let value = 0
  for (const char of String(name).toUpperCase()) {
    if (char < "A" || char > "Z") return 0
    value = (value * 26) + (char.charCodeAt(0) - 64)
  }
  return value
}

function columnNumberToName(number:unknown) {
  let value = Number(number)
  let result = ""
  while (value > 0) {
    value--
    result = String.fromCharCode(65 + (value % 26)) + result
    value = Math.floor(value / 26)
  }
  return result
}

export function normalizeExcelCellAddress(address = "") {
  const match = String(address || "").trim().replaceAll("$", "").match(/^([A-Za-z]{1,3})([1-9]\d{0,6})$/)
  if (!match) throw new Error(`无效的单元格地址: ${address || "(空)"}`)
  const column = columnNameToNumber(match?.[1] || '')
  const row = Number(match?.[2])
  if (column < 1 || column > MAX_EXCEL_COLUMNS || row < 1 || row > MAX_EXCEL_ROWS) {
    throw new Error(`单元格地址超出 Excel 范围: ${address}`)
  }
  return `${columnNumberToName(column)}${row}`
}

export function parseExcelRange(range = "") {
  const parts = String(range || "").trim().split(":")
  if (parts.length < 1 || parts.length > 2) throw new Error(`无效的单元格区域: ${range || "(空)"}`)
  const start = normalizeExcelCellAddress(parts[0])
  const end = normalizeExcelCellAddress(parts[1] || parts[0])
  const parse = (address:string) => {
    const match = address.match(/^([A-Z]+)(\d+)$/)
    return { column: columnNameToNumber(match?.[1] || ''), row: Number(match?.[2]) }
  }
  const a = parse(start)
  const b = parse(end)
  const bounds = {
    startRow: Math.min(a.row, b.row),
    endRow: Math.max(a.row, b.row),
    startColumn: Math.min(a.column, b.column),
    endColumn: Math.max(a.column, b.column)
  }
  return {
    ...bounds,
    address: `${columnNumberToName(bounds.startColumn)}${bounds.startRow}:${columnNumberToName(bounds.endColumn)}${bounds.endRow}`,
    cellCount: (bounds.endRow - bounds.startRow + 1) * (bounds.endColumn - bounds.startColumn + 1)
  }
}

function normalizeScalar(value:unknown):Scalar {
 if(value===undefined||value===null||typeof value==='string'||typeof value==='number'||typeof value==='boolean')return value
 if(value instanceof Date)return value.toISOString()
 if(Array.isArray(value))return value.map(normalizeScalar)
 const object=record(value)
 if(typeof object.error==='string')return object.error
 if(Array.isArray(object.richText))return object.richText.map(item=>String(record(item).text||'')).join('')
 if(typeof object.text==='string'&&object.hyperlink)return object.text
 if(typeof object.hyperlink==='string')return object.hyperlink
 if(object.formula||object.sharedFormula)return normalizeScalar(object.result)
 const result:{[key:string]:Scalar}={}
 for(const [key,nested]of Object.entries(object))result[key]=normalizeScalar(nested)
 return result
}

function resolveMergedCell(cell:ExcelJS.Cell) {
  if (!cell?.isMerged || !cell?.master) return cell
  return cell.master
}

function normalizeDisplayValue(sourceCell:ExcelJS.Cell, normalizedValue:Scalar) {
  const text = String(sourceCell?.text ?? "")
  if (text && text !== "[object Object]") return text
  if (normalizedValue === undefined || normalizedValue === null) return ""
  if (typeof normalizedValue === "string") return normalizedValue
  if (typeof normalizedValue === "object") {
    try { return JSON.stringify(normalizedValue) } catch { return "" }
  }
  return String(normalizedValue)
}

export function serializeExcelCell(cell:ExcelJS.Cell, requestedAddress = "") {
  const sourceCell = resolveMergedCell(cell)
  const formula = sourceCell?.formula || record(sourceCell?.value).formula || record(sourceCell?.value).sharedFormula || ""
  const hasFormula = Boolean(formula)
  const rawResult = hasFormula ? (sourceCell?.result ?? record(sourceCell?.value).result) : sourceCell?.value
  const hasCachedValue = !hasFormula || rawResult !== undefined
  const normalizedValue = hasCachedValue ? normalizeScalar(rawResult) : null
  return {
    address: requestedAddress || cell?.address || sourceCell?.address || "",
    sourceAddress: sourceCell?.address || cell?.address || "",
    merged: Boolean(cell?.isMerged),
    formula: hasFormula ? `=${String(formula).replace(/^=/, "")}` : null,
    formulaType: hasFormula ? (sourceCell?.formulaType || record(sourceCell?.value).shareType || "normal") : null,
    value: normalizedValue,
    hasCachedValue,
    displayValue: normalizeDisplayValue(sourceCell, normalizedValue),
    numberFormat: sourceCell?.numFmt || "",
    type: String(sourceCell?.type ?? "")
  }
}

export async function loadExcelWorkbook(buffer:Buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error("Excel 文件内容为空")
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(Uint8Array.from(buffer).buffer, {
    ignoreNodes: ["dataValidations", "extLst"]
  })
  if (!workbook.worksheets.length) throw new Error("工作簿中没有可读取的工作表")
  if (workbook.worksheets.length > 100) throw new Error(`工作表数量过多: ${workbook.worksheets.length}（上限 100）`)
  return workbook
}

export function resolveExcelWorksheet(workbook:ExcelJS.Workbook, sheetName = ""):ExcelJS.Worksheet {
  const requested = String(sheetName || "").trim()
  if (!requested) {
    if (workbook.worksheets.length === 1) return workbook.worksheets[0]!
    throw new Error(`请指定工作表名称。可用工作表: ${workbook.worksheets.map(sheet => sheet.name).join("、")}`)
  }
  const exact = workbook.getWorksheet(requested)
  if (exact) return exact
  const lowered = requested.toLowerCase()
  const caseInsensitive = workbook.worksheets.filter(sheet => sheet.name.toLowerCase() === lowered)
  if (caseInsensitive.length === 1) return caseInsensitive[0]!
  const index = Number(requested)
  if (Number.isInteger(index) && index >= 1 && index <= workbook.worksheets.length) {
    return workbook.worksheets[index - 1]!
  }
  throw new Error(`找不到工作表“${requested}”。可用工作表: ${workbook.worksheets.map(sheet => sheet.name).join("、")}`)
}

export function listExcelWorksheets(workbook:ExcelJS.Workbook) {
  return workbook.worksheets.map((sheet, index) => ({
    index: index + 1,
    name: sheet.name,
    state: sheet.state || "visible",
    rowCount: sheet.rowCount || 0,
    columnCount: sheet.columnCount || 0
  }))
}

export function readExcelCell(workbook:ExcelJS.Workbook, { sheetName, address }:{sheetName?:string|undefined;address?:string|undefined} = {}) {
  const sheet = resolveExcelWorksheet(workbook, sheetName)
  const normalizedAddress = normalizeExcelCellAddress(address)
  return {
    sheetName: sheet.name,
    cell: serializeExcelCell(sheet.getCell(normalizedAddress), normalizedAddress)
  }
}

export function readExcelRange(workbook:ExcelJS.Workbook, { sheetName, range, maxCells = DEFAULT_MAX_RANGE_CELLS }:{sheetName?:string|undefined;range?:string|undefined;maxCells?:number|undefined} = {}) {
  const sheet = resolveExcelWorksheet(workbook, sheetName)
  const parsed = parseExcelRange(range)
  const limit = Math.max(1, Math.min(1000, Number(maxCells) || DEFAULT_MAX_RANGE_CELLS))
  if (parsed.cellCount > limit) {
    throw new Error(`区域 ${parsed.address} 包含 ${parsed.cellCount} 个单元格，超过单次上限 ${limit}`)
  }
  const rows = []
  for (let row = parsed.startRow; row <= parsed.endRow; row++) {
    const cells = []
    for (let column = parsed.startColumn; column <= parsed.endColumn; column++) {
      const address = `${columnNumberToName(column)}${row}`
      cells.push(serializeExcelCell(sheet.getCell(address), address))
    }
    rows.push(cells)
  }
  return { sheetName: sheet.name, range: parsed.address, cellCount: parsed.cellCount, rows }
}

function searchableText(cell:SerializedCell, searchIn = "all") {
  const parts = []
  if (["all", "formula"].includes(searchIn) && cell.formula) parts.push(cell.formula)
  if (["all", "value"].includes(searchIn)) {
    if (cell.value !== undefined && cell.value !== null) {
      parts.push(typeof cell.value === "string" ? cell.value : JSON.stringify(cell.value))
    }
    if (cell.displayValue) parts.push(cell.displayValue)
  }
  return parts.join("\n").toLowerCase()
}

function searchableFields(cell:SerializedCell, searchIn = "all") {
  const fields = []
  if (["all", "formula"].includes(searchIn) && cell.formula) fields.push(String(cell.formula))
  if (["all", "value"].includes(searchIn)) {
    if (cell.value !== undefined && cell.value !== null) {
      fields.push(typeof cell.value === "string" ? cell.value : JSON.stringify(cell.value))
    }
    if (cell.displayValue) fields.push(String(cell.displayValue))
  }
  return [...new Set(fields.map(value => value.trim().toLowerCase()).filter(Boolean))]
}

function normalizeMatchMode(matchMode = "contains") {
  return ["contains", "exact", "starts_with", "ends_with"].includes(matchMode) ? matchMode : "contains"
}

function matchesPrimaryQuery(cell:SerializedCell, primary:string, searchIn:string, matchMode:string) {
  if (!primary) return false
  return searchableFields(cell, searchIn).some(field => {
    if (matchMode === "exact") return field === primary
    if (matchMode === "starts_with") return field.startsWith(primary)
    if (matchMode === "ends_with") return field.endsWith(primary)
    return field.includes(primary)
  })
}

function cellAddressCoordinates(address = "") {
  const normalized = normalizeExcelCellAddress(address)
  const match = normalized.match(/^([A-Z]+)(\d+)$/)
  return { column: columnNameToNumber(match?.[1] || ''), row: Number(match?.[2]) }
}

function formatBounds(bounds:Omit<Bounds,"address"|"cellCount">) {
  return `${columnNumberToName(bounds.startColumn)}${bounds.startRow}:${columnNumberToName(bounds.endColumn)}${bounds.endRow}`
}

function resolveSearchBounds(sheet:ExcelJS.Worksheet, { range = "", anchorCell = "", rowRadius = 10, columnRadius = 5 }:SearchOptions = {}) {
  if (String(range || "").trim()) return parseExcelRange(range)
  if (!String(anchorCell || "").trim()) return null
  const anchor = cellAddressCoordinates(anchorCell)
  const requestedRows = Number(rowRadius)
  const requestedColumns = Number(columnRadius)
  const rows = Math.floor(Math.max(0, Math.min(500, Number.isFinite(requestedRows) ? requestedRows : 10)))
  const columns = Math.floor(Math.max(0, Math.min(100, Number.isFinite(requestedColumns) ? requestedColumns : 5)))
  const bounds = {
    startRow: Math.max(1, anchor.row - rows),
    endRow: Math.min(MAX_EXCEL_ROWS, anchor.row + rows),
    startColumn: Math.max(1, anchor.column - columns),
    endColumn: Math.min(MAX_EXCEL_COLUMNS, anchor.column + columns)
  }
  return { ...bounds, address: formatBounds(bounds), cellCount: (bounds.endRow - bounds.startRow + 1) * (bounds.endColumn - bounds.startColumn + 1) }
}

function normalizeSearchTerms(terms:unknown = []) {
  return [...new Set((Array.isArray(terms) ? terms : [terms])
    .map(term => String(term || "").trim())
    .filter(Boolean))]
}

function scoreSearchCandidate(cell:SerializedCell, primaryQuery = "", relatedTerms:string[] = [], searchIn = "all", matchMode = "contains") {
  const primary = String(primaryQuery || "").trim().toLowerCase()
  const valueText = searchableText(cell, "value")
  const formulaText = searchableText(cell, "formula")
  const display = String(cell.displayValue || "").trim().toLowerCase()
  let score = 0
  const exactMatch = matchesPrimaryQuery(cell, primary, searchIn, matchMode)
  if (exactMatch) {
    score += 1000
    if (display === primary) score += 300
    else if (display.startsWith(primary)) score += matchMode === "starts_with" ? 220 : 120
    else if (display.endsWith(primary)) score += matchMode === "ends_with" ? 220 : 60
  }

  const matchedTerms = []
  for (const term of relatedTerms) {
    const normalized = term.toLowerCase()
    const inValue = ["all", "value"].includes(searchIn) && valueText.includes(normalized)
    const inFormula = ["all", "formula"].includes(searchIn) && formulaText.includes(normalized)
    if (!inValue && !inFormula) continue
    matchedTerms.push(term)
    if (inValue) {
      score += display === normalized ? 240 : (display.startsWith(normalized) ? 150 : 90)
      score += Math.min(20, normalized.length * 2)
    }
    if (inFormula) score += 20
  }
  return { score, exactMatch, matchedTerms }
}

function getSheetSearchIndex(workbook:ExcelJS.Workbook, sheet:ExcelJS.Worksheet, maxScannedCells:number, bounds:Bounds|null = null):SearchIndex {
  let workbookCache = workbookSearchIndexCache.get(workbook)
  if (!workbookCache) {
    workbookCache = new Map()
    workbookSearchIndexCache.set(workbook, workbookCache)
  }
  const cacheKey = `${sheet.id || sheet.name}:${maxScannedCells}:${bounds?.address || "all"}`
  if (workbookCache.has(cacheKey)) return workbookCache.get(cacheKey)!

  const seenSources = new Set()
  const cells = []
  let scannedCells = 0
  let truncated = false
  const startRow = bounds?.startRow || 1
  const endRow = Math.min(bounds?.endRow || sheet.rowCount, sheet.rowCount)
  const startColumn = bounds?.startColumn || 1
  const endColumn = Math.min(bounds?.endColumn || sheet.columnCount, sheet.columnCount)
  outer: for (let rowNumber = startRow; rowNumber <= endRow; rowNumber++) {
    const row = sheet.getRow(rowNumber)
    for (let column = startColumn; column <= endColumn; column++) {
      const rawCell = row.getCell(column)
      const sourceCell = resolveMergedCell(rawCell)
      const sourceAddress = sourceCell?.address || rawCell.address
      if (seenSources.has(sourceAddress)) continue
      seenSources.add(sourceAddress)
      if (++scannedCells > maxScannedCells) {
        scannedCells = maxScannedCells
        truncated = true
        break outer
      }
      if (sourceCell?.value === null || sourceCell?.value === undefined) continue
      cells.push(serializeExcelCell(sourceCell, sourceAddress))
    }
  }
  const index = { cells, scannedCells, truncated }
  workbookCache.set(cacheKey, index)
  return index
}

export function findInExcelWorkbook(workbook:ExcelJS.Workbook, {
  sheetName = "",
  query = "",
  relatedTerms = [],
  searchIn = "all",
  matchMode = "contains",
  range = "",
  anchorCell = "",
  rowRadius = 10,
  columnRadius = 5,
  limit = DEFAULT_MAX_SEARCH_RESULTS,
  maxScannedCells = DEFAULT_MAX_SEARCH_CELLS
}:SearchOptions = {}) {
  const keyword = String(query || "").trim().toLowerCase()
  if (!keyword) throw new Error("搜索关键词不能为空")
  const normalizedRelatedTerms = normalizeSearchTerms(relatedTerms)
  const normalizedSearchIn = ["all", "formula", "value"].includes(searchIn) ? searchIn : "all"
  const normalizedMatchMode = normalizeMatchMode(matchMode)
  const resultLimit = Math.max(1, Math.min(100, Number(limit) || DEFAULT_MAX_SEARCH_RESULTS))
  const scanLimit = Math.max(100, Math.min(200_000, Number(maxScannedCells) || DEFAULT_MAX_SEARCH_CELLS))
  const sheets = sheetName ? [resolveExcelWorksheet(workbook, sheetName)] : workbook.worksheets
  const matches = []
  const candidates = []
  let scannedCells = 0
  let truncated = false
  let exactMatchCount = 0
  let scanOrder = 0
  const scopes = []

  outer: for (const sheet of sheets) {
    const remainingScan = scanLimit - scannedCells
    if (remainingScan <= 0) {
      truncated = true
      break
    }
    const bounds = resolveSearchBounds(sheet, { range, anchorCell, rowRadius, columnRadius })
    if (bounds) scopes.push({ sheetName: sheet.name, range: bounds.address })
    const index = getSheetSearchIndex(workbook, sheet, remainingScan, bounds)
    scannedCells += index.scannedCells
    for (const cell of index.cells) {
        const relevance = scoreSearchCandidate(cell, keyword, normalizedRelatedTerms, normalizedSearchIn, normalizedMatchMode)
        if (!relevance.exactMatch && !relevance.matchedTerms.length) continue
        if (relevance.exactMatch) exactMatchCount++
        candidates.push({
          sheetName: sheet.name,
          ...cell,
          exactMatch: relevance.exactMatch,
          matchedTerms: relevance.matchedTerms,
          relevanceScore: relevance.score,
          _scanOrder: scanOrder++
        })
        if (!normalizedRelatedTerms.length && candidates.length >= resultLimit) {
          truncated = true
          break outer
        }
        if (candidates.length >= 2000) {
          truncated = true
          break outer
        }
    }
    if (index.truncated) {
      truncated = true
      break
    }
  }

  if (normalizedRelatedTerms.length) {
    candidates.sort((a, b) => b.relevanceScore - a.relevanceScore || a._scanOrder - b._scanOrder)
  }
  matches.push(...candidates.slice(0, resultLimit).map(({ _scanOrder, ...candidate }) => candidate))
  if (candidates.length > resultLimit) truncated = true
  return {
    query: String(query).trim(),
    relatedTerms: normalizedRelatedTerms,
    exactMatchCount,
    searchIn: normalizedSearchIn,
    matchMode: normalizedMatchMode,
    scope: scopes.length === 1 ? scopes[0]!.range : null,
    scopes,
    matches,
    scannedCells,
    truncated
  }
}
