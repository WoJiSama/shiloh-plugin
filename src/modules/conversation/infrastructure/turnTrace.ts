interface TraceLogger {info?(message:string):void;debug?(message:string):void}
interface Archive {dir:string;retentionDays?:number;enabled?:boolean}
export interface ToolRoutingTraceUpdate {
  candidates?: string[]
  beforeFilter?: string[]
  afterFilter?: string[]
  finalTools?: string[]
  // Tools in the request handed to the model gateway. This snapshot does not
  // establish provider consumption or describe later text-backend fallbacks.
  requestTools?: string[]
  toolChoice?: unknown
  applied?: string[]
  executionPath?: 'forced' | 'model' | 'none'
  filterStatus?: 'applied' | 'bypassed'
  planner?: {status: string; reason?: string}
}
export interface IntentShadowTraceResult {status:string;elapsedMs:number;intent?:string;confidence?:number;reason?:string}
interface TraceRecord {turnId:string;at:string;groupId:string;userId:string;sessionId:string;intent:{kind:string;confidence:number|null;source:string}|null;trigger:{mode:string;gateDecision:string;gateReason:string;phase:string}|null;route:{mode:string;profile:string;reason:string}|null;toolRouting?:ToolRoutingTraceUpdate;intentShadow?:IntentShadowTraceResult;modelCalls:{stage:string;ms:number;tokens?:number}[];tools:{name:string;ok:boolean;ms:number}[];failures:{stage:string;error:string}[];outbound:number;totalMs:number|null}
interface ShadowTraceEvent {event:'intent_shadow';parentTurnId:string;at:string;intentShadow:IntentShadowTraceResult}
import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"

function compactError(value:unknown = "") {
  return String((value instanceof Error ? value.message : value) || "")
    .replace(/\s+/g, " ")
    .slice(0, 200)
}

// ---- NDJSON 落盘：一条 trace 一行，按天滚动，写失败绝不影响回合本身 ----

const archiveState = { tail: Promise.resolve(), lastPruneAt: 0 }

export function resolveTurnTraceArchiveDir(customDir = "") {
  if (String(customDir || "").trim()) return path.resolve(String(customDir).trim())
  const cwd = process.cwd()
  const candidates = [
    path.join(cwd, "plugins", "shiloh-plugin", "data", "turn_trace"),
    path.join(cwd, "data", "turn_trace")
  ]
  // 优先落在真实插件目录下（部署形态）；开发/测试形态退回仓库 data/
  for (const candidate of candidates) {
    if (fs.existsSync(path.dirname(candidate))) return candidate
  }
  return candidates.at(-1)!
}

