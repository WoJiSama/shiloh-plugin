import type {ForwardCompleteness, ForwardReadEntry, ForwardReadState} from '../../../contracts/forwardContext.js'

const STATES = new Set<ForwardReadState>(['complete', 'partial', 'unavailable'])
const REASONS = new Set(['node_limit', 'depth_limit', 'fetch_failed', 'malformed_response'])
function object(value: unknown): Record<string, unknown> | null {return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null}
function count(value: unknown): value is number {return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0}

/** Reject malformed metadata instead of promoting unknown history to complete. */
export function parseForwardCompleteness(value: unknown): ForwardCompleteness | undefined {
  const raw = object(value)
  if (!raw || raw.version !== 1 || !STATES.has(raw.state as ForwardReadState)) return undefined
  const numbers = ['knownTotalNodes', 'processedNodes', 'omittedKnownNodes'] as const
  const flags = ['totalExact', 'nodeLimitReached', 'textTruncated', 'mediaTruncated', 'snapshotTruncated'] as const
  const lists = ['failedForwardIds', 'depthLimitedForwardIds', 'cycleForwardIds'] as const
  if (!numbers.every(key => count(raw[key])) || !flags.every(key => typeof raw[key] === 'boolean')
    || !lists.every(key => Array.isArray(raw[key]) && raw[key].every(item => typeof item === 'string' && item.trim()) && new Set(raw[key]).size === raw[key].length) || !Array.isArray(raw.entries)) return undefined
  const entries: ForwardReadEntry[] = []
  const ids = new Set<string>()
  for (const value of raw.entries) {
    const item = object(value)
    if (!item || typeof item.forwardId !== 'string' || !item.forwardId.trim() || ids.has(item.forwardId) || !count(item.depth) || !count(item.processedNodes)
      || !(item.totalNodes === null || count(item.totalNodes)) || !STATES.has(item.state as ForwardReadState)
      || item.reason !== undefined && !REASONS.has(String(item.reason))) return undefined
    if (typeof item.totalNodes === 'number' && item.processedNodes > item.totalNodes) return undefined
    if (item.state === 'complete' && (item.totalNodes === null || item.totalNodes !== item.processedNodes || item.reason !== undefined)) return undefined
    if (item.state === 'unavailable' && (item.totalNodes !== null || item.processedNodes !== 0 || !['fetch_failed', 'malformed_response'].includes(String(item.reason)))) return undefined
    if (item.state !== 'unavailable' && ['fetch_failed', 'malformed_response'].includes(String(item.reason))) return undefined
    ids.add(item.forwardId)
    entries.push({forwardId: item.forwardId, depth: item.depth, totalNodes: item.totalNodes as number | null,
      processedNodes: item.processedNodes, state: item.state as ForwardReadState,
      ...(item.reason ? {reason: item.reason as NonNullable<ForwardReadEntry['reason']>} : {})})
  }
  const knownTotalNodes = raw.knownTotalNodes as number, processedNodes = raw.processedNodes as number, omittedKnownNodes = raw.omittedKnownNodes as number
  if (knownTotalNodes !== processedNodes + omittedKnownNodes) return undefined
  if (entries.reduce((sum, item) => sum + (item.totalNodes ?? 0), 0) !== knownTotalNodes || entries.reduce((sum, item) => sum + item.processedNodes, 0) !== processedNodes) return undefined
  const result: ForwardCompleteness = {version: 1, state: raw.state as ForwardReadState, knownTotalNodes, processedNodes, omittedKnownNodes,
    totalExact: raw.totalExact as boolean, nodeLimitReached: raw.nodeLimitReached as boolean, textTruncated: raw.textTruncated as boolean,
    mediaTruncated: raw.mediaTruncated as boolean, snapshotTruncated: raw.snapshotTruncated as boolean,
    failedForwardIds: [...raw.failedForwardIds as string[]], depthLimitedForwardIds: [...raw.depthLimitedForwardIds as string[]], cycleForwardIds: [...raw.cycleForwardIds as string[]], entries}
  if ([...result.failedForwardIds, ...result.depthLimitedForwardIds, ...result.cycleForwardIds].some(id => !ids.has(id))) return undefined
  if (result.failedForwardIds.some(id => entries.find(item => item.forwardId === id)?.state !== 'unavailable') || entries.some(item => item.state === 'unavailable' && !result.failedForwardIds.includes(item.forwardId))) return undefined
  if (result.depthLimitedForwardIds.some(id => entries.find(item => item.forwardId === id)?.reason !== 'depth_limit') || entries.some(item => item.reason === 'depth_limit' && !result.depthLimitedForwardIds.includes(item.forwardId))) return undefined
  if (result.nodeLimitReached !== entries.some(item => item.reason === 'node_limit')) return undefined
  if (result.totalExact && (omittedKnownNodes || result.failedForwardIds.length || result.depthLimitedForwardIds.length || result.cycleForwardIds.length || result.nodeLimitReached || entries.some(item => item.totalNodes === null))) return undefined
  if (result.state === 'unavailable' && (processedNodes || !result.failedForwardIds.length)) return undefined
  if (result.state === 'complete' && (!result.totalExact || omittedKnownNodes || result.failedForwardIds.length || result.depthLimitedForwardIds.length
    || result.cycleForwardIds.length || result.nodeLimitReached || result.textTruncated || result.mediaTruncated || result.snapshotTruncated)) return undefined
  return result
}

export function formatForwardCompleteness(completeness?: ForwardCompleteness): string {
  if (!completeness || !completeness.entries.length) return ''
  const status = completeness.state === 'complete' ? '完整展开' : completeness.state === 'unavailable' ? '未能读取' : '部分展开'
  const range = completeness.totalExact ? `已处理 ${completeness.processedNodes}/${completeness.knownTotalNodes} 条` : `已处理 ${completeness.processedNodes} 条，已知至少 ${completeness.knownTotalNodes} 条，总数尚不完整`
  const details = [completeness.omittedKnownNodes ? `已知另有 ${completeness.omittedKnownNodes} 条未处理` : '',
    completeness.nodeLimitReached ? '达到节点预算' : '', completeness.depthLimitedForwardIds.length ? `${completeness.depthLimitedForwardIds.length} 处嵌套达到深度预算` : '',
    completeness.failedForwardIds.length ? `${completeness.failedForwardIds.length} 份记录读取失败` : '', completeness.cycleForwardIds.length ? '循环引用未再次展开' : '',
    completeness.textTruncated ? '正文因长度预算仅保留摘录' : '', completeness.mediaTruncated ? '部分媒体引用未收录' : '', completeness.snapshotTruncated ? '部分结构快照内容未收录' : ''].filter(Boolean)
  return `【转发读取范围】${status}；${range}${details.length ? `；${details.join('；')}` : ''}。仅依据下方实际展开内容；未读或未展示部分不能说成已读，也不能据此补写事实。媒体引用不等于已识别。`
}

export function findForwardCompleteness(message: unknown, context?: unknown): ForwardCompleteness | undefined {
  const fromContext = parseForwardCompleteness(object(context)?.completeness)
  if (fromContext) return fromContext
  if (!Array.isArray(message)) return undefined
  for (const value of message) {
    const item = object(value)
    if (item?.type === 'forward_context') {
      const parsed = parseForwardCompleteness(item.completeness)
      if (parsed) return parsed
    }
  }
  return undefined
}
