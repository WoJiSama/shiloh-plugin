import fs from "fs"
import path from "path"
import type { PersonaScope } from "../../../contracts/persona.js"

interface ReplyAttribution { kind:"self"|"other"|"unknown"; viewer?:PersonaScope }
export interface Episode { at:number; date:string; userId:string;userName:string;summary:string;reply:string;source?:PersonaScope;replyAttribution?:ReplyAttribution }
interface EpisodeOptions { groupId?:string|number;userId?:string|number;userName?:string;summary?:string;reply?:string;at?:number;maxPerGroup?:number;baseDir?:string;terms?:string[];days?:number;limit?:number;minAgeMs?:number;source?:PersonaScope;viewer?:PersonaScope }
interface EpisodePromptOptions { viewer?:PersonaScope }
function isEpisode(value:unknown):value is Episode { if(!value||typeof value!=='object')return false;const row=value as Record<string,unknown>;return typeof row.at==='number'&&Number.isFinite(row.at)&&['date','userId','userName','summary','reply'].every(key=>typeof row[key]==='string') }

function normalizeScope(value:unknown):PersonaScope|undefined {
  if (!value || typeof value !== "object") return undefined
  const row = value as Record<string, unknown>
  const fields = ["botId", "personaId", "personaVersion", "personaName"] as const
  if (!fields.every(field => typeof row[field] === "string" && String(row[field]).trim())) return undefined
  return {
    botId: String(row.botId).trim(),
    personaId: String(row.personaId).trim(),
    personaVersion: String(row.personaVersion).trim(),
    personaName: String(row.personaName).trim()
  }
}

function attributeReply(episode:Episode, viewer?:PersonaScope):ReplyAttribution {
  const source = normalizeScope(episode.source)
  const scope = normalizeScope(viewer)
  if (!source) return { kind: "unknown", ...(scope ? { viewer: scope } : {}) }
  const ownReply = scope && source.botId === scope.botId && source.personaId === scope.personaId && source.personaVersion === scope.personaVersion
  return { kind: ownReply ? "self" : "other", ...(scope ? { viewer: scope } : {}) }
}

// 召回视图携带当前读者，持久日志只保存事实来源；换 bot/人格时必须重新归属。
function episodeForViewer(episode:Episode, viewer?:PersonaScope):Episode {
  const source = normalizeScope(episode.source)
  return { ...episode, ...(source ? { source } : {}), replyAttribution: attributeReply(episode, viewer) }
}

// 跨天情节记忆：每群一条 NDJSON 追加日志，按时间线回放"发生过什么"。
// 目的是接住「上次说的那个」「昨天那件事」这类时间指代——
// 检索按 关键词命中 + 时间近因 排序，不做向量（成本与精度现阶段不匹配）。

const DEFAULT_MAX_PER_GROUP = 200
const memoryFallback = new Map<string,Episode[]>()
const loadedFiles = new Set<string>()

function resolveDir(baseDir = "") {
  if (String(baseDir || "").trim()) return path.resolve(String(baseDir))
  const cwd = process.cwd()
  const candidates = [
    path.join(cwd, "plugins", "shiloh-plugin", "data", "episodic"),
    path.join(cwd, "data", "episodic")
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(path.dirname(candidate))) return candidate
  }
  return candidates.at(-1)!
}

function filePathFor(groupId = "", baseDir = "") {
  const safe = String(groupId || "").replace(/[^\w-]/g, "") || "unknown"
  return path.join(resolveDir(baseDir), `${safe}.ndjson`)
}

