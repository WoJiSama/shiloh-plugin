import type {ConversationIdentity} from './conversationIdentity.js'
export interface SmartDynamicsState {phaseUntil:number;conversationPhase:'focus'|'fading'|'cold';consecutiveNoAction:number;focusReplyCount:number;recentReplyTimestamps:number[];replyLatencies:{at:number;ms:number}[];recentIncomingTimestamps:number[];pendingCount:number}
export interface SmartDynamicsConfig {fadingDurationMs?:number;maxRepliesPer10Min?:number;rateLimitCooldownMs?:number;talkValue?:number;groupTalkValues?:{group?:unknown;value?:unknown}[]|Record<string,unknown>;enableTalkValueRules?:boolean;talkValueRules?:{range?:string;value?:unknown}[];idleCompensationEnabled?:boolean;avgLatencyDefaultMs?:number;directTriggerMergeMs?:number;replyDebounceMs?:number;directTriggerMergeMaxMessages?:number}
interface Host {config:{smartTrigger?:SmartDynamicsConfig};computeAvgReplyLatency(state:SmartDynamicsState):number;getSmartState(groupId:string|number,e?:ConversationIdentity):SmartDynamicsState}
export function createSmartDynamics(logger:{info(message:string):void}, now:()=>number=Date.now) {
// smart 会话动态纯辅助:对话相位(FOCUS/FADING/COLD)、发言频率(talkValue/按群覆盖/时段规则)、
// 空闲补偿、回复延迟统计、群消息速率。只依赖 host.config 与 state,无 IO——
// 从 apps/test.js 原样迁出(行为不变),注意力漂移等后续功能在此扩展。

function resolveConversationPhase(host:Host, state:SmartDynamicsState) {
    const currentTime = now()
    const smartCfg = host.config.smartTrigger || {}
    const fadingDurationMs = Number(smartCfg.fadingDurationMs) || 90000

    // 自动衰减：一次入口可能跨越多个 phase，循环到稳定状态
    while (state.phaseUntil && currentTime > state.phaseUntil) {
      if (state.conversationPhase === 'focus') {
        state.conversationPhase = 'fading'
        // 从 focus 结束的那一刻起算 fading 持续时间
        const fadingStart = state.phaseUntil
        state.phaseUntil = fadingStart + fadingDurationMs
        state.consecutiveNoAction = 0
        if (currentTime > state.phaseUntil) continue   // fading 也已过期，继续衰减到 cold
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

function applyRateLimitGuard(host:Host, state:SmartDynamicsState, groupId:string|number) {
    const smartCfg = host.config.smartTrigger || {}
    const cutoff = now() - 600000
    state.recentReplyTimestamps = (state.recentReplyTimestamps || []).filter(t => t > cutoff)
    const maxPer10Min = Number(smartCfg.maxRepliesPer10Min) || 8
    if (state.recentReplyTimestamps.length >= maxPer10Min) {
      logger.info(`[RateLimit] group=${groupId} 10min 已回复 ${state.recentReplyTimestamps.length}/${maxPer10Min} 次，强制 no_action`)
      state.conversationPhase = 'fading'
      state.phaseUntil = now() + (Number(smartCfg.rateLimitCooldownMs) || 300000)
      return false
    }
    state.recentReplyTimestamps.push(now())
    return true
}

function resolveTalkValue(host:Host, groupId:string|number) {
    const s = host.config.smartTrigger || {}
    const fallback = Number(s.talkValue) || 1.0
    // 按群覆盖:某些群话痨/某些群安静,优先级最高(借鉴 MaiBot 按 item_id 的频率规则)
    // 兼容两种形态:锅巴 GSubForm 写的数组 [{group,value}],手写 yaml 的对象 {群号:值}
    const groupOverrides = s.groupTalkValues
    if (Array.isArray(groupOverrides)) {
      const entry = groupOverrides.find(item => item && String(item.group) === String(groupId || ""))
      const v = Number(entry?.value)
      if (Number.isFinite(v) && v > 0) return Math.min(1, v)
    } else if (groupOverrides && typeof groupOverrides === "object") {
      const v = Number(groupOverrides[String(groupId || "")])
      if (Number.isFinite(v) && v > 0) return Math.min(1, v)
    }
    if (!s.enableTalkValueRules || !Array.isArray(s.talkValueRules) || s.talkValueRules.length === 0) {
      return fallback
    }
    const clock = new Date(now())
    const hhmm = `${String(clock.getHours()).padStart(2, '0')}:${String(clock.getMinutes()).padStart(2, '0')}`
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

function idleCompensationMet(host:Host, state:SmartDynamicsState, threshold:number, prevLastMsgAt:number) {
    const s = host.config.smartTrigger || {}
    if (!s.idleCompensationEnabled) return false
    const avgMs = host.computeAvgReplyLatency(state) || Number(s.avgLatencyDefaultMs) || 60000
    if (avgMs <= 0) return false
    const idleMs = Math.max(0, now() - (prevLastMsgAt || now()))
    return state.pendingCount + idleMs / avgMs >= threshold
}

function computeAvgReplyLatency(host:Host, state:SmartDynamicsState) {
    if (!state?.replyLatencies?.length) return 0
    const cutoff = now() - 600000
    state.replyLatencies = state.replyLatencies.filter(item => item.at >= cutoff)
    if (!state.replyLatencies.length) return 0
    const sum = state.replyLatencies.reduce((acc, item) => acc + item.ms, 0)
    return sum / state.replyLatencies.length
}

function recordReplyLatency(host:Host, groupId:string|number, latencyMs:number,e?:ConversationIdentity) {
    if (!groupId || !Number.isFinite(latencyMs) || latencyMs <= 0) return
    const state = host.getSmartState(groupId,e)
    state.replyLatencies.push({ at: now(), ms: latencyMs })
    if (state.replyLatencies.length > 50) state.replyLatencies = state.replyLatencies.slice(-50)
}

function computeGroupMsgRate5min(host:Host, state:SmartDynamicsState) {
    if (!Array.isArray(state?.recentIncomingTimestamps)) return 0
    const cutoff = now() - 300000
    state.recentIncomingTimestamps = state.recentIncomingTimestamps.filter(t => t > cutoff)
    return state.recentIncomingTimestamps.length
}

function getDirectTriggerMergeMs(host:Host) {
    const smartCfg = host.config.smartTrigger || {}
    const configured = Number(smartCfg.directTriggerMergeMs)
    if (Number.isFinite(configured)) return Math.max(0, Math.min(5000, configured))
    const fallback = Number(smartCfg.replyDebounceMs)
    return Math.max(0, Math.min(5000, Number.isFinite(fallback) ? fallback : 1500))
}

function getDirectTriggerMergeMaxMessages(host:Host) {
    const configured = Number(host.config.smartTrigger?.directTriggerMergeMaxMessages)
    if (Number.isFinite(configured)) return Math.max(2, Math.min(20, Math.floor(configured)))
    return 8
}

return {resolveConversationPhase,applyRateLimitGuard,resolveTalkValue,idleCompensationMet,computeAvgReplyLatency,recordReplyLatency,computeGroupMsgRate5min,getDirectTriggerMergeMs,getDirectTriggerMergeMaxMessages}
}
