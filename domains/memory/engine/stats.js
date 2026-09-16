// utils/memory/stats.js
// 轻量进程内统计（§0.3）：计数器 + 耗时累加。重启归零，零依赖。
// 只记状态/计数，绝不记 fact 全文（隐私 + 防刷屏）。
//
// 约定计数键：
//   embed.hit / embed.miss / embed.fail
//   llm.extract.call / llm.extract.fail
//   llm.reflect.call / llm.reflect.fail
//   extract.user.flushed / extract.user.buffered / extract.user.optedOut
//   extract.group.run / extract.group.throttled / extract.boundary.drop
// 约定耗时键：embed.ms / llm.extract.ms / llm.reflect.ms

const counters = new Map()
const timings = new Map()

export const memStats = {
  // 计数 +n（n 默认 1）。非有限 n 视为 0，不抛错。
  inc(key, n = 1) {
    if (!key) return
    const add = Number(n)
    if (!Number.isFinite(add)) return
    counters.set(key, (counters.get(key) || 0) + add)
  },

  // 记录一次耗时（累加 sum + count）。非有限 ms 忽略。
  observe(key, ms) {
    if (!key) return
    const value = Number(ms)
    if (!Number.isFinite(value)) return
    const cur = timings.get(key) || { count: 0, sumMs: 0 }
    timings.set(key, { count: cur.count + 1, sumMs: cur.sumMs + value })
  },

  // 返回 { counters:{...}, timings:{key:{count,sumMs,avgMs}} } 的快照（不可变拷贝）。
  snapshot() {
    const countersOut = {}
    for (const [key, value] of counters) countersOut[key] = value
    const timingsOut = {}
    for (const [key, { count, sumMs }] of timings) {
      timingsOut[key] = { count, sumMs, avgMs: count ? sumMs / count : 0 }
    }
    return { counters: countersOut, timings: timingsOut }
  },

  // 测试辅助：清空所有计数与耗时。
  reset() {
    counters.clear()
    timings.clear()
  }
}
