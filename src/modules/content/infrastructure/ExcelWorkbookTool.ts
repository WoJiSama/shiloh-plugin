import { AbstractTool } from "../../toolSupport/infrastructure/AbstractTool.js"
import { downloadExcelBuffer, listGroupExcelFiles, resolveExcelFileContext } from "./excelFileContext.js"
import {
  findInExcelWorkbook,
  listExcelWorksheets,
  loadExcelWorkbook,
  readExcelCell,
  readExcelRange
} from "./excelWorkbook.js"
import { safeTruncateUnicode } from "../../models/domain/unicodeText.js"

const DEFAULT_WORKBOOK_CACHE_TTL_MS = 5 * 60 * 1000
const DEFAULT_WORKBOOK_CACHE_MAX_ENTRIES = 8
import type ExcelJS from 'exceljs'
import {parseExcelEvent,type ExcelEvent,type ExcelFile,type ExcelFileOptions} from './excelFileContext.js'
type Loaded={workbook:ExcelJS.Workbook;bytes:number;downloadMs:number;parseMs:number}
type Cache=Map<string,{createdAt:number;promise:Promise<Loaded>}>
interface ToolOptions {resolveFile?:typeof resolveExcelFileContext;downloadFile?:typeof downloadExcelBuffer;listGroupFiles?:typeof listGroupExcelFiles;workbookCache?:Cache;cacheTtlMs?:number;cacheMaxEntries?:number}
type QueryParams=NonNullable<Parameters<typeof findInExcelWorkbook>[1]>&ExcelFileOptions&{operation?:string;cell?:string}
type QueryResult=({operation:'list_sheets';sheets:ReturnType<typeof listExcelWorksheets>})|({operation:'list_group_excels'}&Awaited<ReturnType<typeof listGroupExcelFiles>>)|({operation:'read_cell'}&ReturnType<typeof readExcelCell>)|({operation:'read_range'}&ReturnType<typeof readExcelRange>)|({operation:'find'}&ReturnType<typeof findInExcelWorkbook>)
const sharedWorkbookCache:Cache = new Map()
export function createExcelWorkbookTool(ports:{logger?:{info(message:string):void}}={}) {

function displayValue(value:unknown) {
  if (value === undefined) return "(无)"
  if (value === null) return "(空)"
  if (typeof value === "string") return value || "(空字符串)"
  return JSON.stringify(value)
}

function formatCell(cell:ReturnType<typeof readExcelCell>["cell"]) {
  const lines = [
    `单元格: ${cell.address}${cell.sourceAddress && cell.sourceAddress !== cell.address ? `（合并区域实际来源: ${cell.sourceAddress}）` : ""}`,
    `公式: ${cell.formula || "(无公式)"}`
  ]
  if (cell.formula && !cell.hasCachedValue) {
    lines.push("值: (工作簿未保存计算结果；请用 Excel/WPS 重新计算并保存后再查询)")
  } else {
    lines.push(`值: ${displayValue(cell.value)}`)
  }
  lines.push(`显示值: ${cell.displayValue || "(空)"}`)
  if (cell.numberFormat) lines.push(`数字格式: ${cell.numberFormat}`)
  return lines.join("\n")
}

function formatResult(result:QueryResult, file:Pick<ExcelFile,"fileName"|"origin">) {
  const header = [
    "【Excel 工作簿查询结果】",
    `文件: ${file.fileName}`,
    `来源: ${file.origin}`
  ]
  if (result.operation === "list_sheets") {
    return [...header, "工作表:", ...result.sheets.map(sheet =>
      `${sheet.index}. ${sheet.name}（${sheet.state}，${sheet.rowCount}行 × ${sheet.columnCount}列）`
    )].join("\n")
  }
  if (result.operation === "list_group_excels") {
    const lines = [
      ...header,
      `群文件中的 Excel: ${result.files.length} 个（共扫描到 ${result.totalExcelFiles} 个）${result.truncated ? "，目录扫描达到上限" : ""}`
    ]
    for (const file of result.files) {
      lines.push(`${file.fullPath}（${file.size || 0} 字节${file.uploaderName ? `，上传者:${file.uploaderName}` : ""}）`)
    }
    if (!result.files.length) lines.push("没有找到匹配的群文件 Excel")
    return lines.join("\n")
  }
  if (result.operation === "read_cell") {
    return [...header, `工作表: ${result.sheetName}`, formatCell(result.cell)].join("\n")
  }
  if (result.operation === "read_range") {
    const lines = [...header, `工作表: ${result.sheetName}`, `区域: ${result.range}（${result.cellCount}个单元格）`]
    for (const row of result.rows) {
      for (const cell of row) lines.push(formatCell(cell))
    }
    return lines.join("\n\n")
  }
  if (result.operation === "find") {
    const matchModeLabels:Record<string,string> = {
      contains: "包含",
      exact: "完全等于",
      starts_with: "开头是",
      ends_with: "结尾是"
    }
    const lines = [
      ...header,
      `搜索: ${result.query}`,
      `匹配方式: ${matchModeLabels[result.matchMode] || result.matchMode || "包含"}`,
      ...(result.scope ? [`搜索区域: ${result.scope}`] : []),
      ...(result.relatedTerms?.length ? [
        `原词精确命中: ${result.exactMatchCount || 0}`,
        `关联词: ${result.relatedTerms.join("、")}`,
        ...(result.exactMatchCount ? [] : ["说明: 工作簿中没有出现搜索原词；以下是文件内实际命中的关联内容，不等同于原词的字面命中。"])
      ] : []),
      `扫描单元格: ${result.scannedCells}`,
      `匹配数量: ${result.matches.length}${result.truncated ? "（结果或扫描已达到上限）" : ""}`
    ]
    for (const match of result.matches) {
      const matchedBy = match.exactMatch
        ? "原词"
        : (match.matchedTerms?.length ? `关联词:${match.matchedTerms.join("/")}` : "")
      lines.push(`工作表: ${match.sheetName}${matchedBy ? `（命中:${matchedBy}）` : ""}\n${formatCell(match)}`)
    }
    if (!result.matches.length) lines.push("没有找到匹配项")
    return lines.join("\n\n")
  }
  return [...header, JSON.stringify(result)].join("\n")
}

class ExcelWorkbookTool extends AbstractTool {
 resolveFile:typeof resolveExcelFileContext;downloadFile:typeof downloadExcelBuffer;listGroupFiles:typeof listGroupExcelFiles;workbookCache:Cache;cacheTtlMs:number;cacheMaxEntries:number;
  constructor(options:ToolOptions = {}) {
    super()
    this.resolveFile = options.resolveFile || resolveExcelFileContext
    this.downloadFile = options.downloadFile || downloadExcelBuffer
    this.listGroupFiles = options.listGroupFiles || listGroupExcelFiles
    this.workbookCache = options.workbookCache || sharedWorkbookCache
    this.cacheTtlMs = Math.max(1000, Number(options.cacheTtlMs) || DEFAULT_WORKBOOK_CACHE_TTL_MS)
    this.cacheMaxEntries = Math.max(1, Math.min(32, Number(options.cacheMaxEntries) || DEFAULT_WORKBOOK_CACHE_MAX_ENTRIES))
    this.name = "excelWorkbookTool"
    this.description = [
      "读取当前消息、引用消息、当前用户最近上传或当前群文件仓库中的 Excel 工作簿（.xlsx/.xlsm）。",
      "可以列出工作表、查询单元格、读取小范围区域、在指定 tab/sheet 或某个单元格附近搜索文字、数值或公式；sheetName 可直接填写工作表序号，例如第二个 tab 填 2。",
      "find 支持包含、完全等于、开头是、结尾是等匹配方式。模型应根据用户自然语言自行选择操作与参数，不要求用户使用固定句式。",
      "read_cell 会同时返回公式、工作簿保存的计算值和显示值；最终回答必须原样列出公式，不能自行重写或猜测公式结果。",
      "如果公式没有 cached result，会明确提示用户用 Excel/WPS 重新计算并保存；本工具不会执行宏、外部链接或公式代码。",
      "旧版 .xls 暂不支持，需要用户另存为 .xlsx。"
    ].join("\n")
    this.parameters = {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["list_group_excels", "list_sheets", "read_cell", "read_range", "find"],
          description: "操作：列出群文件 Excel、列出工作簿 tab、读取单元格、读取小范围区域、搜索内容。"
        },
        sheetName: {
          type: "string",
          description: "工作表/tab 名称或从 1 开始的序号，支持中文；例如第二个 tab 填 2。只有一个工作表时可省略。"
        },
        cell: {
          type: "string",
          pattern: "^\\$?[A-Za-z]{1,3}\\$?[1-9]\\d{0,6}$",
          description: "read_cell 的单元格地址，例如 B7、$C$12。"
        },
        range: {
          type: "string",
          pattern: "^\\$?[A-Za-z]{1,3}\\$?[1-9]\\d{0,6}(?::\\$?[A-Za-z]{1,3}\\$?[1-9]\\d{0,6})?$",
          description: "read_range 要读取的区域，或 find 要限定搜索的区域，例如 A1:D10；read_range 单次最多 300 个单元格。"
        },
        query: {
          type: "string",
          description: "find 的搜索关键词，可搜索值、显示文本或公式。"
        },
        searchIn: {
          type: "string",
          enum: ["all", "value", "formula"],
          description: "find 搜索范围，默认 all。"
        },
        matchMode: {
          type: "string",
          enum: ["contains", "exact", "starts_with", "ends_with"],
          description: "find 的匹配方式：包含、完全等于、开头是、结尾是；默认 contains。"
        },
        anchorCell: {
          type: "string",
          pattern: "^\\$?[A-Za-z]{1,3}\\$?[1-9]\\d{0,6}$",
          description: "find 的可选中心单元格。用户说‘附近/周围’且上下文中有明确格子时填写，例如 B40。"
        },
        rowRadius: {
          type: "number",
          minimum: 0,
          maximum: 500,
          description: "以 anchorCell 搜索附近时，上下各查多少行，默认 10。"
        },
        columnRadius: {
          type: "number",
          minimum: 0,
          maximum: 100,
          description: "以 anchorCell 搜索附近时，左右各查多少列，默认 5。"
        },
        relatedTerms: {
          type: "array",
          items: { type: "string" },
          maxItems: 30,
          description: "可选关联词。用户问“与某概念相关”且原词可能不在文件中时填写；工具会明确区分原词命中和关联词命中。"
        },
        limit: {
          type: "number",
          minimum: 1,
          maximum: 100,
          description: "find 最多返回多少项，默认 30。"
        },
        fileUrl: {
          type: "string",
          description: "可选。只有用户明确给出 Excel HTTP/HTTPS 链接时填写；用户上传或引用文件时省略。"
        },
        fileName: {
          type: "string",
          description: "可选。要读取群文件仓库中的指定 Excel 时填写文件名，例如 预算表.xlsx；当前消息或引用已附文件时省略。"
        },
        folderPath: {
          type: "string",
          description: "可选群文件目录名或路径；存在同名 Excel 时必须填写，例如 财务/2026。"
        }
      },
      required: ["operation"],
      additionalProperties: false
    }
  }

  getWorkbookCacheKey(file:Partial<ExcelFile> = {}, e:ExcelEvent = {}) {
    const scope = e?.group_id ? `group:${e.group_id}` : `user:${e?.user_id || "private"}`
    const identity = file.fileId || file.fullPath || file.fileUrl || `${file.origin || "unknown"}:${file.fileName || "workbook"}`
    return `${scope}:${identity}`
  }

  pruneWorkbookCache(now = Date.now()) {
    for (const [key, entry] of this.workbookCache) {
      if (!entry?.createdAt || now - entry.createdAt > this.cacheTtlMs) this.workbookCache.delete(key)
    }
    while (this.workbookCache.size > this.cacheMaxEntries) {
      const oldestKey = this.workbookCache.keys().next().value
      if (oldestKey === undefined) break
      this.workbookCache.delete(oldestKey)
    }
  }

  async getWorkbook(file:ExcelFile, e:ExcelEvent) {
    const now = Date.now()
    this.pruneWorkbookCache(now)
    const cacheKey = this.getWorkbookCacheKey(file, e)
    const cached = this.workbookCache.get(cacheKey)
    if (cached && now - cached.createdAt <= this.cacheTtlMs) {
      const value = await cached.promise
      return { ...value, cacheHit: true, downloadMs: 0, parseMs: 0 }
    }

    const promise = (async () => {
      const downloadStartedAt = Date.now()
      const buffer = await this.downloadFile(file.fileUrl)
      const downloadedAt = Date.now()
      const workbook = await loadExcelWorkbook(buffer)
      return {
        workbook,
        bytes: buffer.length,
        downloadMs: downloadedAt - downloadStartedAt,
        parseMs: Date.now() - downloadedAt
      }
    })()
    this.workbookCache.set(cacheKey, { createdAt: now, promise })
    this.pruneWorkbookCache(now)
    try {
      return { ...await promise, cacheHit: false }
    } catch (error) {
      this.workbookCache.delete(cacheKey)
      throw error
    }
  }

  async func(input:Record<string,unknown>, event:unknown) {
    const e=parseExcelEvent(event),opts:QueryParams={}
    for(const key of ['operation','cell','sheetName','query','searchIn','matchMode','range','anchorCell','fileUrl','fileName','folderPath'] as const){const value=input[key];if(typeof value==='string')opts[key]=value}
    for(const key of ['rowRadius','columnRadius','limit'] as const){const value=input[key];if(typeof value==='number'&&Number.isFinite(value))opts[key]=value}
    if(Array.isArray(input.relatedTerms))opts.relatedTerms=input.relatedTerms.filter((value):value is string=>typeof value==='string')
    const operation = String(opts.operation || "").trim()
    if (!["list_group_excels", "list_sheets", "read_cell", "read_range", "find"].includes(operation)) return "error: 不支持的 Excel 操作"
    if (operation === "read_cell" && !opts.cell) return "error: read_cell 需要 cell 参数"
    if (operation === "read_range" && !opts.range) return "error: read_range 需要 range 参数"
    if (operation === "find" && !String(opts.query || "").trim()) return "error: find 需要 query 参数"

    try {
      if (operation === "list_group_excels") {
        const listing = await this.listGroupFiles(e, {
          query: opts.query || opts.fileName,
          folderPath: opts.folderPath
        })
        return safeTruncateUnicode(formatResult({ operation, ...listing }, {
          fileName: "当前群文件仓库",
          origin: "group_file"
        }), 12_000)
      }
      const startedAt = Date.now()
      const file = await this.resolveFile(e, opts)
      const resolvedAt = Date.now()
      const loaded = await this.getWorkbook(file, e)
      const workbook = loaded.workbook
      const queryStartedAt = Date.now()
      let payload:QueryResult
      if (operation === "list_sheets") {
        payload = { operation, sheets: listExcelWorksheets(workbook) }
      } else if (operation === "read_cell") {
        payload = { operation, ...readExcelCell(workbook, { sheetName: opts.sheetName, address: opts.cell }) }
      } else if (operation === "read_range") {
        payload = { operation, ...readExcelRange(workbook, { sheetName: opts.sheetName, range: opts.range, maxCells: 300 }) }
      } else {
        payload = {
          operation:"find",
          ...findInExcelWorkbook(workbook, {
            sheetName: opts.sheetName,
            query: opts.query,
            relatedTerms: opts.relatedTerms,
            searchIn: opts.searchIn,
            matchMode: opts.matchMode,
            range: opts.range,
            anchorCell: opts.anchorCell,
            rowRadius: opts.rowRadius,
            columnRadius: opts.columnRadius,
            limit: opts.limit
          })
        }
      }
      ports.logger?.info?.(
        `[ExcelWorkbookTool] operation=${operation} source=${file.origin || "unknown"} cache=${loaded.cacheHit ? "hit" : "miss"} resolveMs=${resolvedAt - startedAt} downloadMs=${loaded.downloadMs} parseMs=${loaded.parseMs} queryMs=${Date.now() - queryStartedAt} totalMs=${Date.now() - startedAt}`
      )
      return safeTruncateUnicode(formatResult(payload, file), 12_000)
    } catch (error) {
      return `error: Excel 查询失败: ${error instanceof Error?error.message:String(error)}`
    }
  }
}

return {ExcelWorkbookTool}
}
