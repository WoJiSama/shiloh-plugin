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
export function buildPersonProfileExtractPrompt(messages: { name: string; text: string }[]): { system: string; user: string } {
  return {
    system: [
      '你是群聊机器人的人物档案提取器。从近期消息里提取"身份级、跨群稳定、此人到处都愿意被知道"的事实，建立人物核心档案。',
      '只收五类：name（此人喜欢被怎么称呼）、interests（长期爱好，如喜欢的番/游戏/音乐/运动）、taboos（雷点忌讳，如不想被提的话题）、traits（稳定性格印象，如"爱玩梗""技术宅"，≤4字/条）、facts（稳定小事实，如"养了两只猫""在准备考研"）。',
      '明确不收：情感倾诉、健康隐私、争执冲突、群内梗、角色扮演设定、一次性话题、只在当前群成立的内容——这些留在各群自己的记忆里。',
      '宁缺毋滥：只在消息里有明确、稳定的信号时才输出；拿不准就不收这个人。',
      '只输出严格 JSON 数组（可为空 []）：[{"userId":"QQ号","name":"称呼","interests":["…"],"taboos":["…"],"traits":["…"],"facts":["…"]}]，字段都可省略。',
    ].join('\n'),
    user: JSON.stringify(messages.slice(-40).map(m => ({ name: m.name.slice(0, 20), text: m.text.slice(0, 120) })))
  }
}

/** 注入格式：一行紧凑事实，空档案返回空串 */
export function formatPersonProfile(profile: PersonProfile | undefined, display: string): string {
  if (!profile) return ''
  const parts: string[] = []
  if (profile.name) parts.push(`称呼「${profile.name}」`)
  if (profile.traits?.length) parts.push(profile.traits.slice(0, 3).join('、'))
  if (profile.interests?.length) parts.push(`喜欢：${profile.interests.slice(0, 4).join('、')}`)
  if (profile.facts?.length) parts.push(profile.facts.slice(0, 3).join('；'))
  if (profile.taboos?.length) parts.push(`雷点：${profile.taboos.slice(0, 3).join('、')}`)
  if (!parts.length) return ''
  return `${display}：${parts.join('；')}`
}
