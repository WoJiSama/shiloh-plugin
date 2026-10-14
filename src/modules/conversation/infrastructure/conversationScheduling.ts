import type {ConversationEvent,ConversationState} from '../application/smartConversation.js'
import {isAiConversationEnabled} from '../domain/aiConversationGate.js'
import {smartConversationKey} from '../domain/conversationIdentity.js'
import {markProactiveReply} from '../domain/proactiveReplyFreshness.js'
import {lastIncomingMsgAt} from '../domain/splitState.js'
import {stripCqMarkup} from '../domain/replySanitizer.js'
import {summarizeForLog} from '../domain/messageContext.js'
import {collectMentionTargetIds} from '../domain/mentionTargets.js'
import {createSmartLockPolicy} from '../domain/smartLockPolicy.js'
export interface ScheduledEvent extends ConversationEvent {_toolRequestMerged?:boolean;_mergedRawCqTexts?:string[];_mergedMessageCount?:number;_mergedRetainedMessageCount?:number;_mergedDroppedMessageCount?:number;_mergedOriginalTexts?:string[]}
export interface MergeMessage {event:ScheduledEvent;text:string;at:number}
export type MergeMessages=MergeMessage[] & {droppedCount?:number}
interface MergeEntry {timer:ReturnType<typeof setTimeout>;messages:MergeMessages;droppedCount:number;reason?:string}
export interface SchedulingHost {
 config:{enabled?:unknown;chatTriggerMode?:string;smartTrigger?:{deferredGateEnabled?:boolean;avgLatencyDefaultMs?:number;minDeferredMs?:number;maxDeferredMs?:number;toolRequestMergeMs?:number;smartLockTimeoutMs?:number|string|null;replyDebounceMs?:number;maxConsecutiveInterrupts?:number}};
 tools?:{function?:{name?:string}}[];
 resolveTalkValue(groupId:string|number):number;computeAvgReplyLatency(state:ConversationState):number;checkGroupPermission(e:ScheduledEvent):boolean;
 isUserBlacklisted(e:ScheduledEvent):boolean;isMutedInGroup(e:ScheduledEvent):Promise<boolean>;handleRandomReplySmart(e:ScheduledEvent):Promise<unknown>;handleTool(e:ScheduledEvent):Promise<unknown>;
 getSmartState(groupId:string|number,e?:ScheduledEvent):ConversationState;getDirectTriggerMergeMs():number;getDirectTriggerMergeMaxMessages():number;
 getMergeMsForEvent(e:ScheduledEvent):number;isMergeableDirectTrigger(e:ScheduledEvent):boolean;isMergeableToolRequest(e:ScheduledEvent):boolean;
 isCommand(e:ScheduledEvent):boolean;isAutomaticTorrentDownloadEvent(e:ScheduledEvent):boolean;isLikelyToolRequestText(text:string):boolean;
 buildMergedDirectTriggerEvent(e:ScheduledEvent,messages:MergeMessages):ScheduledEvent;buildMergedToolRequestEvent(e:ScheduledEvent,messages:MergeMessages):ScheduledEvent;
 getSmartLockTimeoutMs():number;releaseSmartInFlight(state:ConversationState,e:ScheduledEvent|null,token:number):void
}
export interface SchedulingPorts {
 logger:{info(message:string):void;warn(message:string):void;error(message:string,error?:unknown):void};
 resolveToolRequestMergeMs(text:string,names:string[],options:{defaultMs:number;fastMs:number|undefined}):number;
 shouldBypassMergeForExcel(text:string):boolean;isDrawTaskStatusInquiry(text:string):boolean;
}
export function createConversationScheduling(ports:SchedulingPorts) {
const {logger,resolveToolRequestMergeMs,shouldBypassMergeForExcel,isDrawTaskStatusInquiry}=ports
const {armSmartLockWatchdog,clearSmartLockWatchdog}=createSmartLockPolicy(()=>false)
const directTriggerMergeTimers=new Map<string,MergeEntry>()
const toolRequestMergeTimers=new Map<string,MergeEntry>()
const consecutiveInterrupts=new Map<string|number,number>()

function scheduleDeferredGateCheck(host:SchedulingHost,e:ScheduledEvent,state:ConversationState) {
    const smartCfg = host.config.smartTrigger || {}
    if (smartCfg.deferredGateEnabled === false) return
    if (!e?.group_id) return
    if (state.conversationPhase !== 'cold') return

    if (state.deferredTimer) clearTimeout(state.deferredTimer)

    const talkValue = host.resolveTalkValue(e.group_id)
    const threshold = Math.max(1, Math.ceil(1 / Math.max(0.01, talkValue)))
    const avgMs = host.computeAvgReplyLatency(state) || Number(smartCfg.avgLatencyDefaultMs) || 60000
    const idleMs = Math.max(0, Date.now() - (state.lastMsgAt || Date.now()))
    const currentEquiv = (state.pendingCount || 0) + idleMs / avgMs
    const remaining = Math.max(0, threshold - currentEquiv)

    const minMs = Number(smartCfg.minDeferredMs) || 120000
    const maxMs = Number(smartCfg.maxDeferredMs) || 900000
    const delayMs = Math.max(minMs, Math.min(maxMs, Math.ceil(remaining * avgMs)))

    const groupId = e.group_id
    state.deferredTimer = setTimeout(async () => {
      state.deferredTimer = null
      try {
        const mode = String(host.config?.chatTriggerMode || 'strict').toLowerCase()
        if (mode !== 'smart') return
        if (!isAiConversationEnabled(host.config)) return
        if (!host.checkGroupPermission(e)) return
        if (host.isUserBlacklisted(e)) return
        if (await host.isMutedInGroup(e)) return
        if (state.inFlight) return
        state.forceGateCheck = true
        const wrapped:ScheduledEvent = Object.create(e)
        wrapped._smartWaitRerun = true
        wrapped._deferredReason = 'cold_idle'
        logger.info(`[DeferredGate] group=${groupId} fired delay=${delayMs}ms`)
        await host.handleRandomReplySmart(wrapped)
      } catch (err) {
        logger.error('[DeferredGate] 失败:', err)
      }
    }, delayMs)
    state.deferredTimer.unref?.()
  }

function getMergeMsForEvent(host:SchedulingHost,e:ScheduledEvent) {
    const availableToolNames = (host.tools || []).flatMap(tool => tool?.function?.name ? [tool.function.name] : [])
    return resolveToolRequestMergeMs(e.msg || "", availableToolNames, {
      defaultMs: host.getDirectTriggerMergeMs(),
      fastMs: host.config.smartTrigger?.toolRequestMergeMs
    })
  }

function isMergeableDirectTrigger(host:SchedulingHost,e:ScheduledEvent) {
    if (!e?.group_id || !e?.user_id || e?._directTriggerMerged || e?._smartWaitRerun || e?._smartQueuedRerun || e?._proactiveReply) return false
    if (e.forceGrabRedBag || host.isCommand(e)) return false
    if (shouldBypassMergeForExcel(e.msg || "")) return false
    const message = Array.isArray(e.message) ? e.message : []
    return !message.some(seg => ["image", "video", "record", "file"].includes(seg?.type || ""))
  }

function buildMergedDirectTriggerEvent(host:SchedulingHost,baseEvent:ScheduledEvent,messages:MergeMessages = []) {
    const latest = messages.at(-1)?.event || baseEvent
    const merged:ScheduledEvent = Object.create(latest)
    const textLines = messages
      .map(item => String(item.text || item.event?.msg || "").trim())
      .filter(Boolean)
    const droppedCount = Number(messages.droppedCount) || 0
    const totalCount = textLines.length + droppedCount
    const mergedText = textLines.length > 1
      ? `同一个人连续发了 ${totalCount} 条消息${droppedCount > 0 ? `（这里只保留最后 ${textLines.length} 条）` : ""}：\n${textLines.map((text, index) => `${index + 1}. ${text}`).join("\n")}`
      : textLines.join("\n")
    merged.msg = mergedText
    merged.raw_message = mergedText
    // 合并不能丢 @:重建 message 时把各条消息的 at 段按出现顺序补回,
    // 否则下游(头像参考/成员指认)只能看到最后一个 @ (e.at)。
    const atTargets:string[] = []
    for (const item of messages) {
      for (const qq of collectMentionTargetIds(item.event || {}, latest.self_id)) {
        if (!atTargets.includes(String(qq))) atTargets.push(String(qq))
      }
    }
    merged.message = [
      { type: "text", text: mergedText },
      ...atTargets.map(qq => ({ type: "at", qq }))
    ]
    // 保留各条原始 CQ 文本(e.msg 已被剥掉 @,无法还原位置),供语义分类器做 @ 注解
    merged._mergedRawCqTexts = messages
      .map(item => String(item.event?.raw_message || ""))
      .filter(text => text.includes("[CQ:at"))
    merged._directTriggerMerged = true
    merged._mergedMessageCount = totalCount
    merged._mergedRetainedMessageCount = textLines.length
    merged._mergedDroppedMessageCount = droppedCount
    merged._mergedOriginalTexts = textLines
    return merged
  }

function buildMergedDirectTriggerPrompt(host:SchedulingHost,e:Pick<ScheduledEvent,'_directTriggerMerged'|'_mergedMessageCount'|'_mergedDroppedMessageCount'>) {
    if (!e?._directTriggerMerged || !e?._mergedMessageCount) return ""
    const count = Number(e._mergedMessageCount) || 0
    const dropped = Number(e._mergedDroppedMessageCount) || 0
    const droppedText = dropped > 0 ? `其中前面 ${dropped} 条较早消息已为防刷屏省略，只保留最后几条。` : ""
    return [
      "【连续点名合并】",
      `同一位群友刚刚连续叫你/触发你 ${count} 次。${droppedText}`,
      "请把这些内容当作同一轮连续发言来理解，只自然回复一次。",
      "不要逐条编号回答，不要提到“合并”“系统”“触发窗口”或内部处理。"
    ].join("\n")
  }

function scheduleMergedDirectTrigger(host:SchedulingHost,e:ScheduledEvent,handler:(e:ScheduledEvent)=>Promise<void>,reason = "direct") {
    const mergeMs = host.getMergeMsForEvent(e)
    if (mergeMs <= 0 || !host.isMergeableDirectTrigger(e)) return null

    const key = `${smartConversationKey(e.group_id, e)}:${e.user_id}`
    const previous = directTriggerMergeTimers.get(key)
    if (previous?.timer) clearTimeout(previous.timer)

    const messages = previous?.messages || []
    messages.push({
      event: e,
      text: stripCqMarkup(e.msg || ""),
      at: Date.now()
    })
    const maxMessages = host.getDirectTriggerMergeMaxMessages()
    let droppedCount = previous?.droppedCount || 0
    while (messages.length > maxMessages) {
      messages.shift()
      droppedCount++
    }
    messages.droppedCount = droppedCount

    const timer = setTimeout(async () => {
      const entry = directTriggerMergeTimers.get(key)
      if (!entry || entry.timer !== timer) return
      directTriggerMergeTimers.delete(key)
      const mergedEvent = host.buildMergedDirectTriggerEvent(e, entry.messages)
      logger.info(`[触发合并] group=${e.group_id} user=${e.user_id} total=${entry.messages.length + (entry.droppedCount || 0)} retained=${entry.messages.length} dropped=${entry.droppedCount || 0} reason=${reason} latest="${summarizeForLog(entry.messages.at(-1)?.text || "")}"`)
      try {
        await handler(mergedEvent)
      } catch (error) {
        logger.error(`[触发合并] 执行失败:`, error)
      }
    }, mergeMs)

    directTriggerMergeTimers.set(key, { timer, messages, droppedCount, reason })
    logger.info(`[触发合并] group=${e.group_id} user=${e.user_id} wait=${mergeMs}ms count=${messages.length} dropped=${droppedCount} reason=${reason} msg="${summarizeForLog(e.msg || "")}"`)
    return false
  }

function isMergeableToolRequest(host:SchedulingHost,e:ScheduledEvent) {
    if (!e?.group_id || !e?.user_id || e?._toolRequestMerged || e?._directTriggerMerged || e?._smartWaitRerun || e?._smartQueuedRerun || e?._proactiveReply) return false
    if (e.forceGrabRedBag || host.isCommand(e)) return false
    const text = String(e.msg || "").trim()
    if (!text || isDrawTaskStatusInquiry(text)) return false
    // 每个磁链都是独立下载任务。不要把连续磁链合并后只处理其中一个。
    if (host.isAutomaticTorrentDownloadEvent(e)) return false
    if (shouldBypassMergeForExcel(text)) return false
    const message = Array.isArray(e.message) ? e.message : []
    if (message.some(seg => ["image", "video", "record", "file"].includes(seg?.type || ""))) return false
    return host.isLikelyToolRequestText(text)
  }

function buildMergedToolRequestEvent(host:SchedulingHost,baseEvent:ScheduledEvent,messages:MergeMessages = []) {
    const merged = host.buildMergedDirectTriggerEvent(baseEvent, messages)
    merged._toolRequestMerged = true
    return merged
  }

function scheduleMergedToolRequest(host:SchedulingHost,e:ScheduledEvent,handler:(e:ScheduledEvent)=>Promise<void>) {
    const mergeMs = host.getMergeMsForEvent(e)
    if (mergeMs <= 0 || !host.isMergeableToolRequest(e)) return null

    const key = `${smartConversationKey(e.group_id,e)}:${e.user_id}:tool_request`
    const previous = toolRequestMergeTimers.get(key)
    if (previous?.timer) clearTimeout(previous.timer)

    const messages = previous?.messages || []
    messages.push({
      event: e,
      text: stripCqMarkup(e.msg || ""),
      at: Date.now()
    })
    const maxMessages = host.getDirectTriggerMergeMaxMessages()
    let droppedCount = previous?.droppedCount || 0
    while (messages.length > maxMessages) {
      messages.shift()
      droppedCount++
    }
    messages.droppedCount = droppedCount

    const timer = setTimeout(async () => {
      const entry = toolRequestMergeTimers.get(key)
      if (!entry || entry.timer !== timer) return
      toolRequestMergeTimers.delete(key)
      const mergedEvent = host.buildMergedToolRequestEvent(e, entry.messages)
      logger.info(`[工具请求合并] group=${e.group_id} user=${e.user_id} total=${entry.messages.length + (entry.droppedCount || 0)} retained=${entry.messages.length} dropped=${entry.droppedCount || 0} latest="${summarizeForLog(entry.messages.at(-1)?.text || "")}"`)
      try {
        await handler(mergedEvent)
      } catch (error) {
        logger.error(`[工具请求合并] 执行失败:`, error)
      }
    }, mergeMs)

    toolRequestMergeTimers.set(key, { timer, messages, droppedCount })
    logger.info(`[工具请求合并] group=${e.group_id} user=${e.user_id} wait=${mergeMs}ms count=${messages.length} dropped=${droppedCount} msg="${summarizeForLog(e.msg || "")}"`)
    return false
  }

function releaseSmartInFlight(host:SchedulingHost,state:ConversationState,e:ScheduledEvent|null,expectedToken?:number) {
    if (!state) return
    // 看门狗强制释放（或长任务提前释放）后锁可能已交给新轮次；旧轮次的 finally 不得误释放
    if (expectedToken !== undefined && state.inFlightToken !== expectedToken) return
    clearSmartLockWatchdog(state)
    state.inFlight = false
    if (!state.needsRerun) return

    const rerunEvent = state.rerunEvent || e
    const queuedForceGateCheck = !!state.queuedForceGateCheck
    state.needsRerun = false
    state.rerunEvent = null
    state.queuedForceGateCheck = false
    if (!rerunEvent) return
    const wrappedRerun:ScheduledEvent = Object.create(rerunEvent)
    wrappedRerun._smartQueuedRerun = true
    if (queuedForceGateCheck) wrappedRerun._smartQueuedGateCheck = true
    host.handleRandomReplySmart(wrappedRerun).catch(err => logger.error('[TimingGate] 重跑失败:', err))
  }

function getSmartLockTimeoutMs(host:SchedulingHost) {
    const raw = host.config?.smartTrigger?.smartLockTimeoutMs
    const value = raw === undefined || raw === null || raw === '' ? NaN : Number(raw)
    return Number.isFinite(value) ? Math.max(0, value) : 180000
  }

function scheduleSmartLockWatchdog(host:SchedulingHost,state:ConversationState) {
    armSmartLockWatchdog(state, {
      timeoutMs: host.getSmartLockTimeoutMs(),
      logger,
      onForceRelease: () => host.releaseSmartInFlight(state, null, state.inFlightToken)
    })
  }

async function applyReplyDebounce(host:SchedulingHost,e:ScheduledEvent) {
    const debounceMs = Math.max(0, Number(host.config.smartTrigger?.replyDebounceMs) || 0)
    if (debounceMs <= 0 || !e?.group_id) return true
    const debounceStartAt = Date.now()
    await new Promise(r => setTimeout(r, debounceMs))
    const newestAt = lastIncomingMsgAt.get(smartConversationKey(e.group_id, e)) || 0
    if (newestAt > debounceStartAt) {
      const max = Math.max(0, Number(host.config.smartTrigger?.maxConsecutiveInterrupts) || 0)
      const cur = (consecutiveInterrupts.get(smartConversationKey(e.group_id, e)) || 0) + 1
      if (max === 0 || cur <= max) {
        consecutiveInterrupts.set(smartConversationKey(e.group_id, e), cur)
        logger.info(`[Debounce] group=${e.group_id} 检测到新消息打断，让步本轮 (${cur}/${max || '∞'})`)
        return false
      }
      logger.info(`[Debounce] group=${e.group_id} 连续打断达上限 ${max} 次，强制走完不让步`)
      consecutiveInterrupts.set(smartConversationKey(e.group_id, e), 0)
      return true
    }
    consecutiveInterrupts.set(smartConversationKey(e.group_id, e), 0)
    return true
  }

function scheduleWaitReply(host:SchedulingHost,e:ScheduledEvent,seconds:number,reason:string) {
    const groupId = e.group_id
    if (!groupId) {
      logger.warn(`[WaitTool] 私聊场景暂不支持自动续话: user=${e.user_id}`)
      return
    }
    const state = host.getSmartState(groupId, e)
    const userKey = `${groupId}_${e.user_id}`
    const old = state.waitTimers.get(userKey)
    if (old) clearTimeout(old)

    const timer = setTimeout(async () => {
      state.waitTimers.delete(userKey)
      // 触发时再次校验：模式可能已切回 strict、bot 可能已被禁言、群可能已退出白名单
      const mode = String(host.config?.chatTriggerMode || 'strict').toLowerCase()
      if (!isAiConversationEnabled(host.config)) return
      if (mode !== 'smart') {
        logger.info(`[WaitTool] group=${groupId} 已切出 smart 模式，取消续话`)
        return
      }
      if (!host.checkGroupPermission(e)) {
        logger.info(`[WaitTool] group=${groupId} 不在白名单，取消续话`)
        return
      }
      if (host.isUserBlacklisted(e)) {
        logger.info(`[WaitTool] group=${groupId} user=${e.user_id} 命中用户黑名单，取消续话`)
        return
      }
      if (await host.isMutedInGroup(e)) {
        logger.info(`[WaitTool] group=${groupId} 被禁言，取消续话`)
        return
      }
      state.forceContinue = false
      state.forceGateCheck = true
      logger.info(`[WaitTool] group=${groupId} user=${e.user_id} fired after ${seconds}s reason=${reason || ''}`)
      try {
        const wrapped:ScheduledEvent = Object.create(e)
        wrapped._smartWaitRerun = true
        await host.handleRandomReplySmart(wrapped)
      } catch (err) {
        logger.error(`[WaitTool] 续话失败:`, err)
      }
    }, seconds * 1000)
    state.waitTimers.set(userKey, timer)
  }

async function enqueueProactiveTask(host:SchedulingHost,groupId:string|number,intent:string,opts:{source?:string;anchorE?:ScheduledEvent} = {}) {
    if (!isAiConversationEnabled(host.config)) {
      logger.info('[Proactive] 插件总开关已关闭，取消续话')
      return { ok: false, error: 'plugin_disabled' }
    }
    if (!groupId || !intent) return { ok: false, error: 'missing_params' }
    const anchor = opts.anchorE
    if (!anchor) {
      logger.warn(`[Proactive] group=${groupId} 缺少锚点 e，无法触发；intent="${String(intent).slice(0, 40)}"`)
      return { ok: false, error: 'missing_anchor' }
    }
    if (String(anchor.group_id) !== String(groupId)) {
      logger.warn(`[Proactive] anchor.group_id(${anchor.group_id}) 与传入 groupId(${groupId}) 不匹配，拒绝触发`)
      return { ok: false, error: 'anchor_group_mismatch' }
    }
    if (!host.checkGroupPermission(anchor)) {
      return { ok: false, error: 'not_whitelisted' }
    }
    if (host.isUserBlacklisted(anchor)) {
      return { ok: false, error: 'user_blacklisted' }
    }
    if (await host.isMutedInGroup(anchor)) {
      return { ok: false, error: 'muted' }
    }

    logger.info(`[Proactive] group=${groupId} source=${opts.source || 'unknown'} intent="${String(intent).slice(0, 40)}"`)
    try {
      const wrapped:ScheduledEvent = Object.create(anchor)
      wrapped.msg = `[系统主动触发 来自 ${opts.source || '插件'}] ${intent}`
      const mode = String(host.config?.chatTriggerMode || 'strict').toLowerCase()
      if (mode === 'smart') {
        const state = host.getSmartState(groupId, anchor)
        state.forceContinue = true
        markProactiveReply(wrapped, lastIncomingMsgAt.get(smartConversationKey(groupId, anchor)) || Date.now())
        setImmediate(() => host.handleRandomReplySmart(wrapped).catch(err => logger.error('[Proactive] 处理失败:', err)))
      } else {
        // strict 模式没有 Gate，直接走 handleTool（绕过 @/前缀破冰）
        setImmediate(() => host.handleTool(wrapped).catch(err => logger.error('[Proactive] 处理失败:', err)))
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

function cancelPendingConversation(host:SchedulingHost,groupId:string|number,e?:ScheduledEvent) {
    try {
      const state = host.getSmartState(groupId, e)
      if (state.deferredTimer) {
        clearTimeout(state.deferredTimer)
        state.deferredTimer = null
      }
      for (const timer of state.waitTimers?.values() || []) clearTimeout(timer)
      state.waitTimers?.clear?.()
      state.rerunEvent = null
      state.forceContinue = false
      state.forceGateCheck = false
      state.queuedForceGateCheck = false
      state.needsRerun = false
    } catch (error) {
      logger.warn(`[违禁词] 清理排队续话失败 group=${groupId}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

return {scheduleDeferredGateCheck,getMergeMsForEvent,isMergeableDirectTrigger,buildMergedDirectTriggerEvent,buildMergedDirectTriggerPrompt,scheduleMergedDirectTrigger,isMergeableToolRequest,buildMergedToolRequestEvent,scheduleMergedToolRequest,releaseSmartInFlight,getSmartLockTimeoutMs,scheduleSmartLockWatchdog,applyReplyDebounce,scheduleWaitReply,enqueueProactiveTask,cancelPendingConversation,consecutiveInterrupts}
}
