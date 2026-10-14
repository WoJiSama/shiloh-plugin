import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { enrichBilibiliMessageSegments, formatBilibiliHistoryLinks, formatBilibiliHistoryText } from '../modules/media/infrastructure/bilibiliMessage.js'
import type { MediaCard } from '../contracts/mediaRelay.js'

export interface BilibiliBackfillPorts {
  cwd?: string
  enrich?: (segments: MediaCard[], rawMessage: string) => Promise<MediaCard[]>
  redisCli?: (args: string[], options: { encoding?: 'utf8'; stdio?: 'ignore'; maxBuffer?: number }) => string
  logger?: { log(message: string): void }
}
export interface BilibiliBackfillResult { groupId: string; messageId: string | null; archiveChanged: number; redisChanged: number }
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null

function decodeSegments(value: unknown): MediaCard[] {
  if (!Array.isArray(value)) return []
  const segments: MediaCard[] = []
  for (const item of value as unknown[]) {
    const data = record(item)
    if (!data) continue
    segments.push({ ...data, ...(typeof data.type === 'string' ? { type: data.type } : {}) })
  }
  return segments
}

export async function runBilibiliBackfillCli(argv: string[], ports: BilibiliBackfillPorts = {}): Promise<BilibiliBackfillResult> {
  const readArg = (name: string, fallback = '') => {
    const index = argv.indexOf(`--${name}`)
    return index >= 0 ? String(argv[index + 1] || fallback) : fallback
  }
  const groupId = readArg('group')
  const messageId = readArg('message')
  if (!/^\d+$/.test(groupId)) throw new Error('需要 --group 群号')
  if (messageId && !/^\d+$/.test(messageId)) throw new Error('--message 必须是消息 ID')
  const enrich = ports.enrich ?? enrichBilibiliMessageSegments
  const redisCli = ports.redisCli ?? ((args, options) => String(execFileSync('redis-cli', args, options) || ''))
  const enrichRecord = async (item: Record<string, unknown>) => {
    if (messageId && String(item.message_id || '') !== messageId) return { record: item, changed: false }
    const message = await enrich(decodeSegments(item.message), String(item.raw_message || ''))
    const changed = message.some(segment => segment.type === 'bilibili')
    return { record: changed ? { ...item, message } : item, changed }
  }
  const dir = path.join(ports.cwd ?? process.cwd(), 'data/message_archive/group', groupId)
  const files = (await fs.promises.readdir(dir).catch(() => [] as string[])).filter(name => name.endsWith('.ndjson')).sort()
  let archiveChanged = 0
  for (const name of files) {
    const file = path.join(dir, name)
    const original = await fs.promises.readFile(file, 'utf8')
    const output: string[] = []
    let fileChanged = false
    for (const line of original.split(/\r?\n/)) {
      if (!line.trim()) continue
      let item: Record<string, unknown> | null
      try { item = record(JSON.parse(line)) } catch { item = null }
      if (!item) { output.push(line); continue }
      const result = await enrichRecord(item)
      output.push(JSON.stringify(result.record))
      if (result.changed) { archiveChanged++; fileChanged = true }
    }
    if (!fileChanged) continue
    const stat = await fs.promises.stat(file)
    const temp = `${file}.bilibili-${process.pid}.tmp`
    await fs.promises.writeFile(temp, `${output.join('\n')}\n`, { mode: stat.mode })
    await fs.promises.rename(temp, file)
  }
  const key = `ytbot:messages:group:${groupId}`
  const raw = redisCli(['--raw', 'GET', key], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim()
  let redisChanged = 0
  if (raw) {
    const values: unknown = JSON.parse(raw)
    if (!Array.isArray(values)) throw new Error('Redis 消息记录必须为数组')
    const records = (values as unknown[]).map(value => {
      const item = record(value)
      if (!item) throw new Error('Redis 消息记录包含无效条目')
      return item
    })
    for (let index = 0; index < records.length; index++) {
      const item = records[index]
      if (!item) continue
      const result = await enrichRecord(item)
      if (!result.changed) continue
      const card = decodeSegments(result.record.message).find(segment => segment.type === 'bilibili')
      const links = formatBilibiliHistoryLinks(card)
      result.record.content = links ? `${formatBilibiliHistoryText(card)} [${links}]` : formatBilibiliHistoryText(card)
      records[index] = result.record
      redisChanged++
    }
    if (redisChanged) {
      const ttl = Number(redisCli(['--raw', 'TTL', key], { encoding: 'utf8' }).trim())
      const args = ['SET', key, JSON.stringify(records)]
      if (ttl > 0) args.push('EX', String(ttl))
      redisCli(args, { stdio: 'ignore', maxBuffer: 32 * 1024 * 1024 })
    }
  }
  const result = { groupId, messageId: messageId || null, archiveChanged, redisChanged }
  ;(ports.logger ?? console).log(JSON.stringify(result))
  return result
}