function loadEpisodes(groupId = "", baseDir = "") {
  const key = String(groupId || "")
  const file = filePathFor(key, baseDir)
  if (loadedFiles.has(file)) return memoryFallback.get(file) || []
  loadedFiles.add(file)
  let episodes: Episode[] = []
  try {
    const raw = fs.readFileSync(file, "utf8")
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue
      try {
        const value:unknown = JSON.parse(line)
        if (!isEpisode(value)) continue
        const source = normalizeScope(value.source)
        // 旧记录仍可分享群友原话，但磁盘里任何归属视图都不能作为自身经历的凭证。
        episodes.push({ at:value.at, date:value.date, userId:value.userId, userName:value.userName, summary:value.summary, reply:value.reply, ...(source ? { source } : {}) })
      } catch {}
    }
  } catch {}
  memoryFallback.set(file, episodes)
  return episodes
}

/**
 * 回合尾声记录一条情节：谁、让 bot 做了/聊了什么、bot 回了什么（节选）。
 * 追加写 NDJSON 并裁剪内存环形缓冲，写失败不影响回合。
 */
export function recordEpisode({ groupId = "", userId = "", userName = "", summary = "", reply = "", at = Date.now(), maxPerGroup = DEFAULT_MAX_PER_GROUP, baseDir = "", source }:EpisodeOptions = {}) {
  const key = String(groupId || "")
  if (!key || !String(summary || "").trim()) return null
  const cap = Math.max(20, Number(maxPerGroup) || DEFAULT_MAX_PER_GROUP)
  const replySource = normalizeScope(source)
  const episode:Episode = {
    at,
    date: new Date(at).toISOString().slice(0, 10),
    userId: String(userId || ""),
    userName: String(userName || "").slice(0, 24),
    summary: String(summary || "").replace(/\s+/g, " ").slice(0, 120),
    reply: String(reply || "").replace(/\s+/g, " ").slice(0, 120),
    ...(replySource ? { source: replySource } : {})
  }
  const episodes = loadEpisodes(key, baseDir)
  episodes.push(episode)
  if (episodes.length > cap) episodes.splice(0, episodes.length - cap)
  memoryFallback.set(filePathFor(key, baseDir), episodes)
  try {
    const file = filePathFor(key, baseDir)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `${JSON.stringify(episode)}\n`, "utf8")
  } catch {}
  return episode
}

const TIME_DEIXIS_PATTERN = /上次|上回|昨天|前天|那天|之前说|之前聊|前几天|上周|刚才说|早些时候/

/** 用户话里带时间指代时才值得翻情节日志 */
export function hasTemporalDeixis(text = "") {
  return TIME_DEIXIS_PATTERN.test(String(text || ""))
}

function scoreEpisode(episode:Episode, terms:string[] = [], now = Date.now()) {
  const haystack = `${episode.summary}${episode.reply}`
  let score = 0
  for (const term of terms) {
    if (term && haystack.includes(term)) score += 5
  }
  const ageHours = Math.max(0, (now - Number(episode.at || 0)) / 3600000)
  score += Math.max(0, 5 - ageHours / 24) // 一天内近因加分，逐日衰减
  return score
}

/**
 * 按关键词 + 近因召回情节（默认 7 天内，最多 5 条）。
 * terms 为空时返回最近几条（纯时间线回放）。
 */
