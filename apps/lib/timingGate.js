// Timing Gate:smart 模式的插话时机 LLM 决策(continue/no_action/wait/deferred)。
// 从 apps/test.js 原样迁出(行为不变),this 依赖以 host 注入;
// 输入(e, state, ctx)与返回 {decision, reason, ...} 契约不变。
// 注意力漂移等"何时说话"的新信号以后在信号采集段扩展。
import { resolveChatCompletionUrl as normalizeChatCompletionUrl } from "../../utils/chatCompletionUrl.js"
import { hasBotTextAnchor, getReplySender, messageQuotesUser } from "../../utils/messageContext.js"
import { getMentionTargetId, messageMentionsUser } from "../../utils/mentionTargets.js"
import { computeAddresseeSignal } from "../../utils/addresseeSignals.js"
import { buildPersonaTonePrompt } from "../../utils/personaTonePolicy.js"
import { getGroupTopicPrompt, getGroupSocialPrompt, detectAttentionHook } from "../../utils/groupContextState.js"

const logger = globalThis.logger


// 注意力漂移提示(三档措辞;strong 档另在阈值侧降门槛):
// 借鉴 MaiBot attention_drift——被新话题/爆发话题自然吸引,更像活人群友
export function formatAttentionHint(hook, level = "normal") {
  if (!hook?.word) return ""
  const strength = {
    subtle: "如果自然的话,可以留意一下这个新话题",
    normal: "这个新话题有点意思,你更容易被它吸引",
    strong: "这个新话题明显吸引了你的注意,更倾向于插话参与"
  }[String(level)] || "这个新话题有点意思,你更容易被它吸引"
  return `【注意力】群里刚冒出新话题「${hook.word}」(近期提及 ${hook.count} 次)。${strength}。`
}

export async function runTimingGate(host, e, state, ctx = {}) {
    const smartCfg = host.config.smartTrigger || {}
    const ctxSize = Math.max(5, Math.min(100, Number(smartCfg.gateContextSize) || 20))
    const botName = Bot.nickname || '机器人'

    let history = ''
    try {
      history = await host.messageManager.formatMessageHistory('group', e.group_id, ctxSize)
    } catch { history = '(无)' }

    // Gate 子代理复用 trackAiConfig（同样是"轻量 LLM 决策回不回话"用途，不再单独配置一份模型）
    const trackCfg = host.config.trackAiConfig
    const useCfg = {
      url: normalizeChatCompletionUrl(trackCfg?.trackAiUrl),
      model: trackCfg?.trackAiModel || 'gpt-4o-mini',
      apikey: trackCfg?.trackAiApikey
    }
    if (!useCfg.url || !useCfg.apikey || String(useCfg.apikey).startsWith('sk-xxxxx')) {
      return { decision: 'no_action', reason: 'no_api_config' }
    }

    // ─── 多维信号采集 ─────────────────────────────────────
    const phase = ctx.phase || state.conversationPhase || 'cold'
    const prefilterKind = ctx.prefilter?.kind || 'regular'
    const prefilterReason = ctx.prefilter?.reason || ''
    const recentReplyCount = (state.recentReplyTimestamps || []).filter(t => t > Date.now() - 600000).length
    const groupMsgRate5min = host.computeGroupMsgRate5min(state)
    const sinceLastBotReplySec = state.lastBotReplyAt
      ? Math.max(0, Math.floor((Date.now() - state.lastBotReplyAt) / 1000))
      : -1
    const sinceLastMsgSec = state.lastMsgAt
      ? Math.max(0, Math.floor((Date.now() - state.lastMsgAt) / 1000))
      : 0
    const now = new Date()
    const hh = now.getHours()
    const hhmm = `${String(hh).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    const isLateNight = hh >= 23 || hh < 6
    // 是否 @ 别人 / 引用 bot
      let addressedToOther = false
      let currentMsgQuotesBot = false
      let atBot = false
      try {
        const botId = e?.bot?.uin || Bot.uin
        currentMsgQuotesBot = messageQuotesUser(e, botId)
        if (Array.isArray(e?.message)) {
          for (const seg of e.message) {
            if (seg?.type === 'at' && String(getMentionTargetId(seg)) === String(botId)) atBot = true
            if (seg?.type === 'at' && String(getMentionTargetId(seg)) !== String(botId)) addressedToOther = true
            if (seg?.type === 'reply') {
              // 部分协议端会附带被回复消息的 sender 信息
              const repliedUid = getReplySender(seg)
              if (repliedUid && String(repliedUid) === String(botId)) currentMsgQuotesBot = true
            }
          }
        }
      if (!atBot) atBot = messageMentionsUser(e, botId)
    } catch {}
    const currentText = String(e?.msg || '')
    const mentionsBotName = hasBotTextAnchor(currentText, botName, host.config.triggerPrefixes)
    const sameUserAsLastReply = state.lastBotReplyToUserId && String(e?.user_id || '') === String(state.lastBotReplyToUserId)
    // 触发决策与主链路共享同一份人设与对象信号：Gate 判断"要不要回"，主链路判断"回给谁"，口径必须一致
    const addresseeSignal = computeAddresseeSignal({
      e,
      botId: e?.bot?.uin || Bot.uin,
      mentionsBotName,
      quotesBot: currentMsgQuotesBot,
      sameUserAsLastReply,
      prefilterKind
    })
    const { groupAddressed, targetKind, pronounWithoutBotAnchor } = addresseeSignal
    const triggerReason = e?._deferredReason
      ? 'deferred'
      : (prefilterKind === 'continuation_strong' ? `continuation_strong(${prefilterReason})` : 'regular')

    const promptHintBusyGroupRate = Number(smartCfg.promptHintBusyGroupRate) || 30
    const promptHintRateLimitWarn = Number(smartCfg.promptHintRateLimitWarn) || 5

    // 注意力漂移:刚冒出且正在爆发的新话题 → 注入"容易被吸引"提示(零模型调用,纯话题统计)
    const driftCfg = smartCfg.attentionDrift || {}
    const attentionHint = driftCfg.enabled !== false
      ? formatAttentionHint(detectAttentionHook({
          groupId: e?.group_id,
          windowMs: (Number(driftCfg.windowMinutes) || 5) * 60 * 1000
        }), driftCfg.level)
      : ""

    const gatePersonaTone = buildPersonaTonePrompt({
      userText: currentText,
      persona: host.getPersonaFor(e)
    })
    const systemPrompt = `你是 QQ 群聊节奏判断助手。机器人名字叫"${botName}"。
当前北京时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}
你需要判断 ${botName} 是否应该现在插话、保持沉默、或稍后再说。

