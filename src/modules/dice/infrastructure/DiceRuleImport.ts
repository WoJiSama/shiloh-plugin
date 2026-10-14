import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import {pathToFileURL} from 'node:url'
import type {ExpressionOptions} from './DiceRuleExpression.js'
import {getSegmentData,normalizeMessageSegments} from '../../conversation/infrastructure/groupContextResolver.js'
import {diceRecord,diceError} from './diceDecoders.js'
const DICE_RULE_MAX_PACKAGE_BYTES=64*1024
export interface RuleImportEvent {message?:unknown;group_id?:string|number;user_id?:string|number|undefined;getReply?():Promise<unknown>;group?:{getFileUrl?(id:string):Promise<unknown>};friend?:{getFileUrl?(id:string):Promise<unknown>};bot?:{sendApi?(action:string,params:Record<string,unknown>):Promise<unknown>}}
interface RuleImportCandidate {name:string;origin:string;source:string;fileId:string;busId:string}
export interface RuleImportOptions {timeoutMs?:number;fetchImpl?:typeof fetch}
function ensureDir(dir:string){fs.mkdirSync(dir,{recursive:true})}
function writeFileAtomic(file:string,content:string){ensureDir(path.dirname(file));const tmp=`${file}.${process.pid}.${Date.now()}.tmp`;try{fs.writeFileSync(tmp,content);fs.renameSync(tmp,file)}finally{try{fs.rmSync(tmp,{force:true})}catch{}}}
function readYamlCandidates(segments:unknown = [], origin = "current") {
  const candidates = []
  for (const segment of normalizeMessageSegments(segments)) {
    if (segment?.type !== "file") continue
    const data = getSegmentData(segment)
    const name = String(segment.name || data.name || segment.file_name || data.file_name || segment.file || data.file || "").trim()
    if (!/\.(?:ya?ml|js|mjs|cjs)$/i.test(name)) continue
    candidates.push({
      name,
      origin,
      source: String(segment.url || segment.file_url || data.url || data.file_url || "").trim(),
      fileId: String(segment.file_id || segment.fid || data.file_id || data.fid || data.id || "").trim(),
      busId: String(segment.busid || segment.bus_id || data.busid || data.bus_id || "").trim()
    })
  }
  return candidates
}

function readMessageText(message:unknown) {
  if (typeof message === "string") return message
  return normalizeMessageSegments(message)
    .filter(segment => segment?.type === "text")
    .map(segment => {
      const data = getSegmentData(segment)
      return String(segment.text || data.text || "")
    })
    .join("")
}

function extractInlineYaml(value:unknown = "") {
  const text = String(value || "").trim()
  const fenced = text.match(/```(?:yaml|yml)?\s*([\s\S]*?)\s*```/i)?.[1]
  if (fenced) return fenced.trim()
  return /^(?:version|id|name|aliases|commands)\s*:/m.test(text) ? text : ""
}

function extractInlineJs(value:unknown = "") {
  const text = String(value || "").trim()
  const fenced = text.match(/```(?:js|javascript|node)\s*([\s\S]*?)\s*```/i)?.[1]
  if (fenced) return fenced.trim()
  return ""
}

