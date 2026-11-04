/** 人物核心档案（跨群）：保守提取判定 + 合并 + 注入格式化。 */
export interface PersonProfilePatch { userId: string; name?: string; interests?: string[]; taboos?: string[]; traits?: string[]; facts?: string[] }
export interface PersonProfile { name?: string; interests: string[]; taboos: string[]; traits?: string[]; facts?: string[] }

const USERID_RE = /^\d{4,12}$/

/** 解析提取模型输出：严格 JSON 数组，容忍 ```json 包裹与多余文本 */
export function parsePersonProfilePatches(raw: string): PersonProfilePatch[] {
  const text = String(raw || '')
  const match = text.match(/\[[\s\S]*\]/)
  if (!match) return []
  try {
    const parsed = JSON.parse(match[0]) as unknown
    if (!Array.isArray(parsed)) return []
    const out: PersonProfilePatch[] = []
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue
      const row = item as Record<string, unknown>
      const userId = String(row.userId || '').trim()
      if (!USERID_RE.test(userId)) continue
      const strings = (value: unknown) => Array.isArray(value) ? value.map(v => String(v || '').trim()).filter(Boolean).slice(0, 4) : undefined
      const patch: PersonProfilePatch = { userId }
      const name = String(row.name || '').trim()
      if (name) patch.name = name.slice(0, 20)
      for (const field of ['interests', 'taboos', 'traits', 'facts'] as const) {
        const list = strings(row[field])
        if (list?.length) patch[field] = list
      }
      if (patch.name || patch.interests?.length || patch.taboos?.length || patch.traits?.length || patch.facts?.length) out.push(patch)
    }
    return out.slice(0, 10)
  } catch { return [] }
}

/** 提取提示词：只收"任何群都合适被知道"的身份级事实；情境性内容明确排除 */
export function buildPersonProfileExtractPrompt(messages: { userId?: string; name: string; text: string }[]): { system: string; user: string } {
  return {
    system: [
      '你是群聊机器人的人物档案提取器。从近期消息里提取"身份级、跨群稳定、此人到处都愿意被知道"的事实，建立人物核心档案。',
      '只收五类：name（此人喜欢被怎么称呼）、interests（长期爱好，如喜欢的番/游戏/音乐/运动）、taboos（雷点忌讳，如不想被提的话题）、traits（稳定性格印象，如"爱玩梗""技术宅"，≤4字/条）、facts（稳定小事实，如"养了两只猫""在准备考研"）。',
      '明确不收：情感倾诉、健康隐私、争执冲突、群内梗、角色扮演设定、一次性话题、只在当前群成立的内容——这些留在各群自己的记忆里。',
      '宁缺毋滥：只在消息里有明确、稳定的信号时才输出；拿不准就不收这个人。',
      '只输出严格 JSON 数组（可为空 []）：[{"userId":"QQ号","name":"称呼","interests":["…"],"taboos":["…"],"traits":["…"],"facts":["…"]}]，字段都可省略。',
    ].join('\n'),
    user: JSON.stringify(messages.slice(-40).map(m => ({ userId: m.userId || "", name: m.name.slice(0, 20), text: m.text.slice(0, 120) })))
  }
}

/** 注入格式：一行紧凑事实，空档案返回空串。facts 展示侧去重：短词优先，指向同一事实的长句不重复渲染。 */
export function formatPersonProfile(profile: PersonProfile | undefined, display: string): string {
  if (!profile) return ''
  const parts: string[] = []
  if (profile.name) parts.push(`称呼「${profile.name}」`)
  const traits = (profile.traits || []).slice(0, 3)
  if (traits.length) parts.push(traits.join('、'))
  const interests = (profile.interests || []).slice(0, 4)
  if (interests.length) parts.push(`喜欢：${interests.join('、')}`)
  // simRemember 同步的是整句、提取器是短语——同事实两条时保留短的（信息密度高、省 token）
  const factBase = [...traits, ...interests]
  const keptFacts: string[] = []
  for (const fact of [...(profile.facts || [])].sort((a, b) => a.length - b.length)) {
    if (keptFacts.length >= 3) break
    if (factBase.some(base => textCoversFact(fact, base))) continue
    if (keptFacts.some(prev => textCoversFact(fact, prev))) continue
    keptFacts.push(fact)
  }
  if (keptFacts.length) parts.push(keptFacts.join('；'))
  if (profile.taboos?.length) parts.push(`雷点：${profile.taboos.slice(0, 3).join('、')}`)
  if (!parts.length) return ''
  return `${display}：${parts.join('；')}`
}

function normalizeForMatch(text: string): string {
  return String(text || '').toLowerCase().replace(/[\s!！？?。，,．;；:：、~～…·「」『』""''()[\]（）<>{}"'-]/g, '')
}

/** 最长公共子串长度（归一化后逐位比对；条目都 ≤30 字，O(n·m) 足够） */
function longestCommonRun(a: string, b: string): number {
  if (!a || !b) return 0
  let best = 0
  let prev = new Array<number>(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i += 1) {
    const cur = new Array<number>(b.length + 1).fill(0)
    for (let j = 1; j <= b.length; j += 1) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1]! + 1
        if (cur[j]! > best) best = cur[j]!
      }
    }
    prev = cur
  }
  return best
}

/** 两条文本是否指向同一事实：归一化后互为子串（≥3字）或有 ≥3 字连续公共段 */
function textCoversFact(a: string, b: string): boolean {
  const x = normalizeForMatch(a)
  const y = normalizeForMatch(b)
  if (x.length < 2 || y.length < 2) return false
  if ((x.length >= 3 && y.includes(x)) || (y.length >= 3 && x.includes(y))) return true
  return longestCommonRun(x, y) >= 3
}

/**
 * 注入去重：判断一条本群记忆内容是否已被该人的档案覆盖。
 * 判据——归一化后与任一档案字段存在 ≥3 字符的连续公共段（如"学日语"）；
 * 2 字符的偶然撞词（"游戏""动漫"这类泛词）不算覆盖，宁可少量重复也不误杀独特信息。
 */
export function profileCoversContent(content: string, profile: PersonProfile | undefined): boolean {
  if (!profile) return false
  const target = String(content || '')
  if (normalizeForMatch(target).length < 3) return false
  const fields = [...(profile.name ? [profile.name] : []), ...(profile.traits || []), ...(profile.interests || []), ...(profile.facts || []), ...(profile.taboos || [])]
  return fields.some(field => textCoversFact(target, field))
}

/** 生活线×档案兴趣连接：兴趣词条与作品标题是否指向同一作品（归一化后互为子串，CJK ≥2 字/字母数字 ≥3 字） */
export function interestMatchesTitle(interest: string, title: string): boolean {
  const a = normalizeForMatch(interest)
  const b = normalizeForMatch(title)
  if (a.length < 2 || b.length < 2) return false
  const alnum = /^[a-z0-9]+$/.test(a)
  const min = alnum ? 3 : 2
  if (a.length < min) return false
  return b.includes(a) || a.includes(b)
}
