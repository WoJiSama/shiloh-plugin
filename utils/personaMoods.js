// 人设调皮情绪时刻:同一人格内的偶发情绪着色(借鉴 MaiBot multiple_reply_style 的随机性,
// 但不换人格——只是偶尔活泼/腹黑一下)。每回合掷骰,命中注入一条"本回合心情"提示,
// 只影响当次回复;群级冷却防连发。
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000

const lastFiredByGroup = new Map() // groupId -> 上次命中时间戳

export function normalizeMoods(raw) {
  if (!Array.isArray(raw)) return []
  const moods = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const name = String(item.name || "").trim()
    const hint = String(item.hint || "").trim()
    const probability = Number(item.probability)
    if (!name || !hint || !Number.isFinite(probability) || probability <= 0) continue
    moods.push({ name, hint, probability: Math.min(1, probability) })
  }
  return moods
}

// 掷骰:命中返回 { name, hint, prompt },未命中返回 null。
// 每个心情独立概率、最多命中一个、按声明顺序先到先得;命中后进入群级冷却。
export function rollPersonaMood(persona = {}, groupId = "", {
  cooldownMs = DEFAULT_COOLDOWN_MS,
  rand = Math.random,
  now = Date.now
} = {}) {
  const moods = normalizeMoods(persona?.moods)
  if (!moods.length) return null
  const key = String(groupId || "__all__")
  const last = lastFiredByGroup.get(key) || 0
  if (now() - last < cooldownMs) return null
  for (const mood of moods) {
    if (rand() < mood.probability) {
      lastFiredByGroup.set(key, now())
      return { ...mood, prompt: formatMoodPrompt(mood) }
    }
  }
  return null
}

export function formatMoodPrompt(mood = {}) {
  const name = String(mood?.name || "").trim()
  const hint = String(mood?.hint || "").trim()
  if (!name || !hint) return ""
  return [
    `【本回合心情:${name}】`,
    `这一回合可以比平时多一点这种感觉:${hint}`,
    "只影响这一次回复的语气,不改变你是谁;下一回合自然恢复平时的样子,不要刻意解释心情变化。"
  ].join("\n")
}

export function getMoodCooldownState(groupId = "") {
  return lastFiredByGroup.get(String(groupId || "__all__")) || 0
}

export function __resetPersonaMoodsForTest() {
  lastFiredByGroup.clear()
}
