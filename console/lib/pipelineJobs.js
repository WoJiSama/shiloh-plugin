const PREFIX = "ytbot:message_pipeline:"
const states = ["pending", "processing", "retry_wait", "completed", "sent", "failed"]
const invalid = message => Object.assign(new Error(message), { status: 400 })

export function pipelineJobFilters(query = {}) {
  const kind = String(query.kind || "all")
  const status = String(query.status || "all")
  const limit = query.limit === undefined || query.limit === "" ? 50 : Number(query.limit)
  if (!["all", "event", "delivery"].includes(kind)) throw invalid("kind 需为 all、event 或 delivery")
  if (status !== "all" && !states.includes(status)) throw invalid("任务状态无效")
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw invalid("limit 需为 1 到 200 的整数")
  return { kind, status, limit }
}

function summary(kind, record) {
  return {
    kind, id: String(record.id || ""), state: String(record.state || "unknown"),
    botId: String(record.botId || record.envelope?.botId || ""),
    groupId: String(record.groupId || record.envelope?.groupId || ""),
    platform: String(record.platform || ""), attempts: Number(record.attempts) || 0,
    createdAt: Number(record.createdAt) || 0, updatedAt: Number(record.updatedAt) || 0,
    nextRetryAt: Number(record.nextRetryAt) || 0, leaseUntil: Number(record.leaseUntil) || 0,
    lastError: String(record.lastError || "").slice(0, 500), uncertain: Boolean(record.uncertain),
    ...(record.receipt?.messageId ? { receiptMessageId: String(record.receipt.messageId) } : {}),
    runtimeConfirmed: false
  }
}

export async function readPipelineJobs(redis, query = {}, settings = {}, { maxScans = 50, maxRecords = 5000 } = {}) {
  const filters = pipelineJobFilters(query)
  let cursor = "0"
  let scans = 0
  const keys = new Set()
  const pattern = `${PREFIX}${filters.kind === "all" ? "*" : `${filters.kind}:*`}`
  do {
    const result = await redis.cmd("SCAN", cursor, "MATCH", pattern, "COUNT", 200)
    if (!Array.isArray(result) || !Array.isArray(result[1])) throw new Error("Redis SCAN 返回格式无效")
    cursor = String(result[0])
    scans++
    for (const key of result[1]) {
      if (/^ytbot:message_pipeline:(event|delivery):/.test(String(key)) && (filters.kind === "all" || String(key).startsWith(`${PREFIX}${filters.kind}:`))) keys.add(String(key))
      if (keys.size >= maxRecords) break
    }
  } while (cursor !== "0" && scans < maxScans && keys.size < maxRecords)
  const records = []
  let skippedRecords = 0
  const selected = [...keys]
  for (let offset = 0; offset < selected.length; offset += 100) {
    const values = await Promise.all(selected.slice(offset, offset + 100).map(key => redis.cmd("GET", key)))
    for (let index = 0; index < values.length; index++) {
      if (!values[index]) continue // Expired between SCAN and GET: it is outside the retained window.
      try {
        const record = JSON.parse(values[index])
        if (!record || typeof record !== "object" || !record.id) { skippedRecords++; continue }
        if (filters.status !== "all" && record.state !== filters.status) continue
        const kind = selected[offset + index].slice(PREFIX.length).split(":")[0]
        records.push(summary(kind, record))
      } catch { skippedRecords++ }
    }
  }
  records.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id))
  const scanTruncated = cursor !== "0" || keys.size >= maxRecords
  return {
    jobs: records.slice(0, filters.limit), filters, returned: Math.min(filters.limit, records.length),
    matchedInScan: records.length, scannedRecords: keys.size, scanTruncated, skippedRecords,
    retention: { eventMinutes: Number(settings.messagePipeline?.eventTtlMinutes) || 360, deliveryHours: Number(settings.messagePipeline?.deliveryTtlHours) || 24 },
    runtimeConfirmed: false,
    note: "仅查询 Redis TTL 窗口内仍保留的持久任务记录；状态为最后持久化值，无法据此确认机器人或 worker 当前存活。TTL 在任务更新时刷新，过期记录不计入；配置保留时间与当前运行实例可能不同。"
  }
}
