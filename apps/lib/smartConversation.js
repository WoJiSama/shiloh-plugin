// smart 会话编排主体:入口锁/上下文记录/Gate 调用/续话排队/智能锁释放。
// 从 apps/test.js 原样迁出(行为不变),this 依赖以 host 注入;
// smartLockTokenCounter 随迁(全项目唯一使用点在此)。
import { lastIncomingMsgAt } from "./splitState.js"
import { getReplySender } from "../../utils/messageContext.js"
import { collectMentionTargetIds } from "../../utils/mentionTargets.js"
import { isAiConversationEnabled } from "../../utils/aiConversationGate.js"
import { updateGroupTopic, updateGroupSocial, detectAttentionHook } from "../../utils/groupContextState.js"
import { markProactiveReply } from "../../utils/proactiveReplyFreshness.js"
import { anchorEventConversation } from "../../utils/forbiddenWordGuard.js"
import { resolveLongTaskFeedbackPolicy } from "../../utils/longTaskFeedbackPolicy.js"

const logger = globalThis.logger
let smartLockTokenCounter = 0

export async function handleRandomReplySmart(host, e) {
    if (!isAiConversationEnabled(host.config)) return false
    const groupId = e.group_id
    if (host.isUserBlacklisted(e)) {
      logger.info(`[用户黑名单] smart group=${groupId} user=${e.user_id} msg="${summarizeForLog(e.msg || "")}"`)
      return false
    }
    // 违禁词:在学习/话题记录之前拦截,命中内容完全不进入任何下游
    if (host.handleForbiddenWordHit(e)) return false
    host.handleMemorySelfCorrection(e)
    anchorEventConversation(e)
    const state = host.getSmartState(groupId)
    // 记录该群最新消息时间戳给 applyReplyDebounce 用（仅 smart 模式需要，避免 strict 模式持续累积内存）
    const shouldRecordIncoming = !e?._smartWaitRerun && !e?._smartQueuedRerun && !e?._proactiveReply
    const shouldPrefilter = !e?._smartWaitRerun && !e?._proactiveReply
    if (shouldRecordIncoming) {
      const incomingAt = Date.now()
      e._incomingMessageAt = incomingAt
      lastIncomingMsgAt.set(groupId, incomingAt)
      // 活跃度采样移到入口锁外，避免抢锁失败时漏统计（影响 Gate 看到的 5min 消息数）
      state.recentIncomingTimestamps = (state.recentIncomingTimestamps || []).filter(t => t > Date.now() - 300000)
      state.recentIncomingTimestamps.push(Date.now())
      // 复读检测用的最近消息 deque（保留最近 10 条文本）
      const repeatText = (typeof e?.msg === 'string' ? e.msg : '').trim()
      if (repeatText) {
        state.recentMessages = (state.recentMessages || []).slice(-9)
        state.recentMessages.push({ userId: e.user_id, text: repeatText, at: Date.now() })
      }
      // 轻量上下文状态：话题关键词 + 人际互动边（Gate 与主链路共用，零模型调用）
      if (host.config?.groupContextState?.topicEnabled !== false && repeatText) {
        updateGroupTopic({ groupId, text: repeatText })
      }
      if (host.config?.groupContextState?.socialEnabled !== false) {
        updateGroupSocial({
          groupId,
          fromUserId: e.user_id,
          atTargetIds: collectMentionTargetIds(e, e?.bot?.uin || Bot.uin),
          replyToUserId: (() => { try { return getReplySender(e?.source || e?.reply) || "" } catch { return "" } })()
        })
      }
    }
    // 入口锁：该群已经有一个 handleRandomReplySmart 正在跑（Gate / debounce / handleTool 任一阶段）→ 让步本条
    // 必须在任何 await 之前同步检查并 set，防止 await checkTriggers 期间多个调用并发通过
    if (state.inFlight) {
      state.queuedWhileInFlight = (state.queuedWhileInFlight || 0) + 1
      state.lastMsgAt = Date.now()
      state.needsRerun = true
      if (e?._smartWaitRerun) state.queuedForceGateCheck = true
      const smartCfg = host.config.smartTrigger || {}
      const allowDirectTrigger = !e?._smartWaitRerun
      const hasQueuedTrigger = allowDirectTrigger && host.checkTriggers(e)
      const botName = Bot.nickname
      const hasQueuedNameMention = allowDirectTrigger && smartCfg.mentionedNameReply && e.msg &&
        botName && String(e.msg).toLowerCase().includes(String(botName).toLowerCase())
      if ((hasQueuedTrigger && smartCfg.inevitableAtReply !== false) || hasQueuedNameMention || e?._proactiveReply) {
        state.forceContinue = true
        state.rerunEvent = e
      } else if (!state.forceContinue) {
        state.rerunEvent = e
      }
      logger.info(`[SmartQueue] group=${groupId} inFlight=true queued=${state.queuedWhileInFlight} user=${e?.user_id || ''} msg="${String(e?.msg || '').slice(0, 30)}"`)
      return false
    }
    state.inFlight = true
    const smartLockToken = ++smartLockTokenCounter
    state.inFlightToken = smartLockToken
    state.inFlightSince = Date.now()
    host.scheduleSmartLockWatchdog(state)
    try {
      // 先记录上一条消息时间用于空窗补偿（要在 lastMsgAt 被本次更新覆盖之前取出）
      const prevLastMsgAt = state.lastMsgAt || Date.now()
      const queuedCount = Math.max(0, Number(state.queuedWhileInFlight) || 0)
      state.queuedWhileInFlight = 0
      const pendingDelta = e?._smartQueuedRerun ? Math.max(1, queuedCount) : 1 + queuedCount
      state.pendingCount += pendingDelta
      state.lastMsgAt = Date.now()

      const smartCfg = host.config.smartTrigger || {}
      const allowDirectTrigger = !e?._smartWaitRerun

      if (e?._smartWaitRerun) {
        state.forceContinue = false
        state.forceGateCheck = true
      } else if (e?._smartQueuedGateCheck) {
        state.forceGateCheck = true
      }

      if (allowDirectTrigger && e?._proactiveReply) {
        state.forceContinue = true
      }

      // ─── 本地预筛（仅对真实新消息生效）─────────────────────────
      let prefilter = { kind: 'regular', reason: '' }
      if (shouldPrefilter) {
        prefilter = host.prefilterMessage(e, state)
        if (prefilter.kind === 'addressed_other' || prefilter.kind === 'empty_content' || prefilter.kind === 'bot_self_echo' || prefilter.kind === 'likely_addressed_other') {
          // 回滚刚才计入的 pendingCount（这些消息不应推动触发阈值）
          state.pendingCount = Math.max(0, state.pendingCount - pendingDelta)
          logger.info(`[Prefilter] group=${groupId} skip kind=${prefilter.kind} reason=${prefilter.reason}`)
          // 顺手排个 cold 兜底（如果当前是 cold 状态）
          host.scheduleDeferredGateCheck(e, state)
          return false
        }
        if (prefilter.kind === 'continuation_strong') {
          if (prefilter.reason === 'R0_same_user_followup' || prefilter.reason === 'at_bot' || prefilter.reason === 'reply_bot') {
            state.forceContinue = true
          } else {
            state.forceGateCheck = true
          }
          logger.info(`[Prefilter] group=${groupId} continuation_strong reason=${prefilter.reason}`)
        }
        // 复读检测：命中且通过概率 → 跳过 Gate 直接复读原文。
        // 但 force 路径（_proactiveReply / @bot / 触发前缀 / 名字提及）必须走正常 LLM 流程，
        // 因为用户明确指名 bot 时只复读一个 "+1" 体验很差。
        const hasForceSignal = state.forceContinue
          || host.checkTriggers(e)
          || (smartCfg.mentionedNameReply && e.msg && Bot.nickname &&
              String(e.msg).toLowerCase().includes(String(Bot.nickname).toLowerCase()))
        if (!hasForceSignal) {
          const repeatText = host.detectGroupRepeat(e, state)
          if (repeatText) {
            return await host.joinRepeat(e, state, repeatText)
          }
        }
      }

      // 强制覆盖：@/触发前缀
      const hasTrigger = await host.checkTriggers(e)
      if (allowDirectTrigger && hasTrigger && smartCfg.inevitableAtReply !== false) {
        state.forceContinue = true
      }
      // 名字提及（非 @）
      if (allowDirectTrigger && !state.forceContinue && smartCfg.mentionedNameReply && e.msg) {
        const botName = Bot.nickname
        if (botName && String(e.msg).toLowerCase().includes(String(botName).toLowerCase())) {
          state.forceContinue = true
        }
      }

      // ─── 对话焦点状态机：决定本条是否强制走 Gate / 阈值是否减半 ──
      const phase = host.resolveConversationPhase(state)
      if (phase === 'focus' && prefilter.kind === 'continuation_strong') {
        state.forceGateCheck = true
      } else if (phase === 'fading' && smartCfg.fadingForceGate === true && prefilter.kind === 'continuation_strong') {
        // 用户选择激进策略：FADING 期也强制走 Gate
        state.forceGateCheck = true
      }

      // 冷却检查：no_action 后短时间内不再请求 Gate（强制覆盖可绕过）
      const rawCooldownValue = smartCfg.timingGateCooldownSeconds
      const rawCooldownSeconds = rawCooldownValue === undefined || rawCooldownValue === null || rawCooldownValue === ''
        ? NaN
        : Number(rawCooldownValue)
      const cooldownSeconds = Number.isFinite(rawCooldownSeconds) ? rawCooldownSeconds : 8
      const cooldownMs = Math.max(0, cooldownSeconds) * 1000
      if (!state.forceContinue && !state.forceGateCheck && cooldownMs > 0 && Date.now() - state.lastGateNoActionAt < cooldownMs) {
        logger.info(`[SmartSkip] group=${groupId} reason=gate_cooldown pending=${state.pendingCount} cooldownMs=${cooldownMs} msg="${summarizeForLog(e?.msg || "")}"`)
        return false
      }

      // 阈值判定（fading 期半阈值，仅作用于"非 force"路径）
      const talkValue = host.resolveTalkValue(groupId)
      const rawThreshold = Math.max(1, Math.ceil(1 / Math.max(0.01, talkValue)))
      let threshold = phase === 'fading'
        ? Math.max(1, Math.floor(rawThreshold / 2))
        : rawThreshold
      // 注意力漂移(strong 档):群里刚冒出爆发新话题时降一档门槛,更容易被吸引插话
      const driftCfg = host.config?.smartTrigger?.attentionDrift || {}
      if (driftCfg.enabled !== false && String(driftCfg.level) === "strong" && threshold > 1) {
        const hook = detectAttentionHook({ groupId, windowMs: (Number(driftCfg.windowMinutes) || 5) * 60 * 1000 })
        if (hook) {
          threshold = Math.max(1, threshold - 1)
          logger.info(`[注意力漂移] group=${groupId} 新话题「${hook.word}」爆发(${hook.count}次),阈值降为 ${threshold}`)
        }
      }
      const reachThreshold = state.pendingCount >= threshold
      const idleHit = host.idleCompensationMet(state, threshold, prevLastMsgAt)
      if (!state.forceContinue && !state.forceGateCheck && !reachThreshold && !idleHit) {
        logger.info(`[SmartSkip] group=${groupId} reason=below_threshold phase=${phase} pending=${state.pendingCount}/${threshold} talkValue=${talkValue} idleHit=${idleHit} msg="${summarizeForLog(e?.msg || "")}"`)
        // 冷群兜底：phase=cold 且未达阈值时排 deferred timer，让 bot 在合适时机自己跑一轮 Gate
        host.scheduleDeferredGateCheck(e, state)
        return false
      }

      let gateResult
      try {
        // 强制继续路径直接放行，跳过 Gate；强制 Gate 路径仍交给 Gate 判断是否补一句
        if (state.forceContinue) {
          gateResult = { decision: 'continue', reason: 'force', __forceContinue: true }
        } else {
          gateResult = await host.runTimingGate(e, state, { phase, prefilter, threshold })
        }
      } catch (err) {
        logger.error(`[TimingGate] 调用失败:`, err)
        gateResult = { decision: 'no_action', reason: 'error' }
      }

      const decision = gateResult?.decision || 'no_action'
      logger.info(`[TimingGate] group=${groupId} decision=${decision} phase=${phase} pending=${state.pendingCount}/${threshold} forceContinue=${state.forceContinue} forceGate=${state.forceGateCheck} reason=${gateResult?.reason || ''}`)

      if (decision === 'continue') {
        const wasForced = gateResult?.__forceContinue === true
        if (wasForced && !e?._directTriggerMerged) {
          const scheduled = host.scheduleMergedDirectTrigger(e, async mergedEvent => {
            await host.handleRandomReplySmart(mergedEvent)
          }, 'smart_force')
          if (scheduled === false) return false
        }
        // 速率硬上限（force 路径不受限但仍记录时间戳，保证 rate limit 统计准确）
        if (!wasForced) {
          if (!host.applyRateLimitGuard(state, groupId)) {
            logger.info(`[SmartSkip] group=${groupId} reason=rate_limit pending=${state.pendingCount} msg="${summarizeForLog(e?.msg || "")}"`)
            state.pendingCount = 0
            state.forceContinue = false
            state.forceGateCheck = false
            return false
          }
        } else {
          // force 路径直接 push 时间戳，跳过上限检查
          state.recentReplyTimestamps = (state.recentReplyTimestamps || []).filter(t => t > Date.now() - 600000)
          state.recentReplyTimestamps.push(Date.now())
        }
        state.pendingCount = 0
        state.forceContinue = false
        state.forceGateCheck = false
        state.lastGateNoActionAt = 0
        state.consecutiveNoAction = 0
        // 进入 / 续命 FOCUS（非 force 路径计入 focusReplyCount）
        const focusDurationMs = Number(smartCfg.focusDurationMs) || 180000
        const prevPhase = state.conversationPhase
        state.conversationPhase = 'focus'
        state.phaseUntil = Date.now() + focusDurationMs
        // force 路径升回 focus 时视为"新一轮"，重置 focusReplyCount（避免立即又被上限拦截）
        if (wasForced && prevPhase !== 'focus') {
          state.focusReplyCount = 0
        }
        if (!wasForced) {
          state.focusReplyCount = (state.focusReplyCount || 0) + 1
          const maxFocusReplies = Number(smartCfg.focusMaxReplies) || 4
          if (state.focusReplyCount >= maxFocusReplies) {
            // 达上限：本次允许回，但之后立刻降级 FADING 防连刷
            state.conversationPhase = 'fading'
            state.phaseUntil = Date.now() + (Number(smartCfg.fadingDurationMs) || 90000)
            logger.info(`[Phase] group=${groupId} focusMaxReplies(${maxFocusReplies}) 达上限，本次回复后降级 fading`)
          }
        }
        // 标记本条为"主动搭话"（非 @/前缀触发），让 sendSegmentedMessage 决定要不要去掉引用
        if (!wasForced) markProactiveReply(e, e?._incomingMessageAt || lastIncomingMsgAt.get(groupId) || Date.now())
        state.lastBotReplyToUserId = e?.user_id ? String(e.user_id) : null
        // force 路径（@/名字提及/proactive 等"必回"场景）跳过 debounce 立即回复；其余先 debounce 看有没有新消息
        if (!wasForced && !(await host.applyReplyDebounce(e))) {
          logger.info(`[SmartSkip] group=${groupId} reason=debounce_interrupted phase=${phase} msg="${summarizeForLog(e?.msg || "")}"`)
          // 让步后回滚 focusReplyCount（这次实际没回复）
          if (!wasForced) state.focusReplyCount = Math.max(0, (state.focusReplyCount || 0) - 1)
          // 同时回滚 rate limit 计数
          state.recentReplyTimestamps = (state.recentReplyTimestamps || []).slice(0, -1)
          return false
        }
        const longTaskPolicy = resolveLongTaskFeedbackPolicy(String(e?.msg || ""))
        if (longTaskPolicy?.releaseSmartLock === true) {
          e._longRunningToolTask = true
          logger.info(`[SmartLock] group=${groupId} 长耗时任务(${longTaskPolicy.kind})释放 smart 锁，后续消息可继续判断`)
          host.releaseSmartInFlight(state, e, smartLockToken)
        }
        e._triggerContext = { mode: "smart_gate", gateDecision: "continue", gateReason: gateResult?.reason || "", phase }
        return await host.handleTool(e)
      }
      if (decision === 'wait') {
        const sec = Math.max(1, Math.min(60, Number(gateResult.wait_seconds) || 5))
        state.pendingCount = 0
        state.forceContinue = false
        state.forceGateCheck = false
        state.consecutiveNoAction = 0   // wait 不是冷漠，清零计数避免跨 wait 累积误降级
        host.scheduleWaitReply(e, sec, 'gate_wait')
        return false
      }
      // no_action
      logger.info(`[SmartSkip] group=${groupId} reason=gate_no_action phase=${phase} pending=${state.pendingCount} gateReason=${gateResult?.reason || ""} msg="${summarizeForLog(e?.msg || "")}"`)
      state.lastGateNoActionAt = Date.now()
      state.pendingCount = 0
      state.forceContinue = false
      state.forceGateCheck = false
      // FOCUS 内累计 no_action，超过 focusMaxNoAction 就降级 FADING
      if (state.conversationPhase === 'focus') {
        state.consecutiveNoAction = (state.consecutiveNoAction || 0) + 1
        const maxNoAction = Number(smartCfg.focusMaxNoAction) || 2
        if (state.consecutiveNoAction >= maxNoAction) {
          state.conversationPhase = 'fading'
          state.phaseUntil = Date.now() + (Number(smartCfg.fadingDurationMs) || 90000)
          state.consecutiveNoAction = 0
          logger.info(`[Phase] group=${groupId} Gate 连续 ${maxNoAction} 次 no_action，降级 fading`)
        }
      }
      return false
    } finally {
      host.releaseSmartInFlight(state, e, smartLockToken)
    }
  }
