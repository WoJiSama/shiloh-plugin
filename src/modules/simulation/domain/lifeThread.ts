/** 生活线（真实数据源）：解析同步结果、合并真实笔记、注入格式。核心约束——不编造，一切以真实拉取的资料为据。 */

export interface LifeThread {
  id: string
  kind: 'anime' | 'game'
  title: string
  /** B 站 season_id（anime）或搜索锚点（game） */
  sourceId: string
  status: 'active' | 'dropped'
  addedAt: number
  lastSyncAt: number
  lastEpisode?: number
  /** 真实资料笔记（最新在前，≤12 条，每条 ≤120 字） */
  notes: string[]
}

export interface ThreadSyncResult { newNotes: string[]; episode?: number }

const MAX_NOTES = 12

export function normalizeLifeThreads(raw: unknown): LifeThread[] {
  const list = Array.isArray(raw) ? raw : []
  const out: LifeThread[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const id = String(row.id || '').trim()
    const title = String(row.title || '').trim().slice(0, 40)
    const sourceId = String(row.sourceId || '').trim()
    const kind = row.kind === 'game' ? 'game' : 'anime'
    if (!id || !title || !sourceId) continue
    out.push({
      id, kind, title, sourceId,
      status: row.status === 'dropped' ? 'dropped' : 'active',
      addedAt: Number(row.addedAt) || 0,
      lastSyncAt: Number(row.lastSyncAt) || 0,
      ...(Number(row.lastEpisode) > 0 ? { lastEpisode: Number(row.lastEpisode) } : {}),
      notes: Array.isArray(row.notes) ? row.notes.map(n => String(n || '').trim().slice(0, 120)).filter(Boolean).slice(0, MAX_NOTES) : [],
    })
  }
  return out.slice(0, 6)
}

/** 合并同步结果：新笔记置顶、总量截断；集数推进 */
export function mergeThreadSync(thread: LifeThread, sync: ThreadSyncResult, now: number): LifeThread {
  const notes = [...sync.newNotes.map(n => String(n || '').trim().slice(0, 120)).filter(Boolean), ...thread.notes].slice(0, MAX_NOTES)
  return { ...thread, notes, lastSyncAt: now, ...(sync.episode !== undefined && sync.episode > 0 ? { lastEpisode: sync.episode } : {}) }
}

/** 注入格式：活跃线程 + 真实笔记；附使用规则（以真实资料为据，不编造）。commonTopicLines=与群友档案的兴趣重叠提示 */
export function formatLifeThreads(threads: LifeThread[], commonTopicLines: string[] = []): string {
  const active = threads.filter(t => t.status === 'active')
  if (!active.length) return ''
  const lines = active.slice(0, 3).map(t => {
    const head = `- 《${t.title}》（${t.kind === 'anime' ? `在追${t.lastEpisode ? `，看到第 ${t.lastEpisode} 集` : ''}` : '在玩'}）分享链接：https://www.bilibili.com/bangumi/play/ss${t.sourceId}`
    const notes = t.notes.slice(0, 4).map(n => `  · ${n}`).join('\n')
    return notes ? `${head}\n${notes}` : head
  })
  const common = commonTopicLines.slice(0, 3).map(text => `- 共同话题：群里${text}`)
  return ['【你最近的生活线】（以下是你自己在追的作品和真实更新进度——这是你的个人兴趣背景知识，不是当前话题。严格规则：只有当群里正在聊动画/番剧相关话题、或有人提到你在追的作品时才自然带出；绝不在无关话题的群里主动提起。被问「最近在追什么」时可以聊，但别像汇报一样罗列。聊到时以此为据（真实资料），可以聊感想，不要编造资料里没有的剧情细节；可以用 simShareVideoCard(url: 分享链接) 发番剧卡片）', ...lines, ...common].join('\n')
}
