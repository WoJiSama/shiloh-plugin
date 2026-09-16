// utils/memory/conflictResolver.js
import { authorityRank } from './constants.js'

// 比较两个声明（{authority, at, by[]}）。返回 {winner, loser, changed}
// changed=true 表示 incoming 赢了已有的 existing（调用方需更新存储）。
export function resolveClaim(existing, incoming) {
  if (!existing) return { winner: incoming, loser: null, changed: true }
  if (!incoming) return { winner: existing, loser: null, changed: false }

  const incomingStronger = isStronger(incoming, existing)
  if (incomingStronger) return { winner: incoming, loser: existing, changed: true }
  return { winner: existing, loser: incoming, changed: false }
}

function isStronger(a, b) {
  const ra = authorityRank(a.authority)
  const rb = authorityRank(b.authority)
  if (ra !== rb) return ra > rb
  const ta = Number(a.at) || 0
  const tb = Number(b.at) || 0
  if (ta !== tb) return ta > tb
  const ca = Array.isArray(a.by) ? a.by.length : 0
  const cb = Array.isArray(b.by) ? b.by.length : 0
  return ca > cb // 严格大于：相等时不替换（保留 existing）
}