export function recallEpisodes({ groupId = "", terms = [], days = 7, limit = 5, baseDir = "", viewer }:EpisodeOptions = {}) {
  const key = String(groupId || "")
  const episodes = loadEpisodes(key, baseDir)
  if (!episodes.length) return []
  const cutoff = Date.now() - Math.max(1, Number(days) || 7) * 24 * 60 * 60 * 1000
  const fresh = episodes.filter(e => Number(e.at || 0) >= cutoff)
  const words = (Array.isArray(terms) ? terms : []).map(t => String(t || "").trim()).filter(Boolean)
  return fresh
    .map(episode => ({ episode, score: scoreEpisode(episode, words) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Number(limit) || 5))
    .map(item => episodeForViewer(item.episode, viewer))
}

/**
 * 记忆回勾：按用户召回他自己的旧情节（跨天/跨会话的"她记得我"）。
 * minAgeMs 排除太新鲜的记录——半小时内的内容聊天历史里本来就有，
 * 回勾的价值在跨天，不值得重复注入。
 */
export function recallUserEpisodes({ groupId = "", userId = "", days = 7, limit = 2, minAgeMs = 30 * 60 * 1000, baseDir = "", viewer }:EpisodeOptions = {}) {
  const key = String(groupId || "")
  const uid = String(userId || "")
  if (!key || !uid) return []
  const episodes = loadEpisodes(key, baseDir)
  if (!episodes.length) return []
  const now = Date.now()
  const cutoff = now - Math.max(1, Number(days) || 7) * 24 * 60 * 60 * 1000
  const minAge = Math.max(0, Number(minAgeMs) || 0)
  return episodes
    .filter(e => String(e.userId || "") === uid)
    .filter(e => now - Number(e.at || 0) >= minAge && Number(e.at || 0) >= cutoff)
    .slice(-Math.max(1, Number(limit) || 2))
    .reverse()
    .map(episode => episodeForViewer(episode, viewer))
}

function describeWhen(at = 0) {
  const dayMs = 24 * 60 * 60 * 1000
  const days = Math.floor((Date.now() - Number(at || 0)) / dayMs)
  if (days <= 0) return "今天"
  if (days === 1) return "昨天"
  if (days <= 7) return `${days}天前`
  return new Date(at).toISOString().slice(5, 10)
}

function formatReply(episode:Episode, viewer:PersonaScope|undefined, callback = false) {
  if (!episode.reply) return ""
  const attribution = attributeReply(episode, viewer ?? episode.replyAttribution?.viewer)
  if (attribution.kind === "unknown") return ""
  if (attribution.kind === "self") return callback ? `，你当时回：「${episode.reply}」` : `；你回了：「${episode.reply}」`
  const source = normalizeScope(episode.source)!
  const name = source.personaName.replace(/\s+/g, " ")
  return `；${name}（bot ${source.botId}，人设 ${source.personaId}，版本 ${source.personaVersion}）当时回复：「${episode.reply}」`
}

/** 生成注入主 prompt 的情节块，只有完整匹配当前身份的回复可用第一人称。 */
export function buildEpisodicPrompt(episodes:Episode[] = [], { viewer }:EpisodePromptOptions = {}) {
  const list = (Array.isArray(episodes) ? episodes : []).slice(0, 5)
  if (!list.length) return ""
  const lines = ["【近期情节】（按时间线，供接住「上次/昨天」这类指代）"]
  for (const e of list) {
    const who = e.userName ? e.userName : "群友"
    lines.push(`- ${describeWhen(e.at)} ${who}：${e.summary}${formatReply(e, viewer)}`)
  }
  lines.push("用户提到之前的事时优先对照上面的时间线；回复归属以标注为准，其他 bot 或旧人格的回复不能说成自己说过。")
  return lines.join("\n")
}

/**
 * 记忆回勾卡片：这位群友自己的旧情节，作为背景感知注入闲聊。
 * 关键是框定用法——可提可不提，禁止刻意汇报"我记得你说过"。
 */
export function buildUserCallbackPrompt(episodes:Episode[] = [], { userName = "", viewer }:{userName?:string;viewer?:PersonaScope} = {}) {
  const list = (Array.isArray(episodes) ? episodes : []).slice(0, 3)
  if (!list.length) return ""
  const who = String(userName || "").trim() || "这位群友"
  const lines = [`【${who}的旧话题】（背景记忆，不是必聊素材）`]
  for (const e of list) {
    lines.push(`- ${describeWhen(e.at)} 说过：${e.summary}${formatReply(e, viewer, true)}`)
  }
  lines.push("只有当前话题自然接得上时才轻轻提一嘴（像熟人想起旧账那样顺口带过）；接不上就当没有，禁止刻意汇报你记得什么。")
  lines.push("只有明确标作「你当时回」的回复属于当前人格，其他来源的回复不可冒认为自己的经历。")
  return lines.join("\n")
}

export function resetEpisodicMemoryForTests() {
  memoryFallback.clear()
  loadedFiles.clear()
}