function localDateTag(at = Date.now()) {
  const date = new Date(at)
  const pad = (value:number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export async function pruneTurnTraceArchive(dir = "", retentionDays = 7) {
  const days = Math.max(1, Number(retentionDays) || 7)
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  let entries:string[] = []
  try {
    entries = await fs.promises.readdir(dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const entry of entries) {
    if (!/^\d{4}-\d{2}-\d{2}\.ndjson$/.test(entry)) continue
    const entryDate = Date.parse(`${entry.slice(0, 10)}T00:00:00`)
    if (!Number.isFinite(entryDate) || entryDate >= cutoff) continue
    try {
      await fs.promises.unlink(path.join(dir, entry))
      removed++
    } catch {}
  }
  return removed
}

function queueArchiveWrite(record:TraceRecord|ShadowTraceEvent, archive:Archive, logger?:TraceLogger) {
  // 并发回合的追加必须串行，否则 NDJSON 会出现交错行
  archiveState.tail = archiveState.tail.then(async () => {
    try {
      await fs.promises.mkdir(archive.dir, { recursive: true })
      await fs.promises.appendFile(path.join(archive.dir, `${localDateTag()}.ndjson`), `${JSON.stringify(record)}\n`, "utf8")
      if (Date.now() - archiveState.lastPruneAt > 10 * 60 * 1000) {
        archiveState.lastPruneAt = Date.now()
        await pruneTurnTraceArchive(archive.dir, archive.retentionDays)
      }
    } catch (error) {
      logger?.debug?.(`[TurnTrace] 归档写入失败（不影响回合）: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

/**
 * 一个回合一条结构化 trace：意图、触发来源、路由、模型调用、工具成败、失败原因、出站条数、总耗时。
 * finish 时输出 [TurnTrace] 单行日志，并按配置落盘 NDJSON（默认开启，保留 7 天）。
 */
export function createTurnTrace({ groupId = "", userId = "", sessionId = "", logger, archive = null }: {groupId?:unknown;userId?:unknown;sessionId?:unknown;logger?:TraceLogger;archive?:Archive|null} = {}) {
  const startedAt = Date.now()
  let finished = false
  const record:TraceRecord = {
    turnId: randomUUID(),
    at: new Date().toISOString(),
    groupId: String(groupId || ""),
    userId: String(userId || ""),
    sessionId: String(sessionId || ""),
    intent: null,
    trigger: null,
    route: null,
    modelCalls: [],
    tools: [],
    failures: [],
    outbound: 0,
    totalMs: null
  }

  return {
    id: record.turnId,
    record,
    setTrigger(mode:unknown, info:{gateDecision?:unknown;gateReason?:unknown;phase?:unknown} = {}) {
      if (!mode) return
      record.trigger = {
        mode: String(mode),
        gateDecision: String(info.gateDecision || ""),
        gateReason: String(info.gateReason || "").slice(0, 80),
        phase: String(info.phase || "")
      }
    },
    setIntent(kind:unknown, confidence:number|null = null, source = "") {
      if (!kind) return
      record.intent = { kind: String(kind), confidence: confidence ?? null, source: String(source || "") }
    },
    setRoute(mode:unknown, profile:unknown, reason:unknown) {
      record.route = { mode: String(mode || ""), profile: String(profile || ""), reason: String(reason || "") }
    },
    setToolRouting(update:ToolRoutingTraceUpdate) {
      if (finished) return
      const routing = record.toolRouting ??= {}
      for (const key of ['candidates', 'beforeFilter', 'afterFilter', 'finalTools', 'requestTools', 'applied'] as const) {
        if (Array.isArray(update[key])) routing[key] = [...new Set(update[key].filter(name => typeof name === 'string' && name.trim()).map(name => name.trim()))]
      }
      if (update.toolChoice !== undefined) {
        const choice = update.toolChoice
        const selected = typeof choice === 'object' && choice !== null ? Reflect.get(choice, 'function') : null
        routing.toolChoice = typeof choice === 'string' ? choice : selected && typeof selected === 'object' ? String(Reflect.get(selected, 'name') || '') : ''
      }
      if (update.executionPath) routing.executionPath = update.executionPath
      if (update.filterStatus) routing.filterStatus = update.filterStatus
      if (update.planner) routing.planner = {status: String(update.planner.status), ...(update.planner.reason ? {reason: compactError(update.planner.reason)} : {})}
    },
    setIntentShadow(result:IntentShadowTraceResult) {
      const intentShadow:IntentShadowTraceResult = {
        status: String(result.status), elapsedMs: Math.max(0, Number(result.elapsedMs) || 0),
        ...(result.intent ? {intent: String(result.intent)} : {}),
        ...(Number.isFinite(result.confidence) ? {confidence: result.confidence!} : {}),
        ...(result.reason ? {reason: compactError(result.reason)} : {})
      }
      if (!finished) {
        record.intentShadow = intentShadow
        return
      }
      // A background sample usually finishes after the reply. Keep the archived
      // turn immutable and join this small follow-up event in reports. Using a
      // parent id also keeps legacy turnId-based dashboards from counting it.
      const event:ShadowTraceEvent = {event: 'intent_shadow', parentTurnId: record.turnId, at: new Date().toISOString(), intentShadow}
      logger?.info?.(`[TurnTraceShadow] ${JSON.stringify(event)}`)
      if (archive?.enabled) queueArchiveWrite(event, archive, logger)
    },
    addModelCall(stage:unknown, ms:unknown, extra?:{tokens?:unknown}) {
      const call:{stage:string;ms:number;tokens?:number} = { stage: String(stage || ""), ms: Number(ms) || 0 }
      // extra: { tokens } 等;token 数用于区分"上游慢"与"prompt 巨型"两类慢
      if (extra && Number.isFinite(Number(extra.tokens)) && Number(extra.tokens) > 0) call.tokens = Number(extra.tokens)
      record.modelCalls.push(call)
    },
    addTool(name:unknown, ok:unknown, ms:unknown) {
      record.tools.push({ name: String(name || ""), ok: ok !== false, ms: Number(ms) || 0 })
    },
    addFailure(stage:unknown, error:unknown = "") {
      record.failures.push({ stage: String(stage || ""), error: compactError(error) })
    },
    countOutbound(n = 1) {
      record.outbound += Math.max(0, Number(n) || 0)
    },
    finish() {
      if (finished) return record
      finished = true
      record.totalMs = Date.now() - startedAt
      logger?.info?.(`[TurnTrace] ${JSON.stringify(record)}`)
      if (archive?.enabled) queueArchiveWrite(record, archive, logger)
      return record
    }
  }
}
