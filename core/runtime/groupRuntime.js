// 群运行时状态统一门面:一个 groupId 到这里拿全部会话相关状态视图。
// 存储职责仍在各归属模块(smart 状态在本模块、话题/社交在 groupContextState),
// 门面只做组合——跨子系统功能(注意力漂移、中期记忆联动、状态可视化)以后只面对这一个入口。
// 从 apps/test.js 的 trackingChatStates 原样迁出(P 行为不变),LRU 淘汰语义保持。
import { peekGroupTopicState, peekGroupSocialState } from "../../utils/groupContextState.js"

const SMART_GROUP_LIMIT = 100

const smartStatesByGroup = new Map()

// 运行时提供者注册:emotionManager/sessionStore 等实例由插件装配处注入,
// 门面只做组合不持有创建逻辑(避免 core → domains 的反向依赖)
let runtimeProviders = { emotion: null, sessions: null }

export function registerGroupRuntimeProviders(next = {}) {
  runtimeProviders = { ...runtimeProviders, ...next }
  return runtimeProviders
}

// smart 会话状态:same shape as before(见字段注释),超过 100 个群按 lastMsgAt 淘汰最旧
export function getSmartRuntimeState(groupId) {
  const key = String(groupId || "")
  let state = smartStatesByGroup.get(key)
  if (!state) {
    if (smartStatesByGroup.size >= SMART_GROUP_LIMIT) {
      let oldestId = null
      let oldestAt = Infinity
      for (const [gid, st] of smartStatesByGroup) {
        if (st.lastMsgAt < oldestAt) { oldestAt = st.lastMsgAt; oldestId = gid }
      }
      if (oldestId != null) {
        const old = smartStatesByGroup.get(oldestId)
        if (old?.waitTimers) for (const t of old.waitTimers.values()) clearTimeout(t)
        if (old?.deferredTimer) clearTimeout(old.deferredTimer)
        smartStatesByGroup.delete(oldestId)
      }
    }
    state = {
      pendingCount: 0,
      lastMsgAt: Date.now(),
      replyLatencies: [],
      forceContinue: false,
      forceGateCheck: false,
      lastGateNoActionAt: 0,
      inFlight: false,
      inFlightToken: 0,
      inFlightSince: 0,
      inFlightWatchdog: null,
      needsRerun: false,
      rerunEvent: null,
      queuedWhileInFlight: 0,
      queuedForceGateCheck: false,
      waitTimers: new Map(),
      // 拟人化字段
      conversationPhase: 'cold',        // 'cold' | 'focus' | 'fading'
      phaseUntil: 0,                    // 当前 phase 自动衰减时间戳
      focusReplyCount: 0,               // 本轮 FOCUS 期 bot 主动回复次数
      consecutiveNoAction: 0,           // FOCUS 期 Gate 连续 no_action 次数
      lastBotReplyAt: 0,                // bot 在该群最近一次发言时间
      lastBotReplyToUserId: null,       // bot 最近一次回复对应的用户，用于判断后续是否同一人接话
      lastBotReplyKeywords: [],         // bot 上次发言提取的关键词（给 continuation R2 用）
      recentReplyTimestamps: [],        // bot 在该群的最近回复时间戳列表（速率限制用）
      recentIncomingTimestamps: [],     // 该群最近群消息时间戳（活跃度统计用）
      recentMessages: [],               // 最近群消息 deque {userId, text, at}，复读检测用
      lastRepeatJoinAt: 0,              // bot 最近一次参与复读的时间（防短期反复跟读）
      deferredTimer: null               // 冷群唤醒定时器
    }
    smartStatesByGroup.set(key, state)
  }
  return state
}

export function deleteSmartRuntimeState(groupId) {
  const key = String(groupId || "")
  const state = smartStatesByGroup.get(key)
  if (!state) return false
  if (state.waitTimers) for (const t of state.waitTimers.values()) clearTimeout(t)
  if (state.deferredTimer) clearTimeout(state.deferredTimer)
  smartStatesByGroup.delete(key)
  return true
}

export function smartRuntimeGroupIds() {
  return [...smartStatesByGroup.keys()]
}

export function hasSmartRuntimeState(groupId) {
  return smartStatesByGroup.has(String(groupId || ""))
}

export function smartRuntimeSize() {
  return smartStatesByGroup.size
}

/**
 * 群运行时状态统一视图:smart 会话状态 + 话题/社交上下文(只读快照)。
 * 跨子系统的新功能从这里取状态,不要再各自 new Map。
 */
export function getGroupRuntime(groupId) {
  const key = String(groupId || "")
  return {
    groupId: key,
    smart: getSmartRuntimeState(key),
    get topic() { return peekGroupTopicState(key) },
    get social() { return peekGroupSocialState(key) },
    get emotion() { return runtimeProviders.emotion },
    get sessions() { return runtimeProviders.sessions }
  }
}

export function resetGroupRuntimeForTests() {
  for (const state of smartStatesByGroup.values()) {
    if (state.waitTimers) for (const t of state.waitTimers.values()) clearTimeout(t)
    if (state.deferredTimer) clearTimeout(state.deferredTimer)
  }
  smartStatesByGroup.clear()
}

// ── 清扫生命周期:各状态自己注册清扫回调,调度器不再逐张 Map 硬编码 ──
// 注册 fn 签名:({ ttlHours }) => removedCount
const runtimeSweeps = new Map()

export function registerRuntimeSweep(name, fn) {
  if (typeof fn !== "function") return false
  runtimeSweeps.set(String(name || ""), fn)
  return true
}

export function unregisterRuntimeSweep(name) {
  return runtimeSweeps.delete(String(name || ""))
}

export function listRuntimeSweeps() {
  return [...runtimeSweeps.keys()]
}

export function runRuntimeSweeps({ ttlHours = 24, logger = globalThis.logger } = {}) {
  const results = {}
  let removed = 0
  for (const [name, fn] of runtimeSweeps) {
    try {
      const count = Number(fn({ ttlHours })) || 0
      results[name] = count
      removed += count
    } catch (error) {
      results[name] = -1
      logger?.warn?.(`[群运行时] 清扫 ${name} 失败: ${error?.message || error}`)
    }
  }
  return { removed, results }
}

// 内建:smart 状态 TTL 清扫(超时群清定时器并删除)
registerRuntimeSweep("smartStates", ({ ttlHours } = {}) => {
  const cutoff = Date.now() - Math.max(1, Number(ttlHours) || 24) * 3600 * 1000
  let removed = 0
  for (const gid of [...smartStatesByGroup.keys()]) {
    const state = smartStatesByGroup.get(gid)
    if ((state?.lastMsgAt || 0) < cutoff) {
      deleteSmartRuntimeState(gid)
      removed += 1
    }
  }
  return removed
})
