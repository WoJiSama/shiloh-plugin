// 合并转发内容渲染（纯函数）：把 OneBot forward 节点渲染成带发言人的可读行。
// 实测事故教训：只提 text 段会把图片/卡片/内嵌转发的记录整条丢掉（"两份记录没读出来"），
// 且无标记时模型不知道缺什么、转而让群友"重新打字讲一遍"。因此：所有段类型都有标记。

export interface ForwardSegment { type?: string; data?: Record<string, unknown>; text?: unknown; id?: unknown; resid?: unknown; summary?: unknown; qq?: unknown; url?: unknown }
export interface ForwardNode { sender?: { card?: unknown; nickname?: unknown }; message?: unknown; time?: unknown }

export interface RenderedForward {
  lines: string[]
  total: number
  truncated: boolean
  nestedForwardIds: string[]
}

/** 单个消息段 → 可读标记（text 原样，媒体给标记让模型知道"有东西但看不见"） */
export function renderForwardSegment(seg: ForwardSegment): string {
  const type = String(seg?.type || '')
  const data = (seg && typeof seg === 'object' ? (seg.data as Record<string, unknown> | undefined) : undefined) || (seg as Record<string, unknown>)
  switch (type) {
    case 'text':
    case 'plain':
      return String(data?.text ?? seg?.text ?? '')
    case 'at':
      return `@${String(data?.qq ?? '')}`
    case 'image':
      return '[图片]'
    case 'mface':
      return `[表情包:${String(data?.summary || data?.name || '').slice(0, 20)}]`
    case 'face':
      return `[表情${String(data?.id ?? '')}]`
    case 'forward': {
      const id = String(data?.id ?? data?.resid ?? seg?.id ?? seg?.resid ?? '')
      return id ? `[内嵌转发 id=${id}，可再用 simGetForward 展开]` : '[内嵌转发]'
    }
    case 'video':
      return '[视频]'
    case 'record':
      return '[语音]'
    case 'file':
      return `[文件:${String(data?.name || data?.title || '').slice(0, 30)}]`
    case 'reply':
      return '' // 回复头不渲染（正文在后续 text 段里）；引用原文如适配器给出也带上
    case 'json':
    case 'xml': {
      const desc = String(data?.desc || data?.title || data?.brief || '').slice(0, 40)
      return desc ? `[卡片:${desc}]` : '[卡片]'
    }
    default:
      return type ? `[${type}]` : ''
  }
}

/** 渲染整棵转发：每条 ≤maxChars 字，无内容的记录显式标 [无可读内容]（不静默丢弃） */
export function renderForwardNodes(nodes: unknown[], opts: { maxNodes?: number; maxChars?: number } = {}): RenderedForward {
  const maxNodes = Math.min(80, Math.max(10, opts.maxNodes ?? 50))
  const maxChars = Math.min(500, Math.max(60, opts.maxChars ?? 200))
  const list = Array.isArray(nodes) ? nodes : []
  const lines: string[] = []
  const nestedForwardIds: string[] = []
  for (const raw of list.slice(0, maxNodes)) {
    const node = (raw && typeof raw === 'object' ? raw : {}) as ForwardNode
    const name = String(node.sender?.card || node.sender?.nickname || '群友')
    let text = ''
    if (typeof node.message === 'string') {
      text = node.message
    } else if (Array.isArray(node.message)) {
      text = (node.message as ForwardSegment[]).map(seg => renderForwardSegment(seg)).join('').trim()
      // 提取内嵌转发 id 供模型递归展开
      for (const seg of node.message as ForwardSegment[]) {
        if (seg?.type === 'forward') {
          const id = String((seg.data as Record<string, unknown> | undefined)?.id ?? (seg.data as Record<string, unknown> | undefined)?.resid ?? seg?.id ?? seg?.resid ?? '')
          if (id && nestedForwardIds.length < 8) nestedForwardIds.push(id)
        }
      }
    }
    text = text.replace(/\s+/g, ' ').trim()
    lines.push(`${name}：${text ? text.slice(0, maxChars) : '[无可读内容]'}`)
  }
  return { lines, total: list.length, truncated: list.length > maxNodes, nestedForwardIds }
}
