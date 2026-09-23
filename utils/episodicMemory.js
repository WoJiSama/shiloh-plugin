import fs from "fs"
import path from "path"

// 跨天情节记忆：每群一条 NDJSON 追加日志，按时间线回放"发生过什么"。
// 目的是接住「上次说的那个」「昨天那件事」这类时间指代——
// 检索按 关键词命中 + 时间近因 排序，不做向量（成本与精度现阶段不匹配）。

const DEFAULT_MAX_PER_GROUP = 200
const memoryFallback = new Map()
const loadedFiles = new Set()

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
  return candidates.at(-1)
}

function filePathFor(groupId = "", baseDir = "") {
  const safe = String(groupId || "").replace(/[^\w-]/g, "") || "unknown"
  return path.join(resolveDir(baseDir), `${safe}.ndjson`)
}

function loadEpisodes(groupId = "", baseDir = "") {
  const key = String(groupId || "")
  const file = filePathFor(key, baseDir)
  if (loadedFiles.has(file)) return memoryFallback.get(key) || []
  loadedFiles.add(file)
  let episodes = []
  try {
    const raw = fs.readFileSync(file, "utf8")
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue
      try { episodes.push(JSON.parse(line)) } catch {}
    }
  } catch {}
  memoryFallback.set(key, episodes)
  return episodes
}

/**
 * 回合尾声记录一条情节：谁、让 bot 做了/聊了什么、bot 回了什么（节选）。
 * 追加写 NDJSON 并裁剪内存环形缓冲，写失败不影响回合。
 */
export function recordEpisode({ groupId = "", userId = "", userName = "", summary = "", reply = "", at = Date.now(), maxPerGroup = DEFAULT_MAX_PER_GROUP, baseDir = "" } = {}) {
  const key = String(groupId || "")
  if (!key || !String(summary || "").trim()) return null
  const cap = Math.max(20, Number(maxPerGroup) || DEFAULT_MAX_PER_GROUP)
  const episode = {
    at,
    date: new Date(at).toISOString().slice(0, 10),
    userId: String(userId || ""),
    userName: String(userName || "").slice(0, 24),
    summary: String(summary || "").replace(/\s+/g, " ").slice(0, 120),
    reply: String(reply || "").replace(/\s+/g, " ").slice(0, 120)
  }
  const episodes = loadEpisodes(key, baseDir)
  episodes.push(episode)
  if (episodes.length > cap) episodes.splice(0, episodes.length - cap)
  memoryFallback.set(key, episodes)
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

function scoreEpisode(episode, terms = [], now = Date.now()) {
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
export function recallEpisodes({ groupId = "", terms = [], days = 7, limit = 5, baseDir = "" } = {}) {
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
    .map(item => item.episode)
}

/**
 * 记忆回勾：按用户召回他自己的旧情节（跨天/跨会话的"她记得我"）。
 * minAgeMs 排除太新鲜的记录——半小时内的内容聊天历史里本来就有，
 * 回勾的价值在跨天，不值得重复注入。
 */
export function recallUserEpisodes({ groupId = "", userId = "", days = 7, limit = 2, minAgeMs = 30 * 60 * 1000, baseDir = "" } = {}) {
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
}

function describeWhen(at = 0) {
  const dayMs = 24 * 60 * 60 * 1000
  const days = Math.floor((Date.now() - Number(at || 0)) / dayMs)
  if (days <= 0) return "今天"
  if (days === 1) return "昨天"
  if (days <= 7) return `${days}天前`
  return new Date(at).toISOString().slice(5, 10)
}

/** 生成注入主 prompt 的情节块 */
export function buildEpisodicPrompt(episodes = []) {
  const list = (Array.isArray(episodes) ? episodes : []).slice(0, 5)
  if (!list.length) return ""
  const lines = ["【近期情节】（按时间线，供接住「上次/昨天」这类指代）"]
  for (const e of list) {
    const who = e.userName ? e.userName : "群友"
    lines.push(`- ${describeWhen(e.at)} ${who}：${e.summary}${e.reply ? `；你回了：「${e.reply}」` : ""}`)
  }
  lines.push("用户提到之前的事时优先对照上面的时间线，别张冠李戴。")
  return lines.join("\n")
}

/**
 * 记忆回勾卡片：这位群友自己的旧情节，作为背景感知注入闲聊。
 * 关键是框定用法——可提可不提，禁止刻意汇报"我记得你说过"。
 */
export function buildUserCallbackPrompt(episodes = [], { userName = "" } = {}) {
  const list = (Array.isArray(episodes) ? episodes : []).slice(0, 3)
  if (!list.length) return ""
  const who = String(userName || "").trim() || "这位群友"
  const lines = [`【${who}的旧话题】（背景记忆，不是必聊素材）`]
  for (const e of list) {
    lines.push(`- ${describeWhen(e.at)} 说过：${e.summary}${e.reply ? `，你当时回：「${e.reply}」` : ""}`)
  }
  lines.push("只有当前话题自然接得上时才轻轻提一嘴（像熟人想起旧账那样顺口带过）；接不上就当没有，禁止刻意汇报你记得什么。")
  return lines.join("\n")
}

export function resetEpisodicMemoryForTests() {
  memoryFallback.clear()
  loadedFiles.clear()
}