**总原则：默认旁听，只有高置信度确认当前消息在对 ${botName} 说、引用 ${botName}、延续 ${botName} 刚说的话，或强相关到不接会显得突兀时，才 continue。**
克制优先。普通群友之间互相聊天时，即使内容有趣、出现"你"、正在玩梗，也默认 no_action。不要为了显得活跃而找理由插话。

判断指引：
- continue：目标对象=bot；被 @/点名；当前消息明确叫了 ${botName}；引用了 ${botName} 的消息；同一个用户正在追问 ${botName} 刚说过的内容；有人直接问 ${botName} 的身份/状态/意见；明确请求 ${botName} 做事。
- no_action：目标对象=other；没有叫 ${botName}；只是群友之间聊天；"你"明显可能指别人；只是普通玩梗/复读/吐槽；${botName} 只是看得懂但不是被问到；同一话题 ${botName} 刚回过应该让别人说。
- wait：用户句子像是没说完，或者 ${botName} 刚被叫到但对方可能还在补充。

时段倾向：任何时段都默认克制；深夜（23:00-06:00）更倾向 no_action。

【信号判断指引】
- 看到"⚠ @ 了别人"信号：除非该消息内容显然是普遍话题（如"大家觉得..."），否则倾向 no_action
- 看到"目标对象=group"：这是全群问题或公共话题，可以谨慎判断是否插话；只有 ${botName} 能自然帮上或补充时才 continue
- 看到"目标对象=unknown"：默认 no_action，除非近期上下文强烈表明在说 ${botName}
- 看到"目标对象=other"：必须 no_action
- 看到"焦点=focus"不等于一定接话；只有当前消息明确回应 ${botName} 或引用/点名 ${botName}，才倾向 continue
- 看到"最近 10 分钟已回复 ≥${promptHintRateLimitWarn} 次"：除非被点名，倾向 no_action（避免刷屏）
- 看到"群最近 5 分钟消息数 ≥ ${promptHintBusyGroupRate}"：群友正在热聊，默认 no_action，除非明确叫 ${botName}
- 看到"触发原因=deferred"：这是定时自检，群里没新消息或 ${botName} 刚开了话头还没人接；只在非常合适时主动补一句，否则 no_action
- 看到"触发原因=continuation_strong"且消息明显在向 ${botName} 提问/反馈：可以 continue；如果只是相关词命中但没有对 ${botName} 说，仍然 no_action
- 没有明确"应该插"的理由时，必须 no_action

