// smart 会话动态纯辅助:对话相位(FOCUS/FADING/COLD)、发言频率(talkValue/按群覆盖/时段规则)、
// 空闲补偿、回复延迟统计、群消息速率。只依赖 host.config 与 state,无 IO——
// 从 apps/test.js 原样迁出(行为不变),注意力漂移等后续功能在此扩展。

export function resolveConversationPhase(host, state) {
    const now = Date.now()
    const smartCfg = host.config.smartTrigger || {}
    const fadingDurationMs = Number(smartCfg.fadingDurationMs) || 90000

    // 自动衰减：一次入口可能跨越多个 phase，循环到稳定状态
    while (state.phaseUntil && now > state.phaseUntil) {
      if (state.conversationPhase === 'focus') {
        state.conversationPhase = 'fading'
        // 从 focus 结束的那一刻起算 fading 持续时间
        const fadingStart = state.phaseUntil
        state.phaseUntil = fadingStart + fadingDurationMs
        state.consecutiveNoAction = 0
        if (now > state.phaseUntil) continue   // fading 也已过期，继续衰减到 cold
        break
      }
      if (state.conversationPhase === 'fading') {
        state.conversationPhase = 'cold'
        state.phaseUntil = 0
        state.focusReplyCount = 0
        state.consecutiveNoAction = 0
        break
      }
      // 已经是 cold，phaseUntil 不应该为 0 以外的值；保险起见清掉
      state.phaseUntil = 0
      break
    }
    return state.conversationPhase || 'cold'
}

export function applyRateLimitGuard(host, state, groupId) {
    const smartCfg = host.config.smartTrigger || {}
    const cutoff = Date.now() - 600000
    state.recentReplyTimestamps = (state.recentReplyTimestamps || []).filter(t => t > cutoff)
    const maxPer10Min = Number(smartCfg.maxRepliesPer10Min) || 8
    if (state.recentReplyTimestamps.length >= maxPer10Min) {
      logger.info(`[RateLimit] group=${groupId} 10min 已回复 ${state.recentReplyTimestamps.length}/${maxPer10Min} 次，强制 no_action`)
      state.conversationPhase = 'fading'
      state.phaseUntil = Date.now() + (Number(smartCfg.rateLimitCooldownMs) || 300000)
      return false
    }
    state.recentReplyTimestamps.push(Date.now())
    return true
}

export function resolveTalkValue(host, groupId) {
    const s = host.config.smartTrigger || {}
    const fallback = Number(s.talkValue) || 1.0
    // 按群覆盖:某些群话痨/某些群安静,优先级最高(借鉴 MaiBot 按 item_id 的频率规则)
    const groupOverrides = s.groupTalkValues
    if (groupOverrides && typeof groupOverrides === "object") {
      const v = Number(groupOverrides[String(groupId || "")])
      if (Number.isFinite(v) && v > 0) return Math.min(1, v)
    }
    if (!s.enableTalkValueRules || !Array.isArray(s.talkValueRules) || s.talkValueRules.length === 0) {
      return fallback
    }
    const now = new Date()
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    for (const rule of s.talkValueRules) {
      const range = String(rule?.range || '').trim()
      const [start, end] = range.split('-').map(x => x?.trim())
      if (!start || !end) continue
      const inRange = (start <= end && hhmm >= start && hhmm <= end) ||
                      (start > end && (hhmm >= start || hhmm <= end))
      if (inRange) {
        const v = Number(rule.value)
        if (Number.isFinite(v) && v > 0) return v
      }
    }
    return fallback
}

export function idleCompensationMet(host, state, threshold, prevLastMsgAt) {
    const s = host.config.smartTrigger || {}
    if (!s.idleCompensationEnabled) return false
    const avgMs = host.computeAvgReplyLatency(state) || Number(s.avgLatencyDefaultMs) || 60000
    if (avgMs <= 0) return false
    const idleMs = Math.max(0, Date.now() - (prevLastMsgAt || Date.now()))
    return state.pendingCount + idleMs / avgMs >= threshold
}

export function computeAvgReplyLatency(host, state) {
    if (!state?.replyLatencies?.length) return 0
    const cutoff = Date.now() - 600000
    state.replyLatencies = state.replyLatencies.filter(item => item.at >= cutoff)
    if (!state.replyLatencies.length) return 0
    const sum = state.replyLatencies.reduce((acc, item) => acc + item.ms, 0)
    return sum / state.replyLatencies.length
}

export function recordReplyLatency(host, groupId, latencyMs) {
    if (!groupId || !Number.isFinite(latencyMs) || latencyMs <= 0) return
    const state = host.getSmartState(groupId)
    state.replyLatencies.push({ at: Date.now(), ms: latencyMs })
    if (state.replyLatencies.length > 50) state.replyLatencies = state.replyLatencies.slice(-50)
}

export function computeGroupMsgRate5min(host, state) {
    if (!Array.isArray(state?.recentIncomingTimestamps)) return 0
    const cutoff = Date.now() - 300000
    state.recentIncomingTimestamps = state.recentIncomingTimestamps.filter(t => t > cutoff)
    return state.recentIncomingTimestamps.length
}

export function getDirectTriggerMergeMs(host) {
    const smartCfg = host.config.smartTrigger || {}
    const configured = Number(smartCfg.directTriggerMergeMs)
    if (Number.isFinite(configured)) return Math.max(0, Math.min(5000, configured))
    const fallback = Number(smartCfg.replyDebounceMs)
    return Math.max(0, Math.min(5000, Number.isFinite(fallback) ? fallback : 1500))
}

export function getDirectTriggerMergeMaxMessages(host) {
    const configured = Number(host.config.smartTrigger?.directTriggerMergeMaxMessages)
    if (Number.isFinite(configured)) return Math.max(2, Math.min(20, Math.floor(configured)))
    return 8
}
