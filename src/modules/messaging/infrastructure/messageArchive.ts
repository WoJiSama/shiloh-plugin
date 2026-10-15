import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import {parseSentPersonaSource} from '../../conversation/domain/personaProvenance.js'
import {findForwardCompleteness, parseForwardCompleteness} from '../../conversation/domain/forwardCompleteness.js'
interface Segment extends Record<string, unknown> { type?: string; data?: Record<string, unknown>; text?: string; id?: unknown }
interface Sender extends Record<string, unknown> { user_id?: unknown; card?: string; nickname?: string; role?: string; title?: string; level?: unknown }
interface Event extends Record<string, unknown> { time?: number | string; timestamp?: number; message_type?: string; group_id?: unknown; user_id?: unknown; message_id?: unknown; raw_message?: string; msg?: string; message?: Segment[]; sender?: Sender; group?: { name?: string }; group_name?: string; notice_type?: string; sub_type?: string }
interface ArchiveRecord extends Event { timestamp: number; message_type: string; time: string }
interface Context { skipTypes?: string[]; resolveName?(id: unknown): string; replyPreview?(id: string): { name: string; text?: string } | null | undefined; imageLabel?(seg: unknown): string }
interface Query { type?: string; groupId?: unknown; userId?: unknown; startTime?: number; endTime?: number; around?: number; limit?: number; matchLimit?: number; qq?: unknown; messageId?: unknown; keyword?: string; regex?: string; hasImage?: boolean; hasAt?: boolean; hasReply?: boolean }
interface Config { enabled: boolean; retentionDays: number; includePrivate: boolean; includeGroups: string[]; excludeGroups: string[]; globalAdmins: string[]; groupAdmins: { groupId: string; admins: string[] }[]; maxMessageLength: number; storeMediaUrl: boolean; downloadMedia: boolean; baseDir: string; cleanupIntervalHours: number }
interface Logger { warn?(message: string): void; info?(message: string): void }
export interface ArchivePorts {
 getMentionTargetId(value: unknown): unknown; safeTruncateUnicode(text: string, max: number, suffix: string): string;
 enrichBilibiliMessageSegments(message: Segment[] | undefined, text: string): Promise<Segment[]>;
 enrichDouyinMessageSegments(message: Segment[], text: string): Promise<Segment[]>;
 enrichYoutubeMessageSegments(message: Segment[], text: string): Promise<Segment[]>;
 enrichPixivMessageSegments(message: Segment[], text: string): Promise<Segment[]>;
 formatBilibiliHistoryLinks(seg: Segment): string; formatBilibiliHistoryText(seg: Segment): string;
 formatDouyinHistoryLinks(seg: Segment): string; formatDouyinHistoryText(seg: Segment): string;
 formatYoutubeHistoryLinks(seg: Segment): string; formatYoutubeHistoryText(seg: Segment): string;
 formatPixivHistoryLinks(seg: Segment): string; formatPixivHistoryText(seg: Segment): string;
 qqFaceText(id: unknown): string;
 queue: { run<T>(key: string, work: () => Promise<T>): Promise<T> };
 defaultLogger?: Logger; defaultRedis?: unknown;
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
function verifiedForwardSegment(segment: Segment): Segment {
 if (segment.type !== 'forward_context') return segment
 const {completeness: _unverifiedCompleteness, ...record} = segment
 const completeness = parseForwardCompleteness(segment.completeness)
 return {...record, ...(completeness ? {completeness} : {})}
}
function parseArchiveRecord(text: string): ArchiveRecord {
 const value: unknown = JSON.parse(text)
 const row = object(value)
 if (!Number.isFinite(row.timestamp) || typeof row.message_type !== 'string' || typeof row.time !== 'string') throw new Error('Invalid archive record')
 if (row.message !== undefined && (!Array.isArray(row.message) || row.message.some(item => item === null || typeof item !== 'object'))) throw new Error('Invalid archive segments')
 if (row.sender !== undefined && (row.sender === null || typeof row.sender !== 'object')) throw new Error('Invalid archive sender')
 const personaSource = parseSentPersonaSource(row.personaSource, row.source, object(row.sender).user_id ?? row.user_id)
 const forwardCompleteness = parseForwardCompleteness(row.forwardCompleteness) || findForwardCompleteness(row.message, row.forward_context)
 const {personaSource: _unverifiedSource, forwardCompleteness: _unverifiedCompleteness, forward_context: _runtimeContext, ...record} = row
 const message = Array.isArray(row.message) ? row.message.map(segment => verifiedForwardSegment(segment as Segment)) : undefined
 return {...record, ...(message ? {message} : {}), ...(personaSource ? {personaSource} : {}), ...(forwardCompleteness ? {forwardCompleteness} : {})} as ArchiveRecord
}
export function createArchiveManagerClass(ports: ArchivePorts) {
const { getMentionTargetId, safeTruncateUnicode, enrichBilibiliMessageSegments, enrichDouyinMessageSegments, enrichYoutubeMessageSegments, enrichPixivMessageSegments, formatBilibiliHistoryLinks, formatBilibiliHistoryText, formatDouyinHistoryLinks, formatDouyinHistoryText, formatYoutubeHistoryLinks, formatYoutubeHistoryText, formatPixivHistoryLinks, formatPixivHistoryText, qqFaceText } = ports
const archiveWriteQueue = ports.queue
const archiveIdentityIndexes = new Map<string, Set<string>>()
const MAX_ARCHIVE_IDENTITY_FILES = 256

const DEFAULT_CONFIG: Config = {
  enabled: false,
  retentionDays: 7,
  includePrivate: false,
  includeGroups: [],
  excludeGroups: [],
  globalAdmins: [],
  groupAdmins: [],
  maxMessageLength: 5000,
  storeMediaUrl: true,
  downloadMedia: false,
  baseDir: "data/message_archive",
  cleanupIntervalHours: 6
}

function pad(n: unknown) {
  return String(n).padStart(2, "0")
}

function formatDate(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function formatTime(ts: unknown) {
  const date = new Date(Number(ts || Date.now()))
  return `${formatDate(date)} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function formatClock(ts: unknown) {
  const date = new Date(Number(ts || Date.now()))
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function toArray(value: unknown) {
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean)
  if (value === undefined || value === null || value === "") return []
  return String(value).split(/[,，\s]+/).map(v => v.trim()).filter(Boolean)
}

function normalizeGroupAdmins(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.map(input => {
    const item = object(input)
    const groupId = String(item?.groupId || item?.group_id || "").trim()
    const admins = toArray(item?.admins || item?.users || item?.userIds)
    return groupId && admins.length ? { groupId, admins } : null
  }).filter((item): item is { groupId: string; admins: string[] } => item !== null)
}

function normalizeMessageSegments(message: Segment[] = [], storeMediaUrl = true) {
  if (!Array.isArray(message)) return []
  return message.map(seg => {
    if (seg?.type === "forward_context") {
      const completeness = parseForwardCompleteness(seg.completeness)
      return {
        type: "forward_context",
        text: String(seg.text || ""),
        forward_ids: Array.isArray(seg.forward_ids) ? seg.forward_ids.map(String) : [],
        media: Array.isArray(seg.media) ? seg.media : [],
        forward_nodes: Array.isArray(seg.forward_nodes) ? seg.forward_nodes : [],
        ...(completeness ? {completeness} : {})
      }
    }
    if (seg?.type === "bilibili") {
      const next: Segment = { type: "bilibili", platform: "bilibili" }
      for (const key of ["title", "description", "bvid", "ep_id", "aid", "cid", "owner", "owner_mid", "duration", "page_count", "pages", "short_url", "page_url", "video_url", "cover_url", "stats", "shared_by", "shared_by_qq", "published_at", "metadata_status"]) {
        if (seg[key] === undefined || (!storeMediaUrl && ["short_url", "page_url", "video_url", "cover_url"].includes(key))) continue
        next[key] = seg[key]
      }
      if (storeMediaUrl && !next.video_url && next.page_url) next.video_url = next.page_url
      return next
    }
    if (seg?.type === "douyin") {
      const next: Segment = { type: "douyin", platform: "douyin" }
      for (const key of ["title", "description", "aweme_id", "author", "author_uid", "duration", "short_url", "page_url", "video_url", "cover_url", "stats", "metadata_status"]) {
        if (seg[key] === undefined || (!storeMediaUrl && ["short_url", "page_url", "video_url", "cover_url"].includes(key))) continue
        next[key] = seg[key]
      }
      if (storeMediaUrl && !next.video_url && next.page_url) next.video_url = next.page_url
      return next
    }
    if (seg?.type === "youtube") {
      const next: Segment = { type: "youtube", platform: "youtube" }
      for (const key of ["title", "description", "video_id", "channel", "channel_id", "duration", "short_url", "page_url", "video_url", "cover_url", "stats", "published_at", "upload_date", "age_limit", "availability", "is_live", "was_live", "metadata_status"]) {
        if (seg[key] === undefined || (!storeMediaUrl && ["short_url", "page_url", "video_url", "cover_url"].includes(key))) continue
        next[key] = seg[key]
      }
      if (storeMediaUrl && !next.video_url && next.page_url) next.video_url = next.page_url
      return next
    }
    if (seg?.type === "pixiv") {
      const next: Segment = { type: "pixiv", platform: "pixiv" }
      for (const key of ["title", "description", "artwork_id", "author", "author_id", "tags", "page_count", "width", "height", "x_restrict", "sanity_level", "short_url", "page_url", "cover_url", "stats", "published_at", "metadata_status"]) {
        if (seg[key] === undefined || (!storeMediaUrl && ["short_url", "page_url", "cover_url"].includes(key))) continue
        next[key] = seg[key]
      }
      return next
    }
    const next: Segment = { type: seg?.type || "unknown" }
    const data = seg?.data && typeof seg.data === "object" ? seg.data : seg
    for (const key of ["text", "qq", "id", "file", "summary", "url", "sub_type", "fid"]) {
      if (data?.[key] === undefined) continue
      if (!storeMediaUrl && key === "url") continue
      next[key] = data[key]
    }
    return next
  })
}

function messageHasType(record: Event, type: string) {
  return Array.isArray(record.message) && record.message.some(seg => seg?.type === type)
}

function isRecallNotice(record: Event = {}) {
  return record.archive_kind === "notice" && /(^|\.)recall$/.test(String(record.notice_type || "").trim())
}

// 消息表情回应在 QQ 里只是消息上的角标,不是一条独立消息,查询聊天记录时不展示。
function isQueryHiddenNotice(record: Event = {}) {
  if (record.archive_kind !== "notice") return false
  if (isRecallNotice(record)) return true
  return /(^|\.)msg_emoji_like$/.test(String(record.notice_type || "").trim())
}

function archiveRecordIdentity(record: Event = {}) {
  if (record.event_id) return `event:${String(record.event_id)}`
  if (record.message_id === undefined || record.message_id === null || record.message_id === "") return ""
  return [
    "message",
    String(record.archive_kind || "message"),
    String(record.message_id),
    String(record.user_id || "")
  ].join(":")
}

function rememberArchiveIndex(file: string, identities: Set<string>) {
  archiveIdentityIndexes.delete(file)
  archiveIdentityIndexes.set(file, identities)
  while (archiveIdentityIndexes.size > MAX_ARCHIVE_IDENTITY_FILES) {
    archiveIdentityIndexes.delete(archiveIdentityIndexes.keys().next().value!)
  }
}

async function getArchiveIdentityIndex(file: string) {
  const cached = archiveIdentityIndexes.get(file)
  if (cached) {
    rememberArchiveIndex(file, cached)
    return cached
  }
  const identities = new Set<string>()
  const text = await fs.promises.readFile(file, "utf8").catch(error => {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return ""
    throw error
  })
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const identity = archiveRecordIdentity(parseArchiveRecord(line))
      if (identity) identities.add(identity)
    } catch {}
  }
  rememberArchiveIndex(file, identities)
  return identities
}

function decodeEntities(text: unknown = "") {
  return String(text || "")
    .replace(/&amp;/g, "&")
    .replace(/&#91;/g, "[")
    .replace(/&#93;/g, "]")
    .replace(/&quot;/g, "\"")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
}

function renderSegment(seg: Segment = {}, ctx: Context | null = null) {
  const type = seg?.type || "unknown"
  const skipped = Array.isArray(ctx?.skipTypes) && ctx.skipTypes.includes(type)
  if (skipped) return ""
  if (type === "text") return decodeEntities(seg.text || "")
  if (type === "at") return `@${ctx?.resolveName ? ctx.resolveName(getMentionTargetId(seg)) : (getMentionTargetId(seg) || "")}`
  if (type === "reply") {
    const preview = ctx?.replyPreview ? ctx.replyPreview(String(seg.id || "")) : null
    if (preview) return preview.text ? `[回复 ${preview.name}：${preview.text}]` : `[回复 ${preview.name}]`
    return ctx ? "" : `[回复:${seg.id || ""}]`
  }
  if (type === "face") return qqFaceText(seg.id)
  if (type === "image") {
    const summary = decodeEntities(seg.summary || "").replace(/^\[|\]$/g, "")
    return summary ? `[图片:${summary}]` : "[图片]"
  }
  if (type === "file") return `[文件:${seg.file || seg.name || ""}]`
  if (type === "video") return "[视频]"
  if (type === "bilibili") {
    const links = formatBilibiliHistoryLinks(seg)
    return links ? `${formatBilibiliHistoryText(seg)} [${links}]` : formatBilibiliHistoryText(seg)
  }
  if (type === "douyin") {
    const links = formatDouyinHistoryLinks(seg)
    return links ? `${formatDouyinHistoryText(seg)} [${links}]` : formatDouyinHistoryText(seg)
  }
  if (type === "youtube") {
    const links = formatYoutubeHistoryLinks(seg)
    return links ? `${formatYoutubeHistoryText(seg)} [${links}]` : formatYoutubeHistoryText(seg)
  }
  if (type === "pixiv") {
    const links = formatPixivHistoryLinks(seg)
    return links ? `${formatPixivHistoryText(seg)} [${links}]` : formatPixivHistoryText(seg)
  }
  if (type === "record") return "[语音]"
  if (type === "forward") return "[聊天记录]"
  if (type === "forward_context") return `[合并转发记录]\n${decodeEntities(seg.text || "")}`.trim()
  if (type === "json" || type === "xml" || type === "markdown") return "[卡片消息]"
  if (type === "notice") return decodeEntities(seg.text || "[群通知]")
  return `[${type}消息]`
}

function renderReadableMessage(record: Event = {}, ctx: Context | null = null) {
  if (Array.isArray(record.message) && record.message.length) {
    const text = record.message.map(seg => renderSegment(seg, ctx)).join("").trim()
    if (text) return text
  }
  // CQ 码替换必须在未解码的原文上做:值里的 [ ] 是 &#91;/&#93; 实体,
  // 先解码会让中括号截断 CQ 码匹配,漏出 ,file=... 之类的尾巴。
  const skipImage = Array.isArray(ctx?.skipTypes) && ctx.skipTypes.includes("image")
  return decodeEntities(String(record.raw_message || "")
    .replace(/\[CQ:reply,id=([^\],]+)[^\]]*\]/g, (_, id) => {
      const preview = ctx?.replyPreview ? ctx.replyPreview(String(id)) : null
      if (preview) return preview.text ? `[回复 ${preview.name}：${preview.text}]` : `[回复 ${preview.name}]`
      return ctx ? "" : `[回复:${id}]`
    })
    .replace(/\[CQ:at,[^\]]*(?:qq|user_id|id|uin)=(\d+)[^\]]*\]/g, (_, userId) =>
      `@${ctx?.resolveName ? ctx.resolveName(userId) : userId}`)
    .replace(/\[CQ:image(?:,[^\]]*summary=([^,\]]*))?[^\]]*\]/g, (_, summary) => {
      if (skipImage) return ""
      const label = decodeEntities(summary).replace(/^\[|\]$/g, "")
      return label ? `[图片:${label}]` : "[图片]"
    })
    .replace(/\[CQ:face,id=([^\],]+)[^\]]*\]/g, (_, id) => qqFaceText(id))
    .replace(/\[CQ:record[^\]]*\]/g, "[语音]")
    .replace(/\[CQ:video[^\]]*\]/g, "[视频]")
    .replace(/\[CQ:json[^\]]*\]/g, "[卡片消息]")
    .replace(/\[CQ:xml[^\]]*\]/g, "[卡片消息]"))
    .trim()
}

class MessageArchiveManager {
  cwd: string; logger: Logger | undefined; redis: unknown; configPath: string; defaultConfigPath: string; configMtimeMs: number; config: Config; lastCleanupAt: number;
  constructor({ cwd = process.cwd(), logger = ports.defaultLogger, redis = ports.defaultRedis }: { cwd?: string; logger?: Logger; redis?: unknown } = {}) {
    this.cwd = cwd
    this.logger = logger
    this.redis = redis
    this.configPath = path.join(cwd, "plugins/shiloh-plugin/config/message.yaml")
    this.defaultConfigPath = path.join(cwd, "plugins/shiloh-plugin/config_default/message.yaml")
    this.configMtimeMs = 0
    this.config = { ...DEFAULT_CONFIG }
    this.lastCleanupAt = 0
  }

  getConfig() {
    const file = fs.existsSync(this.configPath) ? this.configPath : this.defaultConfigPath
    try {
      const stat = fs.statSync(file)
      if (stat.mtimeMs === this.configMtimeMs) return this.config
      const parsed: unknown = YAML.parse(fs.readFileSync(file, "utf8"))
      const raw = object(object(object(parsed).pluginSettings).messageArchive)
      this.config = {
        ...DEFAULT_CONFIG,
        enabled: raw.enabled !== false && Boolean(raw.enabled ?? DEFAULT_CONFIG.enabled),
        retentionDays: Number(raw.retentionDays) || DEFAULT_CONFIG.retentionDays,
        includePrivate: Boolean(raw.includePrivate),
        maxMessageLength: Number(raw.maxMessageLength) || DEFAULT_CONFIG.maxMessageLength,
        storeMediaUrl: raw.storeMediaUrl !== false,
        downloadMedia: Boolean(raw.downloadMedia),
        baseDir: typeof raw.baseDir === 'string' ? raw.baseDir : DEFAULT_CONFIG.baseDir,
        cleanupIntervalHours: Number(raw.cleanupIntervalHours) || DEFAULT_CONFIG.cleanupIntervalHours,
        includeGroups: toArray(raw.includeGroups),
        excludeGroups: toArray(raw.excludeGroups),
        globalAdmins: toArray(raw.globalAdmins),
        groupAdmins: normalizeGroupAdmins(raw.groupAdmins)
      }
      this.configMtimeMs = stat.mtimeMs
    } catch (error) {
      this.logger?.warn?.(`[MessageArchive] 读取配置失败: ${errorMessage(error)}`)
      this.config = { ...DEFAULT_CONFIG }
    }
    return this.config
  }

  getBaseDir() {
    const cfg = this.getConfig()
    return path.isAbsolute(cfg.baseDir)
      ? cfg.baseDir
      : path.join(this.cwd, "plugins/shiloh-plugin", cfg.baseDir)
  }

  shouldRecord(e: Event, cfg = this.getConfig()) {
    if (!cfg.enabled) return false
    if (!e?.message_type) return false
    if (e.message_type === "private" && !cfg.includePrivate) return false
    if (e.message_type === "group") {
      const gid = String(e.group_id || "")
      if (cfg.includeGroups.length && !cfg.includeGroups.includes(gid)) return false
      if (cfg.excludeGroups.includes(gid)) return false
    }
    return true
  }

  shouldRecordNotice(e: Event, cfg = this.getConfig()) {
    if (!cfg.enabled) return false
    const groupId = e?.group_id
    if (!groupId) return false
    const gid = String(groupId)
    if (cfg.includeGroups.length && !cfg.includeGroups.includes(gid)) return false
    if (cfg.excludeGroups.includes(gid)) return false
    return true
  }

  getGroupAdmins(groupId: unknown, cfg = this.getConfig()) {
    const item = cfg.groupAdmins.find(entry => entry.groupId === String(groupId))
    return item?.admins || []
  }

  canQuery(e: Event, groupId: unknown, cfg = this.getConfig()) {
    const userId = String(e?.user_id || "")
    if (!userId || !groupId) return false
    if (e?.isMaster) return true
    if (cfg.globalAdmins.includes(userId)) return true
    if (String(e?.group_id || "") !== String(groupId)) return false
    if (e?.sender?.role === "owner") return true
    return this.getGroupAdmins(groupId, cfg).includes(userId)
  }

  canManageGroupAdmins(e: Event, groupId: unknown, cfg = this.getConfig()) {
    const userId = String(e?.user_id || "")
    if (!userId || !groupId) return false
    if (e?.isMaster) return true
    return String(e?.group_id || "") === String(groupId) && e?.sender?.role === "owner"
  }

  async appendRecordOnce(file: string, record: Event) {
    return await archiveWriteQueue.run(file, async () => {
      const identity = archiveRecordIdentity(record)
      const identities = await getArchiveIdentityIndex(file)
      if (identity && identities.has(identity)) return false
      await fs.promises.appendFile(file, `${JSON.stringify(record)}\n`, "utf8")
      if (identity) identities.add(identity)
      return true
    })
  }

  async recordMessage(e: Event, options: { preEnrichedMessage?: Segment[]; throwOnError?: boolean } = {}) {
    const cfg = this.getConfig()
    if (!this.shouldRecord(e, cfg)) return
    try {
      const enrichedMessage = Array.isArray(options.preEnrichedMessage)
        ? options.preEnrichedMessage
        : await enrichPixivMessageSegments(
          await enrichYoutubeMessageSegments(
            await enrichDouyinMessageSegments(
              await enrichBilibiliMessageSegments(e.message, e.raw_message || e.msg || ""),
              e.raw_message || e.msg || ""
            ),
            e.raw_message || e.msg || ""
          ),
          e.raw_message || e.msg || ""
        )
      const record = this.buildRecord({ ...e, message: enrichedMessage }, cfg)
      // 播放直链有时效，不写入 NDJSON/Redis；实时搬运仍需在本轮使用它。
      Object.defineProperty(record, "runtimeMessage", { value: enrichedMessage, enumerable: false })
      const dir = path.join(this.getBaseDir(), record.message_type, String(record.group_id || record.user_id || "unknown"))
      await fs.promises.mkdir(dir, { recursive: true })
      await this.appendRecordOnce(path.join(dir, `${formatDate(new Date(record.timestamp))}.ndjson`), record)
      this.cleanupExpired().catch(error => this.logger?.warn?.(`[MessageArchive] 清理过期归档失败: ${errorMessage(error)}`))
      return record
    } catch (error) {
      this.logger?.warn?.(`[MessageArchive] 写入失败: ${errorMessage(error)}`)
      if (options.throwOnError) throw error
      return null
    }
  }

  async recordNotice(e: Event, options: { throwOnError?: boolean } = {}) {
    const cfg = this.getConfig()
    if (!this.shouldRecordNotice(e, cfg)) return
    try {
      const record = this.buildNoticeRecord(e)
      const dir = path.join(this.getBaseDir(), "group", String(record.group_id || "unknown"))
      await fs.promises.mkdir(dir, { recursive: true })
      await this.appendRecordOnce(path.join(dir, `${formatDate(new Date(record.timestamp))}.ndjson`), record)
      if (isRecallNotice(record) && record.message_id !== null && record.message_id !== undefined && String(record.message_id) !== "") {
        const marked = await this.markMessageRecalled(record)
        if (marked) this.logger?.info?.(`[MessageArchive] 消息 ${record.message_id} 已标记撤回（群 ${record.group_id}）`)
      }
      this.cleanupExpired().catch(error => this.logger?.warn?.(`[MessageArchive] 清理过期归档失败: ${errorMessage(error)}`))
      return record
    } catch (error) {
      this.logger?.warn?.(`[MessageArchive] 通知写入失败: ${errorMessage(error)}`)
      if (options.throwOnError) throw error
      return null
    }
  }

  async markMessageRecalled(noticeRecord: Event = {}) {
    const messageId = String(noticeRecord.message_id ?? "")
    if (!messageId) return false
    const dir = path.join(this.getBaseDir(), "group", String(noticeRecord.group_id || "unknown"))
    const files = (await fs.promises.readdir(dir).catch(() => []))
      .filter(name => name.endsWith(".ndjson"))
      .sort()
      .reverse()
    for (const name of files.slice(0, 8)) {
      if (await this.rewriteFileMarkingRecall(path.join(dir, name), messageId, noticeRecord)) return true
    }
    return false
  }

  rewriteFileMarkingRecall(file: string, messageId: string, noticeRecord: Event) {
    return archiveWriteQueue.run(file, async () => {
      const text = await fs.promises.readFile(file, "utf8").catch(() => null)
      if (!text) return false
      let marked = false
      const out = text.split("\n").map(line => {
        if (marked || !line.trim()) return line
        try {
          const record = parseArchiveRecord(line)
          if (record.archive_kind === "notice" || String(record.message_id ?? "") !== messageId) return line
          if (record.recalled) {
            marked = true
            return line
          }
          record.recalled = true
          record.recalled_at = Number(noticeRecord.timestamp) || Date.now()
          record.recalled_by = Number(noticeRecord.operator_id) || null
          marked = true
          return JSON.stringify(record)
        } catch {
          return line
        }
      })
      if (!marked) return false
      const tmp = `${file}.recall-tmp`
      await fs.promises.writeFile(tmp, out.join("\n"), "utf8")
      await fs.promises.rename(tmp, file)
      return true
    })
  }

  buildRecord(e: Event, cfg = this.getConfig()) {
    const timestamp = Number(e.time ? Number(e.time) * 1000 : Date.now())
    const raw = String(e.raw_message || e.msg || "")
    const maxLen = Math.max(100, Number(cfg.maxMessageLength) || DEFAULT_CONFIG.maxMessageLength)
    const personaSource = parseSentPersonaSource(e.personaSource, e.source, e.sender?.user_id ?? e.user_id)
    const forwardCompleteness = parseForwardCompleteness(e.forwardCompleteness) || findForwardCompleteness(e.message, e.forward_context)
    return {
      version: 1,
      event_id: e.event_id || null,
      timestamp,
      time: formatTime(timestamp),
      message_type: e.message_type || "unknown",
      group_id: e.message_type === "group" ? Number(e.group_id) : null,
      group_name: e.group_name || e.group?.name || "",
      user_id: Number(e.user_id || e.sender?.user_id || 0),
      sender: {
        user_id: Number(e.sender?.user_id || e.user_id || 0),
        nickname: e.sender?.card || e.sender?.nickname || "",
        card: e.sender?.card || "",
        role: e.sender?.role || "",
        title: e.sender?.title || "",
        level: e.sender?.level || ""
      },
      message_id: e.message_id || null,
      raw_message: raw.length > maxLen ? safeTruncateUnicode(raw, maxLen, "...") : raw,
      raw_truncated: raw.length > maxLen,
      message: normalizeMessageSegments(e.message, cfg.storeMediaUrl),
      source: e.source || null,
      ...(personaSource ? {personaSource} : {}),
      ...(forwardCompleteness ? {forwardCompleteness} : {})
    }
  }

  buildNoticeRecord(e: Event) {
    const timestamp = Number(e.time ? Number(e.time) * 1000 : Date.now())
    const noticeType = [e.notice_type, e.sub_type].filter(Boolean).join(".") || "notice"
    const operatorId = e.operator_id || e.operatorId || 0
    const userId = e.user_id || e.target_id || 0
    const messageId = e.message_id || e.messageId || null
    const raw = this.formatNoticeText(e, noticeType)
    return {
      version: 1,
      event_id: e.event_id || null,
      archive_kind: "notice",
      timestamp,
      time: formatTime(timestamp),
      message_type: "group",
      notice_type: noticeType,
      group_id: Number(e.group_id || 0),
      group_name: e.group_name || e.group?.name || "",
      user_id: Number(userId || operatorId || 0),
      operator_id: operatorId ? Number(operatorId) : null,
      target_id: e.target_id ? Number(e.target_id) : null,
      sender: {
        user_id: Number(userId || operatorId || 0),
        nickname: "",
        card: "",
        role: "",
        title: "",
        level: ""
      },
      message_id: messageId,
      raw_message: raw,
      raw_truncated: false,
      message: [{ type: "notice", text: raw }],
      source: null
    }
  }

  formatNoticeText(e: Event, noticeType = "notice") {
    const userId = e.user_id || e.target_id || ""
    const operatorId = e.operator_id || e.operatorId || ""
    if (/increase/.test(noticeType)) return `群成员增加：${operatorId || 0} => ${userId} ${e.sub_type || ""}`.trim()
    if (/decrease/.test(noticeType)) return `群成员减少：${operatorId || 0} => ${userId} ${e.sub_type || ""}`.trim()
    if (/recall/.test(noticeType)) return `群消息撤回：${operatorId || 0} => ${userId} ${e.message_id || ""}`.trim()
    if (/poke/.test(noticeType)) return `群戳一戳：${operatorId || 0} => ${userId}`.trim()
    return `群通知：${noticeType} ${JSON.stringify({
      user_id: e.user_id,
      operator_id: e.operator_id,
      target_id: e.target_id,
      message_id: e.message_id
    })}`
  }

  async cleanupExpired(force = false) {
    const cfg = this.getConfig()
    const intervalMs = Math.max(1, Number(cfg.cleanupIntervalHours) || DEFAULT_CONFIG.cleanupIntervalHours) * 3600 * 1000
    if (!force && Date.now() - this.lastCleanupAt < intervalMs) return
    this.lastCleanupAt = Date.now()

    const retentionDays = Math.max(1, Number(cfg.retentionDays) || DEFAULT_CONFIG.retentionDays)
    const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000
    const base = this.getBaseDir()
    if (!fs.existsSync(base)) return
    const files = await this.listArchiveFiles(base)
    for (const file of files) {
      const name = path.basename(file, ".ndjson")
      const date = new Date(`${name}T23:59:59+08:00`)
      if (!Number.isNaN(date.getTime()) && date.getTime() < cutoff) {
        await fs.promises.unlink(file).catch(() => {})
        archiveIdentityIndexes.delete(file)
      }
    }
  }

  async listArchiveFiles(dir: string): Promise<string[]> {
    const out = []
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) out.push(...await this.listArchiveFiles(full))
      else if (entry.isFile() && entry.name.endsWith(".ndjson")) out.push(full)
    }
    return out.sort()
  }

  async query(options: Query = {}) {
    const type = options.type || "group"
    const id = String(options.groupId || options.userId || "").trim()
    if (!id) throw new Error("缺少群号或用户 ID")

    const dir = path.join(this.getBaseDir(), type, id)
    const files = await this.pickFiles(dir, options)
    const records: ArchiveRecord[] = []
    for (const file of files) {
      const text = await fs.promises.readFile(file, "utf8").catch(() => "")
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          const record = parseArchiveRecord(line)
          if (isQueryHiddenNotice(record)) continue
          if (this.inTimeRange(record, options)) records.push(record)
        } catch {}
      }
    }
    records.sort((a, b) => a.timestamp - b.timestamp)

    const matches = records
      .map((record, index) => ({ record, index }))
      .filter(item => this.matchRecord(item.record, options))

    const around = Math.max(0, Number(options.around || 0))
    const limit = Math.min(1000, Math.max(1, Number(options.limit || 30)))
    if (!around) return matches.slice(-limit).map(item => item.record)

    const picked = new Map<number, ArchiveRecord>()
    for (const item of matches.slice(-Math.max(1, Number(options.matchLimit || 1)))) {
      const start = Math.max(0, item.index - around)
      const end = Math.min(records.length - 1, item.index + around)
      for (let i = start; i <= end; i++) picked.set(i, records[i]!)
    }
    return [...picked.entries()].sort((a, b) => a[0] - b[0]).map(([, record]) => record).slice(-limit)
  }

  async pickFiles(dir: string, options: Query = {}) {
    if (!fs.existsSync(dir)) return []
    const files = (await fs.promises.readdir(dir).catch(() => []))
      .filter(name => name.endsWith(".ndjson"))
      .sort()
    const start = options.startTime ? formatDate(new Date(options.startTime)) : ""
    const end = options.endTime ? formatDate(new Date(options.endTime)) : ""
    return files
      .filter(name => {
        const day = path.basename(name, ".ndjson")
        if (start && day < start) return false
        if (end && day > end) return false
        return true
      })
      .map(name => path.join(dir, name))
  }

  inTimeRange(record: ArchiveRecord, options: Query = {}) {
    if (options.startTime && record.timestamp < Number(options.startTime)) return false
    if (options.endTime && record.timestamp > Number(options.endTime)) return false
    return true
  }

  matchRecord(record: ArchiveRecord, options: Query = {}) {
    if (options.qq && String(record.user_id) !== String(options.qq) && String(record.sender?.user_id) !== String(options.qq) && String(record.operator_id || "") !== String(options.qq)) return false
    if (options.messageId && String(record.message_id) !== String(options.messageId)) return false
    if (options.keyword && !this.getSearchText(record).includes(String(options.keyword))) return false
    if (options.regex) {
      try {
        if (!new RegExp(String(options.regex), "i").test(this.getSearchText(record))) return false
      } catch {
        return false
      }
    }
    if (options.hasImage && !messageHasType(record, "image")) return false
    if (options.hasAt && !messageHasType(record, "at")) return false
    if (options.hasReply && !messageHasType(record, "reply")) return false
    return true
  }

  getSearchText(record: ArchiveRecord) {
    return [
      record.raw_message,
      record.sender?.nickname,
      record.sender?.card,
      record.group_name,
      record.notice_type,
      JSON.stringify(record.message || [])
    ].filter(Boolean).join("\n")
  }

  formatRecord(record: ArchiveRecord, { maxTextLength = 800, compact = false, context = null }: { maxTextLength?: number; compact?: boolean; context?: Context | null } = {}) {
    const name = record.archive_kind === "notice"
      ? "群通知"
      : record.sender?.card || record.sender?.nickname || "未知"
    let text
    if (record.archive_kind === "notice" && context) {
      text = this.formatNoticeDisplay(record, context).replace(/\r/g, "")
    } else {
      text = renderReadableMessage(record, context).replace(/\r/g, "")
    }
    if (text.length > maxTextLength) text = safeTruncateUnicode(text, maxTextLength, "...")
    if (record.recalled) text = `[已撤回] ${text}`
    if (compact) return context ? text : (text || "[非文本消息]")
    const suffix = record.recalled ? `（撤回于 ${record.recalled_at ? formatClock(record.recalled_at) : "未知时间"}）` : ""
    return `[${record.time}]${suffix} ${name}(${record.user_id})${record.message_id ? ` [${record.message_id}]` : ""}\n${text || "[非文本消息]"}`
  }

  // 查询展示时按通知字段重新生成可读文案(归档里的 raw_message 是落档时的原始快照,不含名字)。
  formatNoticeDisplay(record: Event = {}, ctx: Context | null = null) {
    const resolve = (id: unknown) => {
      const key = String(id || "")
      if (!key) return ""
      return ctx?.resolveName ? ctx.resolveName(key) : key
    }
    const noticeType = String(record.notice_type || "")
    const user = resolve(record.user_id)
    const operator = resolve(record.operator_id)
    const target = resolve(record.target_id)
    if (/\.poke$/.test(noticeType)) {
      return record.target_id ? `${operator || user} 戳了戳 ${target}` : `${user || operator} 发起了戳一戳`
    }
    if (/\.increase$/.test(noticeType)) {
      return record.operator_id && record.operator_id !== record.user_id
        ? `${operator} 邀请 ${user} 加入了群聊`
        : `${user} 加入了群聊`
    }
    if (/\.decrease$/.test(noticeType)) {
      return record.operator_id && record.operator_id !== record.user_id
        ? `${user} 被管理员 ${operator} 移出了群聊`
        : `${user} 退出了群聊`
    }
    if (/\.recall$/.test(noticeType)) return `${operator || user} 撤回了一条消息`
    if (/\.ban$/.test(noticeType)) return record.operator_id ? `管理员 ${operator} 禁言了 ${user}` : `${user} 被禁言`
    if (/\.lift_ban$/.test(noticeType)) return `管理员 ${operator} 解除了 ${user} 的禁言`
    if (/\.upload$/.test(noticeType)) return `${user} 上传了文件`
    if (/\.essence$/.test(noticeType)) return `${operator || user} 设置了精华消息`
    if (/\.card$/.test(noticeType)) return `${user} 修改了群名片`
    if (/\.admin$/.test(noticeType)) return `${user} 的管理员身份发生了变更`
    if (/\.honor$/.test(noticeType)) return `${user} 获得了群荣誉`
    if (/\.title$/.test(noticeType)) return `${user} 获得了群头衔`
    if (/\.input$/.test(noticeType)) return `${user} 正在输入`
    return `群通知：${noticeType || "unknown"}`
  }

  // ---- 语义记忆索引的读取辅助 ----

  async listArchiveGroupIds() {
    const dir = path.join(this.getBaseDir(), "group")
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])
    return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
  }

  async readAllGroupMessages(groupId: unknown) {
    const dir = path.join(this.getBaseDir(), "group", String(groupId || ""))
    const files = await this.pickFiles(dir, {})
    const records: ArchiveRecord[] = []
    for (const file of files) {
      const text = await fs.promises.readFile(file, "utf8").catch(() => "")
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          const record = parseArchiveRecord(line)
          if (record.archive_kind === "notice") continue
          records.push(record)
        } catch {}
      }
    }
    records.sort((a, b) => a.timestamp - b.timestamp)
    return records
  }

  async readRecentGroupMessages(groupId: unknown, limit = 40) {
    const all = await this.readAllGroupMessages(groupId)
    return all.slice(-Math.max(1, Number(limit) || 40))
  }

  async findMessagePreviews(groupId: unknown, messageIds: unknown[] = []) {    const wanted = new Set(messageIds.map(id => String(id || "").trim()).filter(Boolean))
    if (!wanted.size) return new Map()
    const dir = path.join(this.getBaseDir(), "group", String(groupId || ""))
    const files = (await fs.promises.readdir(dir).catch(() => []))
      .filter(name => name.endsWith(".ndjson"))
      .sort()
      .reverse()
    const found = new Map()
    for (const name of files.slice(0, 8)) {
      const text = await fs.promises.readFile(path.join(dir, name), "utf8").catch(() => "")
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        let record
        try {
          record = parseArchiveRecord(line)
        } catch {
          continue
        }
        if (record.archive_kind === "notice") continue
        const mid = String(record.message_id ?? "")
        if (!wanted.has(mid)) continue
        const preview = renderReadableMessage(record).replace(/\r/g, "")
        found.set(mid, {
          name: record.sender?.card || record.sender?.nickname || String(record.user_id || ""),
          text: safeTruncateUnicode(preview, 60, "…")
        })
        if (found.size === wanted.size) return found
      }
    }
    return found
  }
}


return MessageArchiveManager
}