${gatePersonaTone ? `\n${gatePersonaTone}\n` : ""}
只返回严格的 JSON，格式：{"decision":"continue|no_action|wait","wait_seconds":3,"reason":"简短理由"}
wait 时 wait_seconds 取 3-15 之间。不要任何其他文字、不要 markdown、不要代码块包装。`

    const specialSignals = []
    if (addressedToOther) specialSignals.push('⚠ 当前消息 @ 了别人，谨慎插话')
    if (currentMsgQuotesBot) specialSignals.push(`✓ 当前消息引用了 ${botName} 的某条消息`)
    const specialSignalsBlock = specialSignals.length ? `\n【特殊信号】\n${specialSignals.join('\n')}\n` : ''

    const userPrompt = `【近期群聊记录】
${history}

【当前消息】
${e.sender?.card || e.sender?.nickname || '用户'}: ${e.msg || ''}

【时间与活跃度】
- 距上一条群消息：${sinceLastMsgSec}s
- 距 ${botName} 上一次发言：${sinceLastBotReplySec >= 0 ? sinceLastBotReplySec + 's' : '长时间未发言'}
- ${botName} 最近 10 分钟在本群已回复：${recentReplyCount} 次
- 群最近 5 分钟消息数：${groupMsgRate5min}
- 当前时段：${hhmm}（${isLateNight ? '深夜' : '日间'}）

${getGroupTopicPrompt(e?.group_id) ? "\n【群话题】" + getGroupTopicPrompt(e?.group_id).replace("【群话题】", "") : ""}${attentionHint ? "\n" + attentionHint : ""}
${getGroupSocialPrompt(e?.group_id)}
【对话状态】
- 当前焦点：${phase}（focus=刚参与话题中；fading=余热；cold=未参与）
- 触发原因：${triggerReason}
- 明确 @ ${botName}：${atBot ? '是' : '否'}
- 文本点名 ${botName}：${mentionsBotName ? '是' : '否'}
- 引用了 ${botName} 的消息：${currentMsgQuotesBot ? '是' : '否'}
- 是否同一用户接续 ${botName} 上次回复：${sameUserAsLastReply ? '是' : '否'}
- 当前消息目标对象：${targetKind}
- 文本含"你"但没有任何 ${botName} 指向锚点：${pronounWithoutBotAnchor ? '是，默认认为在对别人说' : '否'}
${specialSignalsBlock}
请输出 JSON 决策。`

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 15000)
    try {
      const response = await fetch(useCfg.url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${useCfg.apikey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: useCfg.model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: 0.3
        }),
        signal: controller.signal
      })
      if (!response.ok) {
        const errorText = await response.text().catch(() => '')
        logger.warn(`[TimingGate] 请求失败 group=${e?.group_id || ''} status=${response.status} body=${errorText.slice(0, 240)}`)
        return { decision: 'no_action', reason: `http_${response.status}` }
      }
      const data = await response.json()
      const raw = data?.choices?.[0]?.message?.content?.trim() || ''
      const jsonMatch = raw.match(/\{[\s\S]*\}/)
      if (!jsonMatch) {
        logger.warn(`[TimingGate] 返回非JSON group=${e?.group_id || ''} raw=${raw.slice(0, 240)}`)
        return { decision: 'no_action', reason: 'no_json' }
      }
      const parsed = JSON.parse(jsonMatch[0])
      const dec = String(parsed.decision || '').toLowerCase()
      if (!['continue', 'no_action', 'wait'].includes(dec)) {
        logger.warn(`[TimingGate] 非法decision group=${e?.group_id || ''} decision=${parsed.decision}`)
        return { decision: 'no_action', reason: 'invalid_decision' }
      }
      return {
        decision: dec,
        wait_seconds: Number(parsed.wait_seconds) || 5,
        reason: String(parsed.reason || '').slice(0, 80)
      }
    } catch (err) {
      logger.warn(`[TimingGate] 异常 group=${e?.group_id || ''}: ${err.message}`)
      return { decision: 'no_action', reason: `exception:${err.message}` }
    } finally {
      clearTimeout(timeoutId)
    }
}
