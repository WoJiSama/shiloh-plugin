import type {ConversationEvent,ConversationState} from '../application/smartConversation.js'
import {messageMentionsUser,collectMentionTargetIds} from '../domain/mentionTargets.js'
import {messageQuotesUser,hasBotTextAnchor,getReplySender,getPreviousRecentMessage,looksAddressedToPreviousSpeaker} from '../domain/messageContext.js'
import {looksDirectedAtBotByPronoun,looksGroupAddressed,isLikelyFollowupMessage,isQuestionMessage,isFeedbackMessage} from '../domain/messageIntent.js'
import {extractForwardIdsFromSegments} from './groupContextResolver.js'
export interface PrefilterHost {
 config:{triggerPrefixes?:unknown[];smartTrigger?:{skipWhenAddressedOther?:boolean;skipWhenEmptyText?:boolean;quickResponseMs?:number;continuationLookbackMs?:number;continuationFollowupMatch?:boolean;continuationKeywordMatch?:boolean;continuationQuestionMatch?:boolean;continuationFeedbackMatch?:boolean}};
 getPersonaFor(e:ConversationEvent):unknown
}
export function createConversationPrefilter(ports:{bot():{uin?:string|number};resolvePersonaName(persona:unknown):string;logger:{warn(message:string):void}}) {
const {resolvePersonaName,logger}=ports
function prefilterMessage(host:PrefilterHost,e:ConversationEvent,state:ConversationState) {
    const smartCfg = host.config.smartTrigger || {}
    try {
      // bot 自己发的消息（防自激励）
      const botId = e?.bot?.uin || ports.bot().uin
      if (botId && String(e?.user_id) === String(botId)) {
        return { kind: 'bot_self_echo', reason: 'sender_is_self' }
      }
      const atSelf = messageMentionsUser(e, botId)
      const quotesSelf = messageQuotesUser(e, botId)
      const text = String(e?.msg || '')
      // 喊名判定用当前账号的人设名(多账号下 Bot.nickname 是主号昵称,会串台唤醒)
      const hasBotName = hasBotTextAnchor(text, resolvePersonaName(host.getPersonaFor(e)), host.config.triggerPrefixes)
      const explicitlyAddressesBot = atSelf || quotesSelf || hasBotName

      // @ 别人（且没有明确点名 bot）→ 跳过。
      // QQ 引用别人时常会自动带 @原作者；如果正文已经写了"希洛/触发前缀"，应视为找 bot。
      if (smartCfg.skipWhenAddressedOther !== false && Array.isArray(e?.message)) {
        const mentionedOthers = collectMentionTargetIds(e, botId)
        if (mentionedOthers.length > 0) {
          if (!explicitlyAddressesBot) {
            return { kind: 'addressed_other', reason: 'at_other_user' }
          }
        }
      }
      // 空文本（纯表情/图片/转账）→ 跳过。合并转发虽然本体没有 text segment，
      // 但可展开为后续问答和历史可用的上下文，不能在这里提前丢弃。
      if (smartCfg.skipWhenEmptyText !== false) {
        const rawText = (typeof e?.msg === 'string' ? e.msg : '').trim()
        if (!rawText && !atSelf && !quotesSelf) {
          if (extractForwardIdsFromSegments(e?.message || []).length) {
            return { kind: 'regular', reason: 'forward_context' }
          }
          return { kind: 'empty_content', reason: 'no_text' }
        }
      }

      // 以下为 continuation_strong 识别（必须距 bot 上次发言不远）
      const sinceLastBotReply = state.lastBotReplyAt ? Date.now() - state.lastBotReplyAt : Infinity
      const quickResponseMs = Math.max(0, Number(smartCfg.quickResponseMs) || 0)
      const lookbackMs = Number(smartCfg.continuationLookbackMs) || 180000
      const sameUserAsLastReply = state.lastBotReplyToUserId && String(e?.user_id || '') === String(state.lastBotReplyToUserId)
      let quotesBot = quotesSelf
      let quotesOther = false
      if (Array.isArray(e?.message)) {
        if (!quotesBot) quotesBot = e.message.some(seg => {
          if (seg?.type !== 'reply') return false
          const repliedUid = getReplySender(seg)
          return repliedUid && String(repliedUid) === String(botId)
        })
        quotesOther = e.message.some(seg => {
          if (seg?.type !== 'reply') return false
          const repliedUid = getReplySender(seg)
          return repliedUid && String(repliedUid) !== String(botId)
        })
      }
      const groupAddressed = looksGroupAddressed(text)
      const previousMessage = getPreviousRecentMessage(state, e)

      if (!atSelf && !hasBotName && !quotesBot && quotesOther) {
        return { kind: 'addressed_other', reason: 'reply_other_user' }
      }

      if (!atSelf && !hasBotName && !quotesBot && !sameUserAsLastReply && !groupAddressed && looksDirectedAtBotByPronoun(text)) {
        return { kind: 'likely_addressed_other', reason: 'pronoun_without_bot_anchor' }
      }

      if (!atSelf && !hasBotName && !quotesBot && !sameUserAsLastReply && looksAddressedToPreviousSpeaker(text, previousMessage, e?.user_id, botId)) {
        return { kind: 'likely_addressed_other', reason: 'reply_previous_speaker' }
      }

      // R1：秒回反应。仅限同一用户接话、引用 bot、或直接点名 bot；避免群友之间一句"你"被误判。
      if (atSelf) {
        return { kind: 'continuation_strong', reason: 'at_bot' }
      }
      if (quotesBot) {
        return { kind: 'continuation_strong', reason: 'reply_bot' }
      }
      if (sinceLastBotReply <= lookbackMs && sameUserAsLastReply && smartCfg.continuationFollowupMatch !== false && isLikelyFollowupMessage(text)) {
        return { kind: 'continuation_strong', reason: 'R0_same_user_followup' }
      }
      if (quickResponseMs > 0 && sinceLastBotReply <= quickResponseMs && (sameUserAsLastReply || quotesBot || hasBotName)) {
        return { kind: 'continuation_strong', reason: 'R1_quick_response' }
      }
      // R2/R3/R4 共同前提：在 lookback 窗口内
      if (sinceLastBotReply <= lookbackMs && (sameUserAsLastReply || quotesBot || hasBotName)) {
        // R2 关键词匹配
        if (smartCfg.continuationKeywordMatch !== false && Array.isArray(state.lastBotReplyKeywords)) {
          for (const kw of state.lastBotReplyKeywords) {
            if (kw && text.includes(kw)) {
              return { kind: 'continuation_strong', reason: `R2_keyword:${kw}` }
            }
          }
        }
        // R3 问句
        if (smartCfg.continuationQuestionMatch !== false && isQuestionMessage(text)) {
          return { kind: 'continuation_strong', reason: 'R3_question' }
        }
        // R4 反馈词
        if (smartCfg.continuationFeedbackMatch !== false && isFeedbackMessage(text)) {
          return { kind: 'continuation_strong', reason: 'R4_feedback' }
        }
      }
      return { kind: 'regular', reason: '' }
    } catch (err) {
      logger.warn(`[Prefilter] 异常，按 regular 处理：${err instanceof Error ? err.message : String(err)}`)
      return { kind: 'regular', reason: 'exception' }
    }
  }
return {prefilterMessage}
}
