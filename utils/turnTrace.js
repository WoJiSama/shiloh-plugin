import fs from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"

function compactError(value = "") {
  return String(value?.message || value || "")
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
  return candidates.at(-1)
}

function localDateTag(at = Date.now()) {
  const date = new Date(at)
  const pad = value => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export async function pruneTurnTraceArchive(dir = "", retentionDays = 7) {
  const days = Math.max(1, Number(retentionDays) || 7)
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  let entries = []
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

function queueArchiveWrite(record, archive) {
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
      globalThis.logger?.debug?.(`[TurnTrace] 归档写入失败（不影响回合）: ${error?.message || error}`)
    }
  })
}

/**
 * 一个回合一条结构化 trace：意图、触发来源、路由、模型调用、工具成败、失败原因、出站条数、总耗时。
 * finish 时输出 [TurnTrace] 单行日志，并按配置落盘 NDJSON（默认开启，保留 7 天）。
 */
export function createTurnTrace({ groupId = "", userId = "", sessionId = "", logger, archive = null } = {}) {
  const startedAt = Date.now()
  const record = {
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
    setTrigger(mode, info = {}) {
      if (!mode) return
      record.trigger = {
        mode: String(mode),
        gateDecision: String(info.gateDecision || ""),
        gateReason: String(info.gateReason || "").slice(0, 80),
        phase: String(info.phase || "")
      }
    },
    setIntent(kind, confidence = null, source = "") {
      if (!kind) return
      record.intent = { kind: String(kind), confidence: confidence ?? null, source: String(source || "") }
    },
    setRoute(mode, profile, reason) {
      record.route = { mode: String(mode || ""), profile: String(profile || ""), reason: String(reason || "") }
    },
    addModelCall(stage, ms) {
      record.modelCalls.push({ stage: String(stage || ""), ms: Number(ms) || 0 })
    },
    addTool(name, ok, ms) {
      record.tools.push({ name: String(name || ""), ok: ok !== false, ms: Number(ms) || 0 })
    },
    addFailure(stage, error = "") {
      record.failures.push({ stage: String(stage || ""), error: compactError(error) })
    },
    countOutbound(n = 1) {
      record.outbound += Math.max(0, Number(n) || 0)
    },
    finish() {
      record.totalMs = Date.now() - startedAt
      logger?.info?.(`[TurnTrace] ${JSON.stringify(record)}`)
      if (archive?.enabled) queueArchiveWrite(record, archive)
      return record
    }
  }
}