// JS 规则包特征：必须导出规则对象（module.exports / export default / export const）
export function looksLikeJsRuleSource(text = "") {
  return /^\s*(?:module\.exports\s*=|exports\.(?:default|pack)\s*=|export\s+default\b|export\s+const\s+\w+\s*=|export\s+\{)/m.test(String(text || ""))
}

const JS_RULE_MAX_FUNCTIONS = 32

/**
 * 加载 JS 规则包源码：module.exports / export default 一个规则对象，
 * 可选 functions: { 名字: (args, ctx) => value } 注册进受限表达式。
 * 仅主人可走到这里（导入与确认都是主人权限）；JS 会在本进程执行。
 */
export async function loadJsRuleSource(text:string, { rulesDir }:{rulesDir?:string} = {}) {
  const source = String(text || "")
  if (!looksLikeJsRuleSource(source)) throw new Error("JS 规则包必须以 module.exports 或 export default 导出规则对象")
  const useEsm = /^\s*export\s+(?:default|const|\{)/m.test(source)
  const ext = useEsm ? "mjs" : "cjs"
  const dir = path.join(rulesDir || path.join(process.cwd(), "plugins/shiloh-plugin/data/dice_rules"), "pending", ".js-load")
  ensureDir(dir)
  const file = path.join(dir, `load-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${ext}`)
  writeFileAtomic(file, source)
  try {
    const mod = diceRecord(await import(`${pathToFileURL(file).href}?t=${Date.now()}`))
    const rawExport = mod.default ?? mod.pack ?? null
    const exported=diceRecord(rawExport)
    if (!rawExport || typeof rawExport !== "object" || Array.isArray(rawExport)) {
      throw new Error("JS 规则包必须导出一个规则对象（module.exports = {...} 或 export default {...}）")
    }
    const functions:NonNullable<ExpressionOptions["customFunctions"]> = {}
    if (exported.functions !== undefined) {
      if (!exported.functions || typeof exported.functions !== "object" || Array.isArray(exported.functions)) {
        throw new Error("functions 必须是 { 函数名: (args, ctx) => 值 } 形式的对象")
      }
      for (const [name, fn] of Object.entries(exported.functions)) {
        if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new Error(`自定义函数名不合法：${name}`)
        if (typeof fn !== "function") throw new Error(`functions.${name} 必须是函数`)
        functions[name] = (args,scope):unknown=>fn(args,scope)
      }
      if (Object.keys(functions).length > JS_RULE_MAX_FUNCTIONS) throw new Error(`自定义函数最多 ${JS_RULE_MAX_FUNCTIONS} 个`)
    }
    const packObject = { ...exported }
    delete packObject.functions
    return { packObject, functions, ext, functionNames: Object.keys(functions) }
  } catch (error) {
    throw new Error(`JS 规则包加载失败：${diceError(error)}`)
  } finally {
    try { fs.rmSync(file, { force: true }) } catch {}
  }
}

async function resolveFileUrl(candidate:RuleImportCandidate, e:RuleImportEvent) {
  if (/^https?:\/\//i.test(candidate.source)) return candidate.source
  if (!candidate.fileId) return ""
  try {
    const direct = e.group_id
      ? await e?.group?.getFileUrl?.(candidate.fileId)
      : await e?.friend?.getFileUrl?.(candidate.fileId)
    const url = typeof direct === "string" ? direct : diceRecord(diceRecord(direct).data).url || diceRecord(direct).url
    if (/^https?:\/\//i.test(String(url || ""))) return String(url)
  } catch {}
  if (!e?.bot?.sendApi) return ""
  try {
    const response = await e.bot.sendApi(e.group_id ? "get_group_file_url" : "get_private_file_url", e.group_id
      ? { group_id: e.group_id, file_id: candidate.fileId, ...(candidate.busId ? { busid: candidate.busId } : {}) }
      : { user_id: e.user_id, file_id: candidate.fileId })
    const outer=diceRecord(response),inner=diceRecord(outer.data)
    const data = diceRecord(inner.data || outer.data || response)
    return String(data.url || data.file_url || "")
  } catch {
    return ""
  }
}

async function downloadYaml(url:string, options:RuleImportOptions = {}) {
  if (!/^https?:\/\//i.test(String(url || ""))) throw new Error("YAML 文件下载链接无效")
  const controller = new AbortController()
  const timeoutMs = Math.max(1000, Math.min(30000, Number(options.timeoutMs) || 12000))
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await (options.fetchImpl || globalThis.fetch)(url, { signal: controller.signal, redirect: "follow" })
    if (!response?.ok) throw new Error(`YAML 文件下载失败：HTTP ${response?.status || "未知"}`)
    const declared = Number(response.headers?.get?.("content-length") || 0)
    if (declared > DICE_RULE_MAX_PACKAGE_BYTES) throw new Error(`YAML 文件超过 ${DICE_RULE_MAX_PACKAGE_BYTES} 字节上限`)
    const chunks = []
    let total = 0
    if (response.body?.getReader) {
      const reader = response.body.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        const chunk = Buffer.from(value)
        total += chunk.length
        if (total > DICE_RULE_MAX_PACKAGE_BYTES) {
          await reader.cancel().catch(() => {})
          throw new Error(`YAML 文件超过 ${DICE_RULE_MAX_PACKAGE_BYTES} 字节上限`)
        }
        chunks.push(chunk)
      }
    } else {
      const chunk = Buffer.from(await response.arrayBuffer())
      total = chunk.length
      chunks.push(chunk)
    }
    const buffer = Buffer.concat(chunks, total)
    if (buffer.length > DICE_RULE_MAX_PACKAGE_BYTES) throw new Error(`YAML 文件超过 ${DICE_RULE_MAX_PACKAGE_BYTES} 字节上限`)
    return buffer.toString("utf8")
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error(`YAML 文件下载超时（${timeoutMs}ms）`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

export async function resolveDiceRuleImportSource(e:RuleImportEvent = {}, raw = "", options:RuleImportOptions = {}) {
  const inline = extractInlineYaml(raw) || extractInlineJs(raw)
  if (inline) return inline

  const candidates = [...readYamlCandidates(e.message, "current")]
  let reply:Record<string,unknown>|null = null
  if (e.getReply) {
    try { reply = diceRecord(await e.getReply()) } catch {}
  }
  if (reply) {
    const replyText = [reply.raw_message, reply.msg, typeof reply.content === "string" ? reply.content : "", readMessageText(reply.message || reply.content)]
      .map(value => extractInlineYaml(value) || extractInlineJs(value))
      .find(Boolean)
    if (replyText) return replyText
    candidates.push(...readYamlCandidates(reply.message || reply.content, "reply"))
  }
  const candidate = candidates[0]
  if (!candidate) throw new Error("请把 YAML/JS 代码放在命令后，或引用一个 .yaml/.yml/.js/.mjs/.cjs 文件再发送 .骰规则导入")
  const url = await resolveFileUrl(candidate, e)
  if (!url) throw new Error(`无法取得 ${candidate.name} 的下载链接`)
  return await downloadYaml(url, options)
}

